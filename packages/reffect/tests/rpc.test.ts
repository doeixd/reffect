import { Cause, Effect, Exit, Option, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { RpcClient } from "effect/rpc";
import { U64Json } from "./fixtures/rpc/contract.ts";
import { replayUnaryCorpus } from "./fixtures/rpc/corpus.ts";
import { makeHarness, withOracle } from "./fixtures/rpc/harness.ts";

const RequestEnvelope = Schema.Struct({
  _tag: Schema.Literal("Request"),
  id: Schema.Union([Schema.String, Schema.Number]),
  tag: Schema.String,
  payload: Schema.Unknown,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});
const decodeRequest = Schema.decodeUnknownSync(RequestEnvelope);
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.timeout("3 seconds")));

test("stock HTTP client preserves u64, typed failure and Unit with exact JSON framing", async () => {
  await run(
    withOracle((harness, invocations) =>
      Effect.gen(function* () {
        const client = yield* harness.client;
        expect(yield* client.Add({ left: 18446744073709551615n, right: 1n })).toBe(0n);
        expect(yield* client.Add({ left: 9007199254740993n, right: 0n })).toBe(9007199254740993n);
        expect(yield* client.Guard({ allowed: true })).toBe(true);
        const failure = yield* Effect.exit(client.Guard({ allowed: false }));
        expect(Exit.isFailure(failure)).toBe(true);
        if (!Exit.isFailure(failure)) throw new Error("Expected a domain failure");
        expect(Cause.findErrorOption(failure.cause)).toEqual(Option.some(false));
        expect(yield* client.Unit(undefined)).toBeUndefined();

        const expected = [
          {
            tag: "Add",
            payload: { left: "18446744073709551615", right: "1" },
            exit: { _tag: "Success", value: "0" },
          },
          {
            tag: "Add",
            payload: { left: "9007199254740993", right: "0" },
            exit: { _tag: "Success", value: "9007199254740993" },
          },
          { tag: "Guard", payload: { allowed: true }, exit: { _tag: "Success", value: true } },
          {
            tag: "Guard",
            payload: { allowed: false },
            exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: false }] },
          },
          { tag: "Unit", payload: null, exit: { _tag: "Success", value: null } },
        ];
        expect(harness.exchanges).toHaveLength(expected.length);
        for (const [index, exchange] of harness.exchanges.entries()) {
          const request = decodeRequest(JSON.parse(exchange.requestBody));
          expect(JSON.parse(exchange.requestBody)).toEqual({
            _tag: "Request",
            id: request.id,
            tag: expected[index].tag,
            payload: expected[index].payload,
            headers: [],
          });
          expect(exchange.method).toBe("POST");
          expect(exchange.url).toBe("http://reffect.test/rpc/");
          expect(exchange.requestHeaders["content-type"]).toBe("application/json");
          expect(exchange.requestHeaders.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
          expect(exchange.status).toBe(200);
          expect(exchange.responseHeaders["content-type"]).toBe("application/json");
          expect(JSON.parse(exchange.responseBody)).toEqual([
            { _tag: "Exit", requestId: request.id, exit: expected[index].exit },
          ]);
        }
        expect(
          new Set(
            harness.exchanges.map((exchange) => decodeRequest(JSON.parse(exchange.requestBody)).id),
          ).size,
        ).toBe(expected.length);
        expect(invocations).toHaveLength(expected.length);
      }),
    ),
  );
});

test("portable golden corpus replays against the stock server before native implementation", async () => {
  await run(
    withOracle((harness, invocations) =>
      replayUnaryCorpus(harness).pipe(
        Effect.andThen(
          Effect.sync(() =>
            expect(invocations.map((entry) => entry.tag)).toEqual([
              "Add",
              "Add",
              "Add",
              "Guard",
              "Guard",
              "Unit",
            ]),
          ),
        ),
      ),
    ),
  );
});

test.each([
  { name: "JSON number instead of decimal string", payload: { left: 1, right: "0" } },
  { name: "missing required field", payload: { left: "1" } },
  { name: "non-numeric decimal string", payload: { left: "garbage", right: "0" } },
])("rejects $name before invoking the handler", async ({ payload }) => {
  await run(
    withOracle((harness, invocations) =>
      Effect.promise(async () => {
        const response = await harness.post(
          JSON.stringify({ _tag: "Request", id: "bad", tag: "Add", payload, headers: [] }),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([
          {
            _tag: "Exit",
            requestId: "bad",
            exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: expect.any(String) }] },
          },
        ]);
        expect(invocations).toHaveLength(0);
      }),
    ),
  );
});

test("malformed JSON is a transport Defect, distinct from a domain failure", async () => {
  await run(
    withOracle((harness, invocations) =>
      Effect.promise(async () => {
        const response = await harness.post("{");
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([
          { _tag: "Defect", defect: { name: "SyntaxError", message: expect.any(String) } },
        ]);
        expect(invocations).toHaveLength(0);
      }),
    ),
  );
});

test("overlapping stock calls preserve correlation and restore scoped envelope headers", async () => {
  await run(
    withOracle((harness, invocations) =>
      Effect.gen(function* () {
        const client = yield* harness.client;
        const values = yield* Effect.forEach(
          Array.from({ length: 16 }, (_, index) => index),
          (index) =>
            client
              .Add({ left: BigInt(index), right: 1n })
              .pipe(RpcClient.withHeaders({ "x-request-id": `request-${index}` })),
          { concurrency: "unbounded" },
        );
        expect(values).toEqual(Array.from({ length: 16 }, (_, index) => BigInt(index + 1)));
        yield* client.Add({ left: 0n, right: 0n });
        expect(invocations).toHaveLength(17);
        for (const exchange of harness.exchanges) {
          const request = decodeRequest(JSON.parse(exchange.requestBody));
          const payload = Schema.decodeUnknownSync(
            Schema.Struct({ left: U64Json, right: U64Json }),
          )(request.payload);
          const invocation = invocations.find((entry) => entry.requestId === request.id);
          expect(invocation).toBeDefined();
          expect(JSON.parse(exchange.responseBody)).toEqual([
            {
              _tag: "Exit",
              requestId: request.id,
              exit: { _tag: "Success", value: String(payload.left + payload.right) },
            },
          ]);
          expect(invocation?.headers["x-request-id"]).toBe(
            Object.fromEntries(request.headers)["x-request-id"],
          );
          expect(invocation?.headers["content-type"]).toBe("application/json");
        }
        expect(invocations.at(-1)?.headers["x-request-id"]).toBeUndefined();
      }),
    ),
  );
});

test("HTTP headers are merged before envelope headers and JSON batches correlate IDs", async () => {
  await run(
    withOracle((harness, invocations) =>
      Effect.promise(async () => {
        const response = await harness.post(
          JSON.stringify([
            {
              _tag: "Request",
              id: "a",
              tag: "Guard",
              payload: { allowed: true },
              headers: [["x-request-id", "envelope-a"]],
            },
            {
              _tag: "Request",
              id: "b",
              tag: "Guard",
              payload: { allowed: false },
              headers: [["x-request-id", "envelope-b"]],
            },
          ]),
          { "x-request-id": "http", "x-transport-only": "present" },
        );
        const responses = Schema.decodeUnknownSync(
          Schema.Array(
            Schema.Struct({ requestId: Schema.String, _tag: Schema.String, exit: Schema.Unknown }),
          ),
        )(await response.json());
        expect(
          Array.from(responses).sort((a, b) => a.requestId.localeCompare(b.requestId)),
        ).toEqual([
          { _tag: "Exit", requestId: "a", exit: { _tag: "Success", value: true } },
          {
            _tag: "Exit",
            requestId: "b",
            exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: false }] },
          },
        ]);
        expect(invocations.map((entry) => entry.headers["x-request-id"]).sort()).toEqual([
          "envelope-a",
          "envelope-b",
        ]);
        expect(invocations.every((entry) => entry.headers["x-transport-only"] === "present")).toBe(
          true,
        );
      }),
    ),
  );
});

test.each([
  { body: "[]", message: "Received empty HTTP response from RPC server" },
  { body: '[{"_tag":"Pong"}]', message: "HTTP response ended before RPC request completed" },
  { body: "{", message: "Error decoding HTTP response" },
])("stock client refuses broken response $body", async ({ body, message }) => {
  const transport: typeof globalThis.fetch = async () =>
    new Response(body, { headers: { "content-type": "application/json" } });
  const harness = makeHarness(transport);
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* harness.client;
        const error = yield* client.Add({ left: 1n, right: 0n }).pipe(Effect.flip);
        expect(error).toMatchObject({ reason: { _tag: "RpcClientDefect", message } });
      }),
    ),
  );
});

test("RPC trace fields and HTTP trace headers occupy separate wire locations", async () => {
  await run(
    withOracle((harness) =>
      Effect.gen(function* () {
        const client = yield* harness.tracedClient;
        yield* client.Guard({ allowed: true });
        const exchange = harness.exchanges[0];
        expect(JSON.parse(exchange.requestBody)).toMatchObject({
          traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
          spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
          sampled: true,
          payload: { allowed: true },
        });
        expect(exchange.requestHeaders.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      }),
    ),
  );
});
