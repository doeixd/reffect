import { Config, Effect, Layer, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { FetchHttpClient } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { CargoApi, NativeRpc } from "../../packages/reffect/src/index.ts";
import { Authenticated } from "../rpc-auth/contract.ts";
import { auth, bindings } from "./handlers.ts";

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const token = yield* Config.String("REFFECT_RPC_CLIENT_TOKEN");
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-rpc-async-example-" });
      const artifact = yield* NativeRpc.compile(Authenticated, bindings, { auth });
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
      const client = yield* RpcClient.make(Authenticated).pipe(
        Effect.provide(
          RpcClient.layerProtocolHttp({ url: `http://${record.address}/rpc` }).pipe(
            Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
          ),
        ),
      );
      const principal = yield* client.WhoAmI(
        { allowed: true },
        { headers: { authorization: `Bearer ${token}` } },
      );
      const denied = yield* client.WhoAmI({ allowed: true }).pipe(Effect.flip);
      const failed = yield* client
        .WhoAmI({ allowed: false }, { headers: { authorization: `Bearer ${token}` } })
        .pipe(Effect.flip);
      const publicValue = yield* client.Public(undefined);
      if (denied !== "Unauthorized" || failed !== false || publicValue !== 0n)
        throw new Error("Unexpected native RPC result");
      yield* Effect.sync(() =>
        console.log(
          `suspended authenticated stock client → native Rust: principal=${principal}, denial=${denied}, typed failure=${String(failed)}`,
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
