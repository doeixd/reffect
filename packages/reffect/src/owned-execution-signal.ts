import type { CompileError } from "./kernel.ts";

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

export const validateOwnedExecutionSignal = (
  options: unknown,
  refusal: (path: string, message: string) => CompileError,
): AbortSignal | undefined => {
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

/** Internal OCAN lifetime boundary; relay setup adds no Effect primitives. */
export const withOwnedExecutionSignal = <A>(
  signal: AbortSignal | undefined,
  preabort: () => A,
  start: (ownedSignal: AbortSignal | undefined) => Promise<A>,
): Promise<A> => {
  if (!signal) return start(undefined);
  // Official runFork checks a signal after eager evaluation, so do this first.
  if (isAborted(signal)) return Promise.resolve(preabort());
  const controller = new AbortController();
  const forward = () => controller.abort();
  const retire = () => removeListener.call(signal, "abort", forward);
  try {
    addListener.call(signal, "abort", forward, { once: true });
    if (isAborted(signal)) {
      retire();
      return Promise.resolve(preabort());
    }
    return start(controller.signal).finally(retire);
  } catch (error) {
    retire();
    throw error;
  }
};
