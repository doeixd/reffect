import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, Compile, NativeRpc, R, Reference, SourceArtifacts } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { successValue } from "./raw-json.ts";

// Shapes from foldkit-remote's wire: entity values and mutation input carry Schema.Unknown.
const WireEntity = Schema.Struct({
  id: NativeRpc.StringJson,
  values: Schema.Record(Schema.String, Schema.Unknown),
});
const Group = RpcGroup.make(
  Rpc.make("Top", { payload: Schema.Unknown, success: Schema.Unknown }),
  Rpc.make("Field", { payload: Schema.Struct({ v: Schema.Unknown }), success: Schema.Unknown }),
  Rpc.make("Entity", { payload: WireEntity, success: WireEntity }),
  Rpc.make("Mutate", {
    payload: { requestId: NativeRpc.StringJson, input: Schema.Unknown },
    success: Schema.Array(Schema.Unknown),
  }),
);

const Field = R.Struct({ v: R.Unknown });
const Entity = R.Struct({ id: R.String, values: R.Record(R.String, R.Unknown) });
const top = R.fn([R.Unknown], R.Unknown, (value) => value);
const field = R.fn([Field], R.Unknown, (value) => R.Struct.get(value, "v"));
const entity = R.fn([Entity], Entity, (value) => value);
const mutate = R.fn([R.String, R.Unknown], R.Array(R.Unknown), (_requestId, input) =>
  R.Array.make(input, input),
);
const bindings = {
  Top: NativeRpc.bind(top),
  Field: NativeRpc.bind(field),
  Entity: NativeRpc.bind(entity),
  Mutate: NativeRpc.bind(mutate, ["requestId", "input"]),
};

const request = (tag: string, payload: string) =>
  `{"_tag":"Request","id":"1","tag":"${tag}","payload":${payload},"headers":[]}`;
const values = [
  '{"b":1,"2":0,"a":{"z":1,"1":2}}',
  "1.0",
  "1e2",
  "-0",
  "12345678901234567890",
  "0.1",
  "5e-324",
  '"é \\u00e9 \\ud83d\\ude00"',
  "null",
  '[1,{"y":2,"x":1},[{"10":1,"9":2}]]',
  '{"a":1,"a":2}',
  '{"b":1,"a":2,"b":3}',
  "true",
  '{"__proto__":{"x":1}}',
  "{}",
  "[]",
];
const corpus: ReadonlyArray<readonly [string, string]> = [
  ...values.map((value) => [`top ${value}`, request("Top", value)] as const),
  ...values.map((value) => [`field ${value}`, request("Field", `{"v":${value}}`)] as const),
  ["field missing", request("Field", "{}")],
  ["field null payload", request("Field", "null")],
  [
    "entity",
    request(
      "Entity",
      `{"values":{"title":"x","3":[1.50,{"q":-0}],"author":{"b":2,"a":1}},"id":"p1"}`,
    ),
  ],
  ["entity bad values", request("Entity", '{"id":"p1","values":[]}')],
  ...values.map(
    (value) =>
      [`mutate ${value}`, request("Mutate", `{"input":${value},"requestId":"r"}`)] as const,
  ),
  ["mutate missing input", request("Mutate", '{"requestId":"r"}')],
];

const oracle = Effect.gen(function* () {
  const run = <A, E>(effect: Effect.Effect<A, E | { readonly _tag: "CompileError" }>) =>
    effect.pipe(Effect.catchTag("CompileError", Effect.die));
  const handlers = Group.toLayer({
    Top: (value) => run(Reference.run(top, [value])),
    Field: (value) => run(Reference.run(field, [value])),
    Entity: (value) => run(Reference.run(entity, [value])),
    Mutate: ({ requestId, input }) => run(Reference.run(mutate, [requestId, input])),
  });
  const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
    Effect.provide([handlers, RpcSerialization.layerJson]),
  );
  return HttpEffect.toWebHandler(http);
});

test("Unknown derives the JSON capability and refuses literals and optional use", async () => {
  const withJson = await Effect.runPromise(
    Compile.make(R.program({ top })).pipe(
      Compile.withSourceArtifacts(SourceArtifacts.None),
      Compile.run,
    ),
  );
  expect(withJson.explanation.crates).toContain("serde_json@1.0.151");
  expect(withJson.files["Cargo.toml"]).toContain("serde_json");
  const plain = await Effect.runPromise(
    Compile.make(R.program({ id: R.fn([R.Bool], R.Bool, (b) => b) })).pipe(
      Compile.withSourceArtifacts(SourceArtifacts.None),
      Compile.run,
    ),
  );
  expect(plain.explanation.crates).not.toContain("serde_json@1.0.151");
  expect(plain.files["Cargo.toml"]).not.toContain("serde_json");
  const literal = await Effect.runPromise(
    Compile.make(R.program({ one: R.fn([R.Bool], R.Unknown, () => R.literal(R.Unknown, 1)) })).pipe(
      Compile.run,
      Effect.flip,
    ),
  );
  expect(literal.diagnostics.map((d) => d.message)).toContain(
    "R.Unknown values come only from decoded input",
  );
  const Optional = RpcGroup.make(
    Rpc.make("Only", {
      payload: Schema.Struct({ v: Schema.optional(Schema.Unknown) }),
      success: Schema.Boolean,
    }),
  );
  const optional = await Effect.runPromise(
    NativeRpc.compile(Optional, {
      Only: NativeRpc.bind(
        R.fn([R.Struct({ v: R.optional(R.Unknown) })], R.Bool, () => R.Bool.literal(true)),
      ),
    }).pipe(Effect.flip),
  );
  expect(optional.message).toContain("optional(Unknown)");
});

test(
  "native Unknown values match the official server as JSON.parse sees them",
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
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-unknown-rpc-" });
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
            const nativeJson: unknown = JSON.parse(native.body);
            const referenceJson: unknown = JSON.parse(reference.body);
            expect(nativeJson, label).toStrictEqual(referenceJson);
            expect(successValue(native.body), `${label} raw key order`).toStrictEqual(
              successValue(reference.body),
            );
          }
          // NUM-005b: a double overflow is a per-request refusal officially, a whole-body one natively.
          const overflow = request("Top", "1e400");
          expect((yield* officialPost(overflow)).body).toContain("Expected JSON value");
          expect((yield* post(overflow)).body).toContain("Invalid JSON");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);
