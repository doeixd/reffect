import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import {
  Capabilities,
  CargoApi,
  Compile,
  CompileError,
  IRType,
  Native,
  NativeRunner,
  R,
  Reference,
  Rust,
  Source,
  SourceArtifacts,
  Target,
} from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const pure = R.fn([], R.Unit, () => R.Unit.literal());
const identity = R.fn([R.Unit], R.Unit, (unit) => unit);
const mixed = R.fn([R.Unit, R.Bool, R.U64], R.U64, (_unit, condition, value) =>
  R.Match.bool(condition, value, value.pipe(R.U64.add(R.U64.literal(1n)))),
);
const succeed = R.Effect.fn([], R.Unit, R.Never, () => R.Effect.void);
const unitFailure = R.Effect.fn([], R.Never, R.Unit, () => R.Effect.fail(R.Unit.literal()));
const branch = R.fn([R.Bool], R.Unit, R.Unit, (condition) =>
  R.Match.bool(condition, R.Effect.void, R.Effect.fail(R.Unit.literal())),
);
const mapped = R.fn([], R.U64, R.Never, () =>
  R.Effect.void.pipe(R.Effect.map((_unit) => R.U64.literal(17n))),
);
const flatMapped = R.fn([R.U64], R.U64, R.Never, (value) =>
  R.Effect.void.pipe(
    R.Effect.flatMap((_unit) => R.Effect.succeed(value)),
    R.Effect.flatMap((outer) =>
      R.Effect.void.pipe(R.Effect.map((_inner) => outer.pipe(R.U64.add(value)))),
    ),
  ),
);
const discarded = R.fn([R.U64], R.Unit, R.Never, (value) =>
  R.Effect.succeed(value).pipe(R.Effect.asVoid),
);
const stopped = R.fn([], R.Unit, R.Bool, () =>
  R.Effect.fail(R.Bool.literal(false)).pipe(
    R.Effect.asVoid,
    R.Effect.flatMap((_unit) => R.Effect.fail(R.Bool.literal(true))),
  ),
);
const selected = R.fn([R.Bool], R.Unit, (condition) =>
  R.Match.bool(condition, R.Unit.literal(), R.Unit.literal()),
);
const program = R.program({
  pure,
  identity,
  mixed,
  succeed,
  unitFailure,
  branch,
  mapped,
  flatMapped,
  discarded,
  stopped,
  selected,
});

const observe = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.match(exit, {
    onSuccess: (value) => ({ success: value }),
    onFailure: (cause) => {
      const error = Cause.findErrorOption(cause);
      if (!Option.isSome(error)) throw new Error("Expected a typed failure");
      return { failure: error.value };
    },
  });
const codes = (effect: Effect.Effect<unknown, CompileError>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.map(() => Array<string>()),
      Effect.catchTag("CompileError", (e) => Effect.succeed(e.diagnostics.map((d) => d.code))),
    ),
  );

test("Unit is exact undefined, not the value-discarding Void schema", async () => {
  expect(Schema.is(Schema.Void)(123)).toBe(true);
  expect(Schema.is(R.Unit.schema)(undefined)).toBe(true);
  for (const value of [null, 0, 1n, false, "unit", {}]) {
    expect(Schema.is(R.Unit.schema)(value)).toBe(false);
    expect(await codes(Reference.runUnknown(identity, [value]))).toContain("INVALID_INPUT");
  }
  expect(() => Object.assign(R.Unit.schema.ast, { checks: undefined })).toThrow();
  expect(() => Object.assign(R.Unit.schema, { ast: Schema.Void.ast })).toThrow();
  expect(R.Unit.native).toBe(Native.Unit);
  expect(await Effect.runPromise(Reference.run(pure, []))).toBeUndefined();
  expect(await Effect.runPromise(Reference.run(succeed, []))).toBe(
    await Effect.runPromise(Effect.void),
  );
  const failure = await Effect.runPromise(Effect.exit(Reference.run(unitFailure, [])));
  expect(observe(failure)).toEqual({ failure: undefined });
});

test("Unit capability/witness checks compose with source artifact policy", async () => {
  const site = Source.site(Source.file("src/unit.ts", "unit()"), 0, 6);
  const annotated = pure.pipe(Source.at(site));
  const full = await Effect.runPromise(Compile.run(R.program({ annotated })));
  const none = await Effect.runPromise(
    Compile.make(R.program({ annotated })).pipe(
      Compile.withSourceArtifacts(SourceArtifacts.None),
      Compile.run,
    ),
  );
  expect(none.files).toEqual(full.files);
  expect(full.explanation.analysis.capabilities).toContain(Capabilities.Unit);
  expect(full.explanation.crates).toEqual([]);
  expect(
    await codes(
      Compile.run(
        program,
        Rust.std.pipe(
          Target.withCapabilities([Capabilities.U64, Capabilities.Bool, Capabilities.SyncResult]),
        ),
      ),
    ),
  ).toContain("UNSUPPORTED_CAPABILITY");
  const wrong = IRType.make(R.Unit.ref, Schema.Void, Native.Unit);
  expect(
    await codes(
      Compile.run(R.program({ wrong: R.fn([], wrong, () => R.literal(wrong, undefined)) })),
    ),
  ).toContain("UNSUPPORTED_REPRESENTATION");
  expect(await codes(Reference.runUnknown(identity, []))).toContain("ARITY_MISMATCH");
});

test(
  "native Unit inputs/results and typed channels agree with Effect in debug/release",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({
            directory: ".",
            prefix: "reffect-unit-",
          });
          const artifact = yield* Compile.make(program).pipe(
            Compile.withSourceArtifacts(SourceArtifacts.None),
            Compile.run,
          );
          const directory = yield* CargoApi.write(
            {
              files: {
                "Cargo.toml": artifact.files["Cargo.toml"],
                "src/main.rs": artifact.files["src/main.rs"],
                "src/lib.rs":
                  artifact.files["src/lib.rs"] +
                  "\nconst _: [(); 0] = [(); std::mem::size_of::<()>()];\n",
              },
            },
            `${parent}/crate`,
          );
          for (const profile of ["debug", "release"] as const) {
            yield* CargoApi.build(directory, profile);
            expect(
              observe(yield* NativeRunner.run(artifact, directory, "pure", pure, [], profile)),
            ).toEqual({ success: undefined });
            expect(
              observe(
                yield* NativeRunner.run(
                  artifact,
                  directory,
                  "identity",
                  identity,
                  [undefined],
                  profile,
                ),
              ),
            ).toEqual({ success: undefined });
            expect(
              observe(
                yield* NativeRunner.run(artifact, directory, "succeed", succeed, [], profile),
              ),
            ).toEqual(observe(yield* Effect.exit(Effect.void)));
            expect(
              observe(
                yield* NativeRunner.run(
                  artifact,
                  directory,
                  "unitFailure",
                  unitFailure,
                  [],
                  profile,
                ),
              ),
            ).toEqual(observe(yield* Effect.exit(Effect.fail(undefined))));
            for (const condition of [true, false]) {
              expect(
                observe(
                  yield* NativeRunner.run(
                    artifact,
                    directory,
                    "branch",
                    branch,
                    [condition],
                    profile,
                  ),
                ),
              ).toEqual(observe(yield* Effect.exit(Reference.run(branch, [condition]))));
              expect(
                observe(
                  yield* NativeRunner.run(
                    artifact,
                    directory,
                    "selected",
                    selected,
                    [condition],
                    profile,
                  ),
                ),
              ).toEqual({ success: undefined });
              expect(
                observe(
                  yield* NativeRunner.run(
                    artifact,
                    directory,
                    "mixed",
                    mixed,
                    [undefined, condition, R.U64.max],
                    profile,
                  ),
                ),
              ).toEqual(
                observe(
                  yield* Effect.exit(Reference.run(mixed, [undefined, condition, R.U64.max])),
                ),
              );
            }
            expect(
              observe(yield* NativeRunner.run(artifact, directory, "mapped", mapped, [], profile)),
            ).toEqual({ success: 17n });
            expect(
              observe(
                yield* NativeRunner.run(
                  artifact,
                  directory,
                  "flatMapped",
                  flatMapped,
                  [9n],
                  profile,
                ),
              ),
            ).toEqual({ success: 18n });
            expect(
              observe(
                yield* NativeRunner.run(
                  artifact,
                  directory,
                  "discarded",
                  discarded,
                  [13n],
                  profile,
                ),
              ),
            ).toEqual(observe(yield* Effect.exit(Effect.succeed(13n).pipe(Effect.asVoid))));
            expect(
              observe(
                yield* NativeRunner.run(artifact, directory, "stopped", stopped, [], profile),
              ),
            ).toEqual(observe(yield* Effect.exit(Effect.fail(false).pipe(Effect.asVoid))));
          }
          const invalid = yield* CargoApi.run(directory, "identity", [0n]).pipe(
            Effect.map(() => undefined),
            Effect.catchTag("CargoError", (error) => Effect.succeed(error)),
          );
          expect(invalid?.stderr).toContain("invalid unit");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(1),
);

test("native Unit decoder refuses malformed payloads and wrong Result channels", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const parent = yield* fs.makeTempDirectoryScoped({
          directory: ".",
          prefix: "reffect-unit-output-",
        });
        const artifact = yield* Compile.make(R.program({ pure, succeed, unitFailure })).pipe(
          Compile.withSourceArtifacts(SourceArtifacts.None),
          Compile.run,
        );
        const directory = yield* CargoApi.write(
          {
            files: {
              "Cargo.toml": artifact.files["Cargo.toml"],
              "src/lib.rs": artifact.files["src/lib.rs"],
              "src/main.rs":
                'fn main() { match std::env::args().nth(1).as_deref() { Some("pure") => println!("unit:undefined"), Some("succeed") => println!("ok:bool:false"), _ => println!("err:unit:extra") } }\n',
            },
          },
          `${parent}/crate`,
        );
        yield* CargoApi.build(directory);
        for (const effect of [
          NativeRunner.run(artifact, directory, "pure", pure, []).pipe(Effect.asVoid),
          NativeRunner.run(artifact, directory, "succeed", succeed, []).pipe(Effect.asVoid),
          NativeRunner.run(artifact, directory, "unitFailure", unitFailure, []).pipe(Effect.asVoid),
        ]) {
          const error = yield* effect.pipe(
            Effect.map(() => undefined),
            Effect.catchTag("CompileError", (failure) => Effect.succeed(failure)),
          );
          expect(error?.diagnostics.map((d) => d.code)).toContain("INVALID_NATIVE_OUTPUT");
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}, 120000);
