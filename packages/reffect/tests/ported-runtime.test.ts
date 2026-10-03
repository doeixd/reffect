import { Effect, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
import { Entity } from "foldkit-entity";
import { Remote, RemoteRpc } from "foldkit-remote";
import { expect, test } from "vite-plus/test";
import { CompileError, NativeRemote, PortedRuntimes, verifyUpstream } from "../src/index.ts";
import type { PortedRuntime } from "../src/index.ts";

// LIVE-010: ported protocol engines are listed in artifacts with their upstream pins, and a build
// refuses packages that differ from those pins.
const all = Object.values(PortedRuntimes);

test("every port's pins match the installed packages", async () => {
  const check = await Effect.runPromise(
    verifyUpstream(all).pipe(Effect.provide(NodeServices.layer)),
  );
  expect(check).toBe("verified");
});

test("without a FileSystem the pins are reported unchecked", async () => {
  expect(await Effect.runPromise(verifyUpstream(all))).toBe("unchecked");
});

test("a pin that differs from the installed package refuses the build", async () => {
  const drifted: PortedRuntime = {
    ...PortedRuntimes.LiveHub,
    upstream: [{ package: "foldkit-remote-server", version: "0.10.0" }],
  };
  const missing: PortedRuntime = {
    ...PortedRuntimes.LiveHub,
    upstream: [{ package: "foldkit-remote-nonexistent", version: "1.0.0" }],
  };
  for (const [runtime, expected] of [
    [drifted, "ported foldkit-remote-server@0.10.0, but 0.11.0 is installed"],
    [missing, "it is not installed"],
  ] as const) {
    const error = await Effect.runPromise(
      verifyUpstream([runtime]).pipe(Effect.flip, Effect.provide(NodeServices.layer)),
    );
    expect(error).toBeInstanceOf(CompileError);
    expect(error.diagnostics[0]?.code).toBe("UPSTREAM_VERSION");
    expect(error.message).toContain("foldkit/remote-live-hub@1");
    expect(error.message).toContain(expected);
  }
});

test("a Remote artifact lists the ports it selected", async () => {
  const domain = Remote.define({
    entities: [Entity.define("Todo", Schema.Struct({ id: Schema.String }))],
  });
  const rows = { Todo: [{ id: "t1" }] };
  const ids = (live: boolean) =>
    Effect.runPromise(
      NativeRemote.compile(RemoteRpc, {
        domain,
        rows,
        ...(live ? { live: true, serialization: "ndjson" as const } : {}),
      }).pipe(
        Effect.map((artifact) => ({
          ports: artifact.runtime.ported.map((port) => port.ref.id),
          upstream: artifact.runtime.upstream,
        })),
        Effect.provide(NodeServices.layer),
      ),
    );
  expect(await ids(false)).toEqual({
    ports: [
      "effect/rpc-http@1",
      "foldkit/remote-read@1",
      "foldkit/remote-mutate@1",
      "foldkit/remote-query-memory@1",
    ],
    upstream: "verified",
  });
  expect((await ids(true)).ports).toContain("foldkit/remote-live-hub@1");
});
