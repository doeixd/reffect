/**
 * Page inputs from the URL and get views (docs/research/ssr-data.md): a view's query input, and a
 * get view's id, are pure R functions of the page's URL. Natively the page fills its planned
 * requests from each request's URL; the reference is upstream `handleRequest` around
 * `renderToString` whose `init` derives the same from the request URL, and the browser's replay
 * answers those requests and nothing more.
 */
import { request as httpRequest } from "node:http";
import { Effect, Exit, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { NodeServices } from "@effect/platform-node";
import { Rendered, handleRequest, renderToString } from "foldkit/experimental/server";
import { defineMessageUnion } from "foldkit/message";
import { Entity, Expr, Order } from "foldkit-entity";
import { Query, Remote, RemoteData, RemoteRpc } from "foldkit-remote";
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

// The get view's id: `?id=`, `a` when absent.
const named = Entity.select(Task, { title: true });
const idOf = R.fn([R.String], R.String, (url) =>
  R.Url.searchParam(url, "id").pipe(
    R.UndefinedOr.match({ onUndefined: () => R.String.literal("a"), onDefined: (id) => id }),
  ),
);
const idFromUrl = (url: string) => new URL(url).searchParams.get("id") ?? "a";

const origin = "http://reffect.test";
const plan = planPage(
  Data,
  initial,
  { tasks: { input: statusOf, projection }, task: { get: named, id: idOf } },
  { origin },
);
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
          // The heading is the selected task's title, as upstream's RemoteData match reads it.
          heading: request.pipe(
            R.Struct.get("views"),
            R.Struct.get("task"),
            R.Match.valueTags({
              Ready: (ready) => ready.pipe(R.Struct.get("value"), R.Struct.get("title")),
              NotFound: () => R.String.literal("Not found"),
            }),
          ),
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
  task: Data.active("Task", () => Option.some(Data.get(named, idFromUrl(url)))),
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
                const task = Data.get(named, idFromUrl(request.url)).read(model);
                return {
                  model: {
                    heading: RemoteData.match(task, {
                      Ready: (value) => value.title,
                      NotFound: () => "Not found",
                      Initial: () => "Unsettled",
                      Loading: () => "Unsettled",
                      Refreshing: () => "Unsettled",
                      Failed: () => "Unsettled",
                    }),
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

test("templated views are planned at the origin's root, and ill-typed inputs are refused", async () => {
  expect(plan.reads).toEqual([
    {
      _tag: "Query",
      request: expect.objectContaining({ query: "ByStatus", input: { status: "open" } }),
    },
    {
      _tag: "Read",
      request: expect.objectContaining({
        requests: [{ entity: "Task", fields: ["title"], id: "a" }],
      }),
    },
  ]);
  expect(plan.views.tasks.input).toBe(statusOf);
  expect(plan.views.task).toMatchObject({ _tag: "Get", read: 1, id: idOf });
  // The view the render reads is R.Remote.Data of the selection.
  expect(
    R.Struct({
      tasks: R.Remote.Page(TodoItem),
      task: R.Remote.Data(R.Struct({ title: R.String })),
    }).id,
  ).toBe(NativeRemote.pageViews(plan).id);
  // A projection that does not accept what the input returns is a type error at the view.
  const byTerm = (input: { readonly term: string }) =>
    Data.query(ByStatus, { status: input.term }, { select, first: 20 });
  // Typed only: planning it would run byTerm on { status }.
  void (() =>
    // @ts-expect-error the input returns { status }, not { term }
    planPage(Data, initial, { tasks: { input: statusOf, projection: byTerm } }, { origin }));
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
  // A get's id must be a String of the URL.
  const notText = R.fn([R.String], R.Bool, () => R.Bool.literal(true));
  const refusedId = await Effect.runPromise(
    NativeRemote.compile(group, {
      domain: Data,
      rows,
      pages: {
        template,
        render: page,
        origin,
        remote: {
          reads: plan.reads,
          // A hand-written plan is checked too; the planned view's type already refuses it.
          // @ts-expect-error the id function returns a Bool
          views: { ...plan.views, task: { ...plan.views.task, id: notText } },
        },
      },
    }).pipe(Effect.flip),
  );
  expect(refusedId.message).toContain("A URL id");
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
          // Each URL, and whether its get needs a Read: upstream's planner asks only for what
          // the store lacks, so a task the list already answered is not read again.
          const targets = [
            ["/tasks", false],
            ["/tasks?status=closed&id=c", false],
            ["/tasks?status=a+b", true],
            ["/tasks?id=missing", true],
          ] as const;
          for (const [target, reads] of targets) {
            const native = yield* Effect.promise(() => send(address, target));
            const flags = flagsOf(native.body);
            const expected = yield* Effect.promise(() => upstream(target, flags.remote.now));
            expect(native, target).toEqual(expected);
            bodies.push(native.body);

            // The browser's init at the same URL: the replay holds exactly the request it makes.
            const url = `${origin}${target}`;
            expect(flags.remote.exchanges.map((exchange) => exchange.request)).toEqual([
              expect.objectContaining({ input: statusFromUrl(url) }),
              ...(reads
                ? [
                    expect.objectContaining({
                      requests: [expect.objectContaining({ id: idFromUrl(url) })],
                    }),
                  ]
                : []),
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
            expect(Data.get(named, idFromUrl(url)).read(resumed.value)).toMatchObject({
              _tag: target.endsWith("missing") ? "NotFound" : "Ready",
            });
          }
          // Two URLs, two lists: the default selects the open tasks, `?status=closed` the other.
          expect(bodies[0]).toContain("Read the URL");
          expect(bodies[0]).not.toContain("Ship it");
          expect(bodies[1]).toContain("Ship it");
          expect(bodies[1]).not.toContain("Read the URL");
          expect(bodies[2]).not.toContain("Ship it");
          // The get view: `?id=c` heads the page with its title, a missing id with NotFound's.
          expect(bodies[1]).toContain("<h1>Ship it</h1>");
          expect(bodies[0]).toContain("<h1>Plan the page</h1>");
          expect(bodies[3]).toContain("<h1>Not found</h1>");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
