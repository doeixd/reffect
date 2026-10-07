import { expect, test } from "vite-plus/test";
import { R } from "../src/index.ts";
import { Computation, EffectFn } from "../src/effect-ir.ts";
import { EqU64, Expr, IRType, Operation } from "../src/kernel.ts";
import { QueueIR as Q } from "../src/queue.ts";
import { QueueDoneType } from "../src/queue-model.ts";
import { analyzeGeneratedQueueProfile } from "../src/queue-generated-profile.ts";
import {
  analyzeGeneratedDeferredGrowth,
  generatedDeferredGrowthLimits,
} from "../src/deferred-growth.ts";

const all = (a: Computation<void>, b: Computation<void>) =>
  R.Effect.all([a, b], { concurrency: "unbounded", discard: true });
const unit = (
  build: (owner: Expr<import("effect").Queue.Queue<bigint>>) => Computation<void>,
  capacity = 1,
) => R.fn([], R.Unit, R.Never, () => Q.bounded(R.U64, capacity).pipe(R.Effect.flatMap(build)));
const analyze = (fn: EffectFn) => analyzeGeneratedQueueProfile(R.program({ work: fn })).get(fn)!;
const pair = (owner: Expr<import("effect").Queue.Queue<bigint>>) =>
  all(Q.offer(owner, R.U64.literal(1n)).pipe(R.Effect.asVoid), Q.take(owner).pipe(R.Effect.asVoid));

test("private Queue receipts accept builtin capacities, scalar captures and child branches", () => {
  for (const capacity of [1, 2, 3]) {
    const profile = analyze(unit(pair, capacity));
    expect(profile.capacity).toBe(capacity);
    expect(profile.success).toBe(R.U64);
    expect(profile.ownerCount).toBe(1);
    expect(profile.taskCapacity).toBe(2);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(profile.bounds.computationOccurrences).toBeGreaterThan(4);
  }
  const empty = <A>(payload: IRType<A>) =>
    R.fn([], R.Unit, R.Never, () =>
      Q.bounded(payload, 1).pipe(R.Effect.flatMap(() => all(R.Effect.void, R.Effect.void))),
    );
  expect(analyze(empty(R.Bool)).success).toBe(R.Bool);
  expect(analyze(empty(R.Unit)).success).toBe(R.Unit);
  const captured = unit((owner) =>
    R.Effect.succeed(R.U64.literal(7n)).pipe(
      R.Effect.flatMap((value) =>
        all(
          R.Match.bool(
            R.Bool.literal(true),
            Q.offer(owner, value).pipe(R.Effect.asVoid),
            R.Effect.void,
          ),
          Q.take(owner).pipe(R.Effect.andThen(R.Log.info("consumed")), R.Effect.asVoid),
        ),
      ),
    ),
  );
  expect(analyze(captured).bounds.expressionOccurrences).toBeGreaterThan(4);
});

test("Queue growth is explicitly selected and counts offered expression edges", () => {
  const fn = unit((owner) =>
    all(
      Q.offer(owner, R.U64.add(R.U64.literal(1n), R.U64.literal(2n))).pipe(R.Effect.asVoid),
      R.Effect.void,
    ),
  );
  const receipt = analyzeGeneratedDeferredGrowth(fn, "functions.work.body", "Queue");
  expect(receipt.expressionOccurrences).toBeGreaterThanOrEqual(3);
  for (const coordinator of ["Deferred", "Semaphore", "Latch"] as const)
    expect(() => analyzeGeneratedDeferredGrowth(fn, "functions.work.body", coordinator)).toThrow(
      /growth receipt/,
    );
});

test("conditional, absent, repeated and nested groups plus parent operations refuse", () => {
  for (const fn of [
    unit(() => R.Effect.void),
    unit((owner) => R.Match.bool(R.Bool.literal(true), pair(owner), R.Effect.void)),
    unit((owner) => pair(owner).pipe(R.Effect.andThen(pair(owner)))),
    unit((owner) => all(pair(owner), R.Effect.void)),
    unit((owner) => Q.offer(owner, R.U64.literal(1n)).pipe(R.Effect.andThen(pair(owner)))),
    unit((owner) => all(Q.shutdown(owner).pipe(R.Effect.asVoid), R.Effect.void)),
    unit((owner) => all(R.Effect.sleep(1), Q.take(owner).pipe(R.Effect.asVoid))),
    unit((owner) => pair(owner).pipe(R.Effect.ensuring(R.Effect.void))),
    unit(() => R.Semaphore.make(1).pipe(R.Effect.flatMap(() => all(R.Effect.void, R.Effect.void)))),
    unit(() => Q.bounded(R.U64, 1).pipe(R.Effect.flatMap(pair))),
  ])
    expect(() => analyze(fn)).toThrow();
  expect(() =>
    analyze(
      R.fn([R.Bool], R.Unit, R.Never, () => Q.bounded(R.U64, 1).pipe(R.Effect.flatMap(pair))),
    ),
  ).toThrow(/zero inputs/);
  const done = R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.U64, 1, QueueDoneType).pipe(
      R.Effect.flatMap(() => all(R.Effect.void, R.Effect.void)),
    ),
  );
  expect(() => analyze(done)).toThrow(/Never/);
});

test("untrusted operation identity refuses without callback execution", () => {
  let calls = 0;
  const alias = Operation.make(EqU64.ref, [R.U64, R.U64], R.Bool, () => {
    calls++;
    return true;
  });
  const fn = unit((owner) =>
    all(
      Q.offer(owner, R.U64.literal(1n)).pipe(R.Effect.asVoid),
      R.Effect.succeed(Expr.apply(alias, R.U64.literal(1n), R.U64.literal(1n))).pipe(
        R.Effect.asVoid,
      ),
    ),
  );
  expect(() => analyze(fn)).toThrow(/audited builtin scalar/);
  expect(calls).toBe(0);
});

test("full-edge preflight rejects oversized untaken branches and cycles", () => {
  const fn = unit((owner) =>
    all(
      R.Match.bool(
        R.Bool.literal(true),
        Q.offer(owner, R.U64.literal(1n)).pipe(R.Effect.asVoid),
        R.Log.info("x".repeat(generatedDeferredGrowthLimits.textBytes + 1)),
      ),
      R.Effect.void,
    ),
  );
  expect(() => analyze(fn)).toThrow(/textBytes/);
  const cyclic: Computation<void> = Computation.make(R.Unit, R.Never, {
    _tag: "Ensuring",
    get body() {
      return cyclic;
    },
    finalizer: R.Effect.void,
  });
  expect(() => analyze(unit(() => cyclic))).toThrow(/Cyclic/);
  let branches = R.Effect.void;
  for (let i = 0; i < 10; i++) branches = R.Match.bool(R.Bool.literal(true), branches, branches);
  expect(() => analyze(unit(() => branches))).toThrow(/computationOccurrences/);
});
