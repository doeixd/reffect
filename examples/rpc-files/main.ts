import { Effect, Layer, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { FetchHttpClient } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { CargoApi, NativeRpc, R } from "../../packages/reffect/src/index.ts";
import { Files } from "./contract.ts";

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-rpc-files-" });
      const path = `${parent}/input.txt`;
      yield* fs.writeFileString(path, "hello");
      const handler = R.fn([R.Bool], R.U64, R.Bool, (wait) =>
        R.File.scoped(
          path,
          (file) =>
            file.size.pipe(
              R.Effect.flatMap((size) =>
                R.Match.bool(wait, R.Effect.sleep(10), R.Effect.void).pipe(
                  R.Effect.flatMap(() => R.Effect.succeed(size)),
                ),
              ),
            ),
          R.Log.info("file closed"),
        ),
      );
      const artifact = yield* NativeRpc.compile(Files, { Size: NativeRpc.bind(handler, ["wait"]) });
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
      if (!Option.isSome(ready)) return yield* Effect.die("Missing server ready record");
      const record = Schema.decodeUnknownSync(Schema.Struct({ address: Schema.String }))(
        JSON.parse(ready.value),
      );
      const client = yield* RpcClient.make(Files).pipe(
        Effect.provide(
          RpcClient.layerProtocolHttp({ url: `http://${record.address}/rpc` }).pipe(
            Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
          ),
        ),
      );
      const size = yield* client.Size({ wait: true });
      if (size !== 5n) return yield* Effect.die("Unexpected native file size");
      yield* Effect.sync(() => console.log(`stock client → native scoped file: size=${size}`));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
