/**
 * The `reffect` command line (docs/research/cli.md): `check`, `build` and `run` a server entry
 * whose default export is its compile effect, such as `NativeRpc.compile(Group, bindings)`. Each
 * command is a thin wrapper over the library: the entry's own compile, then `CargoApi`.
 */
import { pathToFileURL } from "node:url";
import {
  Console,
  Effect,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Predicate,
  Schema,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess } from "effect/process";
import type { NodeServices } from "@effect/platform-node/NodeServices";
import { CargoApi, CargoError, type GeneratedFiles } from "./cargo.ts";
import { CompileError, type Diagnostic } from "./kernel.ts";

/** The entry could not be loaded, or its default export is not a compile effect or artifact. */
export class EntryError extends Schema.TaggedError<EntryError>()("EntryError", {
  message: Schema.String,
}) {}

const isGeneratedFiles = (value: unknown): value is GeneratedFiles =>
  Predicate.hasProperty(value, "files") &&
  Predicate.isObject(value.files) &&
  ["Cargo.toml", "src/lib.rs", "src/main.rs"].every(
    (name) => Predicate.hasProperty(value.files, name) && Predicate.isString(value.files[name]),
  );
/** The entry contract (CLI-002): the CLI provides the Node platform services its compile reads. */
const isCompileEffect = (value: unknown): value is Effect.Effect<unknown, unknown, NodeServices> =>
  Effect.isEffect(value);

const CONTRACT =
  "its default export must be a compile effect, such as `export default NativeRpc.compile(Group, bindings)`";

/** Imports `entry` and runs its compile: the artifact it describes. */
const compileEntry = Effect.fn("Cli.compileEntry")(function* (entry: string) {
  const path = yield* Path.Path;
  const file = path.resolve(entry);
  const module: unknown = yield* Effect.tryPromise({
    try: () => import(pathToFileURL(file).href),
    catch: (cause) =>
      new EntryError({
        message: `Could not load ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
  const exported = Predicate.hasProperty(module, "default") ? module.default : undefined;
  const artifact = isCompileEffect(exported) ? yield* exported : exported;
  if (!isGeneratedFiles(artifact))
    return yield* new EntryError({ message: `${file} is not a reffect server entry: ${CONTRACT}` });
  return artifact;
});

/** `file:line:column code: message`, or the IR path when the diagnostic has no location. */
export const formatDiagnostic = (diagnostic: Diagnostic): string => {
  const at = diagnostic.primary;
  const where =
    at?.file !== undefined && at.line !== undefined
      ? `${at.file}:${at.line}:${at.column ?? 1}`
      : diagnostic.path;
  return `${where} ${diagnostic.code}: ${diagnostic.message}`;
};

/** Reports a refused compile, a failed Cargo or file step, or a bad entry, and exits 1 (CLI-006). */
const reported = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catch((error) => {
      const lines =
        error instanceof CompileError
          ? error.diagnostics.length
            ? error.diagnostics.map(formatDiagnostic)
            : [error.message]
          : error instanceof CargoError ||
              error instanceof EntryError ||
              error instanceof PlatformError.PlatformError
            ? [error.message]
            : undefined;
      if (lines === undefined) return Effect.fail(error);
      return Console.error(lines.join("\n")).pipe(
        Effect.andThen(Effect.sync(() => void (process.exitCode = 1))),
      );
    }),
  );

const entry = Argument.File("entry", { mustExist: true }).pipe(
  Argument.withDescription("The server entry; its default export is the compile effect"),
);
const release = Flag.Boolean("release").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Build with the release profile"),
);
const crate = Flag.String("crate").pipe(
  Flag.optional,
  Flag.withDescription(
    "The generated crate's directory (default .reffect/<entry> beside the entry)",
  ),
);

/** Compiles, syncs, fetches and builds `entry`: the built binary's path. */
const buildEntry = Effect.fn("Cli.buildEntry")(function* (
  file: string,
  crateDirectory: Option.Option<string>,
  profile: "debug" | "release",
) {
  const path = yield* Path.Path;
  const artifact = yield* compileEntry(file);
  const stem = path.basename(file).replace(/\.[^.]*$/, "");
  const directory = yield* CargoApi.sync(
    artifact,
    Option.getOrElse(crateDirectory, () => path.join(path.dirname(file), ".reffect", stem)),
  );
  yield* CargoApi.fetch(directory);
  yield* CargoApi.build(directory, profile);
  return {
    stem,
    binary: path.join(directory, "target", profile, `reffect_generated${exe}`),
  };
});
const exe = process.platform === "win32" ? ".exe" : "";

const check = Command.make("check", { entry }, ({ entry }) =>
  reported(compileEntry(entry).pipe(Effect.andThen(Console.log(`${entry}: ok`)))),
).pipe(Command.withDescription("Compile the entry and report its diagnostics, without Cargo"));

const build = Command.make(
  "build",
  {
    entry,
    release,
    crate,
    out: Flag.String("out").pipe(
      Flag.optional,
      Flag.withDescription("Where to copy the binary (default ./<entry>)"),
    ),
  },
  ({ entry, release, crate, out }) =>
    reported(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const built = yield* buildEntry(entry, crate, release ? "release" : "debug");
        const target = path.resolve(Option.getOrElse(out, () => `${built.stem}${exe}`));
        yield* fs.copyFile(built.binary, target);
        yield* Console.log(target);
      }),
    ),
).pipe(Command.withDescription("Compile the entry and build its native server binary"));

const run = Command.make(
  "run",
  {
    entry,
    release,
    crate,
    args: Argument.String("args").pipe(
      Argument.variadic(),
      Argument.withDescription("Arguments for the server, after --"),
    ),
  },
  ({ entry, release, crate, args }) =>
    reported(
      Effect.scoped(
        Effect.gen(function* () {
          const built = yield* buildEntry(entry, crate, release ? "release" : "debug");
          const server = yield* ChildProcess.make(built.binary, args, {
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          });
          const code = yield* server.exitCode;
          yield* Effect.sync(() => void (process.exitCode = code));
        }),
      ),
    ),
).pipe(Command.withDescription("Build the entry, then run its server with the given arguments"));

export const ReffectCli = Command.make("reffect").pipe(
  Command.withDescription("Compile Effect servers written with R to native Rust binaries"),
  Command.withSubcommands([check, build, run]),
);
