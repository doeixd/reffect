import { Cause, Clock, Context, Effect, Exit, Fiber, Logger, Scheduler, Tracer } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { R, SemaphoreExecution } from "../src/index.ts";
import { DeferredIR as D } from "../src/deferred.ts";
import { DeferredExecution } from "../src/deferred-execution.ts";
import type { FramedExit } from "../src/effect-ir.ts";
import { EqU64, Expr, Operation } from "../src/kernel.ts";
import { SemaphoreIR as S } from "../src/semaphore.ts";
import { SemaphoreType } from "../src/semaphore-model.ts";
import type { SemaphoreExecutionOptions } from "../src/semaphore-execution.ts";

const completed = R.fn([], R.U64, R.Never, () =>
  S.make(1).pipe(
    R.Effect.flatMap((owner) =>
      S.withPermit(owner)(
        R.Log.info("entered").pipe(R.Effect.andThen(R.Effect.succeed(R.U64.literal(7n)))),
      ),
    ),
  ),
);
const held = R.fn([], R.Unit, R.Never, () =>
  S.make(1).pipe(
    R.Effect.flatMap((owner) =>
      S.withPermit(owner)(
        R.Log.info("held").pipe(
          R.Effect.andThen(R.Effect.sleep(1000)),
          R.Effect.ensuring(
            R.Log.info("cleanup:start").pipe(
              R.Effect.andThen(R.Effect.sleep(1)),
              R.Effect.andThen(R.Log.info("cleanup:done")),
            ),
          ),
        ),
      ),
    ),
  ),
);

test("owned Semaphore retains scalar results, immutable logs and fresh owners", async () => {
  const result = await SemaphoreExecution.run(completed);
  expect(result.exit).toEqual(Exit.succeed(7n));
  expect(result.logs).toEqual(["entered"]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.logs)).toBe(true);
  const framed = await SemaphoreExecution.runWithFrames(completed);
  expect(framed.exit).toMatchObject({ value: { exit: Exit.succeed(7n), frames: [], omitted: 0 } });
  expect(framed.logs).toEqual(result.logs);
  const first = new AbortController();
  const second = new AbortController();
  const activeFirst = SemaphoreExecution.run(held, { signal: first.signal });
  const activeSecond = SemaphoreExecution.run(held, { signal: second.signal });
  first.abort();
  second.abort();
  for (const invocation of [activeFirst, activeSecond]) {
    expect((await invocation).logs).toEqual(["held", "cleanup:start", "cleanup:done"]);
  }
});

test("pre-aborted execution stays unopened and held interruption awaits cleanup and retains helper frames", async () => {
  for (const run of [SemaphoreExecution.run, SemaphoreExecution.runWithFrames]) {
    const preflight = await run(held, { signal: AbortSignal.abort() });
    expect(preflight.logs).toEqual([]);
    const preflightExit: Exit.Exit<unknown, unknown> = preflight.exit;
    expect(Exit.isFailure(preflightExit) && Cause.hasInterruptsOnly(preflightExit.cause)).toBe(
      true,
    );
    const controller = new AbortController();
    const active = run(held, { signal: controller.signal });
    controller.abort();
    const result = await active;
    expect(result.logs).toEqual(["held", "cleanup:start", "cleanup:done"]);
    const outer: Exit.Exit<unknown, unknown> = result.exit;
    const framed = Exit.isSuccess(outer) ? (outer.value as FramedExit<void, never>) : undefined;
    const exit = framed?.exit ?? outer;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    if (framed) {
      expect(framed.frames.map(({ kind }) => kind)).toEqual([
        "sleep",
        "flatMap",
        "ensuring",
        "semaphoreWithPermits",
        "semaphoreScope",
        "function",
      ]);
      expect(framed.frames.at(-2)).toEqual({ path: "functions.work.body", kind: "semaphoreScope" });
      expect(framed.omitted).toBe(0);
    }
  }
});

test("All discards interrupted child trails and captures its root boundary after sibling cleanup", async () => {
  const work = R.fn([], R.Unit, R.Never, () =>
    S.make(1).pipe(
      R.Effect.flatMap((owner) =>
        R.Effect.all(
          [
            S.withPermit(owner)(
              R.Log.info("holder").pipe(
                R.Effect.andThen(R.Effect.sleep(1000)),
                R.Effect.ensuring(
                  R.Log.info("holder:cleanup").pipe(R.Effect.andThen(R.Effect.sleep(1))),
                ),
              ),
            ),
            S.withPermit(owner)(R.Log.info("waiter")),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      ),
    ),
  );
  const controller = new AbortController();
  const active = SemaphoreExecution.runWithFrames(work, { signal: controller.signal });
  controller.abort();
  const result = await active;
  expect(result.logs).toEqual(["holder", "holder:cleanup"]);
  expect(result.exit).toMatchObject({
    value: {
      frames: [
        { path: "functions.work.body.body", kind: "all" },
        { path: "functions.work.body", kind: "semaphoreScope" },
        { path: "functions.work", kind: "function" },
      ],
      omitted: 0,
    },
  });
});

test("options are closed and accessors or signal lookalikes fail before work", async () => {
  const accessor = vi.fn(() => AbortSignal.abort());
  for (const options of [
    {
      get signal() {
        return accessor();
      },
    },
    { signal: Object.create(AbortSignal.prototype) },
    { signal: {} },
    { context: Context.empty() },
    { scheduler: new Scheduler.MixedScheduler() },
    { onFiberStart: vi.fn() },
    { preventYield: true },
    { maxOpsBeforeYield: 1 },
    { [Symbol("hook")]: vi.fn() },
    Object.create({ signal: AbortSignal.abort() }),
    null,
  ]) {
    const result = await SemaphoreExecution.run(completed, options as SemaphoreExecutionOptions);
    expect(result.logs).toEqual([]);
    expect(result.exit).toMatchObject({
      cause: { reasons: [{ error: { diagnostics: [{ code: "SEMAPHORE_EXECUTION_CONTEXT" }] } }] },
    });
  }
  expect(accessor).not.toHaveBeenCalled();
  const optionShape = (options: SemaphoreExecutionOptions) => options;
  // @ts-expect-error host contexts cannot be injected
  optionShape({ context: Context.empty() });
});

test("builtin lookalikes, escaped handles and mixed Deferred are refused without executing callbacks", async () => {
  const callback = vi.fn(() => true);
  const alias = Operation.make(EqU64.ref, [R.U64, R.U64], R.Bool, callback);
  const custom = R.fn([], R.Bool, R.Never, () =>
    S.make(1).pipe(
      R.Effect.flatMap((owner) =>
        S.withPermit(owner)(
          R.Effect.succeed(Expr.apply(alias, R.U64.literal(1n), R.U64.literal(1n))),
        ),
      ),
    ),
  );
  expect((await SemaphoreExecution.run(custom)).exit).toMatchObject({
    cause: {
      reasons: [
        {
          error: {
            diagnostics: [{ code: "SEMAPHORE_EXECUTION_CONTEXT", path: "function.reference" }],
          },
        },
      ],
    },
  });
  expect(callback).not.toHaveBeenCalled();
  const escaped = R.fn([], SemaphoreType, R.Never, () => S.make(1));
  const mixed = R.fn([], R.Unit, R.Never, () =>
    S.make(1).pipe(
      R.Effect.flatMap((owner) =>
        S.withPermit(owner)(
          D.make(R.Unit).pipe(
            R.Effect.flatMap((cell) =>
              D.succeed(cell, R.Unit.literal()).pipe(R.Effect.andThen(D.await(cell))),
            ),
          ),
        ),
      ),
    ),
  );
  for (const work of [escaped, mixed]) {
    const result = await SemaphoreExecution.run<unknown>(work);
    expect(result.logs).toEqual([]);
    expect(Exit.isFailure(result.exit)).toBe(true);
  }
  expect(Exit.isFailure((await DeferredExecution.run(completed)).exit)).toBe(true);
});

test("owned scheduler and logger exclude ambient host services and retain automatic yielding", async () => {
  const hostLog = vi.fn();
  const sleep = vi.fn(() => Effect.die("ambient clock leaked"));
  const traced = new Set<number>();
  const tracer: Tracer.Tracer = {
    span: (options) => Tracer.nativeTracer.span(options),
    context: (primitive, fiber) => {
      traced.add(fiber.id);
      return primitive["~effect/Effect/evaluate"](fiber);
    },
  };
  const clock: Clock.Clock = Object.assign(
    Object.create(Context.get(Context.empty(), Clock.Clock)),
    { sleep },
  );
  const host = Context.empty().pipe(
    Context.add(Clock.Clock, clock),
    Context.add(Tracer.Tracer, tracer),
    Context.add(Logger.CurrentLoggers, new Set([Logger.make(hostLog)])),
    Context.add(Scheduler.MaxOpsBeforeYield, 1),
    Context.add(Scheduler.PreventSchedulerYield, true),
  );
  const work = R.fn([], R.Unit, R.Never, () =>
    S.make(1).pipe(
      R.Effect.flatMap((owner) =>
        S.withPermit(owner)(R.Log.info("owned").pipe(R.Effect.andThen(R.Effect.sleep(1)))),
      ),
    ),
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
      Effect.promise(() => SemaphoreExecution.run(work)),
    );
    expect(result.exit).toEqual(Exit.succeed(undefined));
    expect(result.logs).toEqual(["owned"]);
    expect(counts.length).toBeGreaterThan(0);
    expect(Math.max(...counts)).toBeLessThan(2048);
    expect(traced.size).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(hostLog).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

test("the owned boundary refuses work beyond the framed receipt before starting", async () => {
  const work = R.fn([], R.Unit, R.Never, () =>
    S.make(1).pipe(
      R.Effect.flatMap((owner) => {
        let prefix = R.Log.info("unopened");
        let suffix = R.Effect.void;
        for (let i = 0; i < 40; i++) {
          prefix = prefix.pipe(R.Effect.map((value) => value));
          suffix = suffix.pipe(R.Effect.map((value) => value));
        }
        return S.withPermit(owner)(prefix.pipe(R.Effect.andThen(suffix)));
      }),
    ),
  );
  for (const run of [SemaphoreExecution.run, SemaphoreExecution.runWithFrames]) {
    const result = await run(work);
    expect(result.logs).toEqual([]);
    const exit: Exit.Exit<unknown, unknown> = result.exit;
    expect(Exit.isFailure(exit)).toBe(true);
    expect(result.exit).toMatchObject({
      cause: {
        reasons: [
          {
            error: {
              diagnostics: [expect.objectContaining({ code: "SEMAPHORE_BUDGET_EXCEEDED" })],
            },
          },
        ],
      },
    });
  }
});

test("public execution bounds deep authored graphs before recursive builtin auditing", async () => {
  const work = R.fn([], R.Unit, R.Never, () =>
    R.Semaphore.make(1).pipe(
      R.Effect.flatMap((owner) => {
        let body = R.Log.info("unopened");
        for (let i = 0; i < 10000; i++) body = body.pipe(R.Effect.ensuring(R.Effect.void));
        return R.Semaphore.withPermit(owner)(body);
      }),
    ),
  );
  for (const run of [SemaphoreExecution.run, SemaphoreExecution.runWithFrames]) {
    const result = await run(work);
    expect(result.logs).toEqual([]);
    expect(result.exit).toMatchObject({
      cause: {
        reasons: [
          {
            error: {
              diagnostics: [expect.objectContaining({ code: "SEMAPHORE_STRUCTURAL_GROWTH" })],
            },
          },
        ],
      },
    });
  }
});
