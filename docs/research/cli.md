# The reffect CLI: build, run and check a server entry

Checked 2026-10-06 against `effect` 4.0.0 (`effect/cli`), `@effect/platform-node` 4.0.0, Node 24 (vp) and Cargo 1.9x.

## Prior work

- [compiler-api](../compiler-api.md#the-cli-is-then-almost-trivial) sketches `build/run/dev/check/emit/inspect` built with Effect's CLI modules, with "no hidden compiler functionality in the CLI": each command is a thin wrapper over the library.
- [rpc-mvp](../rpc-mvp.md) names `build server.ts` producing a server binary as part of the public demo; [open work](../open-work.md) lists it among unbuilt demos.
- Today a user writes the driver themselves: `NativeRpc.compile` (or `NativeRemote.compile`) returns an `RpcArtifact`, then `CargoApi.write`, `fetch` and `build` ([examples/rpc](../../examples/rpc/main.ts)). `CargoApi.write` refuses an existing directory, so every rebuild starts a fresh crate and recompiles Tokio/Axum.

## Sources

- `effect/cli` 4.0.0 (`node_modules/effect/src/cli`): `Command.make(name, config, handler)`, `Command.withSubcommands`, `Command.run(command, { version })` reading arguments from `Stdio`, `Argument.String`/`variadic`, `Flag.Boolean`/`String`/`optional`. Its environment (`FileSystem | Path | Terminal | ChildProcessSpawner | Stdio`) is exactly `NodeServices.layer`.
- Node 24 strips erasable TypeScript by default; reffect's sources use parameter properties (`SemanticRef`, `kernel.ts`), which need `--experimental-transform-types`. The examples already run that way.

## Decisions

- **CLI-001 Thin over the library.** Commands use `effect/cli` and call only public API: the entry's compile effect, then `CargoApi`. The one library addition the CLI needs is public too (CLI-003).
- **CLI-002 Entry contract.** The entry module's default export is the compile effect, `export default NativeRpc.compile(Group, bindings)`, or the artifact itself. It may require the Node platform services, which the CLI provides. Alternatives rejected: a named export (another name to learn), a config file (a second way to say what the code already says), an exported function (needs arguments the CLI cannot know).
- **CLI-003 Incremental crate.** `CargoApi.sync(artifact, directory)` writes an artifact into a crate directory it owns: it records the written paths in `reffect-files.json`, rewrites only changed files and deletes paths the previous artifact had but this one lacks. It refuses a non-empty directory without that record, so it never overwrites user files. Cargo's `target/` survives, so a rebuild recompiles only the generated crate.
- **CLI-004 Paths.** The crate defaults to `.reffect/<entry stem>` beside the entry (`--crate` overrides). `build` copies the binary to `--out`, default `<entry stem>` (`.exe` on Windows) in the working directory. `--release` selects the release profile, as in Cargo; the default is debug.
- **CLI-005 Commands.** `check <entry>` runs the compile effect and reports diagnostics, without Cargo. `build <entry>` compiles, syncs, fetches, builds and copies the binary. `run <entry> [-- args]` builds, then runs the binary with inherited stdio and forwards its exit code. `dev`, `emit` and `inspect` stay open.
- **CLI-006 Diagnostics.** A `CompileError` prints one line per diagnostic, `file:line:column code: message` when it has a primary location and `path code: message` otherwise; a `CargoError` prints the Cargo message and its rendered native diagnostics. Either exits 1. A JSON report is open.
- **CLI-007 Launcher.** `packages/reffect/bin/reffect.js` re-executes Node with `--experimental-transform-types` on `src/cli.ts`, because the package ships TypeScript sources. It goes once the package ships compiled JavaScript.

## Acceptance

1. `reffect build examples/rpc/server.ts` produces a binary that prints the ready record; the stock client gets `sum=0` from it.
2. A second `build` after no change rewrites nothing and Cargo reports no recompilation of dependencies; a changed artifact replaces changed files and removes stale ones.
3. `sync` refuses a non-empty directory it did not write; a manifest naming an unsafe path is refused.
4. `check` on an entry that the compiler refuses exits 1 with the diagnostic code; on a valid entry it exits 0.
5. An entry without a usable default export fails with a message naming the contract.

## Open

- `dev` (watch and restart), `emit`, `inspect`, a JSON diagnostic report.
- Entries whose compile needs more than the Node platform services (for example a configured database URL) take configuration through `Config` today; a CLI flag for it is open.
