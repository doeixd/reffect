import { expect, test } from "vite-plus/test";
import { R } from "../src/index.ts";
import { checkEffectFunction } from "../src/effect-ir.ts";

const options = { concurrency: "unbounded", discard: true } as const;
const Payload = R.Struct({ code: R.U64 });
const failure = () => R.Effect.fail(Payload.make({ code: R.U64.literal(7n) }));
const group = R.Effect.all([R.Effect.fail(R.U64.literal(1n)), R.Effect.void], options);

test("task-related composite recovery refuses channel changes while legacy recovery remains valid", () => {
  const composite = group.pipe(R.Effect.catchAll(failure));
  const changed = R.fn([], R.Unit, R.Never, () =>
    composite.pipe(R.Effect.catchAll(() => R.Effect.void)),
  );
  expect(checkEffectFunction(changed, "changed").map((issue) => issue.code)).toContain(
    "TASK_GROUP_RECOVERY",
  );
  const legacy = R.fn([], R.Unit, R.Never, () =>
    failure().pipe(R.Effect.catchAll(() => R.Effect.void)),
  );
  expect(checkEffectFunction(legacy, "legacy")).toEqual([]);
  const scalarSource = R.fn([], R.Unit, Payload, () => composite);
  expect(checkEffectFunction(scalarSource, "scalarSource")).toEqual([]);
});

test("shared task sources retain recovery admission after an earlier occurrence", () => {
  const composite = group.pipe(R.Effect.catchAll(failure));
  const shared = R.fn([], R.Unit, R.Never, () =>
    R.Match.bool(
      R.Bool.literal(true),
      composite.pipe(R.Effect.catchAll(() => R.Effect.void)),
      composite.pipe(R.Effect.catchAll(() => R.Effect.void)),
    ),
  );
  const paths = checkEffectFunction(shared, "shared")
    .filter((issue) => issue.code === "TASK_GROUP_RECOVERY")
    .map((issue) => issue.path);
  expect(paths).toEqual(["shared.body.onTrue", "shared.body.onFalse"]);
});

test("task stream host refusal still inspects nested stream cleanup", () => {
  const cleanup = R.Effect.all([R.Effect.void, R.Effect.void], options);
  const emit = R.Stream.fn([], R.Never, () =>
    R.Stream.make(R.U64.literal(1n)).pipe(R.Stream.ensuring(cleanup)),
  );
  const fn = R.fn([], R.Unit, R.Never, () => R.Effect.all([emit.body, R.Effect.void], options));
  const codes = checkEffectFunction(fn, "streaming").map((issue) => issue.code);
  expect(codes).toContain("TASK_GROUP_HOST");
  expect(codes).toContain("TASK_GROUP_CLEANUP");
});
