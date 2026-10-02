import { Effect, FileSystem, Layer, Option, Schedule, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, RpcCodecs } from "../src/index.ts";
import { Authentication, CurrentPrincipal } from "../../../examples/rpc-auth/contract.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const high = RpcCodecs.u64Range({ minimum: 9007199254740993n, maximum: 9007199254740995n });
const zero = RpcCodecs.u64Range({ minimum: 0n, maximum: 1n });
const maximum = RpcCodecs.u64Range({
  minimum: 18446744073709551614n,
  maximum: 18446744073709551615n,
});
const group = RpcGroup.make(
  Rpc.make("Scalar", { payload: high, success: RpcCodecs.U64Json }),
  Rpc.make("Field", { payload: { value: high }, success: RpcCodecs.U64Json }).middleware(
    Authentication,
  ),
  Rpc.make("Zero", { payload: zero, success: RpcCodecs.U64Json }),
  Rpc.make("Maximum", { payload: maximum, success: RpcCodecs.U64Json }),
  Rpc.make("Reordered", {
    payload: { value: high, allowed: Schema.Boolean },
    success: RpcCodecs.U64Json,
  }).middleware(Authentication),
  Rpc.make("Empty", { payload: {}, success: RpcCodecs.U64Json }),
);
const handler = R.fn([R.U64], R.U64, R.Never, (value) =>
  R.Log.info("called").pipe(R.Effect.flatMap(() => R.Effect.succeed(value))),
);
const protectedHandler = R.fn([R.U64, R.U64], R.U64, R.Never, (_principal, value) =>
  R.Log.info("called").pipe(R.Effect.flatMap(() => R.Effect.succeed(value))),
);
const reorderedHandler = R.fn(
  [R.U64, R.Bool, R.U64],
  R.U64,
  R.Never,
  (_principal, allowed, value) =>
    R.Log.info("called").pipe(
      R.Effect.flatMap(() =>
        R.Match.bool(allowed, R.Effect.succeed(value), R.Effect.succeed(R.U64.literal(0n))),
      ),
    ),
);
const emptyHandler = R.fn([], R.U64, R.Never, () =>
  R.Log.info("called").pipe(R.Effect.flatMap(() => R.Effect.succeed(R.U64.literal(0n)))),
);
const bindings = {
  Scalar: NativeRpc.bind(handler),
  Field: NativeRpc.bindPrincipal(protectedHandler, ["value"]),
  Zero: NativeRpc.bind(handler),
  Maximum: NativeRpc.bind(handler),
  Reordered: NativeRpc.bindPrincipal(reorderedHandler, ["allowed", "value"]),
  Empty: NativeRpc.bind(emptyHandler),
};
const auth = NativeRpc.bearer(Authentication, CurrentPrincipal, {
  credentialsEnv: "REFFECT_RPC_CREDENTIALS",
});
const headers = [["authorization", "Bearer fixture-schema-token"]];
const rows = [
  { tag: "Scalar", payload: "9007199254740993", valid: true },
  { tag: "Scalar", payload: "9007199254740994", valid: true },
  { tag: "Scalar", payload: "0009007199254740995", valid: true },
  { tag: "Scalar", payload: "9007199254740992", valid: false },
  { tag: "Scalar", payload: "9007199254740996", valid: false },
  { tag: "Scalar", payload: "18446744073709551616", valid: false },
  { tag: "Scalar", payload: "-1", valid: false },
  { tag: "Scalar", payload: "+9007199254740993", valid: false },
  { tag: "Scalar", payload: "", valid: false },
  { tag: "Scalar", payload: 9007199254740992, valid: false },
  { tag: "Zero", payload: "-000", valid: true },
  { tag: "Zero", payload: "0001", valid: true },
  { tag: "Zero", payload: "2", valid: false },
  { tag: "Maximum", payload: "18446744073709551614", valid: true },
  { tag: "Maximum", payload: "18446744073709551615", valid: true },
  { tag: "Maximum", payload: "18446744073709551613", valid: false },
  { tag: "Field", payload: { value: "9007199254740993" }, valid: true, headers },
  { tag: "Field", payload: { value: "9007199254740995" }, valid: true, headers },
  { tag: "Field", payload: { value: "9007199254740992" }, valid: false, headers },
  { tag: "Field", payload: { value: "9007199254740996" }, valid: false },
  { tag: "Field", payload: {}, valid: false },
  { tag: "Field", payload: { value: "9007199254740993" }, valid: false },
  { tag: "Reordered", payload: { value: "9007199254740993", allowed: true }, valid: true, headers },
  {
    tag: "Reordered",
    payload: { value: "9007199254740994", allowed: false },
    valid: true,
    headers,
  },
  {
    tag: "Reordered",
    payload: { value: "9007199254740992", allowed: "bad" },
    valid: false,
    headers,
  },
  { tag: "Reordered", payload: { value: "9007199254740992", allowed: "bad" }, valid: false },
  {
    tag: "Reordered",
    payload: { value: "9007199254740993", allowed: "bad" },
    valid: false,
    headers,
  },
  { tag: "Reordered", payload: {}, valid: false },
  { tag: "Reordered", payload: { value: "9007199254740993" }, valid: false },
  { tag: "Reordered", payload: { allowed: "bad" }, valid: false },
  { tag: "Field", payload: null, valid: false },
  { tag: "Field", payload: 1, valid: false },
  { tag: "Field", payload: true, valid: false },
  { tag: "Field", payload: "bad", valid: false },
  { tag: "Field", payload: [], valid: false },
  { tag: "Field", payload: [1], valid: false },
  { tag: "Empty", payload: null, valid: false },
  { tag: "Empty", payload: {}, valid: true },
  { tag: "Empty", payload: [], valid: true },
  { tag: "Empty", payload: "valid", valid: true },
  { tag: "Empty", payload: 1, valid: true },
  { tag: "Empty", payload: true, valid: true },
];
const exchange = (transport: typeof fetch, url: string) =>
  Effect.forEach(rows, (row, i) =>
    Effect.promise(async () => {
      const response = await transport(url, {
        method: "POST",
        body: JSON.stringify({
          _tag: "Request",
          id: String(i),
          tag: row.tag,
          payload: row.payload,
          headers: row.headers ?? [],
        }),
      });
      expect(response.status).toBe(200);
      return response.json();
    }),
  );
const stockCallCount = 7;
const stockClient = (transport: typeof fetch, url: string) => {
  const protocol = RpcClient.layerProtocolHttp({
    url,
    transformClient: (client) =>
      HttpClient.transformResponse(client, (response) =>
        response.pipe(Effect.provideService(FetchHttpClient.Fetch, transport)),
      ),
  }).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]));
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(group, { disableTracing: true }).pipe(
      Effect.provide(protocol),
    );
    expect(yield* client.Scalar(9007199254740994n)).toBe(9007199254740994n);
    expect(yield* client.Zero(0n)).toBe(0n);
    expect(
      yield* client.Field(
        { value: 9007199254740995n },
        { headers: { authorization: "Bearer fixture-schema-token" } },
      ),
    ).toBe(9007199254740995n);
    expect(
      yield* client.Reordered(
        { value: 9007199254740993n, allowed: true },
        { headers: { authorization: "Bearer fixture-schema-token" } },
      ),
    ).toBe(9007199254740993n);
    expect(
      yield* client.Reordered(
        { value: 9007199254740994n, allowed: false },
        { headers: { authorization: "Bearer fixture-schema-token" } },
      ),
    ).toBe(0n);
    expect(yield* client.Empty(17)).toBe(0n);
    expect(yield* client.Empty([])).toBe(0n);
  });
};
const withOracle = Effect.scoped(
  Effect.gen(function* () {
    const called: string[] = [];
    const handlers = group.toLayer({
      Scalar: (value) =>
        Effect.sync(() => {
          called.push("Scalar");
          return value;
        }),
      Field: (payload) =>
        Effect.sync(() => {
          called.push("Field");
          return payload.value;
        }),
      Reordered: (payload) =>
        Effect.sync(() => {
          called.push("Reordered");
          return payload.allowed ? payload.value : 0n;
        }),
      Empty: () =>
        Effect.sync(() => {
          called.push("Empty");
          return 0n;
        }),
      Maximum: (value) =>
        Effect.sync(() => {
          called.push("Maximum");
          return value;
        }),
      Zero: (value) =>
        Effect.sync(() => {
          called.push("Zero");
          return value;
        }),
    });
    const authentication = Layer.succeed(Authentication, (effect, metadata) =>
      metadata.headers.authorization === "Bearer fixture-schema-token"
        ? effect.pipe(Effect.provideService(CurrentPrincipal, 1n))
        : Effect.fail("Unauthorized"),
    );
    return yield* Effect.gen(function* () {
      const http = yield* RpcServer.toHttpEffect(group, { disableTracing: true });
      const web = HttpEffect.toWebHandler(http);
      const transport: typeof fetch = (input, init) => web(new Request(input, init));
      const responses = yield* exchange(transport, "http://reffect.test/rpc");
      expect(called).toHaveLength(rows.filter((row) => row.valid).length);
      yield* stockClient(transport, "http://reffect.test/rpc");
      expect(called).toHaveLength(rows.filter((row) => row.valid).length + stockCallCount);
      return responses;
    }).pipe(Effect.provide([handlers, authentication, RpcSerialization.layerJson]));
  }),
);

test("bounded payload range factories reject invalid bounds and derived/output schemas", async () => {
  expect(() => RpcCodecs.u64Range({ minimum: 2n, maximum: 1n })).toThrow(RangeError);
  expect(() => RpcCodecs.u64Range({ minimum: -1n, maximum: 1n })).toThrow(RangeError);
  expect(() => RpcCodecs.u64Range({ minimum: 0n, maximum: 18446744073709551616n })).toThrow(
    RangeError,
  );
  expect(() => Reflect.apply(RpcCodecs.u64Range, undefined, [{ minimum: 0, maximum: 1n }])).toThrow(
    TypeError,
  );
  expect(RpcCodecs.U64Json.make(1n)).toBe(1n);
  expect(RpcCodecs.U64Json.makeOption(1n)).toEqual(Option.some(1n));
  expect(await Effect.runPromise(high.makeEffect(9007199254740993n))).toBe(9007199254740993n);
  expect(Object.isFrozen(high)).toBe(true);
  expect(Object.isFrozen(high.ast)).toBe(true);
  expect(Object.isFrozen(high.ast.checks)).toBe(true);
  const identity = R.fn([R.U64], R.U64, (value) => value);
  for (const schema of [
    high.check(Schema.isGreaterThanBigInt(9007199254740993n)),
    high.annotate({ title: "changed" }),
  ]) {
    const error = await Effect.runPromise(
      NativeRpc.compile(
        RpcGroup.make(Rpc.make("Check", { payload: schema, success: RpcCodecs.U64Json })),
        { Check: NativeRpc.bind(identity) },
      ).pipe(Effect.flip),
    );
    expect(error.diagnostics[0]?.code).toBe("RPC_UNSUPPORTED");
  }
  const error = await Effect.runPromise(
    NativeRpc.compile(
      RpcGroup.make(Rpc.make("Check", { payload: RpcCodecs.U64Json, success: high })),
      { Check: NativeRpc.bind(identity) },
    ).pipe(Effect.flip),
  );
  expect(error.diagnostics[0]?.message).toContain("payloads only");
  const effectIdentity = R.fn([R.U64], R.U64, R.U64, (value) => R.Effect.succeed(value));
  const errorSchema = await Effect.runPromise(
    NativeRpc.compile(
      RpcGroup.make(
        Rpc.make("Check", { payload: RpcCodecs.U64Json, success: RpcCodecs.U64Json, error: high }),
      ),
      { Check: NativeRpc.bind(effectIdentity) },
    ).pipe(Effect.flip),
  );
  expect(errorSchema.diagnostics[0]?.message).toContain("payloads only");
});

test(
  "native range payload validation matches official Schema and stock clients before auth",
  async () => {
    const oracle = await Effect.runPromise(withOracle);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const artifact = yield* NativeRpc.compile(group, bindings, { auth });
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-schema-" });
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.fetch(directory);
          yield* CargoApi.build(directory, "debug");
          const called: string[] = [];
          const child = yield* ChildProcess.make(
            `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
            ["--port", "0"],
            {
              env: {
                REFFECT_RPC_CREDENTIALS: JSON.stringify([
                  { token: "fixture-schema-token", principal: "1" },
                ]),
              },
              extendEnv: true,
            },
          );
          yield* Stream.runForEach(Stream.splitLines(Stream.decodeText(child.stderr)), (line) =>
            Effect.sync(() => {
              if (line) called.push(line);
            }),
          ).pipe(Effect.forkScoped);
          const ready = yield* Stream.runHead(
            Stream.splitLines(Stream.decodeText(child.stdout)),
          ).pipe(Effect.timeout("5 seconds"));
          if (!Option.isSome(ready)) throw new Error("Missing native ready record");
          const record = Schema.decodeUnknownSync(Schema.Struct({ address: Schema.String }))(
            JSON.parse(ready.value),
          );
          const url = `http://${record.address}/rpc`;
          expect(yield* exchange(fetch, url)).toEqual(oracle);
          yield* stockClient(fetch, url);
          const expected = rows.filter((row) => row.valid).length + stockCallCount;
          yield* Effect.sync(() => called.length).pipe(
            Effect.repeat({
              while: (count) => count < expected,
              schedule: Schedule.spaced("2 millis"),
            }),
            Effect.timeout("2 seconds"),
          );
          expect(called).toHaveLength(expected);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0),
);
