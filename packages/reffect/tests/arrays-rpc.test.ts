import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const WireItem = Schema.Struct({ name: NativeRpc.StringJson, count: NativeRpc.U64Json });
const WireBoundary = Schema.TaggedUnion({ Terminal: {}, Cursor: { cursor: NativeRpc.StringJson } });
const Group = RpcGroup.make(
  Rpc.make("Nums", {
    payload: Schema.Array(NativeRpc.U64Json),
    success: Schema.Array(NativeRpc.U64Json),
  }),
  Rpc.make("Items", {
    payload: { items: Schema.Array(WireItem), fallback: NativeRpc.StringJson },
    success: NativeRpc.StringJson,
  }),
  Rpc.make("Grid", {
    payload: Schema.Array(Schema.Array(Schema.Boolean)),
    success: NativeRpc.U64Json,
  }),
  Rpc.make("Flip", { payload: Schema.Array(WireBoundary), success: Schema.Array(WireBoundary) }),
);

const Item = R.Struct({ name: R.String, count: R.U64 });
const Boundary = R.TaggedUnion({ Terminal: {}, Cursor: { cursor: R.String } });
const nums = R.fn([R.Array(R.U64)], R.Array(R.U64), (xs) =>
  R.Array.map(xs, (x, i) => R.U64.add(x, i)),
);
const items = R.fn([R.Array(Item), R.String], R.String, (list, fallback) =>
  R.Array.reduce(list, fallback, (acc, item) =>
    R.Match.bool(
      R.U64.lt(R.U64.literal(1n), R.Struct.get(item, "count")),
      R.Struct.get(item, "name"),
      acc,
    ),
  ),
);
const grid = R.fn([R.Array(R.Array(R.Bool))], R.U64, (rows) =>
  R.Array.reduce(rows, R.U64.literal(0n), (total, row) =>
    R.U64.add(total, R.Array.length(R.Array.filter(row, (cell) => cell))),
  ),
);
const flip = R.fn([R.Array(Boundary)], R.Array(Boundary), (list) =>
  R.Array.map(list, (b) =>
    Boundary.match(b, {
      Terminal: () => Boundary.cases.Cursor.make({ cursor: R.String.literal("start") }),
      Cursor: () => Boundary.cases.Terminal.make({}),
    }),
  ),
);
const bindings = {
  Nums: NativeRpc.bind(nums),
  Items: NativeRpc.bind(items, ["items", "fallback"]),
  Grid: NativeRpc.bind(grid),
  Flip: NativeRpc.bind(flip),
};

const request = (tag: string, payload: string, id = "1") =>
  `{"_tag":"Request","id":"${id}","tag":"${tag}","payload":${payload},"headers":[]}`;
const corpus: ReadonlyArray<readonly [string, string]> = [
  ["nums", request("Nums", '["1","2","18446744073709551614"]')],
  ["nums empty", request("Nums", "[]")],
  ["nums object", request("Nums", '{"0":"1"}')],
  ["nums null", request("Nums", "null")],
  ["nums bad element", request("Nums", '["1",2,"x"]')],
  [
    "items",
    request(
      "Items",
      '{"items":[{"name":"a","count":"1"},{"name":"b","count":"3"}],"fallback":"none"}',
    ),
  ],
  ["items empty", request("Items", '{"items":[],"fallback":"none"}')],
  [
    "items element missing",
    request("Items", '{"items":[{"name":"a","count":"1"},{"name":"b"}],"fallback":"x"}'),
  ],
  ["items not array", request("Items", '{"items":{},"fallback":"x"}')],
  ["grid", request("Grid", "[[true,false],[],[true,true]]")],
  ["grid bad cell", request("Grid", "[[true],[1]]")],
  ["grid bad row", request("Grid", "[[true],true]")],
  ["flip", request("Flip", '[{"_tag":"Terminal"},{"_tag":"Cursor","cursor":"c"}]')],
  ["flip bad tag", request("Flip", '[{"_tag":"Terminal"},{"_tag":"Nope"}]')],
  ["flip bad case field", request("Flip", '[{"_tag":"Cursor","cursor":7}]')],
];

const oracle = Effect.gen(function* () {
  const run = <A, E>(effect: Effect.Effect<A, E | { readonly _tag: "CompileError" }>) =>
    effect.pipe(Effect.catchTag("CompileError", Effect.die));
  const handlers = Group.toLayer({
    Nums: (xs) => run(Reference.run(nums, [xs])),
    Items: ({ items: list, fallback }) => run(Reference.run(items, [list, fallback])),
    Grid: (rows) => run(Reference.run(grid, [rows])),
    Flip: (list) => run(Reference.run(flip, [list])),
  });
  const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
    Effect.provide([handlers, RpcSerialization.layerJson]),
  );
  return HttpEffect.toWebHandler(http);
});

test("checked arrays and tuples are refused at the RPC boundary", async () => {
  const Checked = RpcGroup.make(
    Rpc.make("Nums", {
      payload: Schema.Array(NativeRpc.U64Json).check(Schema.isMinLength(1)),
      success: Schema.Array(NativeRpc.U64Json),
    }),
  );
  const error = await Effect.runPromise(
    NativeRpc.compile(Checked, { Nums: NativeRpc.bind(nums) }).pipe(Effect.flip),
  );
  expect(error.message).toContain("Schema.Array");
});

test(
  "native array payloads and results match the official RPC server",
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
              return { status: response.status, body: await response.json() };
            });
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-arrays-rpc-" });
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
          const post = (body: string) =>
            Effect.promise(async () => {
              const response = await fetch(url, { method: "POST", body });
              return { status: response.status, body: await response.json() };
            });
          for (const [label, body] of corpus)
            expect(yield* post(body), label).toEqual(yield* officialPost(body));

          const client = yield* RpcClient.make(Group, { disableTracing: true }).pipe(
            Effect.provide(
              RpcClient.layerProtocolHttp({ url }).pipe(
                Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
              ),
            ),
          );
          expect(yield* client.Nums([5n, 6n])).toEqual([5n, 7n]);
          expect(
            yield* client.Items({ items: [{ name: "x😀", count: 2n }], fallback: "none" }),
          ).toBe("x😀");
          expect(yield* client.Grid([[true], [true, false, true]])).toBe(3n);
          expect(yield* client.Flip([WireBoundary.cases.Terminal.make({})])).toEqual([
            { _tag: "Cursor", cursor: "start" },
          ]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);
