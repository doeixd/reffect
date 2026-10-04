/**
 * Hydrates the native server's render with a stock Effect RPC client for the published Remote
 * contract. `/rpc` and the page are the same origin: the Vite dev server proxies both to the
 * native server.
 */
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Runtime } from "foldkit";
import { Remote, RemoteRpc } from "foldkit-remote";
import { BUILD_ID, Flags, Message, Model, init, subscriptions, update, view } from "./app.ts";

// Remote.clientLayer takes the stock client; a transport failure becomes a Remote error.
const RemoteLive = Layer.unwrap(
  Effect.gen(function* () {
    const rpc = yield* RpcClient.make(RemoteRpc, { disableTracing: true });
    return Remote.clientLayer(rpc);
  }),
).pipe(
  Layer.provide(
    RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
      Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson]),
    ),
  ),
);

const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
  subscriptions,
  container: document.getElementById("root"),
  resources: RemoteLive,
  devTools: { Message },
});

// The native server rendered the first screen; adopt it and start from its Flags.
Runtime.hydrate(application, { buildId: BUILD_ID });
