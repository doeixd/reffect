import { Effect, Exit } from "effect";
import { flow as effectFlow } from "effect";
import { NodeServices } from "@effect/platform-node";
import { FileSystem } from "effect";
import { expect, test } from "vite-plus/test";
import { CargoApi, Compile, EffectFn, Fn, NativeRunner, R, Reference, Rust } from "../src/index.ts";

const nativeValue = <A, E>(exit: Exit.Exit<A, E>): A =>
  Exit.match(exit, {
    onSuccess: (value) => value,
    onFailure: (cause) => {
      throw cause;
    },
  });

const one = R.fn([R.U64], R.U64, (x) => R.U64.add(x, R.U64.literal(1n)));
const double = R.fn([R.U64], R.U64, (x) => R.U64.mul(x, R.U64.literal(2n)));
const addOneThenDouble = R.flow(one, double);
const start = R.fn([], R.Unit, R.Never, () => R.Effect.logInfo("start"));
const thenSeven = R.fn([R.Unit], R.U64, R.Never, () => R.Effect.succeed(R.U64.literal(7n)));
const pureThenEffect = R.flow(start, thenSeven);
const failWhen = R.fn([R.U64], R.U64, R.Bool, (x) =>
  R.Match.bool(
    R.U64.eq(x, R.U64.literal(0n)),
    R.Effect.fail(R.Bool.literal(false)),
    R.Effect.succeed(R.U64.add(x, R.U64.literal(1n))),
  ),
);
const effectThenEffect = R.flow(failWhen, double);
const multi = R.flow(
  R.fn([R.U64, R.U64], R.U64, (a, b) => R.U64.add(a, b)),
  double,
);
const triple = R.flow(
  one,
  double,
  R.fn([R.U64], R.U64, (x) => R.U64.add(x, R.U64.literal(3n))),
);

test("flow composes Fn and EffectFn values with reference/native parity", async () => {
  expect(addOneThenDouble).toBeInstanceOf(Fn);
  expect(effectThenEffect).toBeInstanceOf(EffectFn);
  expect(R.flow(one)).toBe(one);
  expect(await Effect.runPromise(Reference.run(addOneThenDouble, [5n]))).toBe(12n);
  expect(await Effect.runPromise(Reference.run(triple, [1n]))).toBe(7n);
  expect(await Effect.runPromise(Reference.run(multi, [2n, 3n]))).toBe(10n);
  expect(await Effect.runPromise(Reference.run(effectThenEffect, [4n]))).toBe(10n);
  expect(await Effect.runPromise(Effect.exit(Reference.run(effectThenEffect, [0n])))).toMatchObject(
    {
      _tag: "Failure",
    },
  );
  expect(await Effect.runPromise(Reference.run(pureThenEffect, []))).toBe(7n);
  // plain Effect composition still composes build-time (builder) functions
  const addOne = (x: import("../src/index.ts").Expr<bigint>) => R.U64.add(x, R.U64.literal(1n));
  const timesTwo = (x: import("../src/index.ts").Expr<bigint>) => R.U64.mul(x, R.U64.literal(2n));
  const Doubled = R.fn([R.U64], R.U64, effectFlow(addOne, timesTwo));
  expect(await Effect.runPromise(Reference.run(Doubled, [5n]))).toBe(12n);
});

test("flow refuses non-IR functions and non-unary/mismatched components", () => {
  // @ts-expect-error plain functions are not Fn/EffectFn
  expect(() => R.flow((x: number) => x + 1)).toThrow();
  expect(() =>
    R.flow(
      one,
      R.fn([R.U64, R.U64], R.U64, (a, b) => R.U64.add(a, b)),
    ),
  ).toThrow();
  expect(() =>
    R.flow(
      one,
      R.fn([R.Bool], R.U64, (_x) => R.U64.literal(0n)),
    ),
  ).toThrow();
  const forged = R.fn([R.U64], R.U64, (x) => x);
  // @ts-expect-error a non-IR value cannot be composed
  expect(() => R.flow(forged, 5)).toThrow();
});

test("compiled composed functions agree with the reference in native debug/release", async () => {
  const program = R.program({ addOneThenDouble, effectThenEffect });
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ directory: ".", prefix: "reffect-flow-" });
      const artifact = yield* Compile.run(program, Rust.tokio);
      expect(artifact.files["src/lib.rs"]).not.toContain("Box<dyn>");
      const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
      for (const profile of ["debug", "release"] as const) {
        yield* CargoApi.build(directory, profile);
        const pure = yield* NativeRunner.run(
          artifact,
          directory,
          "addOneThenDouble",
          addOneThenDouble,
          [9n],
          profile,
        );
        expect(nativeValue(pure)).toEqual(yield* Reference.run(addOneThenDouble, [9n]));
        const effect = yield* NativeRunner.run(
          artifact,
          directory,
          "effectThenEffect",
          effectThenEffect,
          [4n],
          profile,
        );
        expect(nativeValue(effect)).toEqual(yield* Reference.run(effectThenEffect, [4n]));
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}, 180000);
