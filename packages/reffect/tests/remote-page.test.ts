/**
 * Milestone 9, M9-3 step 2a: a native page reads its Remote data through the server's own engine
 * and carries the exchanges in its Flags. The reference is upstream `handleRequest` around
 * `renderToString` whose Flags hold the exchanges `record` keeps while `Data.satisfy` runs
 * against `RemoteServer.memory`; the browser's `replay` then resumes without a fetch.
 */
import { request as httpRequest } from "node:http";
import { Effect, Exit, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { NodeServices } from "@effect/platform-node";
import { Rendered, handleRequest, renderToString } from "foldkit/experimental/server";
import { Entity } from "foldkit-entity";
import { RemoteRpc } from "foldkit-remote";
import { RemoteServer } from "foldkit-remote-server";
import { expect, test } from "vite-plus/test";
import { CargoApi, CompileError, NativeRemote, R } from "../src/index.ts";
import type { Expr } from "../src/index.ts";
import { RemoteResume, planReads, record, replay } from "../src/remote-resume.ts";
import { Data, Todo, Todos, initial, rows } from "../../../examples/todo-remote/domain.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { BUILD_ID, Page, todoDocument, todoView } from "./fixtures/ssr-todos.ts";

const list = Data.query(
  Todos,
  {},
  { select: Entity.select(Todo, { id: true, title: true, done: true }) },
);
const active = { todos: Data.active("Todos", () => Option.some(list)) };
const reads = planReads(Data.satisfy(initial, active));
const origin = "http://reffect.test";
const template =
  '<!doctype html><html lang="en"><head><title>Placeholder</title></head>' +
  '<body><div id="root"></div></body></html>';
const group = RemoteRpc.omit("FoldkitRemoteMutate", "FoldkitRemoteLive");

// The page's view does not read the data yet (step 2b); its Flags carry it for the browser.
const Flags = R.Struct({ remote: R.Unknown });
const init = (url: Expr<string>) =>
  R.Struct({
    heading: R.String,
    todos: R.Array(R.Struct({ id: R.String, title: R.String, done: R.Bool })),
  }).make({
    heading: url,
    todos: R.Array.empty(R.Struct({ id: R.String, title: R.String, done: R.Bool })),
  });
const page = R.fn([R.String, R.Unknown], Page, (url, remote) =>
  R.Html.renderToString(
    { init: () => init(url), view: todoDocument },
    { buildId: BUILD_ID, flags: Flags.make({ remote }) },
  ),
);
const FlagsSchema = Schema.Struct({ remote: RemoteResume });

/** Upstream: satisfy against the reference server, recorded, in the same Flags. */
const upstream = async (target: string, now: number) => {
  const [, exchanges] = await Effect.runPromise(
    record(Data.satisfy(initial, active, { now: () => now })).pipe(
      Effect.provide(RemoteServer.memory({ domain: Data, rows }).layer),
    ),
  );
  const response = await handleRequest(new Request(`${origin}${target}`), {
    template,
    renderPage: async (request) =>
      Rendered(
        await Effect.runPromise(
          renderToString(
            {
              Flags: FlagsSchema,
              init: () => ({ model: { heading: request.url, todos: [] } }),
              view: R.Html.toFoldkitView(todoView),
            },
            { flags: { remote: { now, exchanges } }, buildId: BUILD_ID },
          ),
        ),
      ),
  });
  return { status: response.status, body: await response.text() };
};
const send = (address: string, target: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const [host, port] = address.split(":");
    const outgoing = httpRequest(
      { host, port: Number(port), method: "GET", path: target },
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
/** The Flags a page carries, as the hydrating client parses them. */
const flagsOf = (body: string) => {
  const payload = /<script type="application\/json" data-foldkit-flags="app">(.*?)<\/script>/s.exec(
    body,
  );
  if (!payload) throw new Error("Missing Flags payload");
  return Schema.decodeUnknownSync(Schema.toCodecJson(FlagsSchema))(JSON.parse(payload[1]!));
};

test("planned page reads are the satisfy's first pass, and relations are refused", async () => {
  expect(reads.map((read) => read._tag)).toEqual(["Query"]);
  const refused = await Effect.runPromise(
    NativeRemote.compile(group, {
      domain: Data,
      rows,
      pages: {
        template,
        render: page,
        reads: [{ _tag: "Query", request: { query: "Nope", input: {}, window: {} } }],
      },
    }).pipe(Effect.flip),
  );
  expect(refused).toBeInstanceOf(CompileError);
  expect(refused.message).toContain("domain's");
});

test(
  "a native page records its reads, renders as upstream, and the browser resumes without a fetch",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-remote-page-" });
          const artifact = yield* NativeRemote.compile(group, {
            domain: Data,
            rows,
            pages: { template, render: page, origin, reads },
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

          const native = yield* Effect.promise(() => send(address, "/todos"));
          const flags = flagsOf(native.body);
          // Upstream with the native render's clock: the same bytes, Flags included.
          const expected = yield* Effect.promise(() => upstream("/todos", flags.remote.now));
          expect(native).toEqual(expected);

          // The browser's init: the replay gives the server's data and plans no fetch.
          const resumed = Effect.runSyncExit(
            Data.satisfy(initial, active, { now: () => flags.remote.now }).pipe(
              Effect.provide(replay(flags.remote.exchanges)),
            ),
          );
          if (!Exit.isSuccess(resumed)) throw new Error(String(resumed.cause));
          const read = list.read(resumed.value);
          expect(read).toMatchObject({ _tag: "Ready" });
          expect(
            Data.subscriptions(active)["todos.read"].modelToDependencies(resumed.value),
          ).toMatchObject({ requirements: [], queries: [] });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
