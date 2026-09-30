# Optional Cruster distributed backend

[Roadmap](../PLAN.md) · [Documentation index](README.md) · [Revision overview](op-expr-revision-convo.md)

This document preserves part of the later design conversation. Read the revision overview for how it updates earlier proposals. Examples and upstream API, repository, and licensing claims are historical design material, not verified current facts or implemented guarantees.

## Contents

- [Where it fits especially well](#where-it-fits-especially-well)
- [Effect Cluster could compile almost directly to Cruster](#effect-cluster-could-compile-almost-directly-to-cruster)
- [Its streaming implementation is useful prior art too](#its-streaming-implementation-is-useful-prior-art-too)
- [This is particularly compelling for Foldkit Remote](#this-is-particularly-compelling-for-foldkit-remote)
- [Durable workflows are probably an even better fit](#durable-workflows-are-probably-an-even-better-fit)
- [Its `ResourceMap` is interesting, but don't confuse it with Effect `RcMap`](#its-resourcemap-is-interesting-but-dont-confuse-it-with-effect-rcmap)
- [Cruster's cancellation/uninterruptibility model is relevant](#crusters-cancellationuninterruptibility-model-is-relevant)
- [I would expose Cruster as a target capability](#i-would-expose-cruster-as-a-target-capability)
- [The compiler may not even need Cruster's proc macros](#the-compiler-may-not-even-need-crusters-proc-macros)
- [One important warning: don't make Cruster the base native runtime](#one-important-warning-dont-make-cruster-the-base-native-runtime)
- [It also changes the roadmap](#it-also-changes-the-roadmap)

---

Yes — **very much**, but I would use Cruster in a more specific role than Gen2 or Foldkit-Plus.

After looking through it, Cruster is unusually relevant because it is already a **Rust implementation of ideas directly descended from Effect's cluster system**. The repository even vendors an `effect-smol` tree containing Effect's unstable cluster sources, and `crates/cruster/src/schema.rs` explicitly says its `Persisted` and `Uninterruptible` Rust constructs replace Effect `ServiceMap.Reference` annotations from `ClusterSchema.ts`.

So I would position it like this:

```text
                 effect-native
                      │
           ordinary native Effect
                      │
              Tokio / Axum / SQLx
                      │
            ┌─────────┴──────────┐
            │                    │
      single-node runtime    distributed profile
                                  │
                                  ▼
                              Cruster
```

Not the foundation of `effect-native`, but potentially the **native backend for Effect Cluster / durable distributed execution**.

### Where it fits especially well

Cruster already gives us a lot of things we were otherwise going to eventually need:

- addressable stateless entities with sharding/routing;
- persisted versus non-persisted RPCs;
- at-least-once durable delivery;
- streaming entity calls;
- scheduled delivery;
- distributed singletons;
- cron;
- gRPC inter-node transport;
- runner discovery and shard assignment;
- durable workflows;
- journaled activities;
- durable sleep;
- deferred/signals;
- SQL-backed persistence;
- activity transactions where application SQL writes and the workflow journal commit atomically.

That last one is particularly valuable. Cruster's workflow model already solves a very hard problem:

```text
workflow activity
    │
    ├─ application DB changes
    │
    └─ activity journal result
           │
           ▼
       one SQL transaction
```

So after a crash, a completed activity can replay from its journal rather than executing the side effect again.

That's a substantial amount of native distributed-effect infrastructure we should not casually rebuild.

## Effect Cluster could compile almost directly to Cruster

Imagine eventual Effect-side source like:

```ts
const Users = Cluster.Entity.make("Users", [GetUser, UpdateUser]);
```

with RPC annotations:

```text
GetUser
  persisted = false

UpdateUser
  persisted = true
  uninterruptible = "server"
```

Our IR can preserve:

```text
Entity Users

RPC GetUser
  delivery: best-effort

RPC UpdateUser
  delivery: persisted
  interruption: server-uninterruptible
```

Then the Rust target has two possible lowerings:

```text
Rust.singleNode
    ↓
ordinary generated local service

Rust.cluster(Cruster)
    ↓
Cruster entity
```

The Cruster lowering might generate approximately:

```rust
#[entity]
struct Users {
    db: PgPool,
}

#[entity_impl]
impl Users {
    #[rpc]
    async fn get_user(...) -> ... {
        ...
    }

    #[rpc(persisted)]
    async fn update_user(...) -> ... {
        ...
    }
}
```

Cruster already generates typed entity clients and routes calls by entity ID/shard.

So instead of inventing:

```text
effect-native distributed entity runtime
```

we potentially get:

```text
Effect Cluster IR
       ↓
Cruster codegen
```

which is much more attractive.

---

## Its streaming implementation is useful prior art too

Cruster's entity client has:

```rust
send_stream<Req, Res>(...)
```

and internally deals with streamed replies, sequence ordering, pending chunks, exit replies, and receiver cancellation. Its gRPC transport also stops consuming the remote stream when the receiver is dropped.

That doesn't mean we should replace Effect RPC with Cruster RPC.

I'd keep the distinction:

```text
Browser RPC
────────────
Effect RpcClient
HTTP / WS / SchemaBinary
native Effect RPC server


Internal cluster RPC
────────────────────
Cruster
gRPC
sharding
persisted delivery
runner-to-runner calls
```

So a request could flow:

```text
Browser
   │
Effect RPC
   ▼
native server node
   │
compiled service call
   ▼
Cruster entity client
   │
gRPC
   ▼
node owning shard
   │
handler
   ▼
Postgres
```

The browser never knows Cruster exists.

---

# This is particularly compelling for Foldkit Remote

Suppose:

```text
Project:p123
```

has a home shard.

Then a native `foldkit-remote-server` could itself run on top of Cruster entities:

```text
Foldkit Remote requirement
         ↓
Native RemoteServer
         ↓
EntitySource<Project>
         ↓
Cruster Project entity
         ↓
correct owning runner
         ↓
SQLx/Postgres
```

Or more likely, use the RemoteServer itself as stateless front-end logic while Cruster shards application services underneath.

For live Remote:

```text
browser subscription
       ↓
Effect RPC stream
       ↓
native RemoteServer
       ↓
Cruster entity/stream
       ↓
remote runner
```

So Cruster could give the native Foldkit backend a **distributed scaling story** almost for free relative to implementing one ourselves.

---

# Durable workflows are probably an even better fit

We previously discussed compiling things like:

```ts
Workflow.make(...)
```

or Effect persisted queues/workflows later.

Instead of us implementing the whole durable execution engine:

```text
journal
timers
recovery
signals
idempotency
scheduled messages
distributed ownership
```

we could target Cruster.

Conceptually:

```ts
const ProcessOrder =
  C.Workflow.make("ProcessOrder", ...)
```

IR:

```text
Workflow ProcessOrder

activity ReserveInventory
activity ChargePayment
activity Confirm

durable sleep
deferred signal
```

Rust:

```text
Cruster Workflow
     +
Cruster activities
     +
SqlWorkflowEngine
```

Cruster already has `WorkflowStorage`, `DurableContext`, journal keys, durable deferreds, durable sleep and transactional activity handling.

That could eliminate **months** of infrastructure work.

---

# Its `ResourceMap` is interesting, but don't confuse it with Effect `RcMap`

Cruster also has a concurrent keyed `ResourceMap<K,V>` using `DashMap`, `OnceCell`, and `CancellationToken`. Concurrent requests for a key share initialization, and removal cancels the associated resource.

That's useful code/prior art for:

```text
keyed resources
single-flight construction
cancellation on eviction
```

and potentially for things like:

```text
Remote live resources
entity instances
compiled cache resources
```

But I would **not say it's already an implementation of Effect `RcMap`**. Effect `RcMap` has specific reference-counted scoped acquisition/release semantics. We'd need a semantic comparison before reusing it for that particular primitive.

---

# Cruster's cancellation/uninterruptibility model is relevant

Cruster has an explicit:

```rust
enum Uninterruptible {
    No,
    Client,
    Server,
    Both,
}
```

and its comment says this maps the Effect Cluster annotations into Rust.

This is exactly the kind of thing we'd otherwise have to design when compiling:

```ts
Effect.uninterruptible(...)
```

around remote operations.

It doesn't solve Effect's **general fiber interruption model**, but it gives us a ready semantic implementation for cluster RPC interruption policy.

---

# I would expose Cruster as a target capability

This meshes nicely with the Gen2-inspired target/capability design.

Something like:

```ts
Compile.make("server").pipe(
  Compile.withProgram(program),

  Compile.withTarget(
    Rust.binary({
      distributed: Cruster.cluster({
        storage: "postgres",
        discovery: "etcd",
      }),
    }),
  ),

  Compile.run,
);
```

Or perhaps Layers:

```ts
Compile.run(spec).pipe(
  Effect.provide(Cruster.layer({...}))
)
```

The program itself shouldn't necessarily know.

A service could simply say:

```text
requires:
  DistributedEntity
  PersistedDelivery
```

Then:

```text
Target: plain Tokio
    PersistedDelivery ✗

Target: Cruster
    PersistedDelivery ✓
```

The compiler explains:

```text
Service OrderProcessor requires:
  durable persisted messages
  distributed entity addressing

Selected implementation:
  Cruster

Reason:
  target supplies PersistedDelivery
  and DistributedEntity
```

That's exactly where the capability/law system becomes useful.

---

# The compiler may not even need Cruster's proc macros

There are two options.

**Fastest implementation:** generate Rust that uses Cruster's macros:

```rust
#[entity]
#[entity_impl]
#[rpc(persisted)]
```

This is easy and gives us their code generation.

**Longer-term cleaner integration:** lower our IR directly to Cruster's underlying APIs:

```text
Entity
EntityClient
Sharding
Envelope
WorkflowEngine
...
```

because our compiler already knows all the information their proc macros extract from Rust syntax.

The latter avoids:

```text
TS IR
  ↓
generated Rust syntax
  ↓
Cruster macro parses syntax
  ↓
more generated Rust
```

and becomes:

```text
TS IR
  ↓
direct Cruster registrations/types
```

But I'd absolutely use the macros for the prototype.

---

# One important warning: don't make Cruster the base native runtime

Cruster is fairly substantial. Its crate currently pulls in:

```text
Tokio
Tonic / Prost
SQLx
DashMap
parking_lot
MessagePack
tracing/OpenTelemetry
Prometheus
cron
...
```

with optional etcd, consistent hashing and Rayon support.

We do **not** want:

```ts
C.U32.add(1, 2);
```

or a simple Foldkit SSR server to suddenly bring along a distributed workflow runtime.

So:

```text
effect-native-runtime
    tiny
    Scope
    Fiber semantic glue
    cancellation
    etc.

effect-native-cruster
    optional
    cluster
    durable workflows
    persisted RPC
```

is the better split.

Tree shaking at the Cargo dependency level, essentially.

---

# It also changes the roadmap

> **Later update:** The final detailed plan assigns Cruster to [milestone 13](implementation-milestones.md#36-milestone-13--cruster-distributed-profile) and [keeps it optional](implementation-milestones.md#37-cruster-remains-optional). Local runtime and browser RPC do not depend on this backend.

I would now envision:

```text
CORE
──────────────────────
Effect Native IR
Rust codegen
Tokio
Scope/Fiber semantics
RPC
Foldkit SSR
Remote
SQLx


DISTRIBUTED
──────────────────────
effect-native-cruster

Effect Cluster
    → Cruster Entity

Persisted RPC
    → Cruster persisted RPC

Cluster streams
    → Cruster streaming

scheduled RPC
    → Cruster send_at

singleton
    → Cruster singleton

cron
    → Cruster ClusterCron

durable Workflow
    → Cruster Workflow

activity
    → Cruster Activity

durable sleep
    → Cruster workflow timer

deferred / signal
    → Cruster durable deferred

distributed routing
    → Cruster Sharding

inter-node transport
    → Cruster gRPC
```

That's a **huge later-stage capability unlock**.

And this project is especially useful because it isn't merely a random Rust actor framework that happens to have similar concepts. There is concrete evidence in the repository that its implementation was designed against Effect's cluster model: it includes the Effect cluster source tree for reference and explicitly maps Effect annotations into Rust constructs. That makes it probably the best candidate I've seen so far for the distributed side of `effect-native`.

Licensing also looks workable: the workspace declares `MIT OR Apache-2.0`, while the repository includes an MIT license file.

So I'd now divide reuse like this:

```text
Gen2
  → compiler semantics/kernel

Foldkit-Plus
  → real application/query/Remote IR

Effect
  → authoring API + reference semantics

Cruster
  → native distributed/durable runtime

Tokio/Axum/SQLx/etc.
  → native execution substrate
```

That combination makes `effect-native` look considerably more achievable than if we were building every layer ourselves.
