/**
 * Milestone 10 step 4 (docs/research/schema-binary.md): tagged unions, arrays (number runs,
 * struct row runs with interning), records and `Unknown` under `serialization: "schema-binary"`,
 * byte for byte as the official server running the same R handlers writes them; in default mode
 * and with `fingerprintPayloads` (fingerprint mode: positional structs, union positions, row-run
 * presence masks).
 */
import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { SchemaBinary } from "effect/encoding";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const Shape = Schema.TaggedUnion({
  Circle: { r: Schema.Number },
  Square: { side: Schema.Number, label: Schema.optional(NativeRpc.StringJson) },
  Empty: {},
});
const Item = Schema.Struct({
  id: NativeRpc.StringJson,
  name: NativeRpc.StringJson,
  tags: Schema.Array(NativeRpc.StringJson),
  qty: Schema.Number,
  done: Schema.optional(Schema.Boolean),
});
const Bag = Schema.Struct({
  shapes: Schema.Array(Shape),
  maybe: Schema.NullOr(Shape),
  items: Schema.Array(Item),
  numbers: Schema.Array(Schema.Number),
  flags: Schema.Array(Schema.Boolean),
  words: Schema.Array(NativeRpc.StringJson),
  counts: Schema.Record(NativeRpc.StringJson, Schema.Number),
  extra: Schema.Unknown,
  tables: Schema.Array(Schema.Record(NativeRpc.StringJson, Schema.Number)),
});
const Group = RpcGroup.make(
  Rpc.make("Echo", { payload: Bag, success: Bag }),
  Rpc.make("Reject", { payload: Shape, success: Schema.Number, error: Shape }),
);

const RShape = R.TaggedUnion({
  Circle: { r: R.Number },
  Square: { side: R.Number, label: R.optional(R.String) },
  Empty: {},
});
const RBag = R.Struct({
  shapes: R.Array(RShape),
  maybe: R.NullOr(RShape),
  items: R.Array(
    R.Struct({
      id: R.String,
      name: R.String,
      tags: R.Array(R.String),
      qty: R.Number,
      done: R.optional(R.Bool),
    }),
  ),
  numbers: R.Array(R.Number),
  flags: R.Array(R.Bool),
  words: R.Array(R.String),
  counts: R.Record(R.String, R.Number),
  extra: R.Unknown,
  tables: R.Array(R.Record(R.String, R.Number)),
});
const echo = R.fn([RBag], RBag, (bag) => bag);
const reject = R.fn([RShape], R.Number, RShape, (shape) => R.Effect.fail(shape));
const bindings = { Echo: NativeRpc.bind(echo), Reject: NativeRpc.bind(reject) };

const official = (fingerprintPayloads: boolean) =>
  Effect.gen(function* () {
    const run = <A, E>(effect: Effect.Effect<A, E | { readonly _tag: "CompileError" }>) =>
      effect.pipe(Effect.catchTag("CompileError", Effect.die));
    const handlers = Group.toLayer({
      Echo: (bag) => run(Reference.run(echo, [bag])),
      Reject: (shape) => run(Reference.run(reject, [shape])),
    });
    const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
      Effect.provide([handlers, RpcSerialization.layerSchemaBinary({ fingerprintPayloads })]),
    );
    return HttpEffect.toWebHandler(http);
  });

const binary = Effect.runSync(
  Effect.service(RpcSerialization.RpcSerialization).pipe(
    Effect.provide(RpcSerialization.layerSchemaBinary()),
  ),
);
const requestBody = (
  tag: "Echo" | "Reject",
  payload: unknown,
  id = 0,
  fingerprintPayloads = false,
) => {
  const rpc = Group.requests.get(tag);
  if (rpc === undefined) throw new Error(tag);
  return binary.makeUnsafe().encode({
    _tag: "Request",
    id,
    tag,
    payload: Schema.encodeUnknownSync(
      SchemaBinary.toCodec(rpc.payloadSchema, { fingerprint: fingerprintPayloads }),
    )(payload),
    headers: [],
  }) as Uint8Array<ArrayBuffer>;
};

const empty: typeof Bag.Type = {
  shapes: [],
  maybe: null,
  items: [],
  numbers: [],
  flags: [],
  words: [],
  counts: {},
  extra: null,
  tables: [],
};
const items = (count: number, distinct: boolean) =>
  Array.from({ length: count }, (_, i) => ({
    id: distinct ? `id-${i}` : `id-${i % 3}`,
    name: i % 2 === 0 ? "even" : "odd",
    tags: i % 4 === 0 ? [] : ["a", i % 3 === 0 ? "b" : "c", "a"],
    qty: i % 5 === 0 ? i / 4 : i,
    ...(i % 3 === 0 ? { done: i % 2 === 0 } : {}),
  }));
const bags: ReadonlyArray<readonly [string, typeof Bag.Type]> = [
  ["empty", empty],
  [
    "shapes",
    {
      ...empty,
      shapes: [
        { _tag: "Circle", r: 1.5 },
        { _tag: "Square", side: 2 },
        { _tag: "Square", side: -0, label: "x" },
        { _tag: "Empty" },
      ],
      maybe: { _tag: "Circle", r: Number.NaN },
    },
  ],
  ["items repeating", { ...empty, items: items(12, false) }],
  // A table of 64 values that never repeated stops interning when the 65th arrives, so that
  // value's repeat is a literal again; names keep their table.
  [
    "items past the intern cutoff",
    { ...empty, items: [...items(65, true), { ...items(1, true)[0]!, id: "id-64" }] },
  ],
  [
    "items repeating before the cutoff",
    { ...empty, items: [...items(64, true), ...items(2, true)] },
  ],
  ["varint numbers", { ...empty, numbers: [0, -0, 1, -1, 2 ** 48 - 1] }],
  ["decimal numbers", { ...empty, numbers: [1, 2.5, -0.25, 12.5, 2 ** 41 - 1] }],
  ["f64 numbers", { ...empty, numbers: [1, Math.PI, Number.NaN, 2 ** 48] }],
  // Record rows: the extras block, and shapes reused only by rows with extras.
  [
    "arrays of records",
    { ...empty, tables: [{ b: 1, a: 2.5 }, {}, { a: -1 }, {}, { é: 0, "10": 3 }] },
  ],
  ["flags and words", { ...empty, flags: [true, false, true], words: ["", "é😀", "a"] }],
  [
    "records",
    {
      ...empty,
      counts: { b: 2, a: 1, "10": 3, "2": 4, "": 0.5, é: -0, ab: Number.POSITIVE_INFINITY },
    },
  ],
  [
    "unknown",
    {
      ...empty,
      extra: { z: [1, 0.1, 1e21, 1e-7, -0, "s\u0001 ", true, null], a: { nested: {} } },
    },
  ],
];

for (const fingerprintPayloads of [false, true])
  test(
    `composite SchemaBinary shapes answer byte for byte as the official server (fingerprintPayloads: ${fingerprintPayloads})`,
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const reference = yield* official(fingerprintPayloads);
            const fs = yield* FileSystem.FileSystem;
            const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-sb-composites-" });
            const artifact = yield* NativeRpc.compile(Group, bindings, {
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
            const answer =
              (respond: (body: Uint8Array<ArrayBuffer>) => Promise<Response>) =>
              (body: Uint8Array<ArrayBuffer>) =>
                Effect.promise(async () => {
                  const response = await respond(body);
                  return `${response.status} ${Buffer.from(await response.arrayBuffer()).toString("hex")}`;
                });
            const native = answer((body) => fetch(url, { method: "POST", body }));
            const officially = answer((body) =>
              reference(new Request("http://reffect.test/rpc", { method: "POST", body })),
            );

            const corpus = [
              ...bags.map(
                ([label, bag], i) =>
                  [label, requestBody("Echo", bag, i, fingerprintPayloads)] as const,
              ),
              ...[
                { _tag: "Circle", r: 2 },
                { _tag: "Square", side: 0.5, label: "l" },
                { _tag: "Empty" },
              ].map(
                (shape) =>
                  [
                    `reject ${shape._tag}`,
                    requestBody("Reject", shape, 0, fingerprintPayloads),
                  ] as const,
              ),
            ];
            for (const [label, body] of corpus)
              expect(yield* native(body), label).toBe(yield* officially(body));

            const client = yield* RpcClient.make(Group, { disableTracing: true }).pipe(
              Effect.provide(
                RpcClient.layerProtocolHttp({ url }).pipe(
                  Layer.provide([
                    FetchHttpClient.layer,
                    RpcSerialization.layerSchemaBinary({ fingerprintPayloads }),
                  ]),
                ),
              ),
            );
            // What the reference answers, through Effect's own SchemaBinary round trip: an
            // `Unknown` is JSON text, where -0 is 0.
            const BagCodec = SchemaBinary.toCodec(Bag);
            for (const [label, bag] of bags)
              expect(yield* client.Echo(bag), label).toStrictEqual(
                Schema.decodeSync(BagCodec)(
                  Schema.encodeSync(BagCodec)(yield* Reference.run(echo, [bag]).pipe(Effect.orDie)),
                ),
              );
            expect(yield* Effect.flip(client.Reject({ _tag: "Empty" }))).toStrictEqual({
              _tag: "Empty",
            });
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    },
    nativeTestBudget(0) + 240000,
  );
