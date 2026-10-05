import { Match, Schema } from "effect";
import { namingDigest } from "./naming.ts";
import { dual } from "effect/Function";
import {
  BoolType,
  Capabilities,
  Expr,
  IRType,
  NumberType,
  Operation,
  StringType,
  SemanticRef,
  Targets,
  Traits,
  U64Type,
  UnitType,
  UnknownType,
  arrayItem,
  fail,
  structLayout,
  recordValue,
  optionalItem,
  undefinedOrItem,
  unionCases,
} from "./kernel.ts";
import type { AnyOperation, ArrayOp, Layout, MatchCase, StructLayout, Value } from "./kernel.ts";
import { Computation, joinType } from "./effect-ir.ts";
import { RustIdent } from "./rust-emit.ts";

/** `Schema.optional(T)` / `Schema.optionalKey(T)` as a struct field marker (OPT-002). */
export interface OptionalField<T, Kind extends "optional" | "optionalKey"> {
  readonly _tag: "OptionalField";
  readonly kind: Kind;
  readonly type: IRType<T>;
}
/** Field witnesses of a struct, in declaration (and wire-encoding) order. */
export type Fields = {
  readonly [name: string]: IRType<any> | OptionalField<any, "optional" | "optionalKey">;
};
type RequiredKeys<F extends Fields> = {
  [K in keyof F]: F[K] extends OptionalField<any, any> ? never : K;
}[keyof F];
type OptionalKeys<F extends Fields> = Exclude<keyof F, RequiredKeys<F>>;
type FieldValue<T> =
  T extends OptionalField<infer A, infer Kind>
    ? Kind extends "optional"
      ? A | undefined
      : A
    : Value<T>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type StructValue<F extends Fields> = Simplify<
  { readonly [K in RequiredKeys<F>]: FieldValue<F[K]> } & {
    readonly [K in OptionalKeys<F>]?: FieldValue<F[K]>;
  }
>;
type FieldExpr<T> =
  T extends OptionalField<infer A, infer Kind>
    ? Kind extends "optional"
      ? Expr<A> | Expr<A | undefined>
      : Expr<A>
    : Expr<Value<T>>;
type FieldExprs<F extends Fields> = { readonly [K in RequiredKeys<F>]: FieldExpr<F[K]> } & {
  readonly [K in OptionalKeys<F>]?: FieldExpr<F[K]>;
};
export type CaseValue<Tag extends string, F extends Fields> = {
  readonly _tag: Tag;
} & StructValue<F>;
export type UnionValue<C extends { readonly [tag: string]: Fields }> = {
  readonly [T in keyof C & string]: CaseValue<T, C[T]>;
}[keyof C & string];

const rustIdent = (text: string): string | undefined => {
  try {
    return RustIdent.make(text).text;
  } catch {
    return undefined;
  }
};
// Stable, collision-resistant naming digest (#30).
const digest = namingDigest;
/** Native field names: the declared name when it is a Rust identifier, else positional. */
export const rustFieldNames = (layout: StructLayout) => {
  const names = layout.fields.map((field, i) => rustIdent(field.name) ?? `field_${i}`);
  return new Set(names).size === names.length ? names : layout.fields.map((_, i) => `field_${i}`);
};
export const rustVariantName = (tag: string, index: number) => rustIdent(tag) ?? `Case${index}`;

const freeze = <S extends Schema.Top>(schema: S): S => {
  for (const check of schema.ast.checks ?? []) Object.freeze(check);
  if (schema.ast.checks) Object.freeze(schema.ast.checks);
  Object.freeze(schema.ast);
  return Object.freeze(schema);
};

/**
 * Structural interning: identical structures share one witness, so IRType.same stays identity.
 * Identity matters only among witnesses still referenced, so the table holds them weakly (#39):
 * a path steps through child witnesses by WeakMap and ends in a WeakRef, and a long-lived
 * process (watch, editor) no longer keeps every witness it ever authored.
 */
interface InternNode {
  readonly byValue: Map<unknown, InternNode>;
  readonly byObject: WeakMap<object, InternNode>;
  leaf: WeakRef<object> | undefined;
}
const internNode = (): InternNode => ({
  byValue: new Map(),
  byObject: new WeakMap(),
  leaf: undefined,
});
const interned = internNode();
const released = new FinalizationRegistry<{ node: InternNode; leaf: WeakRef<object> }>(
  ({ node, leaf }) => {
    if (node.leaf === leaf) node.leaf = undefined;
  },
);
const intern = <W extends object>(path: readonly unknown[], make: () => W): W => {
  let node = interned;
  for (const key of path) {
    const byObject = typeof key === "object" && key !== null;
    let next = byObject ? node.byObject.get(key) : node.byValue.get(key);
    if (!next) {
      next = internNode();
      if (byObject) node.byObject.set(key, next);
      else node.byValue.set(key, next);
    }
    node = next;
  }
  const existing = node.leaf?.deref();
  if (existing) return existing as W;
  const witness = make();
  const leaf = new WeakRef<object>(witness);
  node.leaf = leaf;
  released.register(witness, { node, leaf });
  return witness;
};

class Composite<A> extends IRType<A> {
  constructor(id: string, schema: Schema.Codec<A>, rustName: string, layout: Layout) {
    super(
      SemanticRef.type(id),
      schema,
      Object.freeze({ target: Targets.RustStd, type: rustName }),
      // Composite values are Cloneable but not Copy in this profile (REC-004).
      Object.freeze([Traits.Cloneable]),
      Object.freeze(layout),
    );
  }
}

const isOptionalField = (
  value: unknown,
): value is OptionalField<unknown, "optional" | "optionalKey"> =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "OptionalField";
const fieldList = (fields: Fields) => {
  if (Object.hasOwn(fields, "_tag"))
    throw fail("RESERVED_FIELD", "authoring", "Struct", "`_tag` is reserved for tagged unions");
  return Object.entries(fields).map(([name, field]): StructLayout["fields"][number] => {
    const type = isOptionalField(field) ? field.type : field;
    if (!(type instanceof IRType))
      throw fail("TYPE_MISMATCH", "authoring", `Struct.${name}`, "Fields require IRType witnesses");
    // Optional fields record their read witness, UndefinedOr<T> (OPT-002).
    return isOptionalField(field)
      ? Object.freeze({
          name,
          type: UndefinedOrType.of(type) as IRType<unknown>,
          optional: field.kind,
        })
      : Object.freeze({ name, type: type as IRType<unknown> });
  });
};
const fieldSchema = (field: StructLayout["fields"][number]): Schema.Top =>
  field.optional === undefined
    ? field.type.schema
    : field.optional === "optional"
      ? Schema.optional(undefinedOrItem(field.type)!.schema)
      : Schema.optionalKey(undefinedOrItem(field.type)!.schema);
const structKey = (layout: StructLayout) =>
  JSON.stringify([
    layout.tag ?? null,
    layout.identifier ?? null,
    layout.fields.map((f) => [f.name, f.type.id, f.optional ?? null]),
  ]);

/** A struct witness (`Schema.Struct`), or a union case when it carries a `_tag`. */
export class StructType<F extends Fields, A = StructValue<F>> extends Composite<A> {
  declare private readonly fieldsType: F;
  private constructor(
    readonly fields: F,
    readonly tag: string | undefined,
    readonly identifier: string | undefined,
  ) {
    const list = fieldList(fields);
    const layout = { _tag: "Struct" as const, fields: Object.freeze(list), tag, identifier };
    const key = structKey(layout);
    const name =
      identifier !== undefined
        ? (rustIdent(identifier) ??
          (() => {
            throw fail(
              "INVALID_IDENTIFIER",
              "authoring",
              "Struct.annotate",
              "Native identifiers must be Rust identifiers",
            );
          })())
        : `${tag === undefined ? "Struct" : (rustIdent(tag) ?? "Case")}_${digest(key)}`;
    const struct = Schema.Struct({
      ...(tag === undefined ? {} : { _tag: Schema.tag(tag) }),
      ...Object.fromEntries(list.map((f) => [f.name, fieldSchema(f)])),
    });
    super(
      `reffect/struct@1/${digest(key)}`,
      freeze(
        identifier === undefined ? struct : struct.annotate({ identifier }),
      ) as unknown as Schema.Codec<A>,
      name,
      layout,
    );
    Object.freeze(this);
  }
  static of<const F extends Fields>(fields: F, tag?: string, identifier?: string): StructType<F> {
    const list = fieldList(fields);
    return intern(
      ["struct", tag, identifier, ...list.flatMap((f) => [f.name, f.optional, f.type])],
      () => new StructType(fields, tag, identifier),
    );
  }
  /** Effect `Schema.annotate({ identifier })`: a distinct witness, since diagnostics differ. */
  annotate(annotations: { readonly identifier: string }): StructType<F, A> {
    return StructType.of(this.fields, this.tag, annotations.identifier) as unknown as StructType<
      F,
      A
    >;
  }
  make(values: FieldExprs<F>): Expr<A> {
    return Expr.make(this, undefined, ordered(this, values));
  }
}
// Omitted optional keys are absent; an explicit `undefined` entry is not admitted (OPT-002).
const ordered = (
  type: IRType<unknown>,
  values: { readonly [name: string]: Expr<unknown> | undefined },
  tag?: string,
) => {
  const layout = structLayout(type, tag)!;
  const names = Object.keys(values);
  if (
    names.some((n) => !layout.fields.some((f) => f.name === n) || values[n] === undefined) ||
    layout.fields.some((f) => f.optional === undefined && !Object.hasOwn(values, f.name))
  )
    throw fail(
      "TYPE_MISMATCH",
      "authoring",
      "make",
      "Construction requires every required field and only declared fields",
    );
  return layout.fields.map((field) =>
    Object.hasOwn(values, field.name) ? values[field.name] : undefined,
  );
};

/** A union case: constructing it yields the union-typed value (narrower than Effect, REC-002). */
export interface CaseType<Tag extends string, F extends Fields, U> extends IRType<
  CaseValue<Tag, F>
> {
  readonly fields: F;
  readonly tag: Tag;
  make(values: FieldExprs<F>): Expr<U>;
}
/** Exhaustive handlers: all pure (`Expr`) or all effectful (`Computation`). */
type Handlers<C extends { readonly [tag: string]: Fields }> = {
  readonly [T in keyof C & string]: (
    value: Expr<CaseValue<T, C[T]>>,
  ) => Expr<any> | Computation<any, any>;
};
type Result<R> = [R] extends [Expr<any>]
  ? Expr<R extends Expr<infer B> ? B : never>
  : [R] extends [Computation<any, any>]
    ? Computation<
        R extends Computation<infer B, any> ? B : never,
        R extends Computation<any, infer E> ? E : never
      >
    : never;
export type MatchResult<H> = Result<
  { readonly [K in keyof H]: H[K] extends (...args: any) => infer R ? R : never }[keyof H]
>;

/** `Schema.TaggedUnion({ Tag: fields })`, lowered to a Rust enum of case structs. */
export class TaggedUnionType<C extends { readonly [tag: string]: Fields }> extends Composite<
  UnionValue<C>
> {
  readonly cases: {
    readonly [T in keyof C & string]: CaseType<T, C[T], UnionValue<C>>;
  };
  private constructor(casesByTag: C) {
    const tags = Object.keys(casesByTag);
    if (tags.length === 0)
      throw fail(
        "EMPTY_UNION",
        "authoring",
        "TaggedUnion",
        "A tagged union needs at least one case",
      );
    const members = tags.map((tag) => StructType.of(casesByTag[tag], tag));
    const key = JSON.stringify(members.map((m) => m.id));
    super(
      `reffect/union@1/${digest(key)}`,
      freeze(Schema.Union(members.map((m) => m.schema))) as unknown as Schema.Codec<UnionValue<C>>,
      `Union_${digest(key)}`,
      { _tag: "Union", cases: Object.freeze(members) },
    );
    const cases: Record<string, unknown> = {};
    members.forEach((member, i) => {
      const tag = tags[i];
      cases[tag] = Object.freeze(
        Object.assign(Object.create(member), {
          make: (values: { readonly [name: string]: Expr<unknown> | undefined }) =>
            Expr.make(this, tag, ordered(this, values, tag)),
        }),
      );
    });
    this.cases = Object.freeze(cases) as TaggedUnionType<C>["cases"];
    Object.freeze(this);
  }
  static of<const C extends { readonly [tag: string]: Fields }>(casesByTag: C): TaggedUnionType<C> {
    const members = Object.keys(casesByTag).map((tag) => StructType.of(casesByTag[tag], tag));
    return intern(["union", ...members], () => new TaggedUnionType(casesByTag));
  }
  /** Effect `TaggedUnion.match(value, cases)`, data-first or data-last. */
  readonly match: {
    <const H extends Handlers<C>>(cases: H): (value: Expr<UnionValue<C>>) => MatchResult<H>;
    <const H extends Handlers<C>>(value: Expr<UnionValue<C>>, cases: H): MatchResult<H>;
  } = dual<
    <const H extends Handlers<C>>(cases: H) => (value: Expr<UnionValue<C>>) => MatchResult<H>,
    <const H extends Handlers<C>>(value: Expr<UnionValue<C>>, cases: H) => MatchResult<H>
  >(2, (value, cases) => matchTags(value, cases));
}

/** Effect `Match.valueTags`: exhaustive handlers over a tagged-union value. */
export const matchTags = (
  value: Expr<unknown>,
  handlers: {
    readonly [tag: string]: (value: Expr<any>) => Expr<unknown> | Computation<unknown, unknown>;
  },
): any => {
  const union = unionCases(value.type);
  if (!union)
    throw fail("TYPE_MISMATCH", "authoring", "match", "Tagged matching requires a tagged union");
  const cases: MatchCase<Expr<unknown> | Computation<unknown, unknown>>[] = union.map(
    (caseType) => {
      const tag = structLayout(caseType)!.tag!;
      const handler = Object.hasOwn(handlers, tag) ? handlers[tag] : undefined;
      if (!handler)
        throw fail(
          "NON_EXHAUSTIVE_MATCH",
          "authoring",
          "match",
          `Missing case ${JSON.stringify(tag)}`,
        );
      const binder = Symbol(`reffect/match/${tag}`);
      return Object.freeze({ tag, binder, body: handler(Expr.parameter(caseType, binder, 0)) });
    },
  );
  if (Object.keys(handlers).length !== cases.length)
    throw fail("UNKNOWN_CASE", "authoring", "match", "Handlers name a tag outside the union");
  const pure = cases.flatMap((c) => (c.body instanceof Expr ? [{ ...c, body: c.body }] : []));
  if (pure.length === cases.length) return Expr.matchTags(value, pure[0].body.type, pure);
  const effects = cases.flatMap((c) =>
    c.body instanceof Computation ? [Object.freeze({ ...c, body: c.body })] : [],
  );
  if (effects.length !== cases.length)
    throw fail(
      "TYPE_MISMATCH",
      "authoring",
      "match",
      "Handlers must all return Expr or all return Computation",
    );
  // Like R.Match.bool: Never channels widen, distinct non-Never witnesses are refused.
  return Computation.make(
    effects.map((c) => c.body.output).reduce(joinType),
    effects.map((c) => c.body.error).reduce(joinType),
    { _tag: "MatchTags", value, cases: Object.freeze(effects) },
  );
};

/** The tags of a tagged-union value type. */
type TagsOf<A> = A extends { readonly _tag: infer T extends string } ? T : never;
/**
 * One handler per tag of `A`, each given its own case, as Effect's `Match.valueTags` types them;
 * a handler for a tag outside `A` is refused.
 */
type CaseHandlers<A, H> = {
  readonly [K in TagsOf<A>]: (
    value: Expr<Extract<A, { readonly _tag: K }>>,
  ) => Expr<any> | Computation<any, any>;
} & { readonly [K in Exclude<keyof H, TagsOf<A>>]: never };
/** Effect `Match.valueTags(value, handlers)`, data-first or data-last. */
export const valueTags: {
  <A, const H extends CaseHandlers<A, H>>(handlers: H): (value: Expr<A>) => MatchResult<H>;
  <A, const H extends CaseHandlers<A, H>>(value: Expr<A>, handlers: H): MatchResult<H>;
} = dual<
  <A, const H extends CaseHandlers<A, H>>(handlers: H) => (value: Expr<A>) => MatchResult<H>,
  <A, const H extends CaseHandlers<A, H>>(value: Expr<A>, handlers: H) => MatchResult<H>
>(2, (value, handlers) => matchTags(value, handlers));

/**
 * `Struct.get(key)(self)` / `Struct.get(self, key)`; optional keys read as `T | undefined`.
 * Read nested fields with `self.pipe(Struct.get("a"), Struct.get("b"))` or a named intermediate:
 * TypeScript cannot infer `Struct.get(Struct.get(self, "a"), "b")`, as for any dual (#15).
 */
const get: {
  <S, const K extends keyof S & string>(key: K): (self: Expr<S>) => Expr<S[K]>;
  <S, const K extends keyof S & string>(self: Expr<S>, key: K): Expr<S[K]>;
} = dual(2, (self: Expr<unknown>, key: string) => Expr.get(self, key));

/** `Schema.optional(T)`: the key may be absent, and a present value may be `undefined`. */
export const optional = <T>(type: IRType<T>): OptionalField<T, "optional"> =>
  Object.freeze({ _tag: "OptionalField", kind: "optional", type });
/** `Schema.optionalKey(T)`: the key may be absent; a present value is a `T`. */
export const optionalKey = <T>(type: IRType<T>): OptionalField<T, "optionalKey"> =>
  Object.freeze({ _tag: "OptionalField", kind: "optionalKey", type });

/** `Schema.UndefinedOr(T)`: a plain `T | undefined`, natively `Option<T>` (OPT-001). */
export class UndefinedOrType<T> extends Composite<T | undefined> {
  private constructor(readonly item: IRType<T>) {
    super(
      `reffect/undefined-or@1/${digest(item.id)}`,
      freeze(Schema.UndefinedOr(item.schema)) as unknown as Schema.Codec<T | undefined>,
      `Option<${item.native.type}>`,
      { _tag: "UndefinedOr", item, absent: "undefined" },
    );
    Object.freeze(this);
  }
  static of<T>(item: IRType<T>): UndefinedOrType<T> {
    if (!(item instanceof IRType))
      throw fail("TYPE_MISMATCH", "authoring", "UndefinedOr", "UndefinedOr requires a witness");
    // `undefined | undefined` collapses in JS, so a witness admitting undefined cannot nest; a
    // NullOr item would share JSON `null` with the absent value (OPT-006).
    if (IRType.same(item, UnitType) || optionalItem(item))
      throw fail(
        "TYPE_MISMATCH",
        "authoring",
        "UndefinedOr",
        "The item witness must not admit undefined",
      );
    return intern(["undefinedOr", item], () => new UndefinedOrType(item));
  }
}
/**
 * `Schema.NullOr(T)`: a plain `T | null`, natively `Option<T>` like `UndefinedOr`, whose layout
 * and nodes it shares with `null` as the absent value (OPT-006).
 */
export class NullOrType<T> extends Composite<T | null> {
  private constructor(readonly item: IRType<T>) {
    super(
      `reffect/null-or@1/${digest(item.id)}`,
      freeze(Schema.NullOr(item.schema)) as unknown as Schema.Codec<T | null>,
      `Option<${item.native.type}>`,
      { _tag: "UndefinedOr", item, absent: "null" },
    );
    Object.freeze(this);
  }
  static of<T>(item: IRType<T>): NullOrType<T> {
    if (!(item instanceof IRType))
      throw fail("TYPE_MISMATCH", "authoring", "NullOr", "NullOr requires a witness");
    // A witness that already admits null (or undefined, which shares JSON `null`) cannot nest.
    if (IRType.same(item, UnitType) || IRType.same(item, UnknownType) || optionalItem(item))
      throw fail("TYPE_MISMATCH", "authoring", "NullOr", "The item witness must not admit null");
    return intern(["nullOr", item], () => new NullOrType(item));
  }
}
/** `Schema.NullOr(T)`; read it with `R.Option.fromNullOr` (OPT-007). */
export const NullOr = <T>(item: IRType<T>): NullOrType<T> => NullOrType.of(item);
const undefinedOrMatch = <A, B>(
  self: Expr<A | undefined>,
  options: {
    readonly onUndefined: () => Expr<B>;
    readonly onDefined: (a: Expr<A>) => Expr<NoInfer<B>>;
  },
): Expr<B> => {
  const item = undefinedOrItem(self.type);
  if (!item)
    throw fail("TYPE_MISMATCH", "authoring", "UndefinedOr.match", "match requires UndefinedOr");
  const binder = Symbol("reffect/undefinedOr/defined");
  const onDefined = options.onDefined(Expr.parameter(item as IRType<A>, binder, 0));
  const onUndefined = options.onUndefined();
  if (!(onDefined instanceof Expr) || !(onUndefined instanceof Expr))
    throw fail(
      "TYPE_MISMATCH",
      "authoring",
      "UndefinedOr.match",
      "Handlers must return pure expressions in this profile",
    );
  return Expr.matchUndefined(self, binder, onDefined, onUndefined);
};
/** Effect `UndefinedOr.match(self, { onUndefined, onDefined })`, data-first or data-last. */
const undefinedOrMatchDual: {
  <A, B>(options: {
    readonly onUndefined: () => Expr<B>;
    readonly onDefined: (a: Expr<A>) => Expr<NoInfer<B>>;
  }): (self: Expr<A | undefined>) => Expr<B>;
  <A, B>(
    self: Expr<A | undefined>,
    options: {
      readonly onUndefined: () => Expr<B>;
      readonly onDefined: (a: Expr<A>) => Expr<NoInfer<B>>;
    },
  ): Expr<B>;
} = dual(2, undefinedOrMatch);
/** Effect `UndefinedOr.map(self, f)`: maps a defined value, keeping `undefined`. */
const undefinedOrMap: {
  <A, B>(f: (a: Expr<A>) => Expr<B>): (self: Expr<A | undefined>) => Expr<B | undefined>;
  <A, B>(self: Expr<A | undefined>, f: (a: Expr<A>) => Expr<B>): Expr<B | undefined>;
} = dual(2, <A, B>(self: Expr<A | undefined>, f: (a: Expr<A>) => Expr<B>): Expr<B | undefined> => {
  const item = undefinedOrItem(self.type);
  if (!item)
    throw fail("TYPE_MISMATCH", "authoring", "UndefinedOr.map", "map requires UndefinedOr");
  const binder = Symbol("reffect/undefinedOr/defined");
  const body = f(Expr.parameter(item as IRType<A>, binder, 0));
  const output = UndefinedOrType.of(body.type);
  return Expr.matchUndefined(self, binder, Expr.defined(output, body), Expr.undefined(output));
});
export const UndefinedOr = Object.freeze(
  Object.assign(<T>(item: IRType<T>): UndefinedOrType<T> => UndefinedOrType.of(item), {
    match: undefinedOrMatchDual,
    map: undefinedOrMap,
  }),
);

export const Struct = Object.assign(
  <const F extends Fields>(fields: F): StructType<F> => StructType.of(fields),
  { get },
);
export const TaggedUnion = <const C extends { readonly [tag: string]: Fields }>(
  casesByTag: C,
): TaggedUnionType<C> => TaggedUnionType.of(casesByTag);

/** `Schema.Array(item)`: a readonly array lowered to `Vec<T>` (ARR-001). */
export class ArrayType<T> extends Composite<ReadonlyArray<T>> {
  private constructor(readonly item: IRType<T>) {
    super(
      `reffect/array@1/${digest(item.id)}`,
      freeze(Schema.Array(item.schema)) as unknown as Schema.Codec<ReadonlyArray<T>>,
      `Vec<${item.native.type}>`,
      { _tag: "Array", item },
    );
    Object.freeze(this);
  }
  static of<T>(item: IRType<T>): ArrayType<T> {
    if (!(item instanceof IRType))
      throw fail("TYPE_MISMATCH", "authoring", "Array", "Arrays require an item witness");
    return intern(["array", item], () => new ArrayType(item));
  }
}
const loop = <A>(
  op: ArrayOp,
  output: IRType<A>,
  self: Expr<unknown>,
  body: (item: Expr<any>, index: Expr<bigint>, accumulator?: Expr<any>) => Expr<unknown>,
): Expr<A> => {
  const item = arrayItem(self.type);
  if (!item) throw fail("TYPE_MISMATCH", "authoring", "Array", "Iteration requires an array");
  const itemBinder = Symbol("reffect/array/item");
  const indexBinder = Symbol("reffect/array/index");
  const accumulator = Match.value(op).pipe(
    Match.tag("Reduce", (reduce) => Expr.parameter(output, reduce.accumulator, 0)),
    Match.orElse(() => undefined),
  );
  return Expr.arrayLoop(
    op,
    output,
    self,
    itemBinder,
    indexBinder,
    body(Expr.parameter(item, itemBinder, 0), Expr.parameter(U64Type, indexBinder, 0), accumulator),
  );
};
/** Effect `Array.map(self, (a, i) => b)`; the index is a u64. */
const map: {
  <A, B>(
    f: (a: Expr<A>, i: Expr<bigint>) => Expr<B>,
  ): (self: Expr<ReadonlyArray<A>>) => Expr<ReadonlyArray<B>>;
  <A, B>(
    self: Expr<ReadonlyArray<A>>,
    f: (a: Expr<A>, i: Expr<bigint>) => Expr<B>,
  ): Expr<ReadonlyArray<B>>;
} = dual(
  2,
  (self: Expr<ReadonlyArray<unknown>>, f: (a: Expr<unknown>, i: Expr<bigint>) => Expr<unknown>) => {
    let output: IRType<unknown> | undefined;
    const itemBinder = Symbol("reffect/array/item");
    const indexBinder = Symbol("reffect/array/index");
    const item = arrayItem(self.type);
    if (!item) throw fail("TYPE_MISMATCH", "authoring", "Array.map", "map requires an array");
    const body = f(Expr.parameter(item, itemBinder, 0), Expr.parameter(U64Type, indexBinder, 0));
    output = ArrayType.of(body.type);
    return Expr.arrayLoop({ _tag: "Map" }, output, self, itemBinder, indexBinder, body);
  },
);
/** Effect `Array.filter(self, (a, i) => boolean)`. */
const filter: {
  <A>(
    predicate: (a: Expr<A>, i: Expr<bigint>) => Expr<boolean>,
  ): (self: Expr<ReadonlyArray<A>>) => Expr<ReadonlyArray<A>>;
  <A>(
    self: Expr<ReadonlyArray<A>>,
    predicate: (a: Expr<A>, i: Expr<bigint>) => Expr<boolean>,
  ): Expr<ReadonlyArray<A>>;
} = dual(
  2,
  (
    self: Expr<ReadonlyArray<unknown>>,
    predicate: (a: Expr<unknown>, i: Expr<bigint>) => Expr<boolean>,
  ) => loop({ _tag: "Filter" }, self.type, self, (a, i) => predicate(a, i)),
);
/** Effect `Array.reduce(self, b, (b, a, i) => b)`. */
const reduce: {
  <A, B>(
    b: Expr<B>,
    f: (b: Expr<B>, a: Expr<A>, i: Expr<bigint>) => Expr<B>,
  ): (self: Expr<ReadonlyArray<A>>) => Expr<B>;
  <A, B>(
    self: Expr<ReadonlyArray<A>>,
    b: Expr<B>,
    f: (b: Expr<B>, a: Expr<A>, i: Expr<bigint>) => Expr<B>,
  ): Expr<B>;
} = dual(
  3,
  (
    self: Expr<ReadonlyArray<unknown>>,
    b: Expr<unknown>,
    f: (b: Expr<unknown>, a: Expr<unknown>, i: Expr<bigint>) => Expr<unknown>,
  ) =>
    loop(
      { _tag: "Reduce", init: b, accumulator: Symbol("reffect/array/accumulator") },
      b.type,
      self,
      (a, i, acc) => f(acc!, a, i),
    ),
);
/** Effect `Array.make(...elements)`: at least one element, all sharing a witness. */
const make = <A>(...elements: readonly [Expr<A>, ...Expr<A>[]]): Expr<ReadonlyArray<A>> =>
  Expr.arrayMake(ArrayType.of(elements[0].type), elements);
/** Effect `Array.empty()`; the item witness is explicit because there is no element. */
const empty = <A>(item: IRType<A>): Expr<ReadonlyArray<A>> =>
  Expr.arrayMake(ArrayType.of(item), []);
/** Effect `Array.length`, as a u64. */
const length = <A>(self: Expr<ReadonlyArray<A>>): Expr<bigint> => Expr.arrayLength(self);
const arrayOf = <T>(item: IRType<T>): ArrayType<T> => ArrayType.of(item);
// A function's own `length` is read-only but configurable; Effect's `Array.length` replaces it.
Object.defineProperty(arrayOf, "length", { value: length, enumerable: true });
export const ArrayIR: typeof arrayOf & {
  readonly make: typeof make;
  readonly empty: typeof empty;
  readonly length: typeof length;
  readonly map: typeof map;
  readonly filter: typeof filter;
  readonly reduce: typeof reduce;
} = Object.freeze(
  Object.assign(arrayOf as typeof arrayOf & { readonly length: typeof length }, {
    make,
    empty,
    map,
    filter,
    reduce,
  }),
);

type ForEachOptions = { readonly discard?: boolean; readonly concurrency?: never };
/**
 * Effect `Effect.forEach(self, (a, i) => effect, { discard? })`: sequential and fail-fast
 * (ARR-003). Concurrency is refused until broader fiber semantics land.
 */
export const forEach: {
  <A, B, E>(
    f: (a: Expr<A>, i: Expr<bigint>) => Computation<B, E>,
  ): (self: Expr<ReadonlyArray<A>>) => Computation<ReadonlyArray<B>, E>;
  <A, B, E>(
    f: (a: Expr<A>, i: Expr<bigint>) => Computation<B, E>,
    options: { readonly discard: true },
  ): (self: Expr<ReadonlyArray<A>>) => Computation<void, E>;
  <A, B, E>(
    self: Expr<ReadonlyArray<A>>,
    f: (a: Expr<A>, i: Expr<bigint>) => Computation<B, E>,
  ): Computation<ReadonlyArray<B>, E>;
  <A, B, E>(
    self: Expr<ReadonlyArray<A>>,
    f: (a: Expr<A>, i: Expr<bigint>) => Computation<B, E>,
    options: { readonly discard: true },
  ): Computation<void, E>;
} = dual(
  (args) => args[0] instanceof Expr,
  (
    self: Expr<ReadonlyArray<unknown>>,
    f: (a: Expr<unknown>, i: Expr<bigint>) => Computation<unknown, unknown>,
    options?: ForEachOptions,
  ) => {
    if (options && "concurrency" in options)
      throw fail(
        "UNSUPPORTED_CONCURRENCY",
        "authoring",
        "Effect.forEach",
        "forEach is sequential in this profile",
      );
    const item = arrayItem(self.type);
    if (!item)
      throw fail("TYPE_MISMATCH", "authoring", "Effect.forEach", "forEach requires an array");
    const itemBinder = Symbol("reffect/forEach/item");
    const indexBinder = Symbol("reffect/forEach/index");
    const body = f(Expr.parameter(item, itemBinder, 0), Expr.parameter(U64Type, indexBinder, 0));
    const discard = options?.discard === true;
    const output: IRType<unknown> = discard ? UnitType : ArrayType.of(body.output);
    return Computation.make(output, body.error, {
      _tag: "ForEach",
      source: self,
      item: itemBinder,
      index: indexBinder,
      body,
      discard,
    });
  },
);

/** `Schema.Record(Schema.String, V)`: a string-keyed record in JS key order (RECJS-001). */
export class RecordType<V> extends Composite<{ readonly [key: string]: V }> {
  private constructor(readonly value: IRType<V>) {
    super(
      `reffect/record@1/${digest(value.id)}`,
      // R.String's schema is a refined `Schema.String`, whose static type erases the key brand.
      freeze(
        Schema.Record(StringType.schema as unknown as typeof Schema.String, value.schema),
      ) as unknown as Schema.Codec<{
        readonly [key: string]: V;
      }>,
      `Vec<(String, ${value.native.type})>`,
      { _tag: "Record", value },
    );
    Object.freeze(this);
  }
  static of<V>(key: IRType<string>, value: IRType<V>): RecordType<V> {
    if (!IRType.same(key, StringType) || !(value instanceof IRType))
      throw fail(
        "TYPE_MISMATCH",
        "authoring",
        "Record",
        "Records take R.String keys and a value witness",
      );
    return intern(["record", value], () => new RecordType(value));
  }
}
type RecordOf<V> = { readonly [key: string]: V };
const requireRecord = (self: Expr<unknown>, name: string) => {
  const value = recordValue(self.type);
  if (!value)
    throw fail("TYPE_MISMATCH", "authoring", `Record.${name}`, `${name} requires a Record`);
  return value;
};
/** Effect `Record.keys`: own keys in JS order. */
const recordKeys = <V>(self: Expr<RecordOf<V>>): Expr<ReadonlyArray<string>> => {
  requireRecord(self, "keys");
  return Expr.recordQuery("Keys", ArrayType.of(StringType), self);
};
/** Effect `Record.values`, in key order. */
const recordValues = <V>(self: Expr<RecordOf<V>>): Expr<ReadonlyArray<V>> =>
  Expr.recordQuery("Values", ArrayType.of(requireRecord(self, "values") as IRType<V>), self);
/** Effect `Record.size`, a JS number. */
const recordSize = <V>(self: Expr<RecordOf<V>>): Expr<number> => {
  requireRecord(self, "size");
  return Expr.recordQuery("Size", NumberType, self);
};
/** Effect `Record.has(self, key)`: whether `key` is an own key. */
const recordHas: {
  (key: Expr<string>): <V>(self: Expr<RecordOf<V>>) => Expr<boolean>;
  <V>(self: Expr<RecordOf<V>>, key: Expr<string>): Expr<boolean>;
} = dual(2, <V>(self: Expr<RecordOf<V>>, key: Expr<string>): Expr<boolean> => {
  requireRecord(self, "has");
  if (!IRType.same(key.type, StringType))
    throw fail("TYPE_MISMATCH", "authoring", "Record.has", "Keys are R.String values");
  return Expr.recordQuery("Has", BoolType, self, key);
});
export const RecordIR = Object.freeze(
  Object.assign(
    <V>(key: IRType<string>, value: IRType<V>): RecordType<V> => RecordType.of(key, value),
    { keys: recordKeys, values: recordValues, size: recordSize, has: recordHas },
  ),
);

/** Native variant names for literals: the literal when it is a Rust identifier, else positional. */
export const rustLiteralVariants = (literals: readonly string[]): readonly string[] => {
  const names = literals.map((literal, i) => rustIdent(literal) ?? `V${i}`);
  return new Set(names).size === names.length ? names : literals.map((_, i) => `V${i}`);
};
/** `Schema.Literals([...])` over strings: a Copy unit-variant enum (LIT-001). */
export class LiteralsType<L extends string> extends IRType<L> {
  private constructor(readonly literals: readonly L[]) {
    const key = JSON.stringify(literals);
    super(
      SemanticRef.type(`reffect/literals@1/${digest(key)}`),
      freeze(Schema.Literals(literals)) as unknown as Schema.Codec<L>,
      Object.freeze({ target: Targets.RustStd, type: `Literals_${digest(key)}` }),
      Object.freeze([Traits.Copyable, Traits.Cloneable, Traits.Eq]),
      Object.freeze({ _tag: "Literals" as const, literals: Object.freeze([...literals]) }),
    );
    Object.freeze(this);
  }
  static of<const L extends string>(literals: readonly [L, ...L[]]): LiteralsType<L> {
    if (
      !Array.isArray(literals) ||
      literals.length === 0 ||
      literals.some((literal) => typeof literal !== "string") ||
      new Set(literals).size !== literals.length
    )
      throw fail("TYPE_MISMATCH", "authoring", "Literals", "Literals are distinct strings");
    return intern(["literals", ...literals], () => new LiteralsType(literals));
  }
  /** A literal value of this union. */
  literal(value: L): Expr<L> {
    return Expr.literal(this, value);
  }
  /** The literal as the String it is: a union of string literals widened to String. */
  text(value: Expr<L>): Expr<string> {
    if (!IRType.same(value.type, this))
      throw fail("TYPE_MISMATCH", "authoring", "Literals.text", "The value is not of this union");
    return Expr.apply(literalTextOperation(this), value) as Expr<string>;
  }
}
const literalTexts = new WeakMap<AnyOperation, LiteralsType<string>>();
const literalTextOperations = new WeakMap<LiteralsType<string>, AnyOperation>();
const literalTextOperation = (type: LiteralsType<string>): AnyOperation => {
  const known = literalTextOperations.get(type);
  if (known) return known;
  const operation = Operation.make(
    SemanticRef.operation(`reffect/literals.text@1/${digest(type.id)}`),
    [type] as const,
    StringType,
    (value) => value,
  ).pipe(Operation.withCapabilities([Capabilities.String])) as unknown as AnyOperation;
  literalTextOperations.set(type, operation);
  literalTexts.set(operation, type);
  return operation;
};
/** The union an operation widens to String, when it is a `Literals.text` operation. */
export const literalTextOf = (operation: AnyOperation): LiteralsType<string> | undefined =>
  literalTexts.get(operation);
export const Literals = <const L extends string>(literals: readonly [L, ...L[]]): LiteralsType<L> =>
  LiteralsType.of(literals);
