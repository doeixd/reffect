// @vitest-environment happy-dom
/**
 * Milestone 9, M9-5: the showcase, one native executable over SQLite. Its first screen equals
 * upstream `handleRequest` around `renderToString` with the browser app's own `init` and `view`
 * (upstream reads the same rows from its memory backend), the stock runtime hydrates it without
 * asking for anything, a mutation commits through SQL, reaches a fresh Live subscription through
 * the snapshot, and survives into the next page render.
 */
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { NodeServices } from "@effect/platform-node";
import { Runtime } from "foldkit";
import { Rendered, handleRequest, renderToString } from "foldkit/experimental/server";
import { RemoteClient } from "foldkit-remote";
import { RemoteServer } from "foldkit-remote-server";
import { databaseLayer, query, source } from "foldkit-remote-drizzle";
import { drizzle } from "drizzle-orm/node-sqlite";
import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vite-plus/test";
import { CargoApi } from "../src/index.ts";
import { record } from "../src/remote-resume.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { Todos } from "../../../examples/todo-remote/domain.ts";
import { DATABASE_URL_ENV, compileShowcase } from "../../../examples/todo-fullstack/server.ts";
import { bindings, seed, sqliteUrl } from "../../../examples/todo-fullstack/db.ts";
import {
  BUILD_ID,
  Data,
  Flags,
  Message,
  Model,
  initial,
  init,
  list,
  subscriptions,
  update,
  view,
} from "../../../examples/todo-remote/web/app.ts";

const origin = "http://reffect.test";
// happy-dom's import.meta.url is not a file URL, so the template is found from the package.
const template = readFileSync(
  resolve(process.cwd(), "../../examples/todo-remote/web/index.html"),
  "utf8",
);

/** The Flags a rendered page carries, as the hydrating client decodes them. */
const flagsOf = (body: string) =>
  Schema.decodeUnknownSync(Schema.toCodecJson(Flags))(
    JSON.parse(/data-foldkit-flags="app">(.*?)<\/script>/s.exec(body)?.[1] ?? ""),
  );
/** A GET with Node's own HTTP client: happy-dom replaces the global fetch. */
const get = (address: string, path: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const [host, port] = address.split(":");
    const outgoing = httpRequest(
      { host, port: Number(port), path, headers: { accept: "text/html" } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });

/** An NDJSON RPC call: the response lines until `done` has what it needs, then the call ends. */
const rpc = (address: string, request: object, done: (lines: ReadonlyArray<string>) => boolean) =>
  new Promise<ReadonlyArray<string>>((resolve, reject) => {
    const [host, port] = address.split(":");
    const lines: Array<string> = [];
    let buffer = "";
    const outgoing = httpRequest(
      {
        host,
        port: Number(port),
        method: "POST",
        path: "/rpc",
        headers: { "content-type": "application/ndjson" },
      },
      (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffer += chunk;
          const parts = buffer.split("\n");
          buffer = parts.pop() ?? "";
          lines.push(...parts.filter((line) => line !== ""));
          if (done(lines)) {
            outgoing.destroy();
            resolve(lines);
          }
        });
        response.on("end", () => resolve(lines));
      },
    );
    outgoing.on("error", (error) => (done(lines) ? resolve(lines) : reject(error)));
    outgoing.end(`${JSON.stringify({ _tag: "Request", headers: [], ...request })}\n`);
  });

/**
 * Upstream: the app's own init and view, with the exchanges upstream's own SQL server records:
 * RemoteServer over foldkit-remote-drizzle's sources, reading the same SQLite file.
 */
const upstream = async (now: number, database: string) => {
  const client = new DatabaseSync(database);
  const layer = databaseLayer(drizzle({ client }));
  const handlers = RemoteServer.handlers(
    RemoteServer.make({
      entities: [source(bindings.Todo)],
      queries: [query(Todos, { entity: bindings.Todo })],
    }),
    undefined,
  );
  const drizzleClient = Layer.succeed(RemoteClient, {
    read: (batch) => handlers.FoldkitRemoteRead(batch).pipe(Effect.provide(layer)),
    query: (request) => handlers.FoldkitRemoteQuery(request).pipe(Effect.provide(layer)),
    mutate: () => Effect.die("the page does not mutate"),
    live: () => Stream.die("the page is not live"),
  });
  const [, exchanges] = await Effect.runPromise(
    record(
      Data.satisfy(
        initial,
        { todos: Data.active("Todos", () => Option.some(list)) },
        {
          now: () => now,
        },
      ),
    ).pipe(Effect.provide(drizzleClient)),
  );
  // Windows keeps an open SQLite file locked, so the scenario's directory could not be removed.
  client.close();
  const response = await handleRequest(
    new Request(`${origin}/`, { headers: { accept: "text/html" } }),
    {
      template,
      renderPage: async () =>
        Rendered(
          await Effect.runPromise(
            renderToString(
              { Flags, init, view },
              { flags: { remote: { now, exchanges } }, buildId: BUILD_ID },
            ),
          ),
        ),
    },
  );
  return { status: response.status, body: await response.text() };
};

test(
  "the SQLite showcase renders, resumes, mutates, goes live and persists",
  async () => {
    const {
      rendered: native,
      live,
      after,
      expected,
    } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-todo-fullstack-" });
          const database = `${parent}/todos.db`;
          seed(database);
          const artifact = yield* compileShowcase(template, origin);
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.fetch(directory);
          yield* CargoApi.build(directory, "debug");
          const child = yield* ChildProcess.make(
            `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
            ["--port", "0"],
            { env: { [DATABASE_URL_ENV]: sqliteUrl(database) }, extendEnv: true },
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
          const rendered = yield* Effect.promise(() => get(address, "/"));
          // Upstream reads the same file now, before the toggle below commits.
          const now = flagsOf(rendered.body).remote.now;
          const expected = yield* Effect.promise(() => upstream(now, database));
          // LIVE-015: t2 changes after the render and before the browser subscribes. The fresh
          // subscription's snapshot still carries it, where liveHub alone would send nothing.
          yield* Effect.promise(() =>
            rpc(
              address,
              {
                id: "1",
                tag: "FoldkitRemoteMutate",
                payload: { requestId: "r1", mutation: "ToggleTodo", input: { id: "t2" } },
              },
              (lines) => lines.some((line) => line.includes('"Exit"')),
            ),
          );
          const live = yield* Effect.promise(() =>
            rpc(
              address,
              {
                id: "2",
                tag: "FoldkitRemoteLive",
                payload: {
                  version: 4,
                  requirements: [{ entity: "Todo", id: "t2", fields: ["done"] }],
                  after: 0,
                },
              },
              (lines) => lines.some((line) => line.includes("EntityPatched")),
            ),
          ).pipe(Effect.timeout("10 seconds"));
          // The committed toggle is in SQLite: the next render shows it.
          const after = yield* Effect.promise(() => get(address, "/"));
          return { rendered, live, after, expected };
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(native.status).toBe(200);
    expect(live.join("\n")).toContain('"values":{"done":true}');
    expect(native).toEqual(expected);
    expect(native.body).toContain("Compile it natively");
    expect(native.body).toContain('<li data-id="t2" class="open">');
    expect(after.body).toContain('<li data-id="t2" class="done">');

    // The stock runtime adopts the page; its Remote client must never be asked to read or query.
    // The entry script is the app this test starts itself.
    document.body.innerHTML = (/<body>(.*)<\/body>/s.exec(native.body)?.[1] ?? "").replace(
      /<script type="module"[^>]*><\/script>/,
      "",
    );
    const serverItems = Array.from(document.querySelectorAll("li"));
    expect(serverItems).toHaveLength(2);
    const asked: Array<string> = [];
    const application = Runtime.makeApplication({
      Model,
      Flags,
      init,
      update,
      view,
      subscriptions,
      container: document.getElementById("root"),
      resources: Layer.succeed(RemoteClient, {
        query: (request) =>
          Effect.sync(() => asked.push(`query ${request.query}`)).pipe(
            Effect.andThen(Effect.never),
          ),
        read: (batch) =>
          Effect.sync(() => asked.push(`read ${batch.requests.length}`)).pipe(
            Effect.andThen(Effect.never),
          ),
        mutate: () => Effect.never,
        live: () => Stream.never,
      }),
      devTools: { Message },
    });
    Runtime.hydrate(application, { buildId: BUILD_ID });
    await vi.waitFor(() => expect(document.querySelector("[data-foldkit-app]")).toBeNull());
    // Give subscriptions their first turn: a read entry with something to fetch would ask now.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(asked).toEqual([]);
    expect(Array.from(document.querySelectorAll("li"))).toEqual(serverItems);
  },
  nativeTestBudget(0) + 240000,
);
