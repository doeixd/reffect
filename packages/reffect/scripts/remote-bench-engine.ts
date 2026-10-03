/**
 * In-process engine cost of the official handlers, for comparison with the native engine timed
 * inside its own process (docs/research/remote-bench.md). Same payloads, 200 warm-up and 2000
 * measured calls each.
 */
import { Effect } from "effect";
import { RemoteServer } from "foldkit-remote-server";
import { domain, rows, workloads } from "./remote-bench-domain.ts";

// The published memory backend's server definition (foldkit-plus#140).
const server = RemoteServer.memory({ domain, rows }).server;
const handlers = RemoteServer.handlers(server, undefined);
const payloadOf = (name: string) =>
  (JSON.parse(workloads.find((workload) => workload.name === name)!.body) as { payload: never })
    .payload;

const time = async (name: string, call: () => Promise<unknown>) => {
  for (let i = 0; i < 200; i++) await call();
  const start = performance.now();
  const n = 2000;
  for (let i = 0; i < n; i++) await call();
  console.log(`${name} ${(((performance.now() - start) * 1000) / n).toFixed(1)} us`);
};
await time("official read batch-50", () =>
  Effect.runPromise(handlers.FoldkitRemoteRead(payloadOf("read-batch-50"))),
);
await time("official query page-20", () =>
  Effect.runPromise(handlers.FoldkitRemoteQuery(payloadOf("query-page-20"))),
);
