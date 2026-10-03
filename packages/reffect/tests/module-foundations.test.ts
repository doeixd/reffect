import { Array as OfficialArray, Effect, Exit, FileSystem, Option, Result } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  FailureFrames,
  NativeRunner,
  R,
  Reference,
  Rust,
  SourceArtifacts,
} from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const combined = R.fn([R.U64, R.U64, R.Bool], R.U64, R.Never, (first, second, allowed) => {
  const values = R.Array.make(first, second);
  const positiveSmall = R.Predicate.and<bigint>(
    (value) => R.U64.lt(R.U64.literal(0n), value),
    (value) => R.U64.lt(value, R.U64.literal(5n)),
  );
  const selected = values.pipe(
    R.Array.findFirst(positiveSmall),
    R.Option.map((value) => R.U64.add(value, R.Array.length(values))),
    R.Option.getOrElse(() => R.U64.literal(0n)),
  );
  return R.Match.bool(allowed, R.Effect.succeed(selected), R.Effect.fail(allowed)).pipe(
    R.Effect.matchEffect({
      onSuccess: (value) => R.Effect.succeed(value),
      onFailure: () => R.Effect.succeed(R.U64.literal(0n)),
    }),
    R.Effect.result,
    R.Effect.map((result) =>
      result.pipe(
        R.Result.map((value) => R.U64.add(value, R.U64.literal(1n))),
        R.Result.getOrElse(() => R.U64.literal(0n)),
      ),
    ),
  );
});

test(
  "public Option, Result, predicates and collection helpers compose natively",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-foundations-" });
          for (const failureFrames of [FailureFrames.Bounded, FailureFrames.None]) {
            const artifact = yield* Compile.make(R.program({ combined })).pipe(
              Compile.withTarget(Rust.std),
              Compile.withFailureFrames(failureFrames),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.run,
            );
            expect(artifact.files["Cargo.toml"]).not.toContain("[dependencies]");
            const directory = yield* CargoApi.write(artifact, `${parent}/${failureFrames._tag}`);
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              for (const pair of [
                [0n, 0n],
                [2n, 3n],
                [8n, 4n],
                [R.U64.max, 0n],
              ] as const)
                for (const allowed of [true, false]) {
                  const selected = OfficialArray.findFirst(
                    pair,
                    (value) => value > 0n && value < 5n,
                  ).pipe(
                    Option.map((value) => value + BigInt(pair.length)),
                    Option.getOrElse(() => 0n),
                  );
                  const source: Effect.Effect<bigint, boolean> = allowed
                    ? Effect.succeed(selected)
                    : Effect.fail(allowed);
                  const expected = yield* Effect.result(
                    source.pipe(
                      Effect.matchEffect({
                        onSuccess: Effect.succeed,
                        onFailure: () => Effect.succeed(0n),
                      }),
                    ),
                  ).pipe(
                    Effect.map(Result.map((value) => value + 1n)),
                    Effect.map(Result.getOrElse(() => 0n)),
                  );
                  const args = [...pair, allowed] as const;
                  expect(yield* Reference.run(combined, args)).toBe(expected);
                  expect(
                    yield* NativeRunner.run(
                      artifact,
                      directory,
                      "combined",
                      combined,
                      args,
                      profile,
                    ),
                  ).toEqual(Exit.succeed(expected));
                }
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0),
);
