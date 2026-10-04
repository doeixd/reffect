import { expect, test } from "vite-plus/test";
import { R, FailureFrames, SourceArtifacts } from "../src/index.ts";
import { DeferredIR as D } from "../src/deferred.ts";
import { analyzeGeneratedDeferredProfile } from "../src/deferred-generated-profile.ts";
import { emitFunctions, lowerDeferredFunctions, lowerFunctions } from "../src/lower.ts";

const options = { concurrency: "unbounded", discard: true } as const;
const unit = () => R.Effect.void;
const sequence = R.fn([], R.Bool, R.Never, () =>
  D.make(R.Unit).pipe(
    R.Effect.flatMap((owner) =>
      D.succeed(owner, R.Unit.literal()).pipe(R.Effect.andThen(D.isDone(owner))),
    ),
  ),
);
const grouped = R.fn([], R.Unit, R.Never, () =>
  D.make(R.Unit).pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.all(
        [D.await(owner), D.succeed(owner, R.Unit.literal()).pipe(R.Effect.asVoid)],
        options,
      ),
    ),
  ),
);

test("private generated profiles separate owner occurrences from live contexts", () => {
  const profiles = analyzeGeneratedDeferredProfile(R.program({ sequence, grouped }));
  expect(profiles.get(sequence)).toEqual({ taskCapacity: 1, ownerCount: 1 });
  expect(profiles.get(grouped)).toEqual({ taskCapacity: 3, ownerCount: 1 });
});

test("ordinary backend entry cannot bypass public Deferred refusal", () => {
  expect(() => lowerFunctions(R.program({ sequence }), new Map())).toThrowError(/Deferred/);
});

test("generated borrow ranges preserve provenance and select only reached coordinator families", () => {
  const module = lowerDeferredFunctions(R.program({ grouped }), new Map());
  const emitted = emitFunctions(module);
  const source = emitted.files["src/lib.rs"];
  expect(source).toContain("DeferredTurnHandle<'_, 3>");
  expect(source).toContain("&DeferredState<(), std::convert::Infallible, 3>");
  expect(source).toContain("async fn coordinated_task_group2");
  expect(source).not.toContain("async fn coordinated_task_group3");
  expect(source).not.toContain("async fn deferred_join");
  expect(source).not.toContain("async fn task_group2");
  const occurrences = module.provenance?.occurrences.filter((value) =>
    value.path.includes(".children[0]"),
  );
  expect(occurrences?.length).toBeGreaterThan(0);
  expect(
    emitted.ranges.some((range) => occurrences?.some((value) => range.occurrence === value.id)),
  ).toBe(true);
});

test("private lowering does not add coordinator machinery to ordinary artifacts", () => {
  const ordinary = R.program({ work: R.fn([], R.Unit, R.Never, unit) });
  const args = [new Map(), SourceArtifacts.None, FailureFrames.None] as const;
  const baseline = emitFunctions(lowerFunctions(ordinary, ...args));
  const experiment = emitFunctions(lowerDeferredFunctions(ordinary, ...args));
  expect(experiment).toEqual(baseline);
});

test("private generated profile refuses typed owners, Race, resources and unbounded iteration", () => {
  const typed = R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit, R.Bool).pipe(R.Effect.flatMap(() => unit())),
  );
  const raced = R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(R.Effect.flatMap(() => R.Effect.race(unit(), unit()))),
  );
  const scoped = R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(R.Effect.flatMap(() => R.Effect.scoped(unit()))),
  );
  const repeated = R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(R.Effect.flatMap(() => R.Effect.repeat(unit(), R.Schedule.forever))),
  );
  for (const work of [typed, raced, scoped, repeated])
    expect(() => analyzeGeneratedDeferredProfile(R.program({ work }))).toThrow();
});

test("nested and callback-started groups cannot acquire generated admission", () => {
  const nested = R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap(() =>
        R.Effect.all([R.Effect.all([unit(), unit()], options), unit()], options),
      ),
    ),
  );
  const callback = R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap((owner) =>
        D.succeed(owner, R.Unit.literal()).pipe(
          R.Effect.andThen(R.Effect.all([unit(), unit()], options)),
        ),
      ),
    ),
  );
  expect(() => analyzeGeneratedDeferredProfile(R.program({ nested }))).toThrow();
  expect(() => analyzeGeneratedDeferredProfile(R.program({ callback }))).toThrow();
});

test("private generated profile preserves the conditional automatic-yield refusal", () => {
  let work = unit();
  for (let index = 0; index < 10; index++) {
    const previous = work;
    work = previous.pipe(R.Effect.andThen(previous));
  }
  const oversized = R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(R.Effect.flatMap(() => work)),
  );
  expect(() => analyzeGeneratedDeferredProfile(R.program({ oversized }))).toThrowError(/budget/);
});
