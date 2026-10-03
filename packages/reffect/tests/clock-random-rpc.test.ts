import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcClient, RpcGroup, RpcSerialization } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const Group = RpcGroup.make(
  Rpc.make("Now", { payload: Schema.Undefined, success: Schema.Number }),
  Rpc.make("Later", { payload: Schema.Undefined, success: Schema.Number }),
);
const now = R.fn([], R.Number, R.Never, () => R.Clock.currentTimeMillis);
const later = R.fn([], R.Number, R.Never, () =>
  R.Effect.sleep(1).pipe(R.Effect.andThen(R.Clock.currentTimeMillis)),
);

test("RPC refuses Random without an explicitly selected native driver", async () => {
  const random = R.fn([], R.Number, R.Never, () => R.Random.next);
  const group = RpcGroup.make(
    Rpc.make("Draw", { payload: Schema.Undefined, success: Schema.Number }),
  );
  const failure = await Effect.runPromise(
    NativeRpc.compile(group, { Draw: NativeRpc.bind(random) }).pipe(Effect.flip),
  );
  expect(failure.diagnostics.some((issue) => issue.code === "MISSING_RUNTIME_SERVICE")).toBe(true);
});

test(
  "stock clients read live Clock from synchronous and suspended native handlers",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-clock-rpc-" });
          const artifact = yield* NativeRpc.compile(Group, {
            Now: NativeRpc.bind(now),
            Later: NativeRpc.bind(later),
          });
          expect(artifact.files["src/lib.rs"]).not.toContain("struct RandomDriver");
          expect(artifact.files["src/lib.rs"]).not.toContain("enum ClockDriver");
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.fetch(directory);
          for (const profile of ["debug", "release"] as const) {
            yield* CargoApi.build(directory, profile);
            yield* Effect.scoped(
              Effect.gen(function* () {
                const child = yield* ChildProcess.make(
                  `${directory}/target/${profile}/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
                  ["--port", "0"],
                );
                yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
                const ready = yield* Stream.runHead(
                  Stream.splitLines(Stream.decodeText(child.stdout)),
                ).pipe(Effect.timeout("5 seconds"));
                if (!Option.isSome(ready)) throw new Error("Missing Clock RPC ready record");
                const record = Schema.decodeUnknownSync(
                  Schema.Struct({
                    schema: Schema.Literal("reffect.rpc.ready@1"),
                    address: Schema.String,
                  }),
                )(JSON.parse(ready.value));
                const client = yield* RpcClient.make(Group, { disableTracing: true }).pipe(
                  Effect.provide(
                    RpcClient.layerProtocolHttp({ url: `http://${record.address}/rpc` }).pipe(
                      Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
                    ),
                  ),
                );
                for (const read of [
                  client.Now(undefined),
                  client.Later(undefined),
                  client.Now(undefined),
                ]) {
                  const millis = yield* read;
                  expect(Number.isSafeInteger(millis)).toBe(true);
                  // A broad epoch check detects a monotonic-origin or definition-time sentinel.
                  expect(millis).toBeGreaterThan(1_000_000_000_000);
                  expect(millis).toBeLessThan(10_000_000_000_000);
                }
              }),
            );
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);
