# reffect roadmap

reffect is an ahead-of-time semantic compiler for a statically representable subset of Effect v4 programs. TypeScript executes an Effect-shaped DSL to construct typed IR; a reference interpreter runs that IR through official Effect, and a native backend lowers it to Rust.

This is the entry point for the vision and sequencing. [PROGRESS.md](PROGRESS.md) tracks actual implementation status. The [documentation index](docs/README.md) covers the detailed designs; the [later operation/expression revision](docs/op-expr-revision-convo.md) explains changes to the initial plan. The [compiler package](packages/reffect/README.md) implements the milestone 0 arithmetic path and milestone 1 Foldkit encoded-primitive Query profile with shared conformance, plus the initial synchronous Boolean/u64 milestone 2 profile. Native observability and broader capabilities below remain intended, not shipped.

## How to use this plan

1. Read the constraints before choosing an implementation approach.
2. Read the revised design and milestones, then the task-specific reference documents below.
3. Check PROGRESS.md and actual code before assuming an API or milestone exists.
4. Build the smallest complete capability and validate its semantics against the reference implementation.
5. Record completed work, validation, and remaining questions in PROGRESS.md. Update this roadmap when priorities or constraints change.

## Design constraints

> **Later update:** The [project naming decision](AGENTS.md#project-goal) establishes **reffect** and the **R** DSL namespace. Historical names/examples in the detailed references remain context; use the new names in new designs.

- Effect remains a dependency and semantic oracle. The JS interpreter delegates execution to official Effect; public Schema, RPC, and HTTP descriptions supply boundary contracts.
- Initially compile explicit typed IR built by symbolic callbacks. Arbitrary TypeScript control flow, generators, operators, loops, and opaque callbacks are outside the compiled subset; build-time TypeScript remains unrestricted.
- Every runtime value has an IRType and known native representation. Keep semantic Schema, native memory, wire codecs, and storage mappings distinct.
- Operations carry input/output types, effects, required capabilities, typed laws/evidence, and target implementations. Separate pure Expr, effectful computation, and deterministic state-transition data.
- Match is the initial branching construct. Predicates and structured collection/effect combinators represent branching and iteration as data; normalize composition into canonical IR.
- Derive dependencies and checked semantic traits. Track backend capabilities, program effects, external requirements, and laws separately. Use stable semantic identities rather than display names.
- Introduce law witnesses and assurance policy in the kernel, then enable optimizations only when the evidence/conformance infrastructure supports them. Operation semantics define behavior across backends, including numeric, string, null, and ordering edge cases.
- Infer moves, borrows, sharing, and cloning conservatively first. Ref expresses shared mutable identity; RcRef/RcMap express resource lifetime. Expand scope/fiber ownership analysis when concurrency workloads demand it.
- Compile Effect composition, Context lookups, and Layers away where observable semantics permit. Preserve Layer sharing/freshness, interruption, finalizers, Exit/Cause when observable, and resource lifetimes.
- Use Tokio, Hyper/Tower/Axum, Serde, and SQLx as native substrates. Keep the Effect-specific runtime small; Cruster is an optional later distributed/durable profile.
- Classify supported lowering as generated/direct code, an existing substrate plus a semantic adapter, or dedicated semantic runtime. Distinguish operation, service, and semantic runtime implementation entries; select reachable crates/features through the planner and verify observable behavior before treating a mapping as equivalent.
- Adapt small Gen2 kernel primitives and consume existing Foldkit Entity/Query IR, protocol schemas, and conformance fixtures where possible. Defer shared-kernel extraction until real commonality is demonstrated.
- The compiler is an Effect library with Services/Layers; CLI, editors, tests, and build integrations consume the same public stages and diagnostics.
- Migration is a first-class consumer of compiler analysis/diagnostics. Delegate mechanical AST/workflow execution to an established platform; classify target-reachable work, preserve supported code, and distinguish representability checking from source-rewrite semantic equivalence.
- Make target selection and fallback planning explainable. Refuse unsupported operations when no semantics-preserving implementation exists; expose any later hybrid-host requirement explicitly.
- Preserve stock Effect RPC clients, Foldkit hydration, and Remote resume compatibility. Keep browser RPC separate from internal cluster RPC.
- Keep source provenance independent of semantic identity and telemetry sampling. Preserve observable log/event ordering, context and failure annotations; use verified Rust tracing/OTel adapters with optional dependencies and explicit export policy. Logical Effect frames, native backtraces and distributed traces are separate diagnostics.
- Keep the IR stable as later syntax producers and targets broaden authoring options.

## Document map

The [observability design](docs/observability.md) and [checked research](docs/research/observability.md) define source/provenance artifacts, logical failure frames, structured logging, span/context propagation, metrics, Rust tools and bounded OTLP export. This cross-cutting track attaches to existing milestones and preserves Effect compatibility separately from OTel service-boundary conventions.

The [runtime lowering reference](docs/runtime-lowering.md) supplements the revised design with Rust substrate candidates, the three implementation registry families, compile-time service/Layer wiring, and conformance obligations. It preserves the existing milestone order and initial symbolic-builder restriction.

The [migration tooling design](docs/migration-tooling.md) and [research record](docs/research/migration-tooling.md) add target-scoped compatibility reports, diagnostic-linked fixes, mechanical/guided/architectural workflows, and agent/editor integration as consumers of the same compiler API.

| Document                                                               | Read when working on                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Revision overview](docs/op-expr-revision-convo.md)                    | Changes from the initial proposal, reading order, and precedence                                             |
| [Revised compiler design](docs/compiler-design-revision.md)            | Current architecture, reuse, repository shape, CType/Operation/Law/Trait, compiler stages, API, and CLI      |
| [Revised implementation milestones](docs/implementation-milestones.md) | Detailed milestone 0–15 scope, acceptance, conservative ownership, and later targets                         |
| [Conformance and diagnostics](docs/conformance-and-diagnostics.md)     | Test obligations, semantic diagnostics, postponed scope, and todo-fullstack target                           |
| [Foldkit IR design](docs/foldkit-ir-design.md)                         | Expr/Query adaptation, symbolic inputs, dependencies, identity, deterministic transitions, and normalization |
| [Gen2 semantic kernel](docs/gen2-semantic-kernel.md)                   | Law witnesses/evidence policy, checked traits, representation separation, and explainable planning           |
| [Reuse strategy](docs/reuse-strategy.md)                               | Adaptation versus dependency/contract reuse, semantic ports, and deferred shared extraction                  |
| [Cruster backend](docs/cruster-backend.md)                             | Optional cluster/durable integration, workflows, internal RPC, and runtime isolation                         |
| [Original compiler architecture](docs/architecture.md)                 | Foundational DSL/IR, ownership, Services/Layers, fibers/Scope, platform lowering, and original examples      |
| [RPC MVP](docs/rpc-mvp.md)                                             | Shared contracts, unary JSON/HTTP, and stock-client demo                                                     |
| [RPC protocol](docs/rpc-protocol.md)                                   | Middleware, backpressure, sessions, reverse RPC, serialization, and transports                               |
| [Observability and source diagnostics](docs/observability.md)          | Logging/OTel, source maps, logical/native stacks, context semantics, optional crates and delivery gates      |
| [Compiler API](docs/compiler-api.md)                                   | Build specs, services, results, watch/dev, diagnostics, and CLI details                                      |
| [Foldkit SSR](docs/foldkit-ssr.md)                                     | Server graph, HTML IR, hydration, SSG, and streaming rendering                                               |
| [Foldkit Remote and SQL](docs/foldkit-remote.md)                       | Sources, storage bindings, authorization, queries, liveHub, and SSR resume                                   |

The later revision takes precedence on the changes described in its overview. Earlier discussions remain detailed references. API names, repository and licensing observations, and unresolved citation placeholders are historical proposal material; verify upstream details before implementation.

## Implementation sequence

Use the numbered milestones in the [revised implementation plan](docs/implementation-milestones.md). Its final condensed sequence groups and numbers some later steps differently; the numbering below follows the detailed milestone definitions.

| Milestone                         | Scope                                                                                                                        | Acceptance evidence                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 0. Semantic kernel                | Gen2-inspired representations, Operation/Law/Trait/Capability, CType/Expr/Program/Target, diagnostics and pass skeleton      | A minimal arithmetic C.fn emits a compilable Rust crate; this is a smoke test                                    |
| 1. Foldkit Query → Rust           | Consume Entity Expr/Query and existing evaluator/conformance cases                                                           | JS evaluator, Drizzle, and generated Rust agree on strings, nulls, predicates, ordering, and structured values   |
| 2. Functions and Effect IR        | General C.fn, Match, Predicate, succeed/fail/map/flatMap; official Effect reference interpreter; conservative ownership      | Same supported IR matches Effect and Rust; primitive copies, moves, simple borrows and necessary clones compile  |
| 3. Unary RPC and early middleware | Shared RpcGroup/Schema, async typed handlers, Services/basic Layers, JSON/HTTP; request auth/context immediately after unary | Stock Effect RpcClient calls native handlers with matching success/error behavior and request services           |
| 4. Native RemoteServer            | Existing wire contracts, validation, authorization, grouping, traversal, normalization, mutations, limits; in-memory Sources | Stock foldkit-remote works without native-specific client code; native behavior matches the JS server            |
| 5. Query → SQLx                   | Semantic query planning and build-time storage metadata; portable authorization                                              | JS, Drizzle, and Rust/SQLx conformance agree; unsupported callbacks are refused                                  |
| 6. Streaming and interruption     | Stream lowering, NDJSON chunks/acks/backpressure, cancellation, explicit async Scope/finalizers                              | Client interruption closes native resources; completion/finalization traces match Effect                         |
| 7. Remote live                    | Subscription interest, cursors, changes/deletes, re-authorization, minimal re-reads and patches                              | Stock live subscriptions receive matching changes and finalize on cancellation                                   |
| 8. Foldkit SSR                    | Server-reachable routing/Flags/init/view, HTML IR and serializer                                                             | Stock Foldkit hydration adopts native HTML using the existing handoff protocol                                   |
| 9. SSR data and resume            | Data.satisfy, direct in-process Remote handlers, minimal resume payload                                                      | Browser resumes required data without duplicate startup fetches; todo-fullstack combines SSR/RPC/Remote/SQL/live |
| 10. SchemaBinary                  | Specialized codecs and framing                                                                                               | Effect↔Rust bidirectional encoding/decoding and canonical-byte checks where required                             |
| 11. Persistent RPC                | WebSocket sessions, notifications, reverse RPC, two-way cancellation; independent serialization/transports                   | Stock client compatibility and session cleanup hold across supported profiles                                    |
| 12. Broader concurrency           | Fibers, all/race/fork/join, Ref/Queue/PubSub/Deferred/FiberRef; advanced scope ownership and law-backed optimization         | Effect semantics, finalizer traces, and inferred ownership pass conformance and generated Rust validation        |
| 13. Distributed profile           | Optional Cruster entities, persisted delivery, workflows, activities, timers, sharding                                       | Requested distributed capabilities select a verified implementation; ordinary programs omit cluster dependencies |
| 14. Additional targets/codecs     | Registered native serializers/libraries and WASM experiments                                                                 | Target-specific implementations satisfy explicit support and conformance obligations                             |
| 15. Syntax widening               | Optional operators/control flow/await/Promise transforms producing the same IR                                               | New syntax preserves existing IR semantics and backend behavior                                                  |

Hybrid JS hosting follows solid native semantics and explicitly reports the host requirement through compiler explanations. Implement runtime coverage in response to workloads; defer complex cross-fiber borrowing and law-driven optimizations until their validation foundations exist.

Migration tooling accompanies supported native profiles: introduce source locations, structured compatibility reports, and fix metadata with compiler diagnostics, then add eligible codemods and workflows as capabilities stabilize. It does not reorder the core milestones or enable arbitrary source syntax in the initial compiler; full syntax widening remains later.

The first meaningful compiler workload is Foldkit Query conformance. Unary RPC remains the first major public demo. The combined showcase is `examples/todo-fullstack`: one Rust binary serving Foldkit HTML, Effect RPC, Remote data/live subscriptions, and SQLx-backed storage while the ordinary browser bundle hydrates and uses stock clients.

## Observability delivery track

Follow [the detailed delivery gates](docs/observability.md#delivery-through-the-existing-milestones) alongside the numbered milestones. This is planned support, not an implemented native telemetry claim.

| Milestone               | Required work                                                                                                                                                                          | Acceptance                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next milestone 2 slice  | Immutable source/use-site provenance, diagnostic locations, named logical failure frames, Unit and scoped logging/annotations/log-span timers; no-op and pretty/JSON stderr sinks      | Official Effect/native event ordering, severity, source resolution and annotation restoration agree; native stdout stays unchanged; no OTel/network dependencies in no-op/local-only builds |
| 3 RPC and middleware    | Owned request context, server/client/RPC spans, W3C extraction/injection, baseline counters/duration histograms, resource identity and independently selected OTLP logs/traces/metrics | Stock client propagation and error schemas agree; SDK/Collector export, correlation, bounded queues, signal filtering and deadline-limited shutdown pass conformance                        |
| 4–5 Remote/SQLx         | Domain/query/pool spans and metrics with approved attributes                                                                                                                           | Supported error classes and correlation agree; raw SQL parameters/auth data are excluded                                                                                                    |
| 6 Scope/streaming       | Stream-lifetime spans, interruptor frames, finalizer events and teardown ordering                                                                                                      | Cancellation and cleanup traces match Effect; spans close exactly once                                                                                                                      |
| 7–9 and 11–12           | Bounded live/session/message spans or links, SSR/data correlation, fork/join context rules and optional task debugging                                                                 | Context stays isolated across siblings, async polls, joins and finalizers; no unbounded session telemetry retention                                                                         |
| Later targets/frontends | Distributed workflow policies, target adapters and exact source-map producers                                                                                                          | New producers/targets preserve the same provenance and semantic record contracts                                                                                                            |

Prefer `tracing`/`tracing-subscriber` and `tracing-opentelemetry` for native spans, direct OTel SDK records/instruments where needed for exact Effect logging/metrics, and OTLP to a Collector. Pin/test exact crate versions/features when implementing. Metadata and logical diagnostics remain useful without sampling/export; exporters never install globals from a generated library. Logging is best-effort diagnostics by default, while durable audit writes remain an explicit business service.

## Compiler pipeline

> **Later update:** [Runtime support reporting](docs/runtime-lowering.md#planning-support-reporting-and-acceptance) extends planning with substrate/adapter choices and reachable crates/features. [Migration diagnostics](docs/migration-tooling.md#structured-diagnostics-and-shared-fix-registry) expose source locations, alternatives, and eligible fixes through the same compiler API.

`check → derive → normalize → plan → verify → optimize → ownership → lower → emit → build`

Check local invariants; derive dependencies, traits, requirements, and scope relationships; normalize composition; select implementations; verify required capabilities/laws; apply justified rewrites; assign ownership; lower and emit target code; build artifacts. Expose stages through the Effect API and record selected/rejected strategies and valid fallback reasons for `Compile.explain`.

Planning should distinguish operation, service, and semantic runtime requirements. Explain generated specializations, selected substrates/adapters, remaining semantic obligations, and reachable Cargo crates/features. Registry metadata can enter the kernel early; implement entries only as workloads require them. Compile-time batching, Schedule state machines, Ref specialization, and stream fusion remain subject to semantic/evidence checks.

Source provenance follows nodes and use edges through every pass, including optimization/shared helper lowering. Planning records selected observability adapters, sinks, context/clock requirements, policies, stripped information and Cargo features. Ownership verifies queued record lifetimes; emission includes versioned source maps/build identity when selected. Compiler pass telemetry uses official Effect and independent providers from the generated application. See [observability stage obligations](docs/observability.md#compiler-integration-and-acceptance).

## Validation strategy

> **Later update:** See [migration acceptance](docs/migration-tooling.md#delivery-and-acceptance) for rewrite preconditions, repeat-run stability, and target boundaries. A native check establishes representability; conformance tests must also establish that a rewrite preserves behavior.

- Compare operation/IR results through reference JS or official Effect and generated Rust, including numeric, null, string, and ordering edge cases.
- Compare source-aware log/span/metric records with deterministic official Effect and Rust in-memory collectors; verify severity, executed-site frames, context isolation, OTel propagation/status policy, output-stream isolation, redaction, bounded export/shutdown and dependency/overhead profiles. Treat random IDs/timestamps/native stack text separately from semantic invariants.
- Generate Schema-driven law property tests and track subject-indexed evidence separately from claims.
- Reuse Entity/Query fixtures across evaluator, Drizzle, and Rust/SQLx; compare NativeRemoteServer with the existing JS server.
- Test official RPC client interoperability, including middleware, cancellation, backpressure, framing, and session lifetime as supported.
- Cross-encode/decode codecs with Effect and compare bytes where canonical output is required.
- Compare Foldkit rendering, stock hydration, and Remote resume; compare observable Exit/Cause and finalizer/interruption traces for runtime features.
- For substrate adapters, compare supported lifecycle/policy behavior with Effect: Queue/PubSub shutdown and strategy, shared completion, scoped cache/pool release, Layer sharing/freshness, timer interruption, and batching/schedule/stream semantics. Verify that generated dependencies include only reachable implementations.
- For migrations, verify each eligible fix preserves behavior, refuses unmet preconditions, respects target reachability, leaves supported code unchanged, and is stable on repeat runs. Compiler checks, conformance tests, and native builds establish different parts of the result; report unresolved cases explicitly.

Use [AGENTS.md](AGENTS.md) for tooling, commits, and guidance on when subagent review is useful.

## Decisions to settle during implementation

- Exact source/record schema versions and deterministic occurrence IDs; diagnostic/source precision, tested observability crate/MSRV/features, and profile buffer/cardinality/flush defaults. The [observability architecture](docs/observability.md) fixes the semantic and dependency boundaries first.
- Exact public names/package boundaries and which Gen2 primitives are appropriate to adapt.
- Portable Schema subset and distinct native/wire/storage representations, including numeric semantics.
- Stable identity/serialization rules, law witness typing, evidence provenance, trust policy, and checked-trait derivation.
- Installed Effect/Foldkit versions and precise protocol profiles to pin for compatibility tests.
- Ownership/access modes, escaping captures, and observable runtime semantics for each capability profile.
- Conditions under which fallback preserves semantics, limits, security, and the negotiated protocol.
- Native extension contracts and the compatibility obligations for optional Cruster, syntax widening, and hybrid hosting.
- Operation/service/semantic-runtime registry boundaries, crate/feature metadata, supported adapter profiles, and evidence required to select direct lowering versus a wrapper.
- Migration source-to-IR locations, report schema, versioned diagnostic/fix registry, external engine adapter, evidence thresholds, and editor integration hooks.
