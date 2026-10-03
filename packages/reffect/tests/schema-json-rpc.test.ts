import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, Compile, NativeRpc, R, Reference, SourceArtifacts } from "../src/index.ts";
import type { IRType } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { successValue } from "./raw-json.ts";

// RM-006: typed values encode as Schema.toCodecJson encodes them, verified over the wire.
const Shape = Schema.Struct({
  name: Schema.String,
  count: Schema.Number,
  tags: Schema.Array(Schema.String),
  maybe: Schema.optional(Schema.Number),
  key: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["draft", "live"]),
  data: Schema.Unknown,
  scores: Schema.Record(Schema.String, Schema.Number),
});
const Event = Schema.Union([
  Schema.TaggedStruct("Opened", { at: Schema.Number }),
  Schema.TaggedStruct("Closed", { reason: Schema.String, code: Schema.optionalKey(Schema.Number) }),
]);
const Group = RpcGroup.make(
  Rpc.make("Num", { payload: Schema.Number, success: Schema.Unknown }),
  Rpc.make("Shape", { payload: Shape, success: Schema.Unknown }),
  Rpc.make("Events", { payload: Schema.Array(Event), success: Schema.Unknown }),
  Rpc.make("Pair", {
    payload: { left: Shape, right: Schema.Number },
    success: Schema.Array(Schema.Unknown),
  }),
);

const NumW = NativeRpc.witness(Schema.Number);
const ShapeW = NativeRpc.witness(Shape);
const EventsW = NativeRpc.witness(Schema.Array(Event));
const encode = <A>(witness: IRType<A>) => R.Schema.encodeSync(R.Schema.toCodecJson(witness));
const num = R.fn([NumW], R.Unknown, (value) => encode(NumW)(value));
const shape = R.fn([ShapeW], R.Unknown, (value) => encode(ShapeW)(value));
const events = R.fn([EventsW], R.Unknown, (value) => encode(EventsW)(value));
// Two encoders in one function, and one witness shared with another procedure.
const pair = R.fn([ShapeW, NumW], R.Array(R.Unknown), (left, right) =>
  R.Array.make(encode(ShapeW)(left), encode(NumW)(right)),
);
const bindings = {
  Num: NativeRpc.bind(num),
  Shape: NativeRpc.bind(shape),
  Events: NativeRpc.bind(events),
  Pair: NativeRpc.bind(pair, ["left", "right"]),
};

const request = (tag: string, payload: string) =>
  `{"_tag":"Request","id":"1","tag":"${tag}","payload":${payload},"headers":[]}`;
const shapes = [
  '{"name":"a","count":1,"tags":[],"status":"draft","data":null,"scores":{}}',
  '{"scores":{"b":1,"2":-0,"a":0.1},"data":{"y":[1.50,{"q":-0}],"x":"é"},"status":"live","tags":["x","y"],"count":"NaN","name":"é 😀","maybe":-0,"key":"k"}',
  '{"name":"","count":"-Infinity","tags":[""],"maybe":null,"status":"draft","data":[],"scores":{"10":1,"9":2}}',
  '{"name":"n","count":1e21,"tags":[],"status":"live","data":5e-324,"scores":{"x":"Infinity"}}',
];
const corpus: ReadonlyArray<readonly [string, string]> = [
  ...[
    "0",
    "-0",
    "1.5",
    '"NaN"',
    '"Infinity"',
    '"-Infinity"',
    "9007199254740993",
    "1e21",
    "5e-324",
  ].map((value) => [`num ${value}`, request("Num", value)] as const),
  ...shapes.map((value, i) => [`shape ${i}`, request("Shape", value)] as const),
  [
    "events",
    request(
      "Events",
      '[{"_tag":"Closed","reason":"done"},{"at":"NaN","_tag":"Opened"},{"code":-0,"reason":"","_tag":"Closed"}]',
    ),
  ],
  ["events empty", request("Events", "[]")],
  ...shapes.map(
    (value, i) => [`pair ${i}`, request("Pair", `{"right":"Infinity","left":${value}}`)] as const,
  ),
];

const oracle = Effect.gen(function* () {
  const run = <A, E>(effect: Effect.Effect<A, E | { readonly _tag: "CompileError" }>) =>
    effect.pipe(Effect.catchTag("CompileError", Effect.die));
  const handlers = Group.toLayer({
    Num: (value) => run(Reference.run(num, [value])),
    Shape: (value) => run(Reference.run(shape, [value])),
    Events: (value) => run(Reference.run(events, [value])),
    Pair: ({ left, right }) => run(Reference.run(pair, [left, right])),
  });
  const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
    Effect.provide([handlers, RpcSerialization.layerJson]),
  );
  return HttpEffect.toWebHandler(http);
});

test("encoding needs a host's verified codecs", async () => {
  const plain = await Effect.runPromise(
    Compile.make(R.program({ num })).pipe(
      Compile.withSourceArtifacts(SourceArtifacts.None),
      Compile.run,
      Effect.flip,
    ),
  );
  expect(plain.message).toContain("Missing capability");
  const artifact = await Effect.runPromise(NativeRpc.compile(Group, bindings));
  // One encoder per witness, however often it is used.
  expect(artifact.files["src/lib.rs"].match(/pub fn json_/g)).toHaveLength(3);
});

test(
  "native typed-value encoding matches Schema.toCodecJson over the wire",
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
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-schema-json-" });
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
          const post = (body: string) =>
            Effect.promise(async () => {
              const response = await fetch(`http://${address}/rpc`, { method: "POST", body });
              return { status: response.status, body: await response.text() };
            });
          for (const [label, body] of corpus) {
            const native = yield* post(body);
            const reference = yield* officialPost(body);
            expect(native.status, label).toBe(reference.status);
            expect(reference.body, label).toContain('"Success"');
            expect(JSON.parse(native.body), label).toStrictEqual(JSON.parse(reference.body));
            expect(successValue(native.body), `${label} raw key order`).toStrictEqual(
              successValue(reference.body),
            );
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);
