import { Effect, Layer, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { FetchHttpClient } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { CargoApi, NativeRpc, R } from "../../packages/reffect/src/index.ts";
import { Arithmetic } from "./contract.ts";

const bindings = {
  Add: NativeRpc.bind(
    R.fn([R.U64, R.U64], R.U64, (a, b) => a.pipe(R.U64.add(b))),
    ["left", "right"],
  ),
  Guard: NativeRpc.bind(
    R.fn([R.Bool], R.Bool, R.Bool, (allowed) =>
      R.Match.bool(allowed, R.Effect.succeed(allowed), R.Effect.fail(allowed)),
    ),
    ["allowed"],
  ),
};
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-rpc-example-" });
      const artifact = yield* NativeRpc.compile(Arithmetic, bindings);
      const directory = yield* CargoApi.write(artifact, `${parent}/server`);
      yield* CargoApi.fetch(directory);
      yield* CargoApi.build(directory);
      const server = yield* ChildProcess.make(
        `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
        ["--port", "0"],
      );
      yield* Stream.runDrain(server.stderr).pipe(Effect.forkScoped);
      const ready = yield* Stream.runHead(Stream.splitLines(Stream.decodeText(server.stdout))).pipe(
        Effect.timeout("5 seconds"),
      );
      if (!Option.isSome(ready)) throw new Error("Missing server ready record");
      const record = Schema.decodeUnknownSync(
        Schema.Struct({ schema: Schema.Literal("reffect.rpc.ready@1"), address: Schema.String }),
      )(JSON.parse(ready.value));
      const client = yield* RpcClient.make(Arithmetic).pipe(
        Effect.provide(
          RpcClient.layerProtocolHttp({ url: `http://${record.address}/rpc` }).pipe(
            Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
          ),
        ),
      );
      const sum = yield* client.Add({ left: 18446744073709551615n, right: 1n });
      const rejected = yield* client.Guard({ allowed: false }).pipe(Effect.flip);
      if (sum !== 0n || rejected !== false) throw new Error("Unexpected native RPC result");
      yield* Effect.sync(() =>
        console.log(`stock client → native Rust: sum=${sum}, typed failure=${String(rejected)}`),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
