import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// Contract records keyed by plain Schema.String, as Remote's wire module declares them.
const WireCounts = Schema.Record(Schema.String, Schema.Number);
const WireWindow = Schema.Struct({
  first: Schema.optionalKey(Schema.Number),
  after: Schema.optionalKey(NativeRpc.StringJson),
});
const WireRequest = Schema.Struct({
  fields: Schema.Array(NativeRpc.StringJson),
  windows: Schema.optional(Schema.Record(Schema.String, WireWindow)),
});
const WireNested = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Boolean));
const Group = RpcGroup.make(
  Rpc.make("Echo", { payload: WireCounts, success: WireCounts }),
  Rpc.make("Keys", { payload: WireCounts, success: Schema.Array(NativeRpc.StringJson) }),
  Rpc.make("Values", { payload: WireCounts, success: Schema.Array(Schema.Number) }),
  Rpc.make("Size", { payload: WireCounts, success: Schema.Number }),
  Rpc.make("Request", { payload: WireRequest, success: WireRequest }),
  Rpc.make("Nested", { payload: WireNested, success: WireNested }),
  Rpc.make("Has", {
    payload: { record: WireCounts, key: NativeRpc.StringJson },
    success: Schema.Boolean,
  }),
);

const Counts = R.Record(R.String, R.Number);
const Window = R.Struct({ first: R.optionalKey(R.Number), after: R.optionalKey(R.String) });
const WindowRequest = R.Struct({
  fields: R.Array(R.String),
  windows: R.optional(R.Record(R.String, Window)),
});
const Nested = R.Record(R.String, R.Record(R.String, R.Bool));
const echo = R.fn([Counts], Counts, (counts) => counts);
const keys = R.fn([Counts], R.Array(R.String), (counts) => R.Record.keys(counts));
const values = R.fn([Counts], R.Array(R.Number), (counts) => R.Record.values(counts));
const size = R.fn([Counts], R.Number, (counts) => R.Record.size(counts));
const request = R.fn([WindowRequest], WindowRequest, (value) => value);
const nested = R.fn([Nested], Nested, (value) => value);
const has = R.fn([Counts, R.String], R.Bool, (counts, key) => R.Record.has(counts, key));
const bindings = {
  Echo: NativeRpc.bind(echo),
  Keys: NativeRpc.bind(keys),
  Values: NativeRpc.bind(values),
  Size: NativeRpc.bind(size),
  Request: NativeRpc.bind(request),
  Nested: NativeRpc.bind(nested),
  Has: NativeRpc.bind(has, ["record", "key"]),
};

const envelope = (tag: string, payload: string, id = "1") =>
  `{"_tag":"Request","id":"${id}","tag":"${tag}","payload":${payload},"headers":[]}`;
const mixed = '{"z":1,"a":2,"10":3,"2":4,"-1":5,"01":6,"4294967295":7,"4294967294":8,"0":9}';
const corpus: ReadonlyArray<readonly [string, string]> = [
  ["empty", envelope("Echo", "{}")],
  ["mixed order", envelope("Echo", mixed)],
  ["keys order", envelope("Keys", mixed)],
  ["values order", envelope("Values", mixed)],
  ["size", envelope("Size", mixed)],
  ["size empty", envelope("Size", "{}")],
  ["duplicate key", envelope("Echo", '{"b":1,"a":2,"b":3}')],
  ["proto key", envelope("Echo", '{"__proto__":1,"constructor":2}')],
  ["non-finite", envelope("Echo", '{"n":"NaN","i":"-Infinity"}')],
  ["array", envelope("Echo", "[]")],
  ["null", envelope("Echo", "null")],
  ["string", envelope("Echo", '"x"')],
  ["bad value", envelope("Echo", '{"a":1,"b":true,"c":"y"}')],
  ["bad index value first", envelope("Echo", '{"b":true,"5":"x"}')],
  ["bad value null", envelope("Echo", '{"a":null}')],
  ["request plain", envelope("Request", '{"fields":["a"]}')],
  ["request null windows", envelope("Request", '{"fields":[],"windows":null}')],
  [
    "request windows",
    envelope(
      "Request",
      '{"windows":{"posts":{"after":"c","first":10},"1":{},"author":{"first":2}},"fields":["posts","author"]}',
    ),
  ],
  ["request windows array", envelope("Request", '{"fields":[],"windows":[]}')],
  ["request windows number", envelope("Request", '{"fields":[],"windows":3}')],
  ["request bad window", envelope("Request", '{"fields":[],"windows":{"a":{"first":"x"}}}')],
  ["request window not object", envelope("Request", '{"fields":[],"windows":{"b":{},"a":1}}')],
  ["nested", envelope("Nested", '{"y":{"b":true,"a":false},"x":{},"3":{"1":true}}')],
  ["nested bad", envelope("Nested", '{"y":{"b":true,"a":1}}')],
  ["has present", envelope("Has", '{"record":{"a":1},"key":"a"}')],
  ["has absent", envelope("Has", '{"record":{"a":1},"key":"toString"}')],
  ["has index", envelope("Has", '{"record":{"7":1},"key":"7"}')],
  ["has bad record", envelope("Has", '{"record":[],"key":"a"}')],
];

// Object key sequences at every depth; JSON.parse keeps insertion order for non-index keys.
const order = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(order)
    : typeof value === "object" && value !== null
      ? Object.entries(value).map(([key, item]) => [key, order(item)])
      : value;
const exitValue = (body: string): unknown => {
  const parsed: unknown = JSON.parse(body);
  return Array.isArray(parsed)
    ? parsed.map((message) => (message as { exit?: { value?: unknown } }).exit?.value)
    : parsed;
};

const oracle = Effect.gen(function* () {
  const run = <A, E>(effect: Effect.Effect<A, E | { readonly _tag: "CompileError" }>) =>
    effect.pipe(Effect.catchTag("CompileError", Effect.die));
  const handlers = Group.toLayer({
    Echo: (value) => run(Reference.run(echo, [value])),
    Keys: (value) => run(Reference.run(keys, [value])),
    Values: (value) => run(Reference.run(values, [value])),
    Size: (value) => run(Reference.run(size, [value])),
    Request: (value) => run(Reference.run(request, [value])),
    Nested: (value) => run(Reference.run(nested, [value])),
    Has: ({ record, key }) => run(Reference.run(has, [record, key])),
  });
  const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
    Effect.provide([handlers, RpcSerialization.layerJson]),
  );
  return HttpEffect.toWebHandler(http);
});

test("records outside the admitted profile are refused", async () => {
  const keyed = RpcGroup.make(
    Rpc.make("Only", {
      payload: Schema.Record(Schema.String.check(Schema.isMinLength(1)), Schema.Number),
      success: Schema.Boolean,
    }),
  );
  const handler = R.fn([Counts], R.Bool, () => R.Bool.literal(true));
  const keyError = await Effect.runPromise(
    NativeRpc.compile(keyed, { Only: NativeRpc.bind(handler) }).pipe(Effect.flip),
  );
  expect(keyError.message).toContain("Record keys");
  const optionalValues = RpcGroup.make(
    Rpc.make("Only", {
      payload: Schema.Record(Schema.String, Schema.optional(Schema.Number)),
      success: Schema.Boolean,
    }),
  );
  const valueError = await Effect.runPromise(
    NativeRpc.compile(optionalValues, { Only: NativeRpc.bind(handler) }).pipe(Effect.flip),
  );
  expect(valueError.message).toContain("cannot be optional");
});

test(
  "native records match the official server, including key order",
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
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-records-js-rpc-" });
          const artifact = yield* NativeRpc.compile(Group, bindings);
          expect(artifact.files["Cargo.toml"]).toContain('"preserve_order"');
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
              return { status: response.status, body: await response.text() };
            });
          for (const [label, body] of corpus) {
            const native = yield* post(body);
            const reference = yield* officialPost(body);
            expect(native.status, label).toBe(reference.status);
            expect(JSON.parse(native.body), label).toStrictEqual(JSON.parse(reference.body));
            expect(order(exitValue(native.body)), `${label} key order`).toStrictEqual(
              order(exitValue(reference.body)),
            );
          }

          const client = yield* RpcClient.make(Group, { disableTracing: true }).pipe(
            Effect.provide(
              RpcClient.layerProtocolHttp({ url }).pipe(
                Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
              ),
            ),
          );
          const echoed = yield* client.Echo({ z: 1, a: NaN, "3": 2 });
          expect(Object.keys(echoed)).toEqual(["3", "z", "a"]);
          expect(yield* client.Keys({ b: 1, a: 2 })).toEqual(["b", "a"]);
          expect(yield* client.Has({ record: { a: 1 }, key: "a" })).toBe(true);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);
