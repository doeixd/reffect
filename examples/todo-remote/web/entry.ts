/**
 * Hydrates the native server's render with a stock Effect RPC client for the published Remote
 * contract. `/rpc` and the page are the same origin: the Vite dev server proxies both to the
 * native server.
 */
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { Runtime } from "foldkit";
import { Remote, RemoteRpc } from "foldkit-remote";
import { BUILD_ID, Flags, Message, Model, init, subscriptions, update, view } from "./app.ts";

// The serialization the server speaks, from the Vite config; a bundle without it uses NDJSON.
declare const __TODO_REMOTE_RPC__: string | undefined;
const serialization =
  typeof __TODO_REMOTE_RPC__ !== "undefined" && __TODO_REMOTE_RPC__ === "schema-binary"
    ? RpcSerialization.layerSchemaBinary()
    : RpcSerialization.layerNdjson;

// The transport, likewise: HTTP, or one WebSocket session on the page's own origin.
declare const __TODO_REMOTE_TRANSPORT__: string | undefined;
const protocol =
  typeof __TODO_REMOTE_TRANSPORT__ !== "undefined" && __TODO_REMOTE_TRANSPORT__ === "websocket"
    ? RpcClient.layerProtocolSocket().pipe(
        Layer.provide([
          Socket.layerWebSocket(
            `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`,
          ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
          serialization,
        ]),
      )
    : RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
        Layer.provide([FetchHttpClient.layer, serialization]),
      );

// Remote.clientLayer takes the stock client; a transport failure becomes a Remote error.
const RemoteLive = Layer.unwrap(
  Effect.gen(function* () {
    const rpc = yield* RpcClient.make(RemoteRpc, { disableTracing: true });
    return Remote.clientLayer(rpc);
  }),
).pipe(Layer.provide(protocol));

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
