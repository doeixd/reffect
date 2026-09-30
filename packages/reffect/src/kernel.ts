import { Effect, Match, Pipeable, Schema } from "effect";
import { dual } from "effect/Function";

export const Diagnostic = Schema.Struct({
  code: Schema.String,
  stage: Schema.String,
  path: Schema.String,
  message: Schema.String,
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

export class IRType<A> extends Pipeable.Class {
  protected constructor(
    readonly ref: SemanticRef<"type">,
    readonly schema: Schema.Codec<A>,
    readonly native: NativeRepresentation,
    readonly traits: readonly Trait[],
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
        new IRType(self.ref, self.schema, self.native, Object.freeze(Array.from(traits))),
      );
  }
  static same(self: IRType<unknown>, other: IRType<unknown>): boolean {
    return self.ref === other.ref && self.schema === other.schema && self.native === other.native;
  }
}
export type Value<T> = T extends IRType<infer A> ? A : never;
export type Inputs<I extends readonly IRType<unknown>[]> = { readonly [K in keyof I]: Value<I[K]> };
export type Symbols<I extends readonly IRType<unknown>[]> = { [K in keyof I]: Expr<Value<I[K]>> };

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
    };
export class Expr<A> extends Pipeable.Class {
  private constructor(
    readonly type: IRType<A>,
    readonly node: Node,
  ) {
    super();
    Object.freeze(this);
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
  ) {
    super();
    Object.freeze(this);
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
export class Program extends Pipeable.Class {
  private constructor(readonly functions: Readonly<Record<string, Fn>>) {
    super();
    Object.freeze(this);
  }
  static make(this: void, functions: Readonly<Record<string, Fn>>): Program {
    return new Program(Object.freeze(Object.fromEntries(Object.entries(functions))));
  }
  static add(name: string, fn: Fn) {
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
export const R = Object.freeze({
  fn: Fn.make,
  program: Program.make,
  literal: Expr.literal,
  U64: U64Type,
});

export const checkFunction = (f: Fn, path: string): readonly Diagnostic[] => {
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
          if (
            n.binder !== f.binder ||
            !Number.isInteger(n.index) ||
            n.index < 0 ||
            n.index >= f.input.length
          )
            add("FOREIGN_PARAMETER", at, "Parameter is outside this function's binder");
          else if (!IRType.same(f.input[n.index], e.type))
            add("TYPE_MISMATCH", at, "Parameter type witness differs from its declaration");
        },
        Literal: (n) => {
          if (!Schema.is(e.type.schema)(n.value))
            add("INVALID_LITERAL", at, "Literal does not satisfy its IRType schema");
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
  if (!IRType.same(f.body.type, f.output))
    add("TYPE_MISMATCH", path, "Function body witness differs from declared output");
  walk(f.body, `${path}.body`);
  return issues;
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
  const cache = new Map<Expr<unknown>, unknown>();
  const evaluate = (e: Expr<unknown>): unknown => {
    if (cache.has(e)) return cache.get(e);
    const value = Match.value(e.node).pipe(
      Match.tagsExhaustive({
        Parameter: (n) => values[n.index],
        Literal: (n) => n.value,
        Apply: (n) => n.operation.reference(...n.args.map(evaluate)),
      }),
    );
    Schema.decodeUnknownSync(e.type.schema)(value);
    cache.set(e, value);
    return value;
  };
  return yield* Effect.try({
    try: () => evaluate(f.body) as A,
    catch: (cause) => fail("REFERENCE_FAILURE", "reference", "function.body", String(cause)),
  });
});
export const Reference = {
  runUnknown,
  run: <I extends readonly IRType<unknown>[], A>(f: Fn<I, A>, args: Inputs<I>) =>
    runUnknown(f, args),
};
