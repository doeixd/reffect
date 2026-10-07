import { getEventListeners } from "node:events";
import { Cause, Clock, Context, Effect, Exit, Fiber, Logger, Scheduler, Tracer } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { R } from "../src/authoring.ts";
import { EffectReference } from "../src/effect-ir.ts";
import type { Computation, FramedExit } from "../src/effect-ir.ts";
import { CompileError, EqU64, Expr, Operation } from "../src/kernel.ts";
import { QueueIR as Q } from "../src/queue.ts";
import { QueueExecution } from "../src/queue-execution.ts";
import type { QueueExecutionOptions } from "../src/queue-execution.ts";

const all = (a: Computation<void>, b: Computation<void>) =>
  R.Effect.all([a, b], { concurrency: "unbounded", discard: true });
const sequence = (steps: readonly Computation<void>[]) =>
  steps.reduce((body, next) => body.pipe(R.Effect.andThen(next)), R.Effect.void);
const transfer = (capacity: number) =>
  R.fn([], R.U64, R.Never, () =>
    Q.bounded(R.U64, capacity).pipe(
      R.Effect.flatMap((owner) =>
        all(
          sequence(
            [1n, 2n, 3n].map((value) =>
              Q.offer(owner, R.U64.literal(value)).pipe(R.Effect.andThen(R.Log.info(`p:${value}`))),
            ),
          ),
          sequence(
            [1n, 2n, 3n].map((value) =>
              Q.take(owner).pipe(R.Effect.andThen(R.Log.info(`c:${value}`))),
            ),
          ),
        ).pipe(R.Effect.andThen(R.Effect.succeed(R.U64.literal(7n)))),
      ),
    ),
  );
const blocked = R.fn([], R.Unit, R.Never, () =>
  Q.bounded(R.U64, 1).pipe(
    R.Effect.flatMap((owner) =>
      all(
        R.Log.info("waiting").pipe(
          R.Effect.andThen(Q.take(owner)),
          R.Effect.andThen(R.Log.info("must-not-run")),
        ),
        Q.take(owner).pipe(R.Effect.asVoid),
      ),
    ),
  ),
);
const codes = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.flatMap((reason) =>
        Cause.isFailReason(reason) && reason.error instanceof CompileError
          ? reason.error.diagnostics.map((diagnostic) => diagnostic.code)
          : [],
      )
    : [];
const interrupted = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);

// Keep a raw official oracle alongside the owned path used by generated tests.
test("owned Queue matches raw reference pressure, scalar results and immutable fresh observations", async () => {
  for (const capacity of [1, 2, 3]) {
    const fn = transfer(capacity);
    const logs: string[] = [];
    const raw = await Effect.runPromiseExit(
      EffectReference.run(fn, []).pipe(
        Effect.provideService(
          Logger.CurrentLoggers,
          new Set([Logger.make((event) => logs.push(String(event.message)))]),
        ),
      ),
    );
    const owned = await QueueExecution.run(fn);
    expect(owned.exit).toEqual(raw);
    expect(owned.logs).toEqual(logs);
    expect(owned.exit).toEqual(Exit.succeed(7n));
    expect(Object.isFrozen(owned)).toBe(true);
    expect(Object.isFrozen(owned.logs)).toBe(true);
    expect((await QueueExecution.run(fn)).logs).toEqual(logs);
    const framed = await QueueExecution.runWithFrames(fn);
    expect(framed.exit).toMatchObject({
      value: { exit: Exit.succeed(7n), frames: [], omitted: 0 },
    });
    expect(framed.logs).toEqual(logs);
  }
});

test("preabort remains unopened and blocked offer/take interruption settles before return", async () => {
  const full = R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.U64, 1).pipe(
      R.Effect.flatMap((owner) =>
        all(
          Q.offer(owner, R.U64.literal(1n)).pipe(
            R.Effect.andThen(R.Log.info("full")),
            R.Effect.andThen(Q.offer(owner, R.U64.literal(2n))),
            R.Effect.andThen(R.Log.info("must-not-offer")),
          ),
          R.Effect.void,
        ),
      ),
    ),
  );
  for (const fn of [blocked, full])
    for (const run of [QueueExecution.run, QueueExecution.runWithFrames]) {
      const pre = await run(fn, { signal: AbortSignal.abort() });
      expect(interrupted(pre.exit)).toBe(true);
      expect(pre.logs).toEqual([]);
      const controller = new AbortController();
      const pending = run(fn, { signal: controller.signal });
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      controller.abort();
      const result = await pending;
      expect(result.logs).toEqual(fn === blocked ? ["waiting"] : ["full"]);
      const outer: Exit.Exit<unknown, unknown> = result.exit;
      const exit = Exit.isSuccess(outer) ? (outer.value as FramedExit<void, never>).exit : outer;
      expect(interrupted(exit)).toBe(true);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    }
  const controller = new AbortController();
  const pending = QueueExecution.runWithFrames(blocked, { signal: controller.signal });
  controller.abort();
  expect((await pending).exit).toMatchObject({
    value: {
      frames: [
        { path: "functions.work.body.body", kind: "all" },
        { path: "functions.work.body", kind: "queueScope" },
        { path: "functions.work", kind: "function" },
      ],
      omitted: 0,
    },
  });
});

test("cancellation uses intrinsic signal state and listener methods without external hooks", async () => {
  const hook = vi.fn(() => {
    throw new Error("external signal hook ran");
  });
  for (const run of [QueueExecution.run, QueueExecution.runWithFrames]) {
    const pre = new AbortController();
    pre.abort();
    Object.defineProperty(pre.signal, "aborted", { get: hook });
    expect(interrupted((await run(blocked, { signal: pre.signal })).exit)).toBe(true);
    const controller = new AbortController();
    Object.defineProperties(controller.signal, {
      aborted: { get: hook },
      addEventListener: { value: hook },
      removeEventListener: { value: hook },
    });
    const pending = run(blocked, { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.logs).toEqual(["waiting"]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  }
  expect(hook).not.toHaveBeenCalled();
});

test("plain options, brand checks and profile auditing refuse before callbacks or authored logs", async () => {
  const accessor = vi.fn(() => AbortSignal.abort());
  for (const options of [
    null,
    {
      get signal() {
        return accessor();
      },
    },
    { signal: Object.create(AbortSignal.prototype) },
    { signal: {} },
    { context: Context.empty() },
    { scheduler: new Scheduler.MixedScheduler() },
    { maxOpsBeforeYield: 1 },
    { [Symbol("hook")]: vi.fn() },
    Object.create({ signal: AbortSignal.abort() }),
  ]) {
    for (const run of [QueueExecution.run, QueueExecution.runWithFrames]) {
      const result = await run(transfer(1), options as QueueExecutionOptions);
      expect(codes(result.exit)).toEqual(["QUEUE_EXECUTION_CONTEXT"]);
      expect(result.logs).toEqual([]);
    }
  }
  expect(accessor).not.toHaveBeenCalled();
  const shape = (options: QueueExecutionOptions) => options;
  // @ts-expect-error The owned context cannot be replaced.
  shape({ context: Context.empty() });
  const callback = vi.fn(() => true);
  const alias = Operation.make(EqU64.ref, [R.U64, R.U64], R.Bool, callback);
  const forged = R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.U64, 1).pipe(
      R.Effect.flatMap((owner) =>
        all(
          Q.offer(owner, R.U64.literal(1n)).pipe(R.Effect.asVoid),
          R.Effect.succeed(Expr.apply(alias, R.U64.literal(1n), R.U64.literal(1n))).pipe(
            R.Effect.asVoid,
          ),
        ),
      ),
    ),
  );
  expect(codes((await QueueExecution.run(forged)).exit)).toContain("QUEUE_REFERENCE_CONTEXT");
  expect(callback).not.toHaveBeenCalled();
  for (const fn of [
    R.fn([], R.Unit, R.Never, () => R.Log.info("ordinary")),
    R.fn([], R.Unit, R.Never, () =>
      Q.bounded(R.U64, 1).pipe(
        R.Effect.flatMap((owner) =>
          all(Q.shutdown(owner).pipe(R.Effect.asVoid), R.Log.info("unsupported")),
        ),
      ),
    ),
  ]) {
    const result = await QueueExecution.run(fn);
    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(result.logs).toEqual([]);
  }
});

test("over-budget programs refuse before source logging and cancellation attachment", async () => {
  const fn = R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.U64, 1).pipe(
      R.Effect.flatMap((owner) => {
        const offer = Q.offer(owner, R.U64.literal(1n)).pipe(R.Effect.asVoid),
          take = Q.take(owner).pipe(R.Effect.asVoid);
        return R.Log.info("unopened").pipe(
          R.Effect.andThen(
            all(
              sequence(Array.from({ length: 10 }, () => offer)),
              sequence(Array.from({ length: 10 }, () => take)),
            ),
          ),
        );
      }),
    ),
  );
  for (const run of [QueueExecution.run, QueueExecution.runWithFrames]) {
    const controller = new AbortController();
    const result = await run(fn, { signal: controller.signal });
    expect(codes(result.exit)).toEqual(["QUEUE_BUDGET_EXCEEDED"]);
    expect(result.logs).toEqual([]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  }
});

test("owned scheduler isolates ambient services, hooks, loggers and yield settings", async () => {
  const ambientLog = vi.fn(),
    now = vi.fn(() => 123),
    traced = new Set<number>();
  const tracer: Tracer.Tracer = {
    span: (options) => Tracer.nativeTracer.span(options),
    context: (primitive, fiber) => {
      traced.add(fiber.id);
      return primitive["~effect/Effect/evaluate"](fiber);
    },
  };
  const clock: Clock.Clock = Object.assign(
    Object.create(Context.get(Context.empty(), Clock.Clock)),
    { currentTimeMillisUnsafe: now },
  );
  const host = Context.empty().pipe(
    Context.add(Clock.Clock, clock),
    Context.add(Tracer.Tracer, tracer),
    Context.add(Logger.CurrentLoggers, new Set([Logger.make(ambientLog)])),
    Context.add(Scheduler.MaxOpsBeforeYield, 1),
    Context.add(Scheduler.PreventSchedulerYield, true),
  );
  const original = Object.getOwnPropertyDescriptor(
    Scheduler.MixedScheduler.prototype,
    "shouldYield",
  )!.value as Scheduler.MixedScheduler["shouldYield"];
  const counts: number[] = [];
  const spy = vi
    .spyOn(Scheduler.MixedScheduler.prototype, "shouldYield")
    .mockImplementation(function (
      this: Scheduler.MixedScheduler,
      fiber: Fiber.Fiber<unknown, unknown>,
    ) {
      if (!traced.has(fiber.id)) {
        expect(fiber.cache.maxOpsBeforeYield).toBe(2048);
        expect(fiber.cache.preventYield).toBe(false);
        expect(fiber.cache.tracerContext).toBeUndefined();
        counts.push(fiber.currentOpCount);
      }
      return original.call(this, fiber);
    });
  try {
    const result = await Effect.runPromiseWith(host)(
      Effect.promise(() => QueueExecution.run(transfer(1))),
    );
    expect(result.exit).toEqual(Exit.succeed(7n));
    const framed = await Effect.runPromiseWith(host)(
      Effect.promise(() => QueueExecution.runWithFrames(transfer(1))),
    );
    expect(framed.exit).toMatchObject({ value: { exit: Exit.succeed(7n), frames: [] } });
    expect(framed.logs).toEqual(result.logs);
    expect(counts.length).toBeGreaterThan(0);
    expect(Math.max(...counts)).toBeLessThan(2048);
    expect(traced.size).toBe(2);
    expect(now).not.toHaveBeenCalled();
    expect(ambientLog).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

test("successful signal forwarding retires only its own listener and stays invocation-local", async () => {
  const controller = new AbortController(),
    unrelated = vi.fn();
  controller.signal.addEventListener("abort", unrelated);
  for (let i = 0; i < 3; i++) {
    const result = await QueueExecution.run(transfer(1), { signal: controller.signal });
    expect(result.exit).toEqual(Exit.succeed(7n));
    expect(getEventListeners(controller.signal, "abort")).toEqual([unrelated]);
  }
  const nullOptions = Object.assign(Object.create(null), {
    signal: controller.signal,
  }) as QueueExecutionOptions;
  expect((await QueueExecution.run(transfer(1), nullOptions)).exit).toEqual(Exit.succeed(7n));
  controller.abort();
  expect(unrelated).toHaveBeenCalledOnce();
  expect((await QueueExecution.run(transfer(1))).exit).toEqual(Exit.succeed(7n));
});

test("concurrent blocked invocations keep cancellation and frame trails separate", async () => {
  const first = new AbortController(),
    second = new AbortController();
  const left = QueueExecution.runWithFrames(blocked, { signal: first.signal });
  const right = QueueExecution.runWithFrames(blocked, { signal: second.signal });
  first.abort();
  const firstResult = await left;
  expect(firstResult.logs).toEqual(["waiting"]);
  expect(getEventListeners(first.signal, "abort")).toHaveLength(0);
  expect(getEventListeners(second.signal, "abort")).toHaveLength(1);
  second.abort();
  const secondResult = await right;
  expect(secondResult.logs).toEqual(["waiting"]);
  expect(Exit.isSuccess(firstResult.exit) && Exit.isSuccess(secondResult.exit)).toBe(true);
  if (Exit.isSuccess(firstResult.exit) && Exit.isSuccess(secondResult.exit)) {
    expect(interrupted(firstResult.exit.value.exit)).toBe(true);
    expect(interrupted(secondResult.exit.value.exit)).toBe(true);
    expect(secondResult.exit.value.frames).toEqual(firstResult.exit.value.frames);
    expect(secondResult.exit.value.frames).not.toBe(firstResult.exit.value.frames);
  }
  expect(getEventListeners(second.signal, "abort")).toHaveLength(0);
});
