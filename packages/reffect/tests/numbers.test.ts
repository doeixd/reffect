import { Effect, FileSystem } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, Compile, NativeRunner, R, Reference, SourceArtifacts } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const add = R.fn([R.Number, R.Number], R.Number, (a, b) => R.Number.add(a, b));
const eq = R.fn([R.Number, R.Number], R.Bool, (a, b) => R.Number.eq(a, b));
const lt = R.fn([R.Number, R.Number], R.Bool, (a, b) => a.pipe(R.Number.lt(b)));
// Literals keep exact bits: NaN, -0 and a subnormal.
const literals = R.fn([R.Bool], R.Number, (pick) =>
  R.Match.bool(
    pick,
    R.Number.add(R.Number.literal(-0), R.Number.literal(-0)),
    R.Number.add(R.Number.literal(5e-324), R.Number.literal(NaN)),
  ),
);
const program = R.program({ add, eq, lt, literals });

const values = [
  0,
  -0,
  1,
  -1.5,
  0.1,
  0.2,
  2 ** 53,
  2 ** 53 + 2,
  5e-324,
  Number.MAX_VALUE,
  Infinity,
  -Infinity,
  NaN,
];
const pairs = values.flatMap((a) => values.map((b) => [a, b] as const));

test("number operations follow JS double semantics in the reference", async () => {
  for (const [a, b] of pairs) {
    expect(Object.is(await Effect.runPromise(Reference.run(add, [a, b])), a + b)).toBe(true);
    expect(await Effect.runPromise(Reference.run(eq, [a, b]))).toBe(a === b);
    expect(await Effect.runPromise(Reference.run(lt, [a, b]))).toBe(a < b);
  }
  expect(Object.is(await Effect.runPromise(Reference.run(literals, [true])), -0)).toBe(true);
  expect(Number.isNaN(await Effect.runPromise(Reference.run(literals, [false])))).toBe(true);
});

test(
  "native numbers agree with the reference bit for bit",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-numbers-" });
          const artifact = yield* Compile.make(program).pipe(
            Compile.withSourceArtifacts(SourceArtifacts.None),
            Compile.run,
          );
          expect(artifact.explanation.crates).toEqual([]);
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          for (const profile of ["debug", "release"] as const) {
            yield* CargoApi.build(directory, profile);
            // A representative subset keeps process launches bounded.
            for (const [a, b] of pairs.filter((_, i) => i % 7 === 0)) {
              const sum = yield* NativeRunner.run(artifact, directory, "add", add, [a, b], profile);
              expect(sum._tag === "Success" && Object.is(sum.value, a + b), `${a} + ${b}`).toBe(
                true,
              );
              expect(
                yield* NativeRunner.run(artifact, directory, "eq", eq, [a, b], profile),
              ).toEqual(yield* Effect.exit(Reference.run(eq, [a, b])));
              expect(
                yield* NativeRunner.run(artifact, directory, "lt", lt, [a, b], profile),
              ).toEqual(yield* Effect.exit(Reference.run(lt, [a, b])));
            }
            const zero = yield* NativeRunner.run(
              artifact,
              directory,
              "literals",
              literals,
              [true],
              profile,
            );
            expect(zero._tag === "Success" && Object.is(zero.value, -0)).toBe(true);
            const nan = yield* NativeRunner.run(
              artifact,
              directory,
              "literals",
              literals,
              [false],
              profile,
            );
            expect(nan._tag === "Success" && Number.isNaN(nan.value)).toBe(true);
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
