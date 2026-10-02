import { Cause, Effect, Exit, FileSystem, Option } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  Expr,
  FailureFrames,
  NativeRunner,
  R,
  Reference,
  ReplaceAllString,
  SourceArtifacts,
} from "../src/index.ts";
import { escapeAttributeValue, escapeText } from "./fixtures/foldkit-escape.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// Foldkit's tables, applied as literal replacements with `&` first so that later
// replacements never re-escape an introduced ampersand.
const escaper = (table: readonly (readonly [string, string])[]) =>
  R.fn([R.String], R.String, R.Bool, (value) =>
    R.Match.bool(
      R.String.includes(value, R.String.literal("\u0000")),
      R.Effect.fail(R.Bool.literal(false)),
      R.Effect.succeed(
        table.reduce<Expr<string>>(
          (text, [search, replacement]) => R.String.replaceAll(text, search, replacement),
          value,
        ),
      ),
    ),
  );
const text = escaper([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ["\r", "&#13;"],
]);
const attribute = escaper([
  ["&", "&amp;"],
  ['"', "&quot;"],
  ["<", "&lt;"],
  ["\r", "&#13;"],
]);
const contains = R.fn([R.String, R.String], R.Bool, (self, search) =>
  self.pipe(R.String.includes(search)),
);
// Returns a parameter from both branches, exercising owned copies out of borrowed helpers.
const pick = R.fn([R.String, R.String], R.String, (left, right) =>
  R.Match.bool(R.String.eq(left, right), left, R.String.replaceAll(right, "a", "b")),
);
const program = R.program({ text, attribute, contains, pick });

const wellFormed = [
  "",
  "plain",
  'a&b<c>d"e\rf',
  "\r\n",
  "&amp;&lt;",
  "😀<😀",
  "é&",
  "\u{10FFFF}>",
  "日本語&\"<'",
  "$&$$",
];
const refused = ["\u0000", "x\u0000y"];
const loneSurrogates = ["\uD800", "\uDC00a", "a\uD83D", "\uDE00\uD83D"];

const upstream = (escape: (value: string) => string, value: string) => {
  try {
    return { value: escape(value) };
  } catch {
    return { throws: true };
  }
};
const observe = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.match(exit, {
    onSuccess: (value) => ({ value }),
    onFailure: (cause) => ({ error: Option.getOrUndefined(Cause.findErrorOption(cause)) }),
  });

test("escaping agrees with pinned upstream Foldkit, refusing NUL and lone surrogates", async () => {
  for (const [fn, escape] of [
    [text, escapeText],
    [attribute, escapeAttributeValue],
  ] as const) {
    for (const value of wellFormed)
      expect(observe(await Effect.runPromiseExit(Reference.run(fn, [value])))).toEqual(
        upstream(escape, value),
      );
    for (const value of refused) {
      expect(upstream(escape, value)).toEqual({ throws: true });
      expect(observe(await Effect.runPromiseExit(Reference.run(fn, [value])))).toEqual({
        error: false,
      });
    }
    // Upstream throws; reffect refuses the input at its String decode boundary.
    for (const value of loneSurrogates) {
      expect(upstream(escape, value)).toEqual({ throws: true });
      const error = await Effect.runPromise(Reference.run(fn, [value]).pipe(Effect.flip));
      if (typeof error === "boolean") throw new Error("Expected an input refusal");
      expect(error.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["INVALID_INPUT"]);
    }
  }
});

test("string operations refuse unsupported replacement and capture shapes", async () => {
  const value = R.String.literal("a");
  expect(() => R.String.replaceAll(value, "", "x")).toThrow("non-empty literal search");
  expect(() => R.String.replaceAll(value, "a", "$&")).toThrow("$ substitution");
  expect(() => R.String.literal("\uD800")).toThrow("well-formed");
  const checks = (fn: Parameters<typeof R.program>[0][string]) =>
    Effect.runPromise(Compile.check(R.program({ fn })).pipe(Effect.isSuccess));
  // Hand-built applications cannot bypass the literal-argument constraint.
  expect(
    await checks(
      R.fn([R.String, R.String], R.String, (self, search) =>
        Expr.apply(ReplaceAllString, self, search, R.String.literal("x")),
      ),
    ),
  ).toBe(false);
  expect(
    await checks(
      R.fn([R.String], R.String, (self) =>
        Expr.apply(ReplaceAllString, self, R.String.literal("a"), R.String.literal("$$")),
      ),
    ),
  ).toBe(false);
  expect(
    await checks(
      R.fn([R.String], R.Unit, R.Never, (self) =>
        R.Effect.addFinalizer(() => R.Effect.asVoid(R.Effect.succeed(self))).pipe(R.Effect.scoped),
      ),
    ),
  ).toBe(false);
  expect(await checks(text)).toBe(true);
});

test(
  "native string functions agree with the reference across policies and profiles",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-strings-" });
          for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
            const artifact = yield* Compile.make(program).pipe(
              Compile.withFailureFrames(policy),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.run,
            );
            expect(artifact.explanation.crates).toEqual([]);
            const directory = yield* CargoApi.write(artifact, `${parent}/${policy._tag}`);
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              for (const fn of [text, attribute] as const)
                for (const value of [...wellFormed, ...refused]) {
                  const name = fn === text ? "text" : "attribute";
                  const native = yield* NativeRunner.run(
                    artifact,
                    directory,
                    name,
                    fn,
                    [value],
                    profile,
                  );
                  expect(observe(native), `${name} ${JSON.stringify(value)}`).toEqual(
                    observe(yield* Effect.exit(Reference.run(fn, [value]))),
                  );
                }
              for (const [self, search] of [
                ["haystack", "st"],
                ["😀x", "x"],
                ["😀", "😀"],
                ["abc", ""],
                ["abc", "abcd"],
              ] as const)
                expect(
                  yield* NativeRunner.run(
                    artifact,
                    directory,
                    "contains",
                    contains,
                    [self, search],
                    profile,
                  ),
                ).toEqual(yield* Effect.exit(Reference.run(contains, [self, search])));
              for (const [left, right] of [
                ["same", "same"],
                ["left", "banana"],
              ] as const)
                expect(
                  yield* NativeRunner.run(
                    artifact,
                    directory,
                    "pick",
                    pick,
                    [left, right],
                    profile,
                  ),
                ).toEqual(yield* Effect.exit(Reference.run(pick, [left, right])));
              // Lone surrogates are refused before reaching the native process.
              expect(
                yield* NativeRunner.run(
                  artifact,
                  directory,
                  "text",
                  text,
                  ["\uD800"],
                  profile,
                ).pipe(
                  Effect.flip,
                  Effect.map((error) => error.message),
                ),
              ).toContain("well-formed");
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);
