import { Effect, Fiber, Scheduler } from "effect";
import { expect, test } from "vite-plus/test";
import { R } from "../src/authoring.ts";
import { Computation, EffectReference as Reference, matchComputation } from "../src/effect-ir.ts";
import { defaultDeferredBudgetContext } from "../src/deferred-budget.ts";
import { analyzeSemaphoreBudget, semaphoreBudgetLimit } from "../src/semaphore-budget.ts";
import { SemaphoreIR as S } from "../src/semaphore.ts";

const unit = () => R.Effect.succeed(R.Unit.literal());
const sequence = (items: readonly Computation<void>[]): Computation<void> => {
  if (items.length === 1) return items[0];
  const split = Math.floor(items.length / 2);
  return R.Effect.andThen(sequence(items.slice(0, split)), sequence(items.slice(split)));
};
const guards = (count: number) =>
  R.fn([], R.Unit, R.Never, () =>
    S.make(1).pipe(
      R.Effect.flatMap((owner) => {
        const shared = S.withPermit(owner)(unit());
        return sequence(Array.from({ length: count }, () => shared));
      }),
    ),
  );
class Probe extends Scheduler.MixedScheduler {
  maximum = 0;
  yields = 0;
  override shouldYield(fiber: Fiber.Fiber<unknown, unknown>): boolean {
    this.maximum = Math.max(this.maximum, fiber.currentOpCount);
    const decision = super.shouldYield(fiber);
    if (decision) this.yields++;
    return decision;
  }
}

test("shared occurrences and selected branch maxima retain finite driver limits", () => {
  const shared = analyzeSemaphoreBudget(guards(4));
  const branch = R.fn([], R.Unit, R.Never, () =>
    S.make(1).pipe(
      R.Effect.flatMap((owner) => {
        const guard = S.withPermit(owner)(unit());
        return matchComputation(
          R.Bool.literal(true),
          guard,
          sequence([guard, guard, guard, guard]),
        );
      }),
    ),
  );
  const receipt = analyzeSemaphoreBudget(branch);
  expect(receipt.admitted).toBe(true);
  expect(receipt.bounds).toEqual(shared.bounds);
  expect(receipt.plain).toBeGreaterThan(shared.plain);
  expect(receipt.framed).toBeGreaterThan(shared.framed);
  expect(shared.bounds).toMatchObject({ retry: 1, scans: 5, callbacks: 8, settlement: 3 });
  expect(Object.isFrozen(shared)).toBe(true);
  expect(Object.isFrozen(shared.bounds)).toBe(true);
  expect(analyzeSemaphoreBudget(guards(8)).framed).toBeGreaterThan(shared.framed);
});

test("the finite receipt refuses the threshold while measured admitted turns never yield", async () => {
  let accepted = guards(1);
  let refused = guards(1);
  for (let count = 2; count < 64; count++) {
    const candidate = guards(count);
    if (!analyzeSemaphoreBudget(candidate).admitted) {
      refused = candidate;
      break;
    }
    accepted = candidate;
  }
  const bound = analyzeSemaphoreBudget(accepted);
  expect(bound.admitted).toBe(true);
  expect(bound.framed).toBeLessThan(semaphoreBudgetLimit);
  expect(analyzeSemaphoreBudget(refused)).toMatchObject({
    admitted: false,
    framed: semaphoreBudgetLimit,
    bounds: undefined,
    diagnostics: [{ code: "SEMAPHORE_BUDGET_EXCEEDED" }],
  });
  for (const effect of [Reference.run(accepted, []), Reference.runWithFrames(accepted, [])]) {
    const scheduler = new Probe();
    await Effect.runPromise(Effect.exit(effect), { scheduler });
    expect(scheduler.maximum).toBeLessThanOrEqual(bound.framed);
    expect(scheduler.yields).toBe(0);
  }
});

test("All cancellation and asynchronous masked cleanup stay below both receipts", async () => {
  const program = R.fn([], R.Unit, R.Never, () =>
    S.make(1).pipe(
      R.Effect.flatMap((owner) => {
        const child = S.withPermit(owner)(
          R.Effect.sleep(50).pipe(R.Effect.ensuring(R.Effect.sleep(1))),
        );
        return R.Effect.all([child, child, child], { concurrency: "unbounded", discard: true });
      }),
    ),
  );
  const observed = analyzeSemaphoreBudget(program);
  const unobserved = analyzeSemaphoreBudget(program, "body", defaultDeferredBudgetContext, false);
  expect(observed.admitted).toBe(true);
  expect(observed.plain).toBe(unobserved.plain);
  expect(observed.framed).toBeGreaterThan(unobserved.framed);
  expect(observed.bounds).toMatchObject({ callbacks: 12, scans: 4 });
  for (const [effect, bound] of [
    [Reference.run(program, []), observed.plain],
    [Reference.runWithFrames(program, []), observed.framed],
  ] as const) {
    const scheduler = new Probe();
    const fiber = Effect.runFork(Effect.exit(effect), { scheduler });
    expect(fiber.pollUnsafe()).toBeUndefined();
    fiber.interruptUnsafe();
    await Effect.runPromise(Fiber.await(fiber));
    expect(scheduler.maximum).toBeLessThanOrEqual(bound);
    expect(scheduler.yields).toBe(0);
    // Successful completion resumes contending callbacks through successive scans.
    const completed = new Probe();
    await Effect.runPromise(Effect.exit(effect), { scheduler: completed });
    expect(completed.maximum).toBeLessThanOrEqual(bound);
    expect(completed.yields).toBe(0);
  }
});

test("context, attributed logs, timer overflow and mixed ownership fail closed", () => {
  expect(
    analyzeSemaphoreBudget(guards(1), "body", {
      ...defaultDeferredBudgetContext,
      scheduler: "custom",
    }),
  ).toMatchObject({
    admitted: false,
    bounds: undefined,
    diagnostics: [{ code: "SEMAPHORE_BUDGET_CONTEXT" }],
  });
  const lexical = (body: Computation<void>) =>
    R.fn([], R.Unit, R.Never, () => S.make(1).pipe(R.Effect.flatMap(() => body)));
  expect(
    analyzeSemaphoreBudget(
      lexical(Computation.make(R.Unit, R.Never, { _tag: "Sleep", milliseconds: 2147483648 })),
    ),
  ).toMatchObject({ admitted: false, bounds: undefined });
  expect(
    analyzeSemaphoreBudget(lexical(R.Log.info("attributes", [["value", R.U64.literal(1n)]]))),
  ).toMatchObject({ admitted: false, diagnostics: [{ code: "SEMAPHORE_BUDGET_UNACCOUNTED" }] });
  expect(analyzeSemaphoreBudget(lexical(R.Effect.scoped(unit())))).toMatchObject({
    admitted: false,
    bounds: undefined,
  });
  expect(analyzeSemaphoreBudget(guards(256))).toMatchObject({
    admitted: false,
    plain: 2048,
    bounds: undefined,
  });
  expect(analyzeSemaphoreBudget(R.fn([], R.Unit, R.Never, unit))).toMatchObject({
    admitted: false,
    plain: 2048,
    framed: 2048,
    bounds: undefined,
  });
});
