import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// Contract schemas, as a Remote wire module would declare them.
const WireBoundary = Schema.TaggedUnion({
  Terminal: {},
  Cursor: { cursor: NativeRpc.StringJson },
  Unknown: {},
});
const WireItem = Schema.Struct({ name: NativeRpc.StringJson, count: NativeRpc.U64Json }).annotate({
  identifier: "Item",
});
const WireFlag = Schema.Struct({ flag: Schema.Boolean });
const Group = RpcGroup.make(
  Rpc.make("Next", { payload: WireBoundary, success: WireBoundary }),
  Rpc.make("Label", {
    payload: { item: WireItem, boundary: WireBoundary },
    success: NativeRpc.StringJson,
  }),
  Rpc.make("Store", { payload: WireItem, success: WireItem, error: WireBoundary }),
  Rpc.make("Flag", { payload: WireFlag, success: Schema.Boolean }),
);

// Native handlers over the matching R witnesses.
const Boundary = R.TaggedUnion({ Terminal: {}, Cursor: { cursor: R.String }, Unknown: {} });
const Item = R.Struct({ name: R.String, count: R.U64 }).annotate({ identifier: "Item" });
const Flag = R.Struct({ flag: R.Bool });
const next = R.fn([Boundary], Boundary, (boundary) =>
  Boundary.match(boundary, {
    Terminal: () => Boundary.cases.Unknown.make({}),
    Cursor: (c) =>
      Boundary.cases.Cursor.make({
        cursor: R.String.replaceAll(R.Struct.get(c, "cursor"), "a", "b"),
      }),
    Unknown: () => Boundary.cases.Terminal.make({}),
  }),
);
const label = R.fn([Item, Boundary], R.String, (item, boundary) =>
  Boundary.match(boundary, {
    Terminal: () => R.Struct.get(item, "name"),
    Cursor: (c) => R.Struct.get(c, "cursor"),
    Unknown: () => R.String.literal("unknown"),
  }),
);
const store = R.fn([Item], Item, Boundary, (item) =>
  R.Match.bool(
    R.U64.eq(R.Struct.get(item, "count"), R.U64.literal(0n)),
    R.Effect.fail(Boundary.cases.Cursor.make({ cursor: R.Struct.get(item, "name") })),
    R.Effect.succeed(item),
  ),
);
const flag = R.fn([Flag], R.Bool, (value) => R.Bool.not(R.Struct.get(value, "flag")));
const bindings = {
  Next: NativeRpc.bind(next),
  Label: NativeRpc.bind(label, ["item", "boundary"]),
  Store: NativeRpc.bind(store),
  Flag: NativeRpc.bind(flag),
};

const request = (tag: string, payload: string, id = "1") =>
  `{"_tag":"Request","id":"${id}","tag":"${tag}","payload":${payload},"headers":[]}`;
const corpus: ReadonlyArray<readonly [string, string]> = [
  ["cursor", request("Next", '{"cursor":"banana","_tag":"Cursor"}')],
  ["terminal", request("Next", '{"_tag":"Terminal"}')],
  ["unknown", request("Next", '{"_tag":"Unknown"}')],
  ["wrong tag", request("Next", '{"_tag":"Nope"}')],
  ["missing tag", request("Next", '{"cursor":"c"}')],
  ["numeric tag", request("Next", '{"_tag":5}')],
  ["cursor missing", request("Next", '{"_tag":"Cursor"}')],
  ["cursor numeric", request("Next", '{"_tag":"Cursor","cursor":5}')],
  ["excess property", request("Next", '{"_tag":"Terminal","extra":1}')],
  ["string payload", request("Next", '"Terminal"')],
  ["null payload", request("Next", "null")],
  ["array payload", request("Next", "[]")],
  [
    "label cursor",
    request(
      "Label",
      '{"item":{"name":"n","count":"1"},"boundary":{"_tag":"Cursor","cursor":"c😀"}}',
    ),
  ],
  [
    "label terminal",
    request("Label", '{"boundary":{"_tag":"Terminal"},"item":{"count":"1","name":"named"}}'),
  ],
  [
    "label nested missing",
    request("Label", '{"item":{"name":"n","count":"1"},"boundary":{"_tag":"Cursor"}}'),
  ],
  [
    "label nested tag",
    request("Label", '{"item":{"name":"n","count":"1"},"boundary":{"_tag":"Nope"}}'),
  ],
  ["label item missing", request("Label", '{"item":{"name":"n"},"boundary":{"_tag":"Terminal"}}')],
  ["label item not object", request("Label", '{"item":"x","boundary":{"_tag":"Terminal"}}')],
  ["label missing item", request("Label", '{"boundary":{"_tag":"Terminal"}}')],
  ["store ok", request("Store", '{"count":"2","name":"kept","x":true}')],
  ["store typed failure", request("Store", '{"name":"empty","count":"0"}')],
  ["store not object", request("Store", '"x"')],
  ["store bad field", request("Store", '{"name":1,"count":"x"}')],
  ["store big count", request("Store", '{"name":"n","count":"18446744073709551615"}')],
  ["flag", request("Flag", '{"flag":true}')],
  ["flag not object", request("Flag", "1")],
  ["flag wrong type", request("Flag", '{"flag":"yes"}')],
  ["batch", `[${request("Next", '{"_tag":"Terminal"}', "a")},${request("Flag", "null", "b")}]`],
];

const oracle = Effect.gen(function* () {
  const run = <A, E>(effect: Effect.Effect<A, E | { readonly _tag: "CompileError" }>) =>
    effect.pipe(Effect.catchTag("CompileError", Effect.die));
  const handlers = Group.toLayer({
    Next: (boundary) => run(Reference.run(next, [boundary])),
    Label: ({ item, boundary }) => run(Reference.run(label, [item, boundary])),
    Store: (item) => run(Reference.run(store, [item])),
    Flag: (value) => run(Reference.run(flag, [value])),
  });
  const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
    Effect.provide([handlers, RpcSerialization.layerJson]),
  );
  return HttpEffect.toWebHandler(http);
});

test("contract composites map onto the interned handler witnesses", async () => {
  const artifact = await Effect.runPromise(NativeRpc.compile(Group, bindings));
  for (const token of ["fn decode_Item", "fn encode_Item", "Expected Item"])
    expect(artifact.files["src/main.rs"]).toContain(token);
  // Plain Schema.String inside a composite is still refused.
  const Plain = RpcGroup.make(
    Rpc.make("Flag", { payload: Schema.Struct({ flag: Schema.String }), success: Schema.Boolean }),
  );
  const error = await Effect.runPromise(
    NativeRpc.compile(Plain, { Flag: NativeRpc.bind(flag) }).pipe(Effect.flip),
  );
  expect(error.message).toContain("NativeRpc.StringJson");
});

test(
  "native composite payloads, results and errors match the official RPC server",
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
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-records-rpc-" });
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
          expect(yield* client.Next(WireBoundary.cases.Cursor.make({ cursor: "banana" }))).toEqual({
            _tag: "Cursor",
            cursor: "bbnbnb",
          });
          expect(
            yield* client.Label({
              item: { name: "n", count: 1n },
              boundary: WireBoundary.cases.Terminal.make({}),
            }),
          ).toBe("n");
          expect(yield* client.Store({ name: "kept", count: 2n })).toEqual({
            name: "kept",
            count: 2n,
          });
          expect(yield* client.Store({ name: "empty", count: 0n }).pipe(Effect.flip)).toEqual({
            _tag: "Cursor",
            cursor: "empty",
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);
