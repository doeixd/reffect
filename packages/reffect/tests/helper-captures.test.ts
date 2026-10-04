import { expect, test } from "vite-plus/test";
import { R, FailureFrames, SourceArtifacts } from "../src/index.ts";
import { DeferredIR as D } from "../src/deferred.ts";
import { emitFunctions, lowerDeferredFunctions } from "../src/lower.ts";

const lower = (work: Parameters<typeof R.program>[0][string]) =>
  lowerDeferredFunctions(R.program({ work }), new Map(), SourceArtifacts.None, FailureFrames.None);

test("private signatures retain only used owners through nested helpers and immediate finalizers", () => {
  const work = R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap(() =>
        D.make(R.Bool).pipe(
          R.Effect.flatMap((used) =>
            R.Effect.succeed(R.Bool.literal(true)).pipe(
              R.Effect.flatMap((value) =>
                R.Effect.void.pipe(R.Effect.ensuring(D.succeed(used, value).pipe(R.Effect.asVoid))),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  const module = lower(work);
  const helpers = module.functions[0].helpers;
  const ensuring = helpers.find((helper) => helper.body._tag === "Ensuring")!;
  expect(ensuring.deferredOwners).toHaveLength(1);
  expect(ensuring.input).toHaveLength(1);
  const completion = helpers.find((helper) => helper.body._tag === "DeferredComplete")!;
  expect(completion.input).toEqual(ensuring.input);
  const scopeOwners = helpers.flatMap((helper) =>
    helper.body._tag === "DeferredScope" ? [helper.body.owner.name] : [],
  );
  expect(ensuring.deferredOwners?.[0].name).toBe(scopeOwners[1]);
  expect(helpers.find((helper) => helper.index === 0)?.deferredOwners).toEqual([]);
  expect(
    helpers
      .filter((helper) => helper.body._tag === "Succeed")
      .every((helper) => helper.deferredOwners?.length === 0),
  ).toBe(true);
  const emitted = emitFunctions(module).files["src/lib.rs"];
  expect(emitted).toContain(`${scopeOwners[1]}: &DeferredState`);
});

test("private scalar capture selection retains transitive reads and prunes pure branch arguments", () => {
  const work = R.fn([], R.Bool, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap(() =>
        R.Effect.succeed(R.Bool.literal(false)).pipe(
          R.Effect.flatMap(() =>
            R.Effect.succeed(R.Bool.literal(true)).pipe(
              R.Effect.flatMap((used) =>
                R.Effect.void.pipe(
                  R.Effect.andThen(
                    R.Effect.succeed(R.Match.bool(used, used, R.Bool.literal(false))),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  const helpers = lower(work).functions[0].helpers;
  const branchHelpers = helpers.filter((helper) => helper.body._tag === "Pure");
  expect(branchHelpers).toHaveLength(2);
  expect(branchHelpers.map((helper) => helper.input.length).sort((a, b) => a - b)).toEqual([0, 1]);
  expect(helpers.every((helper) => helper.input.length <= 1)).toBe(true);
  const scalar = branchHelpers.find((helper) => helper.input.length === 1)!.input[0];
  expect(
    helpers
      .filter((helper) => helper.input.length > 0)
      .every((helper) => helper.input[0] === scalar),
  ).toBe(true);
});

test("shared owner operations preserve their identity across distinct scalar binding scopes", () => {
  const work = R.fn([], R.Bool, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap((owner) => {
        const shared = D.isDone(owner);
        return shared.pipe(
          R.Effect.flatMap(() =>
            R.Effect.succeed(R.U64.literal(7n)).pipe(R.Effect.andThen(shared)),
          ),
        );
      }),
    ),
  );
  const helpers = lower(work).functions[0].helpers;
  const sharedUses = helpers.filter((helper) => helper.body._tag === "DeferredIsDone");
  expect(sharedUses).toHaveLength(2);
  expect(sharedUses.map((helper) => helper.input)).toEqual([[], []]);
  expect(sharedUses[0].deferredOwners).toEqual(sharedUses[1].deferredOwners);
  expect(sharedUses[0].deferredOwners).toHaveLength(1);
});
