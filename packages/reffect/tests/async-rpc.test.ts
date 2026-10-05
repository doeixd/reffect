import {
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { CurrentLogAnnotations, CurrentLogSpans } from "effect/References";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { request as httpRequest } from "node:http";
import { expect, test } from "vite-plus/test";
import { CargoApi, FailureFrames, NativeRpc, Reference } from "../src/index.ts";
import {
  Authenticated,
  Authentication,
  CurrentPrincipal,
} from "../../../examples/rpc-auth/contract.ts";
import { auth, bindings, publicHandler, whoAmI } from "../../../examples/rpc-async/handlers.ts";

const credentials = [
  { token: "async-alpha-token", principal: "9007199254740993" },
  { token: "async-beta-token", principal: "18446744073709551615" },
];
const logSchema = Schema.Struct({
  message: Schema.String,
  request: Schema.Struct({
    id: Schema.Union([Schema.String, Schema.Number]),
    tag: Schema.String,
    principal: Schema.NullOr(Schema.String),
  }),
  annotations: Schema.Record(Schema.String, Schema.Unknown),
  spans: Schema.Array(Schema.Struct({ label: Schema.String })),
});
type Log = typeof logSchema.Type;
const waitUntil = (condition: () => boolean) =>
  Effect.sync(condition).pipe(
    Effect.repeat({ while: (ready) => !ready, schedule: Schedule.spaced("2 millis") }),
    Effect.timeout("3 seconds"),
  );
const request = (id: string, i = 0, allowed = true) => ({
  _tag: "Request",
  id,
  tag: "WhoAmI",
  payload: { allowed },
  headers: [["authorization", `Bearer ${credentials[i % 2].token}`]],
});
const completed = ["started", "after", "inner:start", "inner:done", "outer:start", "outer:done"];
const interrupted = ["started", "inner:start", "inner:done", "outer:start", "outer:done"];
const assertContext = (logs: readonly Log[]) => {
  for (const log of logs) {
    if (log.message === "public") {
      expect(log.request).toMatchObject({ tag: "Public", principal: null });
      expect(log.annotations).toEqual({});
      expect(log.spans).toEqual([]);
    } else {
      expect(log.request.tag).toBe("WhoAmI");
      expect(log.annotations).toEqual({ owner: log.request.principal });
      expect(log.spans.map((span) => span.label)).toEqual(["handler"]);
    }
  }
  expect(JSON.stringify(logs)).not.toContain("-token");
};
const scenario = (transport: typeof fetch, url: string, logs: Log[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(Authenticated, { disableTracing: true }).pipe(
        Effect.provide(
          RpcClient.layerProtocolHttp({ url }).pipe(
            Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
          ),
        ),
        Effect.provideService(FetchHttpClient.Fetch, transport),
      );
      expect(yield* client.WhoAmI({ allowed: true }).pipe(Effect.flip)).toBe("Unauthorized");
      expect(
        yield* client
          .WhoAmI(
            { allowed: false },
            { headers: { authorization: `Bearer ${credentials[0].token}` } },
          )
          .pipe(Effect.flip),
      ).toBe(false);
      const values = yield* Effect.forEach(
        Array.from({ length: 8 }, (_, i) => i),
        (i) =>
          client.WhoAmI(
            { allowed: true },
            { headers: { authorization: `Bearer ${credentials[i % 2].token}` } },
          ),
        { concurrency: "unbounded" },
      );
      expect(values).toEqual(
        Array.from({ length: 8 }, (_, i) => BigInt(credentials[i % 2].principal)),
      );
      expect(yield* client.Public(undefined)).toBe(0n);
      // HTTP completion and the stderr reader are independent observation channels.
      yield* waitUntil(() => logs.length >= 55);
      expect(logs).toHaveLength(55);
      const ids = new Set(
        logs.filter((log) => log.message === "started").map((log) => log.request.id),
      );
      expect(ids.size).toBe(9);
      for (const id of ids)
        expect(logs.filter((log) => log.request.id === id).map((log) => log.message)).toEqual(
          completed,
        );
      // All eight calls begin before any of those calls resumes: real suspension/overlap.
      const overlap = logs.slice(6, 14);
      expect(overlap.map((log) => log.message)).toEqual(Array(8).fill("started"));
      assertContext(logs);
    }),
  );

const cancelStockClient = (transport: typeof fetch, url: string, logs: Log[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(Authenticated, { disableTracing: true }).pipe(
        Effect.provide(
          RpcClient.layerProtocolHttp({ url }).pipe(
            Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
          ),
        ),
        Effect.provideService(FetchHttpClient.Fetch, transport),
      );
      const start = logs.length;
      const fiber = yield* client
        .WhoAmI({ allowed: true }, { headers: { authorization: `Bearer ${credentials[0].token}` } })
        .pipe(Effect.forkScoped);
      yield* waitUntil(() => logs.slice(start).some((log) => log.message === "started"));
      yield* Fiber.interrupt(fiber);
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
      yield* waitUntil(() => logs.slice(start).length === 5);
      expect(logs.slice(start).map((log) => log.message)).toEqual(interrupted);
      assertContext(logs.slice(start));
    }),
  );

const oracle = (logs: Log[]) => {
  const authentication = Layer.succeed(Authentication, (effect, metadata) => {
    const credential = credentials.find(
      (c) => metadata.headers.authorization === `Bearer ${c.token}`,
    );
    if (!credential) return Effect.fail("Unauthorized");
    return effect.pipe(
      Effect.provideService(CurrentPrincipal, BigInt(credential.principal)),
      Effect.annotateLogs({
        requestId: metadata.requestId,
        rpcTag: metadata.rpc._tag,
        principal: credential.principal,
      }),
    );
  });
  const handlers = Authenticated.toLayer({
    WhoAmI: (payload) =>
      CurrentPrincipal.pipe(
        Effect.flatMap((principal) => Reference.run(whoAmI, [principal, payload.allowed])),
        Effect.catchTag("CompileError", Effect.die),
      ),
    Public: (_payload, metadata) =>
      Reference.run(publicHandler, []).pipe(
        Effect.catchTag("CompileError", Effect.die),
        Effect.annotateLogs({ requestId: metadata.requestId, rpcTag: "Public", principal: null }),
      ),
  });
  const logger = Logger.layer([
    Logger.make((options) => {
      const annotations = options.fiber.getRef(CurrentLogAnnotations);
      const spans = options.fiber.getRef(CurrentLogSpans);
      const owner = annotations.owner;
      if (owner !== undefined && typeof owner !== "bigint")
        throw new Error("Invalid oracle owner annotation");
      logs.push(
        Schema.decodeUnknownSync(logSchema)({
          message: String(options.message),
          request: {
            id: annotations.requestId,
            tag: annotations.rpcTag,
            principal: annotations.principal,
          },
          annotations: owner === undefined ? {} : { owner: owner.toString() },
          spans: spans.map(([label]) => ({ label })),
        }),
      );
    }),
  ]);
  return Effect.scoped(
    Effect.gen(function* () {
      const http = yield* RpcServer.toHttpEffect(Authenticated, { disableTracing: true });
      const handler = HttpEffect.toWebHandler(http.pipe(Effect.interruptible));
      const transport: typeof fetch = (input, init) => handler(new Request(input, init));
      yield* scenario(transport, "http://reffect.test/rpc", logs);
      yield* cancelStockClient(transport, "http://reffect.test/rpc", logs);
      const controller = new AbortController();
      const pending = transport("http://reffect.test/rpc", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify(request("cancelled")),
      }).then(
        () => undefined,
        () => undefined,
      );
      yield* waitUntil(() =>
        logs.some((log) => log.request.id === "cancelled" && log.message === "started"),
      );
      controller.abort();
      yield* Effect.promise(() => pending);
      yield* waitUntil(() => logs.filter((log) => log.request.id === "cancelled").length === 5);
      expect(
        logs.filter((log) => log.request.id === "cancelled").map((log) => log.message),
      ).toEqual(interrupted);
      assertContext(logs);
    }).pipe(Effect.provide([handlers, authentication, RpcSerialization.layerJson])),
  ).pipe(Effect.provide(logger));
};

test("stock HTTP RPC oracle scopes context across sleep and masked cancellation cleanup", async () => {
  await Effect.runPromise(oracle([]));
});

const checkNative = (directory: string, profile: "debug" | "release") =>
  Effect.scoped(
    Effect.gen(function* () {
      const logs: Log[] = [];
      const server = yield* ChildProcess.make(
        `${directory}/target/${profile}/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
        ["--port", "0"],
        {
          env: { REFFECT_RPC_CREDENTIALS: JSON.stringify(credentials) },
          extendEnv: true,
        },
      );
      yield* Stream.runForEach(Stream.splitLines(Stream.decodeText(server.stderr)), (line) =>
        Effect.sync(() => {
          if (line.startsWith('{"schema":"reffect.log@1"'))
            logs.push(Schema.decodeUnknownSync(logSchema)(JSON.parse(line)));
        }),
      ).pipe(Effect.forkScoped);
      const ready = yield* Stream.runHead(Stream.splitLines(Stream.decodeText(server.stdout))).pipe(
        Effect.timeout("5 seconds"),
      );
      if (!Option.isSome(ready)) throw new Error("Missing ready record");
      const record = Schema.decodeUnknownSync(Schema.Struct({ address: Schema.String }))(
        JSON.parse(ready.value),
      );
      const url = `http://${record.address}/rpc`;
      yield* scenario(globalThis.fetch, url, logs);
      yield* cancelStockClient(globalThis.fetch, url, logs);
      const outgoing = httpRequest(url, { method: "POST" });
      outgoing.on("error", () => {});
      // A body's requests run concurrently, as official forks a fiber per request (#25), so the
      // disconnect interrupts both, and each still runs its masked cleanup.
      outgoing.end(JSON.stringify([request("cancelled"), request("sibling", 1)]));
      const started = (id: string) =>
        logs.some((log) => log.request.id === id && log.message === "started");
      yield* waitUntil(() => started("cancelled") && started("sibling"));
      outgoing.destroy();
      for (const id of ["cancelled", "sibling"]) {
        yield* waitUntil(() => logs.filter((log) => log.request.id === id).length === 5);
        expect(
          logs.filter((log) => log.request.id === id).map((log) => log.message),
          id,
        ).toEqual(interrupted);
      }
      // A subsequent principal/request cannot inherit cancelled state or scoped annotations.
      const response = yield* Effect.promise(() =>
        fetch(url, { method: "POST", body: JSON.stringify(request("subsequent", 1)) }).then((r) =>
          r.json(),
        ),
      );
      expect(response).toEqual([
        {
          _tag: "Exit",
          requestId: "subsequent",
          exit: { _tag: "Success", value: credentials[1].principal },
        },
      ]);
      yield* waitUntil(() =>
        logs.some((log) => log.request.id === "subsequent" && log.message === "outer:done"),
      );
      expect(logs.filter((log) => log.request.id === "cancelled")).toHaveLength(5);
      expect(
        logs.filter((log) => log.request.id === "subsequent").map((log) => log.message),
      ).toEqual(completed);
      assertContext(logs);
    }),
  );

test("native HTTP worker retains isolated context and awaits finalizers on socket disconnect", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-async-rpc-" });
        for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
          const artifact = yield* NativeRpc.compile(Authenticated, bindings, {
            auth,
            failureFrames: policy,
          });
          expect(artifact.runtime.handlerProfile).toBe("suspended-scalars");
          expect(artifact.runtime.crates).toContain("http-body@1.0.1");
          if (FailureFrames.isNone(policy))
            expect(artifact.files["src/lib.rs"]).not.toContain("FrameTrail");
          const directory = yield* CargoApi.write(
            artifact,
            `${parent}/${FailureFrames.isNone(policy) ? "none" : "bounded"}`,
          );
          yield* CargoApi.fetch(directory);
          for (const profile of ["debug", "release"] as const) {
            yield* CargoApi.build(directory, profile);
            yield* checkNative(directory, profile).pipe(Effect.timeout("20 seconds"));
          }
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}, 240000);
