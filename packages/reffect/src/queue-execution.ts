import {
  validateOwnedExecutionSignal,
  withOwnedExecutionSignal,
} from "./owned-execution-signal.ts";
import { attachQueueAllRecordedFrames } from "./queue-all-observation.ts";
import { DeferredInterruptionFrames } from "./deferred-interruption-frames.ts";
import { Cause, Context, Effect, Exit, Logger, Scheduler } from "effect";
import type { EffectFn, FramedExit } from "./effect-ir.ts";
import { PrivateEffectReference } from "./effect-ir.ts";
import {
  analyzeGeneratedQueueDoneProfile,
  analyzeGeneratedQueueFallibleProfile,
} from "./queue-generated-profile.ts";
import { queueBudgetLimit } from "./queue-budget.ts";
import { CompileError, Program } from "./kernel.ts";

export interface QueueExecutionOptions {
  readonly signal?: AbortSignal;
}
export interface QueueObservation<A> {
  readonly exit: Exit.Exit<A, CompileError>;
  readonly logs: readonly string[];
}
/** Observed source Done may survive cancellation that bypasses root All recovery. */
export interface QueueAllObservation<A> {
  readonly exit: Exit.Exit<A, CompileError | Cause.Done<void>>;
  readonly logs: readonly string[];
}
type Observation<A, E> = {
  readonly exit: Exit.Exit<A, CompileError | E>;
  readonly logs: readonly string[];
};
const refusal = (path: string, message: string) =>
  new CompileError({
    message: "Unsupported standalone Queue execution",
    diagnostics: [{ code: "QUEUE_EXECUTION_CONTEXT", stage: "check", path, message }],
  });

const execute = <A, Out, E = never>(
  fn: EffectFn<readonly [], A, never>,
  options: QueueExecutionOptions | undefined,
  reference: () => Effect.Effect<Out, CompileError | E>,
  all = false,
): Promise<Observation<Out, E>> => {
  let signal: AbortSignal | undefined;
  try {
    signal = validateOwnedExecutionSignal(options, refusal);
    const profile = (all ? analyzeGeneratedQueueFallibleProfile : analyzeGeneratedQueueDoneProfile)(
      Program.make({ work: fn }),
    ).get(fn);
    if (!profile || (all && !profile.fallibleAll))
      throw refusal(
        "function",
        all
          ? "This runner requires checked root All2 unit Done recovery"
          : "This runner requires the checked bounded Queue profile",
      );
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    return Promise.resolve(Object.freeze({ exit: Exit.fail(error), logs: Object.freeze([]) }));
  }
  return withOwnedExecutionSignal<Observation<Out, E>>(
    signal,
    () => Object.freeze({ exit: Exit.interrupt(), logs: Object.freeze([]) }),
    (ownedSignal) => {
      const logs: string[] = [];
      const logger = Logger.make((event) => logs.push(String(event.message)));
      const context = Context.empty().pipe(
        Context.add(Scheduler.Scheduler, new Scheduler.MixedScheduler()),
        Context.add(Scheduler.MaxOpsBeforeYield, queueBudgetLimit),
        Context.add(Scheduler.PreventSchedulerYield, false),
        Context.add(Logger.CurrentLoggers, new Set([logger])),
      );
      return Effect.runPromiseExitWith(context)(
        reference(),
        ownedSignal ? { signal: ownedSignal } : undefined,
      ).then((exit) => Object.freeze({ exit, logs: Object.freeze(logs) }));
    },
  );
};

const runWithFrames = <A, E = never>(
  fn: EffectFn<readonly [], A, never>,
  options?: QueueExecutionOptions,
  all = false,
  attachRecorded?: (
    observation: Observation<FramedExit<A, E>, E>,
    boundary: Pick<FramedExit<A, E>, "frames" | "omitted">,
  ) => Observation<FramedExit<A, E>, E>,
): Promise<Observation<FramedExit<A, E>, E>> => {
  const frames = new DeferredInterruptionFrames();
  return execute<A, FramedExit<A, E>, E>(
    fn,
    options,
    () =>
      PrivateEffectReference.runWithFramesUnknown(
        fn,
        [],
        "functions.work.body",
        () => {
          frames.claim();
          try {
            frames.prepare(fn.body, "functions.work.body");
            return [];
          } catch (error) {
            if (error instanceof CompileError) return error.diagnostics;
            throw error;
          }
        },
        frames.root("functions.work.body"),
      ),
    all,
  ).then((observation) => {
    const { exit } = observation;
    const trail = frames.snapshot();
    if (attachRecorded) return attachRecorded(observation, trail);
    // Pre-aborted invocations have no recorded source boundary and stay unopened.
    if (!Exit.isFailure(exit) || !Cause.hasInterruptsOnly(exit.cause) || !trail.frames.length)
      return observation;
    return Object.freeze({
      logs: observation.logs,
      exit: Exit.succeed(
        Object.freeze({
          exit: Exit.failCause(
            Cause.fromReasons<E>(exit.cause.reasons.filter(Cause.isInterruptReason)),
          ),
          ...trail,
        }),
      ),
    });
  });
};

/**
 * Execution of the bounded Queue profile in an owned official Effect context.
 * Observes Exit and captured logs; accepts only an optional AbortSignal.
 * Accepts offer/take and End with child-local unit Done recovery; wider ownership stays gated.
 */
export const QueueExecution = Object.freeze({
  run: <A>(
    fn: EffectFn<readonly [], A, never>,
    options?: QueueExecutionOptions,
  ): Promise<QueueObservation<A>> =>
    execute(fn, options, () => PrivateEffectReference.runUnknown(fn, [], () => [])),
  runWithFrames: <A>(
    fn: EffectFn<readonly [], A, never>,
    options?: QueueExecutionOptions,
  ): Promise<QueueObservation<FramedExit<A, never>>> => runWithFrames(fn, options),
});

/** Owned root All2 Done recovery; observations preserve source Done when cancellation bypasses it. */
export const QueueAllExecution = Object.freeze({
  run: (
    fn: EffectFn<readonly [], void, never>,
    options?: QueueExecutionOptions,
  ): Promise<QueueAllObservation<void>> =>
    execute<void, void, Cause.Done<void>>(
      fn,
      options,
      () => PrivateEffectReference.runUnknown(fn, [], () => []),
      true,
    ),
  runWithFrames: (
    fn: EffectFn<readonly [], void, never>,
    options?: QueueExecutionOptions,
  ): Promise<QueueAllObservation<FramedExit<void, Cause.Done<void>>>> =>
    runWithFrames<void, Cause.Done<void>>(fn, options, true, attachQueueAllRecordedFrames),
});
