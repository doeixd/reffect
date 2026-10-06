# reffect design documents

Start with [PLAN.md](../PLAN.md) for constraints and the consolidated roadmap. Use [PROGRESS.md](../PROGRESS.md) for implementation status.

**[Streaming RPC and interruption](research/streaming-rpc.md)** is the milestone 6 research and design: the Effect v4 HTTP stream wire format, NDJSON framing, disconnect as interruption, and the first Stream subset.

**[Native Remote Live](research/remote-live.md)** is the milestone 7 research and design: upstream's `liveHub` semantics, `R.LiveHub` signals, the native hub and the runtime-served `FoldkitRemoteLive` stream.

**[Milestone 8B: SSR source to R](research/ssr-codemod.md)** identifies the pinned upstream `examples/ssr` source, the R surface it lacks, and the translator decisions (TypeScript 7 API, `@foldkit/ui` translated, `InnerHTML` supported).

**[Milestone 10: SchemaBinary](research/schema-binary.md)** serves `RpcSerialization.layerSchemaBinary` natively (first slice delivered): generated transcoders, an exact canonical encoder and byte equality with the official server, and the upstream request-defect bug it works around. The [wire format](research/schema-binary-format.md) is specified from Effect 4.0.0's source and probes.

**[The reffect CLI](research/cli.md)** records `reffect check|build|run`: the entry contract, the owned incremental crate directory, diagnostics and the launcher.

**[Milestone 11: RPC over WebSocket](research/websocket-rpc.md)** records Effect 4.0.0's socket protocol (sessions, acked streams, ping, interruption) and the plan for a native WebSocket transport. Server push and reverse RPC are deferred: 4.0.0's stock client cannot receive them.

**[Serving native RPC](research/rpc-serving.md)** covers connections, read timeouts and threading for generated servers ([#16](https://github.com/doeixd/reffect/issues/16), [#25](https://github.com/doeixd/reffect/issues/25)).

**[Composite recovery refinement](research/retained-composite-recovery.md)** explains ordinary Remote mutation admission versus cancellation-retained failures during masked suspension.

**[Generated Deferred lowering](research/deferred-generated-lowering.md)** records the private inline-owner/helper integration profile and its ordering, cancellation and cost gates.

Its implementation decisions are recorded separately for [helper borrows](research/deferred-generated-helper.md), [All cancellation](research/deferred-generated-runtime.md) and [independent conformance/costs](research/deferred-generated-conformance.md).

[Helper capture minimization](research/helper-captures.md) records the private calling-convention optimization and its lexical binding and cancellation requirements; [growth measurements](research/helper-capture-costs.md) define depth budgets and allocation attribution.

[Nested Deferred integration](research/deferred-nested-integration.md) records the private initial Race boundary, with separate [topology](research/deferred-nested-topology.md), [lowering](research/deferred-nested-lowering.md), [runtime](research/deferred-nested-runtime.md) and [conformance](research/deferred-nested-conformance.md) decisions.

[Nested future storage](research/nested-future-storage.md) records caller-pinned child borrows, actual layout reduction and the fixture regression budget; [independent layout research](research/nested-future-layout.md) explains the ownership and pinning evidence.

[Standalone Deferred execution](research/deferred-execution-boundary.md) establishes an internal owned scheduler/context boundary, with its [primary-source context audit](research/deferred-context-audit.md). The Effect-valued research entry remains conditional; [private interruption-frame contract](research/deferred-interruption-frames.md) records exact bounded trails, observer budgets and scope-indexed shared paths. Public admission remains gated.

[Private generated Deferred growth](research/deferred-generated-growth.md) separates whole-graph/helper nesting, expression/text expansion, module aggregation and emitted Rust limits from evaluator receipts and measured future layouts.

[Private Deferred native layout admission](research/deferred-native-layout.md) records the exact-root compile-time size ceiling and its native build boundary.

**[Native Foldkit SSR](research/native-ssr.md)** is the milestone 8A research and design: upstream `renderToString`, serializer and hydration semantics (foldkit 0.165.0), `R.Html` views mirroring Foldkit's builder, a bounded profile, and a ported serializer subset.

**[SSR with Remote data](research/ssr-data.md)** is the milestone 9 plan: upstream prefetch and snapshot resume, native projections in R views, async pages, and the decision to take milestone 9 before 8B.

**[Open work](open-work.md)** registers everything still to be done — deferred slices, open questions, refusals expected to widen, owed measurements and future milestones — each linked to the record that owns it.

The roadmap governs current sequencing and the active frontier. The [design revision overview](op-expr-revision-convo.md) explains historical changes; use it as architecture background, not a prerequisite archaeology exercise.

[Parallel Effect module work](effect-modules.md) tracks the resource lifetime, Context/Layer, error recovery and Schema implementation batch, with per-module decision records for later review.

[Effect v4 coverage and priorities](effect-module-coverage.md) inventories every installed module namespace and orders remaining work by semantic dependencies, independently of the core roadmap. [Module expansion preparation](research/module-expansion.md) records this batch's coordination and admission decisions. [Lexical Ref implementation](research/ref-module.md) defines the bounded sequential state profile and its ownership gates.

The bounded [Clock/Random profile](research/clock-random-modules.md) now has separate [implementation](research/runtime-services-implementation.md), [native drivers](research/runtime-services-lowering.md) and [conformance/cost evidence](research/runtime-services-conformance.md) records. [Structured task kernel preparation](research/structured-concurrency.md) defines the first Unit/Never All/Race slice, independent cancellation and awaited cleanup; [conformance and measured costs](research/structured-concurrency-conformance.md) record the delivered bounds. The next-family records define [coordination](research/coordination-modules.md), [channels/streaming](research/channel-stream-modules.md) and [configuration/caching](research/config-cache-modules.md). These are implementation designs and semantic gates, not runtime support claims.

The module records cover [Option](research/option-module.md), [Result](research/result-module.md), [Exit/Cause](research/exit-cause.md), [Effect control flow](research/effect-combinators.md), [collections and predicates](research/collection-combinators.md), and [Duration configuration](research/duration-module.md). Each records its bounded API, costs, refusals and conformance evidence. Fallible structured tasks have separate [core](research/fallible-core.md), [fallible concurrency semantics](research/fallible-concurrency.md), [native](research/fallible-native.md) and [conformance](research/fallible-conformance.md) decisions; [lexical coordination](research/lexical-coordination.md) prepares Deferred and scoped Semaphore ownership. Deferred has separate [core](research/deferred-core.md), [native](research/deferred-native.md) and [conformance](research/deferred-conformance.md) preparation; synchronous broadcast ordering remains an admission gate. The [automatic-yield budget audit](research/deferred-budget.md) supplies a private, conditional operation-expansion checker and explicit unaccounted-node refusals. The [shared outcome-analysis record](research/retained-outcomes.md) owns the compiler admission and reachability rules. Retained-outcome repair has [native](research/retained-outcomes-native.md) and [conformance](research/retained-outcomes-conformance.md) decision records. The [retained-outcome host record](research/retained-outcomes-host.md) defines RPC refusal independently of declared error channels. The [ownership/outcome audit](research/deferred-ownership.md) records cancellation-retained failures independently of declared error channels. The [private core record](research/deferred-integration-core.md) owns lexical handle/IR/reference decisions. Private integration also has [native adapter](research/deferred-integration-native.md) and [admission](research/deferred-integration-admission.md) records. The [private integration pipeline](research/deferred-integration-pipeline.md) defines reference execution, provenance/resource traversal and the explicit native admission gate. The [inline owner-state record](research/deferred-state.md) separates retained outcomes and ordered removable registrations from scheduler admission. The [turn protocol](research/deferred-turns.md) and [bounded kernel experiment](research/deferred-turn-prototype.md) records the next internal adapter and its validation limits.

[North-star acceptance input](north_star.md) preserves the proposed Foldkit SSR corpus/migration acceptance test. It is design input; verify its external claims before using it as roadmap direction.

[Qwik optimizer closure-conversion research](research/qwik-closure-conversion.md) studies Qwik v2's Oxc/SWC capture analysis as prior art for milestone 8B. It recommends boundary-driven free-variable analysis and explicit reffect CapturePlans while normally erasing, rather than serializing, runtime closures.

[**R language direction**](r-language.md) defines the tiny semantic core: TypeScript is the macro/metaprogramming language; R keeps Match as its branch primitive, ordinary callable functions as statically resolved calls, compiler-discovered recursion/proper-tail lowering, and Effect semantics. Loop/use/let/if-like ergonomics stay in user land; richer native types and extensions remain orthogonal.

## Revised design and implementation references

**[Native divergences](native-divergences.md)** is the one register of observable differences between native artifacts and official Effect/Foldkit, with closed entries and the compile-time profile. Check it before deploying, and add to it whenever a decision accepts a difference.

The later [runtime lowering reference](runtime-lowering.md) integrates the supplied Rust-substrate conversation once. It extends implementation selection and registry guidance while retaining the revised milestone sequence.

| Document                                                          | Focus                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Revision overview](op-expr-revision-convo.md)                    | Changes, reading order, and precedence over earlier proposals                               |
| [Revised compiler design](compiler-design-revision.md)            | Semantic kernel, representations, Operation/Law/Trait, compiler stages, API, and CLI        |
| [Revised implementation milestones](implementation-milestones.md) | Detailed milestones 0–15, ownership, RPC/Remote/SQL/streaming/SSR, and later targets        |
| [Conformance and diagnostics](conformance-and-diagnostics.md)     | Test obligations, diagnostics, postponed scope, condensed sequence, and todo-fullstack      |
| [Foldkit IR design](foldkit-ir-design.md)                         | Expr/Query reuse, symbolic inputs, dependency/support analysis, normalization, and identity |
| [Gen2 semantic kernel](gen2-semantic-kernel.md)                   | Typed law witnesses, evidence policy, checked traits, representations, and planning         |
| [Reuse strategy](reuse-strategy.md)                               | Adaptation, public contracts, semantic ports, and deferred common-kernel extraction         |
| [Cruster backend](cruster-backend.md)                             | Optional distributed/durable capabilities and isolation from local execution/browser RPC    |

## Observability design and research

[Observability, logging and source diagnostics](observability.md) defines typed semantic records, provenance/source maps, logical versus native stacks, scoped log/span context, OTel policy/propagation/metrics, selected Rust tools, optional dependency profiles and acceptance/delivery gates. It is the current observability design direction; source artifacts, logical frames, bounded failure construction, independent frame stripping and scoped logging are implemented for the scalar profile, with synchronous authenticated RPC request/log correlation now implemented. The bounded Sleep/Ensuring async context and cooperative cancellation slice is implemented; general Scope, propagation and exported telemetry remain planned.

[Observability research](research/observability.md) records pinned Effect RC.118 behavior, primary Rust/OTel/W3C sources and observed releases, alternatives and compatibility gaps checked before integration.

[Source maps and authored diagnostics](source-maps.md) records the implemented explicit builder/range/build-diagnostic foundation and defines planned standard JS maps, authoritative IR-to-Rust provenance/ranges, optional native symbols, MagicString/AST boundaries, coordinate conversions, artifact/privacy policy and delivery gates. It extends the observability design without widening the supported source syntax.

[Source-map research](research/source-maps.md) records standards, coordinate units, MagicString/map-tool versions, compiler and native symbol boundaries, alternatives and acceptance evidence.

[Failure frame research](research/failure-frames.md#construction-bounds-and-frame-policy-preparation--2026-10-01) records the bounded capsule/frame opt-out design, primary layout sources and conformance gates. The [native cost probe](../packages/reffect/scripts/frame-cost.ts) reproduces allocation/layout and release timing observations.

[Metadata ownership and costs](metadata-cost.md) explains current compiler/native storage, measured annotation/build overhead, WeakMap tradeoffs, plain native values, independent opt-out policies and failure/context allocation gates. [The research](research/metadata-and-editor-tooling.md) records checked Rust/Volar interfaces and the reproducible probe.

[Editor tooling and Volar](editor-tooling.md) selects a compiler-diagnostic/preview-first path and optional virtual-document integration, with explicit mapping/feature/checker boundaries.

[Typed Rust emission](rust-emission.md) guides composable internal identifier/type/expression/item helpers around the existing IR/source writer as new lowering needs them.

[Rust emission research](research/rust-emit.md) records the helper roles, escaping/format contracts, alternatives and byte-identical migration acceptance for the internal `Rs` module.

[Facet evaluation](research/facet.md) checks static Rust type reflection against metadata ownership and future Schema/codec consumers. Facet remains an optional candidate; source occurrences/Effect semantics and protocol conformance stay compiler-owned.

## Async execution and performance

- [Suspended RPC research](research/async-rpc.md): owned context, cooperative interruption and awaited non-failing finalization, with reference/native/socket evidence.
- [Scoped heartbeat](research/heartbeat.md): bounded sequential finalizer specialization, spaced repetition and a standalone native lifecycle example.
- [Bounded Schedule](research/schedule.md): `recurs`/`spaced`/`exponential`/`forever`, `repeat`/`retry`, frame handling and a concrete native loop.
- [Scoped native files](research/scoped-files.md): real read-only handle ownership, borrowed use, acquisition masking and closure gates before general Scope registration.
- [Dynamic resource Scope registration](research/resource-scope-registration.md): implemented bounded lexical profile — lexical `scoped`/`addFinalizer`/scalar `acquireRelease` and `RegisteredFile` with compiler-proved capacity, registration-time context and masked LIFO close. Manual/child/parallel Scope, Exit-aware cleanup and resource Layers remain later gates; the provisional preparation is retained as archive within that record.
- [Resource-bearing Layers](research/resource-layer.md): scoped `Layer.effect` acquisition in a provide-owned scope, fallible acquisition, shared/fresh/nested memo inheritance and the registered-file size workload.
- [Well-formed strings](research/string-profile.md): `R.String` semantics compared across UTF-16/UTF-8, literal `replaceAll`, owned/borrowed lowering and the Foldkit escaping differential.
- [JS numbers](research/number-profile.md): `R.Number` as IEEE doubles, pinned `Schema.Number` JSON codec rules (non-finite strings, `isInt`/`isFinite`), structural check recognition and JS-compatible encoding.
- [Native types](research/native-types.md) (earlier research, updated by [R language direction](r-language.md)): JS-type Rust crates and representation details feeding the planned native type batch.
- [Remote benchmark](research/remote-bench.md): native versus official Remote server memory, HTTP and in-process engine timings, the client-bound caveat, and optimizations (query cell cache, in-place merges, allocator finding).
- [Remote mutations, Store and authorization](research/remote-mutations.md) (proposed): R-authored mutations over a native `RemoteStore` service, typed-to-`Unknown` encoding, and authorization as compiled R functions (milestone §21).
- [Literal unions](research/literal-unions.md): `R.Literals([...])` string literal unions as Copy Rust enums, and their RPC codecs.
- [Raw Unknown](research/unknown-json.md): `R.Unknown` as JSON data normalized like `JSON.parse` (doubles, JS key order), a derived JSON capability and `serde_json` dependency, and the open plain-`Schema.String` question for Remote requests.
- [TaggedError classes](research/tagged-errors.md): `Schema.TaggedError` error unions as R tagged-union cases with verified round trips; plain `Schema.String` in encoded positions; JS boundaries build instances.
- [Array length checks](research/array-length.md): decode-only `isMaxLength`/`isMinLength`/`isBetweenLength` on `Schema.Array`, verified against Effect filters; checks run after elements, and the first failure wins.
- [String-keyed records](research/records-js-order.md): `R.Record(R.String, V)` with `keys`/`values`/`size`/`has`, JS own-property key order natively (`preserve_order` plus index-key partitioning), and record codecs.
- [Optional fields](research/optional-fields.md): `R.optional`/`R.optionalKey` struct fields and `R.UndefinedOr`, native presence (`Option`/`Option<Option>`), and the verified `| null` mismatch text of `Schema.optional` JSON codecs.
- [Milestone 5: Remote over SQL with SQLx](research/sqlx-remote.md) (accepted): SQLite first with the Drizzle-backed server as oracle, storage metadata from `foldkit-remote-drizzle` bindings, keyset paging, upserts in per-mutation transactions; SQLx 0.9.0.
- [Native RemoteServer design](research/native-remote.md): proposed semantic-port engine, generated wire codecs, JS ordering rules, memory backend first and the differential harness.
- [Milestone 4 gap analysis](research/remote-gap-analysis.md): Remote wire features still missing, probed Number/optional/Record semantics, and why the native engine design comes next.
- [Arrays and structured iteration](research/arrays.md): `R.Array` mirroring `effect/Array`/`Schema.Array`, structured loops, `Effect.forEach` and exact RPC array codecs.
- [Records and tagged unions](research/records-unions.md): proposed Struct/TaggedUnion witnesses, matching, ownership and RPC codecs for the milestone 4 gate, grounded in the `foldkit-plus` Remote wire schemas.
- [North-star review](research/north-star-review.md): verified/adopted claims from the north-star and runtime-strategy inputs, and open roadmap questions. The [Foldkit SSR inventory](research/foldkit-ssr-inventory.md) measures the pinned upstream server graph.
- [Server-lifetime RPC services](research/server-layer.md): layers built once at native server startup, `bindServices`, startup failure and graceful shutdown ordering matching `RpcServer`.
- Scope preparation evidence: [pinned reference semantics](research/scope-reference-evidence.md), [native storage/lifetimes](research/scope-native-evidence.md), and [registered-file workload](research/scope-workload-evidence.md).
- [Runnable registered-file Scope](../examples/scope-registration/README.md): bounded sequential registration with a real read-only file retained through outer scope exit.
- [Runnable async example](../examples/rpc-async/README.md): unchanged stock authenticated client calling suspended native handlers.
- [Runnable scoped-file RPC](../examples/rpc-files/README.md): a native handler owns a real read-only file across suspension and closes it before cleanup.
- [Performance requirements](performance.md): workload measurements, structural growth/allocation gates and exploratory baselines.
- [Async cost probe](../packages/reffect/scripts/async-cost.ts) and [raw results](research/async-cost-results.json): release future/context layouts and construction allocations.

## Original detailed references

| Document                                        | Focus                                                                                                                       |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [Compiler architecture](architecture.md)        | Full compiler thesis, typed DSL/IR, Schema, ownership, Effect runtime semantics, platform backends, and original milestones |
| [RPC MVP](rpc-mvp.md)                           | Shared Effect contracts and the first native unary RPC demonstration                                                        |
| [RPC protocol and transports](rpc-protocol.md)  | Streaming, middleware, cancellation, bidirectional sessions, serialization, and transport profiles                          |
| [Compiler library API and CLI](compiler-api.md) | Effect-based compiler services, build specifications, stages, diagnostics, watch/dev, and CLI                               |
| [Foldkit SSR and SSG](foldkit-ssr.md)           | Native server rendering and compatibility with the existing browser hydration protocol                                      |
| [Foldkit Remote and SQL](foldkit-remote.md)     | Native RemoteServer, Entity/Query semantics, Sources/storage, SQLx, live data, and SSR resume                               |

These six documents preserve the original PLAN.md discussions. The seven extracted revision documents preserve the later conversation, including its final revised plan. All retain code samples, diagrams, and provisional APIs; some include unresolved citation placeholders or historical repository/licensing observations. They describe intended behavior, not implemented support or verified upstream facts. Use the roadmap for current sequencing and verify dependency-specific claims before implementation.

Edit the individual documents directly as the design evolves. Keep the roadmap and this index aligned with document names and scope.

Section-local **Later update** notes link earlier proposals to the specific revised decisions or extensions that affect them. Notes identify superseded sequencing where relevant; preserved examples still describe proposals, and a link does not establish implemented support. Use [AGENTS.md](../AGENTS.md#project-goal) for the current reffect/R naming decision.

## Runtime lowering reference

[Lowering Effect onto the Rust ecosystem](runtime-lowering.md) covers the candidate crate/primitive catalogue, direct lowering versus adapters versus dedicated runtime, operation/service/semantic registry families, Layer wiring, Ref specialization, caches/pools, batching, schedules, streams, and support reporting. The duplicated pasted conversation is integrated as one edited reference. Candidate mappings and research leads require verification; coverage percentages are not measured support.

## RPC conformance

[Unary RPC foundation](research/unary-rpc.md) records pinned HTTP/JSON and Schema contracts, the portable request/response corpus, stock-client/reference-server tests, the generated native scalar HTTP profile, and its real-socket debug/release acceptance evidence.

[Authenticated RPC research](research/rpc-auth.md) defines the checked bearer adapter, principal service projection, runtime credentials and request/log ownership gates.

[Cookie sessions research](research/cookie-sessions.md) (#4) proposes how authenticated pages and the hydrated browser client authenticate with an HttpOnly session cookie, with the CSRF defences mutations then need.

## Kernel research

[Unit semantics and representation](research/unit.md) records exact undefined admission versus Effect's discarding Void schema, Rust unit lowering, internal bridge tokens and composition conformance.

[Bounded logical failure frames](research/failure-frames.md) records explicit-boundary frame semantics, the Effect span-chain oracle, the stderr companion envelope and reference/native path agreement.

[Scoped logging preparation](research/logging.md) records the Effect Logger/level/annotation oracle, the `R.Log` node design, stderr JSON records and conformance obligations.

[Upstream reconciliation](research/upstream-reconciliation.md) records the retained dynamic Query/Effect/source paths, local prototype preservation, dependency choices, reachable-data validation and Windows failure-test budgets.

[IR function composition](research/flow-composition.md) records why `flow` could not compose `R.fn` values and the implemented bounded substitution-based `R.flow`, keeping plain composition in `effect`.

[Named function calls and recursion](research/function-calls.md) preserves the earlier deferred-call analysis and per-pass blast radius; [R language direction](r-language.md) now promotes named monomorphic calls and proper tail recursion into the planned language foundation while keeping first-class function values out of scope.

[Source-artifact policy preparation](research/source-artifact-policy.md) records the independent Full/None request policy, honest artifact types, skipped provenance/writer/hash work and validation before implementation.

[Basic Effect IR research](research/basic-effect-ir.md) records the synchronous Boolean/u64 success/failure profile, lexical continuation scopes, Result lowering and milestone 2 conformance obligations.

[Semantic kernel bootstrap research](research/semantic-kernel.md) records the milestone 0 numeric semantics, pinned Effect v4 API checks, kernel/registry boundaries, and differential/native acceptance criteria.

[Foldkit Query native bootstrap](research/foldkit-query.md) records pinned upstream IR/fixtures, encoded-value semantics, representation limits, the native evaluator bridge, and three-interpreter validation for milestone 1.

[Foldkit-Plus issue record](research/foldkit-plus-issues.md) documents confirmed upstream discrepancies, traversal/mutability/reporting limitations, and package compatibility findings with reproductions.

## Effect ecosystem reference

Pinned external API/ecosystem surveys used for research and design checks. They describe upstream packages and third-party projects, not implemented reffect support; verify claims against the installed dependency version before acting on them.

[Effect v4 API scope](effect-v4-api-scope.md) maps `effect@4.0.0-rc.115` modules, v3→v4 renames, idioms and companion packages.

[Effect Schema](effect-schema.md) covers the v4 Schema API and ecosystem, including the standalone-to-core history and decode/encode split.

[Effect ecosystem](effect-ecosystem.md) maps official v4 packages and verified community libraries (jobs, Cloudflare, Alchemy, agents, durable streams, SQL, TUI, frontend), plus a weekly-digest digest.

[Effect-adjacent projects](effect-adjacent-projects.md) surveys auth, payments, infrastructure, database and agent projects for stack fit against Effect v4.

## Migration tooling and research

[Compiler-guided migration tooling](migration-tooling.md) integrates the migration conversation: an external codemod engine, compiler-owned compatibility reports, target reachability, mechanical/guided/architectural transformations, diagnostic-linked fixes, JSON/editor/agent workflows, and semantic validation. Commands, packages, and the future migration skill are proposals.

[Migration tooling research](research/migration-tooling.md) records prior-design review, primary-source checks, versions/date limits, alternatives, rationale, acceptance, and open questions before design integration. It distinguishes native representability from rewrite equivalence and corrects the Grit organization versus successor-project maintenance assumption.

## One-time extraction scripts

[scripts/Split-Plan.ps1](../scripts/Split-Plan.ps1) requires a copy of the original, unsplit plan and a destination directory without its six files:

```powershell
./scripts/Split-Plan.ps1 -SourcePath <original-plan.md> -OutputDirectory <destination>
```

The script validates all six boundaries, refuses to overwrite existing documents, and checks that the extracted bodies reconstruct the source exactly before adding titles, navigation, and contents links. Do not run it on the new roadmap or use it to regenerate maintained docs.

[scripts/Split-DesignConversation.ps1](../scripts/Split-DesignConversation.ps1) applies the same preservation/refusal checks to the seven conversation sections:

```powershell
./scripts/Split-DesignConversation.ps1 -SourcePath <original-conversation.md> -OutputDirectory <destination>
```

Use an original, unsplit conversation copy as input. The current op-expr-revision-convo.md is an overview, not an extraction source. Extraction preserves bodies exactly before repository formatting; maintain the formatted documents directly afterward.

- [Effect v4 workstream handoff](effect-v4-workstream.md): resume instructions, implementation file map, admission gates and next module priorities.
- [Public Deferred execution](research/deferred-public-execution.md) and [compiler admission](research/deferred-public-admission.md): bounded authoring, owned reference context and native build contract.

- Scoped Semaphore preparation: [slice](research/semaphore-scoped-slice.md), [IR](research/semaphore-ir.md), [traversals](research/semaphore-traversals.md), and [scheduled native adapter](research/semaphore-native.md). The latter records the inline scan prototype, wake-all counterexample and remaining static-driver gates.
