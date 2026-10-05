import { Context, Effect, Exit, Logger, Scheduler } from "effect";
import type { EffectFn, FramedExit } from "./effect-ir.ts";
import { GeneratedDeferredReference } from "./deferred-generated-reference.ts";
import { analyzeGeneratedDeferredProfile } from "./deferred-generated-profile.ts";
import { deferredBudgetLimit } from "./deferred-budget.ts";
import { CompileError, Program } from "./kernel.ts";

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
    if (!analyzeGeneratedDeferredProfile(Program.make({ work: fn })).has(fn))
      throw refusal("function", "This runner requires the checked private Deferred profile");
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

/** Internal standalone host boundary; absent from package exports and public admission. */
export const DeferredExecution = Object.freeze({
  run: <A>(fn: EffectFn<readonly [], A, never>, options?: DeferredExecutionOptions) =>
    execute(fn, options, () => GeneratedDeferredReference.run(fn, [])),
  runWithFrames: <A>(
    fn: EffectFn<readonly [], A, never>,
    options?: DeferredExecutionOptions,
  ): Promise<DeferredObservation<FramedExit<A, never>>> =>
    execute(fn, options, () => GeneratedDeferredReference.runWithFrames(fn, [])),
});
