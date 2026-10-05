/**
 * Page inputs from the URL (docs/research/ssr-data.md): a view's query input is a pure R function
 * of the page's URL. Natively the page fills its planned request's `input` from each request's URL;
 * the reference is upstream `handleRequest` around `renderToString` whose `init` derives the same
 * input from the request URL, and the browser's replay answers that request and nothing more.
 */
import { request as httpRequest } from "node:http";
import { Effect, Exit, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { NodeServices } from "@effect/platform-node";
import { Rendered, handleRequest, renderToString } from "foldkit/experimental/server";
import { defineMessageUnion } from "foldkit/message";
import { Entity, Expr, Order } from "foldkit-entity";
import { Query, Remote, RemoteRpc } from "foldkit-remote";
import { RemoteServer } from "foldkit-remote-server";
import { Surface } from "foldkit-surface";
import { expect, test } from "vite-plus/test";
import { CargoApi, CompileError, NativeRemote, R } from "../src/index.ts";
import { RemoteResume, planPage, record, replay } from "../src/remote-resume.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { BUILD_ID, Page, todoDocument, todoView } from "./fixtures/ssr-todos.ts";

const Task = Entity.define(
  "Task",
  Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    done: Schema.Boolean,
    status: Schema.String,
  }),
);
const ByStatus = Query.define("ByStatus", { status: Schema.String }, ({ input }) =>
  Query.from(Task).pipe(
    Query.where(Expr.eq(Task.fields.status, input.status)),
    Query.orderBy(Order.asc(Task.fields.title)),
  ),
);
const Model = Schema.Struct({ remote: Remote.Model });
const App = Surface.application({ Model, Message: defineMessageUnion({ ...Remote.messages }) });
const Data = Remote.make({ model: App.model.remote, entities: [Task], queries: [ByStatus] });
const initial: typeof Model.Type = { remote: Remote.initial };
const rows = {
  Task: [
    { id: "a", title: "Plan the page", done: true, status: "open" },
    { id: "b", title: "Read the URL", done: false, status: "open" },
    { id: "c", title: "Ship it", done: true, status: "closed" },
  ],
};
const select = Entity.select(Task, { id: true, title: true, done: true });
const projection = (input: { readonly status: string }) =>
  Data.query(ByStatus, input, { select, first: 20 });

// The view's input: `?status=`, `open` when absent. Upstream's init computes the same in TS.
const Input = R.Struct({ status: R.String });
const statusOf = R.fn([R.String], Input, (url) =>
  Input.make({
    status: R.Url.searchParam(url, "status").pipe(
      R.UndefinedOr.match({
        onUndefined: () => R.String.literal("open"),
        onDefined: (value) => value,
      }),
    ),
  }),
);
const statusFromUrl = (url: string) => ({
  status: new URL(url).searchParams.get("status") ?? "open",
});

const origin = "http://reffect.test";
const plan = planPage(Data, initial, { tasks: { input: statusOf, projection } }, { origin });
const template =
  '<!doctype html><html lang="en"><head><title>Placeholder</title></head>' +
  '<body><div id="root"></div></body></html>';
const group = RemoteRpc.omit("FoldkitRemoteMutate", "FoldkitRemoteLive");

const Flags = R.Struct({ remote: R.Unknown });
const TodoItem = R.Struct({ id: R.String, title: R.String, done: R.Bool });
const PageRequest = R.Struct({
  url: R.String,
  remote: R.Unknown,
  views: NativeRemote.pageViews(plan),
});
const page = R.fn([PageRequest], Page, (request) =>
  R.Html.renderToString(
    {
      init: () =>
        R.Struct({ heading: R.String, todos: R.Array(TodoItem) }).make({
          heading: R.Struct.get(request, "url"),
          todos: request.pipe(R.Struct.get("views"), R.Struct.get("tasks"), R.Struct.get("items")),
        }),
      view: todoDocument,
    },
    { buildId: BUILD_ID, flags: Flags.make({ remote: R.Struct.get(request, "remote") }) },
  ),
);
const FlagsSchema = Schema.Struct({ remote: RemoteResume });
const activeAt = (url: string) => ({
  tasks: Data.active("ByStatus", () => Option.some(projection(statusFromUrl(url)))),
});

const upstream = async (target: string, now: number) => {
  const url = `${origin}${target}`;
  const [, exchanges] = await Effect.runPromise(
    record(Data.satisfy(initial, activeAt(url), { now: () => now })).pipe(
      Effect.provide(RemoteServer.memory({ domain: Data, rows }).layer),
    ),
  );
  const response = await handleRequest(new Request(url), {
    template,
    renderPage: async (request) =>
      Rendered(
        await Effect.runPromise(
          renderToString(
            {
              Flags: FlagsSchema,
              init: (flags: typeof FlagsSchema.Type) => {
                const model = Effect.runSync(
                  Data.satisfy(initial, activeAt(request.url), {
                    now: () => flags.remote.now,
                  }).pipe(Effect.provide(replay(flags.remote.exchanges))),
                );
                const read = projection(statusFromUrl(request.url)).read(model);
                return {
                  model: {
                    heading: request.url,
                    todos: read._tag === "Ready" ? [...read.value.items] : [],
                  },
                };
              },
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
const flagsOf = (body: string) => {
  const payload = /<script type="application\/json" data-foldkit-flags="app">(.*?)<\/script>/s.exec(
    body,
  );
  if (!payload) throw new Error("Missing Flags payload");
  return Schema.decodeUnknownSync(Schema.toCodecJson(FlagsSchema))(JSON.parse(payload[1]!));
};

test("a templated view is planned at the origin's root, and an ill-typed input is refused", async () => {
  expect(plan.reads).toEqual([
    {
      _tag: "Query",
      request: expect.objectContaining({ query: "ByStatus", input: { status: "open" } }),
    },
  ]);
  expect(plan.views.tasks.input).toBe(statusOf);
  // A projection that does not accept what the input returns is a type error at the view.
  const byTerm = (input: { readonly term: string }) =>
    Data.query(ByStatus, { status: input.term }, { select, first: 20 });
  // @ts-expect-error the input returns { status }, not { term }
  planPage(Data, initial, { tasks: { input: statusOf, projection: byTerm } }, { origin });
  // The input must return the query's own Input.
  const wrong = R.fn([R.String], R.Struct({ state: R.String }), (url) =>
    R.Struct({ state: R.String }).make({ state: R.Url.pathname(url) }),
  );
  const refused = await Effect.runPromise(
    NativeRemote.compile(group, {
      domain: Data,
      rows,
      pages: {
        template,
        render: page,
        origin,
        remote: { reads: plan.reads, views: { tasks: { ...plan.views.tasks, input: wrong } } },
      },
    }).pipe(Effect.flip),
  );
  expect(refused).toBeInstanceOf(CompileError);
  expect(refused.message).toContain("ByStatus's Input");
});

test(
  "a native page reads the query its URL selects, renders as upstream, and resumes from replay",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-page-input-" });
          const artifact = yield* NativeRemote.compile(group, {
            domain: Data,
            rows,
            pages: { template, render: page, origin, remote: plan },
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

          const bodies: Array<string> = [];
          for (const target of ["/tasks", "/tasks?status=closed", "/tasks?status=a+b"]) {
            const native = yield* Effect.promise(() => send(address, target));
            const flags = flagsOf(native.body);
            const expected = yield* Effect.promise(() => upstream(target, flags.remote.now));
            expect(native, target).toEqual(expected);
            bodies.push(native.body);

            // The browser's init at the same URL: the replay holds exactly the request it makes.
            const url = `${origin}${target}`;
            expect(flags.remote.exchanges.map((exchange) => exchange.request)).toEqual([
              expect.objectContaining({ input: statusFromUrl(url) }),
            ]);
            const resumed = Effect.runSyncExit(
              Data.satisfy(initial, activeAt(url), { now: () => flags.remote.now }).pipe(
                Effect.provide(replay(flags.remote.exchanges)),
              ),
            );
            if (!Exit.isSuccess(resumed)) throw new Error(String(resumed.cause));
            expect(projection(statusFromUrl(url)).read(resumed.value)).toMatchObject({
              _tag: "Ready",
            });
          }
          // Two URLs, two lists: the default selects the open tasks, `?status=closed` the other.
          expect(bodies[0]).toContain("Read the URL");
          expect(bodies[0]).not.toContain("Ship it");
          expect(bodies[1]).toContain("Ship it");
          expect(bodies[1]).not.toContain("Read the URL");
          expect(bodies[2]).not.toContain("Ship it");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
