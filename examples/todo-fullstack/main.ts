/**
 * The milestone 9 showcase: one native executable serving todo-remote's app over SQLite.
 * It renders the first screen and answers Effect RPC, Remote reads, queries, mutations and Live.
 * The browser app is todo-remote's own (`examples/todo-remote/web`), which hydrates the page and
 * resumes from the reads the server made.
 *
 * vp exec node --experimental-transform-types examples/todo-fullstack/main.ts [--port 8787]
 *   [--database todos.db]
 *
 * Without `--database`, a fresh database seeded with the example's rows is made in a temporary
 * directory. The server reads its URL from REFFECT_DATABASE_URL, never from the compiled code.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { NodeServices } from "@effect/platform-node";
import { CargoApi } from "../../packages/reffect/src/index.ts";
import { seed, sqliteUrl } from "./db.ts";
import { DATABASE_URL_ENV, compileShowcase } from "./server.ts";

const option = (name: string) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const port = option("--port") ?? "8787";

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-todo-fullstack-" });
      const given = option("--database");
      const database = given === undefined ? `${parent}/todos.db` : resolve(given);
      if (given === undefined || !existsSync(database)) seed(database);
      const template = yield* fs.readFileString(
        `${import.meta.dirname}/../todo-remote/web/index.html`,
      );
      const directory = yield* CargoApi.write(yield* compileShowcase(template), `${parent}/server`);
      yield* CargoApi.fetch(directory);
      yield* CargoApi.build(directory);
      const server = yield* ChildProcess.make(
        `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
        ["--port", port],
        { env: { [DATABASE_URL_ENV]: sqliteUrl(database) }, extendEnv: true },
      );
      yield* Stream.runDrain(server.stderr).pipe(Effect.forkScoped);
      const ready = yield* Stream.runHead(Stream.splitLines(Stream.decodeText(server.stdout))).pipe(
        Effect.timeout("10 seconds"),
      );
      if (!Option.isSome(ready)) throw new Error("Missing server ready record");
      const { address } = Schema.decodeUnknownSync(
        Schema.Struct({ schema: Schema.Literal("reffect.rpc.ready@1"), address: Schema.String }),
      )(JSON.parse(ready.value));
      console.log(`todo-fullstack: http://${address} over ${database} (Ctrl-C stops it)`);
      console.log(`browser: TODO_REMOTE_PORT=${port} vp dev examples/todo-remote/web`);
      return yield* Effect.never;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
