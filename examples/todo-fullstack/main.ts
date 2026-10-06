/**
 * The milestone 9 showcase: one native executable serving todo-remote's app over SQLite.
 * It renders the first screen and answers Effect RPC, Remote reads, queries, mutations and Live.
 * The browser app is todo-remote's own (`examples/todo-remote/web`), which hydrates the page and
 * resumes from the reads the server made.
 *
 * vp exec node --experimental-transform-types examples/todo-fullstack/main.ts [--port 8787]
 *   [--database todos.db | --postgres postgres://user:password@host/db] [--auth] [--binary]
 *
 * With `--binary`, RPC is SchemaBinary (`RpcSerialization.layerSchemaBinary`) instead of NDJSON;
 * the browser app is then started with `TODO_REMOTE_RPC=schema-binary`, as printed.
 *
 * With `--postgres`, the server runs on that Postgres database instead: the todos table is made
 * and seeded there when it does not exist yet, and an existing one is kept.
 *
 * With `--auth`, pages and RPC need a principal: the browser signs in on a login page with the
 * token printed at start (or TODO_TOKEN), which becomes an HttpOnly session cookie (#4).
 *
 * Without `--database`, a fresh database seeded with the example's rows is made in a temporary
 * directory. The server reads its URL from REFFECT_DATABASE_URL, never from the compiled code.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { NodeServices } from "@effect/platform-node";
import { CargoApi } from "../../packages/reffect/src/index.ts";
import { seed, seedPostgres, sqliteUrl } from "./db.ts";
import { CREDENTIALS_ENV, DATABASE_URL_ENV, compileShowcase } from "./server.ts";

const option = (name: string) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const port = option("--port") ?? "8787";
const auth = process.argv.includes("--auth");
const serialization = process.argv.includes("--binary") ? "schema-binary" : "ndjson";
// The one configured token: given, or fresh each run; it reaches the server only through its env.
const token = process.env.TODO_TOKEN ?? randomBytes(24).toString("base64url");

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-todo-fullstack-" });
      const postgres = option("--postgres");
      const given = option("--database");
      const database = given === undefined ? `${parent}/todos.db` : resolve(given);
      if (postgres !== undefined) yield* Effect.promise(() => seedPostgres(postgres));
      else if (given === undefined || !existsSync(database)) seed(database);
      const databaseUrl = postgres ?? sqliteUrl(database);
      const template = yield* fs.readFileString(
        `${import.meta.dirname}/../todo-remote/web/index.html`,
      );
      const loginPage = auth
        ? yield* fs.readFileString(`${import.meta.dirname}/login.html`)
        : undefined;
      const directory = yield* CargoApi.write(
        yield* compileShowcase(template, {
          ...(loginPage === undefined ? {} : { loginPage }),
          ...(postgres === undefined ? {} : { dialect: "postgres" as const }),
          serialization,
        }),
        `${parent}/server`,
      );
      yield* CargoApi.fetch(directory);
      yield* CargoApi.build(directory);
      const server = yield* ChildProcess.make(
        `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
        ["--port", port],
        {
          env: {
            [DATABASE_URL_ENV]: databaseUrl,
            ...(auth ? { [CREDENTIALS_ENV]: JSON.stringify([{ token, principal: "1" }]) } : {}),
          },
          extendEnv: true,
        },
      );
      yield* Stream.runDrain(server.stderr).pipe(Effect.forkScoped);
      const ready = yield* Stream.runHead(Stream.splitLines(Stream.decodeText(server.stdout))).pipe(
        Effect.timeout("10 seconds"),
      );
      if (!Option.isSome(ready)) throw new Error("Missing server ready record");
      const { address } = Schema.decodeUnknownSync(
        Schema.Struct({ schema: Schema.Literal("reffect.rpc.ready@1"), address: Schema.String }),
      )(JSON.parse(ready.value));
      // The Postgres URL may hold a password, so only the dialect is printed for it.
      const over = postgres === undefined ? database : "Postgres";
      console.log(`todo-fullstack: http://${address} over ${over} (Ctrl-C stops it)`);
      if (auth) console.log(`sign in with token: ${token}`);
      const rpc = serialization === "schema-binary" ? " TODO_REMOTE_RPC=schema-binary" : "";
      console.log(`browser: TODO_REMOTE_PORT=${port}${rpc} vp dev examples/todo-remote/web`);
      return yield* Effect.never;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
