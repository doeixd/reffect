import { expect, test } from "vite-plus/test";
import { R } from "../src/index.ts";
import { DeferredIR as D } from "../src/deferred.ts";
import { analyzeDeferredTopology, analyzeTaskGroups } from "../src/structured-concurrency.ts";

const unit = () => R.Effect.succeed(R.Unit.literal());
const nested = { nestedGroups: true } as const;

test("private nested reservations include ancestors and preserve ordinary refusals", () => {
  const race = R.Effect.race(unit(), unit());
  const outer = R.Effect.all([race, unit()], { concurrency: "unbounded", discard: true });
  const analysis = analyzeDeferredTopology(outer, "body", nested);
  expect(analysis).toMatchObject({ leafCapacity: 3, taskCapacity: 5, diagnostics: [] });
  expect(analysis.taskCapacities.get(race)).toBe(3);
  expect(analysis.taskCapacities.get(outer)).toBe(5);
  for (const ordinary of [analyzeDeferredTopology(outer), analyzeTaskGroups(outer)])
    expect(ordinary.diagnostics).toContainEqual(
      expect.objectContaining({ code: "NESTED_TASK_GROUP" }),
    );
  const three = R.Effect.all([race, unit(), unit()], {
    concurrency: "unbounded",
    discard: true,
  });
  expect(analyzeDeferredTopology(three, "body", nested)).toMatchObject({
    leafCapacity: 4,
    taskCapacity: 6,
    diagnostics: [],
  });
});

test("shared child occurrences sum live reservations while sequential groups reuse them", () => {
  const race = R.Effect.race(unit(), unit());
  const concurrent = R.Effect.all([race, race], {
    concurrency: "unbounded",
    discard: true,
  });
  const analysis = analyzeDeferredTopology(concurrent, "body", nested);
  expect(analysis).toMatchObject({ leafCapacity: 4, taskCapacity: 7, diagnostics: [] });
  expect(analysis.taskCapacities.get(race)).toBe(3);
  const sequential = R.Effect.flatMap(concurrent, () => concurrent);
  expect(analyzeDeferredTopology(sequential, "body", nested)).toMatchObject({
    leafCapacity: 4,
    taskCapacity: 7,
    diagnostics: [],
  });
});

test("nested opt-in retains Deferred callback and masked-cleanup startup barriers", () => {
  const group = R.Effect.all([R.Effect.race(unit(), unit()), unit()], {
    concurrency: "unbounded",
    discard: true,
  });
  for (const program of [
    R.Effect.flatMap(D.make(R.Unit), (d) => R.Effect.flatMap(D.await(d), () => group)),
    R.Effect.flatMap(D.make(R.Unit), (d) =>
      R.Effect.flatMap(D.succeed(d, R.Unit.literal()), () => group),
    ),
  ])
    expect(analyzeDeferredTopology(program, "body", nested).diagnostics).toContainEqual(
      expect.objectContaining({ code: "DEFERRED_CALLBACK_GROUP" }),
    );
  expect(
    analyzeDeferredTopology(R.Effect.ensuring(unit(), group), "body", nested).diagnostics,
  ).toContainEqual(expect.objectContaining({ code: "TASK_GROUP_CLEANUP" }));
});

test("private nested analysis refuses compound outcomes", () => {
  const failed = R.Effect.fail(R.U64.literal(7n));
  const race = R.Effect.race(failed, failed);
  const program = R.Effect.all([race, race], { concurrency: "unbounded", discard: true });
  expect(analyzeDeferredTopology(program, "body", nested).diagnostics).toContainEqual(
    expect.objectContaining({ code: "DEFERRED_NESTED_OUTCOME" }),
  );
});
