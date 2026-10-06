import { Cause, Clock, Context, Effect, Exit, Fiber, Logger, Scheduler, Tracer } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { R } from "../src/index.ts";
import { LatchIR as L } from "../src/latch.ts";
import { LatchType } from "../src/latch-model.ts";
import { LatchExecution } from "../src/latch-execution.ts";
import type { LatchExecutionOptions } from "../src/latch-execution.ts";
import { DeferredIR as D } from "../src/deferred.ts";
import type { FramedExit } from "../src/effect-ir.ts";
import { CompileError, EqU64, Expr, Operation } from "../src/kernel.ts";

const diagnostics = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  return Exit.isFailure(exit)
    ? exit.cause.reasons.flatMap((reason) =>
        Cause.isFailReason(reason) && reason.error instanceof CompileError
          ? reason.error.diagnostics
          : [],
      )
    : [];
};
const completed = R.fn([], R.U64, R.Never, () =>
  L.make(true).pipe(
    R.Effect.flatMap((owner) =>
      L.whenOpen(
        owner,
        R.Log.info("entered").pipe(R.Effect.andThen(R.Effect.succeed(R.U64.literal(7n)))),
      ),
    ),
  ),
);
const blocked = R.fn([], R.Unit, R.Never, () => L.make().pipe(R.Effect.flatMap(L.await)));
const held = R.fn([], R.Unit, R.Never, () =>
  L.make().pipe(
    R.Effect.flatMap((owner) =>
      R.Log.info("held").pipe(
        R.Effect.andThen(L.await(owner)),
        R.Effect.ensuring(
          R.Log.info("cleanup:start").pipe(
            R.Effect.andThen(R.Effect.sleep(1)),
            R.Effect.andThen(L.release(owner)),
            R.Effect.andThen(R.Log.info("cleanup:done")),
          ),
        ),
      ),
    ),
  ),
);

test("owned Latch preserves state-transition results, scalar captures, immutable logs and fresh owners", async () => {
  for (const initial of [false, true]) {
    for (const [operation, expected] of [
      [L.isOpen, initial],
      [L.open, !initial],
      [L.close, initial],
      [L.release, !initial],
    ] as const) {
      const work = R.fn([], R.Bool, R.Never, () =>
        L.make(initial).pipe(R.Effect.flatMap(operation)),
      );
      expect((await LatchExecution.run(work)).exit).toEqual(Exit.succeed(expected));
    }
  }
  const result = await LatchExecution.run(completed);
  expect(result.exit).toEqual(Exit.succeed(7n));
  expect(result.logs).toEqual(["entered"]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.logs)).toBe(true);
  const framed = await LatchExecution.runWithFrames(completed);
  expect(framed.exit).toMatchObject({ value: { exit: Exit.succeed(7n), frames: [], omitted: 0 } });
  expect(framed.logs).toEqual(result.logs);
  const controllers = [new AbortController(), new AbortController()];
  const active = controllers.map((controller) =>
    LatchExecution.run(held, { signal: controller.signal }),
  );
  for (const controller of controllers) controller.abort();
  for (const result of await Promise.all(active))
    expect(result.logs).toEqual(["held", "cleanup:start", "cleanup:done"]);
});

test("owned cohorts preserve detached callbacks and callback-created registrations", async () => {
  const work = R.fn([], R.Unit, R.Never, () =>
    L.make().pipe(
      R.Effect.flatMap((owner) =>
        R.Effect.all(
          [
            L.await(owner).pipe(
              R.Effect.andThen(R.Log.info("old:first")),
              R.Effect.andThen(L.release(owner)),
              R.Effect.andThen(L.await(owner)),
              R.Effect.andThen(R.Log.info("new:first")),
            ),
            L.await(owner).pipe(R.Effect.andThen(R.Log.info("old:second"))),
            L.release(owner).pipe(
              R.Effect.andThen(L.await(owner)),
              R.Effect.andThen(R.Log.info("new:producer")),
              R.Effect.andThen(L.open(owner)),
              R.Effect.asVoid,
            ),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      ),
    ),
  );
  for (const run of [LatchExecution.run, LatchExecution.runWithFrames]) {
    const result = await run(work);
    expect(result.logs).toEqual(["old:first", "old:second", "new:producer", "new:first"]);
    const exit: Exit.Exit<unknown, unknown> = result.exit;
    expect(Exit.isSuccess(exit)).toBe(true);
  }
});

test("pre-aborted calls remain unopened; suspended Await retains root frames and interruption awaits masked cleanup", async () => {
  for (const run of [LatchExecution.run, LatchExecution.runWithFrames]) {
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
    const inner = Exit.isSuccess(outer) ? (outer.value as FramedExit<void, never>).exit : outer;
    expect(Exit.isFailure(inner) && Cause.hasInterruptsOnly(inner.cause)).toBe(true);
  }
  const controller = new AbortController();
  const active = LatchExecution.runWithFrames(blocked, { signal: controller.signal });
  controller.abort();
  expect((await active).exit).toMatchObject({
    value: {
      frames: [
        { path: "functions.work.body.body", kind: "latchAwait" },
        { path: "functions.work.body", kind: "latchScope" },
        { path: "functions.work", kind: "function" },
      ],
      omitted: 0,
    },
  });
});

test("All discards child interruption trails after awaited cleanup and cannot run granted bodies during cancellation", async () => {
  const work = R.fn([], R.Unit, R.Never, () =>
    L.make().pipe(
      R.Effect.flatMap((owner) =>
        R.Effect.all(
          [
            L.await(owner).pipe(
              R.Effect.andThen(R.Log.info("must-not-run:first")),
              R.Effect.ensuring(
                R.Log.info("cleanup:first:start").pipe(
                  R.Effect.andThen(R.Effect.sleep(1)),
                  R.Effect.andThen(L.release(owner)),
                  R.Effect.andThen(R.Log.info("cleanup:first:done")),
                ),
              ),
            ),
            L.await(owner).pipe(
              R.Effect.andThen(R.Log.info("must-not-run:second")),
              R.Effect.ensuring(
                R.Log.info("cleanup:second:start").pipe(
                  R.Effect.andThen(R.Effect.sleep(1)),
                  R.Effect.andThen(R.Log.info("cleanup:second:done")),
                ),
              ),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      ),
    ),
  );
  const controller = new AbortController();
  const active = LatchExecution.runWithFrames(work, { signal: controller.signal });
  controller.abort();
  const result = await active;
  expect(result.logs).toEqual([
    "cleanup:first:start",
    "cleanup:second:start",
    "cleanup:first:done",
    "cleanup:second:done",
  ]);
  expect(result.exit).toMatchObject({
    value: {
      frames: [
        { path: "functions.work.body.body", kind: "all" },
        { path: "functions.work.body", kind: "latchScope" },
        { path: "functions.work", kind: "function" },
      ],
      omitted: 0,
    },
  });
});

test("closed options, getters, unknown hooks and forged signals are refused before authored work", async () => {
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
    for (const run of [LatchExecution.run, LatchExecution.runWithFrames]) {
      const result = await run(completed, options as LatchExecutionOptions);
      expect(result.logs).toEqual([]);
      expect(diagnostics(result.exit)).toEqual([
        expect.objectContaining({ code: "LATCH_EXECUTION_CONTEXT" }),
      ]);
    }
  }
  expect(accessor).not.toHaveBeenCalled();
  const optionShape = (options: LatchExecutionOptions) => options;
  // @ts-expect-error Host contexts cannot be injected.
  optionShape({ context: Context.empty() });
});

test("forged builtins, escaped handles, mixed owners and ordinary functions refuse before callbacks or logs", async () => {
  const callback = vi.fn(() => true);
  const alias = Operation.make(EqU64.ref, [R.U64, R.U64], R.Bool, callback);
  const custom = R.fn([], R.Bool, R.Never, () =>
    L.make(true).pipe(
      R.Effect.flatMap((owner) =>
        L.whenOpen(
          owner,
          R.Effect.succeed(Expr.apply(alias, R.U64.literal(1n), R.U64.literal(1n))),
        ),
      ),
    ),
  );
  expect(diagnostics((await LatchExecution.run(custom)).exit)).toEqual([
    expect.objectContaining({ code: "LATCH_REFERENCE_CONTEXT", path: "function.reference" }),
  ]);
  expect(callback).not.toHaveBeenCalled();
  const escaped = R.fn([], LatchType, R.Never, () => L.make());
  const mixed = R.fn([], R.Unit, R.Never, () =>
    L.make().pipe(
      R.Effect.flatMap(() =>
        D.make(R.Unit).pipe(
          R.Effect.flatMap((cell) =>
            D.succeed(cell, R.Unit.literal()).pipe(R.Effect.andThen(D.await(cell))),
          ),
        ),
      ),
    ),
  );
  const ordinary = R.fn([], R.Unit, R.Never, () => R.Log.info("unopened"));
  for (const work of [escaped, mixed, ordinary]) {
    const result = await LatchExecution.run<unknown>(work);
    expect(result.logs).toEqual([]);
    expect(Exit.isFailure(result.exit)).toBe(true);
  }
});

test("owned scheduler excludes ambient clock, tracer and logger and retains default automatic yielding", async () => {
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
    L.make(true).pipe(
      R.Effect.flatMap((owner) =>
        L.whenOpen(owner, R.Log.info("owned").pipe(R.Effect.andThen(R.Effect.sleep(1)))),
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
      Effect.promise(() => LatchExecution.run(work)),
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

test("deep authored graphs are bounded before recursive builtin auditing or evaluation", async () => {
  const work = R.fn([], R.Unit, R.Never, () =>
    L.make().pipe(
      R.Effect.flatMap(() => {
        let body = R.Log.info("unopened");
        for (let i = 0; i < 10000; i++) body = body.pipe(R.Effect.ensuring(R.Effect.void));
        return body;
      }),
    ),
  );
  for (const run of [LatchExecution.run, LatchExecution.runWithFrames]) {
    const result = await run(work);
    expect(result.logs).toEqual([]);
    expect(diagnostics(result.exit)).toEqual([
      expect.objectContaining({ code: "LATCH_GENERATED_GROWTH" }),
    ]);
  }
});

test("owned execution refuses a whole-invocation framed receipt at the threshold before authored logs", async () => {
  const work = R.fn([], R.Unit, R.Never, () =>
    L.make().pipe(
      R.Effect.flatMap(() => {
        let prefix = R.Log.info("unopened");
        let suffix = R.Effect.void;
        for (let i = 0; i < 40; i++) {
          prefix = prefix.pipe(R.Effect.map((value) => value));
          suffix = suffix.pipe(R.Effect.map((value) => value));
        }
        return prefix.pipe(R.Effect.andThen(suffix));
      }),
    ),
  );
  for (const run of [LatchExecution.run, LatchExecution.runWithFrames]) {
    const result = await run(work);
    expect(result.logs).toEqual([]);
    expect(diagnostics(result.exit)).toEqual([
      expect.objectContaining({ code: "LATCH_BUDGET_EXCEEDED" }),
    ]);
  }
});
