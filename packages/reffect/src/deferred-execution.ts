import { DeferredInterruptionFrames } from "./deferred-interruption-frames.ts";
import { Cause, Context, Effect, Exit, Logger, Match, Scheduler } from "effect";
import type { Computation, EffectFn, FramedExit } from "./effect-ir.ts";
import { GeneratedDeferredReference } from "./deferred-generated-reference.ts";
import { analyzeGeneratedDeferredProfile } from "./deferred-generated-profile.ts";
import { checkGeneratedDeferredNesting } from "./deferred-growth.ts";
import { deferredBudgetLimit } from "./deferred-budget.ts";
import {
  AddNumber,
  AddU64,
  BoolType,
  CompileError,
  ConcatString,
  EqBool,
  EqNumber,
  EqString,
  EqU64,
  IncludesString,
  LtNumber,
  LtU64,
  MulU64,
  NeverType,
  NotBool,
  NumberToString,
  NumberType,
  Program,
  ReplaceAllString,
  StringType,
  SubU64,
  U64Type,
  UnitType,
} from "./kernel.ts";
import type { AnyOperation, Expr, IRType } from "./kernel.ts";

export interface DeferredExecutionOptions {
  readonly signal?: AbortSignal;
}
export interface DeferredObservation<A> {
  readonly exit: Exit.Exit<A, CompileError>;
  readonly logs: readonly string[];
}
const refusal = (path: string, message: string) =>
  new CompileError({
    message: "Unsupported standalone Deferred execution",
    diagnostics: [{ code: "DEFERRED_EXECUTION_CONTEXT", stage: "check", path, message }],
  });

const trustedTypes = new Set<IRType<unknown>>([
  BoolType,
  U64Type,
  UnitType,
  NeverType,
  StringType,
  NumberType,
]);
const trustedOperations = new Set<AnyOperation>([
  AddU64,
  SubU64,
  MulU64,
  EqU64,
  LtU64,
  EqBool,
  NotBool,
  EqString,
  IncludesString,
  ConcatString,
  ReplaceAllString,
  AddNumber,
  EqNumber,
  LtNumber,
  NumberToString,
] as AnyOperation[]);
/** Internal shared identity audit for native admission and owned execution. */
export const checkDeferredExecutionReferences = (
  fn: EffectFn,
  reject: (path: string, message: string) => CompileError = refusal,
): void => {
  const expressions = new Set<Expr<unknown>>();
  const computations = new Set<Computation<unknown, unknown>>();
  const unsupported = () => {
    throw reject(
      "function.reference",
      "Only audited builtin scalar expressions can execute in the owned context",
    );
  };
  const expression = (e: Expr<unknown>): void => {
    if (expressions.has(e)) return;
    expressions.add(e);
    if (!trustedTypes.has(e.type)) unsupported();
    Match.value(e.node).pipe(
      Match.tags({
        Parameter: () => {},
        Literal: () => {},
        Apply: (n) => {
          if (!trustedOperations.has(n.operation)) unsupported();
          n.args.forEach(expression);
        },
        Match: (n) => {
          expression(n.condition);
          expression(n.onTrue);
          expression(n.onFalse);
        },
      }),
      Match.orElse(unsupported),
    );
  };
  const computation = (c: Computation<unknown, unknown>): void => {
    if (computations.has(c)) return;
    computations.add(c);
    if (!trustedTypes.has(c.output) || !trustedTypes.has(c.error)) unsupported();
    Match.value(c.node).pipe(
      Match.tags({
        Succeed: (n) => expression(n.value),
        Map: (n) => {
          computation(n.source);
          expression(n.body);
        },
        FlatMap: (n) => {
          computation(n.source);
          computation(n.body);
        },
        Match: (n) => {
          expression(n.condition);
          computation(n.onTrue);
          computation(n.onFalse);
        },
        Ensuring: (n) => {
          computation(n.body);
          computation(n.finalizer);
        },
        TaskGroup: (n) => n.children.forEach(computation),
        DeferredScope: (n) => {
          if (!trustedTypes.has(n.success) || !trustedTypes.has(n.error)) unsupported();
          computation(n.body);
        },
        QueueMake: unsupported,
        QueueScope: unsupported,
        QueueOperation: unsupported,
        LatchScope: (n) => computation(n.body),
        LatchOperation: () => {},
        SemaphoreScope: (n) => computation(n.body),
        SemaphoreWithPermits: (n) => computation(n.body),
        DeferredComplete: (n) => expression(n.value),
        DeferredAwait: () => {},
        DeferredIsDone: () => {},
        Sleep: () => {},
        Log: () => {},
      }),
      Match.orElse(unsupported),
    );
  };
  computation(fn.body);
};

const cancellation = (options: unknown): AbortSignal | undefined => {
  if (options === undefined) return undefined;
  if (
    options === null ||
    typeof options !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    throw refusal("options", "Only a plain cancellation-options object is supported");
  const descriptors = Object.getOwnPropertyDescriptors(options);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key !== "signal") throw refusal(`options.${String(key)}`, "Only signal is supported");
    if (!("value" in descriptors.signal!))
      throw refusal("options.signal", "Cancellation accessors are unsupported");
  }
  const signal: unknown = descriptors.signal?.value;
  if (signal === undefined) return undefined;
  if (!(signal instanceof AbortSignal))
    throw refusal("options.signal", "Cancellation requires a same-realm AbortSignal");
  // Brand-check before starting source work; a prototype-only lookalike is insufficient.
  try {
    Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!.call(signal);
  } catch {
    throw refusal("options.signal", "Cancellation requires a valid AbortSignal");
  }
  return signal;
};

const execute = <A, Out>(
  fn: EffectFn<readonly [], A, never>,
  options: DeferredExecutionOptions | undefined,
  reference: () => Effect.Effect<Out, CompileError>,
): Promise<DeferredObservation<Out>> => {
  let signal: AbortSignal | undefined;
  try {
    signal = cancellation(options);
    checkGeneratedDeferredNesting(fn, "function");
    checkDeferredExecutionReferences(fn);
    if (!analyzeGeneratedDeferredProfile(Program.make({ work: fn })).has(fn))
      throw refusal("function", "This runner requires the checked bounded Deferred profile");
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    return Promise.resolve(Object.freeze({ exit: Exit.fail(error), logs: Object.freeze([]) }));
  }
  // Official runFork handles signal only after eager evaluation, too late for this contract.
  if (signal?.aborted)
    return Promise.resolve(Object.freeze({ exit: Exit.interrupt(), logs: Object.freeze([]) }));
  const logs: string[] = [];
  const logger = Logger.make((event) => logs.push(String(event.message)));
  const context = Context.empty().pipe(
    Context.add(Scheduler.Scheduler, new Scheduler.MixedScheduler()),
    Context.add(Scheduler.MaxOpsBeforeYield, deferredBudgetLimit),
    Context.add(Scheduler.PreventSchedulerYield, false),
    Context.add(Logger.CurrentLoggers, new Set([logger])),
  );
  // Context construction and Promise observation add no evaluator operations to the receipt.
  return Effect.runPromiseExitWith(context)(reference(), signal ? { signal } : undefined).then(
    (exit) => Object.freeze({ exit, logs: Object.freeze(logs) }),
  );
};

/**
 * Execute the bounded Deferred profile in an owned official Effect context.
 * Observes Exit and captured logs; accepts only an optional AbortSignal.
 * Native parity requires the same admitted profile and a successful Rust build.
 */
export const DeferredExecution = Object.freeze({
  run: <A>(fn: EffectFn<readonly [], A, never>, options?: DeferredExecutionOptions) =>
    execute(fn, options, () => GeneratedDeferredReference.run(fn, [])),
  runWithFrames: <A>(
    fn: EffectFn<readonly [], A, never>,
    options?: DeferredExecutionOptions,
  ): Promise<DeferredObservation<FramedExit<A, never>>> => {
    const frames = new DeferredInterruptionFrames();
    return execute(fn, options, () =>
      GeneratedDeferredReference.runWithInterruptionFrames(fn, [], frames),
    ).then((observation) => {
      const { exit } = observation;
      const trail = frames.snapshot();
      // Pre-aborted invocations have no recorded source boundary and stay unopened.
      if (!Exit.isFailure(exit) || !Cause.hasInterruptsOnly(exit.cause) || !trail.frames.length)
        return observation;
      return Object.freeze({
        logs: observation.logs,
        exit: Exit.succeed(
          Object.freeze({
            exit: Exit.failCause(
              Cause.fromReasons<never>(exit.cause.reasons.filter(Cause.isInterruptReason)),
            ),
            ...trail,
          }),
        ),
      });
    });
  },
});
