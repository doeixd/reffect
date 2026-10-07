import { DeferredInterruptionFrames } from "./deferred-interruption-frames.ts";
import { Cause, Context, Effect, Exit, Logger, Scheduler } from "effect";
import type { EffectFn, FramedExit } from "./effect-ir.ts";
import { PrivateEffectReference } from "./effect-ir.ts";
import { analyzeGeneratedQueueProfile } from "./queue-generated-profile.ts";
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

// External signals may shadow their accessors/listener methods. Only intrinsic
// operations touch them; Effect receives a fresh invocation-owned signal.
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!;
const addListener = Object.getOwnPropertyDescriptor(EventTarget.prototype, "addEventListener")!
  .value as EventTarget["addEventListener"];
const removeListener = Object.getOwnPropertyDescriptor(
  EventTarget.prototype,
  "removeEventListener",
)!.value as EventTarget["removeEventListener"];
const isAborted = (signal: AbortSignal): boolean => aborted.get!.call(signal);

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
    isAborted(signal);
  } catch {
    throw refusal("options.signal", "Cancellation requires a valid AbortSignal");
  }
  return signal;
};

const execute = <A, Out>(
  fn: EffectFn<readonly [], A, never>,
  options: QueueExecutionOptions | undefined,
  reference: () => Effect.Effect<Out, CompileError>,
): Promise<QueueObservation<Out>> => {
  let signal: AbortSignal | undefined;
  try {
    signal = cancellation(options);
    if (!analyzeGeneratedQueueProfile(Program.make({ work: fn })).has(fn))
      throw refusal("function", "This runner requires the checked bounded Queue profile");
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    return Promise.resolve(Object.freeze({ exit: Exit.fail(error), logs: Object.freeze([]) }));
  }
  // Official runFork handles signal only after eager evaluation, too late for this contract.
  if (signal && isAborted(signal))
    return Promise.resolve(Object.freeze({ exit: Exit.interrupt(), logs: Object.freeze([]) }));
  const logs: string[] = [];
  const logger = Logger.make((event) => logs.push(String(event.message)));
  const context = Context.empty().pipe(
    Context.add(Scheduler.Scheduler, new Scheduler.MixedScheduler()),
    Context.add(Scheduler.MaxOpsBeforeYield, queueBudgetLimit),
    Context.add(Scheduler.PreventSchedulerYield, false),
    Context.add(Logger.CurrentLoggers, new Set([logger])),
  );
  // Relay cancellation without admitting external signal hooks into Effect's runner.
  const controller = signal ? new AbortController() : undefined;
  const forward = () => controller!.abort();
  const retire = () => {
    if (signal) removeListener.call(signal, "abort", forward);
  };
  try {
    if (signal) {
      addListener.call(signal, "abort", forward, { once: true });
      if (isAborted(signal)) {
        retire();
        return Promise.resolve(Object.freeze({ exit: Exit.interrupt(), logs: Object.freeze([]) }));
      }
    }
    // Context construction, relay and Promise observation are outside evaluator receipts.
    return Effect.runPromiseExitWith(context)(
      reference(),
      controller ? { signal: controller.signal } : undefined,
    )
      .then((exit) => Object.freeze({ exit, logs: Object.freeze(logs) }))
      .finally(retire);
  } catch (error) {
    retire();
    throw error;
  }
};

/**
 * Private execution of the bounded Queue profile in an owned official Effect context.
 * Observes Exit and captured logs; accepts only an optional AbortSignal.
 * Reference frames do not admit native frames or public Queue compilation.
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
