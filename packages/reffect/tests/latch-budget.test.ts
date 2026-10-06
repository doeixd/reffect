import { Effect, Fiber, Scheduler } from "effect";
import { expect, test } from "vite-plus/test";
import { R } from "../src/authoring.ts";
import { Computation, EffectReference as Reference, matchComputation } from "../src/effect-ir.ts";
import { LatchIR as L } from "../src/latch.ts";
import { SemaphoreIR as S } from "../src/semaphore.ts";
import { analyzeLatchBudget, latchBudgetLimit } from "../src/latch-budget.ts";
import { defaultDeferredBudgetContext } from "../src/deferred-budget.ts";

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
const unit = () => R.Effect.succeed(R.Unit.literal());
const sequence = (items: readonly Computation<void>[]): Computation<void> => {
  if (items.length === 1) return items[0];
  const split = Math.floor(items.length / 2);
  return R.Effect.andThen(sequence(items.slice(0, split)), sequence(items.slice(split)));
};
const transitions = (count: number) =>
  R.fn([], R.Unit, R.Never, () =>
    L.make().pipe(
      R.Effect.flatMap((owner) => {
        const shared = L.release(owner).pipe(R.Effect.asVoid);
        return sequence(Array.from({ length: count }, () => shared));
      }),
    ),
  );

test("audited leaf, owner and observer receipts stay distinct", () => {
  const signal = R.fn([], R.Bool, R.Never, () =>
    L.make().pipe(R.Effect.flatMap((owner) => L.open(owner))),
  );
  expect(analyzeLatchBudget(signal)).toMatchObject({ admitted: true, plain: 31, framed: 73 });
  const awaited = R.fn([], R.Unit, R.Never, () =>
    L.make(true).pipe(R.Effect.flatMap((owner) => L.await(owner))),
  );
  expect(analyzeLatchBudget(awaited)).toMatchObject({ admitted: true, plain: 39, framed: 81 });
  expect(analyzeLatchBudget(awaited, "body", defaultDeferredBudgetContext, false)).toMatchObject({
    plain: 39,
    framed: 41,
  });
});

test("executed branch maxima count every shared incoming edge without charging unused alternatives", () => {
  const make = (branch: boolean) =>
    R.fn([], R.Unit, R.Never, () =>
      L.make().pipe(
        R.Effect.flatMap((owner) => {
          const shared = L.release(owner).pipe(R.Effect.asVoid);
          const longer = sequence([shared, shared, shared, shared]);
          return branch ? matchComputation(R.Bool.literal(true), shared, longer) : longer;
        }),
      ),
    );
  const longer = analyzeLatchBudget(make(false));
  const branch = analyzeLatchBudget(make(true));
  expect(branch.plain).toBe(longer.plain + 4);
  expect(branch.framed).toBe(longer.framed + 28);
  expect(longer.plain).toBeGreaterThan(analyzeLatchBudget(transitions(1)).plain);
  expect(Object.isFrozen(branch)).toBe(true);
  expect(Object.isFrozen(branch.diagnostics)).toBe(true);
});

test("strict threshold refuses the first saturated receipt and admitted reference turns do not yield", async () => {
  let accepted = transitions(1);
  let refused = transitions(1);
  for (let count = 2; count < 128; count++) {
    const candidate = transitions(count);
    if (!analyzeLatchBudget(candidate).admitted) {
      refused = candidate;
      break;
    }
    accepted = candidate;
  }
  const receipt = analyzeLatchBudget(accepted);
  expect(receipt.admitted).toBe(true);
  expect(receipt.framed).toBeLessThan(latchBudgetLimit);
  expect(analyzeLatchBudget(refused)).toMatchObject({
    admitted: false,
    framed: latchBudgetLimit,
    diagnostics: [{ code: "LATCH_BUDGET_EXCEEDED" }],
  });
  for (const [effect, bound] of [
    [Reference.run(accepted, []), receipt.plain],
    [Reference.runWithFrames(accepted, []), receipt.framed],
  ] as const) {
    const scheduler = new Probe();
    await Effect.runPromise(Effect.exit(effect), { scheduler });
    expect(scheduler.maximum).toBeLessThanOrEqual(bound);
    expect(scheduler.yields).toBe(0);
  }
});

test("long state-transition chains actually trigger automatic yielding in both reference modes", async () => {
  const source = transitions(1024);
  expect(analyzeLatchBudget(source)).toMatchObject({
    admitted: false,
    plain: latchBudgetLimit,
    framed: latchBudgetLimit,
  });
  for (const effect of [Reference.run(source, []), Reference.runWithFrames(source, [])]) {
    const scheduler = new Probe();
    await Effect.runPromise(Effect.exit(effect), { scheduler });
    expect(scheduler.yields).toBeGreaterThan(0);
    expect(scheduler.maximum).toBeGreaterThanOrEqual(latchBudgetLimit);
  }
});

test("All children and masked asynchronous cleanup omit the root interruption observer", async () => {
  const source = R.fn([], R.Unit, R.Never, () =>
    L.make().pipe(
      R.Effect.flatMap((owner) =>
        R.Effect.all(
          [
            L.await(owner).pipe(
              R.Effect.ensuring(
                R.Effect.sleep(1).pipe(R.Effect.andThen(L.release(owner)), R.Effect.asVoid),
              ),
            ),
            R.Effect.sleep(50),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      ),
    ),
  );
  const observed = analyzeLatchBudget(source);
  const unobserved = analyzeLatchBudget(source, "body", defaultDeferredBudgetContext, false);
  expect(observed.admitted).toBe(true);
  expect(observed.plain).toBe(unobserved.plain);
  expect(observed.framed - unobserved.framed).toBe(40);
  for (const [effect, bound] of [
    [Reference.run(source, []), observed.plain],
    [Reference.runWithFrames(source, []), observed.framed],
  ] as const) {
    const scheduler = new Probe();
    const fiber = Effect.runFork(Effect.exit(effect), { scheduler });
    expect(fiber.pollUnsafe()).toBeUndefined();
    fiber.interruptUnsafe();
    await Effect.runPromise(Fiber.await(fiber));
    expect(scheduler.maximum).toBeLessThanOrEqual(bound);
    expect(scheduler.yields).toBe(0);
  }
});

test("conditional analysis fails closed on cycles, inputs, unknown context and unaudited operations", () => {
  for (const key of Object.keys(
    defaultDeferredBudgetContext,
  ) as (keyof typeof defaultDeferredBudgetContext)[]) {
    expect(
      analyzeLatchBudget(transitions(1), "body", {
        ...defaultDeferredBudgetContext,
        [key]: "custom",
      }),
    ).toMatchObject({ admitted: false, diagnostics: [{ code: "LATCH_BUDGET_CONTEXT" }] });
  }
  expect(analyzeLatchBudget(R.fn([R.Bool], R.Unit, R.Never, () => unit()))).toMatchObject({
    admitted: false,
    plain: 2048,
    diagnostics: [{ code: "LATCH_BUDGET_INPUT" }],
  });
  const cyclic: Computation<void> = Computation.make(R.Unit, R.Never, {
    _tag: "Ensuring",
    get body() {
      return cyclic;
    },
    finalizer: unit(),
  });
  expect(analyzeLatchBudget(R.fn([], R.Unit, R.Never, () => cyclic))).toMatchObject({
    admitted: false,
    diagnostics: [{ code: "LATCH_BUDGET_CYCLE" }],
  });
  for (const body of [
    R.Log.info("attributes", [["value", R.U64.literal(1n)]]),
    R.Effect.scoped(unit()),
    S.make(1).pipe(R.Effect.flatMap((owner) => S.withPermit(owner)(unit()))),
  ]) {
    expect(analyzeLatchBudget(R.fn([], R.Unit, R.Never, () => body))).toMatchObject({
      admitted: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "LATCH_BUDGET_UNACCOUNTED" }),
      ]),
    });
  }
  expect(
    analyzeLatchBudget(
      R.fn([], R.Unit, R.Never, () =>
        Computation.make(R.Unit, R.Never, { _tag: "Sleep", milliseconds: 2147483648 }),
      ),
    ),
  ).toMatchObject({ admitted: false, diagnostics: [{ code: "LATCH_BUDGET_TIMER" }] });
});
