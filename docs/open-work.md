# Open work register

Everything still to be done, collected from the design and research records on 2026-10-03. Each line links the record that owns the decision; that record stays authoritative for scope, evidence and acceptance. This page is an index for choosing work, not a plan: [PLAN.md](../PLAN.md) sets the order.

**Maintenance.** When work is deferred, refused for later or left open, add a line here as well as in its record. When it is done, delete the line and record the result in [PROGRESS.md](../PROGRESS.md). Observable differences from official Effect/Foldkit belong in [native divergences](native-divergences.md); their fixes are listed below under [Divergence fixes](#divergence-fixes). Items marked _(verify)_ may already be covered by delivered work whose record was not updated.

**Contents:** [Frontier](#frontier) · [Future milestones](#future-milestones-615) · [Cross-cutting gates](#cross-cutting-gates) · [RPC](#rpc) · [Remote](#remote) · [SSR and migration](#ssr-html-and-migration) · [Effect modules](#effect-modules) · [Scope, resources and concurrency](#scope-resources-and-concurrency) · [Types and Schema](#types-and-schema) · [Kernel, R language and emission](#semantic-kernel-r-language-and-rust-emission) · [Observability and source maps](#observability-source-maps-and-metadata) · [Tooling](#compiler-api-editor-and-migration-tooling) · [Divergence fixes](#divergence-fixes) · [Performance](#performance-and-measurement) · [Distributed](#distributed-cruster) · [Upstream](#upstream-foldkit-plus-issues) · [Hygiene](#repository-and-document-hygiene) · [Context only](#context-only-not-commitments)

## Frontier

- `examples/todo-remote` on SQLite/Postgres (it toggles through `get` since RS-007) ([remote-mutations](research/remote-mutations.md#rs-007-reading-stored-rows-2026-10-03))
- Milestone 6 ([streaming-rpc](research/streaming-rpc.md#order-of-work-and-acceptance)): steps 1–4 done. Remaining:
  - `ensuring` beyond the outermost operator;
  - finalizers that read the stream function's inputs in `Reference.stream`;
  - `fromSchedule` beyond `spaced`;
  - `mapEffect`/`runForEach`;
  - a backpressure test with a slow reader

## Future milestones 6–15

- M6: streaming RPC — Stream to Rust stream to NDJSON chunks, acks/backpressure, interrupt protocol, cancellation ([§23](implementation-milestones.md#23-milestone-6--streaming-rpc--real-interruption), [rpc-protocol](rpc-protocol.md#streams))
- M6 companion: native Scope runtime — children, finalizers, Exit, cancellation ([§24](implementation-milestones.md#24-native-scope-runtime))
- M7: Remote live — subscriptions, cursors, changed/deleted, field interest, re-authorization, minimal re-reads, patches, cancel on drop ([§25](implementation-milestones.md#25-milestone-7--native-foldkit-remote-live), NR-006; [remote-live](research/remote-live.md#order-of-work-and-acceptance): the hub on memory and SQL, the Live procedure, authorization and the stock client are delivered. Remaining: live rendering in the `todo-remote` browser app, which needs per-item `Data.live` projections. Per-entity `RemoteServer.live` sources are deferred)
- M8A: hand-authored R native SSR matching `renderToString` and hydrating with the stock client, designed in [native-ssr](research/native-ssr.md#order-of-work-and-acceptance) (SSR-001..008: escaping and markers, `R.Html`, native rendering, hydration, page serving; steps 1–5 delivered (escaping and markers, `R.Html` with reference views, byte-equal native rendering, stock-client hydration, page serving as `handleRequest`); remaining: the todo example's first screen (step 6), pages that read the request (URL, routing, Flags), static renders, lang/dir/canonical, `R.Result` value-type inference that an editor TypeScript rejects; open questions resolved as SSR-009..012: data-first `R.Html` mirroring `h`, per-variant reference-only Messages, `happy-dom` 20.14.5 for headless hydration, `R.Number.toString` via `ryu-js`); M8B: mechanically transformed upstream SSR under the same acceptance ([§26](implementation-milestones.md#26-milestone-8--native-foldkit-ssr))
- M8 companion: HTML compilation — Html IR, serializer, static folding, direct writes, streaming to Hyper ([§27](implementation-milestones.md#27-html-compilation))
- M9 remaining:
  - Reads a second `satisfy` pass would add (a Surface waiting on another's data) are not planned for native pages ([M9-3](research/ssr-data.md#m9-3-plan-agreed-2026-10-03)).
- Showcase: `examples/todo-fullstack`, one binary serving pages, assets, RPC, Remote live and SQLx/Postgres ([§29](implementation-milestones.md#29-first-major-showcase-application), [conformance](conformance-and-diagnostics.md#46-first-concrete-target))
- M11 open: server notifications and reverse RPC, deferred until Effect gives the stock client a way to receive them (WS-001, [websocket-rpc](research/websocket-rpc.md)). The WebSocket transport is delivered for NativeRpc, NativeRemote and the showcase
- M12: broader concurrency — Fiber, fork/join, Semaphore, SynchronizedRef, SubscriptionRef, Deferred, Queue, PubSub, FiberRef ([§32](implementation-milestones.md#32-milestone-12--broader-effect-concurrency)); companions: ownership IR ([§33](implementation-milestones.md#33-structured-concurrency-ownership-pass)), Ref specialization ([§34](implementation-milestones.md#34-ref-specialization)), law-enabled optimization ([§35](implementation-milestones.md#35-laws-start-enabling-real-optimization-here))
- M13: optional Cruster distributed profile ([§36](implementation-milestones.md#36-milestone-13--cruster-distributed-profile))
- M14: custom serializers, registered Rust libraries, WASM experiments ([§38](implementation-milestones.md#38-milestone-14--custom-serialization-and-additional-targets))
- M15: source syntax widening; then the hybrid JS target ([§39](implementation-milestones.md#39-milestone-15--source-syntax-widening), [§40](implementation-milestones.md#40-hybrid-javascript-target-comes-after-native-semantics-are-solid))

## Cross-cutting gates

- Typed Deferred cancellation can retain errors across a Never recovery channel: prove carrier reachability and task-wrapper outcome bounds beyond declared child E before admission ([TURN-012](research/deferred-turns.md)).
- Compound fallible All/Race RPC wire causes, interruptor identities/reason annotations, and retained earlier-channel errors: NativeRpc refuses this new profile pending stock-client conformance ([fallible concurrency](research/fallible-concurrency.md#host-integration-decision)).
- Broader lexical Deferred/Semaphore ownership, waiter storage and scheduler profiles beyond the admitted bounded Deferred subset; extend independent waiter cancellation, registration-ordered continuation turns (including reentrant completion), wake/cleanup routing and automatic-yield evidence before widening admission ([lexical coordination](research/lexical-coordination.md)).

These block many items below.

- Broader represented Exit/Cause (defects, explicit interruption values, full identity/annotations and async capture) — scalar fallible task propagation is delivered; fallible/Exit-aware finalizers, Deferred full-Cause completion and defect-finalizer parity remain gated ([structured-concurrency](research/structured-concurrency.md#why-typed-failure-is-deferred), [runtime-lowering](runtime-lowering.md#what-remains-in-the-semantic-runtime))
- Explicit child/Fiber handles and coordinator ownership — next gate before any suspending coordination module ([coverage](effect-module-coverage.md#priority-waves-and-hard-acceptance-gates), COORD-001)
- Named calls: callable `R.fn` with a hidden `Call(FunctionRef)`, lazy bodies, call graph/SCCs, tail analysis, self-tail loops and mutual-tail state machines; promote to a researched plan first ([r-language RT-1..4](r-language.md#rt-1--callable-functionref), [function-calls](research/function-calls.md#recommendation), D1)
- Ownership inference beyond primitive copy and single-use moves: borrows, `&mut`, clone elimination; composite witnesses are never Copy (REC-004) ([milestones §17](implementation-milestones.md#17-initial-ownership-implementation), [records-unions](research/records-unions.md#implementation-decisions))
- Typed error unions in error channels (e.g. `RemoteReadError | RemoteProtocolError`) and explicit union injection (ERR-003, RESULT-003) ([records-unions](research/records-unions.md#open-questions), [error-recovery](research/error-recovery.md#decisions))
- Coverage revisit triggers COVERAGE-001..006: function-level compatibility report, sharing representation before cross-task Ref aliasing, oracle substitution for nondeterminism, coordination contracts, justified Arc/boxing/buffers, stable Remote differential harness ([coverage](effect-module-coverage.md#provisional-decisions-and-revisit-triggers))
- Wave-gate questions: atomic Ref ops on non-Copy composites, cancellation-safe handle moves, Queue `Done`/failure representation, Deferred full-Cause completion, task-local context inheritance, upstream fairness promises, deterministic Clock suspension, random distribution ([coverage](effect-module-coverage.md#provisional-decisions-and-revisit-triggers))

## RPC

### Unary core

- Bound failure-frame vector growth during accumulation (storage stops at 32) ([unary-rpc](research/unary-rpc.md#acceptance-and-following-work))
- CORS, compression, TLS, proxy headers, request logging as Tower/Axum transport middleware ([unary-rpc](research/unary-rpc.md#native-http-slice-preparation-2026-10-01), [rpc-protocol](rpc-protocol.md#middleware))
- Graceful draining of in-flight requests and shutdown deadlines, instead of interrupting (SL-004) ([server-layer](research/server-layer.md#deferred))
- Install validated transport metadata as request services and carry it into spans ([unary-rpc](research/unary-rpc.md#native-slice-results-and-public-boundary))
- Exact Effect formatter text for all malformed-payload diagnostics (only range and unknown-tag are exact) ([unary-rpc](research/unary-rpc.md#native-slice-results-and-public-boundary))
- Notifications and control messages (only unary `Request` is admitted) ([unary-rpc](research/unary-rpc.md#native-http-slice-preparation-2026-10-01))
- Concurrent dispatch of a batch within one HTTP request ([async-rpc](research/async-rpc.md#chosen-boundary-and-alternatives))
- Cleanup on process crash, panic or task abort; interruption-frame oracle ([async-rpc](research/async-rpc.md#implementation-and-observed-conformance))
- Heartbeat: console/stdout compilation, per-loop allocation measurement, a real OS Ctrl-C test ([heartbeat](research/heartbeat.md#delivered-evidence))
- Demos not yet built: concurrent handlers (`Effect.all`, Ref/Semaphore), a general RPC handler over a compiled SQL service (designed in [sql-service](research/sql-service.md#order-of-work-and-acceptance); Postgres, transactions and statement helpers follow) ([rpc-mvp](rpc-mvp.md#id-make-rpc-the-driver-for-the-whole-roadmap))

### Auth and middleware

- General middleware composition (requires/provides/errors) beyond one bearer adapter per procedure ([rpc-auth](research/rpc-auth.md#runtime-credentials-and-ownership))
- Request services (Tenant, Permissions, RequestId, TraceSpan), rate limiting, error mapping ([rpc-protocol](rpc-protocol.md#middleware), [milestones §19](implementation-milestones.md#19-middleware-belongs-in-rpc-early))
- Production identity: JWT verification, sessions, revocation, an identity provider ([rpc-auth](research/rpc-auth.md#runtime-credentials-and-ownership))
- Principal types other than the `u64` bearer profile (RM-004a) ([native-remote](research/native-remote.md#milestone-4-status-2026-10-03))
- Fully constant-time credential checks (token length and entry count are observable) ([rpc-auth](research/rpc-auth.md#runtime-credentials-and-ownership))
- A protected procedure cannot also bind services (`bindServices` with `bindPrincipal`) _(verify)_ (SL-002) ([server-layer](research/server-layer.md#delivered-implementation))

### Server Layers

- Service objects/methods, non-scalar services, per-request with server layers, concurrent merge, `Layer.launch` for non-RPC executables ([server-layer](research/server-layer.md#deferred))

### Protocol and transports

- NDJSON HTTP streaming (M6), WebSocket sessions (M11), notifications and reverse RPC (WS-001), raw TCP, custom serializers with JS fallback (M14), one transport interface over HTTP/WebSocket/TCP/Worker/in-memory ([rpc-protocol](rpc-protocol.md#one-common-transport-interface))
- SchemaBinary: re-probe request-level defects when [Effect-TS/effect#8826](https://github.com/Effect-TS/effect/issues/8826) is fixed, and drop SB-REQUEST-DEFECT if the fixed bytes match ([schema-binary](research/schema-binary.md#progress))
- Showcase sequence: streaming `WatchTodos` over NDJSON with auth, Scope, SQLx and cancellation, then WebSocket + SchemaBinary ([rpc-protocol](rpc-protocol.md#how-i-would-sequence-these-features))

## Remote

### Engine

- Per-entity live sources ([remote-live](research/remote-live.md#order-of-work-and-acceptance))
- Live review fixes ([review](research/remote-live.md#review-2026-10-03)):
- Live improvement plan ([plan](research/remote-live.md#improvement-plan-2026-10-03)):
  - LIVE-011: typed, domain-checked signals;
  - LIVE-013: randomized hub conformance against upstream `liveHub`;
  - LIVE-014: the written boundary between R policy and ported protocol engines, with the long-term path of the hub in R.
- Live design debts ([review](research/remote-live.md#review-2026-10-03)):
  - LR-5: a separate `LiveHub` node or requirement;
  - LR-6: check signal entity and field names against the domain;
  - LR-9: `ryu-js` cursor text;
  - LR-10: timing-robust tests;
  - LR-11: lower literal field lists directly;
  - LR-12: fault-injection checks of the live tests.
- Domain-specialized engine — entity/field enums, selection bitsets, generated dispatch — replacing the literal port (NR-001, R-3); later an engine authored in R (R-1) ([native-remote](research/native-remote.md#options))
- Compiled R entity read sources beyond memory and SQL _(verify)_ (NR-005) ([native-remote](research/native-remote.md#decisions-proposed))
- Declarative authorization rule as an alternative to compiled `authorize` functions; upstream portable authorization ([foldkit-remote](foldkit-remote.md#authorization-should-probably-move-in-the-same-direction), [milestones §21](implementation-milestones.md#21-authorization-must-become-portable))
- The authorization test keeps a vendored memory read, because `RemoteServer.memory` takes no per-entity `authorize`; ask upstream for that hook or build the auth oracle another way ([fixture](../packages/reffect/tests/fixtures/foldkit-remote-memory.ts))
- Open question: may native `entities` order differ where the client cache ignores order? ([native-remote](research/native-remote.md#open-questions))
- Query inputs beyond Structs of primitives; checked finite numeric inputs (NR-015) ([native-remote](research/native-remote.md#query-design-step-3-accepted-2026-10-02))
- Query sources get no principal in the memory profile (RM-004c) ([remote-mutations](research/remote-mutations.md#rm-004ab-as-implemented-2026-10-03))
- Repeatable browser acceptance (the Chrome run of `todo-remote` was manual) ([native-remote](research/native-remote.md#milestone-4-status-2026-10-03))

### Mutations and store

- Open question: encode mutation outputs natively through `Output`'s JSON codec, or require R to produce the encoded form? (RM-001) ([remote-mutations](research/remote-mutations.md#open-questions))
- Concurrency policy for non-SQL async sources (RS-004) ([remote-mutations](research/remote-mutations.md#open-questions))
- `Schema.Number` and `Schema.optional` in mutation schemas; numbers in outputs (RM-001) ([remote-mutations](research/remote-mutations.md#mutations-as-implemented-2026-10-03))
- Store writes take Struct values only (RS-001) ([remote-mutations](research/remote-mutations.md#typed-values-refined-2026-10-03))
- A `SchemaError` representation, so `decodeUnknownOption`'s `None` can be told apart from an absent row, and `decodeUnknownEffect` admitted (RS-007) ([remote-mutations](research/remote-mutations.md#rs-007-reading-stored-rows-2026-10-03))
- Exercise native number formatting in connection identities over the wire; non-portable connection inputs (RM-005) ([remote-mutations](research/remote-mutations.md#connection-changes-as-implemented-rm-005-2026-10-03))

### SQL

- `many`, inverse-one, `manyToMany`, computed relations and counts (SQLX-003) ([sqlx-remote](research/sqlx-remote.md#decisions))
- Drizzle callbacks: `visible`, relation `where`/`orderBy`, query-source callbacks, counts with `where` (SQLX-003)
- Numeric ids and foreign keys ([sqlx-remote](research/sqlx-remote.md#order-of-work))
- Nullable sort columns on Postgres, where upstream's keyset predicate is correct (SQLX-014) ([sqlx-remote](research/sqlx-remote.md#decisions-1))
- TLS to the database (`tls-rustls-ring-webpki`), with the first deployment (SQLX-015)
- More column types: `real`, `char`, Postgres enums, numeric/bigint strings, dates, json, arrays, uuid (SQLX-010)
- Serialization-failure retry policy; none today (SQLX-012)
- Untested edges: fractional input against an integer column, NUL text on Postgres, a written value of another JSON type than its column ([sqlx-remote](research/sqlx-remote.md#known-edges-not-tested))
- A backend-neutral storage-binding IR separate from Drizzle; automatic recognition of Drizzle-backed sources ([foldkit-remote](foldkit-remote.md#what-happens-to-the-drizzle-schema))

### Query evaluator

- Unicode collation, structured-value equality, automatic domain encoding ([foldkit-query](research/foldkit-query.md#semantics-and-boundaries))
- Upstream's Postgres SQL still folds `contains` by collation while its evaluator folds ASCII only; a candidate upstream issue, not filed ([foldkit-plus-issues](research/foldkit-plus-issues.md#resolution-all-fixed-in-foldkit-plus-0140-checked-2026-10-03))

## SSR, HTML and migration

- Native Foldkit SSR target: Flags → init → view → HTML, compiled routing, exact hydration markers and build ID, stock `Runtime.hydrate` ([foldkit-ssr](foldkit-ssr.md#what-actually-has-to-compile))
- Native view profile; `Foldkit.ssr`/`ssg`/`native(app)` API; VDOM-free static folding; streaming HTML into Hyper ([foldkit-ssr](foldkit-ssr.md#wed-need-a-native-compatible-foldkit-view-profile-initially))
- Per-function server reachability in the SSR inventory (only per-module measured) ([inventory](research/foldkit-ssr-inventory.md#limits-of-the-measurement))
- Closure conversion QC-0..QC-5: Oxc analyzer, boundary registry, pure and Effect callbacks, SSR closure report, helper lifting; mutable-capture analysis; capture regression corpus ([qwik-closure-conversion](research/qwik-closure-conversion.md#qc-0--analyzer-foundation))
- M8B migration targets the tiny R core plus user-land expansions (RT-8) ([r-language](r-language.md#rt-8--migration-integration))
- M8B ([research](research/ssr-codemod.md)) is delivered for the pinned `examples/ssr`. Open:
  - `InnerHTML` with markup, which needs an HTML parser;
  - non-literal `Tabindex`;
  - translator coverage beyond the pinned source, added as workloads need it.

## Effect modules

Per-module scope and refusals are in the [module decision index](effect-modules.md) and the [coverage inventory](effect-module-coverage.md#complete-core-namespace-inventory).

- **Effect core:** JS callbacks/generators, arbitrary async; `catchIf` refinement overloads and optional `orElse`; Cause ancestry on re-fail (new IR primitive); retained handled-error ancestry; combinator allocation benchmark (EFF-003, ERR-001..006) ([effect-combinators](research/effect-combinators.md#decisions), [error-recovery](research/error-recovery.md#decisions))
- **Exit/Cause:** runtime mixed Fail/Die/Interrupt causes, async capture, annotations, equality/combine and effect branding; specialized inline/small-buffer reasons if costs justify it (EXIT-001..006). Fail-only values and synchronous capture are delivered ([exit-cause](research/exit-cause.md)); child handles and fallible tasks still depend on runtime Cause ([gates](#cross-cutting-gates)).
- **Option:** nullable conversions, throwable getters, iterable/product/Do/generator helpers, equality/order helpers, `Schema.Option` branding/`isOption`, heterogeneous/effectful match callbacks, dedicated `Option<T>` layout, witness interner ownership, native layout measurement (OPTION-001..005) ([option-module](research/option-module.md#deferred-surface))
- **Result:** generators, validation accumulation, arbitrary error unions, runtime branding/predicate interop, specialized layout, Never-channel widening, heterogeneous `flatMap` errors, composite CLI/RPC codec (RESULT-001..003) ([result-module](research/result-module.md#implementation-evidence))
- **Duration:** runtime witness and arithmetic; fractional/nanosecond/infinite sleeps; fresh native timer runs (DURATION-001..003) ([duration-module](research/duration-module.md#decisions-recorded-before-implementation))
- **Schedule:** fixed cadence, jitter, `upTo` by duration, `while`/`until`, combinators, schedule output from `repeat`; cron/jitter state machines (SCHED-001/002) ([schedule](research/schedule.md#deferred))
- **Array/Record/collections:** early-terminating checked search, `Record.get` (now unblocked by Option) and constructors, `filterMap`, index access, sorting/order, `append`/`concat`, non-empty types, `Chunk`, refinement signatures, allocation counts (COL-001..004, RECJS-002) ([collection-combinators](research/collection-combinators.md#decisions-recorded-before-implementation), [arrays](research/arrays.md#deferred))
- **Struct/Match/Predicate:** wider Struct utilities, unified `R.Match` over Bool/Option/Result/unions/literals (RT-5) ([r-language](r-language.md#rt-5--match-investment))
- **Scalars:** Boolean/Number/BigInt/String beyond partial witnesses; BigDecimal precision profile ([coverage](effect-module-coverage.md#complete-core-namespace-inventory))
- **Traits and hashed collections:** Order/Equivalence/Equal/Hash/Combiner/Reducer as checked traits; HashMap/HashSet/Trie/Graph (no Rust hash order); JsonPatch/JsonPointer/Optic/RegExp/Symbol ([coverage](effect-module-coverage.md#complete-core-namespace-inventory))
- **Brand/Data/Redacted:** missing; redaction before observability expands ([coverage](effect-module-coverage.md#complete-core-namespace-inventory))
- **TypeScript DX:** `R.Struct.get(R.Struct.get(x, "a"), "b")` passed straight to a typed parameter (e.g. `R.Boolean.not`) infers `never`, because the contextual return type flows into the inner `dual` call; binding the inner value to a `const` works. Reordering the overloads does not help ([sources.ts](../examples/todo-remote/sources.ts))
- **Function/flow:** `R.flow` over `Expr`/`Computation`, requirement unions, per-component frames, CSE/folding, composition size measurement ([flow-composition](research/flow-composition.md#open-questions))
- **Ref family:** owned composite snapshots, escaping/service/cross-request refs, effectful updates, atomic cross-task updates, capture by finalizers/children, `Rc<RefCell>`/Arc/atomic profiles, layout measurement; MutableRef, SynchronizedRef, SubscriptionRef (REF-001..006) ([ref-module](research/ref-module.md#accepted-bounded-decisions))
- **Clock/Random:** nanosecond accessors (blocked on checked signed bigint), range helpers with exact rounding (RANDOM-004), live Random backend, `withSeed` ISAAC port and pre-gates (RANDOM-002/003), virtual-time Sleep and observer-clock parity (CLOCK-004), cross-task driver sharing, defect-finalizer parity, cost measurement, separate Crypto randomness ([clock-random-modules](research/clock-random-modules.md#decisions-recorded-before-implementation))
- **Deferred extension:** bounded standalone authoring/compiler admission and owned `DeferredExecution` are delivered ([public execution](research/deferred-public-execution.md), [admission](research/deferred-public-admission.md)). Remaining: RPC/context integration, richer completion outcomes, compiler/target drift, referenced/retained heap and peak compiler/construction memory budgets, wider captures/inputs, callback-started groups, nested All and deeper/multiple Race. Structural/text/module/emitted Rust limits and exact-root native layout code-generation checks remain enforced; source emission and cargo check do not prove native layout admission.
- **Helper captures:** ordinary helper signature pruning, runtime-context/turn argument elimination and memoized free-reference summaries remain separate optimizations; private capture selection preserves full lexical scope and currently has bounded quadratic compiler traversal ([HCAP-001–004](research/helper-captures.md)).
- **Retained outcomes:** compound RPC wire conformance, composite changed-error payload representation and four-failure capacity before nested coordination ([shared analysis](research/retained-outcomes.md), [host boundary](research/retained-outcomes-host.md), [ownership audit](research/deferred-ownership.md)).
- **Coordination (Wave 2):** bounded standalone Deferred and scoped Semaphore are delivered. Bounded public Latch, audited operation receipts and owned execution are delivered ([LPUB](research/latch-public-admission.md), COORD-004); richer outcomes, mixed timers, child yields, cleanup Await, request embedding and shared owners remain open. Semaphore queued-yield/mixed-timer profiles, manual permits (COORD-005/006), PartitionedSemaphore, broader ownership, barrier harness and cost gates (COORD-007) remain open ([coordination-modules](research/coordination-modules.md#implementation-checklist-by-admission-gate)).
- **Queue/PubSub (Wave 3):** private bounded Queue protocol plus typed lexical IR/Done witness and official reference delivered ([QBF](research/queue-bounded-foundation.md), [QIR](research/queue-lexical-ir.md)); private borrowed continuation bridge, scoped retirement, synchronous interruption and managed asynchronous cleanup/host cancellation delivered ([QCB](research/queue-continuation-bridge.md), [QOWN](research/queue-driver-ownership.md), [QINT](research/queue-interruption-settlement.md), [QASYNC](research/queue-async-settlement.md)); private checked offer/take All2 lowering is delivered ([QGEN](research/queue-generated.md)); checked default-scheduler operation receipts, Done/shutdown retained outcomes, generated finalizer/frame/owned-execution evidence and public admission remain open. Reconcile pinned4.0.0 with the already-fixed upstream reentrant shutdown defect QBF-UPSTREAM-001 before admission; no further report needed. Dropping/sliding, rendezvous, richer errors/batches, PubSub rings/cursors and termination algebra remain separate ([CHAN](research/channel-stream-modules.md#decisions-and-alternatives)).
- **Stream/Sink/Channel (Wave 4+):** finite Stream with specialized pull state, Sink collect/drain/fold, public Channel, runtime cost accounting, futures-core adapter, stream fusion (CHAN-002, CHAN-006..008) ([channel-stream-modules](research/channel-stream-modules.md#explicitly-unsupported-until-later-gates))
- **Config/Redacted:** startup env profile, provider/path subset and codec parity, typed ConfigError, Redacted secret witness, acceptance corpus (CFG-001..004) ([config-cache-modules](research/config-cache-modules.md#configuration-observations-and-decisions))
- **Cache/Request/Pool (Wave 5):** memo slots, shared Cache state machine, substrate choice (Moka?), ScopedCache, static request batching, dynamic RequestResolver, fixed Pool and substrate (CACHE-001..004, REQ-001/002, POOL-001/002) ([config-cache-modules](research/config-cache-modules.md#cache-observations-and-decisions))
- **Fiber family:** Fiber, FiberHandle/Map/Set, FiberRef; task-group fail-fast/collect joins and dynamic topology (COORD-001) ([coverage](effect-module-coverage.md#complete-core-namespace-inventory))
- **Transactional:** TxRef/TxQueue/TxHashMap need a journal/retry runtime ([coverage](effect-module-coverage.md#complete-core-namespace-inventory))
- **Time/platform:** DateTime, Cron, ByteSize; Runtime/Scheduler selection; Logger/Console; Tracer/Metric; FileSystem/Path/Stdio/Terminal/Crypto adapters ([coverage](effect-module-coverage.md#complete-core-namespace-inventory))
- **Schema:** refinements/transforms, serviceful decoding, general compilation, portable registry, constrained output encoding (SCHEMA-001..006); TaggedError widening — classes in payloads, non-tagged classes, checks (TE-004) ([tagged-errors](research/tagged-errors.md#decisions))
- **Unstable groups:** rpc workers/middleware/streaming, http/http-api, encoding (Ndjson/Sse), sql, OTLP/Prometheus, persistence/RateLimiter, socket/workers/process, reactivity, testing (TestClock), cli, ai, cluster/workflow ([coverage](effect-module-coverage.md#group-entry-points))
- Option `partitionMap` tuple order changed in stable; not admitted ([module-expansion](research/module-expansion.md#validation-obligations))

## Scope, resources and concurrency

### Scope and finalization

- Manual Scope values and close, child/fork scopes, parallel release, closed-scope registration (runs immediately with the original Exit), registration within cleanup ([resource-scope-registration](research/resource-scope-registration.md#2026-10-02-preparation-correction-and-implementation-boundary), [scope-reference-evidence](research/scope-reference-evidence.md#unresolved-design-questions-for-the-parent))
- General Exit-aware Scope service (SR-2); Exit-aware/fallible cleanup and cleanup Cause combination; a drain that survives unexpected finalizer failures (SCOPE-002) ([resource-scope](research/resource-scope.md#decisions))
- `acquireRelease({ interruptible: true })`; graceful drain, cross-fiber resource transfer, abort/drop cleanup (SCOPE-004) ([scope-native-evidence](research/scope-native-evidence.md#narrow-authoring-surface-and-ir))
- Scope requirement enforced by types, not only the graph checker (DX decision) ([scope-native-evidence](research/scope-native-evidence.md#narrow-authoring-surface-and-ir))
- General resource computations (`File.open` with resource-aware flatMap); cross-slot captures; more handle types (sockets, SQL handles) (SCOPE-003) ([scope-native-evidence](research/scope-native-evidence.md#captures-delayed-lifetimes-and-log-context))
- Logger/filter replacement and dynamic services in registration snapshots ([scope-native-evidence](research/scope-native-evidence.md#captures-delayed-lifetimes-and-log-context))
- Evidence-based registration budget (the 16-slot ceiling), or a growable registry ([scope-native-evidence](research/scope-native-evidence.md#alternatives-assessed))
- Remaining pre-implementation decisions _(verify)_: split-borrow fixture, log snapshot form, cleanup termination admission, a single capacity plan source; stronger masked-cleanup lowering; blocking-open task panics ([scope-native-evidence](research/scope-native-evidence.md#remaining-decisions-and-validation-status))
- Real-socket disconnect fixture for registered files and the whole registry; acquisition-cancellation seam and handle-identity checks _(verify)_ ([scope-workload-evidence](research/scope-workload-evidence.md#parent-integration-guidance-and-validation-handoff))
- Writable/durable files and a close-failure contract (FILE-002); runtime paths, sandboxing, symlinks (FILE-005) ([scoped-files](research/scoped-files.md#bounded-decisions))

### Resource Layers and services

- Concurrent effectful `Layer.merge`; `Layer.effectDiscard`/`effectContext`; Exit-aware layer release; child/parallel layer scopes ([resource-layer](research/resource-layer.md#deferred), CTX-004)
- Service objects/methods and request injection (CTX-001); server-lifetime layers, `ManagedRuntime`, cross-invocation caching (CTX-003); serialized service identity ABI (CTX-002); dynamic Context requirements ([context-layer](research/context-layer.md#decisions))
- An empty scope is still created for a nested provide whose providers all come from the outer memo ([resource-layer](research/resource-layer.md#implementation-notes))
- Layer graph to a generated app-construction struct ([runtime-lowering](runtime-lowering.md#service-and-layer-wiring))

### Structured concurrency

- Typed child failure and fail-fast joins (TASK-004); result collection, numeric concurrency, iterables/records, race options (TASK-001) ([structured-concurrency](research/structured-concurrency.md#chosen-first-surface))
- Fiber handles, detached children, dynamic spawn; nested groups and groups in cleanup
- Clock/Random in children (TASK-003); Remote store and launch in children; Ref/file capture and parent-Scope registration from children
- Child failure-trail transfer (TASK-005); FiberRef joins, context merge, distributed span identity
- Async cleanup on panic or a dropped parent future ([structured-concurrency](research/structured-concurrency.md#validation-and-cost-gates))
- Inline cancellation instead of two watch channels per group (TASK-006); build-time, dependency and logging/Scope cost measurement
- Replace harness-only host signaling with a public primitive (TASKCONF-002) ([conformance](research/structured-concurrency-conformance.md#test-design-decisions))

### Runtime services

- Virtual time/TestClock, nanos, monotonic adapter (RTS-005); live and seeded Random, Crypto (RTS-002, DRV-002) ([runtime-services-implementation](research/runtime-services-implementation.md#decisions-before-implementation))
- Observer clock injection (DRV-005); nonfinite clock policy (DRV-004); per-function context specialization (DRV-003) ([runtime-services-lowering](research/runtime-services-lowering.md#decisions-before-implementation))
- Host faults as Cause/defects with awaited cleanup, not panics (RTS-004, RTCONF-003)
- Host RPC contexts constructed or refused; combined store and driver layout measurement (DRV-006); host-provided long-lived service instances and registry plug-ins

## Types and Schema

- **Numbers:** `R.Int32`/`Uint32` with named checked/wrapping ops (open: default overflow policy), `R.SafeInt`, sized BigInt widths `U8..U64`/`I8..I64`/`I128`/`U128`, `R.F32`; checked u64 arithmetic; checked-number output encoding (NUM-002); more number checks; `R.Number` laws and operations (NUM-001) ([native-types](research/native-types.md#how-native-sized-types-should-work-proposal), [number-profile](research/number-profile.md#decisions))
- **Strings:** UTF-16 `R.JsString` profile keeping lone surrogates (open: does any workload need them?); explicit `byteLength`/`scalarCount`/`graphemeCount`; slicing, ordering, templates, case mapping, regex; strings in cleanup captures, log attributes and `Launch`; dynamic `replaceAll`; moving owned parameters into results (STR-002/003/005) ([string-profile](research/string-profile.md#deferred))
- **Records and unions:** struct update/spread, recursive types; untagged unions (REC-002); non-String/checked record keys, rest structs (RECJS-005); clone-instead-of-move on single-use locals; composite native runner arguments (REC-006); numeric/boolean/mixed literal unions and their matching (LIT-001/003); effectful `UndefinedOr.match`, wider optional forms (OPT-001/005); Newtype; trait-gated maps ([records-unions](research/records-unions.md#deferred))
- **Arrays, tuples and bytes:** fixed `[T; N]`, length checks in outputs (LEN-002), `isUnique`/tuples/NonEmptyArray (LEN-003), `R.Tuple`, `R.Bytes`, loop fusion (ARR-004), concurrent `forEach` (ARR-003, M12), copy reductions, `parallelReduce` justified by laws ([arrays](research/arrays.md#decisions))
- **Schema and JSON:** portable Schema profile and representation registry (SCHEMA-001), constrained output encoding with a defect contract, all-errors/concurrent parsing (SCHEMA-005), shape-rule rechecks on Effect upgrades (SCHEMA-002/006), Unknown widening (UNK-001/004), opaque native extension types (Uuid, DateTime, Decimal), separate wire/storage representations, Facet vs Serde benchmark ([schema-profile](research/schema-profile.md#limits-and-revisit-triggers), [facet](research/facet.md#decision-and-evaluation-gate))

## Semantic kernel, R language and Rust emission

- Law-driven rewrites; promote laws from claims via Schema-generated property tests; identity/inverse/distributive laws; execution and representation law families; laws in operation types; an optimization trust policy ([gen2-semantic-kernel](gen2-semantic-kernel.md#typed-laws-are-probably-the-biggest-improvement), [semantic-kernel](research/semantic-kernel.md#implementation-evidence))
- Traits beyond Copyable/Cloneable/Eq/TotallyOrdered: Hashable, Shareable, AtomicCompatible, implications ([gen2-semantic-kernel](gen2-semantic-kernel.md#traits-are-another-thing-id-borrow))
- Planner choice records (preferred/rejected/fallback); derived analysis graph; `Compile.show`/IR printer; `Compile.dependencies`/`unsupported`; a distinct deterministic `Operation<S>` IR ([foldkit-ir-design](foldkit-ir-design.md#show-should-absolutely-exist-for-effect-native))
- normalize and optimize are still identity stages ([PROGRESS milestone 0](../PROGRESS.md#2026-09-30--milestone-0-arithmetic-compiler-path))
- R language: call graph and tail lowering (see [gates](#cross-cutting-gates)); refuse non-tail recursion; user-land control library — loop/while/for/use/guard/fold (RT-6); native type batch (RT-7) ([r-language](r-language.md#rt-6--user-land-control-library))
- Rust emission: `Rs` helpers stay internal until there are external callers; structured writer for the Foldkit emitter's `verbatim` shells; no rustfmt pass without a mapping stage ([rust-emission](rust-emission.md#first-extractions-and-acceptance))
- Evaluate `nova_vm` against napi-rs/Neon for the hybrid target ([native-types](research/native-types.md#rust-crates-implementing-js-types))
- Package publication (`packages/reffect` is private) ([semantic-kernel](research/semantic-kernel.md#authoring-api-refinement-user-direction))

## Observability, source maps and metadata

- **Logging:** strings/records/dynamic messages, custom Logger adapters, configurable levels, pretty stderr sink, OTLP log records, dependency-log bridge, exact u64 encoding and truncation policy ([observability](observability.md#logging-semantics-and-sinks), [logging](research/logging.md#chosen-api-and-boundaries))
- **Tracing:** Span IR wrapper and current-span access, OTel export, per-poll/fork/finalizer context rules, W3C traceparent ingress/egress, request IDs, span-status policy ([observability](observability.md#spans-context-and-propagation))
- **Metrics:** typed static instruments over the OTel SDK, cardinality limits, exemplars ([observability](observability.md#metrics))
- **Delivery:** pinned tracing/OTel crate set and dependency profiles; host-provided providers with no globals; bounded export queues, flush ordering, redaction; overhead measurement; acceptance with test exporters and a local Collector ([observability](observability.md#export-operations-privacy-and-overhead))
- **Per milestone:** M3 request propagation and metrics; M4–5 operation/query spans and pool metrics; M6–15 stream spans, live/SSR handoff, FiberRef rules ([observability](observability.md#delivery-through-the-existing-milestones))
- **Failure diagnostics:** Cause-capable frame profiles, native backtraces and symbol packaging, top-level panic diagnostic, async task failure context, bounded descriptor growth, detailed-frames policy ([observability](observability.md#stack-traces-and-failure-metadata), [failure-frames](research/failure-frames.md#hardening-implementation-and-measured-results))
- **Source maps:** automatic JS capture, v3 projections, imported Foldkit sites, transform-origin records once rewrites exist, AST metadata plugin, jridgewell/MagicString adapters, `.rs.map` projections, rustc span edge rules, resolver policy, offline native-address resolver, RPC HTTP main mapping, multi-stage composition tests ([source-maps](source-maps.md#required-verification))
- **Metadata costs:** remove the double metadata snapshot, compact indexes, side-table benchmark, names-only projection, capture suppression, persisted compile-cache policy ([metadata-cost](metadata-cost.md#opt-out-controls-and-defaults), [source-artifact-policy](research/source-artifact-policy.md#chosen-api-and-boundaries))

## Compiler API, editor and migration tooling

- **Compiler API:** declarative `Compile.make` with targets, presets and options; `Native.program`; the compiler as Services and Layers; target data (`Rust.binary`, `Node.hybrid`, `Wasm.module`); a rich `CompileResult`; `Compile.watch`/`devServer`; a queryable support registry; `Compile.explain` support reporting with selected/rejected candidates and crates ([compiler-api](compiler-api.md#compile-options-should-be-composable), [runtime-lowering](runtime-lowering.md#planning-support-reporting-and-acceptance))
- **CLI:** `check`, `build` and `run` are delivered ([cli](research/cli.md)); `dev`, `emit`, `inspect`, `support`, a JSON diagnostic report, and flags for entries whose compile needs configuration remain ([compiler-api](compiler-api.md#the-cli-is-then-almost-trivial))
- **Diagnostics:** pretty/JSON/LSP renderings and semantic codes ([conformance](conformance-and-diagnostics.md#42-diagnostics-are-first-class-output))
- **Implementation registries:** operation/service/semantic registries with `Native.Service.implement` ([runtime-lowering](runtime-lowering.md#three-implementation-registries))
- **Editor:** LSP adapter for compiler diagnostics, read-only Rust preview, Volar virtual documents, UTF-16 position mapping, rust-analyzer bridge; Volar proof of concept vs a direct adapter ([editor-tooling](editor-tooling.md#first-useful-editor-slice))
- **Migration:** nothing implemented yet — mechanical codemods with preconditions, choice recording, pinned Codemod engine adapter, target-scoped reachability reports, a shared fix registry, `Compile.analyze` and CLI, an agent migration skill, Effect-tsgo integration; open questions on locations, report schema and fix IDs ([migration-tooling](migration-tooling.md#mechanical-transformations), [research](research/migration-tooling.md#acceptance-and-open-questions))

## Divergence fixes

Possible fixes for registered [native divergences](native-divergences.md#runtime-differences); none is scheduled.

- Parse the RPC envelope as `serde_json` `RawValue` and decode per request: lone surrogates (STR-007), plain `Schema.String` with a UTF-16 profile (STR-008), out-of-range numbers (NUM-005b)
- `ryu-js`-formatted numbers in RPC and Unknown encoding, after a differential corpus against V8 (NUM-004) ([native-types](research/native-types.md#open-questions))
- Body/batch limits raised per workload; an explicit JSON depth limit via `serde_stacker`
- Refuse or null-encode non-finite numbers at the store/patch boundary (RM-001)
- Immediate finalizer run on a closed scope, once explicit scopes exist (SCOPER-004)
- Cast to the column type in planned Postgres SQL (SQLX-011)
- A Cause/runtime adapter for host-fault defect parity (RTS-004)

## Performance and measurement

- Reproducible baselines before regression thresholds; executable size, cold start, idle/steady RSS, throughput and latency for public demos; Remote/SQL/streaming workloads ([performance](performance.md#evidence-to-collect))
- Engine allocation dominates batch reads: ownership-stage borrowing, `Arc<str>` sharing, interned names (BENCH-002); mimalloc on Linux unmeasured (BENCH-001); multi-core scaling and multi-threaded Tokio ([remote-bench](research/remote-bench.md#decision-2026-10-03))
- Peak heap for Full/None artifacts; metadata performance acceptance matrix; HTTP measurements with cleanup workers; Schema parser costs; compiler heap with many error representations; Ref witness heap ([metadata-cost](metadata-cost.md#performance-acceptance))
- Scope registry sizes and allocations _(verify)_; resource bracket costs under polling/logging/HTTP ([scope-workload-evidence](research/scope-workload-evidence.md#capacity-analysis-and-cost-evidence))
- Shared Cargo target directory for native tests: unique crate names and a binary-path helper; deferred until suite runtime blocks work ([PROGRESS](../PROGRESS.md#2026-10-03--native-test-build-cache-measured-not-adopted))

## Distributed (Cruster)

- Optional `effect-native-cruster` capability with Cargo isolation; Entity, durable workflow and RemoteServer mappings; ResourceMap vs RcMap comparison; macro prototype first; re-verify upstream API and licensing ([cruster-backend](cruster-backend.md#i-would-expose-cruster-as-a-target-capability))

## Upstream foldkit-plus issues

All nine filed issues (#135–#143) are fixed in foldkit-plus 0.14.0, which reffect adopted on 2026-10-03 ([resolution](research/foldkit-plus-issues.md#resolution-all-fixed-in-foldkit-plus-0140-checked-2026-10-03)).

- [foldkit-plus#145](https://github.com/doeixd/foldkit-plus/issues/145): upstream's Postgres `contains` folds by collation while its evaluator folds ASCII only
- [foldkit-plus#146](https://github.com/doeixd/foldkit-plus/issues/146): a NUL search is a protocol `Defect` from the Drizzle source but a typed `RemoteQueryError` from the memory backend (SQLX-018)
- [foldkit-plus#147](https://github.com/doeixd/foldkit-plus/issues/147): `RemoteServer.memory` takes no per-entity `authorize`
- Not filed: Drizzle RC.4 declarations fail TypeScript 7, so `skipLibCheck` stays ([note](research/foldkit-plus-issues.md#dependency-declaration-compatibility-note))

## Repository and document hygiene

- Stale records: `resource-layer.md` still says "accepted for implementation" though RL-001..006 passed; `scoped-files.md` says "results will follow"; `basic-effect-ir.md` open work likely superseded; `compiler-api.md` says no off profile ships (SourceArtifacts.None does); `effect-v4-api-scope.md` uses `effect/unstable/*` paths and the rc.115 baseline ([coverage](effect-module-coverage.md#evidence-and-version-boundary))
- Older PROGRESS entries say the upstream issues were "not posted"; they were filed and are fixed in foldkit-plus 0.14.0 (above)
- Saved stash `0ca3899` kept until validated; four untracked effect-\* documents block the full-root format check ([upstream-reconciliation](research/upstream-reconciliation.md#result))
- Windows: intermittent `taskkill` cleanup stalls and ~60 s failed-child cleanup through the Node process adapter ([PROGRESS milestone 0](../PROGRESS.md#2026-09-30--milestone-0-arithmetic-compiler-path))

## Context only (not commitments)

- North star: whether milestone 8 should accept only unmodified upstream source (Q-1, user deferred); foreign operation ports (parse5→html5ever, URL, JSON, RegExp); a continuous SSR compatibility analyzer ([north-star-review](research/north-star-review.md#user-decision-2026-10-02), [north_star](north_star.md))
- Suggestions: `id_effect`/`effectful`/`effect-rs` comparisons (licensing review before reuse), Shuttle concurrency tests at M12, BackON/Moka/deadpool candidates, module tiers ([suggestions.txt](suggestions.txt))
- Unverified ecosystem claims in [effect-ecosystem](effect-ecosystem.md), [effect-adjacent-projects](effect-adjacent-projects.md) and [effect-schema](effect-schema.md#not-found--unverified)
- Nested data-first `R.Struct.get(R.Struct.get(x, a), b)` can infer `never` inside an `R.fn` callback; the pipe form works ([finding](research/ssr-data.md#m9-3-step-2-design-2026-10-03))
- A browser-safe `R.Html` entry, so an app's view is written once in R and used in the browser through `toFoldkitView` (todo-remote mirrors its view; [M9-4](research/ssr-data.md#plan))

## M9 review issues (2026-10-03)

The review of the SSR data path, LIVE-008, LIVE-012 and LIVE-015, filed on GitHub. Recommended order: security first (#3, #5), then #6, #12 with #9, #10 and #7, then #13, then #4 before any authenticated showcase, then M9-5 and #14.

## Full-codebase review issues (2026-10-03)

Four parallel reviews (RPC server, Remote engine, SSR, compiler core), with the key claims re-verified. Recommended order: #16, #17, #18 (anyone can stall or crash the server), then #21, #22, #23, #24 (SSR security and parity), #19, #20, then correctness, performance and design. The native-only snapshot race is a comment on [#8](https://github.com/doeixd/reffect/issues/8).

- [#32](https://github.com/doeixd/reffect/issues/32): source maps still cost about 3.5× (was 4.6×); 1.5× needs a cheaper artifact form, a format decision
- [#40](https://github.com/doeixd/reffect/issues/40): race children under a masked parent (coordination area); the literal and `unhex` items are done

- **Semaphore extension:** bounded public standalone builders, owned execution, audited generated driver bounds and exact-root layout checks are delivered ([SPUB](research/semaphore-public-admission.md)). Remaining: mixed-duration concurrent timers and queued zero/yield jobs inside All ([STIM](research/semaphore-timer-ordering.md)), RPC/request-context integration, manual/multiple permits, nested groups/acquisitions, mixed Deferred/Semaphore within one function, richer outcomes, registered resource cleanup and full invocation/compiler peak allocation measurements. Raw wake-all experiments remain unselected.

- **Ordinary async Sleep0:** the Semaphore root adapter now uses a guaranteed yield, but ordinary/Deferred native timer paths still need a separate audit of Effect sleep0 scheduler-yield semantics ([STIM](research/semaphore-timer-ordering.md)).
