import { Context, Effect, Layer, Match, Pipeable } from "effect";
import { SourceMaps } from "./source-artifact.ts";
import type { SourceMap } from "./source-artifact.ts";
import type { GeneratedFiles } from "./cargo.ts";
import { locateCompileError } from "./provenance.ts";
import { Cargo } from "./cargo.ts";
import { Foldkit } from "./foldkit.ts";
import { EffectFn, SyncEffects, checkEffectFunction } from "./effect-ir.ts";
import type { Computation } from "./effect-ir.ts";
import { lowerFunctions, emitFunctions } from "./lower.ts";
import type { RustModule } from "./lower.ts";
export { RustExpr } from "./lower.ts";
export type { RustBinding, RustModule } from "./lower.ts";
import {
  AddU64,
  Capabilities,
  IRType,
  CompileError,
  MulU64,
  SubU64,
  Targets,
  SemanticRef,
  U64Type,
  BoolType,
  NeverType,
  EqU64,
  LtU64,
  EqBool,
  NotBool,
  checkFunction,
  fail,
} from "./kernel.ts";
import type {
  AnyOperation,
  Capability,
  EffectRef,
  Expr,
  Fn,
  OperationRef,
  Program,
  Requirement,
} from "./kernel.ts";

export interface Implementation {
  readonly id: string;
  readonly operation: AnyOperation;
  readonly target: SemanticRef<"target">;
  readonly strategy: "generated";
  readonly capabilities: readonly Capability[];
  readonly crates: readonly string[];
  readonly rationale: string;
  readonly method: "wrapping_add" | "wrapping_sub" | "wrapping_mul" | "eq" | "lt" | "not";
}
export class Target extends Pipeable.Class {
  private constructor(
    readonly ref: SemanticRef<"target">,
    readonly capabilities: readonly Capability[],
    readonly implementations: readonly Implementation[],
  ) {
    super();
    Object.freeze(this);
  }
  get id() {
    return this.ref.id;
  }
  static make(ref: SemanticRef<"target">, implementations: readonly Implementation[]): Target {
    return new Target(ref, Object.freeze([]), Object.freeze(Array.from(implementations)));
  }
  static withCapabilities(capabilities: readonly Capability[]) {
    return (self: Target): Target =>
      new Target(self.ref, Object.freeze(Array.from(capabilities)), self.implementations);
  }
}
const implementation = (
  operation: AnyOperation,
  method: Implementation["method"],
): Implementation =>
  Object.freeze({
    id: `rust/${operation.id}`,
    operation,
    target: Targets.RustStd,
    strategy: "generated",
    capabilities: operation.capabilities,
    crates: Object.freeze([]),
    method,
    rationale: `Verified primitive Rust ${method} implements ${operation.id} without coercion`,
  });
const implementations = Object.freeze([
  implementation(AddU64 as AnyOperation, "wrapping_add"),
  implementation(SubU64 as AnyOperation, "wrapping_sub"),
  implementation(MulU64 as AnyOperation, "wrapping_mul"),
  implementation(EqU64 as AnyOperation, "eq"),
  implementation(LtU64 as AnyOperation, "lt"),
  implementation(EqBool as AnyOperation, "eq"),
  implementation(NotBool as AnyOperation, "not"),
]);
const syncResultAdapter = Object.freeze({
  ref: SemanticRef.runtime("rust/std-result@1"),
  target: Targets.RustStd,
  strategy: "generated" as const,
  rationale:
    "Synchronous typed success/failure lowers to std::result::Result; Boolean branches and continuations remain lazy",
});
export const Rust = Object.freeze({
  syncResult: syncResultAdapter,
  std: Target.make(Targets.RustStd, implementations).pipe(
    Target.withCapabilities([Capabilities.U64, Capabilities.Bool, Capabilities.SyncResult]),
  ),
});

export interface Analysis {
  readonly program: Program;
  readonly operations: readonly AnyOperation[];
  readonly capabilities: readonly Capability[];
  readonly effects: readonly EffectRef[];
  readonly requirements: readonly Requirement[];
  readonly types: readonly IRType<unknown>[];
}
export interface Selection {
  readonly operation: AnyOperation;
  readonly selected: Implementation;
  readonly rejected: readonly { readonly id: string; readonly reason: string }[];
}
export class Plan extends Pipeable.Class {
  readonly runtime: typeof syncResultAdapter | undefined;
  private constructor(
    readonly analysis: Analysis,
    readonly target: Target,
    readonly selections: readonly Selection[],
    readonly crates: readonly string[],
  ) {
    super();
    this.runtime = analysis.effects.length === 0 ? undefined : syncResultAdapter;
    Object.freeze(this);
  }
  static make(
    analysis: Analysis,
    target: Target,
    selections: readonly Selection[],
    crates: readonly string[],
  ): Plan {
    return new Plan(
      analysis,
      target,
      Object.freeze(Array.from(selections)),
      Object.freeze(Array.from(crates)),
    );
  }
  static withSelections(selections: readonly Selection[]) {
    return (self: Plan): Plan => Plan.make(self.analysis, self.target, selections, self.crates);
  }
  static withCrates(crates: readonly string[]) {
    return (self: Plan): Plan => Plan.make(self.analysis, self.target, self.selections, crates);
  }
}
export interface Ownership {
  readonly plan: Plan;
  readonly mode: "primitive-copy";
  readonly rationale: string;
}
export interface Artifact extends GeneratedFiles {
  readonly auxiliaryFiles: Readonly<Record<"reffect.sources.json" | "reffect.build.json", string>>;
  readonly sources: SourceMap;
  readonly explanation: Plan;
  readonly stages: readonly string[];
}
export const stages = Object.freeze([
  "check",
  "derive",
  "normalize",
  "plan",
  "verify",
  "optimize",
  "ownership",
  "lower",
  "emit",
]);

// Prefixing with r_ also makes Rust keywords legal and keeps source names out of syntax positions.
const validName = /^[A-Za-z][A-Za-z0-9_]*$/;
const check = Effect.fn("Compile.check")(function* (program: Program) {
  const issues = Object.entries(program.functions).flatMap(([name, f]) => [
    ...(!validName.test(name)
      ? [
          {
            code: "INVALID_NAME",
            stage: "check",
            path: `functions.${name}`,
            message: "Function name must be an ASCII identifier",
          },
        ]
      : []),
    ...(f instanceof EffectFn
      ? checkEffectFunction(f, `functions.${name}`)
      : checkFunction(f, `functions.${name}`)),
  ]);
  if (!Object.keys(program.functions).length)
    return yield* fail("EMPTY_PROGRAM", "check", "functions", "At least one function is required");
  if (issues.length)
    return yield* new CompileError({ message: "Invalid program", diagnostics: issues });
  return program;
});

const derive = Effect.fn("Compile.derive")(function* (
  program: Program,
): Effect.fn.Return<Analysis, CompileError> {
  yield* check(program);
  const found = new Map<OperationRef, AnyOperation>();
  const serializedIds = new Map<string, OperationRef>();
  const types = new Set<IRType<unknown>>();
  const effectRefs = new Set<EffectRef>();
  const visited = new Set<Expr<unknown>>();
  const walk = (e: Expr<unknown>) => {
    if (visited.has(e)) return;
    visited.add(e);
    types.add(e.type);
    Match.value(e.node).pipe(
      Match.tagsExhaustive({
        Parameter: () => {},
        Literal: () => {},
        Match: (n) => {
          walk(n.condition);
          walk(n.onTrue);
          walk(n.onFalse);
        },
        Apply: (n) => {
          const op = n.operation;
          if (
            (serializedIds.has(op.id) && serializedIds.get(op.id) !== op.ref) ||
            (found.has(op.ref) && found.get(op.ref) !== op)
          )
            throw fail(
              "IDENTITY_COLLISION",
              "derive",
              op.id,
              "Distinct operations share a semantic ID",
            );
          serializedIds.set(op.id, op.ref);
          found.set(op.ref, op);
          n.args.forEach(walk);
        },
      }),
    );
  };
  const seenComputations = new Set<Computation<unknown, unknown>>();
  const walkComputation = (c: Computation<unknown, unknown>) => {
    if (seenComputations.has(c)) return;
    seenComputations.add(c);
    types.add(c.output);
    types.add(c.error);
    Match.value(c.node).pipe(
      Match.tagsExhaustive({
        Succeed: (n) => {
          effectRefs.add(SyncEffects.Succeed);
          walk(n.value);
        },
        Fail: (n) => {
          effectRefs.add(SyncEffects.Fail);
          walk(n.error);
        },
        Map: (n) => {
          effectRefs.add(SyncEffects.Map);
          walkComputation(n.source);
          walk(n.body);
        },
        FlatMap: (n) => {
          effectRefs.add(SyncEffects.FlatMap);
          walkComputation(n.source);
          walkComputation(n.body);
        },
        Match: (n) => {
          effectRefs.add(SyncEffects.Match);
          walk(n.condition);
          walkComputation(n.onTrue);
          walkComputation(n.onFalse);
        },
      }),
    );
  };
  yield* Effect.try({
    try: () =>
      Object.values(program.functions).forEach((f) => {
        f.input.forEach((type) => types.add(type));
        types.add(f.output);
        if (f instanceof EffectFn) {
          types.add(f.error);
          walkComputation(f.body);
        } else walk(f.body);
      }),
    catch: (e) =>
      e instanceof CompileError ? e : fail("INVALID_IR", "derive", "program", String(e)),
  });
  const operations = Object.freeze([...found.values()].sort((a, b) => a.id.localeCompare(b.id)));
  const collect = <A extends SemanticRef<string>>(refs: readonly A[]) =>
    Object.freeze(Array.from(new Set(refs)).sort((a, b) => a.id.localeCompare(b.id)));
  return Object.freeze({
    program,
    operations,
    capabilities: collect([
      ...operations.flatMap((op) => op.capabilities),
      ...Array.from(types).flatMap((type): readonly Capability[] =>
        IRType.same(type, U64Type)
          ? [Capabilities.U64]
          : IRType.same(type, BoolType)
            ? [Capabilities.Bool]
            : [],
      ),
      ...(effectRefs.size ? [Capabilities.SyncResult] : []),
    ]),
    effects: collect([...operations.flatMap((op) => op.effects), ...effectRefs]),
    requirements: collect(operations.flatMap((op) => op.requirements)),
    types: Object.freeze(Array.from(types)),
  });
});
const normalize = Effect.fn("Compile.normalize")(function* (analysis: Analysis) {
  // The expression DAG is already canonical for the bootstrap subset. Re-derive to avoid stale reports.
  return yield* derive(analysis.program);
});

const plan = Effect.fn("Compile.plan")(function* (
  analysis: Analysis,
  target: Target = Rust.std,
): Effect.fn.Return<Plan, CompileError> {
  if (target.ref !== Targets.RustStd)
    return yield* fail(
      "UNSUPPORTED_TARGET",
      "plan",
      target.id,
      "No verified lowering registered for this target",
    );
  const derived = yield* derive(analysis.program);
  const selections: Selection[] = [];
  for (const op of derived.operations) {
    const rejected: { id: string; reason: string }[] = [];
    let selected: Implementation | undefined;
    for (const candidate of target.implementations.filter((i) => i.operation.id === op.id)) {
      const reason =
        candidate.operation.ref !== op.ref || candidate.operation !== op
          ? "Semantic identity collision"
          : candidate.target !== target.ref
            ? "Wrong target"
            : op.capabilities.some(
                  (c) => !target.capabilities.includes(c) || !candidate.capabilities.includes(c),
                )
              ? "Missing capability"
              : !implementations.includes(candidate)
                ? "No verified Rust lowering registered for this candidate"
                : undefined;
      if (reason) rejected.push({ id: candidate.id, reason });
      else if (selected)
        rejected.push({ id: candidate.id, reason: "An earlier compatible candidate was selected" });
      else selected = candidate;
    }
    if (!selected)
      return yield* fail(
        "UNSUPPORTED_OPERATION",
        "plan",
        op.id,
        `No semantics-preserving implementation for ${op.id}: ${rejected.map((r) => r.reason).join(", ") || "no candidates"}`,
      );
    selections.push(Object.freeze({ operation: op, selected, rejected: Object.freeze(rejected) }));
  }
  for (const capability of derived.capabilities) {
    if (!target.capabilities.includes(capability))
      return yield* fail(
        "UNSUPPORTED_CAPABILITY",
        "plan",
        capability.id,
        "Target lacks a required representation/control-flow capability",
      );
  }
  if (
    derived.effects.some(
      (ref) => !Object.values(SyncEffects).some((supported) => supported === ref),
    )
  )
    return yield* fail(
      "UNSUPPORTED_EFFECT",
      "plan",
      "effects",
      "No verified synchronous Result adapter for this effect",
    );
  return Plan.make(
    derived,
    target,
    selections,
    Array.from(new Set(selections.flatMap((s) => s.selected.crates))).sort(),
  );
});
const verify = Effect.fn("Compile.verify")(function* (p: Plan) {
  const expected = yield* plan(p.analysis, p.target);
  if (
    p.runtime !== expected.runtime ||
    p.selections.length !== expected.selections.length ||
    p.selections.some(
      (s, i) =>
        s.operation !== expected.selections[i].operation ||
        s.selected !== expected.selections[i].selected,
    ) ||
    p.crates.join() !== expected.crates.join()
  )
    return yield* fail(
      "INVALID_PLAN",
      "verify",
      "selections",
      "Selected plan does not cover the reachable graph with verified implementations",
    );
  for (const type of expected.analysis.types) {
    if (![U64Type, BoolType, NeverType].some((builtin) => IRType.same(type, builtin)))
      return yield* fail(
        "UNSUPPORTED_REPRESENTATION",
        "verify",
        type.id,
        "Only canonical Boolean/u64/Never witnesses have registered native representations",
      );
  }
  for (const f of Object.values(expected.analysis.program.functions)) {
    if (f.input.some((type) => IRType.same(type, NeverType)))
      return yield* fail(
        "UNSUPPORTED_REPRESENTATION",
        "verify",
        "input",
        "Never cannot be supplied as a runtime input",
      );
  }
  return expected;
});
const optimize = Effect.fn("Compile.optimize")(function* (p: Plan) {
  // No law-driven rewrites until evidence/conformance infrastructure warrants them.
  return yield* verify(p);
});
const analyzeOwnership = Effect.fn("Compile.ownership")(function* (
  p: Plan,
): Effect.fn.Return<Ownership, CompileError> {
  return Object.freeze({
    plan: yield* verify(p),
    mode: "primitive-copy",
    rationale:
      "Boolean/u64 are Copy; Never is uninhabited. Branch and continuation scopes keep values local.",
  });
});
const lower = Effect.fn("Compile.lower")(function* (
  ownership: Ownership,
): Effect.fn.Return<RustModule, CompileError> {
  const p = yield* verify(ownership.plan);
  if (ownership.mode !== "primitive-copy")
    return yield* fail("INVALID_OWNERSHIP", "lower", "ownership", "Unsupported ownership strategy");
  return yield* Effect.try({
    try: () =>
      lowerFunctions(
        p.analysis.program,
        new Map(p.selections.map((selection) => [selection.operation.ref, selection.selected])),
      ),
    catch: (cause) =>
      cause instanceof CompileError
        ? cause
        : fail("LOWER_FAILURE", "lower", "program", String(cause)),
  });
});
const emit = Effect.fn("Compile.emit")(function* (
  p: Plan,
): Effect.fn.Return<Artifact, CompileError> {
  const verified = yield* verify(p);
  const module = yield* lower(yield* analyzeOwnership(verified));
  const emitted = emitFunctions(module);
  const sources = yield* SourceMaps.create(module.provenance, emitted.files, emitted.ranges).pipe(
    Effect.mapError((error) => fail("SOURCE_ARTIFACT", "emit", "sources", error.message)),
  );
  return Object.freeze({
    explanation: verified,
    stages,
    files: emitted.files,
    sources: sources.table,
    auxiliaryFiles: sources.auxiliaryFiles,
  });
});
const run = Effect.fn("Compile.run")(function* (program: Program, target: Target = Rust.std) {
  const checked = yield* check(program);
  const derived = yield* derive(checked);
  const normalized = yield* normalize(derived);
  const planned = yield* plan(normalized, target);
  const verified = yield* verify(planned);
  const optimized = yield* optimize(verified);
  return yield* emit(optimized);
});

const located = <A, R>(program: Program, effect: Effect.Effect<A, CompileError, R>) =>
  effect.pipe(Effect.mapError((error) => locateCompileError(program, error)));

export const Compile = {
  fromFoldkitQuery: Foldkit.compile,
  check: (program: Program) => located(program, check(program)),
  derive: (program: Program) => located(program, derive(program)),
  normalize: (analysis: Analysis) => located(analysis.program, normalize(analysis)),
  plan: (analysis: Analysis, target: Target = Rust.std) =>
    located(analysis.program, plan(analysis, target)),
  verify: (p: Plan) => located(p.analysis.program, verify(p)),
  optimize: (p: Plan) => located(p.analysis.program, optimize(p)),
  analyzeOwnership: (p: Plan) => located(p.analysis.program, analyzeOwnership(p)),
  lower: (ownership: Ownership) => located(ownership.plan.analysis.program, lower(ownership)),
  emit: (p: Plan) => located(p.analysis.program, emit(p)),
  run: (program: Program, target: Target = Rust.std) => located(program, run(program, target)),
  build: Effect.fn("Compile.build")(function* (
    program: Program,
    output: string,
    profile: "debug" | "release" = "release",
    target: Target = Rust.std,
  ) {
    const cargo = yield* Cargo;
    const artifact = yield* located(program, run(program, target));
    const directory = yield* cargo.write(artifact, output);
    const process = yield* cargo.build(directory, profile);
    return { artifact, directory, process, stages: stages.concat("build") };
  }),
  explain: Effect.fn("Compile.explain")(function* (program: Program, target: Target = Rust.std) {
    return yield* located(
      program,
      Effect.gen(function* () {
        return yield* plan(yield* derive(program), target);
      }),
    );
  }),
};
export class Compiler extends Context.Service<Compiler, typeof Compile>()("reffect/Compiler") {
  static readonly layer = Layer.succeed(Compiler, Compile);
}

export type { Fn };
