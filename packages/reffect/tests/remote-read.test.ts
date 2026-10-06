import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { RemoteRpc } from "foldkit-remote";
import { RemoteServer } from "foldkit-remote-server";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRemote } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { successValue } from "./raw-json.ts";
import { corpus, domain, rows } from "./remote-read-corpus.ts";

// The published contract, served for Read only.
const ReadGroup = RemoteRpc.omit("FoldkitRemoteMutate", "FoldkitRemoteQuery", "FoldkitRemoteLive");

/** A read request body for the JSON wire. */
const body = (payload: unknown) =>
  JSON.stringify({ _tag: "Request", id: "1", tag: "FoldkitRemoteRead", payload, headers: [] });

const oracle = Effect.gen(function* () {
  // The published memory backend, served over a real RpcServer (foldkit-plus#140).
  const server = RemoteServer.memory({ domain, rows }).server;
  const handlers = RemoteServer.handlers(server, undefined);
  const http = yield* RpcServer.toHttpEffect(ReadGroup, { disableTracing: true }).pipe(
    Effect.provide([
      ReadGroup.toLayer({ FoldkitRemoteRead: handlers.FoldkitRemoteRead }),
      RpcSerialization.layerJson,
    ]),
  );
  return HttpEffect.toWebHandler(http);
});

test(
  "the native read engine matches foldkit-remote-server over the wire",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const official = yield* oracle;
          const officialPost = (body: string) =>
            Effect.promise(async () => {
              const response = await official(
                new Request("http://reffect.test/rpc", { method: "POST", body }),
              );
              return { status: response.status, body: await response.text() };
            });
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-remote-read-" });
          const artifact = yield* NativeRemote.compile(ReadGroup, { domain, rows });
          expect(artifact.runtime.crates).toContain("ryu-js@1.0.3");
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
          for (const [label, payload] of corpus) {
            const text = body(payload);
            const native = yield* Effect.promise(async () => {
              const response = await fetch(url, { method: "POST", body: text });
              return { status: response.status, body: await response.text() };
            });
            const reference = yield* officialPost(text);
            expect(native.status, label).toBe(reference.status);
            expect(JSON.parse(native.body), label).toStrictEqual(JSON.parse(reference.body));
            expect(successValue(native.body), `${label} raw key order`).toStrictEqual(
              successValue(reference.body),
            );
          }

          // The stock RPC client for the published contract reads through the native engine.
          const client = yield* RpcClient.make(ReadGroup, { disableTracing: true }).pipe(
            Effect.provide(
              RpcClient.layerProtocolHttp({ url }).pipe(
                Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
              ),
            ),
          );
          const result = yield* client.FoldkitRemoteRead({
            version: 4,
            requests: [
              {
                entity: "Project",
                id: "p3",
                fields: ["owner"],
                relations: { owner: { entity: "User", fields: ["name"] } },
              },
            ],
          });
          expect(result.entities.map((entity) => entity.id)).toEqual(["p3", "u2"]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 180000,
);
