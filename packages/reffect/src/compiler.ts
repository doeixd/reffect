import { Context, Effect, Layer, Match, Pipeable } from "effect";
import { SourceMaps } from "./source-artifact.ts";
import type { SourceMap } from "./source-artifact.ts";
import type { GeneratedFiles } from "./cargo.ts";
import { locateCompileError } from "./provenance.ts";
import { Cargo } from "./cargo.ts";
import { Foldkit } from "./foldkit.ts";
import { EffectFn, SyncEffects, AsyncEffects, checkEffectFunction } from "./effect-ir.ts";
import type { Computation } from "./effect-ir.ts";
import { FileHandleType, FileRequirement } from "./file-model.ts";
import { lowerFunctions, emitFunctions } from "./lower.ts";
import type { LoweredModule, RustModule, UnmappedRustModule } from "./lower.ts";
import { FailureFrames, checkFailureFramePolicy } from "./frame-policy.ts";
import type { FailureFramePolicy } from "./frame-policy.ts";
import { SourceArtifacts, checkArtifactPolicy } from "./artifact-policy.ts";
import type {
  ArtifactPolicy,
  FullSourceArtifacts,
  NoneSourceArtifacts,
} from "./artifact-policy.ts";
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
  Program,
  U64Type,
  BoolType,
  UnitType,
  NeverType,
  EqU64,
  LtU64,
  EqBool,
  EqString,
  IncludesString,
  ReplaceAllString,
  StringType,
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
  readonly method:
    | "wrapping_add"
    | "wrapping_sub"
    | "wrapping_mul"
    | "eq"
    | "lt"
    | "not"
    | "contains"
    | "replace";
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
  implementation(EqString as AnyOperation, "eq"),
  implementation(IncludesString as AnyOperation, "contains"),
  implementation(ReplaceAllString as AnyOperation, "replace"),
]);
const syncResultAdapter = Object.freeze({
  ref: SemanticRef.runtime("rust/std-result@1"),
  target: Targets.RustStd,
  strategy: "generated" as const,
  rationale:
    "Synchronous typed success/failure lowers to std::result::Result; Boolean branches and continuations remain lazy",
});
const asyncResultAdapter = Object.freeze({
  ref: SemanticRef.runtime("rust/tokio-result@1"),
  target: Targets.RustStd,
  strategy: "generated" as const,
  rationale:
    "Concrete async futures with owned execution context, cooperative cancellation and masked awaited finalizers on Tokio",
});
const scopedFileAdapter = Object.freeze({
  requirement: FileRequirement,
  representation: FileHandleType,
  target: Targets.RustStd,
  strategy: "generated" as const,
  rationale:
    "Read-only std::fs::File ownership, spawn_blocking masked acquisition, borrowed metadata helpers and explicit close before awaited cleanup; no runtime handle map or clones",
  crates: Object.freeze(["tokio@1.53.1"]),
});
export const Rust = Object.freeze({
  scopedFiles: scopedFileAdapter,
  asyncResult: asyncResultAdapter,
  tokio: Target.make(Targets.RustStd, implementations).pipe(
    Target.withCapabilities([
      Capabilities.U64,
      Capabilities.Bool,
      Capabilities.Unit,
      Capabilities.String,
      Capabilities.SyncResult,
      Capabilities.AsyncResult,
      Capabilities.ScopedFiles,
    ]),
  ),
  syncResult: syncResultAdapter,
  std: Target.make(Targets.RustStd, implementations).pipe(
    Target.withCapabilities([
      Capabilities.U64,
      Capabilities.Bool,
      Capabilities.Unit,
      Capabilities.String,
      Capabilities.SyncResult,
    ]),
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
  readonly services: readonly (typeof scopedFileAdapter)[];
  readonly runtime: typeof syncResultAdapter | typeof asyncResultAdapter | undefined;
  private constructor(
    readonly analysis: Analysis,
    readonly target: Target,
    readonly selections: readonly Selection[],
    readonly crates: readonly string[],
    readonly failureFrames: FailureFramePolicy,
  ) {
    super();
    this.services = Object.freeze(
      analysis.requirements.includes(FileRequirement) ? [scopedFileAdapter] : [],
    );
    this.runtime =
      analysis.effects.length === 0
        ? undefined
        : analysis.capabilities.includes(Capabilities.AsyncResult)
          ? asyncResultAdapter
          : syncResultAdapter;
    Object.freeze(this);
  }
  static make(
    analysis: Analysis,
    target: Target,
    selections: readonly Selection[],
    crates: readonly string[],
    failureFrames: FailureFramePolicy = FailureFrames.Bounded,
  ): Plan {
    return new Plan(
      analysis,
      target,
      Object.freeze(Array.from(selections)),
      Object.freeze(Array.from(crates)),
      failureFrames,
    );
  }
  static withFailureFrames(policy: FailureFramePolicy) {
    return (self: Plan): Plan =>
      Plan.make(self.analysis, self.target, self.selections, self.crates, policy);
  }
  static withSelections(selections: readonly Selection[]) {
    return (self: Plan): Plan =>
      Plan.make(self.analysis, self.target, selections, self.crates, self.failureFrames);
  }
  static withCrates(crates: readonly string[]) {
    return (self: Plan): Plan =>
      Plan.make(self.analysis, self.target, self.selections, crates, self.failureFrames);
  }
}
export interface Ownership {
  readonly plan: Plan;
  readonly mode: "primitive-copy" | "lexical-files";
  readonly rationale: string;
}
interface ArtifactBase extends GeneratedFiles {
  readonly failureFrames: FailureFramePolicy;
  readonly sourceArtifacts: ArtifactPolicy;
  readonly explanation: Plan;
  readonly stages: readonly string[];
}
export interface MappedArtifact extends ArtifactBase {
  readonly sourceArtifacts: FullSourceArtifacts;
  readonly auxiliaryFiles: Readonly<Record<"reffect.sources.json" | "reffect.build.json", string>>;
  readonly sources: SourceMap;
}
export interface UnmappedArtifact extends ArtifactBase {
  readonly sourceArtifacts: NoneSourceArtifacts;
  readonly auxiliaryFiles?: never;
  readonly sources?: never;
}
export type Artifact = MappedArtifact | UnmappedArtifact;
export type ArtifactFor<P extends ArtifactPolicy> = P extends NoneSourceArtifacts
  ? UnmappedArtifact
  : MappedArtifact;

/** Complete compile requests compose without changing their authored program or target. */
export class CompileSpec<P extends ArtifactPolicy = FullSourceArtifacts> extends Pipeable.Class {
  private constructor(
    readonly program: Program,
    readonly target: Target,
    readonly sourceArtifacts: P,
    readonly failureFrames: FailureFramePolicy,
  ) {
    super();
    Object.freeze(this);
  }
  static make(this: void, program: Program): CompileSpec {
    return new CompileSpec(program, Rust.std, SourceArtifacts.Full, FailureFrames.Bounded);
  }
  static withSourceArtifacts<P extends ArtifactPolicy>(this: void, policy: P) {
    return <Previous extends ArtifactPolicy>(self: CompileSpec<Previous>): CompileSpec<P> =>
      new CompileSpec(self.program, self.target, policy, self.failureFrames);
  }
  static withFailureFrames(this: void, policy: FailureFramePolicy) {
    return <P extends ArtifactPolicy>(self: CompileSpec<P>): CompileSpec<P> =>
      new CompileSpec(self.program, self.target, self.sourceArtifacts, policy);
  }
  static withTarget(this: void, target: Target) {
    return <P extends ArtifactPolicy>(self: CompileSpec<P>): CompileSpec<P> =>
      new CompileSpec(self.program, target, self.sourceArtifacts, self.failureFrames);
  }
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
        Make: (n) => n.fields.forEach(walk),
        Get: (n) => walk(n.value),
        ArrayMake: (n) => n.elements.forEach(walk),
        ArrayLength: (n) => walk(n.value),
        ArrayLoop: (n) => {
          walk(n.source);
          walk(n.body);
          Match.value(n.op).pipe(
            Match.tag("Reduce", (reduce) => walk(reduce.init)),
            Match.orElse(() => undefined),
          );
        },
        MatchTags: (n) => {
          walk(n.value);
          n.cases.forEach((c) => walk(c.body));
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
        Scope: (n) => {
          effectRefs.add(AsyncEffects.Scope);
          walkComputation(n.body);
        },
        AddFinalizer: (n) => {
          effectRefs.add(AsyncEffects.AddFinalizer);
          walkComputation(n.finalizer);
        },
        AcquireRelease: (n) => {
          effectRefs.add(AsyncEffects.AcquireRelease);
          walkComputation(n.acquire);
          walkComputation(n.release);
        },
        RegisteredFile: (n) => {
          effectRefs.add(AsyncEffects.RegisteredFile);
          walkComputation(n.body);
          walkComputation(n.afterClose);
        },
        Sleep: () => {
          effectRefs.add(AsyncEffects.Sleep);
        },
        Launch: (n) => {
          effectRefs.add(AsyncEffects.Launch);
          n.values.forEach(walk);
        },
        Repeat: (n) => {
          effectRefs.add(AsyncEffects.Repeat);
          walkComputation(n.body);
        },
        Retry: (n) => {
          effectRefs.add(AsyncEffects.Retry);
          walkComputation(n.body);
        },
        FileScope: (n) => {
          effectRefs.add(AsyncEffects.FileScope);
          walkComputation(n.body);
          walkComputation(n.afterClose);
        },
        FileSize: () => {
          effectRefs.add(AsyncEffects.FileSize);
        },
        CatchAll: (n) => {
          effectRefs.add(SyncEffects.CatchAll);
          walkComputation(n.source);
          walkComputation(n.body);
        },
        AcquireUseRelease: (n) => {
          effectRefs.add(AsyncEffects.AcquireUseRelease);
          walkComputation(n.acquire);
          walkComputation(n.use);
          walkComputation(n.release);
        },
        Ensuring: (n) => {
          effectRefs.add(AsyncEffects.Ensuring);
          walkComputation(n.body);
          walkComputation(n.finalizer);
        },
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
        MatchTags: (n) => {
          effectRefs.add(SyncEffects.Match);
          walk(n.value);
          n.cases.forEach((x) => walkComputation(x.body));
        },
        ForEach: (n) => {
          effectRefs.add(SyncEffects.ForEach);
          walk(n.source);
          walkComputation(n.body);
        },
        Log: (n) => {
          effectRefs.add(SyncEffects.Log);
          for (const [, value] of n.attributes) walk(value);
        },
        Annotate: (n) => {
          effectRefs.add(SyncEffects.Annotate);
          walk(n.value);
          walkComputation(n.body);
        },
        Span: (n) => {
          effectRefs.add(SyncEffects.Span);
          walkComputation(n.body);
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
  const usesFiles =
    effectRefs.has(AsyncEffects.FileScope) ||
    effectRefs.has(AsyncEffects.RegisteredFile) ||
    effectRefs.has(AsyncEffects.FileSize);
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
            : IRType.same(type, UnitType)
              ? [Capabilities.Unit]
              : IRType.same(type, StringType)
                ? [Capabilities.String]
                : [],
      ),
      ...(effectRefs.size ? [Capabilities.SyncResult] : []),
      ...(Array.from(effectRefs).some((ref) =>
        Object.values(AsyncEffects).some((supported) => supported === ref),
      )
        ? [Capabilities.AsyncResult]
        : []),
      ...(usesFiles ? [Capabilities.ScopedFiles] : []),
    ]),
    effects: collect([...operations.flatMap((op) => op.effects), ...effectRefs]),
    requirements: collect(
      operations.flatMap((op) => op.requirements).concat(usesFiles ? [FileRequirement] : []),
    ),
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
      (ref) =>
        ![...Object.values(SyncEffects), ...Object.values(AsyncEffects)].some(
          (supported) => supported === ref,
        ),
    )
  )
    return yield* fail(
      "UNSUPPORTED_EFFECT",
      "plan",
      "effects",
      "No verified Result/async adapter for this effect",
    );
  return Plan.make(
    derived,
    target,
    selections,
    Array.from(
      new Set(
        selections
          .flatMap((s) => s.selected.crates)
          .concat(derived.capabilities.includes(Capabilities.AsyncResult) ? ["tokio@1.53.1"] : []),
      ),
    ).sort(),
  );
});
const verify = Effect.fn("Compile.verify")(function* (p: Plan) {
  yield* Effect.try({
    try: () => checkFailureFramePolicy(p.failureFrames),
    catch: (cause) =>
      cause instanceof CompileError
        ? cause
        : fail("INVALID_PLAN", "verify", "failureFrames", String(cause)),
  });
  const expected = (yield* plan(p.analysis, p.target)).pipe(
    Plan.withFailureFrames(p.failureFrames),
  );
  if (
    p.runtime !== expected.runtime ||
    p.services.length !== expected.services.length ||
    p.services.some((service, i) => service !== expected.services[i]) ||
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
    if (
      type.layout === undefined &&
      ![U64Type, BoolType, UnitType, NeverType, StringType].some((builtin) =>
        IRType.same(type, builtin),
      )
    )
      return yield* fail(
        "UNSUPPORTED_REPRESENTATION",
        "verify",
        type.id,
        "Only canonical Boolean/u64/Unit/Never/String witnesses have registered native representations",
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
  const verified = yield* verify(p);
  return Object.freeze({
    plan: verified,
    mode: verified.analysis.requirements.includes(FileRequirement)
      ? "lexical-files"
      : "primitive-copy",
    rationale: verified.analysis.requirements.includes(FileRequirement)
      ? "Scalar values are Copy; each lexical file scope owns one plain File and lends immutable helper borrows, then drops it before cleanup. Resource references cannot escape."
      : "Boolean/u64/Unit are Copy; Never is uninhabited. Branch and continuation scopes keep values local.",
  });
});
const lower = Effect.fn("Compile.lower")(function* (
  ownership: Ownership,
  policy: ArtifactPolicy = SourceArtifacts.Full,
): Effect.fn.Return<LoweredModule, CompileError> {
  const p = yield* verify(ownership.plan);
  if (
    ownership.mode !==
    (p.analysis.requirements.includes(FileRequirement) ? "lexical-files" : "primitive-copy")
  )
    return yield* fail("INVALID_OWNERSHIP", "lower", "ownership", "Unsupported ownership strategy");
  return yield* Effect.try({
    try: () =>
      lowerFunctions(
        p.analysis.program,
        new Map(p.selections.map((selection) => [selection.operation.ref, selection.selected])),
        policy,
        p.failureFrames,
      ),
    catch: (cause) =>
      cause instanceof CompileError
        ? cause
        : fail("LOWER_FAILURE", "lower", "program", String(cause)),
  });
});
const emit = Effect.fn("Compile.emit")(function* (
  p: Plan,
  policy: ArtifactPolicy = SourceArtifacts.Full,
): Effect.fn.Return<MappedArtifact | UnmappedArtifact, CompileError> {
  const verified = yield* verify(p);
  const module = yield* lower(yield* analyzeOwnership(verified), policy);
  const emitted = emitFunctions(module);
  if (SourceArtifacts.isNone(policy))
    return Object.freeze({
      sourceArtifacts: SourceArtifacts.None,
      failureFrames: verified.failureFrames,
      explanation: verified,
      stages,
      files: emitted.files,
    });
  if (!module.provenance)
    return yield* fail("SOURCE_ARTIFACT", "emit", "sources", "Mapped emission requires provenance");
  const sources = yield* SourceMaps.create(module.provenance, emitted.files, emitted.ranges).pipe(
    Effect.mapError((error) => fail("SOURCE_ARTIFACT", "emit", "sources", error.message)),
  );
  return Object.freeze({
    sourceArtifacts: SourceArtifacts.Full,
    failureFrames: verified.failureFrames,
    explanation: verified,
    stages,
    files: emitted.files,
    sources: sources.table,
    auxiliaryFiles: sources.auxiliaryFiles,
  });
});
const run = Effect.fn("Compile.run")(function* (
  program: Program,
  target: Target = Rust.std,
  policy: ArtifactPolicy = SourceArtifacts.Full,
  failureFrames: FailureFramePolicy = FailureFrames.Bounded,
) {
  yield* Effect.try({
    try: () => checkArtifactPolicy(policy),
    catch: (cause) =>
      cause instanceof CompileError
        ? cause
        : fail("UNSUPPORTED_SOURCE_POLICY", "check", "sourceArtifacts", String(cause)),
  });
  const checked = yield* check(program);
  const derived = yield* derive(checked);
  const normalized = yield* normalize(derived);
  const planned = (yield* plan(normalized, target)).pipe(Plan.withFailureFrames(failureFrames));
  const verified = yield* verify(planned);
  const optimized = yield* optimize(verified);
  return yield* emit(optimized, policy);
});

const located = <A, R>(program: Program, effect: Effect.Effect<A, CompileError, R>) =>
  effect.pipe(Effect.mapError((error) => locateCompileError(program, error)));

const withLocations = <A, R>(
  program: Program,
  policy: ArtifactPolicy,
  effect: Effect.Effect<A, CompileError, R>,
) => (SourceArtifacts.isNone(policy) ? effect : located(program, effect));

const runRequest = <Value extends Program | CompileSpec<ArtifactPolicy>>(
  value: Value,
  target?: Target,
): Effect.Effect<
  Value extends CompileSpec<infer P> ? ArtifactFor<P> : MappedArtifact,
  CompileError
> => {
  const program =
    value instanceof CompileSpec ? value.program : value instanceof Program ? value : undefined;
  if (!program)
    return Effect.fail(fail("INVALID_REQUEST", "check", "program", "Use Program or Compile.make"));
  const policy = value instanceof CompileSpec ? value.sourceArtifacts : SourceArtifacts.Full;
  const selectedTarget = target ?? (value instanceof CompileSpec ? value.target : Rust.std);
  // Canonical policy selection determines the artifact branch; the generic signature preserves pipe inference.
  return withLocations(
    program,
    policy,
    run(
      program,
      selectedTarget,
      policy,
      value instanceof CompileSpec ? value.failureFrames : FailureFrames.Bounded,
    ),
  ) as Effect.Effect<
    Value extends CompileSpec<infer P> ? ArtifactFor<P> : MappedArtifact,
    CompileError
  >;
};
function lowerRequest(ownership: Ownership): Effect.Effect<RustModule, CompileError>;
function lowerRequest(
  ownership: Ownership,
  policy: FullSourceArtifacts,
): Effect.Effect<RustModule, CompileError>;
function lowerRequest(
  ownership: Ownership,
  policy: NoneSourceArtifacts,
): Effect.Effect<UnmappedRustModule, CompileError>;
function lowerRequest(
  ownership: Ownership,
  policy: ArtifactPolicy,
): Effect.Effect<LoweredModule, CompileError>;
function lowerRequest(
  ownership: Ownership,
  policy: ArtifactPolicy = SourceArtifacts.Full,
): Effect.Effect<LoweredModule, CompileError> {
  return withLocations(ownership.plan.analysis.program, policy, lower(ownership, policy));
}
function emitRequest(p: Plan): Effect.Effect<MappedArtifact, CompileError>;
function emitRequest(
  p: Plan,
  policy: FullSourceArtifacts,
): Effect.Effect<MappedArtifact, CompileError>;
function emitRequest(
  p: Plan,
  policy: NoneSourceArtifacts,
): Effect.Effect<UnmappedArtifact, CompileError>;
function emitRequest(
  p: Plan,
  policy: ArtifactPolicy,
): Effect.Effect<MappedArtifact | UnmappedArtifact, CompileError>;
function emitRequest(
  p: Plan,
  policy: ArtifactPolicy = SourceArtifacts.Full,
): Effect.Effect<MappedArtifact | UnmappedArtifact, CompileError> {
  return withLocations(p.analysis.program, policy, emit(p, policy));
}

const build = Effect.fn("Compile.build")(function* (
  value: Program | CompileSpec<ArtifactPolicy>,
  output: string,
  profile: "debug" | "release" = "release",
  target: Target = Rust.std,
) {
  const cargo = yield* Cargo;
  const program = value instanceof CompileSpec ? value.program : value;
  const policy = value instanceof CompileSpec ? value.sourceArtifacts : SourceArtifacts.Full;
  const selectedTarget = value instanceof CompileSpec ? value.target : target;
  const artifact = yield* withLocations(
    program,
    policy,
    run(
      program,
      selectedTarget,
      policy,
      value instanceof CompileSpec ? value.failureFrames : FailureFrames.Bounded,
    ),
  );
  const directory = yield* cargo.write(artifact, output);
  const process = yield* cargo.build(directory, profile);
  return { artifact, directory, process, stages: stages.concat("build") };
});
type BuildResult<A extends Artifact> = Omit<
  Effect.Success<ReturnType<typeof build>>,
  "artifact"
> & { readonly artifact: A };
function buildRequest(
  program: Program,
  output: string,
  profile?: "debug" | "release",
  target?: Target,
): Effect.Effect<
  BuildResult<MappedArtifact>,
  Effect.Error<ReturnType<typeof build>>,
  Effect.Services<ReturnType<typeof build>>
>;
function buildRequest<P extends ArtifactPolicy>(
  spec: CompileSpec<P>,
  output: string,
  profile?: "debug" | "release",
): Effect.Effect<
  BuildResult<ArtifactFor<P>>,
  Effect.Error<ReturnType<typeof build>>,
  Effect.Services<ReturnType<typeof build>>
>;
function buildRequest(
  value: Program | CompileSpec<ArtifactPolicy>,
  output: string,
  profile: "debug" | "release" = "release",
  target: Target = Rust.std,
): ReturnType<typeof build> {
  return build(value, output, profile, target);
}

export const Compile = {
  make: CompileSpec.make,
  withTarget: CompileSpec.withTarget,
  withFailureFrames: CompileSpec.withFailureFrames,
  withSourceArtifacts: CompileSpec.withSourceArtifacts,
  fromFoldkitQuery: Foldkit.compile,
  check: (program: Program) => located(program, check(program)),
  derive: (program: Program) => located(program, derive(program)),
  normalize: (analysis: Analysis) => located(analysis.program, normalize(analysis)),
  plan: (analysis: Analysis, target: Target = Rust.std) =>
    located(analysis.program, plan(analysis, target)),
  verify: (p: Plan) => located(p.analysis.program, verify(p)),
  optimize: (p: Plan) => located(p.analysis.program, optimize(p)),
  analyzeOwnership: (p: Plan) => located(p.analysis.program, analyzeOwnership(p)),
  lower: lowerRequest,
  emit: emitRequest,
  run: runRequest,
  build: buildRequest,
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
