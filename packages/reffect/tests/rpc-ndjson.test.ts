import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference } from "../src/index.ts";
import type { Expr } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// STREAM-001: `serialization: "ndjson"` answers as an official `RpcSerialization.layerNdjson`
// server, byte for byte, for unary procedures on the synchronous and asynchronous runtimes.
const Group = RpcGroup.make(
  Rpc.make("Double", {
    payload: { n: Schema.Number },
    success: Schema.Number,
    error: Schema.String,
  }),
);
const doubled = (n: Expr<number>) =>
  R.Match.bool(
    R.Number.lt(n, R.Number.literal(0)),
    R.Effect.fail(R.String.literal("negative")),
    R.Effect.succeed(R.Number.add(n, n)),
  );
const double = R.fn([R.Number], R.Number, R.String, doubled);
// The same after a sleep, so the server runs on the asynchronous runtime.
const slowDouble = R.fn([R.Number], R.Number, R.String, (n) =>
  R.Effect.sleep(1).pipe(R.Effect.andThen(doubled(n))),
);

const line = (id: string, payload: unknown, tag = "Double") =>
  JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] });
// The official server's NDJSON quirks, captured in streaming-rpc.md, are part of the corpus.
const corpus: ReadonlyArray<readonly [string, string]> = [
  ["one", `${line("1", { n: 2 })}\n`],
  ["two in one body", `${line("1", { n: 2 })}\n${line("2", { n: -1 })}\n`],
  ["malformed line skipped", `{nope\n${line("2", { n: 3 })}\n`],
  ["blank lines skipped", `\n\n${line("1", { n: 2 })}\n\n`],
  ["no trailing newline", line("1", { n: 2 })],
  ["empty", ""],
  ["array line", `[${line("1", { n: 2 })}]\n`],
  ["number line", "42\n"],
  ["unknown tag", `${line("1", { n: 2 }, "Nope")}\n`],
  ["invalid payload", `${line("1", { n: "x" })}\n`],
];

const official = (fn: typeof double) =>
  Effect.gen(function* () {
    const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
      Effect.provide([
        Group.toLayer({
          Double: ({ n }) =>
            Reference.run(fn, [n]).pipe(Effect.catchTag("CompileError", Effect.die)),
        }),
        RpcSerialization.layerNdjson,
      ]),
    );
    return HttpEffect.toWebHandler(http);
  });

for (const [runtime, fn] of [
  ["synchronous", double],
  ["asynchronous", slowDouble],
] as const)
  test(
    `native NDJSON answers equal the official layerNdjson server's (${runtime})`,
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const reference = yield* official(fn);
            const fs = yield* FileSystem.FileSystem;
            const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-ndjson-" });
            const artifact = yield* NativeRpc.compile(
              Group,
              { Double: NativeRpc.bind(fn, ["n"]) },
              { serialization: "ndjson" },
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
            const url = `http://${address}/rpc`;
            const answer = (response: Response) =>
              response.text().then((body) => ({
                status: response.status,
                contentType: response.headers.get("content-type"),
                body,
              }));
            for (const [label, body] of corpus) {
              const native = yield* Effect.promise(() =>
                fetch(url, { method: "POST", body }).then(answer),
              );
              const expected = yield* Effect.promise(() =>
                reference(new Request("http://reffect.test/rpc", { method: "POST", body })).then(
                  answer,
                ),
              );
              // An empty 500 carries no content type officially; the native one may.
              expect(native.status, label).toBe(expected.status);
              expect(native.body, label).toBe(expected.body);
              if (expected.status === 200)
                expect(native.contentType, label).toBe(expected.contentType);
            }
            // A stock client over layerNdjson.
            const client = yield* RpcClient.make(Group, { disableTracing: true }).pipe(
              Effect.provide(
                RpcClient.layerProtocolHttp({ url }).pipe(
                  Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson]),
                ),
              ),
            );
            expect(yield* client.Double({ n: 21 })).toBe(42);
            expect(yield* client.Double({ n: -1 }).pipe(Effect.flip)).toBe("negative");
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    },
    nativeTestBudget(0) + 180000,
  );
