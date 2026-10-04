import { Effect, Fiber, Scheduler } from "effect";
import { expect, test } from "vite-plus/test";
import { R, Reference } from "../src/index.ts";
import { Computation, matchComputation } from "../src/effect-ir.ts";
import { analyzeDeferredBudget, deferredBudgetLimit } from "../src/deferred-budget.ts";

class BudgetProbe extends Scheduler.MixedScheduler {
  maximum = 0;
  automaticYields = 0;
  override shouldYield(fiber: Fiber.Fiber<unknown, unknown>): boolean {
    this.maximum = Math.max(this.maximum, fiber.currentOpCount);
    const decision = super.shouldYield(fiber);
    if (decision) this.automaticYields += 1;
    return decision;
  }
}
const unit = () => R.Effect.succeed(R.Unit.literal());
const maps = (count: number) => {
  let body = unit();
  for (let i = 0; i < count; i++) body = R.Effect.map(body, (value) => value);
  return body;
};
const fn = (body: Computation<void, never>) => R.fn([], R.Unit, R.Never, () => body);
const observe = async (effect: Effect.Effect<unknown, unknown>) => {
  const scheduler = new BudgetProbe();
  await Effect.runPromise(Effect.exit(effect), { scheduler });
  return scheduler;
};

test("occurrence summaries count sharing, alternatives and cleanup without exponential traversal", () => {
  const shared = maps(4);
  const sequential = R.Effect.flatMap(shared, () => shared);
  expect(analyzeDeferredBudget(fn(sequential))).toMatchObject({ plain: 92, framed: 104 });
  const alternative = matchComputation(R.Bool.literal(true), shared, unit());
  expect(analyzeDeferredBudget(fn(alternative))).toMatchObject({ plain: 61, framed: 69 });
  expect(analyzeDeferredBudget(fn(R.Effect.ensuring(shared, unit())))).toMatchObject({
    plain: 74,
    framed: 80,
  });
  let doubled = unit();
  for (let i = 0; i < 50; i++) {
    const previous = doubled;
    doubled = R.Effect.flatMap(previous, () => previous);
  }
  expect(analyzeDeferredBudget(fn(doubled))).toMatchObject({
    plain: 2048,
    framed: 2048,
    admitted: false,
    diagnostics: [{ code: "DEFERRED_BUDGET_EXCEEDED" }],
  });
});

test("unaccounted operations, Schema entry and oversized default timers fail closed", () => {
  expect(
    analyzeDeferredBudget(R.fn([R.U64], R.U64, R.Never, (value) => R.Effect.succeed(value))),
  ).toMatchObject({ admitted: false, diagnostics: [{ code: "DEFERRED_BUDGET_INPUT" }] });
  expect(analyzeDeferredBudget(fn(R.Effect.scoped(unit())))).toMatchObject({
    admitted: false,
    diagnostics: [{ code: "DEFERRED_BUDGET_UNACCOUNTED", path: "body" }],
  });
  expect(
    analyzeDeferredBudget(
      fn(Computation.make(R.Unit, R.Never, { _tag: "Sleep", milliseconds: 2147483648 })),
    ),
  ).toMatchObject({
    admitted: false,
    diagnostics: [{ code: "DEFERRED_BUDGET_TIMER" }],
  });
});

test("exact admission boundary stays below the real default scheduler threshold", async () => {
  const below = fn(R.Effect.catchAll(maps(251), () => unit()));
  const above = fn(maps(253));
  const admitted = analyzeDeferredBudget(below);
  expect(admitted.framed).toBe(deferredBudgetLimit - 1);
  expect(admitted.admitted).toBe(true);
  expect(analyzeDeferredBudget(above)).toMatchObject({
    framed: deferredBudgetLimit,
    admitted: false,
  });
  for (const effect of [Reference.run(below, []), Reference.runWithFrames(below, [])]) {
    const observed = await observe(effect);
    expect(observed.maximum).toBeLessThan(deferredBudgetLimit);
    expect(observed.automaticYields).toBe(0);
  }
  const actualYield = fn(maps(512));
  for (const effect of [Reference.run(actualYield, []), Reference.runWithFrames(actualYield, [])]) {
    const observed = await observe(effect);
    expect(observed.maximum).toBeGreaterThanOrEqual(deferredBudgetLimit);
    expect(observed.automaticYields).toBeGreaterThan(0);
  }
});

test("public scheduler observations stay under receipts across failure, cleanup and child cancellation", async () => {
  let ensured = unit();
  for (let i = 0; i < 32; i++) ensured = R.Effect.ensuring(ensured, unit());
  const recovered = R.Effect.fail(R.U64.literal(7n)).pipe(R.Effect.catchAll(() => ensured));
  const loser = R.Effect.sleep(20).pipe(R.Effect.ensuring(unit()));
  const racing = R.Effect.race(loser, unit());
  const all = R.Effect.all([unit(), R.Effect.sleep(1)], {
    concurrency: "unbounded",
    discard: true,
  });
  const failing = R.Effect.all([loser, R.Effect.fail(R.U64.literal(7n))], {
    concurrency: "unbounded",
    discard: true,
  });
  let failedCleanup = R.Effect.fail(R.U64.literal(7n));
  for (let i = 0; i < 32; i++) failedCleanup = R.Effect.ensuring(failedCleanup, unit());
  const programs = [
    fn(unit()),
    fn(maps(64)),
    fn(ensured),
    fn(recovered),
    fn(racing),
    fn(all),
    R.fn([], R.Unit, R.U64, () => failing),
    R.fn([], R.Never, R.U64, () => failedCleanup),
    fn(R.Log.info("deferred budget audit")),
  ];
  for (const program of programs) {
    const bound = analyzeDeferredBudget(program);
    expect(bound.admitted).toBe(true);
    const plain = await observe(Reference.run(program, []));
    const framed = await observe(Reference.runWithFrames(program, []));
    expect(plain.maximum).toBeLessThanOrEqual(bound.plain);
    expect(framed.maximum).toBeLessThanOrEqual(bound.framed);
    expect(plain.automaticYields + framed.automaticYields).toBe(0);
  }
});

test("root and group parent interruption stay within both policy receipts", async () => {
  const pendingChild = R.Effect.sleep(50).pipe(R.Effect.ensuring(maps(16)));
  const programs = [
    fn(pendingChild),
    fn(R.Effect.all([pendingChild, pendingChild], { concurrency: "unbounded", discard: true })),
  ];
  for (const pending of programs) {
    const bound = analyzeDeferredBudget(pending);
    expect(bound.admitted).toBe(true);
    for (const [effect, maximum] of [
      [Reference.run(pending, []), bound.plain],
      [Reference.runWithFrames(pending, []), bound.framed],
    ] as const) {
      const scheduler = new BudgetProbe();
      // runForkWith eagerly evaluate()s before returning: both cleanups are installed.
      const fiber = Effect.runFork(Effect.exit(effect), { scheduler });
      expect(fiber.pollUnsafe()).toBeUndefined();
      fiber.interruptUnsafe();
      // This observer uses its own default scheduler; it is outside the measured graph.
      await Effect.runPromise(Fiber.await(fiber));
      expect(scheduler.maximum).toBeLessThanOrEqual(maximum);
      expect(scheduler.automaticYields).toBe(0);
    }
  }
});
