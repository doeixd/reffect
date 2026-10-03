import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { successValue } from "./raw-json.ts";
import * as Wire from "foldkit-remote";

// The unchanged foldkit-remote contract, without Live (streaming waits for milestones 6–7, NR-006).
const Group = Wire.RemoteRpc.omit("FoldkitRemoteLive");
const ReadErrorSchema = Schema.Union([Wire.RemoteReadError, Wire.RemoteProtocolError]);

// Requests are read through witnesses derived from the contract; results are built from R
// witnesses that intern to the same contract witnesses.
const ReadBatch = NativeRpc.witness(Wire.ReadBatch);
const MutationRequest = NativeRpc.witness(Wire.MutationRequest);
const QueryRequest = NativeRpc.witness(Wire.QueryRequest);
const Settled = R.Struct({ entity: R.String, id: R.String, fields: R.Array(R.String) });
const NormalizedEntity = R.Struct({
  entity: R.String,
  id: R.String,
  values: R.Record(R.String, R.Unknown),
});
const ReadBatchResult = R.Struct({
  entities: R.Array(NormalizedEntity),
  settled: R.Array(Settled),
});
const ReadErrors = R.TaggedUnion({
  RemoteReadError: { message: R.String },
  RemoteProtocolError: { message: R.String, expected: R.Number, received: R.Number },
});
const LiveEdge = R.Struct({ entity: R.String, id: R.String, key: R.String });
const ConnectionChange = R.TaggedUnion({
  Insert: { connection: R.String, position: R.Literals(["prepend", "append"]), edge: LiveEdge },
  Remove: { connection: R.String, edge: LiveEdge },
});
const MutationResult = R.Struct({
  output: R.Unknown,
  entities: R.Array(NormalizedEntity),
  connections: R.optional(R.Array(ConnectionChange)),
  deleted: R.optional(R.Array(R.Struct({ entity: R.String, id: R.String }))),
});
const MutationError = R.TaggedUnion({ RemoteMutationError: { message: R.String } });
const Boundary = R.TaggedUnion({ Terminal: {}, Cursor: { cursor: R.String }, Unknown: {} });
const QueryResult = R.Struct({
  edges: R.Array(R.Struct({ entity: R.String, id: R.String, key: R.String })),
  start: Boundary,
  end: Boundary,
  entities: R.optional(R.Array(NormalizedEntity)),
  settled: R.optional(R.Array(Settled)),
});
const QueryError = R.TaggedUnion({ RemoteQueryError: { message: R.String } });

// Read checks the protocol version, as the reference server does, and settles requested fields.
const read = R.fn([ReadBatch], ReadBatchResult, ReadErrors, (batch) =>
  R.Match.bool(
    R.Number.eq(R.Struct.get(batch, "version"), R.Number.literal(Wire.REMOTE_PROTOCOL_VERSION)),
    R.Effect.succeed(
      ReadBatchResult.make({
        entities: R.Array.empty(NormalizedEntity),
        settled: R.Array.map(R.Struct.get(batch, "requests"), (request) =>
          Settled.make({
            entity: R.Struct.get(request, "entity"),
            id: R.Struct.get(request, "id"),
            fields: R.Struct.get(request, "fields"),
          }),
        ),
      }),
    ),
    R.Effect.fail(
      ReadErrors.cases.RemoteProtocolError.make({
        message: R.String.literal("Remote protocol version mismatch"),
        expected: R.Number.literal(Wire.REMOTE_PROTOCOL_VERSION),
        received: R.Struct.get(batch, "version"),
      }),
    ),
  ),
);
const mutate = R.fn([MutationRequest], MutationResult, MutationError, (request) =>
  R.Match.bool(
    R.String.eq(R.Struct.get(request, "mutation"), R.String.literal("fail")),
    R.Effect.fail(
      MutationError.cases.RemoteMutationError.make({ message: R.String.literal("refused") }),
    ),
    R.Effect.succeed(
      MutationResult.make({
        output: R.Struct.get(request, "input"),
        entities: R.Array.empty(NormalizedEntity),
        connections: R.Array.make(
          ConnectionChange.cases.Insert.make({
            connection: R.Struct.get(request, "mutation"),
            position: R.Literals(["prepend", "append"]).literal("append"),
            edge: LiveEdge.make({
              entity: R.String.literal("post"),
              id: R.Struct.get(request, "requestId"),
              key: R.String.literal("k"),
            }),
          }),
        ),
      }),
    ),
  ),
);
const query = R.fn([QueryRequest], QueryResult, QueryError, (request) =>
  R.Match.bool(
    R.String.eq(R.Struct.get(request, "query"), R.String.literal("missing")),
    R.Effect.fail(QueryError.cases.RemoteQueryError.make({ message: R.String.literal("unknown") })),
    R.Effect.succeed(
      QueryResult.make({
        edges: R.Array.empty(R.Struct({ entity: R.String, id: R.String, key: R.String })),
        start: Boundary.cases.Terminal.make({}),
        end: Boundary.cases.Cursor.make({ cursor: R.Struct.get(request, "query") }),
      }),
    ),
  ),
);
const bindings = {
  FoldkitRemoteRead: NativeRpc.bind(read),
  FoldkitRemoteMutate: NativeRpc.bind(mutate),
  FoldkitRemoteQuery: NativeRpc.bind(query),
};

const message = (tag: string, payload: unknown) =>
  JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] });
const nest = (depth: number, leaf: Record<string, unknown> = {}): Record<string, unknown> =>
  depth === 0
    ? { entity: "user", fields: ["name"], ...leaf }
    : { entity: "post", fields: ["title"], relations: { next: nest(depth - 1, leaf) } };
const readRequest = (extra: Record<string, unknown> = {}) => ({
  entity: "post",
  id: "p1",
  fields: ["title", "author"],
  ...extra,
});
const corpus: ReadonlyArray<readonly [string, string]> = [
  ["read ok", message("FoldkitRemoteRead", { version: 4, requests: [readRequest()] })],
  [
    "read nested windows",
    message("FoldkitRemoteRead", {
      version: 4,
      requests: [
        readRequest({
          windows: { comments: { first: 10, after: "c1" }, "2": {} },
          relations: { author: nest(3), comments: { entity: "comment", fields: [] } },
        }),
      ],
    }),
  ],
  [
    "read deepest level",
    message("FoldkitRemoteRead", {
      version: 4,
      requests: [readRequest({ relations: { r: nest(7) } })],
    }),
  ],
  [
    "read relations beyond the last level",
    message("FoldkitRemoteRead", {
      version: 4,
      requests: [readRequest({ relations: { r: nest(7, { relations: {} }) } })],
    }),
  ],
  ["read version mismatch", message("FoldkitRemoteRead", { version: 3, requests: [] })],
  ["read version NaN", message("FoldkitRemoteRead", { version: "NaN", requests: [] })],
  ["read version string", message("FoldkitRemoteRead", { version: "4", requests: [] })],
  [
    "read too many fields",
    message("FoldkitRemoteRead", {
      version: 4,
      requests: [readRequest({ fields: Array.from({ length: 257 }, (_, i) => `f${i}`) })],
    }),
  ],
  [
    "read negative page",
    message("FoldkitRemoteRead", {
      version: 4,
      requests: [readRequest({ windows: { c: { first: -1 } } })],
    }),
  ],
  [
    "read fractional page",
    message("FoldkitRemoteRead", {
      version: 4,
      requests: [readRequest({ windows: { c: { last: 1.5 } } })],
    }),
  ],
  [
    "read null optional window bound",
    message("FoldkitRemoteRead", {
      version: 4,
      requests: [readRequest({ windows: { c: { first: null } } })],
    }),
  ],
  [
    "read relations array",
    message("FoldkitRemoteRead", { version: 4, requests: [readRequest({ relations: [] })] }),
  ],
  [
    "read missing id",
    message("FoldkitRemoteRead", { version: 4, requests: [{ entity: "post", fields: [] }] }),
  ],
  ["read requests object", message("FoldkitRemoteRead", { version: 4, requests: {} })],
  [
    "mutate ok",
    message("FoldkitRemoteMutate", {
      requestId: "r1",
      mutation: "createPost",
      input: { title: "x", "1": [1.0, -0], nested: { b: 1, a: 2 } },
    }),
  ],
  [
    "mutate fail",
    message("FoldkitRemoteMutate", { requestId: "r2", mutation: "fail", input: null }),
  ],
  ["mutate missing input", message("FoldkitRemoteMutate", { requestId: "r3", mutation: "m" })],
  [
    "query ok",
    message("FoldkitRemoteQuery", { query: "feed", input: { n: 1 }, window: { first: 20 } }),
  ],
  [
    "query select",
    message("FoldkitRemoteQuery", { query: "feed", input: [], window: {}, select: nest(2) }),
  ],
  ["query missing", message("FoldkitRemoteQuery", { query: "missing", input: null, window: {} })],
  [
    "query bad window",
    message("FoldkitRemoteQuery", { query: "feed", input: 1, window: { before: 3 } }),
  ],
  ["query missing window", message("FoldkitRemoteQuery", { query: "feed", input: 1 })],
];

const oracle = Effect.gen(function* () {
  // The JS boundary builds error class instances from R data (TE-002).
  const run = <A, E, S extends Schema.Codec<any, any>>(
    effect: Effect.Effect<A, E | { readonly _tag: "CompileError" }>,
    error: S,
  ): Effect.Effect<A, S["Type"]> =>
    effect.pipe(
      Effect.catchTag("CompileError", Effect.die),
      Effect.mapError((value) => Schema.decodeUnknownSync(error)(value)),
    );
  const handlers = Group.toLayer({
    FoldkitRemoteRead: (batch) => run(Reference.run(read, [batch]), ReadErrorSchema),
    FoldkitRemoteMutate: (request) =>
      run(Reference.run(mutate, [request]), Wire.RemoteMutationError),
    FoldkitRemoteQuery: (request) => run(Reference.run(query, [request]), Wire.RemoteQueryError),
  });
  const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
    Effect.provide([handlers, RpcSerialization.layerJson]),
  );
  return HttpEffect.toWebHandler(http);
});

test("Remote result witnesses built in R intern to the contract witnesses", () => {
  const result = { position: "result" } as const;
  expect(ReadBatchResult).toBe(NativeRpc.witness(Wire.ReadBatchResult, result));
  expect(MutationResult).toBe(NativeRpc.witness(Wire.MutationResult, result));
  expect(QueryResult).toBe(NativeRpc.witness(Wire.QueryResult, result));
  expect(ReadErrors).toBe(NativeRpc.witness(ReadErrorSchema, result));
  expect(MutationError).toBe(NativeRpc.witness(Wire.RemoteMutationError, result));
  expect(QueryError).toBe(NativeRpc.witness(Wire.RemoteQueryError, result));
});

test("the streaming Live procedure is refused explicitly", async () => {
  const error = await Effect.runPromise(
    NativeRpc.compile(Wire.RemoteRpc, {
      ...bindings,
      // @ts-expect-error a stream success has no R handler type, so Live cannot be bound
      FoldkitRemoteLive: NativeRpc.bind(R.fn([R.Bool], R.Bool, (b) => b)),
    }).pipe(Effect.flip),
  );
  expect(error.message).toMatch(/stream/i);
});

test(
  "the foldkit-remote contract compiles natively and matches the official server",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const official = yield* oracle;
          const officialPost = (body: string) =>
            Effect.promise(async () => {
              const response = await official(
                new Request("http://reffect.test/rpc", { method: "POST", body }),
              );
              return { status: response.status, body: await response.text() };
            });
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-remote-wire-rpc-" });
          const artifact = yield* NativeRpc.compile(Group, bindings);
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
          for (const [label, body] of corpus) {
            const native = yield* Effect.promise(async () => {
              const response = await fetch(url, { method: "POST", body });
              return { status: response.status, body: await response.text() };
            });
            const reference = yield* officialPost(body);
            expect(native.status, label).toBe(reference.status);
            expect(JSON.parse(native.body), label).toStrictEqual(JSON.parse(reference.body));
            expect(successValue(native.body), `${label} raw key order`).toStrictEqual(
              successValue(reference.body),
            );
          }

          // A stock RpcClient for the unchanged contract talks to the native server.
          const client = yield* RpcClient.make(Group, { disableTracing: true }).pipe(
            Effect.provide(
              RpcClient.layerProtocolHttp({ url }).pipe(
                Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
              ),
            ),
          );
          const settled = yield* client.FoldkitRemoteRead({
            version: 4,
            requests: [{ entity: "post", id: "p1", fields: ["title"] }],
          });
          expect(settled).toStrictEqual({
            entities: [],
            settled: [{ entity: "post", id: "p1", fields: ["title"] }],
          });
          const mismatch = yield* Effect.flip(
            client.FoldkitRemoteRead({ version: 2, requests: [] }),
          );
          expect(mismatch).toBeInstanceOf(Wire.RemoteProtocolError);
          const mutation = yield* client.FoldkitRemoteMutate({
            requestId: "r",
            mutation: "m",
            input: { a: 1 },
          });
          expect(mutation.connections?.[0]).toMatchObject({ _tag: "Insert", position: "append" });
          expect(
            yield* Effect.flip(
              client.FoldkitRemoteQuery({ query: "missing", input: null, window: {} }),
            ),
          ).toBeInstanceOf(Wire.RemoteQueryError);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 180000,
);
