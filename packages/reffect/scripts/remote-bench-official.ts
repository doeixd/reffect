/**
 * The official side of the Remote benchmark, run in its own process: the published
 * `RemoteServer.handlers` with memory sources, served by `RpcServer.layerHttp` on
 * `NodeHttpServer`, the way an application deploys it. Prints `{ "address": ... }` when ready.
 */
import { createServer } from "node:http";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { RemoteServer } from "foldkit-remote-server";
import {
  memoryQueryRun,
  memoryRead,
  memoryTables,
} from "../tests/fixtures/foldkit-remote-memory.ts";
import { ByStatus, Group, rows } from "./remote-bench-domain.ts";

const tables = memoryTables(rows);
const server = RemoteServer.make<undefined>({
  entities: ["User", "Project"].map((name) =>
    RemoteServer.entity<undefined>({ name }, { read: memoryRead(tables, name) }),
  ),
  queries: [RemoteServer.query(ByStatus, memoryQueryRun(tables, ByStatus))],
});
const handlers = RemoteServer.handlers(server, undefined);

const Ready = Layer.effectDiscard(
  HttpServer.addressFormattedWith((address) =>
    Effect.sync(() => console.log(JSON.stringify({ address }))),
  ),
);
const App = HttpRouter.serve(
  RpcServer.layerHttp({ group: Group, path: "/rpc", protocol: "http", disableTracing: true }),
).pipe(
  Layer.merge(Ready),
  Layer.provide([
    Group.toLayer({
      FoldkitRemoteRead: handlers.FoldkitRemoteRead,
      FoldkitRemoteQuery: handlers.FoldkitRemoteQuery,
    }),
    RpcSerialization.layerJson,
  ]),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
);
NodeRuntime.runMain(Layer.launch(App));
