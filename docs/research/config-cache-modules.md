# Configuration, caching, requests and pools

Research checked 2026-10-02 against Effect **4.0.0-rc.118**. Downloaded primary sources for all seven modules match installed files byte for byte. This is a proposed admission design; no native APIs, nodes or crates are implemented here.

Prior work: [module coverage](../effect-module-coverage.md), [runtime substrates](../runtime-lowering.md#caches-pools-batching-schedules-and-streams), [static providers](context-layer.md), [resource registration](resource-scope-registration.md), [metadata costs](../metadata-cost.md) and [Schema profile](schema-profile.md). The bounded lexical Scope profile does not supply shared entry scopes, arbitrary child fibers or pool leases.

## Primary sources

- Effect [Config](https://cdn.jsdelivr.net/npm/effect@4.0.0-rc.118/src/Config.ts) and [ConfigProvider](https://cdn.jsdelivr.net/npm/effect@4.0.0-rc.118/src/ConfigProvider.ts): provider nodes/cursors, absent-input classification, schema decoding and source errors.
- Effect [Cache](https://cdn.jsdelivr.net/npm/effect@4.0.0-rc.118/src/Cache.ts) and [ScopedCache](https://cdn.jsdelivr.net/npm/effect@4.0.0-rc.118/src/ScopedCache.ts): entry fibers, awaiter counts, TTL and entry Scope closure.
- Effect [Request](https://cdn.jsdelivr.net/npm/effect@4.0.0-rc.118/src/Request.ts) and [RequestResolver](https://cdn.jsdelivr.net/npm/effect@4.0.0-rc.118/src/RequestResolver.ts): request entries, completion, grouping and caching.
- Effect [Pool](https://cdn.jsdelivr.net/npm/effect@4.0.0-rc.118/src/Pool.ts): reservation, per-item reference counts, invalidation, lease release and shutdown.
- Rust [vars_os](https://doc.rust-lang.org/std/env/fn.vars_os.html), [Moka async Cache](https://docs.rs/moka/latest/moka/future/struct.Cache.html), [deadpool managed pools](https://docs.rs/deadpool/latest/deadpool/managed/index.html) and [bb8 Pool](https://docs.rs/bb8/latest/bb8/struct.Pool.html). These pages were checked as substrate candidates, not pinned/admitted dependencies.

## Priority and dependency gates

| Order | Useful first workload                                             | Prerequisite                                                    | Admission boundary                                             |
| ----- | ----------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| 1     | Native server reads PORT/FEATURE at boot, validates before listen | Owned strings, checked scalar parsing, startup error projection | Explicit environment provider; immutable startup settings      |
| 2     | Repeated lookup in one invocation shares one completed result     | Checked key equality and state slots                            | Clearly named local memoization specialization, not full Cache |
| 3     | Two overlapping requests share one cache miss                     | Deferred/shared completion, supervised task cancellation, clock | Bounded Cache with explicit TTL/capacity/context policy        |
| 4     | Static independent requests form one backend batch                | Request identity and backend batch semantic contract            | Generated batch calls with proved result ordering              |
| 5     | Shared cached resource survives caller cancellation then closes   | Shared Scope ownership and awaited close                        | ScopedCache lifecycle adapter                                  |
| 6     | Two requests lease scarce resources through shutdown              | Cancellation-safe waiters, shared Scope, lease identity         | Pool adapter or direct policy layer for a native substrate     |

Config can ship before shared coordination. Cache/Pool work must not delay ordinary startup configuration or be advertised through Map-shaped wrappers that omit their semantics.

## Configuration observations and decisions

- Pinned constructors are capitalized: `Config.String`, `Boolean`, `Number`, `Int`, `Port`, `Redacted`; `Config.schema(codec, path)` goes through `Schema.toCodecStringTree`, not a generic string-to-number convenience parser.
- `Config.Boolean` uses literal strings `true/yes/on/1/y` and `false/no/off/0/n` via the pinned Schema transformation; substituting Rust Boolean parsing loses accepted values.
- `ConfigError` wraps either `ConfigProvider.SourceError` or `Schema.SchemaError`. Source failure, validation failure and absent input are distinguishable.
- `withDefault` handles absence, preserving validation/source failures. Group defaults can replace the entire group when a child is absent; defaulting each field has different behavior. `option` preserves successful `undefined` as Some when the schema admits it.
- `fromEnvRecord` builds a path trie; underscores support both direct and segmented lookup, numeric children support arrays, and empty strings are missing by default unless `preserveEmptyStrings` is true.
- `fromEnv` merges `process.env` and `import.meta.env`; native OS environment alone is a narrower source. Ordinary `Config` resolves a default environment-backed Context reference, while explicit `.parse(provider)` makes the source testable.

**CFG-001 — proposed startup profile.** Read an explicit environment snapshot once during generated server/executable initialization, before resources and listeners are acquired. Begin with flat explicit paths, String/Boolean/Number/Int/Port plus missing-only defaults and admitted record schemas. Bind successful settings into server-owned immutable services. Per-request rereads, hot reload, file/dotenv/network providers, arbitrary `mapEffect` and dynamic provider replacement remain refused. Revisit when a workload needs refresh or another source.

**CFG-002 — preserve provider/parser contracts.** Model provider/path normalization and admitted schema decoding separately. Generate checked parsing matching the pinned StringTree codecs; do not substitute Rust `parse` defaults. Begin with explicit `fromEnvRecord`-equivalent behavior and reject unsupported child discovery/path transforms. Snapshot through `vars_os`; reject invalid Unicode under a documented source-error projection instead of lossy conversion or panic. Native startup configuration is runtime data, never embedded by the TypeScript compiler or Cargo build. Revisit nested/array providers only after their complete node semantics have fixtures.

**CFG-003 — typed failure projection.** Define a checked ConfigError projection retaining source-versus-schema classification, field path and admitted issue kind. Missing-only defaulting depends on internal absence status, not matching error text. Stock error classes/prototypes, arbitrary issue trees and aggregate errors require separately admitted representation. Differential tests must settle exact admitted messages before claiming them; startup exits before listening on failure. Revisit richer issue trees with general Schema error support.

**CFG-004 — secrets need their own boundary.** `Config.Redacted` uses `Schema.Redacted(Schema.String)`. Plain native String cannot claim this contract: formatting, log annotations, wire encoding, diagnostics and generated artifacts can reveal it. Admit Redacted only with an opaque secret witness and explicit reveal operation plus redacted formatting/diagnostic policy; keep secrets out of source artifacts and environment-error payloads. A String payload needs no generic metadata sidecar, but secret storage/erasure is an independent type/security policy. Defer secret zeroization guarantees pending substrate research and tests; ordinary startup settings can ship first. Revisit when connection/auth configuration requires secret inputs.

## Cache observations and decisions

- `Cache.make`/`makeWith` default TTL to infinity; TTL callbacks receive Exit and key, allowing different failure/success lifetimes.
- Cache hits refresh insertion order; capacity removes oldest entries. Expiry uses the Effect clock and `now >= expiresAt`; finite TTL starts when lookup completes, not when lookup begins. Interrupted lookups are removed, while ordinary failures can be cached.
- Each in-flight entry owns a lookup fiber and awaiter count. The last departing waiter interrupts an unfinished lookup; one cancelled follower must not cancel another follower's result.
- Plain `Cache.invalidate` removes a map entry without itself interrupting its lookup fiber; ScopedCache invalidation also owns entry Scope closure. These operations must not share one unqualified drop/cancel adapter.
- `refresh` creates another lookup while an existing unexpired entry can remain readable; completion updates the entry. Invalidation/completion races require matching the actual source, not an assumed generation policy.
- Construction captures Context; `requireServicesAt` changes the type-level lookup-versus-construction service requirement. Captured and invoking contexts are merged, so authorization-sensitive caching cannot silently ignore invocation context.

**CACHE-001 — distinguish local specialization.** A per-invocation memo slot for a known deterministic lookup may erase dynamic machinery only when key/value witnesses, lifetime, failure policy and invocation count prove equivalence. It is not an exported full Cache. Never move authorization-dependent results across requests by optimization. Revisit public Cache after the shared-completion profile is verified.

**CACHE-002 — explicit shared state machine.** First real Cache admission needs keyed pending/completed entries, typed exits, cancellation-safe waiter counts, TTL clock input, capacity ordering and identity-checked updates. Scalar/string keys require verified equality/hash adapters; Rust HashMap equality is not automatically Effect equality. Use owned native entries/handles, not metadata attached to keys or results. Specify context precedence and cache ownership (invocation/server) in the implementation registry. Revisit richer keys after Equal/Hash semantics are admitted.

**CACHE-003 — prefer smallest verified substrate.** Generated native Map plus bounded ordering/completion state is the baseline for a narrow profile. Moka is a candidate only where its eviction, admission, expiry, failure and cancellation policies can satisfy the selected Effect adapter; convenient coalescing alone is insufficient. Reject approximate capacity/eviction behavior where observable inspection/order is admitted. Pin and benchmark a substrate before adding it; pure functions must never depend on it. Revisit when measured throughput/maintenance justifies replacing generated storage.

**CACHE-004 — ScopedCache owns entry lifetimes.** Pinned ScopedCache creates an entry Scope and closes it on expiry/replacement/invalidation/eviction or parent shutdown; closed-cache reads interrupt. It shares lookup exits but does not itself establish a consumer lease protecting returned resources after invalidation. Do not add inferred lease safety or map eviction onto arbitrary dropped Arcs. Verify in-flight scope closure, cancelled waiters and cleanup defects before admission; the current bounded registration ceiling cannot represent arbitrary dynamic entries. Revisit after shared/child Scope and finalizer failure policies are settled.

## Request and resolver observations and decisions

- Requests have typed success/error channels, a request identity/equality contract and runtime Entry completion. They are not merely RPC payload structs.
- `makeWith` supplies `batchKey`, delay, `collectWhile`, optional `preCheck` and `runAll(entries, key)`. Backend completion must account for each entry.
- `fromFunctionBatched` assigns output values positionally to entries. Grouping and batch-size limits do not establish arbitrary reorder-safe association; a checked backend adapter must state its ordering/cardinality guarantees.
- `withCache` caches completed successes and noninterrupted failures with LRU/FIFO and no TTL; `asCache` delegates to Cache and its TTL/service requirements. These are distinct policies.

**REQ-001 — static batching first.** Fuse statically independent requests only with evidence for request equality, resolver identity/context, backend grouping, ordering, cardinality and observable effect/failure behavior. Sequential effectful requests cannot be batched merely because their argument shapes match. Generate a concrete batch invocation plus checked scatter; retain typed per-request exits. Revisit dynamic batching when overlapping suspended requests require collection windows.

**REQ-002 — dynamic resolver admission requires completion semantics.** A shared collector needs per-entry completion, delay/clock, grouping, bounded scheduling and cancellation/listener ownership. Define how cancelled entries affect the batch and other consumers; unresolved or multiply completed entries require pinned-oracle evidence. Do not export a RequestResolver wrapping `forEach`. Keep pure request data separate from runtime entries and diagnostic IDs; revisit after Deferred/Queue/fiber supervision gates.

## Pool observations and decisions

- `Pool.make({ acquire, size, concurrency?, targetUtilization? })` is scoped; each item may support multiple simultaneous leases, default concurrency one.
- `Pool.get` registers return bookkeeping in the caller's Scope. Returning a lease differs from closing its resource; an invalidated item closes after its outstanding references permit it.
- Shutdown marks the pool closed, releases idle items, waits for borrowed items/finalizers and wakes pending waiters. Acquisition, waiter cancellation and resizing use masks and synchronization.
- Elastic TTL adds creation/usage lifetime policy. Pool finalization order is unspecified, so bracket LIFO order must not be imposed on pool items.

**POOL-001 — verify lease ownership before generic pooling.** Begin with fixed capacity, one lease per item, concrete acquisition error, explicit invalidation and awaited owner shutdown. This is a declared profile refusing configurable utilization/concurrency/elastic TTL until proven. Shared lease handles contain resource identity and release state; native payloads carry no generic metadata. Require an exactly-once lease-return path for success/failure/interruption, no waiter leak, and no resource-close-before-last-lease bug. Revisit broader policies on a scarce-resource workload.

**POOL-002 — substrate policy is separate.** Use SQLx's pool directly for a SQL service when that service declares SQLx semantics; do not advertise Effect.Pool parity from that choice. deadpool/bb8 can provide acquisition/recycle machinery for a generic adapter only after return, invalidation, fairness, capacity, failure, TTL and shutdown obligations match. Generated bounded policy plus Tokio synchronization may be smaller for the first admitted Effect profile. Pin candidates and compare dependency/build/runtime costs before selection.

## Decisions to settle before implementation

- Before Config code: choose the exact provider/path subset and startup initialization hook; settle ConfigError projection and missing-input classification with an oracle corpus.
- Before Redacted code: establish secret reveal/formatting/codec rules; source maps and logs must never serialize secret literals or error inputs accidentally.
- Before shared Cache code: settle native clock abstraction, Equal/Hash profile, parent ownership, Context merge policy and cancellation-safe shared completion.
- Before ScopedCache code: admit shared entry Scope close and cleanup-error behavior; determine which upstream version/profile is authoritative.
- Before RequestResolver code: establish batch completion and backend result association contracts; choose whether the first workload actually requires a collection window.
- Before Pool code: admit shared owner/borrower lifetimes and waiter cancellation; choose fixed-capacity policy or a separately named service substrate.

The portable first Config workload should bind a checked port and feature flag before creating the server Layer. A cache workload should then expose a gated scalar lookup shared by two overlapping requests. Resource-bearing cache entries and capacity-one pool leases follow only after shared lifetime admission. These are proposed workload boundaries, not API spellings or executable demos.

## Acceptance workloads and cost gates

1. Config: same captured input record through official `.parse(fromEnvRecord(...))` and native startup; absent/empty/invalid values, Boolean literals, numeric boundaries, Unicode, defaults, source errors and field ordering. Verify no listener/resource acquisition on invalid settings and no secret text in any enabled/disabled diagnostic artifact.
2. Cache: controlled clock and gated lookup; two same-key callers start one acquisition, cancel one then all, cache typed failures, compare zero/infinite/boundary TTL, capacity refresh order and invalidate/refresh races. Compare traces and inspection results, not throughput alone.
3. ScopedCache: tracked resource IDs and gated finalizers; expire/invalidate/evict during pending and completed lookup, close owner during suspension, read closed cache, and verify awaited cleanup/defect outcomes against the pinned oracle.
4. Resolver: duplicates/equal/distinct requests, grouping, cardinality/refusal, reordered backend results, partial failure, cancelled batch members, completion twice and uncompleted entries. Static batching requires an unfused official baseline.
5. Pool: capacity-one overlapping leases, interrupted waiters/acquisition/use, invalidation while borrowed, failed replacement, owner close with pending leases and awaited finalizers. Elastic TTL and concurrency greater than one get separate gates.

Measure reachable crates, generated code/binary size, build time, entry/lease layout, allocation on miss/hit/wait, retained keys/results, and shutdown memory. Configuration should allocate its snapshot/settings once at startup; cache entries and pool resources necessarily own lifecycle state, not per-scalar annotations. Disabled logging/frames must add no diagnostic entry fields, retained provenance graphs or exporters; benchmark separately from unavoidable synchronization/secret storage. No performance result is established by this research.
