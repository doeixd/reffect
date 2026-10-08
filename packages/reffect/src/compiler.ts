import { analyzeGeneratedQueueFallibleProfile } from "./queue-generated-profile.ts";
import { QueueDoneType, containsQueue, containsQueueDone } from "./queue-model.ts";
import { hasQueueComputation, usesQueueNativeType } from "./queue-profile.ts";
import { containsLatch, usesLatchExpression } from "./latch-model.ts";
import { analyzeGeneratedLatchProfile } from "./latch-generated-profile.ts";
import { analyzeGeneratedSemaphoreProfile } from "./semaphore-generated-profile.ts";
import { containsSemaphore, usesSemaphoreExpression } from "./semaphore-model.ts";
import { analyzeGeneratedDeferredProfile } from "./deferred-generated-profile.ts";
import { checkDeferredExecutionReferences } from "./deferred-execution.ts";
import { Context, Effect, Layer, Match, Pipeable } from "effect";
import { UrlPathname, UrlSearchParam } from "./url.ts";
import {
  CookiesParseHeader,
  DateTimeFormatIso,
  DateTimeMake,
  DateTimeToEpochMillis,
  NumberParse,
  UtcType,
} from "./js-std.ts";
import { NESTING_LIMIT, nestingDepth } from "./nesting.ts";
import { literalTextOf } from "./records.ts";
import { streamExpressions, streamFinalizers, streamSources } from "./stream-ir.ts";
import type { StreamIR } from "./stream-ir.ts";
import { SourceMaps } from "./source-artifact.ts";
import type { SourceMap } from "./source-artifact.ts";
import type { GeneratedFiles } from "./cargo.ts";
import { locateCompileError } from "./provenance.ts";
import { Cargo } from "./cargo.ts";
import { Foldkit } from "./foldkit.ts";
import {
  EffectFn,
  SyncEffects,
  AsyncEffects,
  checkEffectFunction,
  isLiveSignal,
} from "./effect-ir.ts";
import type { Computation } from "./effect-ir.ts";
import {
  ClockRequirement,
  RandomRequirement,
  defaultRuntimeServices,
  normalizeRuntimeServicesSelection,
} from "./runtime-service-model.ts";
import type {
  RuntimeServicesSelection,
  ResolvedRuntimeServicesSelection,
} from "./runtime-service-model.ts";
import { analyzeTaskGroups } from "./structured-concurrency.ts";
import { containsRef } from "./ref-model.ts";
import { containsDeferred, usesDeferredExpression } from "./deferred-model.ts";
import { hostFunctionOf } from "./schema-json.ts";
import { HtmlCapability, HtmlType, htmlOperationKind } from "./html-ir.ts";
import type { HtmlOperationKind } from "./html-ir.ts";
import { FileHandleType, FileRequirement } from "./file-model.ts";
import {
  lowerFunctions,
  lowerDeferredFunctions,
  lowerSemaphoreFunctions,
  lowerLatchFunctions,
  lowerQueueFallibleFunctions,
  emitFunctions,
} from "./lower.ts";
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
  AddNumber,
  EqNumber,
  LtNumber,
  NumberType,
  UnknownType,
  reachesUnknown,
  IncludesString,
  ReplaceAllString,
  ConcatString,
  NumberToString,
  IsSafeIntegerNumber,
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
  readonly lowering: Lowering;
}
/**
 * How an implementation lowers to Rust (#36): lowering dispatches on this alone, exhaustively,
 * so a plan's selection is exactly what is emitted.
 */
export type Lowering =
  /** `(a).name(b, ...)`: a Rust method on the first operand. */
  | {
      readonly _tag: "Method";
      readonly name: "wrapping_add" | "wrapping_sub" | "wrapping_mul" | "contains" | "replace";
    }
  /** `(a) op (b)`. */
  | { readonly _tag: "Infix"; readonly operator: "==" | "<" | "+" }
  | { readonly _tag: "Not" }
  /** Two strings joined. */
  | { readonly _tag: "Concat" }
  /** A double as ECMAScript's Number#toString writes it (ryu-js). */
  | { readonly _tag: "NumberText" }
  /** A NativeRpc host's verified JSON function in `crate::reffect_json` (RM-006). */
  | { readonly _tag: "HostJson"; readonly function: string }
  /** The ported Foldkit serializer (SSR-003). */
  | { readonly _tag: "Html"; readonly kind: HtmlOperationKind }
  /** A WHATWG URL reading in `crate::reffect_url`, on the `url` crate. */
  | { readonly _tag: "Url"; readonly kind: "Pathname" | "SearchParam" }
  /**
   * A function of the std-only `crate::js_std` runtime module; `borrow[i]` passes argument `i`
   * as `&str` (a String) rather than by value.
   */
  | { readonly _tag: "Std"; readonly function: string; readonly borrow: readonly boolean[] }
  /** A string-literal union widened to String: a `match` over its enum's variants. */
  | {
      readonly _tag: "LiteralText";
      readonly literals: readonly string[];
      /** The union's native enum. */
      readonly type: string;
    };
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
const loweringName = (lowering: Lowering): string =>
  lowering._tag === "Method"
    ? lowering.name
    : lowering._tag === "Infix"
      ? lowering.operator
      : lowering._tag;
const implementation = (operation: AnyOperation, lowering: Lowering): Implementation =>
  Object.freeze({
    id: `rust/${operation.id}`,
    operation,
    target: Targets.RustStd,
    strategy: "generated",
    capabilities: operation.capabilities,
    crates: Object.freeze([]),
    lowering: Object.freeze(lowering),
    rationale: `Verified primitive Rust ${loweringName(lowering)} implements ${operation.id} without coercion`,
  });
const hostImplementations = new WeakMap<object, Implementation>();
/** A host-supplied function (RM-006), selected only for targets with the JsonEncoders capability. */
const hostImplementation = (operation: AnyOperation, hostFunction: string): Implementation => {
  const known = hostImplementations.get(operation);
  if (known) return known;
  const created: Implementation = Object.freeze({
    id: `rust/${operation.id}`,
    operation,
    target: Targets.RustStd,
    strategy: "generated",
    capabilities: operation.capabilities,
    crates: Object.freeze([]),
    lowering: Object.freeze({ _tag: "HostJson", function: hostFunction }),
    rationale:
      "A NativeRpc host function, verified against the reference, implements the operation",
  });
  hostImplementations.set(operation, created);
  return created;
};
const htmlImplementations = new WeakMap<object, Implementation>();
/** The ported Foldkit serializer (SSR-003) implements every Html operation. */
const literalTextImplementation = (
  operation: AnyOperation,
  literals: readonly string[],
  type: string,
): Implementation =>
  Object.freeze({
    ...implementation(operation, {
      _tag: "LiteralText",
      literals: Object.freeze([...literals]),
      type,
    }),
    rationale: "Each variant of the literal union's enum is the literal it was declared as",
  });
const htmlImplementation = (operation: AnyOperation, kind: HtmlOperationKind): Implementation => {
  const known = htmlImplementations.get(operation);
  if (known) return known;
  const created: Implementation = Object.freeze({
    id: `rust/${operation.id}`,
    operation,
    target: Targets.RustStd,
    strategy: "generated",
    capabilities: operation.capabilities,
    crates: Object.freeze(
      kind._tag === "JsonText" || kind._tag === "JsonRoundTrip" ? ["ryu-js@1.0.3"] : [],
    ),
    lowering: Object.freeze({ _tag: "Html", kind }),
    rationale: "foldkit/ssr-serialize@1 renders the element as renderToString does",
  });
  htmlImplementations.set(operation, created);
  return created;
};
const implementations = Object.freeze([
  implementation(AddU64 as AnyOperation, { _tag: "Method", name: "wrapping_add" }),
  implementation(SubU64 as AnyOperation, { _tag: "Method", name: "wrapping_sub" }),
  implementation(MulU64 as AnyOperation, { _tag: "Method", name: "wrapping_mul" }),
  implementation(EqU64 as AnyOperation, { _tag: "Infix", operator: "==" }),
  implementation(LtU64 as AnyOperation, { _tag: "Infix", operator: "<" }),
  implementation(EqBool as AnyOperation, { _tag: "Infix", operator: "==" }),
  implementation(NotBool as AnyOperation, { _tag: "Not" }),
  implementation(EqString as AnyOperation, { _tag: "Infix", operator: "==" }),
  implementation(IncludesString as AnyOperation, { _tag: "Method", name: "contains" }),
  implementation(ReplaceAllString as AnyOperation, { _tag: "Method", name: "replace" }),
  implementation(ConcatString as AnyOperation, { _tag: "Concat" }),
  implementation(AddNumber as AnyOperation, { _tag: "Infix", operator: "+" }),
  implementation(EqNumber as AnyOperation, { _tag: "Infix", operator: "==" }),
  implementation(LtNumber as AnyOperation, { _tag: "Infix", operator: "<" }),
  ...(
    [
      [UrlPathname, "Pathname"],
      [UrlSearchParam, "SearchParam"],
    ] as const
  ).map(([operation, kind]) =>
    Object.freeze({
      ...implementation(operation as AnyOperation, { _tag: "Url", kind }),
      crates: Object.freeze(["url@2.5.8"]),
      rationale: "The url crate implements the WHATWG URL Standard the reference evaluates with",
    }),
  ),
  ...(
    [
      [NumberParse, "number_parse"],
      [CookiesParseHeader, "cookies_parse_header"],
      [DateTimeMake, "date_time_make"],
      [DateTimeFormatIso, "date_time_format_iso"],
      [DateTimeToEpochMillis, "date_time_epoch_millis"],
      [IsSafeIntegerNumber, "is_safe_integer"],
    ] as const
  ).map(([operation, name]) =>
    Object.freeze({
      ...implementation(operation as AnyOperation, {
        _tag: "Std",
        function: name,
        borrow: Object.freeze(operation.input.map((type) => IRType.same(type, StringType))),
      }),
      rationale: "A std-only port differential against the ECMAScript/Effect function it names",
    }),
  ),
  Object.freeze({
    ...implementation(NumberToString as AnyOperation, { _tag: "NumberText" }),
    crates: Object.freeze(["ryu-js@1.0.3"]),
    rationale: "ryu-js writes a double exactly as ECMAScript Number#toString does",
  }),
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
const liveMillisAdapter = Object.freeze({
  requirement: ClockRequirement,
  ref: SemanticRef.runtime("rust/std-clock-millis@1"),
  representation: NumberType,
  target: Targets.RustStd,
  strategy: "generated" as const,
  crates: Object.freeze([]),
  rationale:
    "Checked signed epoch millis from std SystemTime; no service context for direct live reads",
});
const injectedMillisAdapter = Object.freeze({
  requirement: ClockRequirement,
  ref: SemanticRef.runtime("rust/injected-clock-millis@1"),
  representation: NumberType,
  target: Targets.RustStd,
  strategy: "generated" as const,
  crates: Object.freeze([]),
  rationale:
    "Invocation-owned live/stable/scripted clock selected by trusted native host; no global service or scalar tags",
});
const scriptedRandomAdapter = Object.freeze({
  requirement: RandomRequirement,
  ref: SemanticRef.runtime("rust/scripted-random-double@1"),
  representation: NumberType,
  target: Targets.RustStd,
  strategy: "generated" as const,
  crates: Object.freeze([]),
  rationale:
    "Owned validated double script and cursor; exactly one draw per execution, no implicit live or seeded fallback",
});
type ServiceAdapter =
  | typeof scopedFileAdapter
  | typeof liveMillisAdapter
  | typeof injectedMillisAdapter
  | typeof scriptedRandomAdapter;
export const Rust = Object.freeze({
  scopedFiles: scopedFileAdapter,
  asyncResult: asyncResultAdapter,
  tokio: Target.make(Targets.RustStd, implementations).pipe(
    Target.withCapabilities([
      Capabilities.U64,
      Capabilities.Bool,
      Capabilities.Unit,
      Capabilities.String,
      Capabilities.Number,
      Capabilities.SyncResult,
      HtmlCapability,
      Capabilities.AsyncResult,
      Capabilities.ScopedFiles,
      Capabilities.Json,
    ]),
  ),
  syncResult: syncResultAdapter,
  std: Target.make(Targets.RustStd, implementations).pipe(
    Target.withCapabilities([
      Capabilities.U64,
      Capabilities.Bool,
      Capabilities.Unit,
      Capabilities.String,
      Capabilities.Number,
      Capabilities.SyncResult,
      HtmlCapability,
      Capabilities.Json,
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
/**
 * Plans `plan` produced (and their `withFailureFrames` copies): verify takes such a plan as its
 * own expectation rather than planning again (#31). Plan.make builds any other plan.
 */
const plannedPlans = new WeakSet<Plan>();
export class Plan extends Pipeable.Class {
  readonly services: readonly ServiceAdapter[];
  readonly runtime: typeof syncResultAdapter | typeof asyncResultAdapter | undefined;
  private constructor(
    readonly analysis: Analysis,
    readonly target: Target,
    readonly selections: readonly Selection[],
    readonly crates: readonly string[],
    readonly failureFrames: FailureFramePolicy,
    readonly runtimeServices: ResolvedRuntimeServicesSelection,
  ) {
    super();
    this.services = Object.freeze([
      ...(analysis.requirements.includes(FileRequirement) ? [scopedFileAdapter] : []),
      ...(analysis.requirements.includes(ClockRequirement)
        ? [runtimeServices.clock === "InjectedMillis" ? injectedMillisAdapter : liveMillisAdapter]
        : []),
      ...(analysis.requirements.includes(RandomRequirement) &&
      runtimeServices.random === "ScriptedRandom"
        ? [scriptedRandomAdapter]
        : []),
    ]);
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
    runtimeServices: RuntimeServicesSelection = defaultRuntimeServices,
  ): Plan {
    return new Plan(
      analysis,
      target,
      Object.freeze(Array.from(selections)),
      Object.freeze(Array.from(crates)),
      failureFrames,
      normalizeRuntimeServicesSelection(runtimeServices),
    );
  }
  static withFailureFrames(policy: FailureFramePolicy) {
    return (self: Plan): Plan => {
      const plan = Plan.make(
        self.analysis,
        self.target,
        self.selections,
        self.crates,
        policy,
        self.runtimeServices,
      );
      // Only the policy differs, and verify checks it itself.
      if (plannedPlans.has(self)) plannedPlans.add(plan);
      return plan;
    };
  }
  static withSelections(selections: readonly Selection[]) {
    return (self: Plan): Plan =>
      Plan.make(
        self.analysis,
        self.target,
        selections,
        self.crates,
        self.failureFrames,
        self.runtimeServices,
      );
  }
  static withCrates(crates: readonly string[]) {
    return (self: Plan): Plan =>
      Plan.make(
        self.analysis,
        self.target,
        self.selections,
        crates,
        self.failureFrames,
        self.runtimeServices,
      );
  }
  static withRuntimeServices(selection: RuntimeServicesSelection) {
    return (self: Plan): Plan =>
      Plan.make(
        self.analysis,
        self.target,
        self.selections,
        self.crates,
        self.failureFrames,
        selection,
      );
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
    readonly runtimeServices: ResolvedRuntimeServicesSelection,
  ) {
    super();
    Object.freeze(this);
  }
  static make(this: void, program: Program): CompileSpec {
    return new CompileSpec(
      program,
      Rust.std,
      SourceArtifacts.Full,
      FailureFrames.Bounded,
      defaultRuntimeServices,
    );
  }
  static withSourceArtifacts<P extends ArtifactPolicy>(this: void, policy: P) {
    return <Previous extends ArtifactPolicy>(self: CompileSpec<Previous>): CompileSpec<P> =>
      new CompileSpec(self.program, self.target, policy, self.failureFrames, self.runtimeServices);
  }
  static withFailureFrames(this: void, policy: FailureFramePolicy) {
    return <P extends ArtifactPolicy>(self: CompileSpec<P>): CompileSpec<P> =>
      new CompileSpec(
        self.program,
        self.target,
        self.sourceArtifacts,
        policy,
        self.runtimeServices,
      );
  }
  static withTarget(this: void, target: Target) {
    return <P extends ArtifactPolicy>(self: CompileSpec<P>): CompileSpec<P> =>
      new CompileSpec(
        self.program,
        target,
        self.sourceArtifacts,
        self.failureFrames,
        self.runtimeServices,
      );
  }
  static withRuntimeServices(this: void, selection: RuntimeServicesSelection) {
    const normalized = normalizeRuntimeServicesSelection(selection);
    return <P extends ArtifactPolicy>(self: CompileSpec<P>): CompileSpec<P> =>
      new CompileSpec(
        self.program,
        self.target,
        self.sourceArtifacts,
        self.failureFrames,
        normalized,
      );
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
// Stage outputs are immutable (frozen programs, analyses and plans), so a stage given a value it
// has already accepted answers from that first run: one compile checks, derives and verifies once
// rather than at every later stage (#31). Only successes are kept; a refusal is recomputed.
const deferredProfiles = new WeakMap<Program, ReturnType<typeof analyzeGeneratedDeferredProfile>>();
const checkedDeferredProfiles = (program: Program) => {
  const previous = deferredProfiles.get(program);
  if (previous) return previous;
  const profiles = analyzeGeneratedDeferredProfile(program);
  for (const fn of profiles.keys()) checkDeferredExecutionReferences(fn);
  deferredProfiles.set(program, profiles);
  return profiles;
};
const semaphoreProfiles = new WeakMap<
  Program,
  ReturnType<typeof analyzeGeneratedSemaphoreProfile>
>();
const checkedSemaphoreProfiles = (program: Program) => {
  const previous = semaphoreProfiles.get(program);
  if (previous) return previous;
  const profiles = analyzeGeneratedSemaphoreProfile(program);
  semaphoreProfiles.set(program, profiles);
  return profiles;
};
const latchProfiles = new WeakMap<Program, ReturnType<typeof analyzeGeneratedLatchProfile>>();
const checkedLatchProfiles = (program: Program) => {
  const previous = latchProfiles.get(program);
  if (previous) return previous;
  const profiles = analyzeGeneratedLatchProfile(program);
  latchProfiles.set(program, profiles);
  return profiles;
};

const queueProfiles = new WeakMap<
  Program,
  ReturnType<typeof analyzeGeneratedQueueFallibleProfile>
>();
const checkedQueueProfiles = (program: Program) => {
  const previous = queueProfiles.get(program);
  if (previous) return previous;
  const profiles = analyzeGeneratedQueueFallibleProfile(program);
  queueProfiles.set(program, profiles);
  return profiles;
};

const checkedPrograms = new WeakSet<Program>();
const derivedPrograms = new WeakMap<Program, Analysis>();
const verifiedPlans = new WeakSet<Plan>();
const check = (program: Program): Effect.Effect<Program, CompileError> =>
  checkedPrograms.has(program)
    ? Effect.succeed(program)
    : checkProgram(program).pipe(Effect.tap(() => Effect.sync(() => checkedPrograms.add(program))));
const checkProgram = Effect.fn("Compile.check")(function* (program: Program) {
  // Measured first and without recursion: every later walk, this check's own included, would
  // overflow the stack on such a program instead of answering (#29).
  const tooDeep = Object.entries(program.functions).filter(
    ([, f]) => nestingDepth(f.body) === undefined,
  );
  if (tooDeep.length)
    return yield* new CompileError({
      message: "Invalid program",
      diagnostics: tooDeep.map(([name]) => ({
        code: "NESTING_LIMIT",
        stage: "check",
        path: `functions.${name}`,
        message: `The function's IR nests deeper than ${NESTING_LIMIT} levels`,
      })),
    });
  const queue = yield* Effect.try({
    try: () => checkedQueueProfiles(program),
    catch: (cause) =>
      cause instanceof CompileError
        ? cause
        : fail("QUEUE_GENERATED_PROFILE", "check", "functions", String(cause)),
  });
  for (const [name, fn] of Object.entries(program.functions)) {
    if (
      fn.input.some((type) => containsQueue(type) || containsQueueDone(type)) ||
      containsQueue(fn.output) ||
      containsQueueDone(fn.output) ||
      (fn instanceof EffectFn &&
        ((hasQueueComputation(fn.body) && !queue.has(fn)) ||
          containsQueue(fn.error) ||
          containsQueueDone(fn.error))) ||
      usesQueueNativeType(fn.body, fn instanceof EffectFn && queue.get(fn)?.completion === "End")
    )
      return yield* fail(
        "QUEUE_NATIVE_UNSUPPORTED",
        "check",
        `functions.${name}`,
        "Queue/Done values require the checked standalone Queue profile with local or root All2 Done recovery",
      );
  }
  yield* Effect.try({
    try: () => checkedLatchProfiles(program),
    catch: (cause) =>
      cause instanceof CompileError
        ? cause
        : fail("LATCH_GENERATED_PROFILE", "check", "functions", String(cause)),
  });
  yield* Effect.try({
    try: () => checkedSemaphoreProfiles(program),
    catch: (cause) =>
      cause instanceof CompileError
        ? cause
        : fail("SEMAPHORE_GENERATED_PROFILE", "check", "functions", String(cause)),
  });
  const profiles = yield* Effect.try({
    try: () => checkedDeferredProfiles(program),
    catch: (cause) =>
      cause instanceof CompileError
        ? cause
        : fail("DEFERRED_GENERATED_PROFILE", "check", "functions", String(cause)),
  });
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
    ...(f.input.some(
      (type) =>
        containsRef(type) ||
        containsDeferred(type) ||
        containsSemaphore(type) ||
        containsLatch(type),
    ) ||
    containsRef(f.output) ||
    containsDeferred(f.output) ||
    containsLatch(f.output) ||
    (f instanceof EffectFn && containsLatch(f.error)) ||
    containsSemaphore(f.output) ||
    (f instanceof EffectFn &&
      (containsRef(f.error) || containsDeferred(f.error) || containsSemaphore(f.error))) ||
    (!(f instanceof EffectFn) &&
      (usesDeferredExpression(f.body) ||
        usesSemaphoreExpression(f.body) ||
        usesLatchExpression(f.body)))
      ? [
          {
            code: "RESOURCE_ESCAPE",
            stage: "check",
            path: `functions.${name}`,
            message:
              "Public channels cannot contain lexical Ref, Deferred, Semaphore or Latch handles",
          },
        ]
      : []),
    ...(f instanceof EffectFn
      ? checkEffectFunction(f, `functions.${name}`).filter(
          (issue) =>
            (issue.code !== "NESTED_TASK_GROUP" || !profiles.has(f)) &&
            !(
              issue.code === "TASK_GROUP_RECOVERY" &&
              queue.get(f)?.fallibleAll === true &&
              issue.path === `functions.${name}.body.body`
            ),
        )
      : checkFunction(f, `functions.${name}`)),
  ]);
  if (!Object.keys(program.functions).length)
    return yield* fail("EMPTY_PROGRAM", "check", "functions", "At least one function is required");
  if (issues.length)
    return yield* new CompileError({ message: "Invalid program", diagnostics: issues });
  return program;
});

const derive = (program: Program): Effect.Effect<Analysis, CompileError> => {
  const derived = derivedPrograms.get(program);
  return derived
    ? Effect.succeed(derived)
    : deriveProgram(program).pipe(
        Effect.tap((analysis) => Effect.sync(() => derivedPrograms.set(program, analysis))),
      );
};
const deriveProgram = Effect.fn("Compile.derive")(function* (
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
        Make: (n) => n.fields.forEach((field) => field && walk(field)),
        Get: (n) => walk(n.value),
        MatchUndefined: (n) => {
          walk(n.value);
          walk(n.onDefined);
          walk(n.onUndefined);
        },
        Defined: (n) => walk(n.value),
        Undefined: () => {},
        RecordQuery: (n) => {
          walk(n.value);
          if (n.key) walk(n.key);
        },
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
        TaskGroup: (n) => {
          effectRefs.add(n.mode === "All" ? AsyncEffects.All : AsyncEffects.Race);
          n.children.forEach(walkComputation);
        },
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
        RemoteStore: (n) => {
          effectRefs.add(isLiveSignal(n.op) ? AsyncEffects.LiveHub : AsyncEffects.RemoteStore);
          walk(n.id);
          if (n.values) walk(n.values);
        },
        SqlExecute: (n) => {
          effectRefs.add(AsyncEffects.SqlExecute);
          n.params.forEach(walk);
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
        QueueMake: (n) => {
          effectRefs.add(SyncEffects.QueueMake);
          types.add(n.success);
          types.add(n.error);
        },
        QueueScope: (n) => {
          effectRefs.add(SyncEffects.QueueMake);
          types.add(n.success);
          types.add(n.error);
          walkComputation(n.body);
        },
        QueueOperation: (n) => {
          types.add(n.success);
          types.add(n.error);
          if (n.operation === "Offer") {
            effectRefs.add(AsyncEffects.QueueOffer);
            walk(n.value);
          } else if (n.operation === "Take") effectRefs.add(AsyncEffects.QueueTake);
          else if (n.operation === "End") effectRefs.add(SyncEffects.QueueEnd);
          else effectRefs.add(SyncEffects.QueueShutdown);
        },
        LatchMake: () => effectRefs.add(SyncEffects.LatchMake),
        LatchOperation: (n) =>
          effectRefs.add(
            Match.value(n.operation).pipe(
              Match.when("Await", () => AsyncEffects.LatchAwait),
              Match.when("Open", () => SyncEffects.LatchOpen),
              Match.when("Close", () => SyncEffects.LatchClose),
              Match.when("Release", () => SyncEffects.LatchRelease),
              Match.when("IsOpen", () => SyncEffects.LatchIsOpen),
              Match.exhaustive,
            ),
          ),
        LatchScope: (n) => {
          effectRefs.add(SyncEffects.LatchMake);
          walkComputation(n.body);
        },
        SemaphoreMake: () => effectRefs.add(SyncEffects.SemaphoreMake),
        SemaphoreScope: (n) => {
          effectRefs.add(SyncEffects.SemaphoreMake);
          walkComputation(n.body);
        },
        SemaphoreWithPermits: (n) => {
          effectRefs.add(AsyncEffects.SemaphoreWithPermits);
          walkComputation(n.body);
        },
        DeferredMake: (n) => {
          effectRefs.add(SyncEffects.DeferredMake);
          types.add(n.success);
          types.add(n.error);
        },
        DeferredScope: (n) => {
          effectRefs.add(SyncEffects.DeferredMake);
          types.add(n.success);
          types.add(n.error);
          walkComputation(n.body);
        },
        DeferredAwait: (n) => {
          effectRefs.add(AsyncEffects.DeferredAwait);
          types.add(n.success);
          types.add(n.error);
        },
        DeferredComplete: (n) => {
          effectRefs.add(AsyncEffects.DeferredComplete);
          types.add(n.success);
          types.add(n.error);
          walk(n.value);
        },
        DeferredIsDone: () => {
          effectRefs.add(SyncEffects.DeferredIsDone);
        },
        RefMake: (n) => {
          effectRefs.add(SyncEffects.RefMake);
          walk(n.initial);
        },
        RefScope: (n) => {
          effectRefs.add(SyncEffects.RefMake);
          walk(n.initial);
          walkComputation(n.body);
        },
        RefGet: () => {
          effectRefs.add(SyncEffects.RefGet);
        },
        RefModify: (n) => {
          effectRefs.add(SyncEffects.RefModify);
          walk(n.result);
          walk(n.next);
        },
        ClockReadMillis: () => {
          effectRefs.add(SyncEffects.ClockReadMillis);
        },
        RandomDraw: () => {
          effectRefs.add(SyncEffects.RandomDraw);
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
        StreamEmit: (n) => {
          effectRefs.add(AsyncEffects.StreamEmit);
          const stages = (stream: StreamIR<unknown, unknown>): void => {
            types.add(stream.item);
            types.add(stream.error);
            streamSources(stream.node).forEach(stages);
          };
          stages(n.stream);
          streamExpressions(n.stream).forEach(({ expr }) => walk(expr));
          streamFinalizers(n.stream).forEach(({ finalizer }) => walkComputation(finalizer));
          walk(n.encoded);
        },
        StreamRunCollect: (n) => {
          effectRefs.add(SyncEffects.StreamRunCollect);
          // Every stage's elements and chunks are native values (STREAM-004).
          const stages = (stream: StreamIR<unknown, unknown>): void => {
            types.add(stream.item);
            types.add(stream.error);
            streamSources(stream.node).forEach(stages);
          };
          stages(n.stream);
          streamExpressions(n.stream).forEach(({ expr }) => walk(expr));
          streamFinalizers(n.stream).forEach(({ finalizer }) => walkComputation(finalizer));
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
                : IRType.same(type, NumberType)
                  ? [Capabilities.Number]
                  : [],
      ),
      ...(Array.from(types).some(reachesUnknown) ? [Capabilities.Json] : []),
      ...(effectRefs.size ? [Capabilities.SyncResult] : []),
      ...(effectRefs.has(SyncEffects.QueueMake) ||
      effectRefs.has(SyncEffects.LatchMake) ||
      effectRefs.has(SyncEffects.DeferredMake) ||
      effectRefs.has(SyncEffects.SemaphoreMake) ||
      Array.from(effectRefs).some((ref) =>
        Object.values(AsyncEffects).some((supported) => supported === ref),
      )
        ? [Capabilities.AsyncResult]
        : []),
      ...(usesFiles ? [Capabilities.ScopedFiles] : []),
    ]),
    effects: collect([...operations.flatMap((op) => op.effects), ...effectRefs]),
    requirements: collect(
      operations
        .flatMap((op) => op.requirements)
        .concat(
          usesFiles ? [FileRequirement] : [],
          effectRefs.has(SyncEffects.ClockReadMillis) ? [ClockRequirement] : [],
          effectRefs.has(SyncEffects.RandomDraw) ? [RandomRequirement] : [],
        ),
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
  runtimeServices: RuntimeServicesSelection = defaultRuntimeServices,
): Effect.fn.Return<Plan, CompileError> {
  if (target.ref !== Targets.RustStd)
    return yield* fail(
      "UNSUPPORTED_TARGET",
      "plan",
      target.id,
      "No verified lowering registered for this target",
    );
  const queue = yield* Effect.try({
    try: () => checkedQueueProfiles(analysis.program),
    catch: (cause) =>
      cause instanceof CompileError
        ? cause
        : fail("QUEUE_GENERATED_PROFILE", "plan", "functions", String(cause)),
  });
  if (
    !queue.size &&
    analysis.effects.some((ref) =>
      [
        SyncEffects.QueueMake,
        AsyncEffects.QueueOffer,
        AsyncEffects.QueueTake,
        SyncEffects.QueueEnd,
        SyncEffects.QueueShutdown,
      ].some((operation) => operation === ref),
    )
  )
    return yield* fail(
      "QUEUE_NATIVE_INTEGRATION",
      "plan",
      "effects",
      "Queue requires the checked standalone Queue profile with local or root All2 Done recovery",
    );
  const semaphore = yield* Effect.try({
    try: () => checkedSemaphoreProfiles(analysis.program),
    catch: (cause) =>
      cause instanceof CompileError
        ? cause
        : fail("SEMAPHORE_GENERATED_PROFILE", "plan", "functions", String(cause)),
  });
  const latch = yield* Effect.try({
    try: () => checkedLatchProfiles(analysis.program),
    catch: (cause) =>
      cause instanceof CompileError
        ? cause
        : fail("LATCH_GENERATED_PROFILE", "plan", "functions", String(cause)),
  });
  if (
    !latch.size &&
    analysis.effects.some(
      (ref) =>
        ref === SyncEffects.LatchMake ||
        ref === AsyncEffects.LatchAwait ||
        ref === SyncEffects.LatchOpen ||
        ref === SyncEffects.LatchClose ||
        ref === SyncEffects.LatchRelease ||
        ref === SyncEffects.LatchIsOpen,
    )
  )
    return yield* fail(
      "LATCH_NATIVE_INTEGRATION",
      "plan",
      "effects",
      "Latch requires the checked standalone generated profile",
    );
  if (
    !semaphore.size &&
    analysis.effects.some(
      (ref) => ref === SyncEffects.SemaphoreMake || ref === AsyncEffects.SemaphoreWithPermits,
    )
  )
    return yield* fail(
      "SEMAPHORE_NATIVE_INTEGRATION",
      "plan",
      "effects",
      "Semaphore requires the checked standalone generated profile",
    );
  yield* Effect.try({
    try: () => checkedDeferredProfiles(analysis.program),
    catch: (cause) =>
      cause instanceof CompileError
        ? cause
        : fail("DEFERRED_GENERATED_PROFILE", "plan", "functions", String(cause)),
  });
  const selectedServices = yield* Effect.try({
    try: () => normalizeRuntimeServicesSelection(runtimeServices),
    catch: (cause) =>
      cause instanceof CompileError
        ? cause
        : fail("INVALID_SERVICE_SELECTION", "plan", "runtimeServices", String(cause)),
  });
  if (selectedServices.clock === "InjectedMillis") {
    for (const [name, f] of Object.entries(analysis.program.functions)) {
      if (!(f instanceof EffectFn)) continue;
      const paths = analyzeTaskGroups(f.body, `functions.${name}.body`).childClockPaths;
      if (paths.length)
        return yield* fail(
          "TASK_GROUP_SERVICE",
          "plan",
          paths[0],
          "Child tasks cannot capture a mutable injected Clock driver",
        );
    }
  }
  const derived = yield* derive(analysis.program);
  if (
    derived.requirements.includes(RandomRequirement) &&
    selectedServices.random !== "ScriptedRandom"
  )
    return yield* fail(
      "MISSING_RUNTIME_SERVICE",
      "plan",
      RandomRequirement.id,
      "Reachable Random requires explicit ScriptedRandom implementation selection",
    );
  const selections: Selection[] = [];
  for (const op of derived.operations) {
    const rejected: { id: string; reason: string }[] = [];
    let selected: Implementation | undefined;
    // Host JSON functions and the Html serializer provide their own implementation; every
    // other operation chooses among the target's registered ones.
    const encoded = hostFunctionOf(op);
    const html = htmlOperationKind(op);
    const literalText = literalTextOf(op);
    const provided = encoded
      ? hostImplementation(op, encoded)
      : html
        ? htmlImplementation(op, html)
        : literalText
          ? literalTextImplementation(op, literalText.literals, literalText.native.type)
          : undefined;
    const candidates = provided
      ? [provided]
      : target.implementations.filter((i) => i.operation.id === op.id);
    for (const candidate of candidates) {
      const reason =
        candidate.operation.ref !== op.ref || candidate.operation !== op
          ? "Semantic identity collision"
          : candidate.target !== target.ref
            ? "Wrong target"
            : op.capabilities.some(
                  (c) => !target.capabilities.includes(c) || !candidate.capabilities.includes(c),
                )
              ? "Missing capability"
              : candidate !== provided && !target.implementations.includes(candidate)
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
  const planned = Plan.make(
    derived,
    target,
    selections,
    Array.from(
      new Set(
        selections
          .flatMap((s) => s.selected.crates)
          .concat(derived.capabilities.includes(Capabilities.AsyncResult) ? ["tokio@1.53.1"] : [])
          .concat(derived.capabilities.includes(Capabilities.Json) ? ["serde_json@1.0.151"] : []),
      ),
    ).sort(),
    FailureFrames.Bounded,
    selectedServices,
  );
  plannedPlans.add(planned);
  return planned;
});
/** A plan this stage returned is answered with itself; any other plan is planned again. */
const verify = (p: Plan): Effect.Effect<Plan, CompileError> =>
  verifiedPlans.has(p)
    ? Effect.succeed(p)
    : verifyPlan(p).pipe(Effect.tap((verified) => Effect.sync(() => verifiedPlans.add(verified))));
const verifyPlan = Effect.fn("Compile.verify")(function* (p: Plan) {
  yield* Effect.try({
    try: () => checkFailureFramePolicy(p.failureFrames),
    catch: (cause) =>
      cause instanceof CompileError
        ? cause
        : fail("INVALID_PLAN", "verify", "failureFrames", String(cause)),
  });
  const expected = plannedPlans.has(p)
    ? p
    : (yield* plan(p.analysis, p.target, p.runtimeServices)).pipe(
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
  // Done has a representation only inside a checked completion owner, never as a scalar.
  const localQueueDone = [...checkedQueueProfiles(expected.analysis.program).values()].some(
    (profile) => profile.completion === "End",
  );
  for (const type of expected.analysis.types) {
    if (
      type.layout === undefined &&
      !(type === QueueDoneType && localQueueDone) &&
      ![
        U64Type,
        BoolType,
        UnitType,
        NeverType,
        StringType,
        NumberType,
        UnknownType,
        HtmlType,
        UtcType,
      ].some((builtin) => IRType.same(type, builtin))
    )
      return yield* fail(
        "UNSUPPORTED_REPRESENTATION",
        "verify",
        type.id,
        "Only the builtin scalar witnesses (Bool, u64, Unit, Never, String, Number, Unknown, Html, DateTime.Utc) and composites have registered native representations",
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
      (checkedQueueProfiles(p.analysis.program).size
        ? lowerQueueFallibleFunctions
        : checkedLatchProfiles(p.analysis.program).size
          ? lowerLatchFunctions
          : checkedSemaphoreProfiles(p.analysis.program).size
            ? lowerSemaphoreFunctions
            : checkedDeferredProfiles(p.analysis.program).size
              ? lowerDeferredFunctions
              : lowerFunctions)(
        p.analysis.program,
        new Map(p.selections.map((selection) => [selection.operation.ref, selection.selected])),
        policy,
        p.failureFrames,
        p.runtimeServices,
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
  const emitted = yield* Effect.try({
    try: () => emitFunctions(module),
    catch: (cause) =>
      cause instanceof CompileError
        ? cause
        : fail("EMIT_FAILURE", "emit", "program", String(cause)),
  });
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
  runtimeServices: RuntimeServicesSelection = defaultRuntimeServices,
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
  const planned = (yield* plan(normalized, target, runtimeServices)).pipe(
    Plan.withFailureFrames(failureFrames),
  );
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
      value instanceof CompileSpec ? value.runtimeServices : defaultRuntimeServices,
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
      value instanceof CompileSpec ? value.runtimeServices : defaultRuntimeServices,
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
  withRuntimeServices: CompileSpec.withRuntimeServices,
  fromFoldkitQuery: Foldkit.compile,
  check: (program: Program) => located(program, check(program)),
  derive: (program: Program) => located(program, derive(program)),
  normalize: (analysis: Analysis) => located(analysis.program, normalize(analysis)),
  plan: (
    analysis: Analysis,
    target: Target = Rust.std,
    runtimeServices: RuntimeServicesSelection = defaultRuntimeServices,
  ) => located(analysis.program, plan(analysis, target, runtimeServices)),
  verify: (p: Plan) => located(p.analysis.program, verify(p)),
  optimize: (p: Plan) => located(p.analysis.program, optimize(p)),
  analyzeOwnership: (p: Plan) => located(p.analysis.program, analyzeOwnership(p)),
  lower: lowerRequest,
  emit: emitRequest,
  run: runRequest,
  build: buildRequest,
  explain: Effect.fn("Compile.explain")(function* (
    program: Program,
    target: Target = Rust.std,
    runtimeServices: RuntimeServicesSelection = defaultRuntimeServices,
  ) {
    return yield* located(
      program,
      Effect.gen(function* () {
        return yield* plan(yield* derive(program), target, runtimeServices);
      }),
    );
  }),
};
export class Compiler extends Context.Service<Compiler, typeof Compile>()("reffect/Compiler") {
  static readonly layer = Layer.succeed(Compiler, Compile);
}

export type { Fn };
