# RPC protocol and transports

[Roadmap](../PLAN.md) · [Documentation index](README.md)

Use the [revised milestones](implementation-milestones.md) for feature order: early middleware, then streaming/interruption, later SchemaBinary and persistent sessions. The optional [Cruster backend](cruster-backend.md) handles internal cluster RPC separately from the browser's Effect RPC compatibility boundary; this document retains the detailed protocol proposals.

This document preserves a design discussion from the original PLAN.md. APIs and package names are proposals, not implemented guarantees. Original citation placeholders are retained; verify external API and protocol claims against the installed dependencies before implementation.

## Contents

- [Streams](#streams)
- [Server → client RPC actually means two things](#server--client-rpc-actually-means-two-things)
- [Persistent server→client behavior strongly favors WebSocket](#persistent-serverclient-behavior-strongly-favors-websocket)
- [Middleware](#middleware)
- [Serialization should remain completely independent](#serialization-should-remain-completely-independent)
- [Custom serialization](#custom-serialization)
- [SchemaBinary is particularly exciting](#schemabinary-is-particularly-exciting)
- [WebSocket transport](#websocket-transport)
- [Raw socket / TCP](#raw-socket--tcp)
- [One common transport interface](#one-common-transport-interface)
- [How I would sequence these features](#how-i-would-sequence-these-features)

---

Yes. These are really the pieces that turn the MVP from “typed HTTP request/response” into a **full Effect-compatible RPC protocol implementation**. And they fit the architecture well because Effect already separates protocol messages, serialization, transports, middleware, streams, and interruption rather than baking them into one server implementation. Current `RpcTest`, for example, exercises requests/responses alongside stream chunks, acknowledgements, interrupts, headers, and middleware metadata without involving an actual transport. :chatgpt-content-reference{index="0"}

The clean architecture is:

```text
Rpc contract + handlers
        │
        ▼
┌──────────────────┐
│ Native RPC Core  │
│                  │
│ request routing  │
│ stream state     │
│ cancellation     │
│ middleware       │
│ client sessions  │
└────────┬─────────┘
         │ RpcMessage
         ▼
┌──────────────────┐
│ Serialization    │
│ JSON / NDJSON    │
│ SchemaBinary     │
│ custom           │
└────────┬─────────┘
         │ bytes / frames
         ▼
┌──────────────────┐
│ Transport        │
│ HTTP             │
│ WebSocket        │
│ raw Socket/TCP   │
└──────────────────┘
```

The **RPC core should know almost nothing about HTTP/WebSocket/TCP**, and the transport should know almost nothing about schemas or handlers.

## Streams

Streaming should be a real protocol concept, not “return an array eventually.”

Conceptually:

```ts
const WatchTodos = Rpc.make("WatchTodos", {
  payload: { userId: UserId },
  success: Todo,
  error: WatchError,
  stream: true,
});
```

The compiled handler returns something semantically like:

```text
Stream<Todo, WatchError, R>
```

and native lowering makes that something approximately equivalent to a Rust async stream:

```rust
Stream<Item = Result<Todo, WatchError>>
```

although internally we may want a pull abstraction closer to Effect's own stream/socket semantics.

For every streaming request the native RPC server maintains state roughly like:

```text
StreamRequest {
    requestId
    scope
    cancellationToken
    producer
    outstandingChunks
    backpressureState
}
```

The wire protocol then looks conceptually like:

```text
Client                         Server

Request #42 ──────────────────►

             ◄──── Chunk #42 [A,B,C]

Ack #42 ──────────────────────►

             ◄──── Chunk #42 [D,E]

Ack #42 ──────────────────────►

             ◄──── Exit #42 Success
```

The important bit is **the acknowledgement path**. Current Effect RPC already has stream chunks, acknowledgements and interrupts in its protocol machinery, and Effect specifically hardened HTTP stream backpressure in the v4 RC cycle. :chatgpt-content-reference{index="1"}

Our Rust implementation should preserve that idea rather than just:

```rust
while let Some(x) = stream.next().await {
    socket.send(x).await;
}
```

with unlimited buffering.

Instead there should be an explicit bounded window or bounded outbound queue:

```text
producer
   ↓
bounded chunk buffer
   ↓
serialization
   ↓
transport
   ↓
client acknowledgement
   └──────────────► permits producer to advance
```

That provides end-to-end backpressure.

Cancellation is equally important:

```text
client stops consuming
       ↓
Interrupt(requestId)
       ↓
CancellationToken
       ↓
stream fiber interrupted
       ↓
stream dropped
       ↓
request Scope closes
       ↓
database cursor/socket/etc finalized
```

This is a very good place for Effect semantics to sit above Tokio.

### Streams over HTTP

This works, but the response has to contain **multiple framed RPC messages**.

Plain JSON is not enough for that because one JSON document doesn't give you an incremental message boundary.

Effect's serialization abstraction already distinguishes this explicitly: JSON is intended where the transport itself gives framing, while NDJSON provides framing for streaming byte streams. :chatgpt-content-reference{index="2"}

So we'd want:

```text
HTTP unary
    JSON is fine

HTTP streaming
    NDJSON
    or SchemaBinary
```

Conceptually:

```text
POST /rpc

response body:

{ Chunk... }\n
{ Chunk... }\n
{ Chunk... }\n
{ Exit...  }\n
```

The browser's normal Effect RPC client should decode those incrementally.

---

# Server → client RPC actually means two things

There's a major distinction here.

### One-way server notifications

This is:

```text
server → client
no response expected
```

Examples:

```text
TodoChanged
BuildProgress
CacheInvalidated
PresenceChanged
```

Effect v4 recently made server notifications first-class RPC messages. :chatgpt-content-reference{index="3"}

The native implementation is easy once we have a persistent client connection:

```rust
session.send(
    RpcMessage::Notification(...)
).await
```

At the Effect level, I'd want the handler to have some connection-scoped service such as:

```ts
const client = yield * CurrentRpcClient;

yield *
  client.notify.TodoChanged({
    todo,
  });
```

or, ideally, whatever existing Effect API already represents this.

Native code doesn't care much about the exact TS spelling. The IR is:

```text
NotifyClient {
    client
    rpc
    payload
}
```

### Full reverse RPC

This is more interesting:

```text
server → client request
client executes handler
client → server result
```

For example:

```text
server:
    "Choose a local directory."

browser/client:
    opens UI
    user chooses

client:
    DirectorySelected(...)
```

I would model this as **another RpcGroup**.

For example:

```text
ServerApi
    client calls these on server

ClientApi
    server calls these on client
```

Effect's current MCP implementation already demonstrates this conceptual architecture: it has separate client→server request/notification groups and server→client request/notification groups. :chatgpt-content-reference{index="4"}

So a server handler might conceptually get:

```ts
ClientApi;
```

as a service representing **this particular connected client**:

```ts
const client = yield * ClientApi;

const answer =
  yield *
  client.confirm({
    message: "Delete this file?",
  });
```

Native implementation:

```text
server handler
    │
    │ allocate reverse request ID 775
    ▼
pendingReverseRequests[775] = Deferred
    │
    ▼
send Request(775, Confirm, ...)
    │
    ▼
browser
    │
    │ dispatch ClientApi handler
    ▼
send Success(775, true)
    │
    ▼
complete Deferred
    │
    ▼
server fiber resumes
```

Cancellation works in both directions too.

If the server fiber is interrupted:

```text
server sends Interrupt(775)
```

If the browser disconnects:

```text
all pending reverse RPCs fail/interrupted
```

This is essentially an RPC connection becoming a **bidirectional typed capability channel**.

---

# Persistent server→client behavior strongly favors WebSocket

Ordinary request/response HTTP is great for:

```text
client asks
server responds
```

and even:

```text
client asks
server streams response for a while
```

But arbitrary:

```text
server decides 20 minutes later to call client
```

needs a persistent downstream connection.

You _can_ construct:

```text
SSE/downstream connection
+
POST/upstream connection
```

but now you're basically implementing your own bidirectional session protocol across two HTTP channels.

For native Effect RPC I would make:

```text
HTTP
    unary + server-streaming

WebSocket
    full duplex RPC

raw socket
    full duplex RPC
```

the natural model.

---

# Middleware

There are actually **two middleware layers**, and we should keep them separate.

Transport middleware is things like:

```text
CORS
compression
TLS
HTTP request logging
proxy headers
```

Those should just use:

```text
Axum / Tower / Hyper
```

where appropriate.

RPC middleware is semantic:

```text
authentication
authorization
RPC tracing
request-scoped CurrentUser
RPC rate limiting
tenant resolution
RPC-specific error mapping
```

Effect v4 includes an `RpcMiddleware` module as part of the RPC system. :chatgpt-content-reference{index="5"}

Our compiler should represent middleware something like:

```text
Middleware {
    requires
    provides
    errors
    body
}
```

For example:

```text
AuthMiddleware

requires:
    TokenVerifier

provides:
    CurrentUser

mayFail:
    Unauthorized
```

Handler:

```text
GetAccount

requires:
    CurrentUser
    Database
```

The compiler resolves:

```text
AuthMiddleware
        │
        ▼
 provides CurrentUser
        │
        ▼
GetAccount
```

and generates direct Rust composition.

There doesn't need to be a dynamic middleware registry in production.

Conceptually generated Rust could resemble:

```rust
async fn get_account_with_auth(
    req: Request,
    token_verifier: &TokenVerifier,
    database: &Database,
) -> Result<Account, RpcError> {
    let user =
        authenticate(req.headers(), token_verifier).await?;

    get_account(&user, database).await
}
```

The abstractions may disappear completely.

### Request services

This is where middleware + Context becomes particularly valuable.

Authentication middleware can produce:

```text
CurrentUser
Tenant
Permissions
RequestId
TraceSpan
```

and those become request-scoped fields rather than dynamic Context lookups.

Something like:

```rust
struct RequestContext<'a> {
    user: &'a User,
    tenant: TenantId,
    request_id: RequestId,
}
```

could be generated automatically.

### Client middleware

The browser's normal Effect RPC client can continue running its existing Effect-side middleware.

We don't have to compile that to Rust.

The shared RPC declaration merely says:

```text
this RPC requires AuthMiddleware
```

and:

```text
browser side
    Effect client middleware attaches token

server side
    native compiled middleware validates token
```

That's a very nice separation.

---

# Serialization should remain completely independent

Current Effect `RpcSerialization` is already almost exactly the abstraction we want.

It defines:

```text
codecFor(schema)
contentType
includesFraming
parser
```

and its parser takes incoming `string | Uint8Array` chunks and produces protocol messages, while encoding protocol messages back to strings/bytes. :chatgpt-content-reference{index="6"}

So the compiler shouldn't invent:

```text
HttpRpc
WebSocketRpc
BinaryRpc
JsonRpc
```

as separate systems.

Instead:

```text
             Rpc Core
                │
                ▼
         RpcSerialization
       ┌────────┼─────────┐
       ▼        ▼         ▼
     JSON     NDJSON   SchemaBinary
                │
                ▼
             Transport
```

This means you can use:

```text
WebSocket + JSON
WebSocket + SchemaBinary

TCP + NDJSON
TCP + SchemaBinary

HTTP + JSON
HTTP + NDJSON
HTTP + SchemaBinary
```

subject to framing requirements.

---

# Custom serialization

This is where standalone native compilation creates one real boundary.

Suppose someone writes an arbitrary JS:

```ts
const MySerialization =
  Layer.succeed(
    RpcSerialization,
    {
      codecFor: ...,
      makeUnsafe: () => ({
        decode(bytes) {
          // arbitrary JS
        },

        encode(message) {
          // arbitrary JS
        }
      })
    }
  )
```

We cannot automatically emit Rust for that.

There should be three tiers.

```text
Known serializer
    ↓
native implementation

Compiled serializer
    ↓
serializer expressed using portable CType/IR
    ↓
generate Rust

Arbitrary JS serializer
    ↓
hybrid JS/native target only
```

For custom native extensions I'd probably have a backend registration system rather than polluting the application API.

Something like metadata:

```text
RpcSerialization instance:
    "acme/protobuf"

native backend:
    crate = acme_rpc_codec
    implementation = ...
```

So application source still uses a normal Effect-style serialization service.

The compiler sees the service identity and knows:

```text
native implementation available
```

or:

```text
requires JS host
```

---

# SchemaBinary is particularly exciting

This is probably the eventual **preferred native wire format** when both peers are Effect.

Effect v4's `SchemaBinary` is a compact binary codec generated from the encoded side of Schema. It supports compatible schema evolution by default; arrays of structs use a compact row-run representation, and fingerprint mode can use stricter positional layouts. :chatgpt-content-reference{index="7"}

RPC's `layerSchemaBinary` additionally uses fingerprinted RPC envelopes. Payload fingerprints are disabled by default to allow compatible schema evolution, and the current default maximum frame is 16 MiB. :chatgpt-content-reference{index="8"}

This aligns beautifully with our compiler.

We know at compile time:

```text
GetUser payload
GetUser success
GetUser error

WatchUsers stream element
...
```

So instead of writing one giant generic dynamic SchemaBinary interpreter in Rust, we can generate **specialized codecs**.

Example:

```ts
const User = C.Struct({
  id: C.U64,
  name: C.String,
  age: C.U8,
});
```

could produce generated code conceptually like:

```rust
fn encode_user(
    user: &User,
    writer: &mut BinaryWriter
) {
    ...
}

fn decode_user(
    reader: &mut BinaryReader
) -> Result<User, DecodeError> {
    ...
}
```

The runtime only needs the common primitives:

```text
varints
strings
frame parsing
field IDs
fingerprints
string dictionary
row-run mechanics
```

The schemas themselves become monomorphized codecs.

That can be substantially faster than dynamic schema traversal.

The requirement is:

> Rust SchemaBinary must be byte-compatible with Effect SchemaBinary.

So testing should be:

```text
Effect JS encodes X
        ↓ bytes
Rust decodes X

Rust encodes X
        ↓ bytes
Effect JS decodes X
```

plus byte-level equality where the wire format requires canonical output.

---

# WebSocket transport

Once the RPC core exists, WebSocket should actually be quite small.

A connection owns:

```text
RpcSession
────────────────────
clientId

connection Scope
CancellationToken

active requests:
  Map<RequestId, Fiber>

active streams:
  Map<RequestId, StreamState>

pending reverse calls:
  Map<RequestId, Deferred>

client annotations/context

outbound queue
serializer/parser
```

Then there are essentially two long-lived native tasks:

```text
Reader fiber
    WebSocket frame
        ↓
    deserialize
        ↓
    RpcMessage
        ↓
    dispatch


Writer fiber
    outbound RpcMessage
        ↓
    serialize
        ↓
    WebSocket frame
```

Because WebSocket already provides message framing, plain JSON serialization works naturally; framed formats such as SchemaBinary work too. Effect's serialization abstraction explicitly distinguishes formats that include their own framing from those that rely on a framing transport. :chatgpt-content-reference{index="9"}

When the connection closes:

```text
close session Scope
      ↓
interrupt every active request
      ↓
interrupt every active stream
      ↓
fail pending reverse RPCs
      ↓
run finalizers
      ↓
release services/resources
```

That's very Effect-y.

---

# Raw socket / TCP

The RPC core is basically identical.

The difference is:

```text
WebSocket
    provides message boundaries

TCP
    byte stream only
```

So raw TCP must use a framed serialization:

```text
NDJSON
SchemaBinary
another framed custom format
```

Plain JSON cannot tell where one RPC message ends and the next begins on a continuous TCP byte stream.

Effect's `RpcSerialization` explicitly describes JSON as appropriate where transport framing already exists, and NDJSON as appropriate where framing is needed. :chatgpt-content-reference{index="10"}

Native:

```rust
TcpListener
    ↓
TcpStream
    ↓
split(reader, writer)

reader:
    read bytes
    parser.decode(bytes)
    dispatch messages

writer:
    serialize messages
    write_all(bytes)
```

Effect v4's own Socket abstraction is now pull-based and scoped, with end-to-end backpressure: data isn't read until the consumer pulls, and closing the Scope terminates outstanding reads. :chatgpt-content-reference{index="11"}

That's a very good semantic model to mirror.

---

# One common transport interface

Internally I think everything should converge on something approximately like:

```text
RpcTransport {
    receive() -> Stream<BytesOrFrame>
    send(BytesOrFrame) -> Effect<void>
    close()
}
```

with serialization layered above:

```text
Transport
    ↓ bytes/frames

Serialization parser
    ↓

RpcMessage
```

And the RPC core only sees things like:

```text
Request
Chunk
Ack
Exit
Interrupt
Notification
...
```

not HTTP or TCP.

That makes this possible:

```text
same native RPC engine

     ├── HTTP adapter
     ├── WebSocket adapter
     ├── TCP adapter
     ├── Worker adapter later
     └── in-memory adapter for tests
```

---

# How I would sequence these features

| Stage     | Capability            | What it forces us to solve                                         |
| --------- | --------------------- | ------------------------------------------------------------------ |
| **RPC 0** | unary HTTP + JSON     | contracts, schemas, handlers, services, typed errors               |
| **RPC 1** | middleware            | Context provision, auth, request state, typed middleware errors    |
| **RPC 2** | HTTP streams + NDJSON | Stream lowering, request Scope, chunks, backpressure, interruption |
| **RPC 3** | WebSocket             | persistent sessions, full-duplex transport                         |
| **RPC 4** | server notifications  | connection-scoped client capability                                |
| **RPC 5** | reverse RPC           | server→client requests, pending calls, two-way cancellation        |
| **RPC 6** | SchemaBinary          | native binary Schema codecs, fingerprints, binary framing          |
| **RPC 7** | raw TCP               | framed byte-stream transport, reconnect/lifetime semantics         |
| **RPC 8** | custom serializers    | backend extension mechanism / hybrid fallback                      |

I would pull **middleware very early**, because a web backend without authentication/request context isn't much of a backend.

And then I would make the first impressive demo after unary RPC:

```text
React/Solid browser
      │
      │ stock Effect RpcClient
      ▼
streaming WatchTodos RPC
      │
      │ NDJSON HTTP
      ▼
native Rust backend
      │
      ├── compiled auth middleware
      ├── native request Scope
      ├── SQLx
      └── Tokio cancellation

user navigates away
      ↓
Effect client interrupts stream
      ↓
Rust task cancelled
      ↓
DB stream closes
      ↓
Scope finalizer runs
```

Then switch the exact same RpcGroup to:

```text
WebSocket + SchemaBinary
```

and add server notifications.

At that point this wouldn't look like a toy compiler anymore. It would be demonstrating **actual compatibility with some of the hardest and most distinctive pieces of Effect RPC: typed streaming, backpressure, interruption, middleware, bidirectional sessions, Schema-driven serialization, and scoped resources.**
