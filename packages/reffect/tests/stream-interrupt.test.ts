import { Effect, FileSystem, Logger, Option, Schema, Stream } from "effect";
import { HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// STREAM-002/003 (milestone 6 step 4): chunks reach the client as they are produced, and a client
// that disconnects interrupts the stream, whose finalizer runs exactly once, natively and on the
// official server. Both servers keep serving afterwards.
const S = R.Stream;
const Group = RpcGroup.make(
  Rpc.make("Ticks", { payload: {}, success: Schema.Number, stream: true }),
  Rpc.make("Forever", { payload: {}, success: Schema.Number, stream: true }),
  Rpc.make("Double", { payload: { n: Schema.Number }, success: Schema.Number }),
);
const ticks = S.fn([], R.Never, () => S.fromSchedule(R.Schedule.spaced(150)).pipe(S.take(3)));
const forever = S.fn([], R.Never, () =>
  S.fromSchedule(R.Schedule.spaced(30)).pipe(S.ensuring(R.Log.info("finalized"))),
);
const double = R.fn([R.Number], R.Number, (x) => R.Number.add(x, x));

const line = (tag: string, payload: unknown = {}) =>
  `${JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })}\n`;
type Post = (body: string, signal?: AbortSignal) => Promise<Response>;

/** What one server does: timing of the first chunk, the whole answer, and a disconnect. */
const exercise = async (post: Post, finalized: () => number) => {
  const started = Date.now();
  const response = await post(line("Ticks"));
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  const firstAt = Date.now() - started;
  let rest = "";
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
    rest += decoder.decode(chunk.value);
  const ticksAt = Date.now() - started;

  const abort = new AbortController();
  const live = await post(line("Forever"), abort.signal);
  const liveReader = live.body!.getReader();
  const liveFirst = decoder.decode((await liveReader.read()).value);
  await liveReader.cancel();
  abort.abort();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const afterDisconnect = finalized();
  const still = await (await post(line("Double", { n: 21 }))).text();
  return { first, firstAt, rest, ticksAt, liveFirst, afterDisconnect, still };
};

test(
  "streams arrive incrementally and a disconnect runs the finalizer once, as officially",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // The official server, its logger recording finalizer messages.
          const officialMessages: string[] = [];
          const capture = Logger.layer([
            Logger.make((options) => {
              officialMessages.push(String(options.message));
            }),
          ]);
          const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
            Effect.provide([
              Group.toLayer({
                Ticks: () => Reference.stream(ticks, []),
                Forever: () => Reference.stream(forever, []),
                Double: ({ n }) =>
                  Reference.run(double, [n]).pipe(Effect.catchTag("CompileError", Effect.die)),
              }),
              RpcSerialization.layerNdjson,
              capture,
            ]),
          );
          // A disconnect's finalizer runs in the HTTP request's fiber, so it gets the logger too.
          const officialHandler = HttpEffect.toWebHandler(http.pipe(Effect.provide(capture)));
          const official = yield* Effect.promise(() =>
            exercise(
              (body, signal) =>
                officialHandler(
                  new Request("http://reffect.test/rpc", { method: "POST", body, signal }),
                ),
              () => officialMessages.filter((m) => m.includes("finalized")).length,
            ),
          );

          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-stream-interrupt-" });
          const artifact = yield* NativeRpc.compile(
            Group,
            {
              Ticks: NativeRpc.bind(ticks),
              Forever: NativeRpc.bind(forever),
              Double: NativeRpc.bind(double, ["n"]),
            },
            { serialization: "ndjson" },
          );
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.fetch(directory);
          yield* CargoApi.build(directory, "debug");
          const child = yield* ChildProcess.make(
            `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
            ["--port", "0"],
          );
          const nativeRecords: string[] = [];
          yield* Stream.splitLines(Stream.decodeText(child.stderr)).pipe(
            Stream.runForEach((record) => Effect.sync(() => nativeRecords.push(record))),
            Effect.forkScoped,
          );
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
          const native = yield* Effect.promise(() =>
            exercise(
              (body, signal) => fetch(`http://${address}/rpc`, { method: "POST", body, signal }),
              () =>
                nativeRecords.filter(
                  (record) =>
                    record.startsWith('{"schema":"reffect.log@1"') &&
                    record.includes('"finalized"'),
                ).length,
            ),
          );

          for (const [name, run] of [
            ["official", official],
            ["native", native],
          ] as const) {
            // The first chunk arrives alone, well before the stream ends (3 × 150 ms).
            expect(run.first, name).toBe('{"_tag":"Chunk","requestId":"1","values":[0]}\n');
            expect(run.firstAt, name).toBeLessThan(run.ticksAt - 150);
            expect(run.liveFirst, name).toContain('"values":[0]');
            // The finalizer ran once on disconnect, and the server still answers.
            expect(run.afterDisconnect, name).toBe(1);
            expect(run.still, name).toContain('"value":42');
          }
          expect(native.first + native.rest).toBe(official.first + official.rest);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 180000,
);
