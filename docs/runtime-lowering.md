# Lowering Effect onto the Rust ecosystem

[Roadmap](../PLAN.md) · [Documentation index](README.md) · [Revised compiler design](compiler-design-revision.md)

This reference integrates the supplied runtime-reuse conversation once; the pasted message contained two copies of the same discussion. Formatting, missing arrows, and wording are cleaned up. The mapping candidates, registry examples, and research leads remain proposals. Original citation placeholders did not include recoverable source links, so upstream API/crate claims must be verified before implementation. Percentage estimates of reusable machinery are hypotheses, not measured coverage or acceptance criteria.

## Design principle

First ask whether an abstraction can disappear into generated code. If it must remain, select an existing Rust primitive or crate and add the semantic adapter needed to preserve observable Effect behavior. Implement dedicated runtime machinery only for semantics that neither code generation nor a verified substrate provides.

This refines the existing small-runtime design without changing the [milestone order](implementation-milestones.md). Rust dependency selection follows reachable program requirements; this document does not authorize implementing every listed module upfront.

## Three lowering strategies

| Strategy                                 | Examples                                                                                                     | Compiler responsibility                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Direct lowering or generated code        | Option, result-like values, structs, collection operations; timer calls where the supported semantics permit | Preserve type/value semantics, eliminate abstractions, and emit ordinary Rust                           |
| Existing substrate with semantic adapter | Queue over channel machinery, PubSub, Deferred, streams, caches, pools                                       | Reuse execution mechanics while supplying missing policy, lifecycle, failure, and cancellation behavior |
| Dedicated semantic runtime               | Async Scope, observable Cause/Exit, FiberRef, structured interruption, resource lifecycle                    | Implement the required Effect semantics and validate them against official Effect                       |

The strategy belongs to a supported operation/profile, not merely a module name. A timer call or semaphore acquisition may need cancellation and scope handling even when the underlying wait is provided by Tokio. A familiar Rust type name is not proof of equivalent semantics.

## Candidate mapping catalogue

The original discussion proposes the following research/implementation candidates. “Direct” describes a possible lowering after semantic checks; it does not establish full-module compatibility or a selected dependency.

| Effect concept                  | Candidate Rust substrate                             | Work to plan and verify                                       |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| Clock                           | `std::time`, `tokio::time`                           | Time service adapter, clock semantics, timer interruption     |
| Random                          | `rand`, seeded RNG such as ChaCha                    | Random service adapter, seeding/reproducibility policy        |
| Console                         | `std::io` / `tracing`                                | Output service adapter                                        |
| Tracer                          | `tracing` + OpenTelemetry                            | Trace/context adapter                                         |
| ConfigProvider                  | `config` / Figment                                   | Configuration semantics adapter                               |
| FileSystem                      | `tokio::fs`, `std::fs`                               | Typed failures, scope and interruption where required         |
| Path                            | `std::path`                                          | Path/platform semantic mapping                                |
| Process execution               | `tokio::process`                                     | Process lifecycle and interruption adapter                    |
| Filesystem watch                | `notify`                                             | Event, scope, and shutdown adapter                            |
| HTTP client                     | `reqwest`                                            | Effect failures, codecs, resource lifecycle                   |
| HTTP server                     | Axum + Hyper + Tower                                 | Route/middleware lowering and request lifetime                |
| Sockets                         | `tokio::net`                                         | Scoped I/O and cancellation adapter                           |
| WebSocket                       | `tokio-tungstenite` / Axum WS                        | Protocol and session adapter                                  |
| TLS                             | `rustls`                                             | Configuration/transport adapter                               |
| SQL                             | SQLx                                                 | Schema/query lowering, transactions and connection lifetime   |
| SQL connection pool             | SQLx `Pool`                                          | Pool policy, acquisition, and shutdown parity                 |
| Generic Pool                    | `deadpool` / `bb8`                                   | Resource acquisition/release and Scope adapter                |
| Semaphore                       | `tokio::sync::Semaphore`                             | Permit ownership and interruption contract                    |
| Queue                           | `tokio::sync::mpsc` or custom queue machinery        | Bounded/dropping/sliding strategies and shutdown contract     |
| PubSub                          | `tokio::sync::broadcast` or custom channel machinery | Effect policy, scoped subscription, backpressure and shutdown |
| Deferred                        | `oneshot` + shared completion state                  | Completion and observation wrapper                            |
| SubscriptionRef                 | `watch` + current state                              | State/change subscription wrapper                             |
| Ref                             | `Atomic*`, `Mutex`, `RwLock`, or local mutable state | Type/use/escape-based specialization                          |
| SynchronizedRef                 | Tokio `Mutex`                                        | Effectful mutation and interruption adapter                   |
| Stream                          | `futures::Stream` / `tokio-stream`                   | Typed error/environment, scope, backpressure and operators    |
| Sink                            | `futures::Sink` as possible prior art                | Compare consumption/result semantics; do not assume an alias  |
| Schedule                        | `tokio::time` + cron logic                           | Generated schedule state machine and semantic adapter         |
| Cache                           | Moka                                                 | Effect lookup, failure, sharing and eviction contract         |
| ScopedCache                     | Moka + native Scope                                  | Scoped entry/resource lifetime adapter                        |
| RequestResolver                 | DataLoader-style batching or generated batch calls   | Batching, ordering, caching and failure semantics             |
| Option                          | `Option<T>`                                          | Direct representation where the value contract matches        |
| Either / fallible values        | Enum / `Result<T, E>`                                | Direct representation with explicit variant/error mapping     |
| HashMap                         | `std::collections::HashMap`                          | Key/equality/hash and iteration semantics                     |
| HashSet                         | `HashSet`                                            | Equality/hash and collection semantics                        |
| Sorted maps/sets                | `BTreeMap` / `BTreeSet`                              | Ordering and collection semantics                             |
| Duration                        | `std::time::Duration`                                | Range, precision and supported-value mapping                  |
| Fiber task execution            | Tokio tasks / `JoinSet`                              | Effect supervision and lifecycle wrapper                      |
| Interruption                    | `CancellationToken` + generated checks               | Structured interruption, masking and finalization             |
| FiberRef                        | Generated task/fiber context                         | Inheritance/join semantics                                    |
| Scope                           | Generated async finalizer scope                      | Dedicated lifecycle/finalization semantics                    |
| Exit / Cause                    | Generated enums                                      | Dedicated representation when observable                      |
| STM / TxRef and related modules | Rust STM research or custom implementation           | Substantial semantic work; deferred scope                     |
| Cluster / workflows             | Cruster                                              | Optional later target adapter                                 |

Treat queue/channel topology and policies, Deferred completion sharing, Sink consumption, duration values, and collection ordering as conformance questions. The catalogue should not turn an illustrative mapping into an unchecked alias.

## Ref specialization

Choose the implementation using the value type, reachable operations, sharing, and escape analysis:

```text
Ref<U64> with compatible get/set/increment
    → AtomicU64 candidate

Ref<AppState> with read/update operations
    → Mutex or RwLock candidate

Ref<T> proven local and unshared
    → ordinary local mutable state candidate
```

Do not choose an atomic or lock based on the type alone. Verify update atomicity, ordering, failure/interruption, and all observable operations before eliminating the abstraction. This extends the [conservative ownership plan](implementation-milestones.md); sophisticated specialization can wait for the corresponding workload.

## Three implementation registries

Distinguish three kinds of implementation entry, even if they share common identity, capability, evidence, and target metadata:

| Entry family                    | Describes                                          | Examples                                             |
| ------------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| Operation implementation        | How a semantic operation is emitted or executed    | Integer addition, string contains, sleep, Stream.map |
| Service implementation          | How a required service is constructed and supplied | Clock, Random, FileSystem, HTTP client, database     |
| Semantic runtime implementation | How observable higher-order behavior is preserved  | Scope, Fiber, Queue, PubSub, Deferred                |

Provisional backend registration vocabulary:

```ts
Native.Service.implement(Clock.Clock, {
  target: Rust,
  capabilities: [Capability.Timer],
  implementation: Rust.builtin("clock"),
});

Native.Service.implement(FileSystem.FileSystem, {
  target: Rust,
  implementation: Rust.crate({ crate: "tokio", feature: "fs" }),
});

Native.registry({
  operations: [U64AddRust, StringContainsRust, EffectSleepTokio],
  services: [ClockTokio, RandomRand, FileSystemTokio, HttpClientReqwest, SqlClientSqlx],
  semantics: [ScopeNative, FiberNative, QueueTokio, PubSubTokio],
});
```

These examples describe compiler/backend metadata, not installed APIs. Registration should identify supported semantics and conformance evidence as well as Rust crate/features and capabilities. Reachability determines which implementations and Cargo dependencies are needed.

## Service and Layer wiring

Resolve static service requirements to generated arguments, fields, and constructors where possible. A file read and delay can eventually lower to ordinary Rust:

```rust
let config = tokio::fs::read_to_string("config.json").await?;
tokio::time::sleep(Duration::from_secs(1)).await;
```

This is a substrate illustration: generated code must also preserve the supported error, clock, and interruption contract. The supplied conversation illustrated authoring this with `Effect.gen` and ordinary `yield*`; that syntax belongs to a later frontend or source-widening experiment. Initially compiled callbacks still use symbolic builders and explicit IR, as required by the roadmap.

Likewise, a reachable Layer graph may emit application construction:

```rust
struct App {
    db: PgPool,
    http: reqwest::Client,
    users: UserRepository,
}

let db = PgPoolOptions::new().connect(&config.database_url).await?;
let http = reqwest::Client::new();
let users = UserRepository::new(db.clone());
let app = App { db, http, users };
```

Solve construction statically where possible while retaining Layer identity, memoization/freshness, acquisition failures, and scoped release. Context lookup elimination must preserve the selected service instance and lifetime.

## Caches, pools, batching, schedules, and streams

Moka is a cache candidate; SQLx Pool is a database-pool candidate; deadpool/bb8 are generic-pool candidates. Existing capacity/eviction or connection machinery does not establish Effect Cache/ScopedCache/Pool parity. Verify lookup sharing, failures, entry/resource lifetime, shutdown, and finalization as those features become supported.

RequestResolver may benefit more from compile-time planning than a general runtime DataLoader. The discussion proposes `async_dataloader` and the async-graphql DataLoader as research leads, but static requests might become:

```text
all([Users.get(1), Users.get(2), Users.get(3)])
    → users.get_many(&[1, 2, 3]).await
```

Apply such a rewrite only when request identity, batching behavior, result association, ordering, failure, caching, and interruption remain equivalent. Otherwise retain a verified batching implementation. Law/capability planning governs the choice.

Compile portable Schedule descriptions into a state machine:

```text
spaced       → timer-driven state
exponential  → loop and duration arithmetic
jittered     → RNG and duration arithmetic
cron         → cron-parser candidate and timer waits
```

Verify recurrence, delays, stopping conditions, jitter, clock and interruption semantics. Treat the `cron` crate as a candidate, not automatic parity with Effect's Schedule syntax or behavior.

Use native polling machinery for a supported Stream subset:

```text
Effect Stream<A, E, R>
    → native Stream<Item = Result<A, E>>
      + captured/generated service context
      + Scope/resource lifetime
      + interruption and backpressure adapter
```

That shape is an illustration, not a complete specification of Effect Stream/Channel/Sink. Preserve operator-specific failure, consumption, finalization and cancellation semantics; fuse operators only when valid.

## What remains in the semantic runtime

- Explicit asynchronous Scope closure and Effect-specific finalizer ordering.
- Fiber supervision, structured interruption/masking, and FiberRef inheritance/join behavior.
- Observable Exit/Cause representation and failure combination.
- Layer lifecycle semantics that cannot be resolved entirely at build time.
- Exact Queue/PubSub/Deferred/stream policies and shutdown behavior.
- Scoped caches/pools and RcRef/RcMap resource lifetime.
- Request/RequestResolver behavior that cannot be safely compiled away.
- Later transactional semantics and distributed/durable adapters, only when their milestones require them.

The discussion names `effectful`, `id_effect`, and Rust STM libraries (including `stm`) as implementation-research leads. Investigate their current APIs, maintenance, licensing, and semantic compatibility before reuse. They do not replace the official Effect oracle, establish full compatibility, or justify adopting an Effect interpreter as the base native runtime.

## Planning, support reporting, and acceptance

The proposed `Compile.explain` and support reporting should distinguish required operations, services, and semantic primitives, then show selected implementations, rejected candidates, required crates/features, and why an adapter or generated specialization is necessary.

```text
required service: FileSystem
selected candidate: TokioFs
dependency: tokio/fs
adapter obligations: supported failures and lifecycle

required primitive: Ref<AppState>
selected candidate: lock-backed state
reason: reachable operations do not admit verified atomic specialization

required operation: Schedule.exponential
selected strategy: generated state machine

required primitive: Scope
selected strategy: native async finalizer runtime
```

Integrate this classification into the existing `derive → plan → verify` stages. Introduce registry vocabulary and support obligations in the kernel/planner, but implement service/runtime entries only as needed by milestones. Keep policy-constrained fallbacks explicit and refuse unsupported semantics.

Acceptance for any mapping requires reference parity for its supported profile, explainable selection, and a generated dependency set containing only reachable implementations. Validate cancellation/finalizer traces and lifecycle policies where observable, in addition to values and typed failures. Crate availability and illustrative code alone are insufficient evidence.
