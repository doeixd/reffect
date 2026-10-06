/**
 * The `reffect` CLI (docs/research/cli.md): `CargoApi.sync` owns its crate directory and keeps
 * unchanged files; the launcher's `check` reports diagnostics with exit codes; `build` produces a
 * server binary the stock client calls, and `run` forwards arguments and the exit code.
 */
import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcess } from "effect/process";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi } from "../src/index.ts";
import { Arithmetic } from "../../../examples/rpc/contract.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const launcher = fileURLToPath(new URL("../bin/reffect.js", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`fixtures/cli/${name}`, import.meta.url));
const example = fileURLToPath(new URL("../../../examples/rpc/server.ts", import.meta.url));
const exe = process.platform === "win32" ? ".exe" : "";

/** Runs the launcher to completion: its output and exit code. */
const reffect = (args: readonly string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* ChildProcess.make(process.execPath, [launcher, ...args]);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, exitCode };
    }),
  );

const artifact = (lib: string, auxiliaryFiles?: Record<string, string>) => ({
  files: {
    "Cargo.toml": '[package]\nname = "reffect_generated"\n',
    "src/lib.rs": lib,
    "src/main.rs": "fn main() {}\n",
  },
  ...(auxiliaryFiles === undefined ? {} : { auxiliaryFiles }),
});

test("sync rewrites only changed files, removes stale ones and refuses directories it does not own", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-sync-" });
        const crate = path.join(parent, "crate");
        yield* CargoApi.sync(artifact("pub fn a() {}\n", { "src/extra.rs": "// extra\n" }), crate);
        expect(yield* fs.readFileString(path.join(crate, "src/extra.rs"))).toBe("// extra\n");
        // Age every file, then sync a changed lib without the extra file.
        const old = new Date("2001-01-01T00:00:00Z");
        for (const name of ["Cargo.toml", "src/lib.rs", "src/main.rs"])
          yield* fs.utimes(path.join(crate, name), old, old);
        yield* fs.makeDirectory(path.join(crate, "target"));
        yield* fs.writeFileString(path.join(crate, "target/kept"), "build output");
        yield* CargoApi.sync(artifact("pub fn b() {}\n"), crate);
        const mtime = (name: string) =>
          fs.stat(path.join(crate, name)).pipe(Effect.map((info) => Option.getOrThrow(info.mtime)));
        expect((yield* mtime("src/main.rs")).getTime()).toBe(old.getTime());
        expect((yield* mtime("src/lib.rs")).getTime()).toBeGreaterThan(old.getTime());
        expect(yield* fs.readFileString(path.join(crate, "src/lib.rs"))).toBe("pub fn b() {}\n");
        expect(yield* fs.exists(path.join(crate, "src/extra.rs"))).toBe(false);
        expect(yield* fs.readFileString(path.join(crate, "target/kept"))).toBe("build output");

        // A directory with files but no record of an earlier sync is not overwritten.
        const foreign = path.join(parent, "foreign");
        yield* fs.makeDirectory(foreign);
        yield* fs.writeFileString(path.join(foreign, "notes.txt"), "mine");
        const refused = yield* Effect.flip(CargoApi.sync(artifact("pub fn a() {}\n"), foreign));
        expect(refused.message).toContain("not written by reffect");
        expect(yield* fs.exists(path.join(foreign, "Cargo.toml"))).toBe(false);

        // A record naming a path outside the crate is refused before anything is removed.
        yield* fs.writeFileString(
          path.join(crate, "reffect-files.json"),
          JSON.stringify({ schema: "reffect.crate@1", files: ["../outside"] }),
        );
        const escaped = yield* Effect.flip(CargoApi.sync(artifact("pub fn a() {}\n"), crate));
        expect(escaped.message).toContain("outside the crate");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

test("check reports a valid entry, a refused compile and a module that is not an entry", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const ok = yield* reffect(["check", example]);
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout).toContain(": ok");
      const refused = yield* reffect(["check", fixture("refused.ts")]);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("limits.batch");
      expect(refused.stderr).toContain("Limits are positive safe integers");
      const other = yield* reffect(["check", fixture("not-an-entry.ts")]);
      expect(other.exitCode).toBe(1);
      expect(other.stderr).toContain("default export must be a compile effect");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}, 120000);

test(
  "build produces a server binary the stock client calls; run forwards arguments and exit code",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-cli-" });
          const crate = path.join(parent, "crate");
          const out = path.join(parent, `arith${exe}`);
          const built = yield* reffect(["build", example, "--crate", crate, "--out", out]);
          expect(built.exitCode, built.stderr).toBe(0);
          expect(built.stdout.trim()).toBe(out);

          const server = yield* ChildProcess.make(out, ["--port", "0"]);
          yield* Stream.runDrain(server.stderr).pipe(Effect.forkScoped);
          const ready = yield* Stream.runHead(
            Stream.splitLines(Stream.decodeText(server.stdout)),
          ).pipe(Effect.timeout("10 seconds"));
          if (!Option.isSome(ready)) throw new Error("Missing ready record");
          const { address } = Schema.decodeUnknownSync(
            Schema.Struct({
              schema: Schema.Literal("reffect.rpc.ready@1"),
              address: Schema.String,
            }),
          )(JSON.parse(ready.value));
          const client = yield* RpcClient.make(Arithmetic).pipe(
            Effect.provide(
              RpcClient.layerProtocolHttp({ url: `http://${address}/rpc` }).pipe(
                Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
              ),
            ),
          );
          expect(yield* client.Add({ left: 18446744073709551615n, right: 1n })).toBe(0n);

          // The same crate rebuilds; the server sees the arguments after `--` and its failure
          // becomes the command's exit code.
          const ran = yield* reffect(["run", example, "--crate", crate, "--", "--port", "nope"]);
          expect(ran.exitCode).toBe(1);
          expect(ran.stderr).toContain("ParseIntError");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
