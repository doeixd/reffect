import { Effect, FileSystem, Layer, Logger, Option, Schedule, Schema, Stream } from "effect";
import { CurrentLogAnnotations } from "effect/References";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcClient, RpcGroup, RpcMiddleware, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { request as httpRequest } from "node:http";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, Reference } from "../src/index.ts";
import {
  Authenticated,
  Authentication,
  CurrentPrincipal,
} from "../../../examples/rpc-auth/contract.ts";
import { auth, bindings, publicHandler, whoAmI } from "../../../examples/rpc-auth/handlers.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const credentials = [
  { token: "fixture-alpha-token", principal: "9007199254740993" },
  { token: "fixture-beta-token", principal: "18446744073709551615" },
];
interface Log {
  readonly message: string;
  readonly request: {
    readonly id: string | number;
    readonly tag: string;
    readonly principal: string | null;
  };
  readonly annotations: Readonly<Record<string, unknown>>;
}
const request = (
  id: string | number,
  headers: readonly (readonly [string, string])[] = [],
  allowed = true,
) => ({ _tag: "Request", id, tag: "WhoAmI", payload: { allowed }, headers });
const success = (id: string | number, value: string) => [
  { _tag: "Exit", requestId: id, exit: { _tag: "Success", value } },
];
const denied = (id: string | number, error: string | boolean = "Unauthorized") => [
  { _tag: "Exit", requestId: id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error }] } },
];

const waitForLogs = (logs: Log[], count: number) =>
  Effect.sync(() => logs.length).pipe(
    Effect.repeat({ while: (length) => length < count, schedule: Schedule.spaced("5 millis") }),
    Effect.timeout("2 seconds"),
  );
const scenario = (transport: typeof fetch, url: string, logs: Log[]) =>
  Effect.gen(function* () {
    const post = (body: unknown, headers?: HeadersInit) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await transport(url, {
            method: "POST",
            signal,
            headers,
            body: JSON.stringify(body),
          });
          expect(response.status).toBe(200);
          return response.json();
        },
        catch: (cause) => new Error(String(cause)),
      });
    expect(yield* post(request("missing"))).toEqual(denied("missing"));
    for (const value of [
      "Bearer wrong-secret",
      "Basic fixture-alpha-token",
      "Bearer ",
      "Bearer fixture-alpha-token ",
    ]) {
      expect(yield* post(request("invalid", [["authorization", value]]))).toEqual(
        denied("invalid"),
      );
    }
    expect(
      yield* post(request("transport"), { authorization: "bEaReR fixture-alpha-token" }),
    ).toEqual(success("transport", credentials[0].principal));
    expect(
      yield* post(request(42, [["AuThOrIzAtIoN", "Bearer fixture-beta-token"]]), {
        authorization: "Bearer fixture-alpha-token",
      }),
    ).toEqual(success(42, credentials[1].principal));
    expect(
      yield* post(
        request("last", [
          ["Authorization", "Bearer wrong-secret"],
          ["authorization", "Bearer fixture-alpha-token"],
        ]),
      ),
    ).toEqual(success("last", credentials[0].principal));
    expect(
      yield* post(request("override", [["authorization", "Bearer wrong-secret"]]), {
        authorization: "Bearer fixture-alpha-token",
      }),
    ).toEqual(denied("override"));
    expect(
      yield* post(request("failed", [["authorization", "Bearer fixture-beta-token"]], false)),
    ).toEqual(denied("failed", false));
    const malformed = yield* post({ ...request("bad-payload"), payload: { allowed: "true" } });
    expect(malformed).toEqual([
      {
        _tag: "Exit",
        requestId: "bad-payload",
        exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: expect.any(String) }] },
      },
    ]);
    const publicRequest = {
      _tag: "Request",
      id: "public",
      tag: "Public",
      payload: null,
      headers: [],
    };
    expect(yield* post(publicRequest)).toEqual(success("public", "0"));
    const batch = yield* post([
      request("batch-a", [["authorization", "Bearer fixture-alpha-token"]]),
      request("batch-denied"),
      request("batch-b", [["authorization", "Bearer fixture-beta-token"]]),
    ]);
    expect(batch).toHaveLength(3);
    expect(batch).toEqual(
      expect.arrayContaining([
        ...success("batch-a", credentials[0].principal),
        ...denied("batch-denied"),
        ...success("batch-b", credentials[1].principal),
      ]),
    );
    yield* waitForLogs(logs, 7);
    for (const id of ["transport", 42, "last", "failed", "batch-a", "batch-b", "public"]) {
      const log = logs.find((log) => log.request.id === id);
      expect(log).toBeDefined();
      if (!log) throw new Error("Missing handler log");
      const principal =
        id === "public"
          ? null
          : id === 42 || id === "failed" || id === "batch-b"
            ? credentials[1].principal
            : credentials[0].principal;
      expect(log.request).toEqual({ id, tag: id === "public" ? "Public" : "WhoAmI", principal });
      expect(log.annotations).toEqual(id === "public" ? {} : { principal_arg: principal });
    }
    expect(logs.length).toBe(7);
    const protocol = RpcClient.layerProtocolHttp({ url }).pipe(
      Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
    );
    const client = yield* RpcClient.make(Authenticated, { disableTracing: true }).pipe(
      Effect.provide(protocol),
      Effect.provideService(FetchHttpClient.Fetch, transport),
    );
    expect(yield* client.WhoAmI({ allowed: true }).pipe(Effect.flip)).toBe("Unauthorized");
    expect(
      yield* client
        .WhoAmI({ allowed: false }, { headers: { authorization: "Bearer fixture-alpha-token" } })
        .pipe(Effect.flip),
    ).toBe(false);
    const principals = yield* Effect.forEach(
      Array.from({ length: 16 }, (_, i) => i),
      (i) =>
        client.WhoAmI(
          { allowed: true },
          { headers: { authorization: `Bearer ${credentials[i % 2].token}` } },
        ),
      { concurrency: "unbounded" },
    );
    expect(principals).toEqual(
      Array.from({ length: 16 }, (_, i) => BigInt(credentials[i % 2].principal)),
    );
    expect(yield* client.Public(undefined)).toBe(0n);
    yield* waitForLogs(logs, 25);
    expect(logs.length).toBe(25);
    for (const log of logs) {
      expect(log.request.tag).toBe(log.message === "public" ? "Public" : "WhoAmI");
      if (log.message === "handler")
        expect(log.request.principal).toBe(log.annotations.principal_arg);
    }
    expect(JSON.stringify(logs)).not.toContain("fixture-");
    expect(JSON.stringify(logs)).not.toContain("wrong-secret");
  });

const oracle = (logs: Log[]) => {
  const authentication = Layer.succeed(Authentication, (effect, metadata) => {
    const token =
      metadata.headers.authorization?.slice(0, 7).toLowerCase() === "bearer "
        ? metadata.headers.authorization.slice(7)
        : undefined;
    const credential = credentials.find((c) => c.token === token);
    if (!credential) return Effect.fail("Unauthorized");
    return Effect.yieldNow.pipe(
      Effect.andThen(effect),
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
      const id = annotations.requestId;
      const tag = annotations.rpcTag;
      const principal = annotations.principal;
      if (
        (typeof id !== "string" && typeof id !== "number") ||
        typeof tag !== "string" ||
        (typeof principal !== "string" && principal !== null)
      )
        throw new Error("Invalid oracle context");
      const attrs = { ...annotations };
      delete attrs.requestId;
      delete attrs.rpcTag;
      delete attrs.principal;
      logs.push({
        message: String(Array.isArray(options.message) ? options.message[0] : options.message),
        request: { id, tag, principal },
        annotations: Object.fromEntries(
          Object.entries(attrs).map(([key, value]) => [
            key,
            typeof value === "bigint" ? value.toString() : value,
          ]),
        ),
      });
    }),
  ]);
  return Effect.scoped(
    Effect.gen(function* () {
      const http = yield* RpcServer.toHttpEffect(Authenticated, { disableTracing: true });
      const handler = HttpEffect.toWebHandler(http);
      const transport: typeof fetch = (input, init) => handler(new Request(input, init));
      yield* scenario(transport, "http://reffect.test/rpc", logs);
    }).pipe(Effect.provide([handlers, authentication, RpcSerialization.layerJson])),
  ).pipe(Effect.provide(logger));
};

test("stock middleware defines authorization, header precedence and isolated request logging", async () => {
  await Effect.runPromise(oracle([]));
});

const checkNative = (directory: string, profile: "debug" | "release") =>
  Effect.scoped(
    Effect.gen(function* () {
      const logs: Log[] = [];
      const server = yield* ChildProcess.make(
        `${directory}/target/${profile}/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
        ["--port", "0"],
        { env: { REFFECT_RPC_CREDENTIALS: JSON.stringify(credentials) }, extendEnv: true },
      );
      yield* Stream.runForEach(Stream.splitLines(Stream.decodeText(server.stderr)), (line) =>
        Effect.sync(() => {
          if (line)
            logs.push(
              Schema.decodeUnknownSync(
                Schema.Struct({
                  message: Schema.String,
                  request: Schema.Struct({
                    id: Schema.Union([Schema.String, Schema.Number]),
                    tag: Schema.String,
                    principal: Schema.NullOr(Schema.String),
                  }),
                  annotations: Schema.Record(Schema.String, Schema.Unknown),
                }),
              )(JSON.parse(line)),
            );
        }),
      ).pipe(Effect.forkScoped);
      const ready = yield* Stream.runHead(Stream.splitLines(Stream.decodeText(server.stdout))).pipe(
        Effect.timeout("5 seconds"),
      );
      if (!Option.isSome(ready)) throw new Error("Missing ready record");
      const record = Schema.decodeUnknownSync(
        Schema.Struct({ schema: Schema.Literal("reffect.rpc.ready@1"), address: Schema.String }),
      )(JSON.parse(ready.value));
      yield* scenario(globalThis.fetch, `http://${record.address}/rpc`, logs);
      const duplicate = yield* Effect.tryPromise({
        try: (signal) =>
          new Promise<unknown>((resolve, reject) => {
            const outgoing = httpRequest(
              `http://${record.address}/rpc`,
              {
                method: "POST",
                signal,
                headers: [
                  "authorization",
                  "Bearer fixture-alpha-token",
                  "authorization",
                  "Bearer fixture-beta-token",
                ],
              },
              (response) => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk) => {
                  body += chunk;
                });
                response.on("error", reject);
                response.on("end", () => {
                  try {
                    resolve(JSON.parse(body));
                  } catch (error) {
                    reject(error);
                  }
                });
              },
            );
            outgoing.on("error", reject);
            outgoing.end(JSON.stringify(request("duplicate-http")));
          }),
        catch: (cause) => new Error(String(cause)),
      });
      expect(duplicate).toEqual(denied("duplicate-http"));
      expect(logs).toHaveLength(25);
    }),
  );

test(
  "native bearer adapter agrees with stock middleware in debug/release",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-rpc-auth-" });
          const artifact = yield* NativeRpc.compile(Authenticated, bindings, { auth });
          expect(artifact.runtime.auth).toEqual({
            middleware: Authentication.key,
            principalService: CurrentPrincipal.key,
            credentialsEnv: "REFFECT_RPC_CREDENTIALS",
          });
          const sources = Object.values(artifact.files).join("\n");
          for (const credential of credentials) expect(sources).not.toContain(credential.token);
          const directory = yield* CargoApi.write(artifact, `${parent}/server`);
          yield* CargoApi.fetch(directory);
          for (const profile of ["debug", "release"] as const) {
            yield* CargoApi.build(directory, profile);
            yield* checkNative(directory, profile).pipe(Effect.timeout("20 seconds"));
          }
          for (const config of [
            undefined,
            "secret-not-json",
            "[]",
            " ".repeat(16385),
            JSON.stringify(
              Array.from({ length: 33 }, (_, i) => ({
                token: `fixture-token-${i}`,
                principal: "0",
              })),
            ),
            JSON.stringify([{ token: "x".repeat(257), principal: "0" }]),
            JSON.stringify([credentials[0], credentials[0]]),
            JSON.stringify([{ token: "private-bad-token", principal: "18446744073709551616" }]),
            JSON.stringify([{ token: "private bad token", principal: "0" }]),
          ]) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const child = yield* ChildProcess.make(
                  `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
                  ["--port", "0"],
                  { env: { REFFECT_RPC_CREDENTIALS: config }, extendEnv: true },
                );
                const [stdout, stderr, code] = yield* Effect.all(
                  [
                    Stream.mkString(Stream.decodeText(child.stdout)),
                    Stream.mkString(Stream.decodeText(child.stderr)),
                    child.exitCode,
                  ],
                  { concurrency: "unbounded" },
                );
                expect(code).not.toBe(0);
                expect(stdout).toBe("");
                expect(stderr).toContain("Invalid RPC credential configuration");
                expect(stderr).not.toContain("private");
                expect(stderr).not.toContain("secret-not-json");
              }),
            );
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(2) + 120000,
);

test("auth compilation refuses missing and unrelated adapters", async () => {
  class OtherAuth extends RpcMiddleware.Service<OtherAuth, { provides: CurrentPrincipal }>()(
    "reffect/test/OtherAuth",
    { error: Schema.Literal("Denied") },
  ) {}
  const other = NativeRpc.bearer(OtherAuth, CurrentPrincipal, {
    credentialsEnv: "TEST_CREDENTIALS",
  });
  class Changed extends RpcMiddleware.Service<Changed, { provides: CurrentPrincipal }>()(
    "reffect/test/Changed",
    { error: Schema.Literal("Denied") },
  ) {}
  const changed = NativeRpc.bearer(Changed, CurrentPrincipal, {
    credentialsEnv: "TEST_CREDENTIALS",
  });
  Object.defineProperty(Changed, "error", { value: Schema.Literal("Changed") });
  const publicGroup = RpcGroup.make(
    Rpc.make("Public", { payload: Schema.Undefined, success: NativeRpc.U64Json }),
  );
  for (const attempt of [
    NativeRpc.compile(Authenticated, bindings),
    NativeRpc.compile(
      RpcGroup.make(
        Rpc.make("WhoAmI", {
          payload: { allowed: Schema.Boolean },
          success: NativeRpc.U64Json,
          error: Schema.Boolean,
        }).middleware(Changed),
      ),
      { WhoAmI: bindings.WhoAmI },
      { auth: changed },
    ),
    NativeRpc.compile(Authenticated, bindings, { auth: other }),
    NativeRpc.compile(publicGroup, { Public: bindings.Public }, { auth }),
    NativeRpc.compile(
      RpcGroup.make(
        Rpc.make("WhoAmI", {
          payload: { allowed: Schema.Boolean },
          success: NativeRpc.U64Json,
          error: Schema.Boolean,
        })
          .middleware(Authentication)
          .middleware(OtherAuth),
      ),
      { WhoAmI: bindings.WhoAmI },
      { auth },
    ),
  ]) {
    const error = await Effect.runPromise(attempt.pipe(Effect.flip));
    expect(error.diagnostics).toEqual([
      expect.objectContaining({ code: "RPC_UNSUPPORTED", stage: "rpc" }),
    ]);
  }
  class Invalid extends RpcMiddleware.Service<Invalid, { provides: CurrentPrincipal }>()(
    "reffect/test/Invalid",
    { error: Schema.String },
  ) {}
  expect(() => NativeRpc.bearer(Invalid, CurrentPrincipal, { credentialsEnv: "TEST" })).toThrow();
  expect(() =>
    NativeRpc.bearer(Authentication, CurrentPrincipal, { credentialsEnv: "not an env name" }),
  ).toThrow();
});
