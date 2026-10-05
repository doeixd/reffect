import { Context, Effect, FileSystem, Layer, Path, Predicate, Schema, Stream } from "effect";
import { safeRelativePath } from "./source.ts";
import { NativeDiagnostic, readBuildDiagnostics } from "./cargo-diagnostics.ts";
import { ChildProcess } from "effect/process";
import { RuntimeCargoLock } from "./runtime-sources.generated.ts";

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
        // Cargo resolves against this lock, keeping its versions and dropping unused entries (#41).
        ["Cargo.lock", RuntimeCargoLock] as const,
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
/** A lock's registry packages, keyed `name@version`, each with its source and checksum. */
const lockedPackages = (lock: string): ReadonlyMap<string, string> => {
  const packages = new Map<string, string>();
  for (const block of lock.replaceAll("\r\n", "\n").split("[[package]]").slice(1)) {
    const field = (key: string) => new RegExp(`^${key} = "([^"]*)"$`, "m").exec(block)?.[1];
    const [name, version, source] = [field("name"), field("version"), field("source")];
    if (name !== undefined && version !== undefined && source !== undefined)
      packages.set(`${name}@${version}`, `${source} ${field("checksum") ?? ""}`);
  }
  return packages;
};
/**
 * The registry packages a resolved lock holds that `pinned` does not hold identically. A build
 * reaching a crate outside reffect's lock would resolve it from whatever the local registry
 * cache holds, so it is refused rather than built differently across machines (#41).
 */
export const unlockedPackages = (resolved: string, pinned = RuntimeCargoLock): string[] => {
  const locked = lockedPackages(pinned);
  return [...lockedPackages(resolved)]
    .filter(([key, origin]) => locked.get(key) !== origin)
    .map(([key]) => key);
};
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
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = yield* fs.readFileString(path.join(directory, "Cargo.lock")).pipe(
    Effect.mapError(
      (error) =>
        new CargoError({
          message: `The build left no readable Cargo.lock: ${error.message}`,
          command: result.command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        }),
    ),
  );
  const unlocked = unlockedPackages(resolved);
  if (unlocked.length)
    return yield* new CargoError({
      message: `The build resolved crates outside reffect's lock: ${unlocked.join(", ")}`,
      command: result.command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
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
