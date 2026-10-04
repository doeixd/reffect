/**
 * #16 step 1 (docs/research/rpc-serving.md): the native server times out slow headers and
 * bodies and serves a bounded number of connections, where axum::serve bounded neither.
 */
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { Effect, Fiber, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { Rpc, RpcGroup } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const Group = RpcGroup.make(Rpc.make("Ping", { payload: {}, success: Schema.String }));
const ping = R.fn([], R.String, () => R.String.literal("pong"));
const pingBody = JSON.stringify({
  _tag: "Request",
  id: "1",
  tag: "Ping",
  payload: {},
  headers: [],
});

/** Milliseconds until a raw socket is closed by the server, after writing `text`. */
const closedAfter = (host: string, port: number, text: string) =>
  new Promise<{ ms: number; received: string }>((resolve) => {
    const started = Date.now();
    let received = "";
    const socket = connect(port, host, () => socket.write(text));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (received += chunk));
    socket.on("close", () => resolve({ ms: Date.now() - started, received }));
    socket.on("error", () => {});
  });
const post = (host: string, port: number) =>
  new Promise<{ ms: number; status: number }>((resolve, reject) => {
    const started = Date.now();
    const outgoing = httpRequest(
      { host, port, method: "POST", path: "/rpc", agent: false },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({ ms: Date.now() - started, status: response.statusCode ?? 0 }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(pingBody);
  });

test(
  "slow headers and bodies time out, and connections beyond the cap wait",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-rpc-serving-" });
          const artifact = yield* NativeRpc.compile(
            Group,
            { Ping: NativeRpc.bind(ping) },
            { limits: { headerTimeoutMs: 1500, bodyTimeoutMs: 500, connections: 2 } },
          );
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
          const [host, portText] = address.split(":");
          const port = Number(portText);

          // A request still works.
          expect((yield* Effect.promise(() => post(host!, port))).status).toBe(200);

          // Headers that never finish: closed after the header timeout, not held forever.
          const headers = yield* Effect.promise(() =>
            closedAfter(host!, port, "POST /rpc HTTP/1.1\r\nHost: x\r\n"),
          );
          expect(headers.ms).toBeGreaterThanOrEqual(1000);
          expect(headers.ms).toBeLessThan(6000);

          // A body that stalls: answered 408 after the body timeout.
          const body = yield* Effect.promise(() =>
            closedAfter(
              host!,
              port,
              'POST /rpc HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: 100\r\n\r\n{"_tag"',
            ),
          );
          expect(body.received).toMatch(/^HTTP\/1\.1 408/);
          expect(body.ms).toBeLessThan(5000);

          // Two idle connections fill the cap; a third request waits until one closes.
          const idle = [connect(port, host!), connect(port, host!)];
          for (const socket of idle) socket.on("error", () => {});
          yield* Effect.sleep("200 millis");
          const fiber = yield* Effect.promise(() => post(host!, port)).pipe(Effect.forkScoped);
          yield* Effect.sleep("800 millis");
          idle[0]!.destroy();
          const third = yield* Fiber.join(fiber);
          idle[1]!.destroy();
          expect(third.status).toBe(200);
          expect(third.ms).toBeGreaterThanOrEqual(700);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
