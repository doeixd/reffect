import { Cause, Effect, Exit, Fiber, Scheduler } from "effect";
import type { Queue } from "effect";
import { expect, test } from "vite-plus/test";
import { R, Rust } from "../src/index.ts";
import { Computation, EffectReference as Reference } from "../src/effect-ir.ts";
import type { Expr } from "../src/kernel.ts";
import { QueueIR as Q } from "../src/queue.ts";
import { QueueDoneType } from "../src/queue-model.ts";
import { analyzeQueueBudget, queueBudgetLimit } from "../src/queue-budget.ts";
import {
  analyzeGeneratedDeferredGrowth,
  generatedDeferredGrowthLimits,
} from "../src/deferred-growth.ts";
import { analyzeGeneratedQueueProfile } from "../src/queue-generated-profile.ts";
import { lowerQueueFunctions } from "../src/lower.ts";

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
  if (!items.length) return R.Effect.void;
  if (items.length === 1) return items[0];
  const split = Math.floor(items.length / 2);
  return sequence(items.slice(0, split)).pipe(R.Effect.andThen(sequence(items.slice(split))));
};
const all = (a: Computation<void>, b: Computation<void>) =>
  R.Effect.all([a, b], { concurrency: "unbounded", discard: true });
const queued = (
  build: (owner: Expr<Queue.Queue<bigint, Cause.Done<void>>>) => Computation<void>,
  capacity = 1,
) =>
  R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.U64, capacity, QueueDoneType).pipe(R.Effect.flatMap(build)),
  );
const recovered = (owner: Expr<Queue.Queue<bigint, Cause.Done<void>>>, body = R.Effect.void) =>
  Q.take(owner).pipe(
    R.Effect.asVoid,
    R.Effect.catch(() => body),
  );
const emptyEnd = () => queued((owner) => all(recovered(owner), Q.end(owner).pipe(R.Effect.asVoid)));

test("terminal wakes and both recovery edges contribute to the conditional budget", () => {
  const receipt = analyzeQueueBudget(emptyEnd());
  expect(receipt).toMatchObject({ admitted: true, offers: 0, takes: 1, terminals: 1 });
  // Root24 + scope4 + All28 + catch3 + take16 + recovery5 + End16 + two Maps14 + wake16.
  expect(receipt.plain).toBe(126);
  // Framed observers40 + scope2 + All2 + catch2 + take2 + two Maps2.
  expect(receipt.framed).toBe(176);
  const repeated = queued((owner) => {
    const handler = Q.end(owner).pipe(R.Effect.asVoid);
    const child = recovered(owner, handler);
    return all(sequence([child, child]), Q.end(owner).pipe(R.Effect.asVoid));
  });
  expect(analyzeQueueBudget(repeated)).toMatchObject({ offers: 0, takes: 2, terminals: 3 });
  const branch = queued((owner) =>
    all(
      R.Match.bool(
        R.Bool.literal(true),
        Q.end(owner).pipe(R.Effect.asVoid),
        sequence([Q.shutdown(owner).pipe(R.Effect.asVoid), Q.end(owner).pipe(R.Effect.asVoid)]),
      ),
      recovered(owner),
    ),
  );
  expect(analyzeQueueBudget(branch)).toMatchObject({ admitted: true, takes: 1, terminals: 2 });
});

test("official plain and framed terminal/recovery turns stay below receipts without yielding", async () => {
  const sources = [
    emptyEnd(),
    queued((owner) =>
      all(
        sequence([
          Q.offer(owner, R.U64.literal(1n)).pipe(R.Effect.asVoid),
          Q.offer(owner, R.U64.literal(2n)).pipe(R.Effect.asVoid),
          Q.end(owner).pipe(R.Effect.asVoid),
        ]),
        sequence([recovered(owner), recovered(owner), recovered(owner)]),
      ),
    ),
    queued((owner) => all(recovered(owner, recovered(owner)), Q.end(owner).pipe(R.Effect.asVoid))),
    queued((owner) =>
      all(
        recovered(
          owner,
          sequence([
            Q.offer(owner, R.U64.literal(9n)).pipe(R.Effect.asVoid),
            Q.shutdown(owner).pipe(R.Effect.asVoid),
            Q.end(owner).pipe(R.Effect.asVoid),
          ]),
        ),
        Q.end(owner).pipe(R.Effect.asVoid),
      ),
    ),
    queued((owner) =>
      all(
        sequence([
          Q.offer(owner, R.U64.literal(1n)).pipe(R.Effect.asVoid),
          Q.end(owner).pipe(R.Effect.asVoid),
          Q.shutdown(owner).pipe(R.Effect.asVoid),
        ]),
        recovered(owner),
      ),
    ),
  ];
  for (const source of sources) {
    const receipt = analyzeQueueBudget(source);
    expect(receipt.admitted).toBe(true);
    for (const framed of [false, true]) {
      const scheduler = new Probe();
      if (framed)
        expect(
          (await Effect.runPromise(Reference.runWithFrames(source, []), { scheduler })).exit,
        ).toEqual(Exit.succeed(undefined));
      else
        expect(await Effect.runPromise(Reference.run(source, []), { scheduler })).toBeUndefined();
      expect(scheduler.maximum).toBeLessThanOrEqual(framed ? receipt.framed : receipt.plain);
      expect(scheduler.yields).toBe(0);
    }
  }
});

test("owner shutdown and actual parent cancellation bypass recovery within receipts", async () => {
  const shutdown = queued((owner) =>
    all(recovered(owner), Q.shutdown(owner).pipe(R.Effect.asVoid)),
  );
  const blocked = queued((owner) => all(recovered(owner), R.Effect.void));
  for (const source of [shutdown, blocked]) {
    const receipt = analyzeQueueBudget(source);
    expect(receipt.admitted).toBe(true);
    for (const framed of [false, true]) {
      const scheduler = new Probe();
      const effect = framed
        ? Reference.runWithFrames(source, []).pipe(Effect.map((result) => result.exit))
        : Reference.run(source, []).pipe(Effect.exit);
      const fiber = Effect.runFork(effect, { scheduler });
      if (source === blocked) {
        expect(fiber.pollUnsafe()).toBeUndefined();
        fiber.interruptUnsafe();
      }
      const outer = await Effect.runPromise(Fiber.await(fiber));
      // Framed root catches interruption into its observation; unframed outer interruption can escape exit.
      const exit = Exit.isSuccess(outer) ? outer.value : outer;
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(scheduler.maximum).toBeLessThanOrEqual(framed ? receipt.framed : receipt.plain);
      expect(scheduler.yields).toBe(0);
    }
  }
});

test("recovery source and handler count fully for growth, even when dormant or shared", () => {
  const base = R.fn([], R.Unit, R.Never, () => R.Effect.void);
  const caught = R.fn([], R.Unit, R.Never, () =>
    R.Effect.void.pipe(R.Effect.catch(() => R.Effect.void)),
  );
  const a = analyzeGeneratedDeferredGrowth(base, "body", "Queue");
  const b = analyzeGeneratedDeferredGrowth(caught, "body", "Queue");
  expect(b.computationOccurrences).toBe(a.computationOccurrences * 2 + 1);
  expect(b.expressionOccurrences).toBe(a.expressionOccurrences * 2);
  const shared = R.Log.info("retained-handler");
  const repeated = R.fn([], R.Unit, R.Never, () =>
    sequence([
      R.Effect.void.pipe(R.Effect.catch(() => shared)),
      R.Effect.void.pipe(R.Effect.catch(() => shared)),
    ]),
  );
  expect(analyzeGeneratedDeferredGrowth(repeated, "body", "Queue").textBytes).toBe(
    2 * "retained-handler".length,
  );
  const huge = R.fn([], R.Unit, R.Never, () =>
    R.Effect.void.pipe(
      R.Effect.catch(() => R.Log.info("x".repeat(generatedDeferredGrowthLimits.textBytes + 1))),
    ),
  );
  expect(analyzeQueueBudget(huge).admitted).toBe(true);
  expect(() => analyzeGeneratedDeferredGrowth(huge, "body", "Queue")).toThrow(/textBytes/);
  for (const mode of ["Deferred", "Semaphore", "Latch"] as const)
    expect(() => analyzeGeneratedDeferredGrowth(caught, "body", mode)).toThrow(
      /No private scalar growth receipt/,
    );
});

test("handler cycles, unaudited operations and terminal pressure fail closed", () => {
  const cyclic: Computation<void> = Computation.make(R.Unit, R.Never, {
    _tag: "CatchAll",
    binder: Symbol(),
    source: R.Effect.void,
    get body() {
      return cyclic;
    },
  });
  const cycle = R.fn([], R.Unit, R.Never, () => cyclic);
  expect(analyzeQueueBudget(cycle)).toMatchObject({
    admitted: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: "QUEUE_BUDGET_CYCLE" })]),
  });
  expect(() => analyzeGeneratedDeferredGrowth(cycle, "body", "Queue")).toThrow(/Cyclic/);
  const sleep = R.fn([], R.Unit, R.Never, () =>
    R.Effect.void.pipe(R.Effect.catch(() => R.Effect.sleep(1))),
  );
  expect(analyzeQueueBudget(sleep).admitted).toBe(false);
  const pressure = queued((owner) =>
    all(
      sequence(Array.from({ length: 16 }, () => Q.end(owner).pipe(R.Effect.asVoid))),
      sequence(Array.from({ length: 16 }, () => recovered(owner))),
    ),
  );
  expect(() => analyzeGeneratedDeferredGrowth(pressure, "body", "Queue")).not.toThrow();
  expect(analyzeQueueBudget(pressure)).toMatchObject({
    admitted: false,
    framed: queueBudgetLimit,
    diagnostics: [{ code: "QUEUE_BUDGET_EXCEEDED" }],
  });
});

test("finite analysis receipts never admit generated Done or terminal programs", () => {
  const source = emptyEnd();
  expect(analyzeQueueBudget(source).admitted).toBe(true);
  expect(() => analyzeGeneratedDeferredGrowth(source, "body", "Queue")).not.toThrow();
  const program = R.program({ work: source });
  expect(() => analyzeGeneratedQueueProfile(program)).toThrow(/Never/);
  const selected = new Map(Rust.std.implementations.map((item) => [item.operation.ref, item]));
  expect(() => lowerQueueFunctions(program, selected)).toThrow();
});
