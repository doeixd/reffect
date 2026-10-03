/**
 * Native versus official Remote server throughput, latency and memory (docs/research/remote-bench.md).
 * Run: `vp exec node --experimental-transform-types packages/reffect/scripts/remote-bench.ts`.
 * Each server runs in its own process; this process only generates load.
 */
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import { CargoApi, NativeRemote } from "../src/index.ts";
import { Group, domain, rows, workloads } from "./remote-bench-domain.ts";

const REQUESTS = 4000;
const CONCURRENCY = 32;
const WARMUP = 300;

const firstLine = (child: ChildProcess, pick: (line: string) => string | undefined) =>
  new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      const found = pick(line);
      if (found !== undefined) resolve(found);
    });
    child.on("exit", (code) => reject(new Error(`server exited (${code})`)));
  });
const parsed = (line: string, key: string) => {
  try {
    const value = (JSON.parse(line) as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
};
const peakMemoryMiB = (pid: number): number => {
  if (process.platform === "win32") {
    const out = execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      `(Get-Process -Id ${pid}).PeakWorkingSet64`,
    ]).toString();
    return Number(out.trim()) / 1024 / 1024;
  }
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const kib = Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] ?? NaN);
  return kib / 1024;
};
// Load comes from worker threads: one fetch loop saturates a single Node thread long before
// either server does (both servers measured ~1,900 req/s with an in-thread client).
const WORKERS = 4;
const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const { url, body, count, concurrency } = workerData;
  const latencies = [];
  let next = 0;
  const loop = async () => {
    while (next < count) {
      next++;
      const start = performance.now();
      const response = await fetch(url, { method: "POST", body });
      await response.text();
      latencies.push(performance.now() - start);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, loop));
  parentPort.postMessage(latencies);
})();`;
// BENCH-003: with REFFECT_BENCH_OHA set to an oha binary, a native load generator replaces fetch.
const OHA = process.env.REFFECT_BENCH_OHA;
const runOha = (url: string, body: string, count: number) => {
  const file = join(mkdtempSync(join(tmpdir(), "reffect-body-")), "body.json");
  writeFileSync(file, body);
  const report = JSON.parse(
    execFileSync(
      OHA!,
      [
        "-n",
        String(count),
        "-c",
        String(CONCURRENCY),
        "-m",
        "POST",
        "-D",
        file,
        "-H",
        "content-type: application/json",
        "--no-tui",
        "--output-format",
        "json",
        url,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    ).toString(),
  ) as {
    readonly summary: { readonly requestsPerSec: number; readonly successRate: number };
    readonly latencyPercentiles: {
      readonly p50: number;
      readonly p95: number;
      readonly p99: number;
    };
  };
  if (report.summary.successRate !== 1) throw new Error(`oha saw failures against ${url}`);
  const ms = (seconds: number) => Number((seconds * 1000).toFixed(3));
  return {
    requestsPerSecond: Math.round(report.summary.requestsPerSec),
    p50ms: ms(report.latencyPercentiles.p50),
    p95ms: ms(report.latencyPercentiles.p95),
    p99ms: ms(report.latencyPercentiles.p99),
  };
};
const run = async (url: string, body: string, count: number) => {
  if (OHA) return runOha(url, body, count);
  const started = performance.now();
  const parts = await Promise.all(
    Array.from(
      { length: WORKERS },
      () =>
        new Promise<number[]>((resolve, reject) => {
          const worker = new Worker(workerSource, {
            eval: true,
            workerData: { url, body, count: count / WORKERS, concurrency: CONCURRENCY / WORKERS },
          });
          worker.once("message", (latencies: number[]) => {
            resolve(latencies);
            void worker.terminate();
          });
          worker.once("error", reject);
        }),
    ),
  );
  const seconds = (performance.now() - started) / 1000;
  const latencies = parts.flat().sort((a, b) => a - b);
  const at = (q: number) =>
    Number(latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))].toFixed(3));
  return {
    requestsPerSecond: Math.round(count / seconds),
    p50ms: at(0.5),
    p95ms: at(0.95),
    p99ms: at(0.99),
  };
};

const directory = await Effect.runPromise(
  Effect.gen(function* () {
    const artifact = yield* NativeRemote.compile(Group, { domain, rows });
    const target = yield* CargoApi.write(
      artifact,
      join(mkdtempSync(join(tmpdir(), "reffect-bench-")), "crate"),
    );
    yield* CargoApi.fetch(target);
    yield* CargoApi.build(target, "release");
    return target;
  }).pipe(Effect.provide(NodeServices.layer)),
);
const native = spawn(
  join(
    directory,
    "target",
    "release",
    `reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
  ),
  ["--port", "0"],
);
const official = spawn(
  process.execPath,
  ["--experimental-transform-types", join(import.meta.dirname, "remote-bench-official.ts")],
  {
    stdio: ["ignore", "pipe", "inherit"],
  },
);
const servers = [
  {
    name: "native",
    child: native,
    url: `http://${await firstLine(native, (line) => parsed(line, "address"))}/rpc`,
  },
  {
    name: "official",
    child: official,
    url: `${await firstLine(official, (line) => parsed(line, "address"))}/rpc`,
  },
];

const results: Record<string, Record<string, unknown>> = {};
for (const workload of workloads) {
  // Same answer from both servers before timing either.
  const answers = await Promise.all(
    servers.map(async (server) =>
      (await fetch(server.url, { method: "POST", body: workload.body })).text(),
    ),
  );
  if (JSON.stringify(JSON.parse(answers[0])) !== JSON.stringify(JSON.parse(answers[1])))
    throw new Error(`${workload.name}: servers disagree`);
  results[workload.name] = { responseBytes: answers[0].length };
  for (const server of servers) {
    await run(server.url, workload.body, WARMUP);
    results[workload.name][server.name] = await run(server.url, workload.body, REQUESTS);
  }
}
const memory = Object.fromEntries(
  servers.map((server) => [server.name, Number(peakMemoryMiB(server.child.pid!).toFixed(1))]),
);
for (const server of servers) server.child.kill();

const record = {
  checked: new Date().toISOString().slice(0, 10),
  target: `${process.platform}/${process.arch}`,
  node: process.version,
  rust: execFileSync("rustc", ["--version"]).toString().trim(),
  effect: "4.0.0",
  foldkitRemoteServer: "0.10.0",
  setup: {
    rows: { User: rows.User.length, Project: rows.Project.length },
    requests: REQUESTS,
    concurrency: CONCURRENCY,
    warmup: WARMUP,
    client: OHA
      ? `oha ${execFileSync(OHA, ["--version"]).toString().trim()}, same machine`
      : `node fetch (keep-alive) in ${WORKERS} worker threads, same machine`,
  },
  peakServerMemoryMiB: memory,
  results,
};
writeFileSync(
  process.argv[2] ?? "docs/research/remote-bench-results.json",
  `${JSON.stringify(record, null, 2)}\n`,
);
console.log(JSON.stringify(record, null, 2));
process.exit(0);
