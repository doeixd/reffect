import { Cause, Effect, Exit, FileSystem, Option } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  EffectFn,
  NativeRunner,
  R,
  Reference,
  SourceArtifacts,
} from "../src/index.ts";
import type { IRType } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const branch = R.fn([R.Bool], R.U64, R.Unit, (c) =>
  R.Match.bool(c, R.Effect.succeed(R.U64.literal(1n)), R.Effect.fail(R.Unit.literal())),
);
const nested = R.fn([R.U64, R.Bool], R.U64, R.U64, (v, flag) =>
  R.Effect.succeed(v).pipe(
    R.Effect.flatMap((a) =>
      R.Match.bool(
        flag,
        R.Effect.fail(a),
        R.Effect.succeed(a).pipe(R.Effect.flatMap((b) => R.Effect.succeed(R.U64.add(a, b)))),
      ),
    ),
  ),
);
const stopped = R.fn([], R.U64, R.Bool, () =>
  R.Effect.flatMap(R.Effect.fail(R.Bool.literal(false)), () => R.Effect.fail(R.Bool.literal(true))),
);
const sharedFail = R.Effect.fail(R.U64.literal(3n));
const shared = R.fn([R.Bool], R.U64, R.U64, (c) => R.Match.bool(c, sharedFail, sharedFail));
const deepBody = (() => {
  let body = R.Effect.fail(R.U64.literal(1n));
  for (let i = 0; i < 40; i++)
    body = R.Effect.flatMap(body, () => R.Effect.fail(R.U64.literal(1n)));
  return body;
})();
const deep = R.Effect.fn([], R.U64, R.U64, () => deepBody);
const program = R.program({ branch, nested, stopped, shared, deep });

const pathsOf = (frames: readonly { readonly path: string; readonly kind: string }[]) =>
  frames.map((f) => [f.path, f.kind]);

test(
  "reference and native report the same executed boundary chains in debug/release",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({
            directory: ".",
            prefix: "reffect-frames-",
          });
          const artifact = yield* Compile.make(program).pipe(
            Compile.withSourceArtifacts(SourceArtifacts.None),
            Compile.run,
          );
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          for (const profile of ["debug", "release"] as const) {
            yield* CargoApi.build(directory, profile);
            const cases: {
              fn: EffectFn<readonly IRType<unknown>[], unknown, unknown>;
              name: "branch" | "nested" | "stopped" | "shared";
              args: readonly unknown[];
              base: string;
            }[] = [
              { fn: branch, name: "branch", args: [false], base: "functions.branch.body" },
              { fn: nested, name: "nested", args: [7n, true], base: "functions.nested.body" },
              { fn: stopped, name: "stopped", args: [], base: "functions.stopped.body" },
              { fn: shared, name: "shared", args: [true], base: "functions.shared.body" },
              { fn: shared, name: "shared", args: [false], base: "functions.shared.body" },
            ];
            const errorOf = (exit: Exit.Exit<unknown, unknown>) =>
              Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
            for (const c of cases) {
              const native = yield* NativeRunner.runWithFramesUnknown(
                artifact,
                directory,
                c.name,
                c.fn,
                c.args,
                profile,
              );
              const ref = yield* Reference.runWithFramesUnknown(c.fn, c.args, c.base);
              expect(Exit.isFailure(native.exit), `${profile}/${c.name}`).toBe(true);
              expect(Exit.isFailure(ref.exit), `${profile}/${c.name}`).toBe(true);
              expect(pathsOf(native.frames)).toEqual(pathsOf(ref.frames));
              expect(native.omitted).toBe(ref.omitted);
              // Domain payloads are unchanged by frame capture.
              const nativeError = errorOf(native.exit);
              const refError = errorOf(ref.exit);
              expect(
                Option.isSome(nativeError) &&
                  Option.isSome(refError) &&
                  nativeError.value === refError.value,
              ).toBe(true);
            }
            // Only the executed branch appears; the unselected arm contributes nothing.
            const takenTrue = yield* NativeRunner.runWithFrames(
              artifact,
              directory,
              "branch",
              branch,
              [true],
              profile,
            );
            expect(Exit.isSuccess(takenTrue.exit)).toBe(true);
            expect(takenTrue.frames).toEqual([]);
            expect(takenTrue.omitted).toBe(0);
            const refTrue = yield* Reference.runWithFrames(branch, [true], "functions.branch.body");
            expect(Exit.isSuccess(refTrue.exit)).toBe(true);
            expect(refTrue.frames).toEqual([]);
            // Shared helpers report the executed helper once for either call site.
            const sharedTrue = yield* NativeRunner.runWithFrames(
              artifact,
              directory,
              "shared",
              shared,
              [true],
              profile,
            );
            const sharedFalse = yield* NativeRunner.runWithFrames(
              artifact,
              directory,
              "shared",
              shared,
              [false],
              profile,
            );
            expect(pathsOf(sharedTrue.frames)).toEqual(pathsOf(sharedFalse.frames));
            // Existing payload-only entry point is unchanged by the stderr envelope.
            const plain = yield* NativeRunner.run(
              artifact,
              directory,
              "branch",
              branch,
              [false],
              profile,
            );
            expect(Exit.isFailure(plain)).toBe(true);
            // Deep chains truncate honestly with an omitted count.
            const deepNative = yield* NativeRunner.runWithFrames(
              artifact,
              directory,
              "deep",
              deep,
              [],
              profile,
            );
            const deepRef = yield* Reference.runWithFrames(deep, [], "functions.deep.body");
            expect(deepNative.frames).toHaveLength(32);
            expect(deepNative.omitted).toBeGreaterThan(0);
            expect(pathsOf(deepNative.frames)).toEqual(pathsOf(deepRef.frames));
            expect(deepNative.omitted).toBe(deepRef.omitted);
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0),
);

test(
  "mapped artifacts attach provenance origins without changing paths",
  async () => {
    const full = await Effect.runPromise(Compile.run(R.program({ branch })));
    const none = await Effect.runPromise(
      Compile.make(R.program({ branch })).pipe(
        Compile.withSourceArtifacts(SourceArtifacts.None),
        Compile.run,
      ),
    );
    // None honestly omits origins from frame literals; everything else is identical.
    // Origins appear Rust-escaped inside string literals.
    expect(none.files["src/lib.rs"].replaceAll(/,\\"origin\\":\\"[^\\"]*\\"/g, "")).toBe(
      full.files["src/lib.rs"].replaceAll(/,\\"origin\\":\\"[^\\"]*\\"/g, ""),
    );
    expect(none.files["src/main.rs"]).toBe(full.files["src/main.rs"]);
    expect(none.files["Cargo.toml"]).toBe(full.files["Cargo.toml"]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({
            directory: ".",
            prefix: "reffect-frames-origins-",
          });
          const fullDir = yield* CargoApi.write(full, `${parent}/full`);
          const noneDir = yield* CargoApi.write(none, `${parent}/none`);
          yield* CargoApi.build(fullDir, "debug");
          yield* CargoApi.build(noneDir, "debug");
          const fullRun = yield* NativeRunner.runWithFrames(
            full,
            fullDir,
            "branch",
            branch,
            [false],
            "debug",
          );
          const noneRun = yield* NativeRunner.runWithFrames(
            none,
            noneDir,
            "branch",
            branch,
            [false],
            "debug",
          );
          expect(fullRun.frames.length).toBeGreaterThan(0);
          expect(
            fullRun.frames.every((f) => typeof f.origin === "string" && f.origin.length > 0),
          ).toBe(true);
          expect(noneRun.frames.every((f) => !Object.hasOwn(f, "origin"))).toBe(true);
          expect(pathsOf(noneRun.frames)).toEqual(pathsOf(fullRun.frames));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0),
);

test(
  "malformed or missing frame envelopes are refused without touching payloads",
  async () => {
    const failer = R.Effect.fn([], R.U64, R.U64, () => R.Effect.fail(R.U64.literal(9n)));
    const ok = R.Effect.fn([], R.U64, R.Never, () => R.Effect.succeed(R.U64.literal(1n)));
    const artifact = await Effect.runPromise(
      Compile.make(R.program({ failer, ok })).pipe(
        Compile.withSourceArtifacts(SourceArtifacts.None),
        Compile.run,
      ),
    );
    const main = (arm: string) =>
      `fn main() -> Result<(), &'static str> {\n    let args: Vec<String> = std::env::args().skip(1).collect();\n    match args.first().map(String::as_str).ok_or("missing function")? {\n${arm}\n        _ => return Err("unknown function"),\n    }\n    Ok(())\n}\n`;
    const scenarios = [
      {
        dir: "wrongSchema",
        fn: "failer",
        out: "err:u64:9",
        err: '{"schema":"other@1","frames":[],"omitted":0}',
      },
      { dir: "notJson", fn: "failer", out: "err:u64:9", err: '{"schema":"reffect.frames@1",' },
      { dir: "noEnvelope", fn: "failer", out: "err:u64:9", err: "" },
      {
        dir: "unknownKind",
        fn: "failer",
        out: "err:u64:9",
          err: '{"schema":"reffect.frames@1","frames":[{"function":"f","path":"p","kind":"fiber"}],"omitted":0}',
      },
      {
        dir: "emptyIdentity",
        fn: "failer",
        out: "err:u64:9",
        err: '{"schema":"reffect.frames@1","frames":[{"function":"","path":"p","kind":"fail"}],"omitted":0}',
      },
      {
        dir: "badOmitted",
        fn: "failer",
        out: "err:u64:9",
        err: '{"schema":"reffect.frames@1","frames":[],"omitted":-1}',
      },
      {
        dir: "successEnvelope",
        fn: "ok",
        out: "ok:u64:1",
        err: '{"schema":"reffect.frames@1","frames":[],"omitted":0}',
      },
    ] as const;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({
            directory: ".",
            prefix: "reffect-frames-bad-",
          });
          for (const s of scenarios) {
            const directory = yield* CargoApi.write(
              {
                files: {
                  ...artifact.files,
                  // Raw strings avoid format-string brace conflicts in the JSON envelope.
                  "src/main.rs": main(
                    `        "${s.fn}" => { println!("{}", r#"${s.out}"#); eprintln!("{}", r#"${s.err}"#); },`,
                  ),
                },
              },
              `${parent}/${s.dir}`,
            );
            yield* CargoApi.build(directory, "debug");
            const error = yield* (
              s.fn === "ok"
                ? NativeRunner.runWithFrames(artifact, directory, "ok", ok, [], "debug")
                : NativeRunner.runWithFrames(artifact, directory, "failer", failer, [], "debug")
            ).pipe(
              Effect.map(() => undefined),
              Effect.catchTag("CompileError", (e) => Effect.succeed(e)),
            );
            expect(
              error?.diagnostics.map((d) => d.code),
              s.dir,
            ).toContain("INVALID_NATIVE_FRAMES");
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0),
);
