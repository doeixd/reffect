import { Effect, Fiber, Scheduler } from "effect";
import { expect, test } from "vite-plus/test";
import { R, Reference } from "../src/index.ts";
import { Computation, matchComputation } from "../src/effect-ir.ts";
import { DeferredIR as D } from "../src/deferred.ts";
import { analyzeDeferredBudget, defaultDeferredBudgetContext } from "../src/deferred-budget.ts";
import { analyzeDeferredTopology } from "../src/structured-concurrency.ts";

const unit = () => R.Effect.succeed(R.Unit.literal());
const all = (
  children:
    | readonly [Computation<void, never>, Computation<void, never>]
    | readonly [Computation<void, never>, Computation<void, never>, Computation<void, never>],
) => R.Effect.all(children, { concurrency: "unbounded", discard: true });
const fn = <E>(body: Computation<void, E>) => R.fn([], R.Unit, body.error, () => body);
class BudgetProbe extends Scheduler.MixedScheduler {
  maximum = 0;
  automaticYields = 0;
  override shouldYield(fiber: Fiber.Fiber<unknown, unknown>): boolean {
    this.maximum = Math.max(this.maximum, fiber.currentOpCount);
    const yielded = super.shouldYield(fiber);
    if (yielded) this.automaticYields++;
    return yielded;
  }
}

test("private scalar Deferred receipts cover actual plain/framed expansion", async () => {
  const body = R.Effect.flatMap(D.make(R.U64, R.U64), (d) =>
    R.Effect.flatMap(D.isDone(d), () =>
      R.Effect.flatMap(D.fail(d, R.U64.literal(7n)), () =>
        R.Effect.flatMap(D.succeed(d, R.U64.literal(9n)), () =>
          R.Effect.flatMap(
            R.Effect.catchAll(D.await(d), () => R.Effect.succeed(R.U64.literal(11n))),
            () => unit(),
          ),
        ),
      ),
    ),
  );
  const program = fn(body);
  const bounds = analyzeDeferredBudget(program);
  expect(bounds.admitted).toBe(true);
  for (const [effect, bound] of [
    [Reference.run(program, []), bounds.plain],
    [Reference.runWithFrames(program, []), bounds.framed],
  ] as const) {
    const scheduler = new BudgetProbe();
    await Effect.runPromise(Effect.exit(effect), { scheduler });
    expect(scheduler.maximum).toBeLessThanOrEqual(bound);
    expect(scheduler.automaticYields).toBe(0);
  }
});

test("budget defaults remain an explicit conditional proof, with unsupported contexts refused", () => {
  for (const key of Object.keys(
    defaultDeferredBudgetContext,
  ) as (keyof typeof defaultDeferredBudgetContext)[]) {
    const context = { ...defaultDeferredBudgetContext, [key]: "custom" };
    // hooks also uses custom; every changed field has an intentionally valid unsupported value.
    const result = analyzeDeferredBudget(fn(unit()), "body", context);
    expect(result.admitted).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "DEFERRED_BUDGET_CONTEXT", path: `context.${key}` }),
    );
  }
});

test("coordinated capacities distinguish owners, leaves and ancestor contexts", () => {
  const first = all([unit(), unit()]);
  const second = all([unit(), unit(), unit()]);
  const sequential = R.Effect.flatMap(first, () => second);
  const branches = matchComputation(R.Bool.literal(true), first, second);
  for (const body of [sequential, branches])
    expect(analyzeDeferredTopology(body)).toMatchObject({
      leafCapacity: 3,
      taskCapacity: 4,
      ownerCount: 0,
      diagnostics: [],
    });
  const lexical = R.Effect.flatMap(D.make(R.U64), () =>
    R.Effect.flatMap(D.make(R.Unit), () => second),
  );
  expect(analyzeDeferredTopology(lexical)).toMatchObject({
    hasDeferred: true,
    leafCapacity: 3,
    taskCapacity: 4,
    ownerCount: 2,
    diagnostics: [],
  });
  const nested = all([R.Effect.race(unit(), unit()), unit()]);
  expect(analyzeDeferredTopology(nested)).toMatchObject({ leafCapacity: 3, taskCapacity: 5 });
  expect(analyzeDeferredTopology(nested).diagnostics).toContainEqual(
    expect.objectContaining({ code: "NESTED_TASK_GROUP" }),
  );
});

test("resumed continuation, completion, recovery and cleanup group startup stay blocked", () => {
  const programs = [
    R.Effect.flatMap(D.make(R.Unit), (d) =>
      R.Effect.flatMap(D.await(d), () => all([unit(), unit()])),
    ),
    R.Effect.flatMap(D.make(R.Unit), (d) =>
      R.Effect.flatMap(D.succeed(d, R.Unit.literal()), () => all([unit(), unit()])),
    ),
    R.Effect.flatMap(D.make(R.Unit, R.U64), (d) =>
      R.Effect.catchAll(D.await(d), () => all([unit(), unit()])),
    ),
    R.Effect.flatMap(D.make(R.Unit), (d) => R.Effect.ensuring(D.await(d), all([unit(), unit()]))),
  ];
  for (const body of programs)
    expect(analyzeDeferredTopology(body).diagnostics).toContainEqual(
      expect.objectContaining({ code: "DEFERRED_CALLBACK_GROUP" }),
    );
});

test("pending Deferred cancellation receipt covers unregister and masked cleanup", async () => {
  const pending = fn(
    R.Effect.flatMap(D.make(R.Unit), (d) => R.Effect.ensuring(D.await(d), unit())),
  );
  const bounds = analyzeDeferredBudget(pending);
  expect(bounds.admitted).toBe(true);
  for (const [effect, bound] of [
    [Reference.run(pending, []), bounds.plain],
    [Reference.runWithFrames(pending, []), bounds.framed],
  ] as const) {
    const scheduler = new BudgetProbe();
    const fiber = Effect.runFork(Effect.exit(effect), { scheduler });
    expect(fiber.pollUnsafe()).toBeUndefined();
    fiber.interruptUnsafe();
    await Effect.runPromise(Fiber.await(fiber));
    expect(scheduler.maximum).toBeLessThanOrEqual(bound);
    expect(scheduler.automaticYields).toBe(0);
  }
});

test("shared occurrence summaries stay finite and iteration remains refused", () => {
  let shared = unit();
  for (let i = 0; i < 40; i++) {
    const previous = shared;
    shared = R.Effect.flatMap(previous, () => previous);
  }
  expect(analyzeDeferredTopology(shared)).toMatchObject({ leafCapacity: 1, taskCapacity: 1 });
  const repeated = R.Effect.repeat(unit(), R.Schedule.forever);
  expect(analyzeDeferredTopology(repeated)).toMatchObject({
    leafCapacity: Infinity,
    taskCapacity: Infinity,
  });
  expect(analyzeDeferredTopology(repeated).diagnostics).toContainEqual(
    expect.objectContaining({ code: "DEFERRED_TOPOLOGY_LOOP" }),
  );
});

test("owner occurrences count shared edges and alternatives without unsafe integer rounding", () => {
  const owned = R.Effect.flatMap(D.make(R.Unit), () => unit());
  expect(
    analyzeDeferredTopology(matchComputation(R.Bool.literal(true), owned, owned)).ownerCount,
  ).toBe(2);
  let expanded = owned;
  for (let i = 0; i < 54; i++) {
    const previous = expanded;
    expanded = R.Effect.flatMap(previous, () => previous);
  }
  expect(analyzeDeferredTopology(expanded)).toMatchObject({
    ownerCount: Infinity,
    leafCapacity: 1,
    taskCapacity: 1,
  });
});
