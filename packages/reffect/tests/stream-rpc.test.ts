import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// STREAM-006: R.Stream.fn answers a `stream: true` procedure with the official server's chunks
// and exit, under NDJSON (streamed) and JSON (buffered), alongside a unary procedure.
const S = R.Stream;
const n = (value: number) => R.Number.literal(value);
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
  Rpc.make("Double", { payload: { n: Schema.Number }, success: Schema.Number }),
);
const count = S.fn([R.Number], R.String, (upTo) =>
  S.range(1, upTo).pipe(
    S.rechunk(2),
    S.map((x) => R.Number.add(x, x)),
  ),
);
const broken = S.fn([], R.String, () =>
  S.concat(S.make(n(1), n(2)), S.fail(R.String.literal("boom"), R.Number)),
);
const nothing = S.fn([], R.Never, () => S.empty(R.Number));
const words = S.fn([], R.Never, () =>
  S.make(R.String.literal("é"), R.String.literal('"q"'), R.String.literal("😀")),
);
const double = R.fn([R.Number], R.Number, (x) => R.Number.add(x, x));
const bindings = {
  Count: NativeRpc.bind(count, ["upTo"]),
  Broken: NativeRpc.bind(broken),
  Nothing: NativeRpc.bind(nothing),
  Words: NativeRpc.bind(words),
  Double: NativeRpc.bind(double, ["n"]),
};
const official = (serialization: "json" | "ndjson") =>
  Effect.gen(function* () {
    const handlers = Group.toLayer({
      Count: ({ upTo }) => Reference.stream(count, [upTo]),
      Broken: () => Reference.stream(broken, []),
      Nothing: () => Reference.stream(nothing, []),
      Words: () => Reference.stream(words, []),
      Double: ({ n: x }) =>
        Reference.run(double, [x]).pipe(Effect.catchTag("CompileError", Effect.die)),
    });
    const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
      Effect.provide([
        handlers,
        serialization === "ndjson" ? RpcSerialization.layerNdjson : RpcSerialization.layerJson,
      ]),
    );
    return HttpEffect.toWebHandler(http);
  });

const message = (id: string, tag: string, payload: unknown = {}) =>
  JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] });
const corpus: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["count", [message("1", "Count", { upTo: 5 })]],
  ["count none", [message("1", "Count", { upTo: 0 })]],
  ["broken", [message("1", "Broken")]],
  ["nothing", [message("1", "Nothing")]],
  ["words", [message("1", "Words")]],
  [
    "a stream then a unary call",
    [message("1", "Count", { upTo: 3 }), message("2", "Double", { n: 4 })],
  ],
  ["invalid stream payload", [message("1", "Count", { upTo: "x" })]],
];
const body = (serialization: "json" | "ndjson", messages: ReadonlyArray<string>) =>
  serialization === "ndjson"
    ? messages.map((line) => `${line}\n`).join("")
    : messages.length === 1
      ? messages[0]
      : `[${messages.join(",")}]`;

for (const serialization of ["ndjson", "json"] as const)
  test(
    `native streaming procedures answer as the official server (${serialization})`,
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const reference = yield* official(serialization);
            const fs = yield* FileSystem.FileSystem;
            const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-stream-rpc-" });
            const artifact = yield* NativeRpc.compile(Group, bindings, { serialization });
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
            const answers = new Map<string, string>();
            for (const [label, messages] of corpus) {
              const text = body(serialization, messages);
              const native = yield* Effect.promise(() =>
                fetch(url, { method: "POST", body: text }).then((r) => r.text()),
              );
              const expected = yield* Effect.promise(() =>
                reference(
                  new Request("http://reffect.test/rpc", { method: "POST", body: text }),
                ).then((r) => r.text()),
              );
              answers.set(label, expected);
              if (serialization === "ndjson") expect(native, label).toBe(expected);
              else expect(JSON.parse(native), label).toStrictEqual(JSON.parse(expected));
            }
            // The chunks compared are really there.
            expect(answers.get("count")).toContain('"values":[2,4]');
            expect(answers.get("count")).toContain('"values":[10]');
            expect(answers.get("broken")).toContain('"error":"boom"');
            expect(answers.get("a stream then a unary call")).toContain('"value":8');
            // A stock client consumes the native stream.
            const client = yield* RpcClient.make(Group, { disableTracing: true }).pipe(
              Effect.provide(
                RpcClient.layerProtocolHttp({ url }).pipe(
                  Layer.provide([
                    FetchHttpClient.layer,
                    serialization === "ndjson"
                      ? RpcSerialization.layerNdjson
                      : RpcSerialization.layerJson,
                  ]),
                ),
              ),
            );
            expect([...(yield* Stream.runCollect(client.Count({ upTo: 4 })))]).toEqual([
              2, 4, 6, 8,
            ]);
            expect(yield* Stream.runCollect(client.Broken({})).pipe(Effect.flip)).toBe("boom");
            expect([...(yield* Stream.runCollect(client.Words({})))]).toEqual(["é", '"q"', "😀"]);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    },
    nativeTestBudget(0) + 180000,
  );
