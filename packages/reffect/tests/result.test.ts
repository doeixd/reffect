import { Effect, Exit, FileSystem, Result } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  NativeRunner,
  R,
  Reference,
  Rust,
  SourceArtifacts,
} from "../src/index.ts";
import { ResultIR, effectResult } from "../src/result.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const U64Bool = ResultIR(R.U64, R.Bool);
const transform = R.fn([R.Bool, R.U64], ResultIR(R.String, R.U64), (ok, n) =>
  R.Match.bool(ok, ResultIR.succeed(n, R.Bool), ResultIR.fail(ok, R.U64)).pipe(
    ResultIR.map((value) => R.U64.add(value, R.U64.literal(1n))),
    ResultIR.flatMap((value) =>
      R.Match.bool(
        R.U64.lt(value, R.U64.literal(5n)),
        ResultIR.succeed(R.String.literal("small😀"), R.Bool),
        ResultIR.fail(R.Bool.literal(true), R.String),
      ),
    ),
    ResultIR.mapError((error) => R.Match.bool(error, R.U64.literal(9n), R.U64.literal(7n))),
  ),
);
const capture = R.fn([R.Bool, R.U64], U64Bool, R.Never, (ok, n) =>
  effectResult(R.Match.bool(ok, R.Effect.succeed(n), R.Effect.fail(ok))),
);
const captureSuccess = R.fn([R.U64], ResultIR(R.U64, R.Never), R.Never, (n) =>
  effectResult(R.Effect.succeed(n)),
);
const captureFailure = R.fn([R.Bool], ResultIR(R.Never, R.Bool), R.Never, (error) =>
  effectResult(R.Effect.fail(error)),
);
const nativeTransform = R.flow(
  transform,
  R.fn([ResultIR(R.String, R.U64)], R.String, (value) =>
    ResultIR.match(value, {
      onSuccess: (text) => text,
      onFailure: (error) =>
        R.Match.bool(
          R.U64.eq(error, R.U64.literal(9n)),
          R.String.literal("large"),
          R.String.literal("failed"),
        ),
    }),
  ),
);
const nativeCapture = R.fn([R.Bool, R.U64], R.U64, R.Never, (ok, n) =>
  effectResult(R.Match.bool(ok, R.Effect.succeed(n), R.Effect.fail(ok))).pipe(
    R.Effect.map(ResultIR.getOrElse(() => R.U64.literal(7n))),
  ),
);
const nativeSuccess = R.fn([R.U64], R.U64, R.Never, (n) =>
  effectResult(R.Effect.succeed(n)).pipe(
    R.Effect.map(
      ResultIR.match({ onSuccess: (value) => value, onFailure: () => R.U64.literal(0n) }),
    ),
  ),
);
const nativeFailure = R.fn([R.Bool], R.Bool, R.Never, (error) =>
  effectResult(R.Effect.fail(error)).pipe(
    R.Effect.map(
      ResultIR.match({ onSuccess: () => R.Bool.literal(true), onFailure: (value) => value }),
    ),
  ),
);
const flags = R.fn([U64Bool], R.Bool, (self) => ResultIR.isFailure(self));
const fallback = R.fn([U64Bool], R.U64, (self) =>
  self.pipe(ResultIR.getOrElse(() => R.U64.literal(10n))),
);
const format = R.fn([U64Bool], R.String, (self) =>
  ResultIR.match(self, {
    onSuccess: () => R.String.literal("ok"),
    onFailure: () => R.String.literal("error"),
  }),
);
const officialInput = (ok: boolean, n: bigint): Result.Result<bigint, boolean> =>
  ok ? Result.succeed(n) : Result.fail(ok);
const oracle = (ok: boolean, n: bigint) =>
  officialInput(ok, n).pipe(
    Result.map((value) => value + 1n),
    Result.flatMap((value) => (value < 5n ? Result.succeed("small😀") : Result.fail(true))),
    Result.mapError((error) => (error ? 9n : 7n)),
    Result.match({
      onSuccess: (success) => ({ _tag: "Success", success }),
      onFailure: (failure) => ({ _tag: "Failure", failure }),
    }),
  );
const corpus = [
  [true, 0n],
  [true, 4n],
  [false, 3n],
  [true, 9007199254740993n],
] as const;

test("Result operations agree with pinned Effect v4 and capture typed errors", async () => {
  expect(ResultIR(R.U64, R.Bool)).toBe(U64Bool);
  expect(await Effect.runPromise(Reference.run(captureSuccess, [11n]))).toEqual({
    _tag: "Success",
    success: 11n,
  });
  expect(await Effect.runPromise(Reference.run(captureFailure, [false]))).toEqual({
    _tag: "Failure",
    failure: false,
  });
  for (const [ok, n] of corpus) {
    expect(await Effect.runPromise(Reference.run(transform, [ok, n]))).toEqual(oracle(ok, n));
    expect(await Effect.runPromise(Reference.run(capture, [ok, n]))).toEqual(
      ok ? { _tag: "Success", success: n } : { _tag: "Failure", failure: false },
    );
  }
  for (const value of [
    { _tag: "Success", success: 3n },
    { _tag: "Failure", failure: false },
  ] as const) {
    expect(await Effect.runPromise(Reference.run(flags, [value]))).toBe(value._tag === "Failure");
    expect(await Effect.runPromise(Reference.run(fallback, [value]))).toBe(
      value._tag === "Success" ? 3n : 10n,
    );
    expect(await Effect.runPromise(Reference.run(format, [value]))).toBe(
      value._tag === "Success" ? "ok" : "error",
    );
  }
});

test("Result builds each callback once, accepts reversed tags, and refuses witness widening", async () => {
  const reversed = R.TaggedUnion({ Failure: { failure: R.Bool }, Success: { success: R.U64 } });
  let maps = 0,
    errors = 0,
    binds = 0;
  const fn = R.fn([reversed], U64Bool, (self) =>
    self.pipe(
      ResultIR.map((value) => {
        maps++;
        return value;
      }),
      ResultIR.mapError((error) => {
        errors++;
        return error;
      }),
      ResultIR.flatMap((value) => {
        binds++;
        return ResultIR.succeed(value, R.Bool);
      }),
    ),
  );
  expect([maps, errors, binds]).toEqual([1, 1, 1]);
  const outputOrder = R.fn([U64Bool], reversed, (self) =>
    ResultIR.flatMap(self, (value) => reversed.cases.Success.make({ success: value })),
  );
  for (const value of [
    { _tag: "Success", success: 2n },
    { _tag: "Failure", failure: true },
  ] as const)
    expect(await Effect.runPromise(Reference.run(outputOrder, [value]))).toEqual(value);
  for (const value of [
    { _tag: "Success", success: 2n },
    { _tag: "Failure", failure: true },
  ] as const)
    expect(await Effect.runPromise(Reference.run(fn, [value]))).toEqual(value);
  expect(() =>
    ResultIR.flatMap(
      ResultIR.succeed(R.U64.literal(1n), R.Number),
      // @ts-expect-error A different error channel is rejected statically and dynamically.
      (value) => ResultIR.succeed(value, R.U64),
    ),
  ).toThrow("same error witness");
  const invalid = R.TaggedUnion({
    Success: { success: R.U64, extra: R.Bool },
    Failure: { failure: R.Bool },
  });
  expect(() =>
    ResultIR.isSuccess(
      invalid.cases.Success.make({ success: R.U64.literal(1n), extra: R.Bool.literal(true) }),
    ),
  ).toThrow("Result requires");
  let success = 0,
    failure = 0;
  ResultIR.mapBoth(ResultIR.succeed(R.U64.literal(1n), R.Bool), {
    onSuccess: (value) => {
      success++;
      return value;
    },
    onFailure: (error) => {
      failure++;
      return error;
    },
  });
  expect([success, failure]).toEqual([1, 1]);
});

test(
  "native Result transformations and Effect capture preserve values without new dependencies",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-result-" });
          const artifact = yield* Compile.make(
            R.program({
              transform: nativeTransform,
              capture: nativeCapture,
              captureSuccess: nativeSuccess,
              captureFailure: nativeFailure,
            }),
          ).pipe(
            Compile.withTarget(Rust.std),
            Compile.withSourceArtifacts(SourceArtifacts.None),
            Compile.run,
          );
          expect(artifact.files["Cargo.toml"]).not.toContain("tokio");
          expect(artifact.files["Cargo.toml"]).not.toContain("result =");
          expect(artifact.files["src/lib.rs"]).toContain("enum Union_");
          const directory = yield* CargoApi.write(artifact, `${parent}/native`);
          for (const profile of ["debug", "release"] as const) {
            yield* CargoApi.build(directory, profile);
            expect(
              yield* NativeRunner.run(
                artifact,
                directory,
                "captureSuccess",
                nativeSuccess,
                [11n],
                profile,
              ),
            ).toEqual(Exit.succeed(11n));
            expect(
              yield* NativeRunner.run(
                artifact,
                directory,
                "captureFailure",
                nativeFailure,
                [false],
                profile,
              ),
            ).toEqual(Exit.succeed(false));
            for (const [ok, n] of corpus) {
              expect(
                yield* NativeRunner.run(
                  artifact,
                  directory,
                  "transform",
                  nativeTransform,
                  [ok, n],
                  profile,
                ),
              ).toEqual(Exit.succeed(ok ? (n + 1n < 5n ? "small😀" : "large") : "failed"));
              expect(
                yield* NativeRunner.run(
                  artifact,
                  directory,
                  "capture",
                  nativeCapture,
                  [ok, n],
                  profile,
                ),
              ).toEqual(yield* Effect.exit(Reference.run(nativeCapture, [ok, n])));
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0),
);
