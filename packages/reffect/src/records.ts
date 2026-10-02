import { Schema } from "effect";
import { dual } from "effect/Function";
import {
  Expr,
  IRType,
  SemanticRef,
  Targets,
  Traits,
  fail,
  structLayout,
  unionCases,
} from "./kernel.ts";
import type { Layout, MatchCase, StructLayout, Value } from "./kernel.ts";
import { Computation, joinType } from "./effect-ir.ts";
import { RustIdent } from "./rust-emit.ts";

/** Field witnesses of a struct, in declaration (and wire-encoding) order. */
export type Fields = { readonly [name: string]: IRType<any> };
export type StructValue<F extends Fields> = { readonly [K in keyof F]: Value<F[K]> };
type FieldExprs<F extends Fields> = { readonly [K in keyof F]: Expr<Value<F[K]>> };
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
// FNV-1a: stable, dependency-free naming digest; identity never depends on it.
const digest = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};
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

// Structural interning: identical structures share one witness, so IRType.same stays identity.
const interned = new Map<unknown, unknown>();
const intern = <W>(path: readonly unknown[], make: () => W): W => {
  let node: Map<unknown, unknown> = interned;
  for (const key of path) {
    let next = node.get(key) as Map<unknown, unknown> | undefined;
    if (!next) node.set(key, (next = new Map()));
    node = next;
  }
  const existing = node.get(intern);
  if (existing) return existing as W;
  const witness = make();
  node.set(intern, witness);
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

const fieldList = (fields: Fields) => {
  if (Object.hasOwn(fields, "_tag"))
    throw fail("RESERVED_FIELD", "authoring", "Struct", "`_tag` is reserved for tagged unions");
  return Object.entries(fields).map(([name, type]) => {
    if (!(type instanceof IRType))
      throw fail("TYPE_MISMATCH", "authoring", `Struct.${name}`, "Fields require IRType witnesses");
    return Object.freeze({ name, type: type as IRType<unknown> });
  });
};
const structKey = (layout: StructLayout) =>
  JSON.stringify([
    layout.tag ?? null,
    layout.identifier ?? null,
    layout.fields.map((f) => [f.name, f.type.id]),
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
      ...Object.fromEntries(list.map((f) => [f.name, f.type.schema])),
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
      ["struct", tag, identifier, ...list.flatMap((f) => [f.name, f.type])],
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
const ordered = (
  type: IRType<unknown>,
  values: { readonly [name: string]: Expr<unknown> },
  tag?: string,
) => {
  const layout = structLayout(type, tag)!;
  const names = Object.keys(values);
  if (
    names.length !== layout.fields.length ||
    names.some((n) => !layout.fields.some((f) => f.name === n))
  )
    throw fail(
      "TYPE_MISMATCH",
      "authoring",
      "make",
      "Construction requires exactly the declared fields",
    );
  return layout.fields.map((field) => values[field.name]);
};

/** A union case: constructing it yields the union-typed value (narrower than Effect, REC-002). */
export type CaseType<Tag extends string, F extends Fields, U> = Omit<
  StructType<F, CaseValue<Tag, F>>,
  "make"
> & {
  readonly make: (values: FieldExprs<F>) => Expr<U>;
};
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
          make: (values: { readonly [name: string]: Expr<unknown> }) =>
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

/** Effect `Match.valueTags(value, handlers)`, data-first or data-last. */
type AnyHandlers = {
  readonly [tag: string]: (value: Expr<any>) => Expr<any> | Computation<any, any>;
};
export const valueTags: {
  <const H extends AnyHandlers>(handlers: H): (value: Expr<unknown>) => MatchResult<H>;
  <const H extends AnyHandlers>(value: Expr<unknown>, handlers: H): MatchResult<H>;
} = dual<
  <const H extends AnyHandlers>(handlers: H) => (value: Expr<unknown>) => MatchResult<H>,
  <const H extends AnyHandlers>(value: Expr<unknown>, handlers: H) => MatchResult<H>
>(2, (value, handlers) => matchTags(value, handlers));

/** `Struct.get(key)(self)` / `Struct.get(self, key)`. */
const get: {
  <S, const K extends keyof S & string>(key: K): (self: Expr<S>) => Expr<S[K]>;
  <S, const K extends keyof S & string>(self: Expr<S>, key: K): Expr<S[K]>;
} = dual(2, (self: Expr<unknown>, key: string) => Expr.get(self, key));

export const Struct = Object.assign(
  <const F extends Fields>(fields: F): StructType<F> => StructType.of(fields),
  { get },
);
export const TaggedUnion = <const C extends { readonly [tag: string]: Fields }>(
  casesByTag: C,
): TaggedUnionType<C> => TaggedUnionType.of(casesByTag);
