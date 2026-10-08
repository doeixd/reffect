import {
  validateOwnedExecutionSignal,
  withOwnedExecutionSignal,
} from "./owned-execution-signal.ts";
import { DeferredInterruptionFrames } from "./deferred-interruption-frames.ts";
import { Cause, Context, Effect, Exit, Logger, Scheduler } from "effect";
import type { EffectFn, FramedExit } from "./effect-ir.ts";
import { PrivateEffectReference } from "./effect-ir.ts";
import { analyzeGeneratedQueueDoneProfile } from "./queue-generated-profile.ts";
import { queueBudgetLimit } from "./queue-budget.ts";
import { CompileError, Program } from "./kernel.ts";

export interface QueueExecutionOptions {
  readonly signal?: AbortSignal;
}
export interface QueueObservation<A> {
  readonly exit: Exit.Exit<A, CompileError>;
  readonly logs: readonly string[];
}
const refusal = (path: string, message: string) =>
  new CompileError({
    message: "Unsupported standalone Queue execution",
    diagnostics: [{ code: "QUEUE_EXECUTION_CONTEXT", stage: "check", path, message }],
  });

const execute = <A, Out>(
  fn: EffectFn<readonly [], A, never>,
  options: QueueExecutionOptions | undefined,
  reference: () => Effect.Effect<Out, CompileError>,
): Promise<QueueObservation<Out>> => {
  let signal: AbortSignal | undefined;
  try {
    signal = validateOwnedExecutionSignal(options, refusal);
    if (!analyzeGeneratedQueueDoneProfile(Program.make({ work: fn })).has(fn))
      throw refusal("function", "This runner requires the checked bounded Queue profile");
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    return Promise.resolve(Object.freeze({ exit: Exit.fail(error), logs: Object.freeze([]) }));
  }
  return withOwnedExecutionSignal<QueueObservation<Out>>(
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

/**
 * Execution of the bounded Queue profile in an owned official Effect context.
 * Observes Exit and captured logs; accepts only an optional AbortSignal.
 * Accepts offer/take and End with child-local unit Done recovery; wider ownership stays gated.
 */
export const QueueExecution = Object.freeze({
  run: <A>(fn: EffectFn<readonly [], A, never>, options?: QueueExecutionOptions) =>
    execute(fn, options, () => PrivateEffectReference.runUnknown(fn, [], () => [])),
  runWithFrames: <A>(
    fn: EffectFn<readonly [], A, never>,
    options?: QueueExecutionOptions,
  ): Promise<QueueObservation<FramedExit<A, never>>> => {
    const frames = new DeferredInterruptionFrames();
    return execute(fn, options, () =>
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
