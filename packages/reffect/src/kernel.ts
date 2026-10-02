import { Effect, Match, Option, Pipeable, Schema } from "effect";
import { dual } from "effect/Function";
import { emptySource, snapshotSource, SourceLocation } from "./source.ts";
import { isWellFormed, wellFormedMessage } from "./unicode.ts";
export { isWellFormed } from "./unicode.ts";
import type { SourceMetadata } from "./source.ts";
import type { EffectFn } from "./effect-ir.ts";

export const Diagnostic = Schema.Struct({
  code: Schema.String,
  stage: Schema.String,
  path: Schema.String,
  message: Schema.String,
  primary: Schema.optionalKey(SourceLocation),
  related: Schema.optionalKey(Schema.Array(SourceLocation)),
});
export type Diagnostic = typeof Diagnostic.Type;
export class CompileError extends Schema.TaggedError<CompileError>()("CompileError", {
  message: Schema.String,
  diagnostics: Schema.Array(Diagnostic),
}) {}
export const fail = (code: string, stage: string, path: string, message: string) =>
  new CompileError({ message, diagnostics: [{ code, stage, path, message }] });

export class SemanticRef<Kind extends string, Id extends string = string> extends Pipeable.Class {
  private constructor(
    readonly kind: Kind,
    readonly id: Id,
  ) {
    super();
    Object.freeze(this);
  }
  static type<const Id extends string>(id: Id) {
    return new SemanticRef("type", id);
  }
  static operation<const Id extends string>(id: Id) {
    return new SemanticRef("operation", id);
  }
  static target<const Id extends string>(id: Id) {
    return new SemanticRef("target", id);
  }
  static capability<const Id extends string>(id: Id) {
    return new SemanticRef("capability", id);
  }
  static effect<const Id extends string>(id: Id) {
    return new SemanticRef("effect", id);
  }
  static runtime<const Id extends string>(id: Id) {
    return new SemanticRef("runtime", id);
  }
  static policy<const Id extends string>(id: Id) {
    return new SemanticRef("policy", id);
  }
  static requirement<const Id extends string>(id: Id) {
    return new SemanticRef("requirement", id);
  }
  static trait<const Id extends string>(id: Id) {
    return new SemanticRef("trait", id);
  }
}
export type OperationRef<Id extends string = string> = SemanticRef<"operation", Id>;
export type Capability = SemanticRef<"capability">;
export type EffectRef = SemanticRef<"effect">;
export type Requirement = SemanticRef<"requirement">;
export const Capabilities = Object.freeze({
  U64: SemanticRef.capability("reffect/capability/u64@1"),
  Bool: SemanticRef.capability("reffect/capability/bool@1"),
  Unit: SemanticRef.capability("reffect/capability/unit@1"),
  String: SemanticRef.capability("reffect/capability/string@1"),
  AsyncResult: SemanticRef.capability("reffect/capability/async-result@1"),
  ScopedFiles: SemanticRef.capability("reffect/capability/scoped-files@1"),
  SyncResult: SemanticRef.capability("reffect/capability/sync-result@1"),
});
export const Targets = Object.freeze({ RustStd: SemanticRef.target("rust/std@1") });
export const Traits = Object.freeze({
  Copyable: SemanticRef.trait("Copyable"),
  Cloneable: SemanticRef.trait("Cloneable"),
  Eq: SemanticRef.trait("Eq"),
  TotallyOrdered: SemanticRef.trait("TotallyOrdered"),
});
export type Trait = SemanticRef<"trait">;
export interface NativeRepresentation {
  readonly target: SemanticRef<"target">;
  readonly type: string;
}
export const Native = Object.freeze({
  U64: Object.freeze({ target: Targets.RustStd, type: "u64" }) satisfies NativeRepresentation,
  Bool: Object.freeze({ target: Targets.RustStd, type: "bool" }) satisfies NativeRepresentation,
  Unit: Object.freeze({ target: Targets.RustStd, type: "()" }) satisfies NativeRepresentation,
  String: Object.freeze({ target: Targets.RustStd, type: "String" }) satisfies NativeRepresentation,
  Never: Object.freeze({
    target: Targets.RustStd,
    type: "std::convert::Infallible",
  }) satisfies NativeRepresentation,
});

export type Assurance = "claim" | "tested" | "proven" | "builtin";
export class Evidence extends Pipeable.Class {
  private constructor(
    readonly assurance: Assurance,
    readonly artifact: string,
  ) {
    super();
    Object.freeze(this);
  }
  static claim(artifact: string) {
    return new Evidence("claim", artifact);
  }
  static tested(artifact: string) {
    return new Evidence("tested", artifact);
  }
  static proven(artifact: string) {
    return new Evidence("proven", artifact);
  }
  static builtin(artifact: string) {
    return new Evidence("builtin", artifact);
  }
}
export const EvidencePolicy = Object.freeze({
  Tested: "tested",
  Proven: "proven",
  Builtin: "builtin",
} as const);
export class Law<Subject extends OperationRef = OperationRef> extends Pipeable.Class {
  private constructor(
    readonly subject: Subject,
    readonly kind: "Associative" | "Commutative" | "Identity" | "EquivalentToReference",
    readonly evidence: Evidence,
  ) {
    super();
    Object.freeze(this);
  }
  static associative<S extends OperationRef>(subject: S, evidence: Evidence) {
    return new Law(subject, "Associative", evidence);
  }
  static commutative<S extends OperationRef>(subject: S, evidence: Evidence) {
    return new Law(subject, "Commutative", evidence);
  }
  static equivalent<S extends OperationRef>(subject: S, evidence: Evidence) {
    return new Law(subject, "EquivalentToReference", evidence);
  }
  static permits(law: Law, subject: OperationRef, minimum: Exclude<Assurance, "claim">): boolean {
    const rank = { claim: 0, tested: 1, proven: 2, builtin: 3 };
    return (
      law.subject === subject &&
      law.evidence.artifact.length > 0 &&
      rank[law.evidence.assurance] >= rank[minimum]
    );
  }
}

/** Structural shape of a composite witness; scalar witnesses have none. */
export type Layout =
  | {
      readonly _tag: "Struct";
      readonly fields: readonly { readonly name: string; readonly type: IRType<unknown> }[];
      /** `_tag` literal of a tagged struct (a union case); not stored natively. */
      readonly tag: string | undefined;
      readonly identifier: string | undefined;
    }
  | { readonly _tag: "Union"; readonly cases: readonly IRType<unknown>[] };
export class IRType<A> extends Pipeable.Class {
  protected constructor(
    readonly ref: SemanticRef<"type">,
    readonly schema: Schema.Codec<A>,
    readonly native: NativeRepresentation,
    readonly traits: readonly Trait[],
    readonly layout?: Layout,
  ) {
    super();
  }
  get id() {
    return this.ref.id;
  }
  static make<A>(
    ref: SemanticRef<"type">,
    schema: Schema.Codec<A>,
    native: NativeRepresentation,
  ): IRType<A> {
    return Object.freeze(new IRType(ref, schema, native, Object.freeze([])));
  }
  static withTraits(traits: readonly Trait[]) {
    return <A>(self: IRType<A>): IRType<A> =>
      Object.freeze(
        new IRType(
          self.ref,
          self.schema,
          self.native,
          Object.freeze(Array.from(traits)),
          self.layout,
        ),
      );
  }
  static same(self: IRType<unknown>, other: IRType<unknown>): boolean {
    return self.ref === other.ref && self.schema === other.schema && self.native === other.native;
  }
}
export type Value<T> = T extends IRType<infer A> ? A : never;
export type Inputs<I extends readonly IRType<unknown>[]> = { readonly [K in keyof I]: Value<I[K]> };
export type Symbols<I extends readonly IRType<unknown>[]> = { [K in keyof I]: Expr<Value<I[K]>> };

/** Operand positions that must be literals, with a validator over their values. */
export interface LiteralArguments {
  readonly positions: readonly number[];
  readonly check: (values: readonly unknown[]) => string | undefined;
}
export class Operation<
  I extends readonly IRType<unknown>[] = readonly IRType<unknown>[],
  A = unknown,
  Ref extends OperationRef = OperationRef,
>
  extends Pipeable.Class
{
  private constructor(
    readonly ref: Ref,
    readonly input: I,
    readonly output: IRType<A>,
    readonly reference: (...args: Inputs<I>) => A,
    readonly effects: readonly EffectRef[],
    readonly requirements: readonly Requirement[],
    readonly capabilities: readonly Capability[],
    readonly laws: readonly Law<Ref>[],
    readonly literalArguments?: LiteralArguments,
  ) {
    super();
    Object.freeze(this);
  }
  get id() {
    return this.ref.id;
  }
  static make<const I extends readonly IRType<unknown>[], A, const Ref extends OperationRef>(
    ref: Ref,
    input: I,
    output: IRType<A>,
    reference: (...args: Inputs<I>) => A,
  ): Operation<I, A, Ref> {
    // Tuple erasure is internal; callers retain inferred signature tuples without assertions.
    return new Operation(
      ref,
      Object.freeze(Array.from(input)) as unknown as I,
      output,
      reference,
      Object.freeze([]),
      Object.freeze([]),
      Object.freeze([]),
      Object.freeze([]),
    );
  }
  static withCapabilities(capabilities: readonly Capability[]) {
    return <I extends readonly IRType<unknown>[], A, Ref extends OperationRef>(
      self: Operation<I, A, Ref>,
    ): Operation<I, A, Ref> =>
      new Operation(
        self.ref,
        self.input,
        self.output,
        self.reference,
        self.effects,
        self.requirements,
        Object.freeze(Array.from(capabilities)),
        self.laws,
        self.literalArguments,
      );
  }
  static withEffects(effects: readonly EffectRef[]) {
    return <I extends readonly IRType<unknown>[], A, Ref extends OperationRef>(
      self: Operation<I, A, Ref>,
    ): Operation<I, A, Ref> =>
      new Operation(
        self.ref,
        self.input,
        self.output,
        self.reference,
        Object.freeze(Array.from(effects)),
        self.requirements,
        self.capabilities,
        self.laws,
        self.literalArguments,
      );
  }
  static withRequirements(requirements: readonly Requirement[]) {
    return <I extends readonly IRType<unknown>[], A, Ref extends OperationRef>(
      self: Operation<I, A, Ref>,
    ): Operation<I, A, Ref> =>
      new Operation(
        self.ref,
        self.input,
        self.output,
        self.reference,
        self.effects,
        Object.freeze(Array.from(requirements)),
        self.capabilities,
        self.laws,
        self.literalArguments,
      );
  }
  static withLaws<const Subject extends OperationRef>(laws: readonly Law<Subject>[]) {
    return <I extends readonly IRType<unknown>[], A>(
      self: Operation<I, A, NoInfer<Subject>>,
    ): Operation<I, A, Subject> =>
      new Operation(
        self.ref,
        self.input,
        self.output,
        self.reference,
        self.effects,
        self.requirements,
        self.capabilities,
        Object.freeze(Array.from(laws)),
        self.literalArguments,
      );
  }
  /** Require literal operands at `positions`; the checker refuses other operand shapes. */
  static withLiteralArguments(literalArguments: LiteralArguments) {
    return <I extends readonly IRType<unknown>[], A, Ref extends OperationRef>(
      self: Operation<I, A, Ref>,
    ): Operation<I, A, Ref> =>
      new Operation(
        self.ref,
        self.input,
        self.output,
        self.reference,
        self.effects,
        self.requirements,
        self.capabilities,
        self.laws,
        Object.freeze({
          positions: Object.freeze(Array.from(literalArguments.positions)),
          check: literalArguments.check,
        }),
      );
  }
}
export type AnyOperation = Operation<readonly IRType<unknown>[], unknown>;
export type Node =
  | { readonly _tag: "Parameter"; readonly binder: symbol; readonly index: number }
  | { readonly _tag: "Literal"; readonly value: unknown }
  | {
      readonly _tag: "Apply";
      readonly operation: AnyOperation;
      readonly args: readonly Expr<unknown>[];
    }
  | {
      readonly _tag: "Match";
      readonly condition: Expr<boolean>;
      readonly onTrue: Expr<unknown>;
      readonly onFalse: Expr<unknown>;
    }
  /** Struct construction, or union-case construction when `tag` names a case of a union type. */
  | {
      readonly _tag: "Make";
      readonly tag: string | undefined;
      readonly fields: readonly Expr<unknown>[];
    }
  | { readonly _tag: "Get"; readonly value: Expr<unknown>; readonly field: string }
  | {
      readonly _tag: "MatchTags";
      readonly value: Expr<unknown>;
      readonly cases: readonly MatchCase<Expr<unknown>>[];
    };
/** One exhaustive tagged-union case; `binder` names the case-struct value. */
export interface MatchCase<Body> {
  readonly tag: string;
  readonly binder: symbol;
  readonly body: Body;
}
export type StructLayout = Extract<Layout, { readonly _tag: "Struct" }>;
const asStruct = (type: IRType<unknown>): StructLayout | undefined =>
  type.layout === undefined
    ? undefined
    : Match.value(type.layout).pipe(
        Match.tag("Struct", (layout) => layout),
        Match.orElse(() => undefined),
      );
/** The case witnesses of a tagged union, or undefined for any other witness. */
export const unionCases = (type: IRType<unknown>): readonly IRType<unknown>[] | undefined =>
  type.layout === undefined
    ? undefined
    : Match.value(type.layout).pipe(
        Match.tag("Union", (layout) => layout.cases),
        Match.orElse(() => undefined),
      );
/** The struct layout of a struct witness, or of the union case named by `tag`. */
export const structLayout = (type: IRType<unknown>, tag?: string): StructLayout | undefined =>
  tag === undefined
    ? asStruct(type)
    : unionCases(type)
        ?.map(asStruct)
        .find((layout) => layout?.tag === tag);
export class Expr<A> extends Pipeable.Class {
  private constructor(
    readonly type: IRType<A>,
    readonly node: Node,
    readonly source: SourceMetadata = emptySource,
  ) {
    super();
    Object.freeze(this);
  }
  withSource(source: SourceMetadata): Expr<A> {
    return new Expr(this.type, this.node, snapshotSource(source));
  }
  static parameter<A>(type: IRType<A>, binder: symbol, index: number): Expr<A> {
    return new Expr(type, Object.freeze({ _tag: "Parameter", binder, index }));
  }
  static literal<A>(this: void, type: IRType<A>, value: A): Expr<A> {
    return new Expr(
      type,
      Object.freeze({ _tag: "Literal", value: Schema.decodeUnknownSync(type.schema)(value) }),
    );
  }
  static apply<const I extends readonly IRType<unknown>[], A>(
    this: void,
    op: Operation<I, A>,
    ...args: Symbols<I>
  ): Expr<A> {
    return new Expr(
      op.output,
      Object.freeze({
        _tag: "Apply",
        operation: op as unknown as AnyOperation,
        args: Object.freeze(Array.from(args)),
      }),
    );
  }
  /** Build a struct (no `tag`) or a union case (`tag`); fields follow the layout's order. */
  static make<A>(
    this: void,
    type: IRType<A>,
    tag: string | undefined,
    fields: readonly Expr<unknown>[],
  ): Expr<A> {
    const layout = structLayout(type, tag);
    if (
      !layout ||
      layout.fields.length !== fields.length ||
      layout.fields.some((field, i) => !IRType.same(field.type, fields[i].type))
    )
      throw fail(
        "TYPE_MISMATCH",
        "authoring",
        "Struct.make",
        "Construction requires every declared field with its witness",
      );
    return new Expr(type, Object.freeze({ _tag: "Make", tag, fields: Object.freeze([...fields]) }));
  }
  static get<A>(this: void, value: Expr<unknown>, field: string): Expr<A> {
    const declared = structLayout(value.type)?.fields.find((f) => f.name === field);
    if (!declared)
      throw fail(
        "UNKNOWN_FIELD",
        "authoring",
        "Struct.get",
        `Unknown field ${JSON.stringify(field)}`,
      );
    return new Expr(declared.type as IRType<A>, Object.freeze({ _tag: "Get", value, field }));
  }
  /** Exhaustive tagged-union branching; every case receives its case-struct value. */
  static matchTags<A>(
    this: void,
    value: Expr<unknown>,
    output: IRType<A>,
    cases: readonly MatchCase<Expr<A>>[],
  ): Expr<A> {
    if (cases.some((c) => !IRType.same(c.body.type, output)))
      throw fail("TYPE_MISMATCH", "authoring", "match", "Every case must produce the same witness");
    return new Expr(
      output,
      Object.freeze({ _tag: "MatchTags", value, cases: Object.freeze([...cases]) }),
    );
  }
  static match<A>(condition: Expr<boolean>, onTrue: Expr<A>, onFalse: Expr<NoInfer<A>>): Expr<A> {
    if (!IRType.same(condition.type, BoolType) || !IRType.same(onTrue.type, onFalse.type))
      throw fail(
        "TYPE_MISMATCH",
        "authoring",
        "Match",
        "Boolean Match requires a Boolean condition and identical branch witnesses",
      );
    return new Expr(onTrue.type, Object.freeze({ _tag: "Match", condition, onTrue, onFalse }));
  }
  /**
   * Compiler-internal capture-free substitution: parameter nodes bound to
   * `binder` become `replacement(index)`. Shared nodes stay shared; cycles are refused.
   * `R.flow` uses this to inline one function body into the next.
   */
  static substitute<A>(
    this: void,
    root: Expr<A>,
    binder: symbol,
    replacement: (index: number) => Expr<unknown> | undefined,
  ): Expr<A> {
    const memo = new Map<Expr<unknown>, Expr<unknown>>();
    const active = new Set<Expr<unknown>>();
    const walk = (self: Expr<unknown>): Expr<unknown> => {
      const cached = memo.get(self);
      if (cached) return cached;
      if (active.has(self))
        throw fail("IR_CYCLE", "authoring", "substitute", "Expression graph contains a cycle");
      active.add(self);
      const result: Expr<unknown> = Match.value(self.node).pipe(
        Match.tagsExhaustive({
          Parameter: (n) => (n.binder === binder ? (replacement(n.index) ?? self) : self),
          Literal: () => self,
          Apply: (n) => {
            const args: Expr<unknown>[] = n.args.map((arg) => walk(arg));
            return args.every((arg, index) => arg === n.args[index])
              ? self
              : new Expr(
                  self.type,
                  Object.freeze({
                    _tag: "Apply",
                    operation: n.operation,
                    args: Object.freeze(args),
                  }),
                  self.source,
                );
          },
          Match: (n) => {
            const condition: Expr<boolean> = walk(n.condition) as Expr<boolean>;
            const onTrue = walk(n.onTrue);
            const onFalse = walk(n.onFalse);
            return condition === n.condition && onTrue === n.onTrue && onFalse === n.onFalse
              ? self
              : new Expr(
                  self.type,
                  Object.freeze({ _tag: "Match", condition, onTrue, onFalse }),
                  self.source,
                );
          },
          Make: (n) => {
            const fields = n.fields.map((field) => walk(field));
            return fields.every((field, i) => field === n.fields[i])
              ? self
              : new Expr(
                  self.type,
                  Object.freeze({ _tag: "Make", tag: n.tag, fields: Object.freeze(fields) }),
                  self.source,
                );
          },
          Get: (n) => {
            const value = walk(n.value);
            return value === n.value
              ? self
              : new Expr(
                  self.type,
                  Object.freeze({ _tag: "Get", value, field: n.field }),
                  self.source,
                );
          },
          MatchTags: (n) => {
            const value = walk(n.value);
            const cases = n.cases.map((c) => ({ ...c, body: walk(c.body) }));
            return value === n.value && cases.every((c, i) => c.body === n.cases[i].body)
              ? self
              : new Expr(
                  self.type,
                  Object.freeze({
                    _tag: "MatchTags",
                    value,
                    cases: Object.freeze(cases.map((c) => Object.freeze(c))),
                  }),
                  self.source,
                );
          },
        }),
      );
      active.delete(self);
      memo.set(self, result);
      return result;
    };
    return walk(root) as Expr<A>;
  }
}
export const apply = Expr.apply;
export class Fn<I extends readonly IRType<unknown>[] = readonly IRType<unknown>[], A = unknown>
  extends Pipeable.Class
{
  private constructor(
    readonly input: I,
    readonly output: IRType<A>,
    readonly binder: symbol,
    readonly body: Expr<A>,
    readonly source: SourceMetadata = emptySource,
  ) {
    super();
    Object.freeze(this);
  }
  withSource(source: SourceMetadata): Fn<I, A> {
    return new Fn(this.input, this.output, this.binder, this.body, snapshotSource(source));
  }
  static make<const I extends readonly IRType<unknown>[], A>(
    this: void,
    input: I,
    output: IRType<A>,
    build: (...args: Symbols<I>) => Expr<A>,
  ): Fn<I, A> {
    const binder = Symbol("reffect/function");
    const args = input.map((type, index) => Expr.parameter(type, binder, index)) as Symbols<I>;
    return new Fn(Object.freeze(Array.from(input)) as unknown as I, output, binder, build(...args));
  }
}
export type AnyFn = Fn | EffectFn;
export class Program extends Pipeable.Class {
  private constructor(readonly functions: Readonly<Record<string, AnyFn>>) {
    super();
    Object.freeze(this);
  }
  static make(this: void, functions: Readonly<Record<string, AnyFn>>): Program {
    return new Program(Object.freeze(Object.fromEntries(Object.entries(functions))));
  }
  static add(name: string, fn: AnyFn) {
    return (self: Program): Program =>
      Program.make(Object.fromEntries(Object.entries(self.functions).concat([[name, fn]])));
  }
}

export const U64Max = (1n << 64n) - 1n;
const makeU64Schema = () => {
  const schema = Schema.BigInt.check(
    Schema.makeFilter((n) => (n >= 0n && n <= U64Max) || "Expected an unsigned 64-bit bigint"),
  );
  // This is a new checked AST, not the shared Schema.BigInt AST. Protect its semantic boundary.
  for (const check of schema.ast.checks ?? []) Object.freeze(check);
  if (schema.ast.checks) Object.freeze(schema.ast.checks);
  Object.freeze(schema.ast);
  return Object.freeze(schema);
};
class U64Witness extends IRType<bigint> {
  constructor() {
    super(
      SemanticRef.type("reffect/u64@1"),
      makeU64Schema(),
      Native.U64,
      Object.freeze([Traits.Copyable, Traits.Cloneable, Traits.Eq, Traits.TotallyOrdered]),
    );
    Object.freeze(this);
  }
  readonly max = U64Max;
  literal(n: bigint) {
    return Expr.literal(this, n);
  }
  readonly add: {
    (that: Expr<bigint>): (self: Expr<bigint>) => Expr<bigint>;
    (self: Expr<bigint>, that: Expr<bigint>): Expr<bigint>;
  } = dual(2, (a: Expr<bigint>, b: Expr<bigint>) => Expr.apply(AddU64, a, b));
  readonly sub: {
    (that: Expr<bigint>): (self: Expr<bigint>) => Expr<bigint>;
    (self: Expr<bigint>, that: Expr<bigint>): Expr<bigint>;
  } = dual(2, (a: Expr<bigint>, b: Expr<bigint>) => Expr.apply(SubU64, a, b));
  readonly mul: {
    (that: Expr<bigint>): (self: Expr<bigint>) => Expr<bigint>;
    (self: Expr<bigint>, that: Expr<bigint>): Expr<bigint>;
  } = dual(2, (a: Expr<bigint>, b: Expr<bigint>) => Expr.apply(MulU64, a, b));
  readonly eq: {
    (that: Expr<bigint>): (self: Expr<bigint>) => Expr<boolean>;
    (self: Expr<bigint>, that: Expr<bigint>): Expr<boolean>;
  } = dual(2, (a: Expr<bigint>, b: Expr<bigint>) => Expr.apply(EqU64, a, b));
  readonly lt: {
    (that: Expr<bigint>): (self: Expr<bigint>) => Expr<boolean>;
    (self: Expr<bigint>, that: Expr<bigint>): Expr<boolean>;
  } = dual(2, (a: Expr<bigint>, b: Expr<bigint>) => Expr.apply(LtU64, a, b));
}
export const U64Type = new U64Witness();
const binary = <const Id extends string>(
  id: Id,
  reference: (a: bigint, b: bigint) => bigint,
  commutative = false,
) => {
  const ref = SemanticRef.operation(id);
  const op = Operation.make(ref, [U64Type, U64Type], U64Type, reference).pipe(
    Operation.withCapabilities([Capabilities.U64]),
  );
  return commutative
    ? op.pipe(
        Operation.withLaws([
          Law.associative(ref, Evidence.claim("docs/research/semantic-kernel.md")),
          Law.commutative(ref, Evidence.claim("docs/research/semantic-kernel.md")),
        ]),
      )
    : op;
};
export const AddU64 = binary("reffect/u64.add.wrap@1", (a, b) => BigInt.asUintN(64, a + b), true);
export const SubU64 = binary("reffect/u64.sub.wrap@1", (a, b) => BigInt.asUintN(64, a - b));
export const MulU64 = binary("reffect/u64.mul.wrap@1", (a, b) => BigInt.asUintN(64, a * b), true);
class BoolWitness extends IRType<boolean> {
  constructor() {
    // Own the AST so freezing this witness never mutates the upstream shared Schema.Boolean.
    const schema = Schema.Boolean.check(Schema.makeFilter(() => true));
    for (const check of schema.ast.checks ?? []) Object.freeze(check);
    if (schema.ast.checks) Object.freeze(schema.ast.checks);
    Object.freeze(schema.ast);
    Object.freeze(schema);
    super(
      SemanticRef.type("reffect/bool@1"),
      schema,
      Native.Bool,
      Object.freeze([Traits.Copyable, Traits.Cloneable, Traits.Eq, Traits.TotallyOrdered]),
    );
    Object.freeze(this);
  }
  literal(value: boolean) {
    return Expr.literal(this, value);
  }
  readonly not = (value: Expr<boolean>) => Expr.apply(NotBool, value);
  readonly eq: {
    (that: Expr<boolean>): (self: Expr<boolean>) => Expr<boolean>;
    (self: Expr<boolean>, that: Expr<boolean>): Expr<boolean>;
  } = dual(2, (a: Expr<boolean>, b: Expr<boolean>) => Expr.apply(EqBool, a, b));
}
export const BoolType = new BoolWitness();
class UnitWitness extends IRType<void> {
  constructor() {
    // Schema.Void discards arbitrary values; native unit admits exactly undefined.
    const schema = Schema.Undefined.check(Schema.makeFilter(() => true));
    for (const check of schema.ast.checks ?? []) Object.freeze(check);
    if (schema.ast.checks) Object.freeze(schema.ast.checks);
    Object.freeze(schema.ast);
    Object.freeze(schema);
    super(
      SemanticRef.type("reffect/unit@1"),
      schema,
      Native.Unit,
      Object.freeze([Traits.Copyable, Traits.Cloneable, Traits.Eq, Traits.TotallyOrdered]),
    );
    Object.freeze(this);
  }
  literal(): Expr<void> {
    return Expr.literal(this, undefined);
  }
}
export const UnitType = new UnitWitness();
const neverSchema = Schema.Never.check(Schema.makeFilter(() => true));
for (const check of neverSchema.ast.checks ?? []) Object.freeze(check);
if (neverSchema.ast.checks) Object.freeze(neverSchema.ast.checks);
Object.freeze(neverSchema.ast);
Object.freeze(neverSchema);
export const NeverType = IRType.make(
  SemanticRef.type("reffect/never@1"),
  neverSchema,
  Native.Never,
);
export const EqU64 = Operation.make(
  SemanticRef.operation("reffect/u64.eq@1"),
  [U64Type, U64Type],
  BoolType,
  (a, b) => a === b,
).pipe(Operation.withCapabilities([Capabilities.U64, Capabilities.Bool]));
export const LtU64 = Operation.make(
  SemanticRef.operation("reffect/u64.lt@1"),
  [U64Type, U64Type],
  BoolType,
  (a, b) => a < b,
).pipe(Operation.withCapabilities([Capabilities.U64, Capabilities.Bool]));
export const EqBool = Operation.make(
  SemanticRef.operation("reffect/bool.eq@1"),
  [BoolType, BoolType],
  BoolType,
  (a, b) => a === b,
).pipe(Operation.withCapabilities([Capabilities.Bool]));
export const NotBool = Operation.make(
  SemanticRef.operation("reffect/bool.not@1"),
  [BoolType],
  BoolType,
  (a) => !a,
).pipe(Operation.withCapabilities([Capabilities.Bool]));

/**
 * Well-formed Unicode text. Lone surrogates are refused at every decode boundary, so
 * equality, containment and literal replacement agree between JS UTF-16 and Rust UTF-8.
 */
class StringWitness extends IRType<string> {
  constructor() {
    const schema = Schema.String.check(
      Schema.makeFilter((value: string) => isWellFormed(value) || wellFormedMessage),
    );
    for (const check of schema.ast.checks ?? []) Object.freeze(check);
    if (schema.ast.checks) Object.freeze(schema.ast.checks);
    Object.freeze(schema.ast);
    Object.freeze(schema);
    super(
      SemanticRef.type("reffect/string@1"),
      schema,
      Native.String,
      Object.freeze([Traits.Cloneable, Traits.Eq]),
    );
    Object.freeze(this);
  }
  literal(value: string): Expr<string> {
    if (!isWellFormed(value))
      throw fail(
        "INVALID_LITERAL",
        "authoring",
        "String.literal",
        "String literals must be well-formed Unicode",
      );
    return Expr.literal(this, value);
  }
  readonly eq: {
    (that: Expr<string>): (self: Expr<string>) => Expr<boolean>;
    (self: Expr<string>, that: Expr<string>): Expr<boolean>;
  } = dual(2, (a: Expr<string>, b: Expr<string>) => Expr.apply(EqString, a, b));
  /** Effect `String.includes(searchString)(self)`; the position argument is not admitted. */
  readonly includes: {
    (searchString: Expr<string>): (self: Expr<string>) => Expr<boolean>;
    (self: Expr<string>, searchString: Expr<string>): Expr<boolean>;
  } = dual(2, (self: Expr<string>, search: Expr<string>) =>
    Expr.apply(IncludesString, self, search),
  );
  /**
   * Effect `String.replaceAll(searchValue, replaceValue)(self)` restricted to literal patterns:
   * a non-empty search and a replacement without `$` substitution patterns.
   */
  readonly replaceAll: {
    (searchValue: string, replaceValue: string): (self: Expr<string>) => Expr<string>;
    (self: Expr<string>, searchValue: string, replaceValue: string): Expr<string>;
  } = dual(3, (self: Expr<string>, search: string, replacement: string) => {
    const problem = replacementProblem([search, replacement]);
    if (problem) throw fail("LITERAL_ARGUMENT", "authoring", "String.replaceAll", problem);
    return Expr.apply(ReplaceAllString, self, this.literal(search), this.literal(replacement));
  });
}
const replacementProblem = (values: readonly unknown[]): string | undefined => {
  const [search, replacement] = values;
  if (typeof search !== "string" || search.length === 0)
    return "replaceAll requires a non-empty literal search";
  if (typeof replacement !== "string" || replacement.includes("$"))
    return "replaceAll replacements cannot contain $ substitution patterns";
  return undefined;
};
export const StringType = new StringWitness();
export const EqString = Operation.make(
  SemanticRef.operation("reffect/string.eq@1"),
  [StringType, StringType],
  BoolType,
  (a, b) => a === b,
).pipe(Operation.withCapabilities([Capabilities.String, Capabilities.Bool]));
export const IncludesString = Operation.make(
  SemanticRef.operation("reffect/string.includes@1"),
  [StringType, StringType],
  BoolType,
  (self, search) => self.includes(search),
).pipe(Operation.withCapabilities([Capabilities.String, Capabilities.Bool]));
export const ReplaceAllString = Operation.make(
  SemanticRef.operation("reffect/string.replace-all-literal@1"),
  [StringType, StringType, StringType],
  StringType,
  (self, search, replacement) => self.replaceAll(search, replacement),
).pipe(
  Operation.withCapabilities([Capabilities.String]),
  Operation.withLiteralArguments({ positions: [1, 2], check: replacementProblem }),
);

export const checkExpression = (
  root: Expr<unknown>,
  bindings: ReadonlyMap<symbol, readonly IRType<unknown>[]>,
  path: string,
): readonly Diagnostic[] => {
  const issues: Diagnostic[] = [];
  const add = (code: string, at: string, message: string) =>
    issues.push({ code, stage: "check", path: at, message });
  const active = new Set<Expr<unknown>>();
  const done = new Set<Expr<unknown>>();
  const ops = new Map<string, AnyOperation>();
  const walk = (e: Expr<unknown>, at: string) => {
    if (active.has(e)) {
      add("IR_CYCLE", at, "Expression graph contains a cycle");
      return;
    }
    if (done.has(e)) return;
    active.add(e);
    Match.value(e.node).pipe(
      Match.tagsExhaustive({
        Parameter: (n) => {
          const input = bindings.get(n.binder);
          if (!input || !Number.isInteger(n.index) || n.index < 0 || n.index >= input.length)
            add("FOREIGN_PARAMETER", at, "Parameter is outside this function's binder");
          else if (!IRType.same(input[n.index], e.type))
            add("TYPE_MISMATCH", at, "Parameter type witness differs from its declaration");
        },
        Match: (n) => {
          if (
            !IRType.same(n.condition.type, BoolType) ||
            !IRType.same(n.onTrue.type, e.type) ||
            !IRType.same(n.onFalse.type, e.type)
          )
            add("TYPE_MISMATCH", at, "Boolean Match condition/branch witnesses are inconsistent");
          walk(n.condition, `${at}.condition`);
          walk(n.onTrue, `${at}.onTrue`);
          walk(n.onFalse, `${at}.onFalse`);
        },
        Literal: (n) => {
          if (!Schema.is(e.type.schema)(n.value))
            add("INVALID_LITERAL", at, "Literal does not satisfy its IRType schema");
        },
        Make: (n) => {
          const layout = structLayout(e.type, n.tag);
          if (
            !layout ||
            layout.fields.length !== n.fields.length ||
            layout.fields.some((field, i) => !IRType.same(field.type, n.fields[i].type))
          )
            add("TYPE_MISMATCH", at, "Construction fields differ from the declared layout");
          n.fields.forEach((field, i) => walk(field, `${at}.fields[${i}]`));
        },
        Get: (n) => {
          const declared = structLayout(n.value.type)?.fields.find((f) => f.name === n.field);
          if (!declared || !IRType.same(declared.type, e.type))
            add("TYPE_MISMATCH", at, "Field access differs from the declared layout");
          walk(n.value, `${at}.value`);
        },
        MatchTags: (n) => {
          const unionTypes = unionCases(n.value.type);
          const tags = unionTypes?.map((c) => structLayout(c)?.tag);
          if (
            !tags ||
            tags.length !== n.cases.length ||
            tags.some((tag) => n.cases.filter((c) => c.tag === tag).length !== 1)
          )
            add("NON_EXHAUSTIVE_MATCH", at, "Tagged match requires exactly one case per union tag");
          walk(n.value, `${at}.value`);
          n.cases.forEach((c, i) => {
            const caseType = unionTypes?.[tags!.indexOf(c.tag)];
            if (!IRType.same(c.body.type, e.type))
              add(
                "TYPE_MISMATCH",
                `${at}.cases[${i}]`,
                "Case witness differs from the match result",
              );
            if (!caseType) return;
            const nested = new Map(bindings);
            nested.set(c.binder, [caseType]);
            issues.push(...checkExpression(c.body, nested, `${at}.cases[${i}]`));
          });
        },
        Apply: (n) => {
          const op = n.operation;
          if (ops.has(op.id) && ops.get(op.id) !== op)
            add("IDENTITY_COLLISION", at, `Distinct operations share ${op.id}`);
          ops.set(op.id, op);
          if (op.effects.length || op.requirements.length)
            add("EFFECT_IN_EXPR", at, "Pure Expr cannot contain effects or service requirements");
          if (n.args.length !== op.input.length)
            add("ARITY_MISMATCH", at, `Expected ${op.input.length} operands`);
          if (!IRType.same(e.type, op.output))
            add("TYPE_MISMATCH", at, "Operation result witness differs from its output");
          for (const law of op.laws)
            if (law.subject !== op.ref || !law.evidence.artifact)
              add(
                "INVALID_LAW",
                at,
                "Law evidence must name this operation reference and an artifact",
              );
          if (op.literalArguments) {
            const literals = op.literalArguments.positions.map((i) =>
              n.args[i] === undefined
                ? Option.none()
                : Match.value(n.args[i].node).pipe(
                    Match.tag("Literal", (literal) => Option.some(literal.value)),
                    Match.orElse(() => Option.none()),
                  ),
            );
            const values = Option.all(literals);
            if (Option.isNone(values))
              add("LITERAL_ARGUMENT", at, `${op.id} requires literal operands`);
            else {
              const problem = op.literalArguments.check(values.value);
              if (problem) add("LITERAL_ARGUMENT", at, problem);
            }
          }
          n.args.forEach((arg, i) => {
            if (!op.input[i] || !IRType.same(arg.type, op.input[i]))
              add(
                "TYPE_MISMATCH",
                `${at}.args[${i}]`,
                "Operand IRType witness differs from operation signature",
              );
            walk(arg, `${at}.args[${i}]`);
          });
        },
      }),
    );
    active.delete(e);
    done.add(e);
  };
  walk(root, path);
  return issues;
};
export const checkFunction = (f: Fn, path: string): readonly Diagnostic[] => [
  ...(!IRType.same(f.body.type, f.output)
    ? [
        {
          code: "TYPE_MISMATCH",
          stage: "check",
          path,
          message: "Function body witness differs from declared output",
        },
      ]
    : []),
  ...checkExpression(f.body, new Map([[f.binder, f.input]]), `${path}.body`),
];
export const evaluateExpression = (
  root: Expr<unknown>,
  bindings: ReadonlyMap<symbol, readonly unknown[]>,
): unknown => {
  const cache = new Map<Expr<unknown>["node"], unknown>();
  // Tagged-match binders extend the scope; each match node evaluates at most once per call.
  const scope = new Map(bindings);
  const evaluate = (e: Expr<unknown>): unknown => {
    if (cache.has(e.node)) return cache.get(e.node);
    const value = Match.value(e.node).pipe(
      Match.tagsExhaustive({
        Parameter: (n) => scope.get(n.binder)![n.index],
        Literal: (n) => n.value,
        Apply: (n) => n.operation.reference(...n.args.map(evaluate)),
        Match: (n) => (evaluate(n.condition) ? evaluate(n.onTrue) : evaluate(n.onFalse)),
        Make: (n) => {
          const layout = structLayout(e.type, n.tag)!;
          const value: Record<string, unknown> =
            layout.tag === undefined ? {} : { _tag: layout.tag };
          layout.fields.forEach((field, i) => (value[field.name] = evaluate(n.fields[i])));
          return value;
        },
        Get: (n) => (evaluate(n.value) as Record<string, unknown>)[n.field],
        MatchTags: (n) => {
          const value = evaluate(n.value) as { readonly _tag: string };
          const selected = n.cases.find((c) => c.tag === value._tag)!;
          scope.set(selected.binder, [value]);
          return evaluate(selected.body);
        },
      }),
    );
    Schema.decodeUnknownSync(e.type.schema)(value);
    cache.set(e.node, value);
    return value;
  };
  return evaluate(root);
};
const runUnknown = Effect.fn("Reference.runUnknown")(function* <
  I extends readonly IRType<unknown>[],
  A,
>(f: Fn<I, A>, args: readonly unknown[]) {
  const issues = checkFunction(f, "function");
  if (issues.length)
    return yield* new CompileError({ message: "Invalid function", diagnostics: issues });
  if (args.length !== f.input.length)
    return yield* fail("ARITY_MISMATCH", "reference", "args", "Incorrect input count");
  const values: unknown[] = [];
  for (let i = 0; i < args.length; i++)
    values.push(
      yield* Schema.decodeUnknownEffect(f.input[i].schema)(args[i]).pipe(
        Effect.mapError((e) => fail("INVALID_INPUT", "reference", `args[${i}]`, e.message)),
      ),
    );
  return yield* Effect.try({
    try: () => evaluateExpression(f.body, new Map([[f.binder, values]])) as A,
    catch: (cause) => fail("REFERENCE_FAILURE", "reference", "function.body", String(cause)),
  });
});
export const PureReference = {
  runUnknown,
  run: <I extends readonly IRType<unknown>[], A>(f: Fn<I, A>, args: Inputs<I>) =>
    runUnknown(f, args),
};
