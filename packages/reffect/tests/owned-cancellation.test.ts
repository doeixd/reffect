import { getEventListeners } from "node:events";
import { Cause, Exit } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { R } from "../src/authoring.ts";
import type { FramedExit } from "../src/effect-ir.ts";
import { CompileError } from "../src/kernel.ts";
import { DeferredIR as D } from "../src/deferred.ts";
import { LatchIR as L } from "../src/latch.ts";
import { SemaphoreIR as S } from "../src/semaphore.ts";
import { QueueIR as Q } from "../src/queue.ts";
import { DeferredExecution } from "../src/deferred-execution.ts";
import { LatchExecution } from "../src/latch-execution.ts";
import { SemaphoreExecution } from "../src/semaphore-execution.ts";
import { QueueExecution } from "../src/queue-execution.ts";

const cleanup = () =>
  R.Log.info("cleanup:start").pipe(
    R.Effect.andThen(R.Effect.sleep(1)),
    R.Effect.andThen(R.Log.info("cleanup:done")),
  );
const cases = [
  {
    name: "Deferred",
    execution: DeferredExecution,
    completed: R.fn([], R.Unit, R.Never, () =>
      D.make(R.Unit).pipe(
        R.Effect.flatMap((cell) =>
          D.succeed(cell, R.Unit.literal()).pipe(R.Effect.andThen(R.Log.info("done"))),
        ),
      ),
    ),
    pending: R.fn([], R.Unit, R.Never, () =>
      D.make(R.Unit).pipe(
        R.Effect.flatMap((cell) =>
          R.Log.info("entered").pipe(R.Effect.andThen(D.await(cell)), R.Effect.ensuring(cleanup())),
        ),
      ),
    ),
  },
  {
    name: "Latch",
    execution: LatchExecution,
    completed: R.fn([], R.Unit, R.Never, () =>
      L.make(true).pipe(R.Effect.flatMap((owner) => L.whenOpen(owner, R.Log.info("done")))),
    ),
    pending: R.fn([], R.Unit, R.Never, () =>
      L.make().pipe(
        R.Effect.flatMap((owner) =>
          R.Log.info("entered").pipe(
            R.Effect.andThen(L.await(owner)),
            R.Effect.ensuring(cleanup()),
          ),
        ),
      ),
    ),
  },
  {
    name: "Semaphore",
    execution: SemaphoreExecution,
    completed: R.fn([], R.Unit, R.Never, () =>
      S.make(1).pipe(R.Effect.flatMap((owner) => S.withPermit(owner)(R.Log.info("done")))),
    ),
    pending: R.fn([], R.Unit, R.Never, () =>
      S.make(1).pipe(
        R.Effect.flatMap((owner) =>
          S.withPermit(owner)(
            R.Log.info("entered").pipe(
              R.Effect.andThen(R.Effect.sleep(1000)),
              R.Effect.ensuring(cleanup()),
            ),
          ),
        ),
      ),
    ),
  },
  {
    name: "Queue",
    execution: QueueExecution,
    completed: R.fn([], R.Unit, R.Never, () =>
      Q.bounded(R.Unit, 1).pipe(
        R.Effect.flatMap((owner) =>
          R.Effect.all(
            [
              Q.offer(owner, R.Unit.literal()).pipe(R.Effect.andThen(R.Log.info("done"))),
              Q.take(owner),
            ],
            { concurrency: "unbounded", discard: true },
          ),
        ),
      ),
    ),
    pending: R.fn([], R.Unit, R.Never, () =>
      Q.bounded(R.Unit, 1).pipe(
        R.Effect.flatMap((owner) =>
          R.Effect.all(
            [R.Log.info("entered").pipe(R.Effect.andThen(Q.take(owner))), Q.take(owner)],
            { concurrency: "unbounded", discard: true },
          ),
        ),
      ),
    ),
  },
] as const;
const interrupted = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);

test.each(cases)(
  "pre-aborted $name signals cannot hide cancellation behind a shadow getter",
  async ({ execution, completed }) => {
    for (const run of [execution.run, execution.runWithFrames]) {
      const controller = new AbortController();
      controller.abort();
      const getter = vi.fn(() => false);
      Object.defineProperty(controller.signal, "aborted", { get: getter });
      const result = await run(completed, { signal: controller.signal });
      expect(interrupted(result.exit)).toBe(true);
      expect(result.logs).toEqual([]);
      expect(getter).not.toHaveBeenCalled();
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    }
  },
);

test.each(cases)(
  "live $name cancellation ignores signal overrides and awaits cleanup",
  async ({ name, execution, pending }) => {
    for (const run of [execution.run, execution.runWithFrames]) {
      const controller = new AbortController();
      const hook = vi.fn(() => {
        throw new Error("external signal hook ran");
      });
      Object.defineProperties(controller.signal, {
        aborted: { get: hook },
        addEventListener: { value: hook },
        removeEventListener: { value: hook },
      });
      const active = run(pending, { signal: controller.signal });
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      controller.abort();
      const result = await active;
      const outer: Exit.Exit<unknown, unknown> = result.exit;
      const exit = Exit.isSuccess(outer) ? (outer.value as FramedExit<void, never>).exit : outer;
      expect(interrupted(exit)).toBe(true);
      expect(result.logs).toEqual(
        name === "Queue" ? ["entered"] : ["entered", "cleanup:start", "cleanup:done"],
      );
      expect(hook).not.toHaveBeenCalled();
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    }
  },
);

test.each(cases)(
  "successful $name invocations retire their own forwarding listener",
  async ({ execution, completed }) => {
    const controller = new AbortController(),
      unrelated = vi.fn();
    controller.signal.addEventListener("abort", unrelated);
    for (const run of [execution.run, execution.runWithFrames]) {
      const result = await run(completed, { signal: controller.signal });
      const outer: Exit.Exit<unknown, unknown> = result.exit;
      expect(Exit.isSuccess(outer)).toBe(true);
      expect(result.logs).toEqual(["done"]);
      expect(getEventListeners(controller.signal, "abort")).toEqual([unrelated]);
    }
    controller.abort();
    expect(unrelated).toHaveBeenCalledOnce();
  },
);

test.each(cases)(
  "$name retains module-specific option diagnostics before source work",
  async ({ name, execution, completed }) => {
    const getter = vi.fn(() => AbortSignal.abort());
    for (const run of [execution.run, execution.runWithFrames]) {
      const result = await run(completed, {
        get signal() {
          return getter();
        },
      });
      expect(result.logs).toEqual([]);
      const outer: Exit.Exit<unknown, unknown> = result.exit;
      expect(Exit.isFailure(outer)).toBe(true);
      if (Exit.isFailure(outer)) {
        const codes = outer.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) && reason.error instanceof CompileError
            ? reason.error.diagnostics.map((issue) => issue.code)
            : [],
        );
        expect(codes).toEqual([`${name.toUpperCase()}_EXECUTION_CONTEXT`]);
      }
    }
    expect(getter).not.toHaveBeenCalled();
  },
);
