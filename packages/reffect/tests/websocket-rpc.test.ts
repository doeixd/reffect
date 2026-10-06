/**
 * Milestone 11 (docs/research/websocket-rpc.md): a native server compiled with
 * `transport: "websocket"` serves Effect RPC sessions as `RpcServer.layerHttp({ protocol:
 * "websocket" })` does. A scripted session (the probe's cases) gets the same frames from both
 * servers; the stock `RpcClient` over `layerProtocolSocket` works under JSON, NDJSON and
 * SchemaBinary.
 */
import { createServer } from "node:http";
import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeHttpServer, NodeServices, NodeSocket } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const S = R.Stream;
const Group = RpcGroup.make(
  Rpc.make("Echo", { payload: { text: Schema.String }, success: Schema.String }),
  Rpc.make("Fail", { payload: {}, success: Schema.String, error: Schema.String }),
  Rpc.make("Count", { payload: { upTo: Schema.Number }, success: Schema.Number, stream: true }),
  Rpc.make("Wait", { payload: {}, success: Schema.String }),
);
const echo = R.fn([R.String], R.String, (text) => text);
const fail = R.fn([], R.String, R.String, () => R.Effect.fail(R.String.literal("nope")));
const count = S.fn([R.Number], R.Never, (upTo) => S.range(1, upTo).pipe(S.rechunk(1)));
const wait = R.fn([], R.String, R.Never, () =>
  R.Effect.sleep(60000).pipe(R.Effect.andThen(R.Effect.succeed(R.String.literal("done")))),
);
const bindings = {
  Echo: NativeRpc.bind(echo, ["text"]),
  Fail: NativeRpc.bind(fail),
  Count: NativeRpc.bind(count, ["upTo"]),
  Wait: NativeRpc.bind(wait),
};
const run = <A, E>(effect: Effect.Effect<A, E | { readonly _tag: "CompileError" }>) =>
  effect.pipe(Effect.catchTag("CompileError", Effect.die));
const handlers = Group.toLayer({
  Echo: ({ text }) => run(Reference.run(echo, [text])),
  Fail: () => run(Reference.run(fail, [])),
  Count: ({ upTo }) => Reference.stream(count, [upTo]),
  Wait: () => run(Reference.run(wait, [])),
});

type Serialization = "json" | "ndjson" | "schema-binary";
const layerOf = (serialization: Serialization) =>
  serialization === "json"
    ? RpcSerialization.layerJson
    : serialization === "ndjson"
      ? RpcSerialization.layerNdjson
      : RpcSerialization.layerSchemaBinary();
/** The official socket server on `port`, for the life of the scope. */
const official = (port: number, serialization: Serialization) =>
  Layer.launch(
    HttpRouter.serve(
      RpcServer.layerHttp({
        group: Group,
        path: "/rpc",
        protocol: "websocket",
        disableTracing: true,
      }).pipe(Layer.provide(handlers), Layer.provide(layerOf(serialization))),
      { disableListenLog: true, disableLogger: true },
    ).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port }))),
  ).pipe(Effect.forkScoped);

/** A native server for `serialization`, for the life of the scope: its address. */
const native = (serialization: Serialization) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-websocket-" });
    const artifact = yield* NativeRpc.compile(Group, bindings, {
      transport: "websocket",
      serialization,
    });
    const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
    yield* CargoApi.fetch(directory);
    yield* CargoApi.build(directory, "debug");
    const child = yield* ChildProcess.make(
      `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
      ["--port", "0"],
    );
    yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
    const ready = yield* Stream.runHead(Stream.splitLines(Stream.decodeText(child.stdout))).pipe(
      Effect.timeout("10 seconds"),
    );
    if (!Option.isSome(ready)) throw new Error("Missing ready record");
    return Schema.decodeUnknownSync(
      Schema.Struct({ schema: Schema.Literal("reffect.rpc.ready@1"), address: Schema.String }),
    )(JSON.parse(ready.value)).address;
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const req = (id: number | string, tag: string, payload: unknown = {}) =>
  JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] });
type Step = (send: (frame: string) => void, frames: string[]) => Promise<void>;
/** The probe's cases, each on a fresh socket, as JSON frames. */
const script: ReadonlyArray<readonly [string, Step]> = [
  ["unary", async (send) => send(req(0, "Echo", { text: "hi" }))],
  ["typed failure", async (send) => send(req(1, "Fail"))],
  [
    "stream: one chunk until each Ack",
    async (send, frames) => {
      send(req(2, "Count", { upTo: 3 }));
      await sleep(500);
      frames.push(`-- before any Ack: ${frames.length}`);
      for (let i = 0; i < 4; i++) {
        send(JSON.stringify({ _tag: "Ack", requestId: 2 }));
        await sleep(200);
      }
    },
  ],
  [
    "interrupt a stream",
    async (send) => {
      send(req(3, "Count", { upTo: 3 }));
      await sleep(300);
      send(JSON.stringify({ _tag: "Interrupt", requestId: 3 }));
    },
  ],
  [
    "interrupt a pending request",
    async (send) => {
      send(req(4, "Wait"));
      await sleep(300);
      send(JSON.stringify({ _tag: "Interrupt", requestId: 4 }));
    },
  ],
  ["ping", async (send) => send(JSON.stringify({ _tag: "Ping" }))],
  [
    "garbage, then ping",
    async (send) => {
      send("not json");
      await sleep(200);
      send(JSON.stringify({ _tag: "Ping" }));
    },
  ],
  [
    "array frame",
    async (send) => send(`[${req(5, "Echo", { text: "a" })},${req(6, "Echo", { text: "b" })}]`),
  ],
  [
    "interrupt an unknown id",
    async (send) => send(JSON.stringify({ _tag: "Interrupt", requestId: 42 })),
  ],
  [
    "a duplicate in-flight id closes the session",
    async (send) => {
      send(req(7, "Wait"));
      await sleep(200);
      send(req(7, "Echo", { text: "dup" }));
    },
  ],
  [
    "unknown tag and bad payload",
    async (send) => {
      send(req(8, "Nope"));
      send(req(9, "Echo", { text: 1 }));
    },
  ],
  [
    "string id, then Eof, then a request",
    async (send) => {
      send(req("s", "Echo", { text: "x" }));
      await sleep(100);
      send(JSON.stringify({ _tag: "Eof" }));
      await sleep(100);
      send(req(10, "Echo", { text: "after" }));
    },
  ],
];
/** What a server answers the script: per case, its frames and any close code. */
const answers = async (url: string) => {
  const out: Record<string, string[]> = {};
  for (const [name, step] of script) {
    const ws = new WebSocket(url);
    const frames: string[] = [];
    ws.onmessage = (event) => frames.push(String(event.data));
    ws.onclose = (event) => frames.push(`closed ${event.code}`);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    await step((frame) => ws.send(frame), frames);
    await sleep(400);
    if (ws.readyState === WebSocket.OPEN) ws.close();
    await sleep(100);
    // A client-initiated close is not part of the answer.
    out[name] = frames
      .filter((frame) => frame !== "closed 1005" && frame !== "closed 1000")
      // Native execution has no JS fiber id (async-rpc); the parse text is the native JSON one.
      .map((frame) =>
        frame
          .replace(/,"fiberId":\d+/g, "")
          .replace(/"message":"Unexpected token.*?is not valid JSON"/, '"message":"Invalid JSON"'),
      );
  }
  return out;
};

const port = 4800 + (process.pid % 100);

test(
  "a native WebSocket session answers a scripted session as the official server",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* official(port, "json");
          yield* Effect.sleep("500 millis");
          const expected = yield* Effect.promise(() => answers(`ws://127.0.0.1:${port}/rpc`));
          const address = yield* native("json");
          const actual = yield* Effect.promise(() => answers(`ws://${address}/rpc`));
          expect(actual).toStrictEqual(expected);
          // The comparison covers backpressure, interruption and the duplicate-id close.
          expect(expected["stream: one chunk until each Ack"]).toContain("-- before any Ack: 1");
          expect(expected["a duplicate in-flight id closes the session"]).toContain("closed 1001");
          expect(expected["interrupt a pending request"]?.[0]).toContain('"Interrupt"');
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);

for (const serialization of ["json", "ndjson", "schema-binary"] as const)
  test(
    `the stock client over a native WebSocket session (${serialization})`,
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const address = yield* native(serialization);
            // The socket protocol lives as long as the test's scope: provided to `make` alone,
            // its socket would close as soon as the client was made.
            const protocol = yield* Layer.build(
              RpcClient.layerProtocolSocket().pipe(
                Layer.provide([
                  NodeSocket.layerWebSocket(`ws://${address}/rpc`),
                  layerOf(serialization),
                ]),
              ),
            );
            const client = yield* RpcClient.make(Group, { disableTracing: true }).pipe(
              Effect.provideContext(protocol),
            );
            expect(yield* client.Echo({ text: "héllo" })).toBe("héllo");
            expect(yield* Effect.flip(client.Fail({}))).toBe("nope");
            expect([...(yield* Stream.runCollect(client.Count({ upTo: 5 })))]).toEqual([
              1, 2, 3, 4, 5,
            ]);
            // A consumer that stops early interrupts the stream; the session goes on.
            expect([
              ...(yield* Stream.runCollect(Stream.take(client.Count({ upTo: 100 }), 2))),
            ]).toEqual([1, 2]);
            // An interrupted request is interrupted on the server too; the session goes on.
            expect(yield* client.Wait({}).pipe(Effect.timeoutOption("300 millis"))).toEqual(
              Option.none(),
            );
            const concurrent = yield* Effect.all(
              Array.from({ length: 8 }, (_, i) => client.Echo({ text: `n${i}` })),
              { concurrency: "unbounded" },
            );
            expect(concurrent).toEqual(Array.from({ length: 8 }, (_, i) => `n${i}`));
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    },
    nativeTestBudget(0) + 240000,
  );
