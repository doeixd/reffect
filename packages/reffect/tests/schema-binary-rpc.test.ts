/**
 * Milestone 10 step 3 (docs/research/schema-binary.md): a native server compiled with
 * `serialization: "schema-binary"` answers SchemaBinary requests byte for byte as the official
 * server running the same R handlers does, and the stock client calls it. Requests the official
 * server answers with a connection defect (an undecodable payload, Effect-TS/effect#8826) are
 * answered with that request's `Die`, whose text is the official JSON server's (SB-REQUEST-DEFECT).
 */
import { Cause, Effect, Exit, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { SchemaBinary } from "effect/encoding";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference } from "../src/index.ts";
import { defaultFieldId } from "../src/schema-binary.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const Measure = Schema.Struct({
  x: Schema.Number,
  flag: Schema.Boolean,
  label: Schema.optional(NativeRpc.StringJson),
  key: Schema.optionalKey(NativeRpc.StringJson),
  note: Schema.NullOr(NativeRpc.StringJson),
  kind: Schema.Literals(["a", "b"]),
  id: NativeRpc.U64Json,
  inner: Schema.Struct({ ok: Schema.Boolean }),
  maybe: Schema.NullOr(Schema.Struct({ v: Schema.Number })),
});
const Group = RpcGroup.make(
  Rpc.make("Echo", { payload: Measure, success: Measure }),
  Rpc.make("Count", {
    payload: { n: Schema.Number.check(Schema.isInt()) },
    success: Schema.Number,
  }),
  Rpc.make("Check", {
    payload: NativeRpc.StringJson,
    success: Schema.Boolean,
    error: NativeRpc.StringJson,
  }),
  Rpc.make("Ping", { payload: {}, success: NativeRpc.StringJson }),
);

const RMeasure = R.Struct({
  x: R.Number,
  flag: R.Bool,
  label: R.optional(R.String),
  key: R.optionalKey(R.String),
  note: R.NullOr(R.String),
  kind: R.Literals(["a", "b"]),
  id: R.U64,
  inner: R.Struct({ ok: R.Bool }),
  maybe: R.NullOr(R.Struct({ v: R.Number })),
});
const echo = R.fn([RMeasure], RMeasure, (measure) => measure);
const count = R.fn([R.Number], R.Number, (n) => R.Number.add(n, R.Number.literal(0.5)));
const check = R.fn([R.String], R.Bool, R.String, (text) =>
  R.Match.bool(
    R.String.eq(text, R.String.literal("")),
    R.Effect.succeed(R.Bool.literal(true)),
    R.Effect.fail(text),
  ),
);
const ping = R.fn([], R.String, () => R.String.literal("pong"));
const bindings = {
  Echo: NativeRpc.bind(echo),
  Count: NativeRpc.bind(count, ["n"]),
  Check: NativeRpc.bind(check),
  Ping: NativeRpc.bind(ping),
};

const officialHandler = (serialization: Layer.Layer<RpcSerialization.RpcSerialization>) =>
  Effect.gen(function* () {
    const run = <A, E>(effect: Effect.Effect<A, E | { readonly _tag: "CompileError" }>) =>
      effect.pipe(Effect.catchTag("CompileError", Effect.die));
    const handlers = Group.toLayer({
      Echo: (value) => run(Reference.run(echo, [value])),
      Count: ({ n }) => run(Reference.run(count, [n])),
      Check: (text) => run(Reference.run(check, [text])),
      Ping: () => run(Reference.run(ping, [])),
    });
    const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
      Effect.provide([handlers, serialization]),
    );
    return HttpEffect.toWebHandler(http);
  });

const binary = Effect.runSync(
  Effect.service(RpcSerialization.RpcSerialization).pipe(
    Effect.provide(RpcSerialization.layerSchemaBinary()),
  ),
);
const procedure = (tag: string) => {
  const rpc = Group.requests.get(tag);
  if (rpc === undefined) throw new Error(`No procedure ${tag}`);
  return rpc;
};
/** A body of one SchemaBinary request, its payload written by Effect's own codec. */
const requestBody = (tag: string, payload: unknown, id: number | string = 0) =>
  binary.makeUnsafe().encode({
    _tag: "Request",
    id,
    tag,
    payload: Schema.encodeUnknownSync(SchemaBinary.toCodec(procedure(tag).payloadSchema))(payload),
    headers: [],
  }) as Uint8Array<ArrayBuffer>;
/** A request whose payload frame is given as raw bytes. */
const rawRequest = (tag: string, payload: Uint8Array) =>
  binary
    .makeUnsafe()
    .encode({ _tag: "Request", id: 0, tag, payload, headers: [] }) as Uint8Array<ArrayBuffer>;

const measure = {
  x: 1,
  flag: true,
  note: null,
  kind: "a",
  id: 7n,
  inner: { ok: false },
  maybe: null,
} as const;
const values: ReadonlyArray<typeof Measure.Type> = [
  measure,
  { ...measure, label: "l", key: "k", note: "n", kind: "b", maybe: { v: 1.5 } },
  { ...measure, label: undefined },
  { ...measure, x: -0, id: 0n },
  { ...measure, x: 0.1, id: 18446744073709551615n },
  { ...measure, x: Number.NaN, maybe: { v: Number.POSITIVE_INFINITY } },
  { ...measure, x: Number.NEGATIVE_INFINITY, maybe: { v: -2.5e-3 } },
  { ...measure, x: 2 ** 48, note: "" },
  { ...measure, x: 2 ** 48 - 1, note: "é😀\u0000" },
  { ...measure, x: Math.PI, label: "" },
  { ...measure, x: 1e21, key: "" },
  { ...measure, x: 12.5, maybe: { v: 21990232555.51 } },
];
const corpus: ReadonlyArray<readonly [string, Uint8Array<ArrayBuffer>]> = [
  ...values.map((value, i) => [`echo ${i}`, requestBody("Echo", value, i)] as const),
  ...[0, 1, -1, 2 ** 40, -(2 ** 52), Number.MAX_SAFE_INTEGER].map(
    (n) => [`count ${n}`, requestBody("Count", { n })] as const,
  ),
  ["check empty", requestBody("Check", "")],
  ["check text", requestBody("Check", "no")],
  ["ping", requestBody("Ping", {}, "p")],
  [
    "two requests",
    new Uint8Array([...requestBody("Ping", {}, 1), ...requestBody("Check", "x", 2)]),
  ],
];
const uvHex = (n: number) => {
  const bytes: number[] = [];
  for (; n > 0x7f; n = Math.floor(n / 128)) bytes.push((n % 128) | 0x80);
  bytes.push(n);
  return Buffer.from(bytes).toString("hex");
};
const f64Hex = (x: number) => {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleLE(x);
  return bytes.toString("hex");
};
/** A default-mode payload frame around a struct's fields, given as hex. */
const payloadFrame = (fields: string) =>
  new Uint8Array(Buffer.from(`${uvHex(1 + fields.length / 2)}20${fields}`, "hex"));
/**
 * Payloads the stock client cannot write, as hand-made frames, with the JSON payload Effect reads
 * the same way. An `isInt` field carries only varints: an f64 there is skipped as absent.
 */
const refused: ReadonlyArray<readonly [string, string, Uint8Array, string]> = [
  ["count missing", "Count", payloadFrame(""), "{}"],
  ["count as f64", "Count", payloadFrame(uvHex(defaultFieldId("n") * 8 + 2) + f64Hex(1.5)), "{}"],
];

test(
  "a native SchemaBinary server answers as the official one, and the stock client calls it",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const official = yield* officialHandler(RpcSerialization.layerSchemaBinary());
          const officialJson = yield* officialHandler(RpcSerialization.layerJson);
          const officialPost = (body: Uint8Array<ArrayBuffer>) =>
            Effect.promise(async () => {
              const response = await official(
                new Request("http://reffect.test/rpc", { method: "POST", body }),
              );
              return {
                status: response.status,
                body: new Uint8Array(await response.arrayBuffer()),
              };
            });

          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-schema-binary-" });
          const artifact = yield* NativeRpc.compile(Group, bindings, {
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
          const url = `http://${address}/rpc`;
          const post = (body: Uint8Array<ArrayBuffer>) =>
            Effect.promise(async () => {
              const response = await fetch(url, { method: "POST", body });
              return {
                status: response.status,
                type: response.headers.get("content-type"),
                body: new Uint8Array(await response.arrayBuffer()),
              };
            });

          // Byte equality with the official server.
          for (const [label, body] of corpus) {
            const native = yield* post(body);
            const reference = yield* officialPost(body);
            expect(native.status, label).toBe(reference.status);
            expect(native.type, label).toBe("application/vnd.effect.rpc+schema-binary");
            expect(Buffer.from(native.body).toString("hex"), label).toBe(
              Buffer.from(reference.body).toString("hex"),
            );
          }

          // SB-REQUEST-DEFECT: the request's own Die, with the official JSON server's text.
          const defectOf = (tag: string, body: Uint8Array) => {
            const [message] = binary.makeUnsafe().decode(body) as ReadonlyArray<{
              readonly _tag: string;
              readonly exit?: Uint8Array;
            }>;
            expect(message?._tag).toBe("Exit");
            const exit = Schema.decodeUnknownSync(
              SchemaBinary.toCodec(Rpc.exitSchema(procedure(tag))),
            )(message?.exit);
            if (!Exit.isFailure(exit)) throw new Error(`${tag} succeeded`);
            return Cause.squash(exit.cause);
          };
          const jsonDefect = (tag: string, payload: string) =>
            Effect.promise(async () => {
              const response = await officialJson(
                new Request("http://reffect.test/rpc", {
                  method: "POST",
                  body: `{"_tag":"Request","id":"0","tag":"${tag}","payload":${payload},"headers":[]}`,
                }),
              );
              const [answer] = (await response.json()) as ReadonlyArray<{
                readonly exit: { readonly cause: ReadonlyArray<{ readonly defect: string }> };
              }>;
              return answer?.exit.cause[0]?.defect;
            });
          for (const [label, tag, payload, json] of refused) {
            const native = yield* post(rawRequest(tag, payload));
            expect(defectOf(tag, native.body), label).toBe(yield* jsonDefect(tag, json));
          }
          // A payload frame that does not decode at all, and an unknown procedure.
          const truncated = yield* post(rawRequest("Count", new Uint8Array([0x05, 0x20])));
          expect(defectOf("Count", truncated.body)).toBe("Expected complete value");
          const twice = payloadFrame(`${uvHex(defaultFieldId("n") * 8 + 1)}04`.repeat(2));
          const repeated = yield* post(rawRequest("Count", twice));
          expect(defectOf("Count", repeated.body)).toBe("Expected unique field ids");
          const utf8 = yield* post(rawRequest("Check", new Uint8Array([0x02, 0x20, 0xff])));
          expect(defectOf("Check", utf8.body)).toBe("Expected utf-8");
          const unknown = yield* post(rawRequest("Nope", new Uint8Array([0x01, 0x20])));
          expect(defectOf("Check", unknown.body)).toBe("Unknown request tag: Nope");

          // The stock client under layerSchemaBinary, including after a refused request.
          const client = yield* RpcClient.make(Group, { disableTracing: true }).pipe(
            Effect.provide(
              RpcClient.layerProtocolHttp({ url }).pipe(
                Layer.provide([FetchHttpClient.layer, RpcSerialization.layerSchemaBinary()]),
              ),
            ),
          );
          for (const value of values)
            expect(yield* client.Echo(value)).toStrictEqual(
              yield* Reference.run(echo, [value]).pipe(Effect.orDie),
            );
          expect(Object.is(-0, (yield* client.Echo({ ...measure, x: -0 })).x)).toBe(true);
          expect(yield* client.Count({ n: 4 })).toBe(4.5);
          expect(yield* client.Check("")).toBe(true);
          expect(yield* Effect.flip(client.Check("bad"))).toBe("bad");
          expect(yield* client.Ping({})).toBe("pong");
          // A procedure the server lacks fails alone, and the client keeps working (#8826).
          const extended = yield* RpcClient.make(
            Group.add(Rpc.make("Missing", { payload: {}, success: Schema.String })),
            { disableTracing: true },
          ).pipe(
            Effect.provide(
              RpcClient.layerProtocolHttp({ url }).pipe(
                Layer.provide([FetchHttpClient.layer, RpcSerialization.layerSchemaBinary()]),
              ),
            ),
          );
          const missing = yield* Effect.exit(extended.Missing({}));
          if (!Exit.isFailure(missing)) throw new Error("Missing succeeded");
          expect(Cause.squash(missing.cause)).toBe("Unknown request tag: Missing");
          expect(yield* extended.Ping({})).toBe("pong");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);

test("SchemaBinary options outside the first slice are refused while compiling", async () => {
  const refusal = (options: Parameters<typeof NativeRpc.compile>[2]) =>
    Effect.runPromise(NativeRpc.compile(Group, bindings, options).pipe(Effect.flip)).then(
      (error) => error.message,
    );
  expect(
    await refusal({ serialization: "schema-binary", schemaBinary: { maxFrameSize: 0 } }),
  ).toContain("positive safe integer");
  expect(await refusal({ schemaBinary: { maxFrameSize: 1024 } })).toContain(
    'serialization: "schema-binary"',
  );
});
