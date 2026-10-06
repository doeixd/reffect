import { DeferredInterruptionFrames } from "./deferred-interruption-frames.ts";
import { Cause, Context, Effect, Exit, Logger, Scheduler } from "effect";
import type { EffectFn, FramedExit } from "./effect-ir.ts";
import { PrivateEffectReference } from "./effect-ir.ts";
import { analyzeGeneratedLatchProfile } from "./latch-generated-profile.ts";
import { latchBudgetLimit } from "./latch-budget.ts";
import { CompileError, Program } from "./kernel.ts";

export interface LatchExecutionOptions {
  readonly signal?: AbortSignal;
}
export interface LatchObservation<A> {
  readonly exit: Exit.Exit<A, CompileError>;
  readonly logs: readonly string[];
}
const refusal = (path: string, message: string) =>
  new CompileError({
    message: "Unsupported standalone Latch execution",
    diagnostics: [{ code: "LATCH_EXECUTION_CONTEXT", stage: "check", path, message }],
  });

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
  options: LatchExecutionOptions | undefined,
  reference: () => Effect.Effect<Out, CompileError>,
): Promise<LatchObservation<Out>> => {
  let signal: AbortSignal | undefined;
  try {
    signal = cancellation(options);
    if (!analyzeGeneratedLatchProfile(Program.make({ work: fn })).has(fn))
      throw refusal("function", "This runner requires the checked bounded Latch profile");
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
    Context.add(Scheduler.MaxOpsBeforeYield, latchBudgetLimit),
    Context.add(Scheduler.PreventSchedulerYield, false),
    Context.add(Logger.CurrentLoggers, new Set([logger])),
  );
  // Context construction and Promise observation add no evaluator operations to the receipt.
  return Effect.runPromiseExitWith(context)(reference(), signal ? { signal } : undefined).then(
    (exit) => Object.freeze({ exit, logs: Object.freeze(logs) }),
  );
};

/**
 * Execute the bounded Latch profile in an owned official Effect context.
 * Observes Exit and captured logs; accepts only an optional AbortSignal.
 * Native parity requires the same admitted profile and a successful Rust build.
 */
export const LatchExecution = Object.freeze({
  run: <A>(fn: EffectFn<readonly [], A, never>, options?: LatchExecutionOptions) =>
    execute(fn, options, () => PrivateEffectReference.runUnknown(fn, [], () => [])),
  runWithFrames: <A>(
    fn: EffectFn<readonly [], A, never>,
    options?: LatchExecutionOptions,
  ): Promise<LatchObservation<FramedExit<A, never>>> => {
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
