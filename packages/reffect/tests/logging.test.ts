import { Effect, Exit, FileSystem, Logger, Schema } from "effect";
import { CurrentLogAnnotations, CurrentLogSpans } from "effect/References";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  CompileError,
  Computation,
  EffectFn,
  FailureFrames,
  NativeRunner,
  R,
  Reference,
  SourceArtifacts,
} from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

interface Captured {
  readonly level: string;
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
  readonly spans: readonly string[];
}
const captureWith = (out: Captured[]) =>
  Logger.layer([
    Logger.make((options) => {
      out.push({
        level: options.logLevel,
        message: options.message,
        annotations: { ...options.fiber.getRef(CurrentLogAnnotations) },
        spans: options.fiber.getRef(CurrentLogSpans).map(([label]) => label),
      });
    }),
  ]);
const normalize = (record: Captured) => ({
  level: record.level,
  message: Array.isArray(record.message) ? record.message.map(String) : [String(record.message)],
  annotations: Object.fromEntries(
    Object.entries(record.annotations)
      .map(([key, value]): readonly [string, string | boolean] => [
        key,
        typeof value === "bigint" ? value.toString() : (value as string | boolean),
      ])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ),
  spans: [...record.spans],
});
interface NativeLog {
  readonly level: string;
  readonly message: string;
  readonly annotations: Readonly<Record<string, unknown>>;
  readonly spans: readonly { readonly label: string; readonly elapsed_ms: number }[];
}
const nativeLogs = (stderr: string): NativeLog[] =>
  stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
    .map((line) => JSON.parse(line) as NativeLog);
const normalizeNative = (record: NativeLog) => ({
  level: record.level,
  message: [record.message],
  annotations: Object.fromEntries(
    Object.entries(record.annotations).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ),
  spans: record.spans.map((span) => {
    expect(Number.isSafeInteger(span.elapsed_ms) && span.elapsed_ms >= 0).toBe(true);
    return span.label;
  }),
});

const ordered = R.fn([], R.Unit, R.Never, () =>
  R.Log.info("first", [["count", R.U64.literal(9007199254740993n)]]).pipe(
    R.Effect.flatMap(() => R.Log.warn("second", [["ok", R.Bool.literal(false)]])),
    R.Effect.flatMap(() => R.Log.error("third")),
    R.Effect.flatMap(() => R.Effect.void),
  ),
);
const everyLevel = R.fn([], R.Unit, R.Never, () =>
  R.Log.trace("t").pipe(
    R.Effect.flatMap(() => R.Log.debug("d")),
    R.Effect.flatMap(() => R.Log.info("i")),
    R.Effect.flatMap(() => R.Log.warn("w")),
    R.Effect.flatMap(() => R.Log.error("e")),
    R.Effect.flatMap(() => R.Log.fatal("f")),
    R.Effect.flatMap(() => R.Effect.void),
  ),
);
const shadowed = R.fn([], R.Unit, R.Never, () =>
  R.Log.info("outer").pipe(
    R.Effect.flatMap(() =>
      R.Log.info("inner").pipe(
        R.Log.annotate("key", R.U64.literal(1n)),
        R.Log.annotate("key", R.U64.literal(2n)),
      ),
    ),
    R.Effect.flatMap(() => R.Log.info("restored")),
    R.Effect.flatMap(() => R.Effect.void),
  ),
);
const spanned = R.fn([], R.Unit, R.Never, () =>
  R.Log.info("outside").pipe(
    R.Effect.flatMap(() => R.Log.info("inside").pipe(R.Log.span("outer"), R.Log.span("inner"))),
    R.Effect.flatMap(() => R.Log.info("after")),
    R.Effect.flatMap(() => R.Effect.void),
  ),
);
const branched = R.fn([R.Bool], R.Unit, R.Never, (flag) =>
  R.Match.bool(flag, R.Log.info("taken-true"), R.Log.info("taken-false")).pipe(
    R.Effect.flatMap(() => R.Effect.void),
  ),
);
const sharedLog = R.Log.info("once");
const shared = R.fn([R.Bool], R.Unit, R.Never, (flag) =>
  R.Match.bool(flag, sharedLog, sharedLog).pipe(R.Effect.flatMap(() => R.Effect.void)),
);
const failing = R.fn([R.Bool], R.U64, R.Unit, (flag) =>
  R.Log.info("before").pipe(
    R.Effect.flatMap(() =>
      R.Match.bool(
        flag,
        R.Log.warn("doomed").pipe(R.Effect.flatMap(() => R.Effect.fail(R.Unit.literal()))),
        R.Effect.fail(R.Unit.literal()),
      ).pipe(R.Log.span("work"), R.Log.annotate("req", R.U64.literal(7n))),
    ),
  ),
);
const escaped = R.fn([], R.Unit, R.Never, () =>
  R.Log.info('quote " backslash \\ newline \n emoji 😀 surrogate A\ud800B', [
    ["key", R.Bool.literal(true)],
  ]).pipe(R.Effect.flatMap(() => R.Effect.void)),
);
const program = R.program({
  ordered,
  everyLevel,
  shadowed,
  spanned,
  branched,
  shared,
  failing,
  escaped,
});

const referenceLogs = (
  name:
    | "ordered"
    | "everyLevel"
    | "shadowed"
    | "spanned"
    | "branched"
    | "shared"
    | "failing"
    | "escaped",
  args: readonly unknown[],
) =>
  Effect.gen(function* () {
    const out: Captured[] = [];
    const fn = program.functions[name];
    if (!(fn instanceof EffectFn)) throw new Error("Expected an effect function");
    const exit = yield* Effect.exit(Reference.runUnknown(fn, args)).pipe(
      Effect.provide(captureWith(out)),
    );
    return { exit, logs: out.map(normalize) };
  });

test(
  "reference and native agree on ordering, levels, attributes and filtering",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({
            directory: ".",
            prefix: "reffect-log-",
          });
          for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
            const artifact = yield* Compile.make(program).pipe(
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.withFailureFrames(policy),
              Compile.run,
            );
            const directory = yield* CargoApi.write(artifact, `${parent}/${policy._tag}`);
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              const cases: {
                name: "ordered" | "shadowed" | "spanned" | "branched" | "shared" | "escaped";
                args: readonly [];
                nativeArgs: readonly [];
              }[] = [
                { name: "ordered", args: [], nativeArgs: [] },
                { name: "shadowed", args: [], nativeArgs: [] },
                { name: "spanned", args: [], nativeArgs: [] },
                { name: "escaped", args: [], nativeArgs: [] },
              ];
              for (const c of cases) {
                const expected = yield* referenceLogs(c.name, c.args);
                expect(Exit.isSuccess(expected.exit), `${profile}/${c.name}`).toBe(true);
                const result = yield* CargoApi.run(directory, c.name, c.nativeArgs, profile);
                expect(result.stdout.trim()).toBe("ok:unit");
                expect(nativeLogs(result.stderr).map(normalizeNative)).toEqual(expected.logs);
              }
              for (const flag of [true, false]) {
                for (const name of ["branched", "shared"] as const) {
                  const expected = yield* referenceLogs(name, [flag]);
                  const result = yield* CargoApi.run(directory, name, [flag], profile);
                  expect(nativeLogs(result.stderr).map(normalizeNative)).toEqual(expected.logs);
                }
              }
              // Shared log nodes emit once per execution, not once per static use.
              const sharedTrue = yield* referenceLogs("shared", [true]);
              expect(sharedTrue.logs).toHaveLength(1);
              // Default minimum filters Trace and Debug on both sides.
              const levels = yield* referenceLogs("everyLevel", []);
              expect(levels.logs.map((log) => log.level)).toEqual([
                "Info",
                "Warn",
                "Error",
                "Fatal",
              ]);
              const nativeLevels = yield* CargoApi.run(directory, "everyLevel", [], profile);
              expect(nativeLogs(nativeLevels.stderr).map(normalizeNative)).toEqual(levels.logs);
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0),
);

test(
  "scopes restore after success and failures keep their annotate/span frames",
  async () => {
    const restored = await Effect.runPromise(referenceLogs("shadowed", []));
    expect(restored.logs.map((log) => log.message)).toEqual([["outer"], ["inner"], ["restored"]]);
    // Innermost scope wins on key conflict, matching official Effect shadowing.
    expect(restored.logs[1].annotations).toEqual({ key: "1" });
    expect(restored.logs[2].annotations).toEqual({});
    const spans = await Effect.runPromise(referenceLogs("spanned", []));
    // First-applied wraps innermost, matching official Effect span stacking.
    expect(spans.logs[1].spans).toEqual(["outer", "inner"]);
    expect(spans.logs[2].spans).toEqual([]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({
            directory: ".",
            prefix: "reffect-log-fail-",
          });
          const artifact = yield* Compile.make(program).pipe(
            Compile.withSourceArtifacts(SourceArtifacts.None),
            Compile.run,
          );
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.build(directory, "debug");
          for (const flag of [true, false]) {
            const expected = yield* referenceLogs("failing", [flag]);
            const native = yield* NativeRunner.runWithFrames(
              artifact,
              directory,
              "failing",
              failing,
              [flag],
              "debug",
            );
            expect(Exit.isFailure(native.exit)).toBe(true);
            expect(Exit.isFailure(expected.exit)).toBe(true);
            const result = yield* CargoApi.run(directory, "failing", [flag], "debug");
            expect(nativeLogs(result.stderr).map(normalizeNative)).toEqual(expected.logs);
            const kinds = native.frames.map((frame) => frame.kind);
            expect(kinds).toContain("annotate");
            expect(kinds).toContain("span");
            const ref = yield* Reference.runWithFrames(failing, [flag], "functions.failing.body");
            expect(native.frames.map((frame) => [frame.path, frame.kind])).toEqual(
              ref.frames.map((frame) => [frame.path, frame.kind]),
            );
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0),
);

const codes = (effect: Effect.Effect<unknown, CompileError>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.map(() => Array<string>()),
      Effect.catchTag("CompileError", (e) => Effect.succeed(e.diagnostics.map((d) => d.code))),
    ),
  );

test("log authoring refuses invalid metadata and mismatched channels", async () => {
  expect(await codes(Compile.run(R.program({ ordered })))).toEqual([]);
  expect(() => R.Effect.void.pipe(R.Log.annotate("", R.Bool.literal(true)))).toThrow();
  expect(() => R.Effect.void.pipe(R.Log.annotate('bad"key', R.Bool.literal(true)))).toThrow();
  expect(() => R.Effect.void.pipe(R.Log.span("bad\\label"))).toThrow();
  expect(() =>
    R.Log.info("dup", [
      ["a", R.Bool.literal(true)],
      ["a", R.Bool.literal(false)],
    ]),
  ).toThrow();
  const forged = R.fn([], R.U64, R.Never, () =>
    Computation.make(R.U64, R.Never, {
      _tag: "Log",
      level: "Info",
      message: "x",
      attributes: [],
    }),
  );
  expect(await codes(Compile.run(R.program({ forged })))).toContain("TYPE_MISMATCH");
});

test(
  "native lexical log context restores nested and unwound scopes",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-log-context-" });
          const artifact = yield* Compile.make(
            R.program({
              emit: R.fn([], R.Unit, R.Never, () => R.Log.info("context")),
            }),
          ).pipe(Compile.withSourceArtifacts(SourceArtifacts.None), Compile.run);
          const directory = yield* CargoApi.write(
            {
              files: {
                ...artifact.files,
                "src/main.rs": String.raw`
use reffect_generated::{r_emit, with_log_context};
fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    r_emit().unwrap();
    with_log_context(r#"{"id":"outer"}"#.to_string(), || {
        r_emit().unwrap();
        with_log_context(r#"{"id":"inner"}"#.to_string(), || r_emit().unwrap());
        r_emit().unwrap();
    });
    let result = std::panic::catch_unwind(|| with_log_context(r#"{"id":"unwound"}"#.to_string(), || panic!("fixture")));
    assert!(result.is_err());
    r_emit().unwrap();
}
`,
              },
            },
            `${parent}/crate`,
          );
          for (const profile of ["debug", "release"] as const) {
            yield* CargoApi.build(directory, profile);
            const result = yield* CargoApi.run(directory, "unused", [], profile);
            const records = result.stderr
              .split("\n")
              .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
              .map((line) =>
                Schema.decodeUnknownSync(
                  Schema.Struct({
                    message: Schema.Literal("context"),
                    request: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
                  }),
                )(JSON.parse(line)),
              );
            expect(records.map((record) => record.request?.id)).toEqual([
              undefined,
              "outer",
              "inner",
              "outer",
              undefined,
            ]);
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(2),
);

test(
  "failure restores native annotation/span scopes with either frame policy",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-log-restoration-" });
          const expected = [];
          for (const flag of [true, false]) {
            const record = yield* referenceLogs("failing", [flag]);
            expect(Exit.isFailure(record.exit)).toBe(true);
            expected.push(...record.logs);
          }
          expected.push(...(yield* referenceLogs("ordered", [])).logs);
          for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
            const artifact = yield* Compile.make(program).pipe(
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.withFailureFrames(policy),
              Compile.run,
            );
            const directory = yield* CargoApi.write(
              {
                files: {
                  ...artifact.files,
                  "src/main.rs": `fn main() {
    assert_eq!(reffect_generated::r_failing(true), Err(()));
    assert_eq!(reffect_generated::r_failing(false), Err(()));
    reffect_generated::r_ordered().unwrap();
}
`,
                },
              },
              `${parent}/${policy._tag}`,
            );
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              const result = yield* CargoApi.run(directory, "ignored", [], profile);
              expect(nativeLogs(result.stderr).map(normalizeNative)).toEqual(expected);
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0),
);
