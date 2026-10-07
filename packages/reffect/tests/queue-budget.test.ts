import { Effect, Fiber, Scheduler } from "effect";
import { expect, test } from "vite-plus/test";
import { R } from "../src/authoring.ts";
import { Computation, EffectReference as Reference } from "../src/effect-ir.ts";
import type { Expr } from "../src/kernel.ts";
import { QueueIR as Q } from "../src/queue.ts";
import { analyzeQueueBudget, queueBudgetLimit } from "../src/queue-budget.ts";
import { defaultDeferredBudgetContext } from "../src/deferred-budget.ts";
import { analyzeGeneratedQueueProfile } from "../src/queue-generated-profile.ts";
import { analyzeGeneratedDeferredGrowth } from "../src/deferred-growth.ts";

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
const sequence = (items: readonly Computation<void>[]): Computation<void> => {
  if (items.length === 0) return R.Effect.void;
  if (items.length === 1) return items[0];
  const split = Math.floor(items.length / 2);
  return sequence(items.slice(0, split)).pipe(R.Effect.andThen(sequence(items.slice(split))));
};
const all = (a: Computation<void>, b: Computation<void>) =>
  R.Effect.all([a, b], { concurrency: "unbounded", discard: true });
const queued = (
  build: (owner: Expr<import("effect").Queue.Queue<bigint>>) => Computation<void>,
  capacity = 1,
) => R.fn([], R.Unit, R.Never, () => Q.bounded(R.U64, capacity).pipe(R.Effect.flatMap(build)));
const pressure = (count: number, capacity = 1) =>
  queued((owner) => {
    const offer = Q.offer(owner, R.U64.literal(1n)).pipe(R.Effect.asVoid);
    const take = Q.take(owner).pipe(R.Effect.asVoid);
    return all(
      sequence(Array.from({ length: count }, () => offer)),
      sequence(Array.from({ length: count }, () => take)),
    );
  }, capacity);

test("Queue receipts charge retries globally and framed All children retain decorations without observers", () => {
  const receipt = analyzeQueueBudget(pressure(1));
  expect(receipt).toMatchObject({ admitted: true, plain: 118, framed: 166, offers: 1, takes: 1 });
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(Object.isFrozen(receipt.diagnostics)).toBe(true);
  const bare = analyzeQueueBudget(pressure(1), "body", defaultDeferredBudgetContext, false);
  expect(bare).toMatchObject({ plain: 118, framed: 126 });
  const profile = analyzeGeneratedQueueProfile(R.program({ work: pressure(1) }));
  expect([...profile.values()][0].budget).toEqual(receipt);
});

test("shared incoming edges count fully and branch alternatives use independent maxima", () => {
  const repeated = analyzeQueueBudget(pressure(2));
  expect(repeated.offers).toBe(2);
  expect(repeated.takes).toBe(2);
  const branch = queued((owner) => {
    const offer = Q.offer(owner, R.U64.literal(1n)).pipe(R.Effect.asVoid);
    return all(R.Match.bool(R.Bool.literal(true), offer, sequence([offer, offer])), R.Effect.void);
  });
  const longer = queued((owner) => {
    const offer = Q.offer(owner, R.U64.literal(1n)).pipe(R.Effect.asVoid);
    return all(sequence([offer, offer]), R.Effect.void);
  });
  const a = analyzeQueueBudget(branch),
    b = analyzeQueueBudget(longer);
  expect(a.offers).toBe(2);
  expect(a.takes).toBe(0);
  expect(a.plain).toBe(b.plain + 4);
  expect(a.framed).toBe(b.framed + 8);
});

test("strict default threshold rejects a finite source that still passes growth", async () => {
  let accepted = pressure(1),
    refused = pressure(1);
  for (let count = 2; count < 64; count++) {
    const candidate = pressure(count);
    if (!analyzeQueueBudget(candidate).admitted) {
      refused = candidate;
      break;
    }
    accepted = candidate;
  }
  const bound = analyzeQueueBudget(accepted);
  expect(bound.admitted).toBe(true);
  expect(bound.framed).toBeLessThan(queueBudgetLimit);
  expect(analyzeQueueBudget(refused)).toMatchObject({
    admitted: false,
    framed: queueBudgetLimit,
    diagnostics: [{ code: "QUEUE_BUDGET_EXCEEDED" }],
  });
  expect(() => analyzeGeneratedDeferredGrowth(refused, "body", "Queue")).not.toThrow();
  expect(() => analyzeGeneratedQueueProfile(R.program({ work: refused }))).toThrow(
    /reference budget/,
  );
  for (const [effect, receipt] of [
    [Reference.run(accepted, []), bound.plain],
    [Reference.runWithFrames(accepted, []), bound.framed],
  ] as const) {
    const scheduler = new Probe();
    await Effect.runPromise(Effect.exit(effect), { scheduler });
    expect(scheduler.maximum).toBeLessThanOrEqual(receipt);
    expect(scheduler.yields).toBe(0);
  }
});

test("capacity pressure, barging and blocked parent cancellation remain below audited bounds", async () => {
  const barging = queued((owner) =>
    all(
      sequence([Q.take(owner).pipe(R.Effect.asVoid), Q.take(owner).pipe(R.Effect.asVoid)]),
      sequence([
        Q.offer(owner, R.U64.literal(1n)).pipe(R.Effect.asVoid),
        Q.take(owner).pipe(R.Effect.asVoid),
        Q.offer(owner, R.U64.literal(2n)).pipe(R.Effect.asVoid),
        Q.offer(owner, R.U64.literal(3n)).pipe(R.Effect.asVoid),
      ]),
    ),
  );
  const blockedTakes = queued((owner) =>
    all(Q.take(owner).pipe(R.Effect.asVoid), Q.take(owner).pipe(R.Effect.asVoid)),
  );
  const blockedOffer = queued((owner) =>
    all(
      sequence([
        Q.offer(owner, R.U64.literal(1n)).pipe(R.Effect.asVoid),
        Q.offer(owner, R.U64.literal(2n)).pipe(R.Effect.asVoid),
      ]),
      R.Effect.void,
    ),
  );
  for (const source of [
    pressure(4, 1),
    pressure(4, 2),
    pressure(4, 3),
    barging,
    blockedTakes,
    blockedOffer,
  ]) {
    const receipt = analyzeQueueBudget(source);
    expect(receipt.admitted).toBe(true);
    for (const [effect, bound] of [
      [Reference.run(source, []), receipt.plain],
      [Reference.runWithFrames(source, []), receipt.framed],
    ] as const) {
      const scheduler = new Probe();
      if (source === blockedTakes || source === blockedOffer) {
        const fiber = Effect.runFork(Effect.exit(effect), { scheduler });
        expect(fiber.pollUnsafe()).toBeUndefined();
        fiber.interruptUnsafe();
        await Effect.runPromise(Fiber.await(fiber));
      } else await Effect.runPromise(Effect.exit(effect), { scheduler });
      expect(scheduler.maximum).toBeLessThanOrEqual(bound);
      expect(scheduler.yields).toBe(0);
    }
  }
});

test("long Queue child computations actually trigger default automatic yielding", async () => {
  const source = queued(() =>
    all(sequence(Array.from({ length: 1024 }, () => R.Effect.void)), R.Effect.void),
  );
  expect(analyzeQueueBudget(source)).toMatchObject({
    admitted: false,
    plain: queueBudgetLimit,
    framed: queueBudgetLimit,
  });
  for (const effect of [Reference.run(source, []), Reference.runWithFrames(source, [])]) {
    const scheduler = new Probe();
    await Effect.runPromise(Effect.exit(effect), { scheduler });
    expect(scheduler.yields).toBeGreaterThan(0);
    expect(scheduler.maximum).toBeGreaterThanOrEqual(queueBudgetLimit);
  }
});

test("unaudited host assumptions, inputs, capacity, cycles and operations fail closed", () => {
  for (const key of Object.keys(
    defaultDeferredBudgetContext,
  ) as (keyof typeof defaultDeferredBudgetContext)[])
    expect(
      analyzeQueueBudget(pressure(1), "body", { ...defaultDeferredBudgetContext, [key]: "custom" }),
    ).toMatchObject({ admitted: false, diagnostics: [{ code: "QUEUE_BUDGET_CONTEXT" }] });
  expect(analyzeQueueBudget(R.fn([R.Bool], R.Unit, R.Never, () => R.Effect.void))).toMatchObject({
    admitted: false,
    diagnostics: [{ code: "QUEUE_BUDGET_INPUT" }],
  });
  const cyclic: Computation<void> = Computation.make(R.Unit, R.Never, {
    _tag: "FlatMap",
    binder: Symbol(),
    source: R.Effect.void,
    get body() {
      return cyclic;
    },
  });
  expect(analyzeQueueBudget(R.fn([], R.Unit, R.Never, () => cyclic))).toMatchObject({
    admitted: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: "QUEUE_BUDGET_CYCLE" })]),
  });
  for (const source of [
    queued(() => all(R.Effect.sleep(1), R.Effect.void)),
    queued(() => R.Effect.race(R.Effect.void, R.Effect.void)),
  ])
    expect(analyzeQueueBudget(source).admitted).toBe(false);
  const root = pressure(1).body.node;
  if (root._tag !== "QueueScope") throw new Error("fixture owner missing");
  const malformed = R.fn([], R.Unit, R.Never, () =>
    Computation.make(R.Unit, R.Never, { ...root, capacity: 0 }),
  );
  expect(analyzeQueueBudget(malformed)).toMatchObject({
    admitted: false,
    diagnostics: [{ code: "QUEUE_BUDGET_CAPACITY" }],
  });
});
