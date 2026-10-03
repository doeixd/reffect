/**
 * Boots the app with a stock Effect RPC client for the published Remote contract. `/rpc` is the
 * same origin: the Vite dev server proxies it to the native server.
 */
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Runtime } from "foldkit";
import { Remote, RemoteRpc } from "foldkit-remote";
import { Flags, Message, Model, init, subscriptions, update, view } from "./app.ts";

// Remote.clientLayer takes the stock client; a transport failure becomes a Remote error.
const RemoteLive = Layer.unwrap(
  Effect.gen(function* () {
    const rpc = yield* RpcClient.make(RemoteRpc, { disableTracing: true });
    return Remote.clientLayer(rpc);
  }),
).pipe(
  Layer.provide(
    RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
      Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
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

Runtime.run(application, {
  flags: Effect.sync(() => ({ session: crypto.randomUUID().slice(0, 8) })),
});
