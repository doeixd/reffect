import { expect, test } from "vite-plus/test";
import { R } from "../src/index.ts";
import { SemaphoreIR as S } from "../src/semaphore.ts";
import { analyzeScopes } from "../src/scope-analysis.ts";
import { analyzeTaskGroups } from "../src/structured-concurrency.ts";
import { analyzeDeferredBudget } from "../src/deferred-budget.ts";
import { analyzeGeneratedDeferredGrowth } from "../src/deferred-growth.ts";
import { analyzeGeneratedDeferredProfile } from "../src/deferred-generated-profile.ts";
import { DeferredExecution } from "../src/deferred-execution.ts";
import { DeferredInterruptionFrames } from "../src/deferred-interruption-frames.ts";
import { nestingDepth } from "../src/nesting.ts";
import { Provenance } from "../src/provenance.ts";

const guarded = <A, E>(body: import("../src/effect-ir.ts").Computation<A, E>) =>
  S.make(1).pipe(R.Effect.flatMap((semaphore) => S.withPermit(semaphore)(body)));

test("Semaphore bodies preserve structural provenance and child service diagnostics", () => {
  const body = guarded(
    R.Effect.all([R.Clock.currentTimeMillis.pipe(R.Effect.asVoid), R.Effect.void], {
      concurrency: "unbounded",
      discard: true,
    }),
  );
  const work = R.fn([], R.Unit, R.Never, () => body);
  expect(nestingDepth(work)).toBeGreaterThan(4);
  expect(analyzeTaskGroups(body).childClockPaths).toEqual(["body.body.body.children[0].source"]);
  const provenance = new Provenance(R.program({ work })).snapshot();
  expect(provenance.occurrences.map((entry) => entry.path)).toContain(
    "functions.work.body.body.body.children[0].source",
  );
});

test("permit bodies retain resource registrations but delayed cleanup cannot capture owners", () => {
  const registered = guarded(R.Effect.addFinalizer(() => R.Effect.void));
  expect(
    analyzeScopes(registered).diagnostics.some((issue) => issue.code === "SCOPE_REQUIRED"),
  ).toBe(true);
  const scoped = R.Effect.scoped(registered);
  const analysis = analyzeScopes(scoped);
  expect(analysis.diagnostics).toEqual([]);
  expect(analysis.capacities.get(scoped)).toBe(1);
  const escaping = S.make(1).pipe(
    R.Effect.flatMap((semaphore) =>
      R.Effect.scoped(R.Effect.addFinalizer(() => S.withPermit(semaphore)(R.Effect.void))),
    ),
  );
  expect(
    analyzeScopes(escaping).diagnostics.some((issue) => issue.code === "RESOURCE_ESCAPE"),
  ).toBe(true);
  const releaseEscape = S.make(1).pipe(
    R.Effect.flatMap((semaphore) =>
      R.Effect.scoped(
        R.Effect.acquireRelease(R.Effect.void, () => S.withPermit(semaphore)(R.Effect.void)),
      ),
    ),
  );
  expect(
    analyzeScopes(releaseEscape).diagnostics.some((issue) => issue.code === "RESOURCE_ESCAPE"),
  ).toBe(true);
});

test("public bounded Deferred proofs refuse Semaphore before authored logs execute", async () => {
  const work = R.fn([], R.Unit, R.Never, () =>
    R.Deferred.make(R.Unit).pipe(
      R.Effect.flatMap(() => guarded(R.Effect.logInfo("must not execute"))),
    ),
  );
  expect(
    analyzeDeferredBudget(work).diagnostics.some(
      (issue) => issue.code === "DEFERRED_BUDGET_UNACCOUNTED",
    ),
  ).toBe(true);
  expect(() => analyzeGeneratedDeferredGrowth(work)).toThrow();
  expect(() => analyzeGeneratedDeferredProfile(R.program({ work }))).toThrow();
  // The shared frame visitor accepts Semaphore; the Deferred admission boundary does not.
  expect(() =>
    new DeferredInterruptionFrames().prepare(work.body, "functions.work.body"),
  ).not.toThrow();
  const observation = await DeferredExecution.run(work);
  expect(observation.logs).toEqual([]);
  expect(observation.exit._tag).toBe("Failure");
});
