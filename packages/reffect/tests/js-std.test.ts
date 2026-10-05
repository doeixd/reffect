/**
 * `js_std` (docs/research/ssr-codemod.md, step 1d): each operation's reference is the ECMAScript
 * or Effect function it names, and the native port must agree with it on every corpus input.
 */
import { Effect, FileSystem } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, Compile, NativeRunner, R, Reference, SourceArtifacts } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// `Number.parse` read through Option, its value written as JS writes it, and whether it is safe.
const parsed = R.fn([R.String], R.String, (text) =>
  R.Number.parse(text).pipe(
    R.Option.match({
      onNone: () => R.String.literal("none"),
      onSome: (value) =>
        R.String.concat(
          R.String.concat(R.String.literal("some "), R.String.fromNumber(value)),
          R.Match.bool(
            R.Number.isSafeInteger(value),
            R.String.literal(" safe"),
            R.String.literal(""),
          ),
        ),
    }),
  ),
);
const program = R.program({ parsed });

const numbers = [
  "",
  " ",
  "  ",
  "NaN",
  "Infinity",
  "-Infinity",
  "+Infinity",
  " Infinity",
  "infinity",
  "inf",
  "nan",
  "1",
  "-0",
  "+1.5",
  "1.",
  ".5",
  ".",
  "+.5e1",
  "1e3",
  "1E-3",
  "1e",
  "e3",
  "1e+",
  "0x1F",
  "0X1f",
  "0x",
  "-0x1",
  "+0x1",
  "0b101",
  "0B2",
  "0o17",
  "0o8",
  "0x1.5",
  "1_000",
  " 42 ",
  " 42 ",
  "﻿7　",
  "᠎7",
  "0x1fffffffffffff",
  "0x20000000000001",
  "0x20000000000003",
  "0x20000000000002",
  `0x${"f".repeat(256)}`,
  `0x${"f".repeat(255)}`,
  `0b${"1".repeat(60)}`,
  "1e400",
  "-1e400",
  "4.9e-324",
  "2.4703282292062328e-324",
  "1e-400",
  "00012",
  "1.2.3",
  "12abc",
  "١٢",
  "9007199254740991",
  "9007199254740992",
  "-9007199254740991",
  "123456789012345678901234567890",
  "0.1",
  "1e21",
];

test("Number.parse reads as Effect's and isSafeInteger as the JS global, in the reference", async () => {
  const run = (text: string) => Effect.runPromise(Reference.run(parsed, [text]));
  expect(await run("0x1F")).toBe("some 31 safe");
  expect(await run(" ")).toBe("none");
  expect(await run("NaN")).toBe("some NaN");
  expect(await run("1.5")).toBe("some 1.5");
});

test(
  "the native port agrees with the reference on every corpus string",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-js-std-" });
          const artifact = yield* Compile.make(program).pipe(
            Compile.withSourceArtifacts(SourceArtifacts.None),
            Compile.run,
          );
          // A std port: no crate is selected for it.
          expect(artifact.explanation.crates.filter((crate) => crate !== "ryu-js@1.0.3")).toEqual(
            [],
          );
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.build(directory, "debug");
          for (const text of numbers) {
            const native = yield* NativeRunner.run(
              artifact,
              directory,
              "parsed",
              parsed,
              [text],
              "debug",
            );
            expect(native, JSON.stringify(text)).toEqual(
              yield* Effect.exit(Reference.run(parsed, [text])),
            );
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
