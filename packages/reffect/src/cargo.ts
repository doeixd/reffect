import { Context, Effect, FileSystem, Layer, Path, Predicate, Schema, Stream } from "effect";
import { safeRelativePath } from "./source.ts";
import { NativeDiagnostic, readBuildDiagnostics } from "./cargo-diagnostics.ts";
import { ChildProcess } from "effect/process";

/** Files shared by compiler consumers; native execution does not require a particular IR. */
export interface GeneratedFiles {
  readonly files: Readonly<Record<"Cargo.toml" | "src/lib.rs" | "src/main.rs", string>>;
  readonly auxiliaryFiles?: Readonly<Record<string, string>>;
}

export class CargoError extends Schema.TaggedError<CargoError>()("CargoError", {
  message: Schema.String,
  command: Schema.Array(Schema.String),
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
  diagnostics: Schema.optionalKey(Schema.Array(NativeDiagnostic)),
}) {}
export interface ProcessResult {
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly diagnostics?: readonly NativeDiagnostic[];
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
const artifactEntries = (artifact: GeneratedFiles) =>
  Effect.try({
    try: () => {
      const required = ["Cargo.toml", "src/lib.rs", "src/main.rs"] as const;
      const entries: readonly (readonly [string, string])[] = [
        ...required.map((name) => [name, artifact.files[name]] as const),
        ...Object.entries(artifact.auxiliaryFiles ?? {}),
      ];
      const seen = new Set<string>();
      for (const [name, text] of entries) {
        const canonical = name.toLowerCase();
        if (!safeRelativePath(name) || typeof text !== "string" || seen.has(canonical))
          throw new TypeError("Invalid or duplicate generated artifact path/content");
        seen.add(canonical);
      }
      for (const name of seen) {
        const segments = name.split("/");
        for (let i = 1; i < segments.length; i++)
          if (seen.has(segments.slice(0, i).join("/")))
            throw new TypeError("Artifact path traverses another output file");
      }
      return entries;
    },
    catch: (cause) =>
      new CargoError({
        message: String(cause),
        command: ["write"],
        exitCode: -1,
        stdout: "",
        stderr: "",
      }),
  });
const writeFiles = Effect.fn("Cargo.writeFiles")(function* (
  artifact: GeneratedFiles,
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* artifactEntries(artifact);
  yield* fs.makeDirectory(path.join(directory, "src"));
  for (const [name, text] of entries) {
    yield* fs.makeDirectory(path.dirname(path.join(directory, name)), { recursive: true });
    yield* fs.writeFileString(path.join(directory, name), text, { flag: "wx" });
  }
  return directory;
});
const write = Effect.fn("Cargo.write")(function* (artifact: GeneratedFiles, output: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* artifactEntries(artifact);
  const directory = path.resolve(output);
  // Exclusive directory creation refuses existing output, including concurrent writers.
  yield* fs.makeDirectory(directory);
  return yield* writeFiles(artifact, directory);
});
const build = Effect.fn("Cargo.build")(function* (
  directory: string,
  profile: "debug" | "release" = "debug",
) {
  const result = yield* execute(
    [
      "build",
      "--offline",
      "--message-format=json",
      ...(profile === "release" ? ["--release"] : []),
    ],
    directory,
  ).pipe(
    Effect.catchTag("CargoError", (error) =>
      Effect.gen(function* () {
        const diagnostics = yield* readBuildDiagnostics(error.stdout, directory);
        return yield* new CargoError({
          message: error.message,
          command: error.command,
          exitCode: error.exitCode,
          stdout: error.stdout,
          stderr: error.stderr,
          diagnostics,
        });
      }),
    ),
  );
  return { ...result, diagnostics: yield* readBuildDiagnostics(result.stdout, directory) };
});
const run = Effect.fn("Cargo.run")(function* (
  directory: string,
  name: string,
  args: readonly (bigint | boolean | string | undefined)[],
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
      ...args.map((value) => (Predicate.isUndefined(value) ? "unit" : String(value))),
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
/** Explicit dependency preparation; build and execution remain offline. */
const fetch = Effect.fn("Cargo.fetch")(function* (directory: string) {
  return yield* execute(["fetch"], directory);
});
export const CargoApi = { write, fetch, build, run, runInput, validate };
export class Cargo extends Context.Service<Cargo, typeof CargoApi>()("reffect/Cargo") {
  static readonly layer = Layer.succeed(Cargo, CargoApi);
}
