# RPC MVP

[Roadmap](../PLAN.md) · [Documentation index](README.md)

This document preserves a design discussion from the original PLAN.md. APIs and package names are proposals, not implemented guarantees. Original citation placeholders are retained; verify external API and protocol claims against the installed dependencies before implementation.

## Contents

- [What the source could look like](#what-the-source-could-look-like)
- [Then the frontend is completely ordinary Effect](#then-the-frontend-is-completely-ordinary-effect)
- [I would deliberately make v0 RPC very small](#i-would-deliberately-make-v0-rpc-very-small)
- [The first end-to-end app could be ridiculously simple](#the-first-end-to-end-app-could-be-ridiculously-simple)
- [What compilation actually has to do](#what-compilation-actually-has-to-do)
- [JSON first](#json-first)
- [This milestone does not require full Fibers](#this-milestone-does-not-require-full-fibers)
- [But cancellation can be the first Fiber-semantic upgrade](#but-cancellation-can-be-the-first-fiber-semantic-upgrade)
- [Streaming RPC can come immediately after](#streaming-rpc-can-come-immediately-after)
- [I'd make RPC the driver for the whole roadmap](#id-make-rpc-the-driver-for-the-whole-roadmap)

---

Yes. In fact, I think **“compile an Effect RPC backend for a normal web app” is probably the best first convincing demo**.

It is much narrower than “compile an entire Effect server,” but it exercises almost every important part of the architecture: Schema, typed request/response models, effects, services, Layers, async execution, serialization, HTTP transport, errors, and eventually cancellation/streaming.

The key demo would be:

```text
Browser
  │
  │ normal Effect RpcClient
  │ normal Effect schemas/contracts
  ▼
HTTP / Effect RPC protocol
  │
  ▼
Generated Rust server
  │
  ├── Tokio
  ├── Hyper/Axum
  └── compiled handler IR
```

The browser should **not know the backend is Rust**.

Effect RPC already separates the RPC contract from transport serialization, with built-in JSON, NDJSON, JSON-RPC, and SchemaBinary serializers. :chatgpt-content-reference{index="0"} That makes the wire protocol a concrete compatibility target rather than something we'd have to invent.

## What the source could look like

I'd try very hard to reuse ordinary Effect RPC definitions.

Something roughly like:

```ts
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { Schema } from "effect";
import { Compiled as C } from "effect-native";

const User = C.Struct({
  id: C.U64,
  name: C.String,
});

const GetUser = Rpc.make("GetUser", {
  payload: {
    id: C.U64,
  },
  success: User,
  error: UserNotFound,
});

export const Api = RpcGroup.make(GetUser);
```

The **contract itself is ordinary Effect RPC**.

Then only the implementation is compiled:

```ts
const ApiLive = C.Rpc.handlers(Api, {
  GetUser: ({ id }) =>
    Users.find(id).pipe(
      C.Effect.flatMap(
        C.Match.option({
          some: C.Effect.succeed,
          none: () => C.Effect.fail(UserNotFound.make({ id })),
        }),
      ),
    ),
});
```

or whatever API turns out nicest.

The important thing is:

```text
Rpc.make / RpcGroup
        ↓
shared unchanged between frontend/backend

handler implementation
        ↓
compiled IR
```

## Then the frontend is completely ordinary Effect

Something conceptually like:

```ts
const client = yield * RpcClient.make(Api);

const user =
  yield *
  client.GetUser({
    id: 123n,
  });
```

with the normal browser RPC transport.

That is the killer demonstration:

> **An unmodified Effect TypeScript client talks to a backend authored in Effect TypeScript but executing as a native Rust binary.**

That's much stronger than showing `add(1, 2)` compiling to Rust.

---

# I would deliberately make v0 RPC very small

Don't initially implement all of Effect RPC.

Effect's RPC machinery is richer than simple request/response: the current RPC test harness explicitly exercises request/response flow alongside stream chunks, acknowledgements, interrupts, headers, middleware metadata, etc. :chatgpt-content-reference{index="1"}

So the first compatibility profile should probably be:

```text
Effect Native RPC v0

✓ Rpc.make
✓ RpcGroup
✓ payload Schema
✓ success Schema
✓ typed error Schema

✓ unary request
✓ unary response

✓ JSON serialization
✓ HTTP transport

✓ async handlers
✓ services
✓ Layers

✗ streams
✗ server→client RPC
✗ middleware initially
✗ custom serialization
✗ SchemaBinary
✗ websocket/socket transport
```

That is still a genuinely useful backend.

---

# The first end-to-end app could be ridiculously simple

Something like a tiny todo application.

Shared definitions:

```ts
const Todo = C.Struct({
  id: C.U64,
  text: C.String,
  completed: C.Bool,
});

const ListTodos = Rpc.make("ListTodos", {
  success: C.Vector(Todo),
});

const AddTodo = Rpc.make("AddTodo", {
  payload: {
    text: C.String,
  },
  success: Todo,
});

const ToggleTodo = Rpc.make("ToggleTodo", {
  payload: {
    id: C.U64,
  },
  success: Todo,
});

export const TodosRpc = RpcGroup.make(ListTodos, AddTodo, ToggleTodo);
```

Backend:

```ts
const TodoRepo = C.Service.make(...)

const Handlers =
  C.Rpc.handlers(TodosRpc, {
    ListTodos: () =>
      TodoRepo.list(),

    AddTodo: ({ text }) =>
      TodoRepo.add(text),

    ToggleTodo: ({ id }) =>
      TodoRepo.toggle(id),
  })
```

Build:

```bash
effect-native build server.ts
```

produces:

```text
target/release/todos-server
```

Frontend:

```ts
const client = yield * RpcClient.make(TodosRpc);

yield *
  client.AddTodo({
    text: "Compile Effect to Rust",
  });
```

No generated Rust API client.

No OpenAPI.

No REST duplication.

The existing Effect RPC contract remains the source of truth.

---

# What compilation actually has to do

The RPC declaration gives us most of the boundary information automatically:

```text
Rpc GetUser

tag:
    "GetUser"

payload:
    Struct {
        id: U64
    }

success:
    User

error:
    UserNotFound
```

So the build pipeline becomes:

```text
RpcGroup
   ↓
inspect schemas
   ↓
compile request/response codecs
   ↓
compile handler graph
   ↓
generate Rust types
   ↓
generate RPC dispatcher
   ↓
generate HTTP server
```

The Rust dispatcher is conceptually:

```rust
match request.tag.as_str() {
    "GetUser" => {
        let payload =
            decode_get_user(request.payload)?;

        let result =
            get_user(&services, payload).await;

        encode_get_user_result(result)
    }

    "AddTodo" => { ... }

    _ => protocol_error(...)
}
```

That is straightforward.

---

# JSON first

Effect v4 RPC already has a defined serialization abstraction whose job is specifically to turn RPC message envelopes into bytes/strings and back. JSON is one of the supported serializers. :chatgpt-content-reference{index="2"}

So don't begin by implementing Effect's fastest possible wire format.

Start with:

```text
Effect RpcClient
      ↓
JSON
      ↓
HTTP
      ↓
Rust
```

That makes debugging trivial because you can inspect requests manually.

Once interoperability is proven:

```text
JSON
 ↓
NDJSON
 ↓
SchemaBinary
```

can come later.

SchemaBinary in particular would eventually be very interesting because Effect already supports a binary RPC serialization with schema-aware encoding/fingerprints. :chatgpt-content-reference{index="3"}

---

# This milestone does not require full Fibers

Another reason I like it.

For a unary RPC handler:

```ts
GetUser;
```

we can initially translate:

```text
Effect<A,E,R>
```

mostly into:

```rust
async fn(...) -> Result<A,E>
```

with Tokio executing the request.

We need:

```text
services
Layer startup
async
typed errors
serialization
HTTP
```

but we do **not** initially need:

```text
user-visible Fiber handles
FiberRef
Queue
PubSub
Effect.race
streaming
full Cause trees
```

That drastically lowers the first milestone.

---

# But cancellation can be the first Fiber-semantic upgrade

Once unary RPC works, the next really compelling feature would be:

> Browser cancels an Effect RPC call → native Rust handler is interrupted → scoped resources finalize.

Effect's RPC machinery has interruption as part of its protocol model rather than treating RPC as merely a JSON request/response abstraction; the test transport explicitly passes interrupts through the same machinery. :chatgpt-content-reference{index="4"}

So the next demo could be:

```ts
const SlowQuery = Rpc.make(...)
```

handler:

```ts
C.Effect.acquireRelease(
  OpenResource,
  resource =>
    C.Effect.sleep("30 seconds").pipe(...),
  resource =>
    CloseResource(resource)
)
```

Then:

```text
browser starts RPC
       ↓
Rust task starts
       ↓
browser fiber interrupted
       ↓
RPC interrupt
       ↓
Rust CancellationToken cancelled
       ↓
handler exits
       ↓
Scope finalizer runs
       ↓
resource closed
```

Now you're demonstrating that you're not merely implementing an RPC-compatible Rust server.

You're preserving **Effect semantics across the wire into native execution**.

That would be a very strong second milestone.

---

# Streaming RPC can come immediately after

Once the unary protocol is solid:

```ts
const WatchTodos = Rpc.make("WatchTodos", {
  success: C.Stream(Todo),
});
```

could eventually become:

```text
Effect Stream
      ↓
RPC stream chunks
      ↓
HTTP streaming / NDJSON
      ↓
Rust Stream
```

Effect RPC serialization already accounts for stream chunks and framed serializers such as NDJSON. :chatgpt-content-reference{index="5"}

That would force us to implement:

```text
Stream
backpressure
request Scope lifetime
cancellation
Fiber supervision
```

in a real application rather than building them speculatively.

That's exactly the sort of pressure we want.

---

# I'd make RPC the driver for the whole roadmap

Something like:

**Demo 0 — Native function:** compile a pure `C.fn` to Rust.

**Demo 1 — Native Effect RPC:** browser Effect client → JSON/HTTP → Rust backend; unary RPC, Schema, errors, Services/Layers.

**Demo 2 — Cancellation:** interrupt client call → native fiber cancellation + Scope/finalizers.

**Demo 3 — Concurrent handler:** handler uses `Effect.all`, Ref/Semaphore, native Tokio concurrency.

**Demo 4 — Streaming RPC:** Rust streams values to the standard Effect RPC client.

**Demo 5 — SQL:** RPC handler uses compiled SQL service → SQLx/Postgres.

At Demo 5 you have a real backend stack:

```text
React / Solid
      │
Effect RpcClient
      │
      │ same RpcGroup + Schemas
      ▼
┌──────────────────────────┐
│ native Rust server       │
│                          │
│ Effect RPC protocol      │
│ Tokio fibers             │
│ generated Layers         │
│ services                 │
│ SQLx                     │
│ Serde                    │
└──────────────────────────┘
      │
      ▼
Postgres
```

And almost all of the API/frontend developer experience is still ordinary Effect.

So yes: **I would elevate this from “possible early demo” to probably the primary MVP target.** It gives the compiler a very clear compatibility test:

> Can the official Effect RPC client connect to the generated binary and behave exactly as though it were talking to an ordinary Effect RPC server?

If the answer is yes, you've demonstrated a surprisingly large fraction of the thesis already.
