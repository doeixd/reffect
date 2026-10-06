# Milestone 11: Effect RPC over WebSocket

Status: researched and planned (2026-10-06).

## Sources (checked 2026-10-06)

- **Effect 4.0.0** as installed (`node_modules/effect/src`):
  - `rpc/RpcServer.ts`:
    - `makeSocketProtocol` 1522–1633;
    - `makeProtocolWithHttpEffectWebsocket` 986–1012, and `makeProtocolWebsocket`/`layerProtocolWebsocket` 1028–1050;
    - dispatch in `make` 761–827;
    - streams and acks 402–454;
    - protocol flags 913–945.
  - `rpc/RpcClient.ts`: `makeProtocolSocket`/`layerProtocolSocket` 1049–1262, the pinger 1217–1239, reconnect 1161–1215, Ack 569–584, Interrupt 399–470.
  - `rpc/RpcMessage.ts`: `isNotification` 60–77.
  - `rpc/RpcSerialization.ts`: the JSON, NDJSON and SchemaBinary parsers.
  - `socket/Socket.ts`: `fromWebSocket`, one element per frame.
- **`@effect/platform-node` 4.0.0** (`ws` 8.22.0): `NodeSocket.layerWebSocket` for the stock client in tests.
- **axum 0.8.9**: the `ws` feature (`tokio-tungstenite` 0.29, `sha1`, `base64`). **hyper-util 0.1.21**'s graceful shutdown accepts `http1::UpgradeableConnection`.

## What official WebSocket RPC is

### Transport and sessions

- **Route.** `RpcServer.layerHttp` defaults to WebSocket: an upgrade at `GET path`. Each socket is one client session, with a private, never-sent id.
- **Frames in.** One frame may hold several messages. Under JSON a frame is an object or an array, and an invalid one is answered with a `Defect` frame while the connection stays open. NDJSON and SchemaBinary parsers buffer across frames; an NDJSON line over 16 MiB closes the socket with code 1009.
- **Frames out.** Each server message is its own frame: text for JSON and NDJSON, binary for SchemaBinary. Nothing is batched.
- **Headers.** The upgrade's headers are prepended to each Request's own headers, lowercased, with later entries winning, so a message header overrides an upgrade header.

### Message handling

| Message                 | Answer                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `Request`               | As over HTTP: unknown tags and undecodable payloads fail that request with an Exit `Die`. Ids are echoed with their JSON type.    |
| `Ping`                  | `Pong`. The stock client pings every 5 s and fails the connection when a Pong is missing (`"ping timeout"`).                      |
| `Ack {requestId}`       | Opens the stream's latch (see Streams).                                                                                           |
| `Interrupt {requestId}` | Interrupts the request's fiber, which answers `Exit{Failure, [Interrupt]}`. Without a fiber, `Exit.interrupt()` is sent directly. |
| `Eof`                   | The stock client never sends it over sockets.                                                                                     |

### Streams

- With `supportsAck`, each stream has a latch. For each array of elements the server closes the latch, writes one `Chunk`, and awaits the latch.
- At most one unacknowledged `Chunk` is in flight per stream, and a chunk may hold many elements.
- The client acks a chunk after enqueueing its values into a bounded buffer of 16.
- A stream ends with `Exit{Success, Void}`.

### Disconnect and reconnect

- **Disconnect** interrupts every in-flight fiber of the client and sends nothing.
- **Reconnect.** The client retries with exponential backoff, starting at 500 ms and capped at 5 s. Pending requests fail with `RpcClientError` and are not replayed.

### Notifications and server-to-client RPC

- **Nothing in 4.0.0 a stock client can receive.**
  - `RequestEncoded.isNotification` exists, but core `RpcServer` treats it like any request.
  - There is no public API for a server to push to a client.
  - The stock `RpcClient` ignores server-sent `Request` messages and has no client-side handler registry.
- Only `ai/McpServer` pushes, through the internal `Protocol.send`.

## Prior decisions that apply

- **STREAM-002** ([streaming RPC](streaming-rpc.md)): no acks over HTTP, so a 16-message buffer stands in. Acked backpressure was deferred to this milestone.
- **STREAM-003**: interruption is cooperative cancellation of the handler's task, with finalizers awaited. A WebSocket `Interrupt` reuses it.
- **SB-001** ([SchemaBinary](schema-binary.md)) and **STREAM-001**: serialization is chosen per server, as in `RpcSerialization`. Over WebSocket that choice is independent of the transport.
- **The binary wire runtime** (`rpc_binary.rs`, `rpc_json.rs`): the per-serialization body readers and writers. A socket needs per-frame variants of them.
- **Unary hardening** ([unary-rpc](unary-rpc.md)): batch and duplicate-id refusals apply per body over HTTP. A session needs its own equivalent: refuse a request whose id is already in flight on that session.
- **#16** (rpc-serving): connection caps and timeouts apply to the accept loop. A WebSocket session occupies its connection slot for its lifetime.

## Decisions

- **WS-001. Scope.** Milestone 11 delivers the WebSocket transport for the stock client: persistent sessions, client-to-server unary and streaming RPC, acked backpressure, and interruption both ways (client `Interrupt`; disconnect cancels the session's tasks). It works with JSON, NDJSON and SchemaBinary.
  - **Server notifications and server-to-client RPC are deferred.** Effect 4.0.0 gives a stock client no way to receive them. Building them now would need a non-stock client protocol, which contradicts the project's compatibility goal.
  - This is recorded in open work, to revisit when upstream adds a client API.
- **WS-002. API.** `NativeRpc.compile(..., { transport: "websocket" })`, mirroring `RpcServer.layerHttp({ protocol: "websocket" })`.
  - HTTP stays the default.
  - The `serialization` option is unchanged and applies to both transports, so transport and serialization are independent.
  - The upgrade is served at `GET path`; POST bodies remain HTTP.
- **WS-003. Runtime.** A new static `rpc_socket.rs` runs one session per socket:
  - a reader task that parses frames with the serialization's parser into the same JSON-shaped envelopes;
  - per-request tasks, keyed by request id, each with its own cancellation;
  - a writer task that writes one frame per outgoing message.
  - Requests reuse `request()` and dispatch unchanged, so authentication and payload decoding behave as over HTTP.
  - axum's `ws` feature (and its crates) is added only to servers compiled with `transport: "websocket"`.
- **WS-004. Backpressure.** A streaming request writes one `Chunk`, then waits for that request's `Ack` before the next. This replaces the 16-message buffer on sockets only (STREAM-002 stays for HTTP).
- **WS-005. Failures, matching the official socket protocol:**
  - an undecodable frame gets a `Defect` and the session continues;
  - an oversize NDJSON line closes with 1009;
  - an unknown tag or bad payload gets that request's `Die`;
  - `Ping` gets `Pong`;
  - a duplicate in-flight id is refused (official behaviour there is uncertain, so it is probed before the decision is final);
  - `Interrupt` cancels the task, which answers `Exit{Failure,[Interrupt]}`;
  - close cancels every task and sends nothing.
- **WS-006. Headers.** Upgrade headers are prepended to each request's headers, as officially. Bearer authentication and session cookies are therefore read from the upgrade as well as from message headers.

## Step 1: the official socket server, probed (2026-10-06)

The probe ran `RpcServer.layerHttp({ protocol: "websocket" })` with `layerJson` on Node's HTTP server, driven by a raw WebSocket client.

| Case                                       | Official frames                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| Unary `Echo`                               | `Exit{Success}`                                                                       |
| Stream of 3, no `Ack` for 500 ms           | one `Chunk[1]` only; each `Ack` releases the next `Chunk`; then `Exit{Success, null}` |
| `Interrupt` after the first chunk          | `Exit{Failure, [Interrupt, fiberId]}`; the stream's finalizer ran                     |
| `Ping`                                     | `Pong`                                                                                |
| Garbage frame, then `Ping`                 | `Defect{SyntaxError, <JS parser message>}`, then `Pong`: the session continues        |
| A request reusing an in-flight id          | **the socket closes (1001)**                                                          |
| Handler defect (`Effect.die`), then `Echo` | `Defect{Error, boom}` (no Exit), then the Echo's Exit                                 |
| An array frame of two requests             | two Exit frames                                                                       |
| `Interrupt` for an unknown id              | nothing                                                                               |
| `Interrupt` of a pending unary             | `Exit{Failure, [Interrupt, fiberId]}`; its interruption ran                           |
| Close with a unary and a stream in flight  | both interrupted, finalizers ran                                                      |
| Unknown tag; payload failing its schema    | each request's `Exit{Failure, [Die, text]}`                                           |
| String id; `Eof`; another request          | answered with the string id; `Eof` ignored; the next request answered                 |

Native decisions from the probe:

- **WS-005 settled.** A duplicate in-flight id closes the session with 1001, as officially. An `Interrupt` for an unknown id and an `Eof` are ignored.
- **Divergences that stay as registered:**
  - A garbage frame's defect text is the native JSON path's `SyntaxError`/`Invalid JSON` (STR-007). The official text is the JS engine's.
  - Interrupted Exits omit `fiberId`: native execution has no JS fiber identifier ([async-rpc](async-rpc.md)).
  - R has no `Effect.die`; host faults stay under RTS-004.

## Steps 2–4: the native WebSocket transport (2026-10-06)

- **Runtime** (`runtime/src/rpc_socket.rs`): one session per socket. A single loop reads frames, writes answers and polls the session's request futures, so no task outlives the socket.
  - Each request runs `request()` unchanged, with its own cancellation and an `Out` whose `acks` gate releases one chunk per `Ack` (WS-004). HTTP's `Out` has no gate.
  - `Ping` gets `Pong`. `Ack` and `Interrupt` reach the request by id; an unknown id is ignored, and `Eof` is ignored.
  - A duplicate in-flight id closes with 1001.
  - On close, every request is cancelled and its answer discarded.
  - A client close is answered by the socket's own handshake, so the session keeps reading until the stream ends.
- **Per-frame parsers** sit beside each serialization's body code (`SocketParser` in `rpc_json.rs`/`rpc_binary.rs`):
  - JSON reads each frame whole: an object, or an array of messages.
  - NDJSON buffers lines across frames, skips unparseable lines, and closes with 1009 over 16 MiB.
  - SchemaBinary buffers frames across WebSocket frames. As `SchemaBinary.parser`, a failure after some messages is reported on the next frame, and the parser is spent from then on (reading of upstream, not probed).
- **Accept loop.** Every server now enables hyper's upgrades. Graceful shutdown is done directly: each connection calls hyper's `graceful_shutdown`, and shutdown waits for every connection permit. This is needed because hyper-util's `GracefulShutdown` has no impl for HTTP/1 upgradeable connections.
- **Compiler.** `NativeRpc.compile(..., { transport: "websocket" })` serves the upgrade at `GET path` instead of `POST`, uses the async runtime, and adds axum's `ws` feature only to such servers. The check crate's lock now pins `tokio-tungstenite` 0.29 for them.
- **Evidence** (`tests/websocket-rpc.test.ts`):
  - **Scripted session:** the probe's twelve cases go to the official socket server and to the native one under JSON, and the frames are equal. The only normalizations are the registered `fiberId` and the `SyntaxError` text. This covers one chunk until each `Ack`, interrupting a stream and a pending request, ping, a garbage frame, an array frame, the duplicate-id close (1001), unknown tags and bad payloads, string ids and `Eof`.
  - **Stock client:** the stock `RpcClient` over `layerProtocolSocket` and `NodeSocket.layerWebSocket` passes under JSON, NDJSON and SchemaBinary. It covers unary, typed failure, a stream, a stream stopped early (an `Interrupt`), a timed-out request, and eight concurrent requests on one session.
  - **A test pitfall, recorded:** a socket client's protocol layer must live in the caller's scope (`Layer.build`). Provided to `RpcClient.make` alone, its socket closes as soon as the client is made.

## Step 5: NativeRemote and the showcase over WebSocket (2026-10-06)

- **NativeRemote.** `NativeRemote.compile(..., { transport: "websocket" })` passes the transport through. Live no longer needs NDJSON or SchemaBinary over a socket, because every message is its own frame.
  - **Evidence** (`tests/schema-binary-remote.test.ts`): the stock client subscribes to Live over a native session with JSON frames while mutations go through the same session. Its decoded events, mutation outcomes and follow-up read equal those from the official server.
- **WS-007. Session cookies over WebSocket.** The cookie's RPC check required the page's own origin _and_ the RPC media type (a CSRF defense). An upgrade is a body-less GET, so it is now accepted when it passes the same-origin check, the standard defense against cross-site WebSocket hijacking; HTTP bodies still need the media type.
  - **Browsers send no Fetch Metadata on a WebSocket handshake.** The origin check therefore compares `Origin` with the configured page `origin`, which a deployment must set to the site's origin. Found in Chrome: with the default origin, the signed-in socket answered `Unauthorized` until the test configured it.
- **The showcase.**
  - `examples/todo-fullstack/main.ts --websocket` compiles the server with `transport: "websocket"`.
  - The browser app follows `TODO_REMOTE_TRANSPORT=websocket` (a Vite `define`): it uses `layerProtocolSocket` over `ws(s)://<host>/rpc`, and Vite proxies the upgrade (`ws: true`).
  - **Evidence:** `tests/todo-fullstack-browser.test.ts` also runs NDJSON over WebSocket in Chrome, with sign-in, hydration and a cookie-authenticated toggle.
- **Test pitfalls, recorded:**
  - An NDJSON message ends at its newline, so a hand-sent frame without one waits in the parser, on either server.
  - Objects decoded from SchemaBinary and from JSON hold the same data with keys in different orders, so cross-serialization comparisons use plain data.

## Plan

1. **Probe** the official socket server: the frames it sends for unary, stream (with and without acks), interrupt, ping, duplicate id, a bad frame and a handler defect. Record the answers here, as fixtures where they are deterministic.
2. **Runtime.** `rpc_socket.rs` (the session, reader, writer and per-request tasks), the per-frame parser and writer for each serialization, and the upgrade route. Unit tests run in the check crate.
3. **Compiler.** `transport: "websocket"`, composing axum's `ws` feature only when it is reached.
4. **Acceptance.** The stock `RpcClient` over `layerProtocolSocket` and `NodeSocket.layerWebSocket`, against the native server and the official one, under JSON, NDJSON and SchemaBinary:
   - unary and typed failures;
   - streams with acks, observed as backpressure (the producer waits);
   - client interruption of a stream (finalizers run);
   - disconnect cancelling in-flight work;
   - ping keepalive over a long idle period;
   - bearer authentication through the upgrade.
5. **Showcase.** `examples/todo-fullstack --websocket`, if Remote's Live then works over the socket, with the browser client on `layerProtocolSocket`.

## Acceptance

- The native WebSocket server answers each request with the official socket server's messages: the same frames message for message, compared per request where answers interleave.
- The stock client works under all three serializations.
- Backpressure is real: at most one unacknowledged chunk per stream.
- Interruption and disconnect run the handler's finalizers.
- Servers without the WebSocket transport gain no dependencies.

## Open questions

- **Duplicate in-flight ids:** the official reaction is uncertain from reading. Settle it in step 1.
- **Handler defects:** with `disableFatalDefects` off, the official server sends a connection-level `Defect`, which fails every pending request on the client. The native HTTP path answers a handler's `Die` per request. Compare both servers in step 1 and record any divergence.
