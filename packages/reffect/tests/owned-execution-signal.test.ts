import { getEventListeners } from "node:events";
import { expect, test, vi } from "vite-plus/test";
import { CompileError } from "../src/kernel.ts";
import {
  validateOwnedExecutionSignal,
  withOwnedExecutionSignal,
} from "../src/owned-execution-signal.ts";

const refusal = (path: string, message: string) =>
  new CompileError({
    message,
    diagnostics: [{ code: "TEST_CONTEXT", stage: "check", path, message }],
  });

test("shared option validation rejects accessors and forged signals without module coupling", () => {
  const getter = vi.fn(() => AbortSignal.abort());
  expect(() =>
    validateOwnedExecutionSignal(
      {
        get signal() {
          return getter();
        },
      },
      refusal,
    ),
  ).toThrow(CompileError);
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    validateOwnedExecutionSignal({ signal: Object.create(AbortSignal.prototype) }, refusal),
  ).toThrow(CompileError);
  expect(() => validateOwnedExecutionSignal({ extra: 1 }, refusal)).toThrow(CompileError);
  expect(validateOwnedExecutionSignal(undefined, refusal)).toBeUndefined();
  expect(validateOwnedExecutionSignal({ signal: undefined }, refusal)).toBeUndefined();
  const signal = new AbortController().signal;
  expect(
    validateOwnedExecutionSignal(Object.assign(Object.create(null), { signal }), refusal),
  ).toBe(signal);
});

test("no signal starts directly without a relay or preabort observation", async () => {
  const value = Promise.resolve("complete"),
    preabort = vi.fn(() => "preabort");
  const start = vi.fn(() => value);
  expect(withOwnedExecutionSignal(undefined, preabort, start)).toBe(value);
  expect(start).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(preabort).not.toHaveBeenCalled();
  await value;
});

test("intrinsic preabort never opens the start callback or attaches a listener", async () => {
  const controller = new AbortController();
  controller.abort();
  const getter = vi.fn(() => false),
    start = vi.fn(() => Promise.resolve("opened"));
  Object.defineProperty(controller.signal, "aborted", { get: getter });
  expect(await withOwnedExecutionSignal(controller.signal, () => "preabort", start)).toBe(
    "preabort",
  );
  expect(start).not.toHaveBeenCalled();
  expect(getter).not.toHaveBeenCalled();
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

test("relay forwards to a distinct signal while leaving completion with the start callback", async () => {
  const controller = new AbortController();
  let owned: AbortSignal | undefined;
  let finish!: () => void;
  const result = withOwnedExecutionSignal(
    controller.signal,
    () => "preabort",
    (signal) => {
      owned = signal;
      return new Promise<string>((resolve) => {
        finish = () => resolve("cleanup:done");
      });
    },
  );
  expect(owned).toBeInstanceOf(AbortSignal);
  expect(owned).not.toBe(controller.signal);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
  controller.abort();
  expect(owned!.aborted).toBe(true);
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  finish();
  expect(await result).toBe("cleanup:done");
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

test("fulfilled and rejected starts retire only their own listener", async () => {
  const controller = new AbortController(),
    unrelated = vi.fn(),
    error = new Error("start rejected");
  controller.signal.addEventListener("abort", unrelated);
  expect(
    await withOwnedExecutionSignal(
      controller.signal,
      () => "preabort",
      () => Promise.resolve("done"),
    ),
  ).toBe("done");
  expect(getEventListeners(controller.signal, "abort")).toEqual([unrelated]);
  await expect(
    withOwnedExecutionSignal(
      controller.signal,
      () => "preabort",
      () => Promise.reject(error),
    ),
  ).rejects.toBe(error);
  expect(getEventListeners(controller.signal, "abort")).toEqual([unrelated]);
  controller.abort();
  expect(unrelated).toHaveBeenCalledOnce();
});

test("synchronous start failure retires the relay and preserves the thrown error", () => {
  const controller = new AbortController(),
    unrelated = vi.fn(),
    error = new Error("start threw");
  controller.signal.addEventListener("abort", unrelated);
  expect(() =>
    withOwnedExecutionSignal(
      controller.signal,
      () => "preabort",
      () => {
        throw error;
      },
    ),
  ).toThrow(error);
  expect(getEventListeners(controller.signal, "abort")).toEqual([unrelated]);
});
