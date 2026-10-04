import { expect, test } from "vite-plus/test";
import { R } from "../src/index.ts";
import { checkEffectFunction } from "../src/effect-ir.ts";
import { analyzeTaskGroups } from "../src/structured-concurrency.ts";

const options = { concurrency: "unbounded", discard: true } as const;
const source = () =>
  R.Effect.fail(R.U64.literal(7n)).pipe(R.Effect.asVoid, R.Effect.ensuring(R.Effect.sleep(1)));

test("Never child channels still select rich group outcomes and cancellation guards", () => {
  const recovered = source().pipe(R.Effect.catchAll(() => R.Effect.void));
  const fn = R.fn([], R.Unit, R.Never, () =>
    R.Effect.all([recovered, R.Effect.sleep(10)], options),
  );
  const analysis = analyzeTaskGroups(fn.body);
  expect(checkEffectFunction(fn, "retained")).toEqual([]);
  expect(analysis.hasFallibleGroups).toBe(false);
  expect(analysis.hasRetainedFailures).toBe(true);
  expect(analysis.requiresRichErrors).toBe(true);
  expect(analysis.richGroups.has(fn.body)).toBe(true);
  expect(analysis.richComputations.has(fn.body)).toBe(true);
  expect(analysis.cancellationGuards.has(recovered)).toBe(true);
});

test("root and same-channel recovery use the same retained-outcome analysis", () => {
  const changed = source().pipe(
    R.Effect.catchAll(() => R.Effect.fail(R.Bool.literal(false)).pipe(R.Effect.asVoid)),
  );
  const same = source().pipe(
    R.Effect.catchAll((error) => R.Effect.fail(error).pipe(R.Effect.asVoid)),
  );
  for (const body of [changed, same]) {
    const analysis = analyzeTaskGroups(body);
    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.richGroups.size).toBe(0);
    expect(analysis.requiresRichErrors).toBe(true);
    expect(analysis.cancellationGuards.has(body)).toBe(true);
  }
});

test("Retry preserves selected failures and source Never inherits inner retained outcomes", () => {
  const retried = R.Effect.retry(source(), R.Schedule.recurs(2));
  const inner = source().pipe(R.Effect.catchAll(() => R.Effect.void));
  const outer = inner.pipe(R.Effect.catchAll(() => R.Effect.void));
  for (const body of [retried, outer]) {
    const analysis = analyzeTaskGroups(body);
    expect(analysis.requiresRichErrors).toBe(true);
    expect(analysis.richComputations.has(body)).toBe(true);
    expect(analysis.cancellationGuards.has(body)).toBe(true);
  }
});

test("unrepresentable async composite channel changes refuse at the recovery boundary", () => {
  const Payload = R.Struct({ code: R.U64 });
  const composite = R.Effect.fail(Payload.make({ code: R.U64.literal(7n) })).pipe(
    R.Effect.asVoid,
    R.Effect.ensuring(R.Effect.sleep(1)),
  );
  const changed = composite.pipe(R.Effect.catchAll(() => R.Effect.void));
  const same = composite.pipe(
    R.Effect.catchAll((error) => R.Effect.fail(error).pipe(R.Effect.asVoid)),
  );
  expect(analyzeTaskGroups(changed, "composite").diagnostics).toMatchObject([
    { code: "TASK_GROUP_RETAINED_FAILURE", path: "composite" },
  ]);
  const sameAnalysis = analyzeTaskGroups(same);
  expect(sameAnalysis.diagnostics).toEqual([]);
  expect(sameAnalysis.cancellationGuards.has(same)).toBe(true);
  expect(sameAnalysis.requiresRichErrors).toBe(false);
});

test("masked finalizer recovery does not add hidden failures to the capacity bound", () => {
  const recovered = source().pipe(R.Effect.catchAll(() => R.Effect.void));
  const cleanupOnly = R.Effect.void.pipe(R.Effect.ensuring(recovered));
  const cleanupAnalysis = analyzeTaskGroups(cleanupOnly);
  expect(cleanupAnalysis.requiresRichErrors).toBe(false);
  expect(cleanupAnalysis.cancellationGuards.has(recovered)).toBe(false);
  // Visiting the shared node in cleanup first cannot hide its later unmasked use.
  const group = R.Effect.all([cleanupOnly, recovered], options);
  const analysis = analyzeTaskGroups(group);
  expect(analysis.requiresRichErrors).toBe(true);
  expect(analysis.richGroups.has(group)).toBe(true);
});

test("synchronous recovery and plain infallible groups preserve ordinary reachability", () => {
  const recovered = R.Effect.fail(R.U64.literal(7n)).pipe(
    R.Effect.asVoid,
    R.Effect.catchAll(() => R.Effect.sleep(1)),
  );
  const group = R.Effect.all([recovered, R.Effect.sleep(1)], options);
  const analysis = analyzeTaskGroups(group);
  expect(analysis.requiresRichErrors).toBe(false);
  expect(analysis.richGroups.size).toBe(0);
  expect(analysis.cancellationGuards.size).toBe(0);
});
