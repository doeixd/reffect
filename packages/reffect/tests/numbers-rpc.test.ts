import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// Remote's page size, declared exactly as foldkit-remote's wire module does.
const PageSize = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Range = Schema.Number.check(Schema.isGreaterThan(1), Schema.isLessThanOrEqualTo(10));
const Group = RpcGroup.make(
  Rpc.make("Echo", { payload: Schema.Number, success: Schema.Number }),
  Rpc.make("Page", {
    payload: { size: PageSize, version: Schema.Number },
    success: Schema.Number,
  }),
  Rpc.make("Ranged", { payload: Range, success: Schema.Boolean }),
  Rpc.make("NonNegative", {
    payload: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
    success: Schema.Number,
  }),
  Rpc.make("Finite", { payload: Schema.Number.check(Schema.isFinite()), success: Schema.Number }),
  Rpc.make("Sizes", {
    payload: Schema.Struct({ first: PageSize, all: Schema.Array(Schema.Number) }),
    success: Schema.Array(Schema.Number),
  }),
);

const echo = R.fn([R.Number], R.Number, (x) => x);
const page = R.fn([R.Number, R.Number], R.Number, (size, version) => R.Number.add(size, version));
const ranged = R.fn([R.Number], R.Bool, (x) => R.Number.lt(x, R.Number.literal(5)));
const nonNegative = R.fn([R.Number], R.Number, (x) => R.Number.add(x, R.Number.literal(0.5)));
const finite = R.fn([R.Number], R.Number, (x) => x);
const Sizes = R.Struct({ first: R.Number, all: R.Array(R.Number) });
const sizes = R.fn([Sizes], R.Array(R.Number), (value) =>
  R.Array.map(R.Struct.get(value, "all"), (x) => R.Number.add(x, R.Struct.get(value, "first"))),
);
const bindings = {
  Echo: NativeRpc.bind(echo),
  Page: NativeRpc.bind(page, ["size", "version"]),
  Ranged: NativeRpc.bind(ranged),
  NonNegative: NativeRpc.bind(nonNegative),
  Finite: NativeRpc.bind(finite),
  Sizes: NativeRpc.bind(sizes),
};

const request = (tag: string, payload: string, id = "1") =>
  `{"_tag":"Request","id":"${id}","tag":"${tag}","payload":${payload},"headers":[]}`;
const scalars = [
  "1",
  "-1.5",
  "-0",
  "0.1",
  "1e21",
  "9007199254740992",
  "9007199254740993",
  "5e-324",
  "1e300",
  '"NaN"',
  '"Infinity"',
  '"-Infinity"',
  '"1"',
  "true",
  "null",
];
const corpus: ReadonlyArray<readonly [string, string]> = [
  ...scalars.map((value) => [`echo ${value}`, request("Echo", value)] as const),
  ...scalars.map((value) => [`ranged ${value}`, request("Ranged", value)] as const),
  ...scalars.map((value) => [`nonNegative ${value}`, request("NonNegative", value)] as const),
  ...scalars.map((value) => [`finite ${value}`, request("Finite", value)] as const),
  ["page", request("Page", '{"size":10,"version":4}')],
  ["page fractional size", request("Page", '{"size":1.5,"version":4}')],
  ["page negative size", request("Page", '{"size":-1,"version":4}')],
  ["page unsafe size", request("Page", '{"size":9007199254740992,"version":4}')],
  ["page string size", request("Page", '{"size":"NaN","version":4}')],
  ["page nonfinite version", request("Page", '{"size":1,"version":"Infinity"}')],
  ["page missing version", request("Page", '{"size":1}')],
  ["sizes", request("Sizes", '{"first":2,"all":[1,"NaN",-0.5]}')],
  ["sizes bad first", request("Sizes", '{"first":2.5,"all":[]}')],
  ["sizes bad element", request("Sizes", '{"first":2,"all":[1,true]}')],
];

const oracle = Effect.gen(function* () {
  const run = <A, E>(effect: Effect.Effect<A, E | { readonly _tag: "CompileError" }>) =>
    effect.pipe(Effect.catchTag("CompileError", Effect.die));
  const handlers = Group.toLayer({
    Echo: (x) => run(Reference.run(echo, [x])),
    Page: ({ size, version }) => run(Reference.run(page, [size, version])),
    Ranged: (x) => run(Reference.run(ranged, [x])),
    NonNegative: (x) => run(Reference.run(nonNegative, [x])),
    Finite: (x) => run(Reference.run(finite, [x])),
    Sizes: (value) => run(Reference.run(sizes, [value])),
  });
  const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
    Effect.provide([handlers, RpcSerialization.layerJson]),
  );
  return HttpEffect.toWebHandler(http);
});

test("checked outputs and unrecognized number checks are refused", async () => {
  const CheckedOutput = RpcGroup.make(
    Rpc.make("Only", { payload: Schema.Number, success: PageSize }),
  );
  const output = await Effect.runPromise(
    NativeRpc.compile(CheckedOutput, { Only: NativeRpc.bind(echo) }).pipe(Effect.flip),
  );
  expect(output.message).toContain("decoding payloads only");
  const Multiple = RpcGroup.make(
    Rpc.make("Only", {
      payload: Schema.Number.check(Schema.isMultipleOf(2)),
      success: Schema.Number,
    }),
  );
  const multiple = await Effect.runPromise(
    NativeRpc.compile(Multiple, { Only: NativeRpc.bind(echo) }).pipe(Effect.flip),
  );
  expect(multiple.message).toContain("Unsupported number check");
});

test(
  "native numbers at the RPC boundary match the official server",
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
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-numbers-rpc-" });
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
              return { status: response.status, body: await response.text() };
            });
          // Compare parsed JSON: values and key sets, with -0 and 0 kept distinct.
          for (const [label, body] of corpus) {
            const native = yield* post(body);
            const reference = yield* officialPost(body);
            expect(native.status, label).toBe(reference.status);
            expect(JSON.parse(native.body), label).toStrictEqual(JSON.parse(reference.body));
          }

          const client = yield* RpcClient.make(Group, { disableTracing: true }).pipe(
            Effect.provide(
              RpcClient.layerProtocolHttp({ url }).pipe(
                Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
              ),
            ),
          );
          expect(Number.isNaN(yield* client.Echo(NaN))).toBe(true);
          expect(yield* client.Echo(-Infinity)).toBe(-Infinity);
          expect(yield* client.Page({ size: 3, version: 0.25 })).toBe(3.25);
          expect(yield* client.Sizes({ first: 1, all: [1, 2.5] })).toEqual([2, 3.5]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);
