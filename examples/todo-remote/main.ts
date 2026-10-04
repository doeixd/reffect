/**
 * A todo list served by a native Foldkit Remote server. The stock Foldkit `Remote` client reads,
 * mutates and watches it live over Effect RPC. The same session runs against upstream's
 * JavaScript memory backend and live hub (with the same R sources over its own MemoryStore) and
 * must see the same screens.
 */
import { Effect, Fiber, FileSystem, Layer, Match, Option, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcess } from "effect/process";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { Entity } from "foldkit-entity";
import {
  ConnectionChangeSchema,
  NormalizedEntity,
  Remote,
  RemoteClient,
  RemoteRpc,
} from "foldkit-remote";
import type { LiveEvent } from "foldkit-remote";
import { RemoteServer, RemoteServerError } from "foldkit-remote-server";
import type { LiveHub, MemoryStore } from "foldkit-remote-server";
import {
  CargoApi,
  CompileError,
  LiveHubHost,
  NativeRemote,
  Reference,
  RemoteStoreHost,
  memoryStoreApi,
} from "../../packages/reffect/src/index.ts";
import type { NativeRemoteMutation } from "../../packages/reffect/src/index.ts";
import { AddTodo, Data, DeleteTodo, ToggleTodo, Todo, Todos, initial, rows } from "./domain.ts";
import { addTodo, deleteTodo, mutations, toggleTodo } from "./sources.ts";
import { page, reads, views } from "./page.ts";

const list = Data.query(Todos, {}, { select: Entity.select(Todo, { title: true, done: true }) });

/** One line of the list as a screen shows it, or why it shows no list. */
const show = (screen: ReturnType<typeof list.read>): string =>
  Match.value(screen).pipe(
    Match.tag("Ready", ({ value }) =>
      value.items.map((todo) => `${todo.done ? "[x]" : "[ ]"} ${todo.title}`).join("   "),
    ),
    Match.orElse((other) => `(${other._tag})`),
  );

const watched = Data.live(Entity.select(Todo, { title: true, done: true }), "t2");
/** One todo as a screen shows it. */
const showTodo = (screen: ReturnType<typeof watched.read>): string =>
  Match.value(screen).pipe(
    Match.tag("Ready", ({ value }) => `${value.done ? "[x]" : "[ ]"} ${value.title}`),
    Match.orElse((other) => `(${other._tag})`),
  );

/** A live event as a second screen watching the todos would apply it. */
const showLive = (event: LiveEvent): string =>
  Match.value(event).pipe(
    Match.tag(
      "EntityPatched",
      ({ ref, values, cursor }) => `#${cursor} ${ref.id} ${JSON.stringify(values)}`,
    ),
    Match.tag("EntityDeleted", ({ ref, cursor }) => `#${cursor} ${ref.id} deleted`),
    Match.orElse(({ _tag }) => _tag),
  );

/**
 * What a screen does: show the list, add, toggle, delete, refuse an empty title, reload. Meanwhile
 * another screen watches t1 and t2 live, as `Data.live` subscribes.
 */
const session = Effect.gen(function* () {
  const screens: Array<readonly [string, string]> = [];
  const client = yield* RemoteClient;
  const watching = yield* client
    .live({
      requirements: [
        { entity: "Todo", id: "t1", fields: ["title"] },
        { entity: "Todo", id: "t2", fields: ["done"] },
      ],
      after: 0,
    })
    .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
  // A second screen reads t2 through `Data.live`: Remote's own live Subscription entry
  // subscribes, and the Messages it emits fold into that screen's Model (LR-3).
  const entries = Data.subscriptions({
    watching: Data.active("Watching", () => Option.some(watched)),
  });
  const liveEntry = entries["watching.live"];
  const other = yield* Data.prefetch(initial, watched);
  const received = yield* liveEntry
    .dependenciesToStream(liveEntry.modelToDependencies(other))
    .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
  yield* Effect.sleep("200 millis");
  let model = yield* Data.prefetch(initial, list);
  screens.push(["start", show(list.read(model))]);
  model = (yield* Remote.mutateInto(Data, model, AddTodo, { id: "t3", title: "Ship it" }, "r1"))
    .model;
  screens.push(["add t3", show(list.read(model))]);
  model = (yield* Remote.mutateInto(Data, model, ToggleTodo, { id: "t2" }, "r2")).model;
  screens.push(["toggle t2", show(list.read(model))]);
  model = (yield* Remote.mutateInto(Data, model, DeleteTodo, { id: "t1" }, "r3")).model;
  screens.push(["delete t1", show(list.read(model))]);
  const refused = yield* Remote.mutate(AddTodo, { id: "t4", title: "" }, "r4").pipe(Effect.flip);
  screens.push(["add without a title", refused.message]);
  screens.push(["reload", show(list.read(yield* Data.prefetch(initial, list)))]);
  const live = yield* Fiber.join(watching).pipe(Effect.timeout("10 seconds"));
  screens.push(["watched live", [...live].map(showLive).join("   ")]);
  const messages = yield* Fiber.join(received).pipe(Effect.timeout("10 seconds"));
  screens.push([
    "second screen",
    showTodo(
      watched.read([...messages].reduce((model, message) => Data.reduce(model, message), other)),
    ),
  ]);
  return screens;
}).pipe(Effect.scoped);

// The encoded outcome an R source returns, read with upstream's own wire schemas.
const Outcome = Schema.Struct({
  output: Schema.Unknown,
  entities: Schema.optionalKey(Schema.Array(NormalizedEntity)),
  connections: Schema.optionalKey(Schema.Array(ConnectionChangeSchema)),
  deleted: Schema.optionalKey(
    Schema.Array(Schema.Struct({ entity: Schema.String, id: Schema.String })),
  ),
});
// Upstream's memory backend running the same R sources over its own store.
// Upstream's live hub, which the sources signal; set once the memory server exists.
let hub: LiveHub<undefined> | undefined;
const reference =
  (native: NativeRemoteMutation, store: MemoryStore) =>
  ({ input }: { readonly input: unknown }) =>
    Reference.run(native.fn, [input]).pipe(
      Effect.provideService(RemoteStoreHost, memoryStoreApi(store)),
      Effect.provideService(LiveHubHost, {
        changed: (ref, fields) => hub!.changed(ref, fields),
        deleted: (ref) => hub!.deleted(ref),
      }),
      Effect.catch((error) =>
        error instanceof CompileError
          ? Effect.die(error)
          : Effect.fail(
              new RemoteServerError({
                message: Schema.decodeUnknownSync(Schema.Struct({ message: Schema.String }))(error)
                  .message,
              }),
            ),
      ),
      Effect.map(Schema.decodeUnknownSync(Outcome)),
    );
const upstream = RemoteServer.memory({
  domain: Data,
  rows,
  mutations: (store) => [
    RemoteServer.mutation(AddTodo, reference(addTodo, store)),
    RemoteServer.mutation(ToggleTodo, reference(toggleTodo, store)),
    RemoteServer.mutation(DeleteTodo, reference(deleteTodo, store)),
  ],
});
/** Upstream's handlers with its live hub, as the stock client's layer. */
const upstreamLayer = Layer.unwrap(
  Effect.gen(function* () {
    const liveHub = yield* RemoteServer.liveHub([...upstream.server.entities.values()]);
    hub = liveHub;
    return Remote.clientLayer(RemoteServer.handlers(upstream.server, undefined, { live: liveHub }));
  }),
);

/** Compiles, builds and starts the native server; its address once it is listening. */
const startServer = (port: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-todo-remote-" });
    // Live streams need NDJSON: a JSON body would wait for a stream that never ends. The page is
    // the browser app's first screen, rendered natively from the list it reads (M9-4).
    const template = yield* fs.readFileString(`${import.meta.dirname}/web/index.html`);
    const artifact = yield* NativeRemote.compile(RemoteRpc, {
      domain: Data,
      rows,
      mutations,
      live: true,
      serialization: "ndjson",
      pages: { template, render: page, reads, views },
    });
    const directory = yield* CargoApi.write(artifact, `${parent}/server`);
    yield* CargoApi.fetch(directory);
    yield* CargoApi.build(directory);
    const server = yield* ChildProcess.make(
      `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
      ["--port", port],
    );
    yield* Stream.runDrain(server.stderr).pipe(Effect.forkScoped);
    const ready = yield* Stream.runHead(Stream.splitLines(Stream.decodeText(server.stdout))).pipe(
      Effect.timeout("10 seconds"),
    );
    if (!Option.isSome(ready)) throw new Error("Missing server ready record");
    const { address } = Schema.decodeUnknownSync(
      Schema.Struct({ schema: Schema.Literal("reffect.rpc.ready@1"), address: Schema.String }),
    )(JSON.parse(ready.value));
    return address;
  });

const native = Effect.gen(function* () {
  const address = yield* startServer("0");
  const rpc = yield* RpcClient.make(RemoteRpc, { disableTracing: true }).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url: `http://${address}/rpc` }).pipe(
        Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson]),
      ),
    ),
  );
  const client = yield* Layer.build(Remote.clientLayer(rpc));
  return yield* session.pipe(Effect.provideContext(client));
});

// `--serve [port]` keeps the native server running for the browser app in `web/`.
const serve = process.argv.indexOf("--serve");
await Effect.runPromise(
  serve >= 0
    ? Effect.scoped(
        Effect.gen(function* () {
          const address = yield* startServer(process.argv[serve + 1] ?? "8787");
          console.log(
            `native todo server listening on http://${address} (page and /rpc; Ctrl-C stops it)`,
          );
          return yield* Effect.never;
        }),
      ).pipe(Effect.provide(NodeServices.layer))
    : Effect.gen(function* () {
        const expected = yield* session.pipe(Effect.provide(upstreamLayer));
        const screens = yield* Effect.scoped(native);
        for (const [label, screen] of screens) console.log(`${label.padEnd(20)} ${screen}`);
        if (JSON.stringify(screens) !== JSON.stringify(expected))
          throw new Error("The native server's screens differ from upstream's memory backend");
        console.log("native screens equal upstream's memory backend");
      }).pipe(Effect.provide(NodeServices.layer)),
);
