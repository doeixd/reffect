# reffect roadmap

reffect is an ahead-of-time semantic compiler for a statically representable subset of Effect v4 programs. TypeScript authoring constructs typed IR; official Effect executes the reference interpretation, and a checked compiler lowers that IR to specialized Rust.

The destination is a native executable serving Foldkit rendering, Effect RPC, Remote data and SQL-backed live updates to ordinary browser clients. Work proceeds through small, verified compatibility profiles. Arbitrary TypeScript compilation and complete Effect coverage are outside the project’s commitment. Build-time TypeScript remains unrestricted; wider runtime authoring syntax comes after native semantics.

## Success criteria

- Stock Effect/Foldkit clients interoperate with compiled services through shared contracts.
- Supported success, failure, cancellation, finalization and sharing behavior agrees with the pinned reference implementation.
- Each profile reports its supported representations, effects, services, protocols, dependencies and explicit refusals.
- Generated code specializes reachable behavior; optional runtime machinery and Cargo dependencies follow reachable requirements.
- Compiled servers run without Node. Native costs and generated-code growth are measured alongside semantic correctness.

## Design constraints

- Effect is the semantic oracle. Schema/RPC/HTTP contracts define boundaries; explicit typed IR is the initial authoring surface.
- Every native value has an IRType and a known representation. Semantic types, native memory, wire codecs and storage mappings remain separate.
- Pure expressions, effectful computations and deterministic state transitions remain distinct. Branching is structured IR; unsupported callbacks and operations are refused.
- Semantic references identify types, operations, capabilities, effects, requirements and law subjects. Source metadata does not change identity. Rewrites require sufficient evidence, separately from claims.
- Compile Effect composition, Context lookups and Layers away where observable semantics permit. Preserve Layer sharing/freshness, supported Exit/Cause behavior, interruption, finalizer ordering and resource lifetimes.
- Classify supported lowering as generated/direct code, an existing substrate plus a semantic adapter, or dedicated semantic runtime. Keep operation, service and semantic-runtime registrations distinct and verify selected implementations.
- Use Rust std/Tokio, Axum/Hyper/Tower, Serde and SQLx as substrates. Delegate machinery only with conformance evidence; similar names do not prove semantic compatibility. Cruster stays optional.
- Begin ownership with primitive copies, moves, simple borrows and necessary clones. Execution context belongs to an invocation; native scalars carry no metadata wrapper. Expand cross-fiber ownership only for supported workloads.
- Expose the complete compiler pipeline through the Effect library. CLI, editors, build systems and migration tools consume the same diagnostics and support decisions.
- Preserve provenance, observability semantics and independent capture/artifact/instrumentation policies. Logical frames, native backtraces and distributed traces have distinct contracts.
- Refuse unavailable semantics rather than silently substituting behavior. Any future host fallback must report its dependencies and preserve limits, security and negotiated protocols.

## Current state

Milestones 0 and 1 are implemented: scalar arithmetic and the separate encoded-primitive Foldkit Query adapter have native conformance. Milestone 2 has a bounded Boolean/u64/Unit/Never function and synchronous Effect profile, shared helpers, source artifacts, bounded failure frames and scoped logging. Milestone 3 is active: scalar unary HTTP RPC, stock clients and one checked bearer/principal projection work. General Schema, Context/Layer lowering and resource Scope remain open.

The active slice is [suspended scalar RPC](docs/research/async-rpc.md): literal delay, owned execution context, cooperative cancellation and non-failing awaited `ensuring` cleanup. The bounded slice has reference/native conformance, real-socket and stock-client cancellation coverage, and measured layout/construction costs. [PROGRESS.md](PROGRESS.md) records completed evidence; the [package README](packages/reffect/README.md) describes shipped APIs.

## Compatibility profiles

These are roadmap names, **not implemented CLI target strings or a new public registry**. Profiles describe cumulative semantic commitments; dependencies still come from reachability. SQL and Query support must remain usable independently of HTTP where their workload permits.

| Profile          | Required capability boundary                                                                                         | Status                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `rust:core`      | Pure scalar functions, Match, Result and the bounded synchronous Effect subset                                       | Implemented through `Rust.std`; Query is a separate checked adapter       |
| `rust:async`     | Core plus owned execution context, cancellation and the admitted finalization/resource subset                        | Sleep/Ensuring slice through `Rust.tokio`; general Scope pending          |
| `rust:rpc`       | Async plus scalar unary RPC, checked middleware and request services; Services/Layers as separately verified entries | Bounded sync/async HTTP/auth subset implemented; general services pending |
| `rust:remote`    | RPC plus Foldkit Remote contracts, portable validation and authorization                                             | Planned                                                                   |
| `rust:sql`       | Checked Query/storage semantics and SQLx; compose with Remote when needed                                            | Planned                                                                   |
| `rust:fullstack` | Remote/SQL plus streaming, live data, SSR and resume                                                                 | Planned                                                                   |

Version each admitted subset against Effect/Foldkit and its Rust substrate. An explain report must show selected implementations, crates/features, rejected alternatives and unsupported semantic requirements. Capability admission never implies support for every operation in an upstream module.

## Implementation sequence

Milestone numbers remain 0–15. Milestone 3 now owns the minimal async foundation; milestone 6 extends its lifetime semantics to streaming.

| Milestone                     | Semantic capability gate                                                                                    | Acceptance evidence                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 0. Semantic kernel            | Typed identities, representations, operations/laws, compiler stages and diagnostics                         | Checked arithmetic emits compilable Rust; overflow and unsupported representations agree/refuse explicitly                |
| 1. Foldkit Query              | Adapt existing Entity Expr/Query IR within its checked encoded profile                                      | JS evaluator, Drizzle and Rust agree on supported fixtures and limitations                                                |
| 2. Functions and Effect IR    | Structured Match/Predicate and typed synchronous composition                                                | Official Effect/native exits agree; sharing and conservative ownership compile                                            |
| 3A. Minimal async foundation  | Async computations, owned request context, cooperative cancellation, finalizers and explicit resource Scope | Suspension preserves context; cancellation awaits cleanup exactly once; supported ordering/Exit/Cause and ownership agree |
| 3B. Unary RPC and services    | Shared contracts, async handlers, middleware, request services and basic Layers                             | Stock clients agree on results/errors; service identity/sharing and request teardown pass conformance                     |
| 4. Native RemoteServer        | Shared wire/validation/authorization, Sources, grouping and normalization                                   | Stock foldkit-remote matches the JS server within declared limits                                                         |
| 5. Query → SQLx               | Native/wire/storage separation and checked SQL operation semantics                                          | JS, Drizzle and Rust/SQLx agree; unsupported callbacks are refused                                                        |
| 6. Streaming                  | Chunking, acknowledgement/backpressure and stream lifetime over the async foundation                        | Interruption releases stream resources; protocol, finalizer and teardown traces agree                                     |
| 7. Remote live                | Interest, cursors, changes/deletes, reauthorization and minimal reads                                       | Stock subscriptions receive equivalent changes and finalize on cancellation                                               |
| 8. Foldkit SSR                | Server-reachable flags/routing/init/view and HTML serialization                                             | Stock hydration adopts native HTML through the established handoff                                                        |
| 9. SSR data and resume        | Data.satisfy, in-process Remote and minimal resume payload                                                  | Browser avoids duplicate initial fetches; combined fullstack demo works                                                   |
| 10. SchemaBinary              | Specialized codecs and framing                                                                              | Effect↔Rust round trips and required canonical bytes agree                                                                |
| 11. Persistent RPC            | Sessions, WebSocket, notifications and bidirectional cancellation                                           | Stock clients and session/resource cleanup agree                                                                          |
| 12. Broader concurrency       | Fibers, fork/join/race, state/channel primitives and advanced ownership                                     | Exit/Cause, sharing, finalizers and policy semantics match Effect                                                         |
| 13. Distributed profile       | Optional durable/distributed operations and Cruster adapters                                                | Requested capabilities select verified entries; ordinary builds omit them                                                 |
| 14. Additional targets/codecs | Verified serializer/library and WASM profiles                                                               | Each target satisfies explicit semantic and compatibility gates                                                           |
| 15. Syntax widening           | Additional producers for the same checked IR                                                                | New syntax preserves the already verified native subset                                                                   |

Each gate can ship bounded subprofiles without claiming the whole milestone. The first `ensuring` slice proves awaited cleanup; it does not complete resource Scope, acquire/release registration or general fiber semantics. Hybrid hosting follows established native semantics and reports its host requirement explicitly.

## Current frontier

Next: prepare and prove a minimal **resource Scope/acquire-release** profile. The suspended authenticated handler, owned contexts and awaited non-failing cleanup are the established baseline.

1. Research and record acquisition masking, registration, reverse release order, nested closure, interruption and the supported Exit/Cause subset before choosing IR/API or an implementation plan.
2. Select one real resource workload and establish handle ownership, escaping-capture refusals and exactly-once release on success, failure and cancellation, including cancellation during acquisition.
3. Compare official Effect and native lifetime traces under both diagnostic policies. Measure scope/future growth and allocations; concrete async helpers alone do not establish efficient resource Scope.
4. Admit the bounded Scope profile only after those gates pass, then prepare basic Services/Layers with explicit implementation registration and sharing/freshness evidence.

Replace this section as the frontier moves. Detailed acceptance and unresolved limits belong in the task’s research record; completed history belongs in PROGRESS.md.

## Cross-cutting requirements

Every milestone must preserve its provenance, diagnostic policy, observability semantics and disabled-path cost guarantees.

- **Conformance:** differential tests against pinned official Effect, stock clients and reused Foldkit/Drizzle fixtures. Verify observable behavior and meaningful refusal cases, rather than APIs alone. See [conformance requirements](docs/conformance-and-diagnostics.md).
- **Provenance and diagnostics:** explicit sites, shared use/definition origins, coordinate units, artifact identity, generated ranges and honest precision. Automatic AST/MagicString/Volar adapters remain optional consumers. Delivery matrices live in [source maps](docs/source-maps.md#delivery-through-the-existing-milestones).
- **Observability:** logging/context ordering, independent signal/export policies, bounded storage and lifetime-safe teardown. Optional OTel adapters follow owned execution context. Delivery matrices live in [observability](docs/observability.md#delivery-through-the-existing-milestones); [metadata costs](docs/metadata-cost.md) records allocation/layout evidence.
- **Performance:** gather generated size/growth, dependency count, compilation, startup, memory, allocations and workload latency/throughput. Turn established structural budgets into regression gates; label exploratory measurements. See [performance requirements](docs/performance.md).
- **Migration:** analyze target reachability, preserve supported code and use registered, evidence-backed fixes. Representability and rewrite equivalence require separate evidence. See [migration tooling](docs/migration-tooling.md).

`check → derive → normalize → plan → verify → optimize → ownership → lower → emit → build` remains the public pipeline. Each stage preserves semantic identity/provenance and reports support through the same library API. Typed Rust emission uses one source writer; optional inspector/codec tools such as Facet need a real consumer and conformance before selection.

## Decisions by milestone

| Deadline                                                | Decision and required record                                                                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Established at 0–2; review when extending               | Canonical semantic identities/witnesses, evidence policy, scalar representation rules and Effect 4.0.0-rc.118 oracle. Serialized build IDs must not conflate distinct semantic objects.                  |
| Before admitting each 3A async capability               | Execution ownership, cancellation points, mask restoration, supported Exit/Cause and finalizer ordering. The current slice admits Unit/Never cleanup; fallible cleanup and Scope are separate decisions. |
| Before 3A resource Scope / 3B Services/Layers           | Scope ownership/closure, acquire-release registration, service versus runtime implementation registry, sharing/freshness and escaping captures.                                                          |
| Before milestone 4                                      | Portable Schema subset, owned strings/records and explicit unions, wire validation and Remote authorization semantics.                                                                                   |
| Before milestone 5                                      | Native/wire/storage representations, SQL numeric/null/text semantics, transaction/cancellation/release boundaries.                                                                                       |
| Before milestone 6                                      | Streaming backpressure/acknowledgement, stream cancellation and lifetime extension of the established Scope/Cause model.                                                                                 |
| Before any exporter or automatic metadata adapter ships | Exact crate/MSRV/features or host/checker versions; record schema, buffers/cardinality, flush deadlines, map identity/privacy and measured costs.                                                        |
| Before milestones 7–12                                  | Subscription/session ownership, reauthorization, fork/join inheritance and each state/channel policy. Decide per admitted workload.                                                                      |
| Before optional milestones 13–15                        | Cruster compatibility, WASM/serializer contracts, syntax producer equivalence and any hybrid-host fallback obligations.                                                                                  |

## Reference docs

Use [AGENTS.md](AGENTS.md) for workflow and [the docs index](docs/README.md) to locate records. Current implementation contracts are in the package README and focused specifications: [metadata ownership](docs/metadata-cost.md), [source maps](docs/source-maps.md), [observability](docs/observability.md), [Rust emission](docs/rust-emission.md), [editor tooling](docs/editor-tooling.md), [migration](docs/migration-tooling.md) and [runtime lowering](docs/runtime-lowering.md).

The detailed [compiler design revision](docs/compiler-design-revision.md) and [milestones](docs/implementation-milestones.md) supply architecture context; this roadmap governs current sequencing and the milestone 3 async promotion. Older conversations, provisional examples and “Later update” notes remain archival context in those documents. They do not establish shipped APIs or supersede the current frontier.
