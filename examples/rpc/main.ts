import { Effect, Layer, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { FetchHttpClient } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { CargoApi } from "../../packages/reffect/src/index.ts";
import { Arithmetic } from "./contract.ts";
import compile from "./server.ts";

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-rpc-example-" });
      const artifact = yield* compile;
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
      const found = yield* client.FirstBelow({ values: [9n, 7n, 3n, 1n], limit: 5n });
      const missing = yield* client.FirstBelow({ values: [9n], limit: 5n });
      const left = yield* client.Withdraw({ balance: 10n, amount: 4n });
      const refused = yield* client.Withdraw({ balance: 3n, amount: 4n }).pipe(Effect.flip);
      if (
        sum !== 0n ||
        rejected !== false ||
        found !== 3n ||
        missing !== null ||
        left !== 6n ||
        refused !== "insufficient funds"
      )
        throw new Error("Unexpected native RPC result");
      yield* Effect.sync(() =>
        console.log(
          `stock client → native Rust: sum=${sum}, typed failure=${String(rejected)}, ` +
            `firstBelow=${found}/${String(missing)}, withdraw=${left}/${refused}`,
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
