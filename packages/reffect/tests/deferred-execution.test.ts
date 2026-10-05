import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Logger,
  Scheduler,
  Tracer,
} from "effect";
import { expect, test, vi } from "vite-plus/test";
import { R } from "../src/index.ts";
import { DeferredIR as D } from "../src/deferred.ts";
import { DeferredExecution } from "../src/deferred-execution.ts";
import type { DeferredExecutionOptions } from "../src/deferred-execution.ts";
import type { FramedExit } from "../src/effect-ir.ts";
import { EqU64, Expr, Operation, SemanticRef } from "../src/kernel.ts";
import {
  analyzeDeferredBudget,
  defaultDeferredBudgetContext,
  deferredBudgetLimit,
} from "../src/deferred-budget.ts";

const completed = R.fn([], R.U64, R.Never, () =>
  D.make(R.U64).pipe(
    R.Effect.flatMap((cell) =>
      R.Log.info("entered").pipe(
        R.Effect.andThen(D.succeed(cell, R.U64.literal(7n))),
        R.Effect.andThen(D.succeed(cell, R.U64.literal(9n))),
        R.Effect.andThen(D.await(cell)),
      ),
    ),
  ),
);
const pending = R.fn([], R.Unit, R.Never, () =>
  D.make(R.Unit).pipe(
    R.Effect.flatMap((cell) =>
      R.Log.info("entered").pipe(
        R.Effect.andThen(D.await(cell)),
        R.Effect.ensuring(
          R.Log.info("cleanup:start").pipe(
            R.Effect.andThen(R.Effect.sleep(1)),
            R.Effect.andThen(R.Log.info("cleanup:done")),
          ),
        ),
      ),
    ),
  ),
);

test("standalone runner retains scalar completion and owns immutable observations", async () => {
  const plain = await DeferredExecution.run(completed);
  expect(plain.exit).toEqual(Exit.succeed(7n));
  expect(plain.logs).toEqual(["entered"]);
  expect(Object.isFrozen(plain)).toBe(true);
  expect(Object.isFrozen(plain.logs)).toBe(true);
  const framed = await DeferredExecution.runWithFrames(completed);
  expect(framed.exit).toMatchObject({ value: { exit: Exit.succeed(7n), frames: [], omitted: 0 } });
  expect(framed.logs).toEqual(plain.logs);
  const after = new AbortController();
  const finished = await DeferredExecution.run(completed, { signal: after.signal });
  after.abort();
  expect(finished).toEqual(plain);
});

test("context, scheduler, hook and accessor injection fail before authored work", async () => {
  const accessor = vi.fn(() => new AbortController().signal);
  const lookalike = Object.create(AbortSignal.prototype) as AbortSignal;
  const options: unknown[] = [
    { scheduler: new Scheduler.MixedScheduler("sync") },
    { context: Context.empty() },
    { clock: Context.get(Context.empty(), Clock.Clock) },
    { tracer: Tracer.nativeTracer },
    { onFiberStart: vi.fn() },
    { uninterruptible: true },
    { preventYield: true },
    { maxOpsBeforeYield: 1 },
    { signal: AbortSignal.abort(), scheduler: new Scheduler.MixedScheduler() },
    {
      get signal() {
        return accessor();
      },
    },
    { signal: lookalike },
    { signal: {} },
    Object.create({ scheduler: new Scheduler.MixedScheduler() }),
    { [Symbol("context")]: Context.empty() },
    null,
  ];
  for (const option of options) {
    const observed = await DeferredExecution.run(completed, option as DeferredExecutionOptions);
    expect(observed.logs).toEqual([]);
    expect(observed.exit).toMatchObject({
      cause: { reasons: [{ error: { diagnostics: [{ code: "DEFERRED_EXECUTION_CONTEXT" }] } }] },
    });
  }
  expect(accessor).not.toHaveBeenCalled();
  const optionsShape = (value: DeferredExecutionOptions) => value;
  // @ts-expect-error arbitrary Effect RunOptions do not cross this boundary
  optionsShape({ scheduler: new Scheduler.MixedScheduler() });
  // @ts-expect-error arbitrary contexts do not cross this boundary
  optionsShape({ context: Context.empty() });
});

test("custom reference callbacks and semantic-ref aliases are refused before invocation", async () => {
  const callback = vi.fn(() => true);
  for (const ref of [SemanticRef.operation("test/custom-context"), EqU64.ref]) {
    const operation = Operation.make(ref, [R.U64, R.U64], R.Bool, callback);
    const work = R.fn([], R.Bool, R.Never, () =>
      D.make(R.Bool).pipe(
        R.Effect.flatMap((cell) =>
          D.succeed(cell, Expr.apply(operation, R.U64.literal(1n), R.U64.literal(1n))).pipe(
            R.Effect.andThen(D.await(cell)),
          ),
        ),
      ),
    );
    const result = await DeferredExecution.run(work);
    expect(result.logs).toEqual([]);
    expect(result.exit).toMatchObject({
      cause: {
        reasons: [
          {
            error: {
              diagnostics: [{ code: "DEFERRED_EXECUTION_CONTEXT", path: "function.reference" }],
            },
          },
        ],
      },
    });
  }
  expect(callback).not.toHaveBeenCalled();
  const builtin = R.fn([], R.Bool, R.Never, () =>
    D.make(R.Bool).pipe(
      R.Effect.flatMap((cell) =>
        D.succeed(cell, R.U64.eq(R.U64.literal(1n), R.U64.literal(1n))).pipe(
          R.Effect.andThen(D.await(cell)),
        ),
      ),
    ),
  );
  expect((await DeferredExecution.run(builtin)).exit).toEqual(Exit.succeed(true));
});

test("ambient services, yield flags and host continuations cannot enter the root fiber", async () => {
  const hostLog = vi.fn();
  const clockSleep = vi.fn(() => Effect.die("ambient clock leaked"));
  const customClock: Clock.Clock = Object.assign(
    Object.create(Context.get(Context.empty(), Clock.Clock)),
    {
      sleep: clockSleep,
    },
  );
  const tracedFibers = new Set<number>();
  const customTracer: Tracer.Tracer = {
    span: (options) => Tracer.nativeTracer.span(options),
    context: (primitive, fiber) => {
      tracedFibers.add(fiber.id);
      return primitive["~effect/Effect/evaluate"](fiber);
    },
  };
  const host = Context.empty().pipe(
    Context.add(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync")),
    Context.add(Clock.Clock, customClock),
    Context.add(Tracer.Tracer, customTracer),
    Context.add(Logger.CurrentLoggers, new Set([Logger.make(hostLog)])),
    Context.add(Scheduler.MaxOpsBeforeYield, 1),
    Context.add(Scheduler.PreventSchedulerYield, true),
  );
  const asleep = R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap((cell) =>
        R.Log.info("owned").pipe(
          R.Effect.andThen(R.Effect.sleep(1)),
          R.Effect.andThen(D.succeed(cell, R.Unit.literal())),
          R.Effect.andThen(D.await(cell)),
        ),
      ),
    ),
  );
  let invocation = Effect.promise(() => DeferredExecution.run(asleep));
  for (let i = 0; i < 600; i++) {
    const next = invocation;
    invocation = Effect.flatMap(Effect.void, () => next);
  }
  const result = await Effect.runPromiseWith(host)(invocation);
  expect(result.exit).toEqual(Exit.succeed(undefined));
  expect(result.logs).toEqual(["owned"]);
  expect(clockSleep).not.toHaveBeenCalled();
  // Only the ambient host fiber enters its tracer hook; the owned root does not.
  expect(tracedFibers.size).toBe(1);
  expect(hostLog).not.toHaveBeenCalled();
});

test("pre-aborted execution does not start while in-flight interruption awaits cleanup", async () => {
  for (const run of [DeferredExecution.run, DeferredExecution.runWithFrames]) {
    const before = new AbortController();
    before.abort();
    const unopened = await run(pending, { signal: before.signal });
    expect(unopened.logs).toEqual([]);
    const unopenedExit: Exit.Exit<unknown, unknown> = unopened.exit;
    expect(Exit.isFailure(unopenedExit) && Cause.hasInterrupts(unopenedExit.cause)).toBe(true);
    const controller = new AbortController();
    const result = run(pending, { signal: controller.signal });
    controller.abort();
    const ended = await result;
    expect(ended.logs).toEqual(["entered", "cleanup:start", "cleanup:done"]);
    const outer: Exit.Exit<unknown, unknown> = ended.exit;
    const exit = Exit.isSuccess(outer) ? (outer.value as FramedExit<void, never>).exit : outer;
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  }
});

const mapped = (count: number) =>
  R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap((cell) => {
        let body = D.await(cell);
        for (let i = 0; i < count; i++) body = R.Effect.map(body, (value) => value);
        return D.succeed(cell, R.Unit.literal()).pipe(R.Effect.andThen(body));
      }),
    ),
  );
test("standalone groups preserve registration-ordered synchronous waiter prefixes", async () => {
  const group = R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap((cell) =>
        R.Effect.all(
          [
            R.Log.info("first:start").pipe(
              R.Effect.andThen(D.await(cell)),
              R.Effect.andThen(R.Log.info("first:prefix")),
            ),
            R.Log.info("second:start").pipe(
              R.Effect.andThen(D.await(cell)),
              R.Effect.andThen(R.Log.info("second:prefix")),
            ),
            R.Log.info("producer:start").pipe(
              R.Effect.andThen(D.succeed(cell, R.Unit.literal())),
              R.Effect.andThen(R.Log.info("producer:after")),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      ),
    ),
  );
  const expected = [
    "first:start",
    "second:start",
    "producer:start",
    "first:prefix",
    "second:prefix",
    "producer:after",
  ];
  const officialLogs: string[] = [];
  const official = Effect.gen(function* () {
    const cell = yield* Deferred.make<void>();
    yield* Effect.all(
      [
        Effect.logInfo("first:start").pipe(
          Effect.andThen(Deferred.await(cell)),
          Effect.andThen(Effect.logInfo("first:prefix")),
        ),
        Effect.logInfo("second:start").pipe(
          Effect.andThen(Deferred.await(cell)),
          Effect.andThen(Effect.logInfo("second:prefix")),
        ),
        Effect.logInfo("producer:start").pipe(
          Effect.andThen(Deferred.succeed(cell, undefined)),
          Effect.andThen(Effect.logInfo("producer:after")),
        ),
      ],
      { concurrency: "unbounded", discard: true },
    );
  });
  const officialContext = Context.make(
    Logger.CurrentLoggers,
    new Set([Logger.make((event) => officialLogs.push(String(event.message)))]),
  );
  expect(await Effect.runPromiseExitWith(officialContext)(official)).toEqual(
    Exit.succeed(undefined),
  );
  expect(officialLogs).toEqual(expected);
  expect((await DeferredExecution.run(group)).logs).toEqual(expected);
  expect((await DeferredExecution.runWithFrames(group)).logs).toEqual(expected);
});
test("owned scheduler preserves automatic yielding and refuses beyond the audited budget", async () => {
  let count = 0;
  while (
    analyzeDeferredBudget(mapped(count + 1), "body", defaultDeferredBudgetContext, true).admitted
  )
    count++;
  const below = mapped(count);
  const above = mapped(count + 1);
  expect(
    analyzeDeferredBudget(below, "body", defaultDeferredBudgetContext, true).framed,
  ).toBeLessThan(deferredBudgetLimit);
  expect(analyzeDeferredBudget(above, "body", defaultDeferredBudgetContext, true).admitted).toBe(
    false,
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
      expect(fiber.cache.maxOpsBeforeYield).toBe(deferredBudgetLimit);
      expect(fiber.cache.preventYield).toBe(false);
      expect(fiber.cache.runtimeMetrics).toBeUndefined();
      expect(fiber.cache.tracerContext).toBeUndefined();
      counts.push(fiber.currentOpCount);
      return original.call(this, fiber);
    });
  try {
    expect((await DeferredExecution.run(below)).exit).toEqual(Exit.succeed(undefined));
    expect((await DeferredExecution.runWithFrames(below)).exit).toMatchObject({
      value: { exit: Exit.succeed(undefined) },
    });
    expect(Math.max(...counts)).toBeLessThan(deferredBudgetLimit);
    const before = counts.length;
    for (const run of [DeferredExecution.run, DeferredExecution.runWithFrames]) {
      const refused = await run(above);
      expect(refused.logs).toEqual([]);
      expect(refused.exit).toMatchObject({
        cause: { reasons: [{ error: { diagnostics: [{ code: "DEFERRED_BUDGET_EXCEEDED" }] } }] },
      });
    }
    expect(counts.length).toBe(before);
  } finally {
    spy.mockRestore();
  }
});
