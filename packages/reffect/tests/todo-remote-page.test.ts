// @vitest-environment happy-dom
/**
 * Milestone 9, M9-4: todo-remote's first screen, rendered by the example's native server. The page
 * equals upstream `handleRequest` around `renderToString` with the browser app's own `init` and
 * `view`, and the stock runtime hydrates it without asking the server for anything.
 */
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { NodeServices } from "@effect/platform-node";
import { Runtime } from "foldkit";
import { Rendered, handleRequest, renderToString } from "foldkit/experimental/server";
import { RemoteClient, RemoteRpc } from "foldkit-remote";
import { RemoteServer } from "foldkit-remote-server";
import { expect, test, vi } from "vite-plus/test";
import { CargoApi, NativeRemote } from "../src/index.ts";
import { record } from "../src/remote-resume.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { Data as DomainData, rows } from "../../../examples/todo-remote/domain.ts";
import { mutations } from "../../../examples/todo-remote/sources.ts";
import { page, reads, views } from "../../../examples/todo-remote/page.ts";
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

/** Upstream: the app's own init and view, with the exchanges upstream's server records. */
const upstream = async (now: number) => {
  const [, exchanges] = await Effect.runPromise(
    record(
      Data.satisfy(
        initial,
        { todos: Data.active("Todos", () => Option.some(list)) },
        {
          now: () => now,
        },
      ),
    ).pipe(Effect.provide(RemoteServer.memory({ domain: DomainData, rows }).layer)),
  );
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
  "todo-remote's first screen renders natively, equals upstream, and hydrates without a fetch",
  async () => {
    const { rendered: native, live } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-todo-page-" });
          // The example's own server: mutations, live and its first screen.
          const artifact = yield* NativeRemote.compile(RemoteRpc, {
            domain: DomainData,
            rows,
            mutations,
            live: true,
            liveSnapshot: true,
            serialization: "ndjson",
            pages: { template, render: page, origin, reads, views },
          });
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.fetch(directory);
          yield* CargoApi.build(directory, "debug");
          const child = yield* ChildProcess.make(
            `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
            ["--port", "0"],
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
          return { rendered, live };
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(native.status).toBe(200);
    expect(live.join("\n")).toContain('"values":{"done":true}');
    const payload = /data-foldkit-flags="app">(.*?)<\/script>/s.exec(native.body);
    const flags = Schema.decodeUnknownSync(Schema.toCodecJson(Flags))(
      JSON.parse(payload?.[1] ?? ""),
    );
    expect(native).toEqual(await upstream(flags.remote.now));
    expect(native.body).toContain("Compile it natively");

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
