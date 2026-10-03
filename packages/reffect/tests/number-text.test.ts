import { Effect, Exit, FileSystem } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, Compile, NativeRunner, R, Reference, SourceArtifacts } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// SSR-012: R.String.fromNumber writes a number as JS String(n) does, natively through ryu-js.
const text = R.fn([R.Number], R.String, (n) => R.String.fromNumber(n));
const values = [
  0,
  -0,
  1,
  -1.5,
  0.1 + 0.2,
  1e21,
  1e-7,
  123456789012345680000,
  2 ** 53,
  2 ** 53 + 2,
  -(2 ** 31),
  5e-324,
  Number.MAX_VALUE,
  1 / 3,
  NaN,
  Infinity,
  -Infinity,
];

test("the reference writes numbers as String(n)", async () => {
  for (const value of values)
    expect(await Effect.runPromise(Reference.run(text, [value]))).toBe(String(value));
});

test(
  "native number text equals JS String(n)",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-number-text-" });
          const artifact = yield* Compile.make(R.program({ text })).pipe(
            Compile.withSourceArtifacts(SourceArtifacts.None),
            Compile.run,
          );
          expect(artifact.explanation.crates).toEqual(["ryu-js@1.0.3"]);
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.fetch(directory);
          yield* CargoApi.build(directory, "debug");
          for (const value of values) {
            const native = yield* NativeRunner.run(
              artifact,
              directory,
              "text",
              text,
              [value],
              "debug",
            );
            expect(native, String(value)).toEqual(Exit.succeed(String(value)));
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
