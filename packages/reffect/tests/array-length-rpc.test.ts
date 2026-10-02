import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// Remote's request field list, declared exactly as foldkit-remote's wire module does.
const Fields = Schema.Array(NativeRpc.StringJson).check(Schema.isMaxLength(3));
const Group = RpcGroup.make(
  Rpc.make("Count", { payload: Fields, success: Schema.Number }),
  Rpc.make("Read", {
    payload: Schema.Struct({
      fields: Fields,
      tags: Schema.optional(
        Schema.Array(Schema.Boolean).check(Schema.isNonEmpty(), Schema.isMaxLength(2)),
      ),
    }),
    success: Schema.Number,
  }),
  Rpc.make("Between", {
    payload: Schema.Array(Schema.Number).check(Schema.isBetweenLength(1, 2)),
    success: Schema.Number,
  }),
  Rpc.make("Min", {
    payload: Schema.Array(Schema.Boolean).check(Schema.isMinLength(2)),
    success: Schema.Number,
  }),
);

const count = R.fn([R.Array(R.String)], R.Number, (fields) =>
  R.Array.reduce(fields, R.Number.literal(0), (n) => R.Number.add(n, R.Number.literal(1))),
);
const Read = R.Struct({ fields: R.Array(R.String), tags: R.optional(R.Array(R.Bool)) });
const read = R.fn([Read], R.Number, (value) =>
  R.Array.reduce(R.Struct.get(value, "fields"), R.Number.literal(0), (n) =>
    R.Number.add(n, R.Number.literal(1)),
  ),
);
const between = R.fn([R.Array(R.Number)], R.Number, (items) =>
  R.Array.reduce(items, R.Number.literal(0), (n, x) => R.Number.add(n, x)),
);
const min = R.fn([R.Array(R.Bool)], R.Number, () => R.Number.literal(1));
const bindings = {
  Count: NativeRpc.bind(count),
  Read: NativeRpc.bind(read),
  Between: NativeRpc.bind(between),
  Min: NativeRpc.bind(min),
};

const request = (tag: string, payload: string) =>
  `{"_tag":"Request","id":"1","tag":"${tag}","payload":${payload},"headers":[]}`;
const corpus: ReadonlyArray<readonly [string, string]> = [
  ...[
    "[]",
    '["a"]',
    '["a","b","c"]',
    '["a","b","c","d"]',
    '["a",1,"c","d"]',
    "[1]",
    "{}",
    "null",
  ].map((body) => [`count ${body}`, request("Count", body)] as const),
  ...[
    '{"fields":[]}',
    '{"fields":["a","b","c","d"]}',
    '{"fields":[],"tags":[]}',
    '{"fields":[],"tags":[true]}',
    '{"fields":[],"tags":[true,true,true]}',
    '{"fields":[],"tags":[1,true,true]}',
    '{"fields":[],"tags":null}',
    '{"fields":[],"tags":3}',
    '{"fields":["a","b","c","d"],"tags":[]}',
  ].map((body) => [`read ${body}`, request("Read", body)] as const),
  ...["[]", "[1]", "[1,2]", "[1,2,3]", '["NaN",2,3]'].map(
    (body) => [`between ${body}`, request("Between", body)] as const,
  ),
  ...["[]", "[true]", "[true,false]", "[1]"].map(
    (body) => [`min ${body}`, request("Min", body)] as const,
  ),
];

const oracle = Effect.gen(function* () {
  const run = <A, E>(effect: Effect.Effect<A, E | { readonly _tag: "CompileError" }>) =>
    effect.pipe(Effect.catchTag("CompileError", Effect.die));
  const handlers = Group.toLayer({
    Count: (value) => run(Reference.run(count, [value])),
    Read: (value) => run(Reference.run(read, [value])),
    Between: (value) => run(Reference.run(between, [value])),
    Min: (value) => run(Reference.run(min, [value])),
  });
  const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
    Effect.provide([handlers, RpcSerialization.layerJson]),
  );
  return HttpEffect.toWebHandler(http);
});

test("length checks outside the decoded profile are refused", async () => {
  const Output = RpcGroup.make(Rpc.make("Only", { payload: Schema.Boolean, success: Fields }));
  const fields = R.fn([R.Bool], R.Array(R.String), () => R.Array.empty(R.String));
  const output = await Effect.runPromise(
    NativeRpc.compile(Output, { Only: NativeRpc.bind(fields) }).pipe(Effect.flip),
  );
  expect(output.message).toContain("decoding payloads only");
  const Unique = RpcGroup.make(
    Rpc.make("Only", {
      payload: Schema.Array(Schema.Boolean).check(Schema.isUnique()),
      success: Schema.Number,
    }),
  );
  const unique = await Effect.runPromise(
    NativeRpc.compile(Unique, { Only: NativeRpc.bind(min) }).pipe(Effect.flip),
  );
  expect(unique.message).toContain("Unsupported array check");
});

test(
  "native array length checks match the official server",
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
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-array-length-rpc-" });
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
          for (const [label, body] of corpus) {
            const native = yield* Effect.promise(async () => {
              const response = await fetch(`http://${address}/rpc`, { method: "POST", body });
              return { status: response.status, body: await response.text() };
            });
            const reference = yield* officialPost(body);
            expect(native.status, label).toBe(reference.status);
            expect(JSON.parse(native.body), label).toStrictEqual(JSON.parse(reference.body));
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);
