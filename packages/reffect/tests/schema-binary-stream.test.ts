/**
 * Streaming procedures over SchemaBinary (docs/research/schema-binary.md): each chunk is a
 * `Chunk` message holding a `NonEmptyArray` frame of the stream's elements, and the exit is
 * `Rpc.exitSchema`'s `Void` success or failure union. Native frames equal the official server's.
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

const S = R.Stream;
const n = (value: number) => R.Number.literal(value);
const Row = Schema.Struct({ n: Schema.Number, label: Schema.String });
const Group = RpcGroup.make(
  Rpc.make("Count", {
    payload: { upTo: Schema.Number },
    success: Schema.Number,
    error: Schema.String,
    stream: true,
  }),
  Rpc.make("Broken", { payload: {}, success: Schema.Number, error: Schema.String, stream: true }),
  Rpc.make("Nothing", { payload: {}, success: Schema.Number, stream: true }),
  Rpc.make("Words", { payload: {}, success: Schema.String, stream: true }),
  Rpc.make("Rows", { payload: {}, success: Row, stream: true }),
  Rpc.make("Double", { payload: { n: Schema.Number }, success: Schema.Number }),
);
const RRow = R.Struct({ n: R.Number, label: R.String });
const count = S.fn([R.Number], R.String, (upTo) =>
  S.range(1, upTo).pipe(
    S.rechunk(2),
    S.map((x) => R.Number.add(x, R.Number.literal(0.5))),
  ),
);
const broken = S.fn([], R.String, () =>
  S.concat(S.make(n(1), n(2)), S.fail(R.String.literal("boom"), R.Number)),
);
const nothing = S.fn([], R.Never, () => S.empty(R.Number));
const words = S.fn([], R.Never, () =>
  S.make(R.String.literal("é"), R.String.literal('"q"'), R.String.literal("😀")),
);
// Repeated labels in one chunk are back-references in its row run.
const rows = S.fn([], R.Never, () =>
  S.range(1, 5).pipe(
    S.rechunk(3),
    S.map((x) => RRow.make({ n: x, label: R.String.literal("row") })),
  ),
);
const double = R.fn([R.Number], R.Number, (x) => R.Number.add(x, x));
const bindings = {
  Count: NativeRpc.bind(count, ["upTo"]),
  Broken: NativeRpc.bind(broken),
  Nothing: NativeRpc.bind(nothing),
  Words: NativeRpc.bind(words),
  Rows: NativeRpc.bind(rows),
  Double: NativeRpc.bind(double, ["n"]),
};
const official = Effect.gen(function* () {
  const handlers = Group.toLayer({
    Count: ({ upTo }) => Reference.stream(count, [upTo]),
    Broken: () => Reference.stream(broken, []),
    Nothing: () => Reference.stream(nothing, []),
    Words: () => Reference.stream(words, []),
    Rows: () => Reference.stream(rows, []),
    Double: ({ n: x }) =>
      Reference.run(double, [x]).pipe(Effect.catchTag("CompileError", Effect.die)),
  });
  const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
    Effect.provide([handlers, RpcSerialization.layerSchemaBinary()]),
  );
  return HttpEffect.toWebHandler(http);
});

const binary = Effect.runSync(
  Effect.service(RpcSerialization.RpcSerialization).pipe(
    Effect.provide(RpcSerialization.layerSchemaBinary()),
  ),
);
const request = (id: number, tag: string, payload: unknown = {}) => {
  const rpc = Group.requests.get(tag);
  if (rpc === undefined) throw new Error(tag);
  return binary.makeUnsafe().encode({
    _tag: "Request",
    id,
    tag,
    payload: Schema.encodeUnknownSync(SchemaBinary.toCodec(rpc.payloadSchema))(payload),
    headers: [],
  }) as Uint8Array<ArrayBuffer>;
};
const join = (...parts: ReadonlyArray<Uint8Array>) =>
  new Uint8Array(parts.flatMap((part) => [...part]));
const corpus: ReadonlyArray<readonly [string, Uint8Array<ArrayBuffer>, boolean]> = [
  ["count", request(1, "Count", { upTo: 5 }), false],
  ["count none", request(1, "Count", { upTo: 0 }), false],
  ["broken", request(1, "Broken"), false],
  ["nothing", request(1, "Nothing"), false],
  ["words", request(1, "Words"), false],
  ["rows", request(1, "Rows"), false],
  [
    "a stream then a unary call",
    join(request(1, "Count", { upTo: 3 }), request(2, "Double", { n: 4 })),
    true,
  ],
];
/** A body's frames, grouped by request id in order, as hex. */
const byRequest = (body: Uint8Array) => {
  const grouped = new Map<string, Array<string>>();
  let pos = 0;
  while (pos < body.length) {
    let len = 0;
    let shift = 1;
    let header = 0;
    for (;;) {
      const b = body[pos + header++]!;
      len += (b & 0x7f) * shift;
      shift *= 128;
      if (b < 0x80) break;
    }
    const frame = body.subarray(pos, pos + header + len);
    pos += header + len;
    const [message] = binary.makeUnsafe().decode(frame) as ReadonlyArray<{
      readonly requestId?: string | number;
    }>;
    const id = String(message?.requestId ?? "");
    grouped.set(id, [...(grouped.get(id) ?? []), Buffer.from(frame).toString("hex")]);
  }
  return Object.fromEntries([...grouped].sort(([a], [b]) => a.localeCompare(b)));
};

test(
  "native streaming procedures answer as the official server (SchemaBinary)",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reference = yield* official;
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-sb-stream-" });
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
          const bytes = (response: Response) =>
            response.arrayBuffer().then((buffer) => new Uint8Array(buffer));
          for (const [label, body, concurrent] of corpus) {
            const native = yield* Effect.promise(() =>
              fetch(url, { method: "POST", body }).then(bytes),
            );
            const expected = yield* Effect.promise(() =>
              reference(new Request("http://reffect.test/rpc", { method: "POST", body })).then(
                bytes,
              ),
            );
            // Requests in one body run concurrently (#25): only each request's order is the
            // protocol's.
            if (concurrent) expect(byRequest(native), label).toStrictEqual(byRequest(expected));
            else
              expect(Buffer.from(native).toString("hex"), label).toBe(
                Buffer.from(expected).toString("hex"),
              );
            // The comparison covers chunks: more than one frame per request.
            expect(Object.values(byRequest(expected)).flat().length, label).toBeGreaterThan(
              label === "nothing" || label === "count none" ? 0 : 1,
            );
          }

          const client = yield* RpcClient.make(Group, { disableTracing: true }).pipe(
            Effect.provide(
              RpcClient.layerProtocolHttp({ url }).pipe(
                Layer.provide([FetchHttpClient.layer, RpcSerialization.layerSchemaBinary()]),
              ),
            ),
          );
          expect([...(yield* Stream.runCollect(client.Count({ upTo: 4 })))]).toEqual([
            1.5, 2.5, 3.5, 4.5,
          ]);
          expect(yield* Stream.runCollect(client.Broken({})).pipe(Effect.flip)).toBe("boom");
          expect([...(yield* Stream.runCollect(client.Words({})))]).toEqual(["é", '"q"', "😀"]);
          expect([...(yield* Stream.runCollect(client.Rows({})))]).toEqual(
            [1, 2, 3, 4, 5].map((x) => ({ n: x, label: "row" })),
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
