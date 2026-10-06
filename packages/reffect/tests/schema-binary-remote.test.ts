/**
 * NativeRemote over SchemaBinary (docs/research/schema-binary.md): the read engine's answers equal
 * foldkit-remote-server's own handlers served under `layerSchemaBinary`, byte for byte. The Remote
 * contract's row runs hold records (`NormalizedEntity.values`), whose keys Effect interns per
 * field (`KEYS`).
 */
import { Effect, Fiber, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { SchemaBinary } from "effect/encoding";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices, NodeSocket } from "@effect/platform-node";
import { Entity } from "foldkit-entity";
import { Mutation, Remote, RemoteRpc } from "foldkit-remote";
import { RemoteServer } from "foldkit-remote-server";
import type { LiveHub, MemoryStore } from "foldkit-remote-server";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  LiveHubHost,
  NativeRemote,
  R,
  Reference,
  RemoteStoreHost,
  memoryStoreApi,
} from "../src/index.ts";
import type { NativeRemoteMutation } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { corpus, domain, rows } from "./remote-read-corpus.ts";

const ReadGroup = RemoteRpc.omit("FoldkitRemoteMutate", "FoldkitRemoteQuery", "FoldkitRemoteLive");
const Read = ReadGroup.requests.get("FoldkitRemoteRead");
if (Read === undefined) throw new Error("FoldkitRemoteRead");

const binary = Effect.runSync(
  Effect.service(RpcSerialization.RpcSerialization).pipe(
    Effect.provide(RpcSerialization.layerSchemaBinary()),
  ),
);
/** The JSON corpus's payload, as the stock client would write it under SchemaBinary. */
const body = (payload: unknown, fingerprint = false) =>
  binary.makeUnsafe().encode({
    _tag: "Request",
    id: 1,
    tag: "FoldkitRemoteRead",
    payload: Schema.encodeUnknownSync(SchemaBinary.toCodec(Read.payloadSchema, { fingerprint }))(
      Schema.decodeUnknownSync(Schema.toCodecJson(Read.payloadSchema))(payload),
    ),
    headers: [],
  }) as Uint8Array<ArrayBuffer>;

const oracle = (fingerprintPayloads: boolean) =>
  Effect.gen(function* () {
    const handlers = RemoteServer.handlers(RemoteServer.memory({ domain, rows }).server, undefined);
    const http = yield* RpcServer.toHttpEffect(ReadGroup, { disableTracing: true }).pipe(
      Effect.provide([
        ReadGroup.toLayer({ FoldkitRemoteRead: handlers.FoldkitRemoteRead }),
        RpcSerialization.layerSchemaBinary({ fingerprintPayloads }),
      ]),
    );
    return HttpEffect.toWebHandler(http);
  });

for (const fingerprintPayloads of [false, true])
  test(
    `the native read engine matches foldkit-remote-server over SchemaBinary (fingerprintPayloads: ${fingerprintPayloads})`,
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const official = yield* oracle(fingerprintPayloads);
            const fs = yield* FileSystem.FileSystem;
            const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-sb-remote-" });
            const artifact = yield* NativeRemote.compile(ReadGroup, {
              domain,
              rows,
              serialization: "schema-binary",
              schemaBinary: { fingerprintPayloads },
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
            const url = `http://${address}/rpc`;
            const hex = async (response: Response) =>
              `${response.status} ${Buffer.from(await response.arrayBuffer()).toString("hex")}`;
            for (const [label, payload] of corpus) {
              const bytes = body(payload, fingerprintPayloads);
              const native = yield* Effect.promise(() =>
                fetch(url, { method: "POST", body: bytes }).then(hex),
              );
              const expected = yield* Effect.promise(() =>
                official(
                  new Request("http://reffect.test/rpc", { method: "POST", body: bytes }),
                ).then(hex),
              );
              expect(native, label).toBe(expected);
            }

            const client = yield* RpcClient.make(ReadGroup, { disableTracing: true }).pipe(
              Effect.provide(
                RpcClient.layerProtocolHttp({ url }).pipe(
                  Layer.provide([
                    FetchHttpClient.layer,
                    RpcSerialization.layerSchemaBinary({ fingerprintPayloads }),
                  ]),
                ),
              ),
            );
            const result = yield* client.FoldkitRemoteRead({
              version: 4,
              requests: [
                {
                  entity: "Project",
                  id: "p3",
                  fields: ["owner"],
                  relations: { owner: { entity: "User", fields: ["name"] } },
                },
              ],
            });
            expect(result.entities.map((entity) => entity.id)).toEqual(["p3", "u2"]);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    },
    nativeTestBudget(0) + 240000,
  );

// Live and Mutate over SchemaBinary: the stock client subscribes while R mutations signal the
// hub; the native hub sends what upstream's liveHub sends, and mutation answers are byte-equal.
const Rename = Mutation.make("Rename", {
  Input: { id: Schema.String, name: Schema.String },
  Output: {},
});
const Drop = Mutation.make("Drop", { Input: { id: Schema.String }, Output: {} });
const liveDomain = Remote.define({
  entities: ["User", "Project"].map((name) =>
    Entity.define(name, Schema.Struct({ id: Schema.String })),
  ),
  mutations: [Rename, Drop],
});
const liveRows = {
  User: [{ id: "u1", name: "Ada" }],
  Project: [
    { id: "p1", name: "Borealis", rank: 2, members: ["User:u1"] },
    { id: "p2", name: "Apollo", rank: -0.5, members: [] },
  ],
};
const rename = NativeRemote.mutation(Rename, ({ input }) => {
  const id = R.Struct.get(input, "id");
  const values = R.Struct({ name: R.String }).make({ name: R.Struct.get(input, "name") });
  return R.Effect.flatMap(R.RemoteStore.write("Project", id, values), () =>
    R.Effect.flatMap(R.LiveHub.changed({ entity: "Project", id }, ["name"]), () =>
      R.Effect.succeed(NativeRemote.outcome(Rename).make({ output: R.Struct({}).make({}) })),
    ),
  );
});
const drop = NativeRemote.mutation(Drop, ({ input }) => {
  const id = R.Struct.get(input, "id");
  return R.Effect.flatMap(R.RemoteStore.remove("Project", id), () =>
    R.Effect.flatMap(R.LiveHub.deleted({ entity: "Project", id }), () =>
      R.Effect.succeed(NativeRemote.outcome(Drop).make({ output: R.Struct({}).make({}) })),
    ),
  );
});
const LiveGroup = RemoteRpc.omit("FoldkitRemoteQuery");

const officialLive = Effect.gen(function* () {
  let hub: LiveHub<undefined> | undefined;
  const run =
    (store: MemoryStore, native: NativeRemoteMutation) =>
    ({ input }: { readonly input: unknown }) =>
      Reference.run(native.fn, [input]).pipe(
        Effect.provideService(RemoteStoreHost, memoryStoreApi(store)),
        Effect.provideService(LiveHubHost, {
          changed: (ref, fields) => hub!.changed(ref, fields),
          deleted: (ref) => hub!.deleted(ref),
        }),
        Effect.catch((error) => Effect.die(error)),
        Effect.as({ output: {} }),
      );
  const server = RemoteServer.memory({
    domain: liveDomain,
    rows: liveRows,
    mutations: (store) => [
      RemoteServer.mutation(Rename, run(store, rename)),
      RemoteServer.mutation(Drop, run(store, drop)),
    ],
  }).server;
  const liveHub = yield* RemoteServer.liveHub([...server.entities.values()]);
  hub = liveHub;
  const handlers = RemoteServer.handlers(server, undefined, { live: liveHub });
  const http = yield* RpcServer.toHttpEffect(LiveGroup, { disableTracing: true }).pipe(
    Effect.provide([
      LiveGroup.toLayer({
        FoldkitRemoteRead: handlers.FoldkitRemoteRead,
        FoldkitRemoteMutate: handlers.FoldkitRemoteMutate,
        FoldkitRemoteLive: handlers.FoldkitRemoteLive,
      }),
      RpcSerialization.layerSchemaBinary(),
    ]),
  );
  return HttpEffect.toWebHandler(http);
});

const Mutate = LiveGroup.requests.get("FoldkitRemoteMutate");
if (Mutate === undefined) throw new Error("FoldkitRemoteMutate");
const mutateBody = (requestId: string, mutation: string, input: unknown) =>
  binary.makeUnsafe().encode({
    _tag: "Request",
    id: 9,
    tag: "FoldkitRemoteMutate",
    payload: Schema.encodeUnknownSync(SchemaBinary.toCodec(Mutate.payloadSchema))({
      requestId,
      mutation,
      input,
    }),
    headers: [],
  }) as Uint8Array<ArrayBuffer>;

/** Over a stock binary client: live events while a rename and a drop land, and their answers. */
const liveSession = (url: string, transport: typeof fetch) =>
  Effect.gen(function* () {
    const rpc = yield* RpcClient.make(LiveGroup, { disableTracing: true }).pipe(
      Effect.provide(
        RpcClient.layerProtocolHttp({ url }).pipe(
          Layer.provide([
            FetchHttpClient.layer.pipe(
              Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(transport)),
            ),
            RpcSerialization.layerSchemaBinary(),
          ]),
        ),
      ),
    );
    const events = yield* rpc
      .FoldkitRemoteLive({
        version: 4,
        requirements: [{ entity: "Project", id: "p1", fields: ["name", "rank"] }],
        after: 5,
      })
      .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
    yield* Effect.sleep("300 millis");
    const mutate = (requestId: string, mutation: string, input: unknown) =>
      Effect.promise(() =>
        transport(url, { method: "POST", body: mutateBody(requestId, mutation, input) }).then(
          async (response) => Buffer.from(await response.arrayBuffer()).toString("hex"),
        ),
      );
    const answers = [
      yield* mutate("r1", "Rename", { id: "p1", name: "Zephyr" }),
      yield* mutate("r2", "Drop", { id: "p1" }),
      yield* mutate("r3", "Nope", {}),
    ];
    const read = yield* rpc.FoldkitRemoteRead({
      version: 4,
      requests: [{ entity: "Project", id: "p2", fields: ["name", "rank", "members"] }],
    });
    return {
      events: JSON.stringify([...(yield* Fiber.join(events).pipe(Effect.timeout("10 seconds")))]),
      answers,
      read: JSON.stringify(read),
    };
  }).pipe(Effect.scoped);

test(
  "native live subscriptions and mutations match upstream over SchemaBinary",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reference = yield* officialLive;
          const official = yield* liveSession("http://reffect.test/rpc", ((input, init) =>
            reference(new Request(input, init))) as typeof fetch);
          expect(official.events).toContain('"EntityPatched"');
          expect(official.events).toContain('"EntityDeleted"');

          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-sb-live-" });
          const artifact = yield* NativeRemote.compile(LiveGroup, {
            domain: liveDomain,
            rows: liveRows,
            mutations: [rename, drop],
            live: true,
            serialization: "schema-binary",
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
          const native = yield* liveSession(`http://${address}/rpc`, fetch);
          expect(native).toStrictEqual(official);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);

/**
 * The same steps through one client, whose protocol layer is given: live events while a rename
 * and a drop land, the mutations' outcomes, and a read after them, all decoded.
 */
const clientSession = (
  protocol: Layer.Layer<RpcClient.Protocol, never, import("effect").Scope.Scope>,
) =>
  Effect.gen(function* () {
    // The protocol lives as long as the session; provided to `make` alone, a socket would close.
    const context = yield* Layer.build(protocol);
    const rpc = yield* RpcClient.make(LiveGroup, { disableTracing: true }).pipe(
      Effect.provideContext(context),
    );
    const events = yield* rpc
      .FoldkitRemoteLive({
        version: 4,
        requirements: [{ entity: "Project", id: "p1", fields: ["name", "rank"] }],
        after: 5,
      })
      .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
    yield* Effect.sleep("300 millis");
    const mutate = (requestId: string, mutation: string, input: unknown) =>
      rpc.FoldkitRemoteMutate({ requestId, mutation, input }).pipe(Effect.result);
    const outcomes = [
      yield* mutate("r1", "Rename", { id: "p1", name: "Zephyr" }),
      yield* mutate("r2", "Drop", { id: "p1" }),
      yield* mutate("r3", "Nope", {}),
    ];
    const read = yield* rpc.FoldkitRemoteRead({
      version: 4,
      requests: [{ entity: "Project", id: "p2", fields: ["name", "rank", "members"] }],
    });
    // As plain data: the two serializations decode object keys in different orders.
    return JSON.parse(
      JSON.stringify({
        events: [...(yield* Fiber.join(events).pipe(Effect.timeout("10 seconds")))],
        outcomes,
        read,
      }),
    ) as unknown;
  }).pipe(Effect.scoped);

test(
  "native Remote, Live included, over a WebSocket session",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reference = yield* officialLive;
          const official = yield* clientSession(
            RpcClient.layerProtocolHttp({ url: "http://reffect.test/rpc" }).pipe(
              Layer.provide([
                FetchHttpClient.layer.pipe(
                  Layer.provide(
                    Layer.succeed(FetchHttpClient.Fetch)(((input, init) =>
                      reference(new Request(input, init))) as typeof fetch),
                  ),
                ),
                RpcSerialization.layerSchemaBinary(),
              ]),
            ),
          );
          expect(JSON.stringify(official)).toContain('"EntityPatched"');
          expect(JSON.stringify(official)).toContain('"EntityDeleted"');

          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-ws-remote-" });
          const artifact = yield* NativeRemote.compile(LiveGroup, {
            domain: liveDomain,
            rows: liveRows,
            mutations: [rename, drop],
            live: true,
            transport: "websocket",
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
          // JSON over the socket: a WebSocket frames every message, so Live needs no NDJSON.
          const native = yield* clientSession(
            RpcClient.layerProtocolSocket().pipe(
              Layer.provide([
                NodeSocket.layerWebSocket(`ws://${address}/rpc`),
                RpcSerialization.layerJson,
              ]),
            ),
          );
          expect(native).toStrictEqual(official);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
