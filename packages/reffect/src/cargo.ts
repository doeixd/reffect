import { Context, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";

/** Files shared by compiler consumers; native execution does not require a particular IR. */
export interface GeneratedFiles {
  readonly files: Readonly<Record<"Cargo.toml" | "src/lib.rs" | "src/main.rs", string>>;
}

export class CargoError extends Schema.TaggedError<CargoError>()("CargoError", {
  message: Schema.String,
  command: Schema.Array(Schema.String),
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
}) {}
export interface ProcessResult {
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const execute = Effect.fn("Cargo.execute")(function* (
  args: readonly string[],
  cwd: string,
  input?: string,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make("cargo", args, {
        cwd,
        stdin: input === undefined ? "ignore" : Stream.succeed(new TextEncoder().encode(input)),
      });
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      const result: ProcessResult = { command: ["cargo", ...args], stdout, stderr, exitCode };
      if (exitCode !== 0)
        return yield* new CargoError({
          command: result.command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          message: `Cargo ${args.join(" ")} failed (${exitCode}): ${stderr}`,
        });
      return result;
    }),
  );
});
const writeFiles = Effect.fn("Cargo.writeFiles")(function* (
  artifact: GeneratedFiles,
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(directory, "src"));
  for (const name of ["Cargo.toml", "src/lib.rs", "src/main.rs"] as const) {
    yield* fs.writeFileString(path.join(directory, name), artifact.files[name], { flag: "wx" });
  }
  return directory;
});
const write = Effect.fn("Cargo.write")(function* (artifact: GeneratedFiles, output: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.resolve(output);
  // Exclusive directory creation refuses existing output, including concurrent writers.
  yield* fs.makeDirectory(directory);
  return yield* writeFiles(artifact, directory);
});
const build = Effect.fn("Cargo.build")(function* (
  directory: string,
  profile: "debug" | "release" = "debug",
) {
  return yield* execute(
    ["build", "--offline", ...(profile === "release" ? ["--release"] : [])],
    directory,
  );
});
const run = Effect.fn("Cargo.run")(function* (
  directory: string,
  name: string,
  args: readonly (bigint | boolean)[],
  profile: "debug" | "release" = "debug",
) {
  return yield* execute(
    [
      "run",
      "--offline",
      "--quiet",
      ...(profile === "release" ? ["--release"] : []),
      "--",
      name,
      ...args.map(String),
    ],
    directory,
  );
});
const validate = Effect.fn("Cargo.validate")(function* (
  artifact: GeneratedFiles,
  cases: readonly {
    readonly name: string;
    readonly args: readonly bigint[];
    readonly expected: bigint;
  }[],
  tempParent?: string,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "reffect-",
        directory: tempParent,
      });
      yield* writeFiles(artifact, directory);
      const results: ProcessResult[] = [];
      for (const profile of ["debug", "release"] as const) {
        results.push(yield* build(directory, profile));
        for (const c of cases) {
          const result = yield* run(directory, c.name, c.args, profile);
          if (result.stdout.trim() !== c.expected.toString())
            return yield* new CargoError({
              command: result.command,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              message: `Native ${profile} result differs for ${c.name}: expected ${c.expected}`,
            });
          results.push(result);
        }
      }
      return results;
    }),
  );
});
const runInput = Effect.fn("Cargo.runInput")(function* (
  directory: string,
  name: string,
  input: string,
  profile: "debug" | "release" = "debug",
) {
  return yield* execute(
    ["run", "--offline", "--quiet", ...(profile === "release" ? ["--release"] : []), "--", name],
    directory,
    input,
  );
});
export const CargoApi = { write, build, run, runInput, validate };
export class Cargo extends Context.Service<Cargo, typeof CargoApi>()("reffect/Cargo") {
  static readonly layer = Layer.succeed(Cargo, CargoApi);
}
