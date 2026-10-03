/**
 * Semantic runtimes ported from upstream source (LIVE-010): the protocol engines a native server
 * runs instead of generated code, with the upstream versions they were ported from and the
 * conformance tests that compare them. Builds list the entries they select, and the version
 * guard refuses a build whose installed upstream packages differ from the pins.
 */
import { Effect, FileSystem, Option } from "effect";
import { fileURLToPath } from "node:url";
import { CompileError, SemanticRef, fail } from "./kernel.ts";

export interface UpstreamPin {
  readonly package: string;
  readonly version: string;
}
export interface PortedRuntime {
  readonly ref: SemanticRef<"runtime">;
  readonly strategy: "port";
  readonly upstream: readonly UpstreamPin[];
  /** RPC procedures (`rpc:<tag>`) or effect ids the port answers. */
  readonly serves: readonly string[];
  /** Differential tests comparing the port with its upstream, relative to the package. */
  readonly evidence: readonly string[];
  readonly rationale: string;
}
const port = (
  id: string,
  upstream: readonly UpstreamPin[],
  serves: readonly string[],
  evidence: readonly string[],
  rationale: string,
): PortedRuntime =>
  Object.freeze({
    ref: SemanticRef.runtime(id),
    strategy: "port" as const,
    upstream: Object.freeze([...upstream]),
    serves: Object.freeze([...serves]),
    evidence: Object.freeze([...evidence]),
    rationale,
  });

const effect: UpstreamPin = { package: "effect", version: "4.0.0" };
const remote: UpstreamPin = { package: "foldkit-remote", version: "0.11.0" };
const remoteServer: UpstreamPin = { package: "foldkit-remote-server", version: "0.11.0" };
const entity: UpstreamPin = { package: "foldkit-entity", version: "0.7.0" };
const drizzle: UpstreamPin = { package: "foldkit-remote-drizzle", version: "0.9.1" };
const foldkit: UpstreamPin = { package: "foldkit", version: "0.165.0" };

export const PortedRuntimes = Object.freeze({
  RpcHttp: port(
    "effect/rpc-http@1",
    [effect],
    ["rpc:*"],
    ["tests/rpc.test.ts", "tests/rpc-ndjson.test.ts", "tests/stream-rpc.test.ts"],
    "Effect RPC's HTTP framing, exits, decode failures and NDJSON streaming, served by Axum",
  ),
  RemoteRead: port(
    "foldkit/remote-read@1",
    [remote, remoteServer],
    ["rpc:FoldkitRemoteRead"],
    ["tests/remote-read.test.ts", "tests/remote-auth.test.ts"],
    "readHelper's grouping, aliases, limits, authorization and settling, ported line for line",
  ),
  RemoteMutate: port(
    "foldkit/remote-mutate@1",
    [remote, remoteServer],
    ["rpc:FoldkitRemoteMutate"],
    ["tests/remote-mutate.test.ts", "tests/remote-sql-mutate.test.ts"],
    "The Mutate handler's error mapping and outcome shape around compiled R sources",
  ),
  RemoteQueryMemory: port(
    "foldkit/remote-query-memory@1",
    [remote, remoteServer, entity],
    ["rpc:FoldkitRemoteQuery"],
    ["tests/remote-query.test.ts", "tests/foldkit-upstream.test.ts"],
    "The memory backend's paging with the milestone-1 Rust port of the foldkit-entity evaluator",
  ),
  RemoteQuerySql: port(
    "foldkit/remote-query-sql@1",
    [remote, remoteServer, drizzle],
    ["rpc:FoldkitRemoteQuery", "rpc:FoldkitRemoteRead", "rpc:FoldkitRemoteMutate"],
    ["tests/remote-sql.test.ts", "tests/remote-sql-mutate.test.ts", "tests/sql-plan.test.ts"],
    "foldkit-remote-drizzle's source, query lowering and keyset paging, planned to SQLx statements",
  ),
  LiveHub: port(
    "foldkit/remote-live-hub@1",
    [remote, remoteServer],
    ["rpc:FoldkitRemoteLive", "reffect/effect/live-hub@1"],
    ["tests/remote-live.test.ts", "tests/remote-sql-live.test.ts"],
    "liveHub's selection, grouping, re-authorization, re-reads and per-stream cursors",
  ),
  SsrSerialize: port(
    "foldkit/ssr-serialize@1",
    [foldkit],
    ["foldkit/experimental/server:renderToString"],
    ["tests/ssr-serialize.test.ts"],
    "renderToString's text and attribute escaping, NUL refusal and hydration key fingerprint",
  ),
});

/** Whether the build checked its ports' pins against the installed packages. */
export type UpstreamCheck = "verified" | "unchecked";

/** The version of `name` as Node finds it from the compiler's own module: up the node_modules chain. */
const installedVersion = (fs: FileSystem.FileSystem, name: string) =>
  Effect.gen(function* () {
    let directory = fileURLToPath(new URL(".", import.meta.url)).replaceAll("\\", "/");
    for (;;) {
      const manifest = `${directory.replace(/\/$/, "")}/node_modules/${name}/package.json`;
      if (yield* fs.exists(manifest)) {
        const parsed: unknown = JSON.parse(yield* fs.readFileString(manifest));
        return typeof parsed === "object" && parsed !== null && "version" in parsed
          ? String(parsed.version)
          : undefined;
      }
      const parent = directory.replace(/\/[^/]*\/?$/, "");
      if (parent === directory || parent === "") return undefined;
      directory = parent;
    }
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Refuses ports whose upstream pins differ from the installed packages (`UPSTREAM_VERSION`).
 * Without a FileSystem service the check is skipped and reported as unchecked.
 */
export const verifyUpstream = (
  runtimes: readonly PortedRuntime[],
): Effect.Effect<UpstreamCheck, CompileError> =>
  Effect.serviceOption(FileSystem.FileSystem).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed<UpstreamCheck>("unchecked"),
        onSome: (fs) =>
          Effect.gen(function* () {
            const pins = new Map<string, UpstreamPin>();
            for (const runtime of runtimes)
              for (const pin of runtime.upstream) pins.set(pin.package, pin);
            for (const pin of pins.values()) {
              const installed = yield* installedVersion(fs, pin.package);
              if (installed !== pin.version)
                return yield* fail(
                  "UPSTREAM_VERSION",
                  "plan",
                  `upstream.${pin.package}`,
                  `${runtimes
                    .filter((runtime) => runtime.upstream.includes(pin))
                    .map((runtime) => runtime.ref.id)
                    .join(", ")} ported ${pin.package}@${pin.version}, but ${
                    installed === undefined ? "it is not installed" : `${installed} is installed`
                  }; re-run its conformance tests and update the pin`,
                );
            }
            return "verified" as const;
          }),
      }),
    ),
  );
