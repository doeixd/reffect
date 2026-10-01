import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpEffect } from "effect/http";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import { Reference } from "../../../src/index.ts";
import { UnaryGroup, unaryHandlers } from "./contract.ts";

export interface Exchange {
  readonly method: string;
  readonly url: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly requestBody: string;
  readonly status: number;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly responseBody: string;
}

/** Replace transport with real fetch and a native URL to replay the same contract. */
export const makeHarness = (
  transport: typeof globalThis.fetch,
  url = "http://reffect.test/rpc",
) => {
  const exchanges: Array<Exchange> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const requestBody = await request.clone().text();
    const response = await transport(request);
    exchanges.push({
      method: request.method,
      url: request.url,
      requestHeaders: Object.fromEntries(request.headers),
      requestBody,
      status: response.status,
      responseHeaders: Object.fromEntries(response.headers),
      responseBody: await response.clone().text(),
    });
    return response;
  };
  const protocol = RpcClient.layerProtocolHttp({
    url,
    transformClient: (client) =>
      HttpClient.transformResponse(client, (response) =>
        response.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
      ),
  }).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]));
  return {
    exchanges,
    client: RpcClient.make(UnaryGroup, { disableTracing: true }).pipe(Effect.provide(protocol)),
    tracedClient: RpcClient.make(UnaryGroup).pipe(Effect.provide(protocol)),
    post: (body: string, headers?: HeadersInit) =>
      fetch(url, { method: "POST", headers: new Headers(headers), body }),
  };
};

export interface Invocation {
  readonly tag: string;
  readonly requestId: string | number;
  readonly headers: Readonly<Record<string, string>>;
}

/** Own the stock server fiber and all client request scopes for the entire scenario. */
export const withOracle = <A, E, R>(
  use: (
    harness: ReturnType<typeof makeHarness>,
    invocations: Array<Invocation>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.suspend(() => {
    const invocations: Array<Invocation> = [];
    const handlers = UnaryGroup.toLayer({
      Add: (payload, metadata) =>
        Effect.sync(() => {
          invocations.push({
            tag: "Add",
            requestId: metadata.requestId,
            headers: metadata.headers,
          });
        }).pipe(
          Effect.andThen(Effect.yieldNow),
          Effect.andThen(
            Reference.run(unaryHandlers.Add, [payload.left, payload.right]).pipe(
              Effect.catchTag("CompileError", Effect.die),
            ),
          ),
        ),
      Guard: (payload, metadata) =>
        Effect.sync(() => {
          invocations.push({
            tag: "Guard",
            requestId: metadata.requestId,
            headers: metadata.headers,
          });
        }).pipe(
          Effect.andThen(
            Reference.run(unaryHandlers.Guard, [payload.allowed]).pipe(
              Effect.catchTag("CompileError", Effect.die),
            ),
          ),
        ),
      Unit: (_payload, metadata) =>
        Effect.sync(() => {
          invocations.push({
            tag: "Unit",
            requestId: metadata.requestId,
            headers: metadata.headers,
          });
        }).pipe(
          Effect.andThen(
            Reference.run(unaryHandlers.Unit, []).pipe(
              Effect.catchTag("CompileError", Effect.die),
              Effect.as(undefined),
            ),
          ),
        ),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const http = yield* RpcServer.toHttpEffect(UnaryGroup, { disableTracing: true });
        const handler = HttpEffect.toWebHandler(http);
        const transport: typeof globalThis.fetch = (input, init) =>
          handler(new Request(input, init));
        return yield* use(makeHarness(transport), invocations);
      }).pipe(Effect.provide([handlers, RpcSerialization.layerJson])),
    );
  });
