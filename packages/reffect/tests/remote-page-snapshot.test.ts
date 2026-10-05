/**
 * One read transaction per page (docs/research/ssr-data.md): a SQL page's reads see one snapshot.
 * The page lists projects, then gets a user. Another connection holds an exclusive lock on
 * `users` with an uncommitted rename, and commits once the page waits on that lock. The page must
 * show the name from its snapshot, while a pool read under the same interleaving shows the rename.
 */
import { request as httpRequest } from "node:http";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { NodeServices } from "@effect/platform-node";
import { defineMessageUnion } from "foldkit/message";
import { Entity } from "foldkit-entity";
import { Remote, RemoteRpc } from "foldkit-remote";
import { Surface } from "foldkit-surface";
import pg from "pg";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRemote, R } from "../src/index.ts";
import { planPage } from "../src/remote-resume.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { BUILD_ID, Page, todoDocument } from "./fixtures/ssr-todos.ts";
import {
  ByStatus,
  Project,
  Search,
  domainEntities,
  pgBound,
} from "./fixtures/remote-sql-domain.ts";
import { postgresBackend } from "./fixtures/sql-database.ts";

const Model = Schema.Struct({ remote: Remote.Model });
const App = Surface.application({ Model, Message: defineMessageUnion({ ...Remote.messages }) });
const Data = Remote.make({
  model: App.model.remote,
  entities: [domainEntities.User, Project],
  queries: [ByStatus, Search],
});
const initial: typeof Model.Type = { remote: Remote.initial };
const plan = planPage(Data, initial, {
  projects: Data.query(
    ByStatus,
    { status: "active" },
    { select: Entity.select(Project, { id: true, name: true, done: true }), first: 3 },
  ),
  owner: { get: Entity.select(domainEntities.User, { name: true }), id: "u1" },
});
const template =
  '<!doctype html><html lang="en"><head><title>Placeholder</title></head>' +
  '<body><div id="root"></div></body></html>';
const group = RemoteRpc.omit("FoldkitRemoteMutate", "FoldkitRemoteLive");

const TodoItem = R.Struct({ id: R.String, title: R.String, done: R.Bool });
const PageRequest = R.Struct({ views: NativeRemote.pageViews(plan) });
// The heading is the user's name; the list, the projects read before it.
const page = R.fn([PageRequest], Page, (request) => {
  const views = R.Struct.get(request, "views");
  return R.Html.renderToString(
    todoDocument(
      R.Struct({ heading: R.String, todos: R.Array(TodoItem) }).make({
        heading: views.pipe(
          R.Struct.get("owner"),
          R.Match.valueTags({
            Ready: (ready) => ready.pipe(R.Struct.get("value"), R.Struct.get("name")),
            NotFound: () => R.String.literal("Nobody"),
          }),
        ),
        todos: R.Array.map(views.pipe(R.Struct.get("projects"), R.Struct.get("items")), (item) =>
          TodoItem.make({
            id: R.Struct.get(item, "id"),
            title: R.Struct.get(item, "name"),
            done: R.Struct.get(item, "done"),
          }),
        ),
      }),
    ),
    { buildId: BUILD_ID },
  );
});

const get = (address: string, path: string, body?: string) =>
  new Promise<string>((resolve, reject) => {
    const [host, port] = address.split(":");
    const outgoing = httpRequest(
      { host, port: Number(port), method: body === undefined ? "GET" : "POST", path },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => resolve(text));
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
const readU1 = JSON.stringify({
  _tag: "Request",
  id: "1",
  tag: "FoldkitRemoteRead",
  payload: { version: 4, requests: [{ entity: "User", id: "u1", fields: ["name"] }] },
  headers: [],
});

test.skipIf(postgresBackend.unavailable !== undefined)(
  "a Postgres page reads one snapshot, though a rename commits while it waits",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const open = yield* postgresBackend.databases;
          const db = yield* open("snapshot");
          const parent = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
            prefix: "reffect-page-snapshot-",
          });
          const artifact = yield* NativeRemote.compile(group, {
            domain: Data,
            sql: { dialect: "postgres", bindings: pgBound, databaseUrlEnv: "REFFECT_DATABASE_URL" },
            pages: { template, render: page, remote: plan },
          });
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.fetch(directory);
          yield* CargoApi.build(directory, "debug");
          const child = yield* ChildProcess.make(
            `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
            ["--port", "0"],
            { env: { REFFECT_DATABASE_URL: db.url }, extendEnv: true },
          );
          yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
          const ready = yield* Stream.runHead(
            Stream.splitLines(Stream.decodeText(child.stdout)),
          ).pipe(Effect.timeout("10 seconds"));
          if (!Option.isSome(ready)) throw new Error("Missing ready record");
          const { address } = Schema.decodeUnknownSync(
            Schema.Struct({
              schema: Schema.Literal("reffect.rpc.ready@1"),
              address: Schema.String,
            }),
          )(JSON.parse(ready.value));
          const client = (name: string) =>
            Effect.acquireRelease(
              Effect.promise(async () => {
                const connection = new pg.Client({
                  connectionString: db.url,
                  application_name: name,
                });
                await connection.connect();
                return connection;
              }),
              (connection) => Effect.promise(() => connection.end().catch(() => undefined)),
            );
          const locker = yield* client("locker");
          const watcher = yield* client("watcher");

          // Renames u1 under an exclusive lock, lets `request` start and wait on that lock,
          // then commits; `request`'s answer.
          const renameDuring = (name: string, request: () => Promise<string>) =>
            Effect.promise(async () => {
              await locker.query("begin");
              await locker.query("lock table users in access exclusive mode");
              await locker.query("update users set display_name = $1 where id = 'u1'", [name]);
              const answer = request();
              for (let attempt = 0; ; attempt++) {
                const waiting = await watcher.query(
                  "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%users%' and application_name <> 'locker'",
                );
                if (waiting.rows[0].n > 0) break;
                if (attempt > 200) throw new Error("The request never waited on the lock");
                await new Promise((resolve) => setTimeout(resolve, 25));
              }
              await locker.query("commit");
              return answer;
            });

          const before = yield* Effect.promise(() => get(address, "/"));
          expect(before).toContain("<h1>Ada</h1>");
          expect(before).toContain("Apollo");

          // The page read the projects before it waited, so its snapshot predates the rename.
          const during = yield* renameDuring("Renamed", () => get(address, "/"));
          expect(during).toContain("<h1>Ada</h1>");
          expect(during).not.toContain("Renamed");
          // The next page has a new snapshot.
          expect(yield* Effect.promise(() => get(address, "/"))).toContain("<h1>Renamed</h1>");

          // Control: a pool read, under the same interleaving, sees the rename it waited for.
          const read = yield* renameDuring("Again", () => get(address, "/rpc", readU1));
          expect(read).toContain('"name":"Again"');
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 300000,
);
