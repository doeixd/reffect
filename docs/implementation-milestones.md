# Revised implementation milestones

[Roadmap](../PLAN.md) · [Documentation index](README.md) · [Revision overview](op-expr-revision-convo.md)

This document preserves part of the later design conversation. Read the revision overview for how it updates earlier proposals. Examples and upstream API, repository, and licensing claims are historical design material, not verified current facts or implemented guarantees.

## Contents

- [14. Milestone 0 — bootstrap the semantic kernel](#14-milestone-0--bootstrap-the-semantic-kernel)
- [Acceptance](#acceptance)
- [15. Milestone 1 — Foldkit Entity Expr/Query as the first real compiler target](#15-milestone-1--foldkit-entity-exprquery-as-the-first-real-compiler-target)
- [16. Milestone 2 — general compiled functions and Effect IR](#16-milestone-2--general-compiled-functions-and-effect-ir)
- [17. Initial ownership implementation](#17-initial-ownership-implementation)
- [18. Milestone 3 — unary Effect RPC](#18-milestone-3--unary-effect-rpc)
- [Acceptance](#acceptance-1)
- [19. Middleware belongs in RPC early](#19-middleware-belongs-in-rpc-early)
- [20. Milestone 4 — native Foldkit RemoteServer](#20-milestone-4--native-foldkit-remoteserver)
- [Acceptance](#acceptance-2)
- [21. Authorization must become portable](#21-authorization-must-become-portable)
- [22. Milestone 5 — native Query → SQLx](#22-milestone-5--native-query--sqlx)
- [Acceptance](#acceptance-3)
- [23. Milestone 6 — streaming RPC + real interruption](#23-milestone-6--streaming-rpc--real-interruption)
- [24. Native Scope runtime](#24-native-scope-runtime)
- [25. Milestone 7 — native Foldkit Remote live](#25-milestone-7--native-foldkit-remote-live)
- [26. Milestone 8 — native Foldkit SSR](#26-milestone-8--native-foldkit-ssr)
- [Critical compatibility rule](#critical-compatibility-rule)
- [27. HTML compilation](#27-html-compilation)
- [28. Milestone 9 — SSR + Remote `Data.satisfy` + resume](#28-milestone-9--ssr--remote-datasatisfy--resume)
- [Important optimization](#important-optimization)
- [29. First major showcase application](#29-first-major-showcase-application)
- [30. Milestone 10 — SchemaBinary](#30-milestone-10--schemabinary)
- [31. Milestone 11 — WebSocket + bidirectional RPC](#31-milestone-11--websocket--bidirectional-rpc)
- [32. Milestone 12 — broader Effect concurrency](#32-milestone-12--broader-effect-concurrency)
- [33. Structured concurrency ownership pass](#33-structured-concurrency-ownership-pass)
- [34. Ref specialization](#34-ref-specialization)
- [35. Laws start enabling real optimization here](#35-laws-start-enabling-real-optimization-here)
- [36. Milestone 13 — Cruster distributed profile](#36-milestone-13--cruster-distributed-profile)
- [37. Cruster remains optional](#37-cruster-remains-optional)
- [38. Milestone 14 — custom serialization and additional targets](#38-milestone-14--custom-serialization-and-additional-targets)
- [39. Milestone 15 — source syntax widening](#39-milestone-15--source-syntax-widening)
- [40. Hybrid JavaScript target comes after native semantics are solid](#40-hybrid-javascript-target-comes-after-native-semantics-are-solid)

---

# 14. Milestone 0 — bootstrap the semantic kernel

Do not start with HTTP.

Adapt the useful Gen2 code into the project:

```text
Representation
Operation
Law
Trait
Capability
Runtime/Target
Diagnostic
Pass
```

Implement:

```ts
CType;
Expr;
Program;
Target;
```

and the compiler pipeline skeleton.

Rust codegen only needs enough to emit a compilable crate.

### Acceptance

This works:

```ts
const Add = C.fn([C.U64, C.U64], C.U64, (a, b) => C.U64.add(a, b));
```

but this is infrastructure validation, not the actual showcase.

---

# 15. Milestone 1 — Foldkit Entity Expr/Query as the first real compiler target

This should be the first meaningful compiler workload.

Take existing:

```text
foldkit-entity Expr
foldkit-entity Query
```

and compile them to a Rust evaluator.

Run existing conformance cases through:

```text
                  same query
                     │
         ┌───────────┼───────────┐
         ▼           ▼           ▼
     JS evaluate   Drizzle      Rust
         │           │           │
         └──── semantic parity ───┘
```

This validates:

```text
Schema → Rust type
Expr → Rust
operations
operation support checking
strings
nullability
ordering
vectors
structs
conformance infrastructure
Cargo compilation
```

without needing an Effect runtime.

This is better than spending the first compiler milestone on artificial arithmetic examples.

---

# 16. Milestone 2 — general compiled functions and Effect IR

Introduce:

```ts
C.fn;
C.Match;
C.Predicate;

C.Effect.succeed;
C.Effect.fail;
C.Effect.map;
C.Effect.flatMap;
```

Builder callbacks receive symbolic values.

No:

```text
if
switch
await
yield
for
while
```

inside compiled callbacks.

Add the **reference interpreter**:

```text
C.Effect IR
     ↓
actual Effect
```

Now every native feature can be differential-tested against Effect.

---

# 17. Initial ownership implementation

Do not attempt the full ownership research problem immediately.

Start conservatively:

```text
Copy primitives
    → by value

single-use owned values
    → move

read-only parameters
    → borrow

obvious exclusive local mutation
    → &mut

genuinely duplicated ownership
    → clone
```

No complex cross-fiber borrowing yet.

The important rule remains:

```text
move
 ↓
borrow
 ↓
share
 ↓
clone
```

not “clone everything.”

The full structured-concurrency lifetime analysis comes when fibers arrive.

---

# 18. Milestone 3 — unary Effect RPC

This is the first major public demo.

Goal:

```text
stock Effect RpcClient
        │
        │ JSON / HTTP
        ▼
generated Rust binary
        │
        ▼
compiled Effect handler
```

Reuse ordinary Effect RPC contracts.

Implement:

```text
Rpc.make / RpcGroup inspection
Schema request decoding
Schema success encoding
typed errors
async handlers
Services
basic Layer assembly
JSON
HTTP
```

Use:

```text
Tokio
Axum
Hyper
Serde
```

### Acceptance

An unmodified browser Effect RPC client successfully calls a Rust backend generated from TypeScript.

---

# 19. Middleware belongs in RPC early

Immediately after unary RPC, support semantic RPC middleware:

```text
authentication
authorization
CurrentUser
Tenant
RequestId
tracing metadata
```

Transport middleware remains Tower/Axum territory:

```text
CORS
compression
proxy headers
HTTP logging
```

Compile semantic middleware into direct request-context construction rather than maintaining dynamic Context lookup where possible.

---

# 20. Milestone 4 — native Foldkit RemoteServer

Now take the existing `foldkit-remote` wire protocol unchanged.

Implement native equivalents of `remote-server` behavior:

```text
requirement validation
field grouping
field authorization
ID deduplication
nested relationship traversal
normalization
query execution
mutations
connection changes
limits
```

Do not redesign semantics.

The existing TypeScript server becomes the reference implementation.

Initial Sources can be:

```text
in-memory
compiled service functions
```

### Acceptance

A normal Foldkit browser using existing:

```ts
Remote.clientLayer(...)
```

talks to the Rust backend with no native-specific client code.

---

# 21. Authorization must become portable

Existing arbitrary callback:

```ts
authorize: (principal, fields) => ...
```

is not inherently compilable.

Initially support one of:

```text
portable compiled C.fn
declarative authorization expression
known service implementation
```

Longer term, Foldkit-Plus itself should move semantically important authorization toward a description rather than arbitrary JavaScript.

That benefits all interpreters, not merely Rust.

---

# 22. Milestone 5 — native Query → SQLx

Do **not** port Drizzle.

Compile the existing semantic query representation.

```text
Query.define
    ↓
Query IR
    ↓
SQL planner
    ↓
SQL
    ↓
SQLx
```

Initially, existing Drizzle bindings can execute at build time to supply:

```text
table names
columns
SQL types
relations
primary keys
```

Rust only receives normalized storage metadata.

Avoid compiling arbitrary Drizzle callbacks.

Compatibility hierarchy:

```text
Query.define / Expr IR
    ✓ fully portable

static Drizzle schema/bindings
    ✓ extractable at build time

arbitrary Drizzle expressions/callbacks
    ✗ not native yet
```

### Acceptance

The same query passes:

```text
JS evaluator
Drizzle/SQLite or Postgres
Rust/SQLx
```

conformance.

---

# 23. Milestone 6 — streaming RPC + real interruption

Now introduce:

```text
Stream
Scope
CancellationToken
stream chunks
acks/backpressure
interrupt protocol
```

Native streaming shape:

```text
Effect Stream
    ↓
Rust Stream
    ↓
RPC chunks
    ↓
NDJSON initially
```

Cancellation:

```text
client stops stream
      ↓
RPC Interrupt
      ↓
CancellationToken
      ↓
handler fiber interrupted
      ↓
Scope closes
      ↓
resources finalize
```

This is the first point where serious Effect-specific native runtime semantics become necessary.

---

# 24. Native Scope runtime

Implement the smallest real native Effect runtime component:

```text
Scope

children
finalizers
Exit
cancellation
```

Rust `Drop` cannot run async cleanup, so Effect Scope requires explicit async closure/finalization.

Do not expand the runtime beyond what current milestones demand.

---

# 25. Milestone 7 — native Foldkit Remote live

Now Foldkit Remote's live APIs can sit on the streaming RPC work.

```text
Data.live(...)
     ↓
Remote planner
     ↓
Effect RPC stream
══════════════════════
Rust
     ↓
Native RemoteServer
     ↓
LiveHub / Source
     ↓
Tokio Stream
```

Implement:

```text
subscription tracking
cursor handling
changed/deleted
field-interest checks
re-authorization
minimal re-reads
normalized patches
```

Dropping a browser subscription should cancel and finalize the native subscription.

---

# 26. Milestone 8 — native Foldkit SSR

Compile only the server-reachable Foldkit graph:

```text
Request
  ↓
routing
  ↓
Flags
  ↓
init
  ↓
Model
  ↓
view
  ↓
HTML
```

Not:

```text
update
subscriptions
managed resources
DOM patching
browser commands
```

The browser remains normal Foldkit.

### Critical compatibility rule

Native rendering must emit Foldkit's **existing hydration protocol**.

The stock browser:

```ts
Runtime.hydrate(...)
```

must adopt native-generated HTML successfully.

---

# 27. HTML compilation

Initial:

```text
view
 ↓
Html IR
 ↓
String serializer
```

Then optimize:

```text
Html IR
 ↓
static fragment folding
 ↓
direct writes
```

Example:

```text
WriteStatic("<div><h1>")
WriteEscaped(model.name)
WriteStatic("</h1></div>")
```

Eventually stream directly to Hyper without building a full VDOM or giant intermediate string.

---

# 28. Milestone 9 — SSR + Remote `Data.satisfy` + resume

This is where the Foldkit stack becomes genuinely interesting.

Native request:

```text
route
 ↓
init
 ↓
active Surfaces
 ↓
Data requirements
 ↓
Data.satisfy
 ↓
Native RemoteServer
 ↓
SQLx
 ↓
populate Remote Model
 ↓
view
 ↓
HTML
 +
minimal resume payload
```

The browser hydrates with the data already known.

No initial duplicate fetch.

### Important optimization

During SSR:

```text
RemoteClient
   ↓
direct native RemoteServer invocation
```

No loopback RPC.

The browser later uses the same conceptual API over RPC.

---

# 29. First major showcase application

At this point build one real application:

```text
TypeScript source
────────────────────────
Foldkit
Foldkit Remote
Effect
Effect RPC
Effect Schema
Query definitions


           compile


Rust binary
────────────────────────
Axum/Hyper
Tokio
native Effect RPC
native Foldkit RemoteServer
SQLx
native Foldkit SSR


          Postgres


Browser
────────────────────────
ordinary Foldkit
ordinary foldkit-remote
ordinary Effect RpcClient
```

The Rust binary should serve:

```text
HTML
static assets
RPC
streaming Remote subscriptions
database access
```

This should be the project's first “this is real” demo.

---

# 30. Milestone 10 — SchemaBinary

Once semantic RPC compatibility is proven with JSON/NDJSON, implement native SchemaBinary.

Generate specialized codecs from schemas instead of interpreting arbitrary schema trees at runtime.

Test bidirectionally:

```text
Effect encode
    ↓ bytes
Rust decode

Rust encode
    ↓ bytes
Effect decode
```

and canonical byte equality where required.

This should likely become the preferred Effect↔Effect native transport eventually.

---

# 31. Milestone 11 — WebSocket + bidirectional RPC

Add persistent RPC sessions.

Session owns:

```text
connection Scope
active requests
active streams
pending reverse requests
notifications
outbound queue
serializer
```

Support:

```text
client → server RPC
server → client notifications
server → client RPC
two-way cancellation
streaming
```

Keep serialization and transport independent:

```text
RPC core
   ↓
Serialization
   ↓
Transport
```

so:

```text
WebSocket + JSON
WebSocket + SchemaBinary
TCP + SchemaBinary
HTTP + NDJSON
```

are combinations rather than different RPC systems.

---

# 32. Milestone 12 — broader Effect concurrency

Only now substantially expand:

```text
Fiber
Effect.all
race
fork/join
Semaphore
Ref
SynchronizedRef
SubscriptionRef
Deferred
Queue
PubSub
FiberRef
```

Use Tokio for mechanics.

Preserve Effect semantics with thin native adapters.

---

# 33. Structured concurrency ownership pass

Now upgrade ownership analysis with the actual scope/fiber graph.

Example:

```text
Scope A
├── config
├── child B reads config
└── child C reads config
```

If B and C are guaranteed to join inside A:

```rust
&config
```

may be enough.

If a child escapes:

```text
move
or
Arc
```

is required.

Introduce an explicit ownership IR:

```text
Move<T>
Borrow<T>
BorrowMut<T>
Shared<T>
Clone<T>
```

and let generated Rust act as the final ownership validator.

---

# 34. Ref specialization

Use type information to select:

```text
unique local state
  → let mut T

Ref<U64>
  → AtomicU64 when operations permit

structured Ref<T>
  → Mutex<T> / RwLock<T>

effectful synchronized mutation
  → async Mutex<T>
```

The compiler plan records and explains the choice.

---

# 35. Laws start enabling real optimization here

Examples:

```text
associative reduce
    → tree reduction allowed

associative + parallel-safe
    → parallel reduction

commutative
    → scheduling/order freedom

idempotent
    → safe dedup/replay in selected contexts

inverse
    → rollback generation

monotonic
    → incremental/live optimizations
```

Do not use laws for clever optimization until the conformance/evidence infrastructure is mature.

---

# 36. Milestone 13 — Cruster distributed profile

Now connect Effect Native to Cruster.

Capabilities:

```text
DistributedEntity
PersistedDelivery
Sharding
DurableWorkflow
DurableTimer
Singleton
ClusterCron
```

Compiler selects Cruster implementations when target configuration requests them.

Example:

```ts
Compile.withTarget(
  Rust.binary({
    distributed: Cruster.cluster({
      storage: "postgres",
      discovery: "etcd",
    }),
  }),
);
```

Potential mappings:

```text
Effect Cluster Entity
    → Cruster entity

persisted RPC
    → #[rpc(persisted)]

cluster stream
    → Cruster send_stream

scheduled message
    → send_at / notify_at

singleton
    → Cruster singleton

cron
    → ClusterCron

workflow
    → Cruster workflow

activity
    → Cruster activity

durable sleep
    → Cruster workflow timer

signal/deferred
    → Cruster durable deferred
```

Generate macro-based Cruster Rust first.

Direct lower-level Cruster integration can replace generated proc-macro syntax later if useful.

---

# 37. Cruster remains optional

A simple SSR application should depend on roughly:

```text
Tokio
Axum
Hyper
Serde
```

not:

```text
Tonic
Prost
etcd
workflow persistence
sharding
cluster runtime
```

Therefore Cruster is linked only if the Program capability graph requires it.

---

# 38. Milestone 14 — custom serialization and additional targets

Now introduce:

```text
custom native serializers
registered Rust libraries
WASM target experiments
native libraries
```

A custom serializer can have:

```text
reference implementation
native implementation
law/conformance tests
```

rather than arbitrary unverified code.

---

# 39. Milestone 15 — source syntax widening

Only after the IR/compiler is mature.

Add optional TypeScript source transformation so:

```ts
a + b;
```

becomes the same IR as:

```ts
C.U32.add(a, b);
```

and:

```ts
if (x) ...
```

becomes Match/branch IR.

Potentially:

```ts
const x = await foo();
```

becomes Effect sequencing.

And:

```ts
Promise.all([...])
```

can become native concurrency.

The Rust backend does not change.

Only another IR frontend is added.

---

# 40. Hybrid JavaScript target comes after native semantics are solid

Unsupported JavaScript can eventually be explicit host execution.

Users should still write:

```ts
string;
Promise<T>;
User;
```

not:

```text
Js.String
Js.Promise
Js.Object
```

The compiler internally tracks execution domain:

```text
Native
JavaScriptHost
ForeignFFI
```

A program requiring JS automatically targets:

```text
Node + native addon
```

rather than a standalone executable.

Do not silently fallback unsupported native code to JS.

The target change must be visible in `Compile.explain`.

---
