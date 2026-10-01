import { Cause, Effect, Exit, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, SourceArtifacts } from "../src/index.ts";
import { UnaryGroup, unaryHandlers } from "./fixtures/rpc/contract.ts";
import { replayUnaryCorpus } from "./fixtures/rpc/corpus.ts";
import { makeHarness } from "./fixtures/rpc/harness.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const nativeGroup = UnaryGroup.merge(
  RpcGroup.make(
    Rpc.make("EmptyField", { payload: { "": NativeRpc.U64Json }, success: NativeRpc.U64Json }),
    Rpc.make("Scalar", { payload: Schema.Boolean, success: Schema.Boolean }),
  ),
);
const bindings = {
  Add: NativeRpc.bind(unaryHandlers.Add, ["left", "right"]),
  Guard: NativeRpc.bind(unaryHandlers.Guard, ["allowed"]),
  Unit: NativeRpc.bind(unaryHandlers.Unit),
};
const fetchResponse = (url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: (signal) => fetch(url, { ...init, signal }),
    catch: (cause) => new Error(String(cause)),
  });

const checkServer = (directory: string, profile: "debug" | "release") =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* ChildProcess.make(
        `${directory}/target/${profile}/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
        ["--port", "0"],
      );
      yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
      const ready = yield* Stream.runHead(Stream.splitLines(Stream.decodeText(child.stdout))).pipe(
        Effect.timeout("5 seconds"),
      );
      if (!Option.isSome(ready)) throw new Error("Missing ready record");
      const record = Schema.decodeUnknownSync(
        Schema.Struct({ schema: Schema.Literal("reffect.rpc.ready@1"), address: Schema.String }),
      )(JSON.parse(ready.value));
      const url = `http://${record.address}/rpc`;
      const harness = makeHarness(globalThis.fetch, url);
      yield* replayUnaryCorpus(harness);
      for (const [tag, payload, value] of [
        ["EmptyField", { "": "4" }, "4"],
        ["Scalar", true, true],
      ] as const) {
        const response = yield* Effect.promise(() =>
          harness.post(JSON.stringify({ _tag: "Request", id: tag, tag, payload, headers: [] })),
        );
        expect(yield* Effect.promise(() => response.json())).toEqual([
          { _tag: "Exit", requestId: tag, exit: { _tag: "Success", value } },
        ]);
      }

      const client = yield* harness.client;
      expect(yield* client.Add({ left: 9007199254740993n, right: 2n })).toBe(9007199254740995n);
      expect(yield* client.Unit(undefined)).toBeUndefined();
      expect(yield* client.Guard({ allowed: false }).pipe(Effect.flip)).toBe(false);
      const results = yield* Effect.forEach(
        Array.from({ length: 16 }, (_, index) => index),
        (index) =>
          Effect.all([
            client.Add({ left: BigInt(index), right: 1n }),
            client.Guard({ allowed: index % 2 === 0 }).pipe(Effect.exit),
          ]),
        { concurrency: "unbounded" },
      );
      for (const [index, [sum, guard]] of results.entries()) {
        expect(sum).toBe(BigInt(index + 1));
        Exit.match(guard, {
          onSuccess: (value) => {
            expect(index % 2).toBe(0);
            expect(value).toBe(true);
          },
          onFailure: (cause) => {
            expect(index % 2).toBe(1);
            expect(Cause.findErrorOption(cause)).toEqual(Option.some(false));
          },
        });
      }
      const traced = yield* harness.tracedClient;
      expect(yield* traced.Guard({ allowed: true })).toBe(true);

      const malformed = yield* fetchResponse(url, { method: "POST", body: "{" });
      expect(malformed.status).toBe(200);
      expect(yield* Effect.promise(() => malformed.json())).toEqual([
        { _tag: "Defect", defect: { name: "SyntaxError", message: expect.any(String) } },
      ]);
      for (const body of [
        {
          _tag: "Request",
          id: "bad",
          tag: "Add",
          payload: { left: "1", right: "0" },
          headers: "bad",
        },
        { _tag: "Request", id: {}, tag: "Add", payload: { left: "1", right: "0" }, headers: [] },
        {
          _tag: "Request",
          id: "bad",
          tag: "Unit",
          payload: null,
          headers: [],
          isNotification: true,
        },
      ]) {
        const response = yield* fetchResponse(url, { method: "POST", body: JSON.stringify(body) });
        expect(yield* Effect.promise(() => response.json())).toEqual([
          { _tag: "Defect", defect: { name: "ProtocolError", message: expect.any(String) } },
        ]);
      }
      for (const payload of [{ left: 1, right: "0" }, { left: "1" }, { left: "+1", right: "0" }]) {
        const response = yield* Effect.promise(() =>
          harness.post(
            JSON.stringify({ _tag: "Request", id: "bad", tag: "Add", payload, headers: [] }),
          ),
        );
        expect(yield* Effect.promise(() => response.json())).toEqual([
          {
            _tag: "Exit",
            requestId: "bad",
            exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: expect.any(String) }] },
          },
        ]);
      }
      const idRequest = (id: string | number) => ({
        _tag: "Request",
        id,
        tag: "Guard",
        payload: { allowed: true },
        headers: [],
      });
      const duplicateBodies = [
        JSON.stringify([idRequest("duplicate"), idRequest("duplicate")]),
        JSON.stringify([idRequest(0), idRequest(0)]).replace('"id":0,', '"id":-0.0,'),
        JSON.stringify([idRequest(1), idRequest(1)]).replace('"id":1,', '"id":1.0,'),
      ];
      for (const body of duplicateBodies) {
        const response = yield* fetchResponse(url, { method: "POST", body });
        expect(yield* Effect.promise(() => response.json())).toEqual([
          { _tag: "Defect", defect: { name: "ProtocolError", message: "Duplicate request id" } },
        ]);
      }
      for (const id of [0.1, Number("0.84551240822557006"), Number("1.432697605927436e-308")]) {
        const response = yield* fetchResponse(url, {
          method: "POST",
          body: JSON.stringify(idRequest(id)),
        });
        expect(yield* Effect.promise(() => response.json())).toEqual([
          { _tag: "Exit", requestId: id, exit: { _tag: "Success", value: true } },
        ]);
      }
      expect((yield* fetchResponse(url)).status).toBe(405);
      expect(
        (yield* fetchResponse(url.replace("/rpc", "/other"), { method: "POST", body: "{}" }))
          .status,
      ).toBe(404);
      expect((yield* fetchResponse(url, { method: "POST", body: " ".repeat(65537) })).status).toBe(
        413,
      );
      expect(
        (yield* fetchResponse(url, {
          method: "POST",
          body: JSON.stringify(Array.from({ length: 65 }, () => null)),
        })).status,
      ).toBe(413);
      expect(yield* client.Add({ left: 0n, right: 0n })).toBe(0n);
    }),
  ).pipe(Effect.timeout("15 seconds"));

test(
  "generated Rust HTTP servers satisfy corpus and stock client in debug/release",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-rpc-" });
          const artifact = yield* NativeRpc.compile(nativeGroup, {
            Add: bindings.Add,
            Guard: bindings.Guard,
            Unit: bindings.Unit,
            EmptyField: NativeRpc.bind(
              R.fn([R.U64], R.U64, (value) => value),
              [""],
            ),
            Scalar: NativeRpc.bind(R.fn([R.Bool], R.Bool, (value) => value)),
          });
          expect(artifact.sourceArtifacts).toBe(SourceArtifacts.None);
          expect(artifact.runtime.crates).toEqual([
            "axum@0.8.9",
            "tokio@1.53.1",
            "serde_json@1.0.151",
          ]);
          const directory = yield* CargoApi.write(artifact, `${parent}/server`);
          yield* CargoApi.fetch(directory);
          for (const profile of ["debug", "release"] as const) {
            yield* CargoApi.build(directory, profile);
            yield* checkServer(directory, profile);
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  // Fresh HTTP dependencies compile in both profiles; allow contention and two server cleanups.
  nativeTestBudget(2) + 120000,
);

test("RPC compiler refuses unsupported codecs, payload layouts and route definitions", async () => {
  const scalar = R.fn([R.Bool], R.Bool, (value) => value);
  const group = RpcGroup.make(
    Rpc.make("Check", { payload: Schema.Boolean, success: Schema.Boolean }),
  );
  const unsupportedString = RpcGroup.make(
    Rpc.make("Check", { payload: Schema.String, success: Schema.Boolean }),
  );
  const checked = RpcGroup.make(
    Rpc.make("Check", {
      payload: Schema.Boolean.check(Schema.makeFilter(() => true)),
      success: Schema.Boolean,
    }),
  );
  const optional = RpcGroup.make(
    Rpc.make("Check", {
      payload: { value: Schema.optionalKey(Schema.Boolean) },
      success: Schema.Boolean,
    }),
  );
  class Auth extends RpcMiddleware.Service<Auth>()("reffect/test/Auth") {}
  const middleware = group.middleware(Auth);
  const customDefect = RpcGroup.make(
    Rpc.make("Check", {
      payload: Schema.Boolean,
      success: Schema.Boolean,
      defect: Schema.Defect({ includeStack: true }),
    }),
  );
  const cases = [
    NativeRpc.compile(middleware, {
      Check: NativeRpc.bindPrincipal(R.fn([R.U64, R.Bool], R.Bool, (_principal, value) => value)),
    }),
    NativeRpc.compile(customDefect, { Check: NativeRpc.bind(scalar) }),
    NativeRpc.compile(unsupportedString, { Check: NativeRpc.bind(scalar) }),
    NativeRpc.compile(checked, { Check: NativeRpc.bind(scalar) }),
    NativeRpc.compile(optional, { Check: NativeRpc.bind(scalar, ["value"]) }),
    NativeRpc.compile(group, { Check: NativeRpc.bind(scalar) }, { path: "/rpc/" }),
    NativeRpc.compile(UnaryGroup, {
      Add: NativeRpc.bind(unaryHandlers.Add, ["left", "left"]),
      Guard: bindings.Guard,
      Unit: bindings.Unit,
    }),
    NativeRpc.compile(UnaryGroup, {
      Add: NativeRpc.bind(unaryHandlers.Add, ["left"]),
      Guard: bindings.Guard,
      Unit: bindings.Unit,
    }),
  ];
  for (const attempt of cases) {
    const error = await Effect.runPromise(attempt.pipe(Effect.flip));
    expect(error.diagnostics).toEqual([
      expect.objectContaining({ code: "RPC_UNSUPPORTED", stage: "rpc" }),
    ]);
  }
});
