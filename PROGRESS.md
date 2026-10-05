# Progress

## 2026-10-05 — Standalone Deferred execution contract

- Synced through 9c3a6ee and installed dependencies. [DEXEC-001–004](docs/research/deferred-execution-boundary.md) and the independent [DCTX-001–005 audit](docs/research/deferred-context-audit.md) record the preparation: initial fiber evaluation precedes startup/signal hooks, ambient guards are too late, and an isolated Promise boundary adds no evaluator primitives to the audited named interpreter.
- Delivered private `DeferredExecution.run/runWithFrames`: synchronous profile validation, fresh default scheduler/context with 2048 budget and automatic yielding enabled, owned immutable log observations, and a closed branded AbortSignal option. Custom contexts/runtime options are refused before authored work; pre-aborted signals return interruption without starting. Suspended interruption awaits cleanup. No raw Fiber, caller callbacks or native representation changes are introduced.
- Context/refusal/cancellation/budget validation passes 18/18 across three suites (3.78s), with independently authored official waiter-prefix traces and both diagnostic policies. Delegating scheduler observations corroborate actual default settings and below-limit operation counts; over-limit source is rejected before any fiber starts, and the prior independent long-workload test still observes real automatic yielding. Strict package TypeScript passes. Initial post-commit regression passes 36/36 across six files (118.32s), including actual native nested build/frame ordering and the storage budget. Review additionally closes extensible expression-reference callbacks: only exact builtin operation/type identities and scalar expression forms are permitted in this standalone runner (DEXEC-005). The expanded boundary/budget/admission checks pass 19/19 (10.61s); four test lint warnings are corrected without suppression. Final post-review checking follows before publication.
- The composable private reference remains conditional. Public context-policy integration, exact interrupted frames/Cause, richer retained outcomes and general graph storage bounds remain gates before public Deferred authoring; see [open work](docs/open-work.md).
- Reviewed implementation validation passes 37/37 across six suites (114.78s), including all 16 native nested frame/build cases and both owned execution policies; strict TypeScript and rebuilt workspace pass. Synced the RPC Fetch-text decoding fix through 2d42158 without changing either local implementation patch. A remaining clock-test method-reference warning is fixed by retaining the original mock; final focused checks follow before publication.

## 2026-10-05 — Borrowed nested future storage

- Synced the SSR divergence record through 85ea2c3 and installed dependencies. [NSTORE-001–004](docs/research/nested-future-storage.md) record the design before implementation; independent [NFL-001–003](docs/research/nested-future-layout.md) confirm repeated owned async future storage with standalone Rust debug/release pinning experiments.
- Private generated groups now own/pin children locally and lend `Pin<&mut F>` to the driver. Existing whole-task acknowledgements, primitive suspension, routing, cancellation, cleanup and public refusal are unchanged. Review verifies the borrowed lifetime ends within the same generated block before any authored continuation; no Box, new context field, scalar metadata or unsafe generated projection is added.
- Actual nested invocation futures shrink approximately 65–68%: isolation 42856/43624 → 14976/15248 bytes (None/Bounded), sequential reuse 32832/33344 → 10520/10712, parent interruption 36872/37536 → 11912/12128. Context and whole-drive allocation counts are unchanged in debug/release. The fixture regression budget is `2560 * sizeof(usize)`; the prior actual emitter demonstrably fails it (42856 > 20480), and temporary baseline files are removed.
- Initial semantic/native runtime validation passes 5/5 across two suites (114.66s), including 16 generated build/frame cases and repeated cleanup witnesses. Post-commit validation passes 25/25 across seven suites (212.88s): the new storage gate, exact nested traces, prior generated conformance, quiet zero-allocation/capture growth, profile/public refusal and emitted Rust. Full checking passes 437 formatted files/260 TypeScript files; strict package TypeScript and the rebuilt workspace pass. Committed diff review finds no further issue.
- Synced subsequent Live snapshot fixes through 6e383a8; the optimization patch is unchanged by rebase and the generated runtime-source parity test passes 1/1. Public Deferred scheduler-context enforcement, richer outcomes/diagnostics and general graph growth remain open.

## 2026-10-05 — Private nested Deferred Race

- Synced at b1848e2 and installed dependencies. [Integration preparation](docs/research/deferred-nested-integration.md) records DNI-001–004 before integration edits: bounded outer All with initial inner Race, separate static context identities, private checked reference evaluation, awaited loser cleanup and retirement before reuse. Parallel topology, lowering, runtime and independent conformance work records its decisions separately; public Deferred admission remains gated.
- Delivered occurrence-specific contiguous routing, Never-error nested Race under outer All2/3 (at most six contexts), priority propagation through ancestor drivers and awaited loser finalization. Synchronous winners skip unstarted later children. The private reference entry reuses ordinary evaluation with checked profile admission; public compiler/reference wrappers retain their refusals. Nested All, deeper/multiple Race, callback startup and cleanup-created groups remain refused.
- Independent official/private plain/private framed/generated traces agree across four workloads and 16 native frame/build cases: producer-first/last isolated cancellation, surviving waiter, retained/losing U64 completion, drained sequential timer-group slot reuse and parent cancellation. The expanded suite passes 4/4 (62.75s); focused runtime debug/release witnesses pass 1/1 (17.02s), and root capture/profile/topology/public checks pass 21/21.
- Logging/timer nested fixtures measure 32832–43624-byte invocation futures with the unchanged 96/104-byte context. Whole-drive counts include logs, timers, watch channels and executor activity; owner/bank storage remains inline and no scalar gains metadata. Future reduction/growth budgets remain a public performance gate, recorded in the cost and open-work docs. Full checking passes 430 formatted files/256 TypeScript files; strict TypeScript and rebuilt workspace pass.
- Merged legacy validation passes 34/34 across ten files (136.31s): quiet capture-growth/zero-allocation, prior generated Deferred, runtime/prototype, retained-outcome, public refusal, operation-budget, topology/profile and capture suites. The private reference shim adds no successful-path Effect wrapper or scheduler operation; ordinary/reference admission and unrelated emitted artifacts remain unchanged. Post-commit review and checks follow before publication.

## 2026-10-04 — Generated helper capture minimization

- Synced upstream SSR host extraction through e7a4214 and installed dependencies; native HTML page/runtime-source validation passes 3/3 across two files (27.11s). Core-plan ownership remains with the other instance.
- [Capture preparation](docs/research/helper-captures.md) records HCAP-001–003 before implementation: prune private helper argument lists by semantic binding identity, preserve full lexical lookup and memoization scope, and retain execution context/turn behavior. Rust async functions retain unused arguments, making compiler-side capture selection meaningful. Parallel lowerer and cost work verified transitive captures, emitted behavior and future-size growth; public Deferred admission remains gated.
- Delivered private effect/pure helper signature pruning, including transitive scalar reads, lexical owner references and immediate finalizers. Complete scopes and memo identities remain unchanged; ordinary emitted signatures and plain scalar/context representations are preserved. HCAP-004 records bounded quadratic compiler traversal and defers dependency-summary memoization until measured need.
- [Native growth/cost matrix](docs/research/helper-capture-costs.md) passes 2/2 (52.20s), debug/release × None/Bounded: depth-16 unused-scalar future sizes shrink 2840→1368 and 3120→1648 bytes. All 2800 quiet invocations, including first executions and a captured scalar/owner finalizer, allocate zero times after executor/watch/context construction. HCOST-005's relative growth budget demonstrably fails the old lowerer (1920 > 1600); exact sizes remain observations. Focused capture/profile/emission tests pass 12/12; strict TypeScript and builds pass.
- Semantic/resource, capture/profile, public refusal and emission regressions pass 26/26 across seven suites (210.75s), including debug/release and both frame policies. Synced the subsequent SQL runtime extraction through f2af4ec and reinstalled dependencies; strict TypeScript and rebuilt workspace pass. Formatted the upstream SQLx manifest line without changing dependencies/features and fixed the new test's numeric-sort lint warning. Synced runtime-source/SQLite/Postgres integration passes 3/3 (149.33s).
- Pre-commit full checking passes 422 formatted files and 253 TypeScript files with no warnings or errors. Quiet-cost and semantic matrices retain both frame/build profiles; the generated module remains private and the next semantic gate is bounded nested Race with independent waiter cancellation.
- Post-commit review of the implementation finds no remaining issue. Capture cost/semantics, profile, public refusal, emission and runtime-source checks pass 22/22 across seven suites (97.95s), including the repeated native cost/order/cancellation matrices. Full checking again passes 422 files and 253 TypeScript files with no warnings/errors; strict TypeScript and builds pass (4/4 build cache hits). Decisions and remaining optimization/admission gates are indexed in the docs and open-work record. Publication also preserves the later page-data engine extraction and #37 record through 427def9.

## 2026-10-04 — Private generated Deferred lowering

- Synced through 095c3bd and installed dependencies, preserving upstream bounded Live queues and structured RPC emission. [Generated lowering preparation](docs/research/deferred-generated-lowering.md) records DGEN-001–005 before edits: private checked backend entry, inline owner/helper borrows, bounded unnested infallible All2/3, actual context cancellation and explicit public/default-context gates.
- Parallel lowering, bank-aware All runtime and independent conformance work will connect the verified private components. Root owns profile validation, integration and cost/refusal boundaries; public Deferred authoring and native compilation remain gated.
- Concrete decisions are recorded in [helper captures](docs/research/deferred-generated-helper.md), [All cancellation/runtime](docs/research/deferred-generated-runtime.md) and [independent conformance/costs](docs/research/deferred-generated-conformance.md). The private profile validates lexical captures, Never errors, finite task capacity and conditional plain/framed operation budgets before sharing the ordinary emitter; unsupported groups/resources/iterations remain explicit refusals.
- Delivered inline owners and invocation bank, separate borrowed helper captures, semantic Sleep/Await, masked completion and bank-aware All2/3 that waits for interrupted children/finalizers. Sequential Bool/U64/Unit owners are supported privately too. Ordinary lowering and Compile.plan remain gated. Root review aligned diagnostic frame kinds and pruned unused prototype/ordinary coordinator families while preserving mapped provenance.
- Five independently authored workloads match official/plain/framed/generated observations in debug/release × None/Bounded. Quiet first-execution measurement over 100 actual generated Bool-owner invocations allocates zero times in every matrix cell. Measured group futures are 8456–9200 bytes; logging-module AsyncContext is 96/104 bytes, with no coordinator fields. Full harness costs and attribution limits are recorded; future/capture growth remains a public optimization gate.
- Merged generated profile/conformance/runtime, prior coordinator, retained-outcome conformance, public refusal, Rust emission and RPC host tests pass 24/24 across eight files (167.22s). Root check passes 418 formatted files and 251 TypeScript files; strict package TypeScript and builds pass (reffect rebuilt, 3/4 cache hits). Synced the later RPC runtime extraction through 3dd2f7c, preserving its records and core-plan ownership; serving integration and post-commit verification follow before publication.
- Post-commit generated/profile/runtime, original coordinator, public refusal and emission tests pass 18/18 across six files (73.30s); synced RPC serving/runtime-source checks pass 3/3 across two files (51.60s). Full checking exposed only the newly synced runtime Cargo manifest's long Tokio feature line; the follow-up formats it without dependency changes and repeats checking, strict TypeScript/builds and relevant boundary/source tests before publication.

## 2026-10-04 — Composite mutation recovery repair

- Synced concurrent RPC batches and the multi-thread runtime through 2c39d21. The reported mutation refusals trace to 1232a77: NativeRemote maps composite RemoteServerError sources to wire errors, and the blanket asynchronous channel-change refusal incorrectly treats suspension before failure as retained-failure suspension.
- Reviewed the installed and published Effect 4.0.0 failure evaluator, getCont and automatic-yield loop before edits. [Composite recovery refinement](docs/research/retained-composite-recovery.md) records the narrow cooperative scheduling proof and conservative masked/group boundaries. Parallel analysis owns that proof; root adds regression coverage and runs the previously blocked mutation suites sequentially. Existing scalar retained-outcome behavior and compound RPC refusal remain required.
- Narrowed changed-error composite guards/refusals with an exhaustive, memoized proof of selected-failure suspension. Ordinary timer/store waits before failure no longer block Remote mutations; awaited cleanup, masked acquisition, resources, groups and Deferred stay conservative. Scalar carrier selection and same-channel guards are unchanged. Two new regressions fail before the repair; focused analysis/host/admission tests now pass 15/15.
- All five formerly blocked suites pass sequentially against the multi-thread runtime: remote-acceptance 2/2, remote-mutate 3/3, remote-sql-mutate 6/6, remote-sql-live 3/3 and todo-remote-page 1/1. The todo test initially failed to locate its template when invoked from repository root; rerunning from its required package directory passes. Updated the serving record to complete #16's pending mutation verification; no GitHub issue state was changed.
- Full formatting across 409 files, lint/types across 246 TypeScript files, strict package TypeScript and workspace builds pass (reffect rebuilt, 3/4 cache hits). Remaining composite retained-payload representation, compound RPC causes and broader coordination remain explicit open work.
- Post-commit review found a composite wrapper could otherwise hide an inner conservatively selected scalar carrier. RCREC-004 keeps scalar async recovery/retry descendants risky and adds a refusal regression, preserving tagged-payload decoding boundaries while ordinary Remote mutations stay admitted.
- First post-commit validation passes 17/17 across analysis/host/admission and retained-outcome native conformance (62.45s), including debug/release and None/Bounded policies; full check, strict TypeScript and builds also pass. The follow-up review regression suite passes 16/16 before its corrective commit.

## 2026-10-04 — Private Deferred IR integration preparation

- [Private core preparation](docs/research/deferred-integration-core.md) records lexical make/flatMap elaboration, opaque handle exclusion, official reference operations and per-await failure frames; make alone and recursive public/payload escape remain refused.
- [Native adapter preparation](docs/research/deferred-integration-native.md) and [admission preparation](docs/research/deferred-integration-admission.md) record private fixed-arity routing, real AsyncContext masking/cancellation, genuine suspension and audited budget/topology boundaries before edits.
- Synced through bedd884, preserving upstream RPC serving limits and installed current dependencies. [Pipeline preparation](docs/research/deferred-integration-pipeline.md) records DPIPE-001–004 before visitor edits. Parallel private authoring/reference, coordinator-runtime and admission work continues the verified owner/turn kernel; public exports and native compilation remain gated until complete ownership/masking/budget/isolation evidence.
- Delivered private scalar Deferred builders and lexical IR, official plain/framed reference evaluation, per-await error frames, recursive handle exclusion, provenance/resource traversal and explicit plan/direct-lowering refusal. Review closed a pure-function opaque-argument escape. Private budget receipts and topology analysis distinguish owner occurrences, leaf slots and task contexts while preserving existing nested-group refusals.
- The unselected real-AsyncContext coordinator matches five independently authored official ordering traces across ten fresh-owner repetitions in native debug/release. It preserves producer interruption/masking and typed retained outcomes without changing the 24-byte AsyncContext; its borrowed turn handle measures 16 bytes. A fixture mismatch confirmed that asynchronous waiter cleanup may finish after producer continuation; independent cancellation needs a separate finalization signal.
- Merged private pipeline/core/admission/budget/coordinator tests pass 23/23 across five files. Existing retained-outcome, fallible-admission and synced RPC serving tests pass 6/6 across three files (105.57s). Generated owner/helper capture and routing, executable default-context budget enforcement, nested Race isolation, compound outcomes and total None/Bounded cost measurements remain admission gates; no public Deferred support is claimed.
- Root review and final checks pass: 23/23 private tests repeated after pipeline corrections (24.96s), full formatting across 408 files, lint/types across 246 TypeScript files, strict package TypeScript and workspace builds (reffect rebuilt, 3/4 cache hits). Decisions are recorded in the four linked integration records; the separately owned core plan is preserved.

## 2026-10-04 — Retained-outcome repair

- [Outcome analysis preparation](docs/research/retained-outcomes.md) records RETAIN-001–005: distinguish declared errors from cancellation-retained failures, propagate build-owned rich requirements, guard typed recovery with the active mask and preserve the existing bounded scalar capacity.
- [Native preparation](docs/research/retained-outcomes-native.md) and [independent conformance preparation](docs/research/retained-outcomes-conformance.md) record RON/RETCONF decisions before feature edits: typed channels stay distinct from retained outcomes, masks govern recovery, Never children can require rich group wrappers, and exact observed Cause policies remain the oracle.
- Synced upstream SSR/live and review corrections through 6b1a691 and installed current dependencies. Parallel compiler-analysis, native-lowering and independent-conformance work addresses DOWN-001–003 before public Deferred integration. [Host preparation](docs/research/retained-outcomes-host.md) records shared outcome-based RPC refusal and existing independent CLI payload decoding; scalar layouts and the unnested three-failure capacity remain unchanged.
- Delivered shared outcome-based carrier/group selection, cancellation-aware scalar CatchAll/Retry and pre-emission RPC refusal for richer outcomes. Root and declared-Never child recovery now preserve earlier scalar failures; changed-error composite sources remain refused. Root review found cleanup-only guard selection could reference an unselected carrier; RETAIN-006 excludes always-masked cleanup while retaining guards for shared unmasked uses. No scalar/context field or new crate was added.
- Independent official/plain/framed/native traces cover 12 workloads, including All versus Race parent cancellation, unchanged and changed error channels, Bool/Unit payloads, loser cleanup, suppressed Retry and masked acquisition recovery/release. Native debug/release and None/Bounded matrix passes 2/2 (64.12s); existing fallible conformance/cost tests pass in the preceding 6/6 run (179.78s), preserving layout/allocation budgets. Analysis/legacy recovery/RPC boundaries pass 12/12; full check passes 394 files/237 TypeScript files, strict TypeScript passes, and workspace builds pass (reffect rebuilt; 3/4 cache hits).

## 2026-10-04 — Deferred integration preparation and owner state

- Remote is synchronized through 4946b9e; installed dependencies are current. The core PLAN/SSR track remains separately owned. Parallel work continues the existing bounded Deferred design: a source-audited automatic-yield budget, lexical ownership/retained-error review, and an unused inline owner-state emitter. Each records decisions before implementation; public Deferred authoring/compiler admission remains gated.
- Review/validation: owner plus turn composition passes 2/2, budget plus retained-outcome regressions pass 8/8, and existing structured/admission/host tests pass 9/9. Root formatting/lint/type check covers 379 files/227 TypeScript files, strict package TypeScript passes, and workspace builds pass (cached). The audit also records a separate root-level retained-failure defect candidate and the proposed nested topology may need four cause slots rather than three; both remain explicit open work.
- [Budget audit](docs/research/deferred-budget.md) records DBUD-001–005 and a private source-expansion checker for the default zero-input reference context. It counts repeated occurrences, caps at 2048 and refuses unaccounted nodes. Scheduler instrumentation verifies the 2047/2048 admission boundary, observed automatic yielding, cleanup/recovery and child cancellation; the checker is not selected by the compiler and has no Deferred-node receipt yet.
- [Ownership audit](docs/research/deferred-ownership.md) found an existing declared-Never child can retain a typed failure when interrupted during awaited cleanup. TURN-013 chooses a conservative checker refusal pending outcome-based carrier selection; The official controlled-clock witness preserves Interrupt plus Fail(7) and skips recovery; reference/compiler refusal and admission boundary regressions pass (7/7 across retained-child, task admission and host refusal). Existing structured tests also pass (9/9 with admission/host).
- [Owner-state preparation](docs/research/deferred-state.md) selects inline retained Copy outcomes, ordered removable task-ID registrations and detached cohorts without cloned Wakers or scalar metadata. The implemented private owner passes debug/optimized Rust, verifies premature destruction is rejected by the borrow checker, and measures zero allocations over 100 isolated complete lifecycles (184-byte owner, 40-byte wait and 128-byte completion for the measured profile). [DTP-006](docs/research/deferred-turn-prototype.md#integration-regression-preparation-2026-10-04) adds direct acknowledgement-isolation regressions: nested requests, successive completion by the same caller, unmarked Pending and reused semantic flags. The new owner now supplies the real-Tokio turn fixture; all seven exact official ordering traces match in debug/release, and state/turn tests pass 2/2 (21.41s).

## 2026-10-04 — Internal Deferred semantic-turn kernel

- Continuing the recorded Deferred scheduling gate after syncing upstream SSR Remote record/replay through cfbb0b8. [Turn protocol](docs/research/deferred-turns.md) and [kernel preparation](docs/research/deferred-turn-prototype.md) record primary sources, a safe Rust prototype, alternatives and DTP-001–005 before source edits. The proposed internal adapter gates fixed-arity polling through an inline task-slot bank; semantic suspension acknowledges a waiter, while nested completion adapter Pending preserves the outer obligation.
- Delivered an internal, currently unselected Rust turn-bank emitter and independent protocol fixtures. All seven official Effect callback traces match native debug/release; safely pinned nested routing, actual Tokio wake/watch/timer progress, complete broadcast under producer cancellation, mask experiments and 100-cycle request/registration reuse pass. This proves the internal protocol experiment, not generated Scope or public Deferred authoring.
- Isolated bank construction/request/acknowledgement/drop uses zero allocations over 100 cycles. Linux Rust 1.98.1 layouts are bank 168 bytes (six slots), state 160 and request 24; measurement excludes executor/watch/trace/owner allocations. Ordinary artifacts do not select this emitter or gain context/payload fields. Root validation passes 5/5 across kernel and existing task admission/host tests (38.25s), strict TypeScript, formatting/lint and workspace builds.
- TURN-009–011 record audited operation-accounting atoms and public Scheduler instrumentation. Large reference graphs do reach the 2048-operation automatic-yield threshold; full Scope/group/Deferred weights remain unproved. This, generated ownership/slot assignment, actual emitted masking and the authored independent-cancellation path remain public-module gates. The cooperative prototype retains task IDs instead of per-waiter Wakers.

## 2026-10-03 — Remote sync and Deferred scheduling gate

- Rebased the fallible task kernel onto upstream through bfb07c0, preserving Remote Live, SSR rendering/hydration/page serving and the separately owned core plan. Resolved the lowerer overlap by retaining RemoteStore live/Get branches and the fallible Repeat projection. Independent integration review found no blocker; NativeRpc's explicit fallible-group refusal covers its live/streaming/page consumers. The synced kernel is published as 2679649.
- Merged validation: 9/9 tests across fallible concurrency/host refusal, Remote Live and HTML page serving (158.17s); strict TypeScript, formatting/lint and workspace builds pass. Post-commit kernel cost/admission/host tests also pass 5/5 (57.29s), retaining the disabled-frame allocation guarantees. The later remote changes were documentation only.
- Deferred preparation is recorded in [core](docs/research/deferred-core.md), [native](docs/research/deferred-native.md) and [conformance](docs/research/deferred-conformance.md) records. Fresh official probes establish registration-ordered synchronous waiter prefixes, including reentrant completion and producer/waiter interruption. [LCOORD-009/010](docs/research/lexical-coordination.md#deferred-completion-scheduling-gate-2026-10-03) reject simple Waker broadcast, a single producer yield and acknowledgement at Await.poll as sufficient adapters.
- Next gate: a safe, bounded semantic continuation-turn protocol, distinguishing genuine Effect suspension from adapter-internal Pending, with static lifetimes and separate waiter/turn-stack cost bounds. Deferred and Semaphore feature source remains unadmitted; authoring/test drafts are outside the repository. Scalar payloads remain plain and no global scheduler/registry is approved.

## 2026-10-05 — Page views decoded by their selection (#6)

- **#6.** The design is in [ssr-data research](docs/research/ssr-data.md#view-witnesses-from-the-selection-6-2026-10-05).
  - **Plan:** `planPage(Data, initial, { todos: list })` records each projection's selection schema.
  - **Views witness:** `NativeRemote.pageViews(plan)` derives it, so a page request must read exactly those views. That replaces the name-only check.
  - **Decoding:** items reach the R view decoded, as upstream's `decodeRow` decodes them.
  - **Examples:** the `todo-remote` example and `remote-page` now derive their views instead of declaring them.
- **Validation.**
  - New `remote-page-decode` test: a `U64Json` field renders byte-equal to upstream, with the bigint deciding each item's class, and a view declaring the wire form (String) is refused. The previous name-only check would have accepted that view.
  - Passing suites: `remote-page`, `todo-remote-page`, `todo-fullstack`, `remote-auth`; `vp check` clean.

## 2026-10-05 — One page plan, one page request (#13)

- **#13.** The design is recorded in [ssr-data research](docs/research/ssr-data.md#page-api-simplification-13-2026-10-05).
  - **Plan:** `NativeRemote`'s `pages.remote` takes one `PagePlan`, from `planPage(...)` or written by hand, instead of the parallel `reads`/`views`.
  - **Request:** `pages.render` takes nothing or one PageRequest Struct of any of `url`, `remote` and `views`. The page declares only what it reads, instead of choosing a shape by argument count.
  - **Internal:** `planReads` is module-private.
  - **No new runtime path.** `positionalPage` builds the request with an adapter composed through `R.flow`, so the generated host is unchanged.
  - **Refusals:** a positional page, an unknown field, a non-String url, and `remote` without a plan.
- **Migrated** `html-flags`, `remote-page`, `remote-auth` (a hand-written plan with a raw Read), `todo-remote-page`, the `todo-remote` example (`page.ts`, `main.ts`, README) and `todo-fullstack`.
- **Validation.** Passing suites: `html-page`, `html-flags`, `remote-page` (with the new refusal cases), `remote-auth`, `todo-remote-page`, `todo-fullstack`. Behaviour is unchanged, including byte equality with upstream. `vp check` clean.

## 2026-10-05 — Live signal ordering decision (#11)

- **#11.** Decided: live re-reads stay before the mutation answers. Upstream's `liveHub.changed` is an Effect the mutation source yields, so native already matches it. Clients can rely on every event a mutation caused being queued before its response. The rationale, costs, bounds and revisit condition are in [remote-live research](docs/research/remote-live.md). No code change.

## 2026-10-05 — SSR follow-ups (#15)

- **Nested `R.Struct.get`.** This is a TypeScript limit, not a signature bug. In isolation, a single-signature function infers `get(get(x, "a"), "b")`, but every overloaded (dual) form fails: data-last first, data-first first, or a data-last form without `S`. TypeScript does not resolve an overloaded generic call's result while it infers the outer call. Effect's dual `Struct.get` has the same shape, so the API stays aligned. The doc comment now names the pipe form and a named intermediate, and `tests/struct-get-types.ts` pins both, plus the nested refusal and an unknown key, with `@ts-expect-error`.
- **`R.Remote.Page`** returns its `StructType` instead of a plain `IRType`, so a page can be made with `.make` and read with `R.Struct.get`; type checks pin both.
- **Resume payload size,** measured on the showcase (`todo-remote` page): 2122 bytes, of which the Flags payload is 551 (26%) and the rest is HTML. Trimming answers to what replay needs is not worth its complexity at that size. Revisit if a page's payload grows past its markup.
- **Validation.** `vp check` clean (type tests included); `remote-page` and `todo-remote-page` pass.

## 2026-10-05 — Shared runtime logic (#38)

- **#38.** Same-language duplications are shared:
  - `check_query` is one `remote_engine::checked_query` over `(name, entity, valid)` for the memory and SQL backends;
  - `EntityPatched` payloads come from one `patched` helper, used by live events and snapshots;
  - requirement-to-relation conversion is `Requirement::as_relation`;
  - both RPC mains use `server_args` and `bind`, so argument parsing and the ready record are written once;
  - the page host parses its origin and computes its `Vary` values once (`OnceLock`) instead of per request, with `ssr_host::resolve_against`.

  The batch-limit block had already been shared by the runtime-sources split.

- **Kept on purpose.** Identifier quoting and `js_space` exist once in TypeScript (build time) and once in Rust (run time). `array_index` lives in two runtime modules that generated crates include independently.
- **Validation.**
  - `runtime:check`: 29 tests, clippy and rustfmt clean.
  - Passing suites: `runtime-sources`, `rpc-serving`, `async-rpc`, `native-rpc`, `html-page`, `remote-page`, `remote-live`, `remote-query`, `remote-sql`, `todo-fullstack`, `todo-remote-page`; `vp check` clean.

## 2026-10-05 — Weak authoring registries (#39)

- **#39, interning.** Structural interning holds witnesses weakly. A path steps through child witnesses by `WeakMap` and ends in a `WeakRef`, and a `FinalizationRegistry` clears dead leaves. Identical live structures still share one witness. A long-lived watch or editor process no longer keeps every witness it authored.
- **JSON codecs.** `schema-json` keys its encode and decode operations by the witness object, not its id string. An unrelated program reusing an id no longer fails at authoring; within one program, `derive` still refuses two operations with one id (`IDENTITY_COLLISION`).
- **`elementOperations`** is module-private, so importers can no longer replace an element's operation.
- **Still strong.** The element-operation table, keyed by shape text, remains a strong `Map`. It is bounded by the distinct element shapes authored.
- **Validation.**
  - New `registries` test, which fails on the previous code: a forgotten struct, with its array and JSON codec, is garbage-collected (GC forced through `--expose-gc`, each check in a later job), a referenced one stays interned, and `elementOperations` is not exported.
  - Passing suites: `records`, `records-js`, `records-rpc`, `schema-json-rpc`, `optional-fields`, `option`, `arrays`, `html`, `remote-mutate`, `remote-query`, `todo-fullstack`, `compiler`, `naming`; `vp check` clean.

## 2026-10-05 — 64-bit naming digest (#30)

- **#30.** Composite witness ids (`reffect/struct@1/…`), generated Rust struct and union names, JSON encoder and decoder names, and RPC codec names now come from one shared 64-bit digest, `src/naming.ts` (cyrb64: synchronous, dependency-free, browser-safe). Before, they came from three copies of a 32-bit FNV-1a. At 10k composites that gave about a 1% chance of a spurious `NATIVE_NAME_COLLISION` or schema-json `TYPE_MISMATCH`; now it is about 3e-12. Generated names change once, from 8 to 16 hex digits.
- **Validation.**
  - New `naming` test: three published FNV-1a 32-bit collision pairs, confirmed to collide under the old function, are distinct now. A digest value is pinned, and 200k struct-like keys are distinct.
  - Passing suites: `records`, `records-rpc`, `records-js`, `schema-json-rpc`, `native-rpc`, `compiler`, `optional-fields`, `arrays-rpc`, `html`, `remote-query`, `todo-fullstack`, `foldkit`; `vp check` clean.

## 2026-10-05 — Per-table query cell caches (#35)

- **#35.** The memory backend stamps each table with the global write counter, and a query's evaluator cells are rebuilt only when its own table's stamp changes. Before, any write anywhere invalidated every query's cells, re-encoding all their text as UTF-16.
- **Validation.**
  - New Rust test: writes and removes on `User` leave the `Todo` query's cells shared, while a `Todo` write rebuilds them, now two rows. The same test fails against the previous engine.
  - `runtime:check`: 29 tests.
  - Passing suites: `runtime-sources`, `remote-query`, `remote-mutate`, `remote-read`, `remote-live`, `remote-page`; `vp check` clean.

## 2026-10-05 — Cheaper mapped emission (#32, part)

- **Measured.** Benchmark: 40 functions of 40 nested `Match.bool` levels, about 38,000 generated ranges, best of three. Full source maps went from 4.6× to about 3.5× the cost of none (553 ms down to about 340 ms; none is 100 ms). The issue's acceptance of 1.5× is **not met**, and #32 stays open.
- **Profile.** Fragment composition was not the main cost. Most of it was in `SourceMaps.create`:
  - canonicalization: 111 ms;
  - validation: 33 ms;
  - the Schema decode of the table it had just built: 29 ms;
  - JSON: 26 ms.
- **Changes.**
  - `canonical` uses the native serializer with a sorted-key replacer and returns records already in key order uncopied. Generated ranges are now built in that order. An integer-like key takes the original algorithm, so the digest text is unchanged.
  - `create` validates its own table without the Schema decode; `decode` and `resolver` still decode.
  - Fragments are a rope. Text, byte lengths and shifted ranges are computed once, and byte lengths are counted without `TextEncoder`.
  - Provenance capture builds its `Match.type` matchers once and records origin parents through a `Set` instead of a linear scan.
- **Remaining.** The rest grows with the number of records: one occurrence and one range per edge, each canonicalized, validated, serialized and hashed. Reaching 1.5× needs a cheaper artifact form, for example hashing the emitted JSON rather than a canonical copy, or a compact range table. That is a format decision ([open work](docs/open-work.md)).
- **Validation.**
  - `source`: new cases for byte lengths against `TextEncoder` (pair, lone surrogates, two- and three-byte text) and for a shared fragment shifted to two places.
  - Passing suites: `artifact-policy`, `compiler`, `frame-policy`, `failure-frames`, `deferred-generated-profile`, `structured-concurrency`, `async-effect`, `resource-scope`, `rust-emission-output`, `string-profile`, `nesting`; `vp check` clean.

## 2026-10-05 — Each stage once per compile (#31)

- **#31.** Every stage re-ran the stages before it, so one `Compile.run` checked 9 times (measured) and derived and planned repeatedly. Programs, analyses and plans are frozen, so each stage now remembers what it accepted, by identity:
  - `check` keeps a `WeakSet` of checked programs, and `derive` a `WeakMap` from program to analysis;
  - `verify` answers a plan it returned with itself;
  - `verify` takes a plan that `plan` produced, or a `withFailureFrames` copy of one, as its own expectation instead of planning again. It still checks representations and the frame policy.
- **Unchanged.** A plan built through the public `Plan.make` is still planned again and refused when it differs. Refusals are not cached, so their diagnostics are unchanged.
- **Review.** `localUses` from #33 narrowed `object` to a record by assignment, which `vp check` rejects; it now uses a type guard and pushes array items without spreading.
- **Validation.**
  - New `stage-reuse` test (failed before: 9 checks): it counts tracer spans, and one `Compile.run` opens one each of check, derive, plan and verify, for a pure and an Effect program. A forged plan is still refused `INVALID_PLAN`, and re-verifying a verified plan returns it without planning.
  - Passing suites: `compiler`, `effect`, `async-effect`, `deferred-pipeline`, `fallible-admission`, `structured-concurrency`, `source`, `artifact-policy`, `frame-policy`, `module-foundations`, `context-layer`, `error-recovery`, `logging`, `ref`, `foldkit`, `native-rpc`, `html`, `todo-fullstack`, `string-profile`; `vp check` clean.

## 2026-10-05 — SSR rendering without repeated copies (#34)

- **#34, Html as a shared tree.** The runtime `Html` is now an `Arc` tree: an element shares its children rather than copying their markup. `render` writes the document once, iteratively, into a buffer sized from the precomputed length. Before, every byte was copied once per ancestor. A custom `Drop` unlinks deep trees without recursion.
- **No second build.** `failure` checks the root kind, the body's error and the stamp without writing the document, so `renderDocument` no longer builds it twice.
- **Class tokens** are deduplicated with a `HashSet` (linear) instead of a scan per token.
- **Template splice.** The page buffer is reserved from the template's byte length at build time.
- **Remaining.** Encoding the rendered page into the outcome `Value` still copies it once.
- **Validation.**
  - New Rust test: a 1 MiB leaf under 5,000 nested elements builds and renders in 0.02 s, exactly and at capacity, and `failure` agrees with `render`. Against the previous renderer the same test took 3.4 s and failed its 2 s bound.
  - `runtime:check`: 28 tests, clippy and rustfmt clean.
  - Passing suites: `runtime-sources`, `html`, `html-native`, `html-hydrate`, `html-page`, `html-flags`, `todo-remote-page`, `todo-fullstack`; `vp check` clean.

## 2026-10-05 — One allocation per concatenation chain (#33)

- **#33.** A string concatenation lowers to `[&(a)[..], &(b)[..], ...].concat()`, one allocation of the exact length. Before, it was a `format!("{}{}")` per link. Lowering binds every intermediate value to a local, so a chain was a run of locals, each link copying its whole prefix.
- **Fusion.** A concatenation local named exactly once, as an argument of another concatenation in the same block, now moves inline, and the chain renders as one list of parts. Inlining is safe there because each block is one straight-line scope whose locals nested helpers never name, and concatenation is pure. A shared link stays a local. Each inlined link keeps its own source range over its parts.
- **Validation.**
  - `string-profile` asserts that its three-link chain is a single four-part `.concat()` with no `format!`, and still agrees with the reference natively in debug and release.
  - Passing suites: `html`, `html-native`, `html-page`, `exit-cause`, `async-effect`, `source`, `artifact-policy`, `frame-policy`, `failure-frames`, `compiler`, `foldkit`; `vp check` clean.

## 2026-10-05 — Literal and argument robustness (#40, part)

- **Lone surrogates.** Rust string and char literals now refuse text with a lone surrogate, raising `INVALID_LITERAL` from the emitter. Before, they emitted `\u{d800}`, which rustc rejects. File paths were already refused at `check`, and log text is JSON-escaped before it becomes a literal.
- **Runner arguments.** The generated `unhex` decodes by byte and by lowercase digit. Before, `str:aé0` panicked slicing mid-character, and `str:+f` decoded through `from_str_radix`'s sign.
- **Still open: race children under a masked parent.** This is in the coordination area and is left to that work ([open work](docs/open-work.md)).
- **Review.** `native-rpc` still expected the crate list from before #16, so it had failed since #16; I had not rerun it then. The list now includes hyper, hyper-util and tower. Async servers also list `futures-util`, which their `Cargo.toml` already had.
- **Validation.**
  - `rust-emit`: three lone-surrogate shapes are refused in strings and chars; a pair passes.
  - `arrays`: six malformed arguments exit 1 with "invalid String" and no panic, in debug and release.
  - Passing suites: `rust-emission-output`, `html-page`, `compiler`, `native-rpc`, `async-rpc`; `vp check` clean.

## 2026-10-05 — Nesting limit (#29)

- **#29.** `Compile.check` and the reference refuse a function whose IR nests deeper than `NESTING_LIMIT` (512) with a structured `NESTING_LIMIT` diagnostic. The new `src/nesting.ts` measures the depth with an explicit stack, once per shared subterm, through expressions, computations, streams and function bodies. It runs before every other walk: the first overflow in the probe was `check`'s own deferred-model walk, which escaped as an untyped defect.
  - **Probe** (nested `Match.bool`):
    - 1025 levels compiled and 2049 overflowed;
    - 511 levels compiled, ran in the reference and built with cargo;
    - depth 10k through `Compile`, `Reference` and `NativeRpc.compile` now answers `CompileError`.
  - **Records:** [compiler API](docs/compiler-api.md) and [native divergences](docs/native-divergences.md).
- **Validation.** New `nesting` test:
  - depth 10k, pure and Effect, refused by `run`, `check` and the reference;
  - the exact boundary at 512;
  - 400 shared squarings measured by depth.

  `compiler`, `effect`, `html`, `html-page`, `foldkit` and `todo-fullstack` pass; `vp check` is clean.

## 2026-10-05 — Remote and SQL data gaps (#26)

- **Keys.** Rows stay keyed `entity:id`, as upstream keys them. Entity names holding a colon are now refused when compiled, and the live hub skips a client requirement whose entity holds one. Before this, `Todo:1` + `x` and `Todo` + `1:x` shared a key.
- **Memory relation pages.** `valueFor` is now an exact port. A non-string item empties the page only when a cursor search passes it or it bounds the page; `[...new Set]` deduplicates primitives. Before this, any non-string item emptied the page.
- **SQLite storage classes.** A BLOB, or any class other than INTEGER, REAL, TEXT and NULL, fails as Postgres's unknown types do, instead of reading as null.
- **Writes.** An object or array written to a column fails instead of binding NULL.
- **Database URL.** A SQL server checks its URL at boot, through a new `RpcRuntime.boot` hook, and exits naming the variable. Before this, it cached a broken pool and answered every request "Database query failed".
- **Records.** Divergence row and refusal recorded in [native divergences](docs/native-divergences.md).
- **Validation.**
  - Rust (27 tests, each new assertion failing on the old code): colon selection, relation-page windows over `[1, 1, "Tag:a", "Tag:b"]`, and SQLite BLOB/object write/unset URL against a temporary database.
  - TS: the `remote-live` colon refusal, and `remote-sql-mutate` spawning the built server without `REFFECT_DATABASE_URL` (non-zero exit, no ready record, the variable named).
  - Passing suites: `remote-sql-mutate`, `remote-read`, `remote-live`, `remote-sql`; `vp check` clean.

## 2026-10-05 — Reproducible generated builds (#41)

- **#41.** Every written artifact carries the runtime crate's `Cargo.lock`. The crate now depends on `subtle` and tokio `signal` as well, so its lock pins every crate a generated build can reach. Cargo keeps those versions and prunes the rest; `--locked` refuses a superset lock, so it is not used. After each build, `Cargo.build` refuses a resolved registry crate that is outside the lock or differs from it in version or checksum (see [compiler API](docs/compiler-api.md)).
- **Validation.** Passing suites:
  - `cargo-lock` (new; the check rejects a newer version, another checksum and an unlisted crate);
  - `runtime-sources` (the lock is part of the generated sources);
  - `effect`, `rpc-auth` (`subtle`), `remote-sql`, `remote-sql-mutate`, `todo-fullstack`, `rpc-serving`, `foldkit`.

  `vp check` is clean. `async-rpc` failed one disconnect test, which also failed without this change: its expectation that a batch's second request never starts predates #25. That test now expects both requests to start and to be interrupted with their masked cleanup.

## 2026-10-05 — RPC body decoding (#27)

- **#27.** The native RPC server decodes a request body as the official server's `request.text` does, in both JSON and NDJSON modes: a leading BOM is removed and invalid UTF-8 becomes U+FFFD (checked against Node's `Response.text`). Previously JSON mode parsed bytes strictly, so such a body was a `SyntaxError` Defect natively and a call upstream.
- **Validation.** `vp run runtime:check` (24 Rust tests, including the new body test); `runtime-sources`, `rpc-serving` and `stream-rpc` suites pass.

## 2026-10-05 — Review fixes: snapshot, nesting, page host (#7, #8, #10, #23, #28)

- **#7.** Ready-only page views are recorded as a native divergence.
- **#10 and #8.** Snapshot rows that read the same fields of one entity share one read. While a snapshot runs, ordinary events record what they told each subscriber, and the snapshot leaves that out, under one lock. A Rust test commits a newer title during the snapshot's read (mutation-checked).
- **#23.** `R.Html` refuses nesting that HTML tree construction rearranges, through branches and mapped items: a block in `p`, `a` in `a`, `form` in `form`, `button` in `button`, a heading in a heading, `li` in `li`. Fifteen shapes are checked against upstream's own refusal, and `native-ssr.md`'s SSR-005 claim is corrected.
- **#28.** In the page host:
  - repeated headers are joined and read as Latin-1;
  - `Vary` is set on refusals after negotiation;
  - templates and the origin are embedded as Rust literals;
  - the runtime id is CR-escaped;
  - a template that already holds Flags is refused.
- **Validation.**
  - `runtime:check` passes 23 Rust tests.
  - These suites pass, run one at a time: `html`, `html-native`, `html-page`, `html-flags`, `remote-auth`, `remote-page`, `remote-live`, `todo-remote-page` and `todo-fullstack`.
  - One miss along the way: the generated sources were stale for a run because `runtime:gen` had not been rerun. The sync test would have caught it.

## 2026-10-04 — M9-5: the todo-fullstack showcase (milestone 9 delivered)

- **Change.** `examples/todo-fullstack` is one native executable serving todo-remote's app over SQLite: the server-rendered first screen with resume, Effect RPC, R mutation sources in one transaction each, and Live with the snapshot.
- **Validation.**
  - `todo-fullstack` passes. The page is byte-equal to upstream fed by upstream's Drizzle server over the same file; hydration makes no fetch; a SQL toggle reaches a fresh Live subscription and persists into the next render.
  - Headless Chrome confirmed hydration, a toggle, and persistence across a reload.
- **Finding.** Upstream memory and Drizzle answers order `entities` differently, so SQL pages are compared against the Drizzle oracle ([record](docs/research/ssr-data.md#plan)).

## 2026-10-04 — #36: one lowering descriptor per implementation

- **Change.** Each `Implementation` carries a tagged `Lowering` (`Method`, `Infix`, `Not`, `Concat`, `NumberText`, `HostJson`, `Html`), replacing the `method` string. Host JSON and Html implementations fill theirs in when they are created. `lower` dispatches on the plan's selection exhaustively with `Match` and no longer re-derives host or Html kinds from side tables. Registration is checked against the target's own implementations, so custom `Target.make` registrations can be selected.
- **Validation.**
  - Generated files are byte-identical before and after, for an RPC program using every primitive lowering and for the todo-remote server.
  - A new `effect.test` case selects a custom registration.
  - `effect`, `html`, `number-text`, `html-native` and `schema-rpc` pass.
- **Not done.** Cargo dependencies are still tracked both in `Plan.crates` and in lowering's module flags. Those flags also decide which runtime modules are inlined, so they stay for now.

## 2026-10-04 — #37 completed: every static runtime in checked Rust (#9, #12)

- **Page host** (`e7a4214`). `ssr_host` is in `runtime/src/ssr_host.rs`. A Rust test checks each helper against values captured from foldkit 0.165.0's own `acceptsHtml`, `varyWith`, `resolveRequestUrl`, `resolvesToIndexHtml` and `classifyRequest`.
- **SQL runtime** (`f2af4ec`). It is `runtime/src/remote_sql.rs`, with `sql_sqlite.rs` or `sql_postgres.rs` as its `dialect` child. The check crate compiles it under both dialects (clippy-clean), and a test per dialect pins quoting and placeholders.
- **Page data step** (`460141a`, #12, #9). It is `remote_engine::page_data` and `page_views`. Planned requests are parsed once per process and views index entities once.
- **What stays generated.** The `native-remote.ts` glue (store-session impls, `RemoteLive`, `remote_live_subscribe`, the authorizer) implements traits generated into each crate's library and names the backend's source. It is per-server glue, not static runtime, so it stays generated.
- **Validation.**
  - `runtime:check` passes 21 Rust tests, with rustfmt and clippy clean.
  - These suites pass, run one at a time: `remote-sql`, `remote-sql-mutate`, `remote-sql-live` (SQLite and Postgres), `html-page`, `html-flags`, `remote-page`, `remote-auth`, `todo-remote-page` and `runtime-sources`.

## 2026-10-04 — #37 slices 1–2: RPC runtime without string patches, static Rust in the crate

- **Slice 1** (`095c3bd`): the layered cancellation type, the shutdown forwarder, the pages fallback and the tokio features were spliced in by matching text. They are template parameters now; `validate_batch` replaces the duplicated batch check (#38).
- **Slice 2** (`04fa21b`): the argument decoders, wire helpers, streaming forwarder with `PendingResponse`, and the accept loop live in `runtime/src/rpc_{args,wire,stream,serve}.rs`.
  - Generated `main.rs` inlines them at its root, so call sites are unchanged.
  - The check crate includes them in a host module with the same imports. `runtime:check` rustfmts them explicitly and runs 16 Rust tests, three of them new for the RPC wire.
- **Validation.** These suites pass, run one at a time: `runtime-sources`, `schema-rpc`, `rpc-auth`, `stream-rpc`, `stream-interrupt`, `server-layer`, `html-page`, `remote-live`, `rpc-serving` and `remote-mutate`.
  - `module-composition` fails the same way without these changes: the coordination work's refusal, "Cancellation-retained failures and fallible task groups require a verified compound RPC Cause wire adapter".
- **Next.** The page host (`ssr-page.ts`), then the SQL runtime.

## 2026-10-04 — #19: bounded Live queues and subscription caps

- **Change.** Each Live subscriber's queue is bounded (default 1024). When it overflows, an event is dropped after its cursor is numbered, so the client sees a gap and resyncs (LIVE-007). Subscriptions are capped in total (10000) and per authenticated principal (64); anonymous clients are not pooled. `NativeRemote({ liveLimits })` sets the bounds, a recorded hardening divergence (LR-8 closed).
- **Validation.**
  - Two Rust tests: a stalled subscriber with a queue of 2 receives cursors 1, 2, then 4; the caps refuse and then free.
  - `runtime:check` passes 13 tests.
  - `remote-live`, `remote-sql-live`, `todo-remote-page`, `stream-rpc` and `runtime-sources` pass.

## 2026-10-04 — #25 and #16 step 2: concurrent batches, multi-thread runtime

- **Change.** A body's requests run concurrently in one task (`FuturesUnordered`, first polled in request order) and answer in completion order, as official does. Generated servers run on the multi-thread runtime; RS-004 holds through per-operation store locking ([record](docs/research/rpc-serving.md)).
- **Validation.** These suites pass, run one at a time: `rpc-serving`, `stream-rpc` (now compared per request), `remote-live` (now compared by events), `server-layer`, `stream-interrupt`, `rpc-auth`, `html-page`, `remote-page`, `html-flags`, `remote-query`, `remote-read` and `remote-auth`.
- **Mutation suites.** They were refused for a while by `TASK_GROUP_RETAINED_FAILURE` from the coordination work, fixed in `6283f7c`. They now pass on the multi-thread runtime (see the 2026-10-04 composite recovery entry), and #16 is closed.

## 2026-10-04 — #16 step 1: read timeouts and a connection cap

- **Change.** Generated servers serve through one accept loop instead of `axum::serve`, which set no hyper timer. The loop has:
  - a header-read timeout;
  - a body-read timeout: axum's own `Bytes` extractor runs under `tokio::time::timeout`, so a stalled body gets 408 and an oversized one keeps its 413;
  - a semaphore connection cap, beyond which accepting waits;
  - hyper-util graceful shutdown.
- **Settings.** The defaults (30 s, 30 s, 1024) are set through `limits`. hyper, hyper-util and tower are pinned to the versions axum already resolves ([design](docs/research/rpc-serving.md)).
- **Validation.**
  - New `rpc-serving` test: partial headers are closed after the timeout, a stalled body gets 408, and a third request waits while two connections fill the cap.
  - Run one at a time (a parallel run was stopped for low memory): `server-layer`, `rpc-auth`, `html-page`, `remote-live`, `remote-acceptance`, `stream-rpc` and `stream-interrupt` pass.
- **Open.** Step 2, threading and concurrent batches (#16, #25).

## 2026-10-04 — Review fixes: step 1 completed (#3, #5, #17, #18, #20)

- **#18.** Scope analysis refuses Remote store calls and live signals in cleanup (`STORE_CLEANUP`). Before, a failed call there panicked the masked finalizer path.
- **#17.** `JsObject` uses hashed slots and a sorted index-key map, and relation fields merge through a set. A 200k-key windows map reads in about 2 s in a debug build; the old engine took more than 90 s. A Rust test pins JS key order.
- **#3.** Data pages send `Cache-Control: private, no-store`, a recorded hardening divergence.
- **#5.** Page views need a windowed query; todo-remote reads the first 50.
- **#20.** Bearer tokens are compared zero-padded to 256 bytes together with their length, in constant time, and the credentials variable is removed once loaded.
- **Validation.**
  - New tests: `store-cleanup`, two Rust tests, a `remote-page` refusal and a header assertion.
  - These suites pass: `remote-read`, `remote-acceptance`, `remote-query`, `remote-live`, `remote-auth`, `rpc-auth`, `remote-mutate`, `remote-sql-mutate`, `remote-page`, `todo-remote-page` and `runtime-sources`.
  - `runtime:check` passes 11 Rust tests.

## 2026-10-04 — Review fixes: SSR security (#21, #22, #24)

- **#22.** `R.Html.DataAttribute` refuses the reserved `data-foldkit-*` markers with upstream's message. Before this, an authored marker preceded the server's, so stored data could set hydration keys.
- **#24.** `Value` outside `button`/`input` is refused while compiling (`refusedOn` was unused), where it used to be dropped silently.
- **#21.** Pages resolve the whole request target as upstream's `resolveRequestUrl` does. A target naming another origin, an absolute-form target to another host, or a target with credentials gets 400 before anything else.
- **Validation.**
  - `html.test` checks each reserved name against upstream's own refusal, and `li` `value` against upstream.
  - `html-flags` adds `//evil.example/x`, absolute-form and credential targets, and fails on the old host (200 for `//evil.example/x`).
  - `ssr-serialize`, `html-page` and `remote-page` pass.

## 2026-10-03 — LIVE-015: opt-in snapshot for fresh live subscriptions

- **Decision (user).** Close the render-to-live gap with an opt-in native snapshot, a recorded divergence that is off by default ([record](docs/research/ssr-data.md#render-to-live-gap-decision-2026-10-03)).
- **Validation.**
  - `todo-remote-page` shows a change made between render and subscription arriving; it times out without the snapshot.
  - `runtime:check` passes 9 Rust tests.
  - `remote-live` and `runtime-sources` pass.
- **Next.** M9-5, the showcase.

## 2026-10-03 — M9-4: todo-remote's first screen natively

- **Change.** The example's native server renders the app's first screen from its own engine. The app's `init` replays the handed-over exchanges and `entry.ts` hydrates. The session id comes from a Command; Vite proxies page navigations.
- **Validation.**
  - `todo-remote-page` passes: the page equals upstream with the app's own `init`/`view`, and hydration issues no read or query (mutation-checked).
  - `examples/todo-remote/main.ts` still equals upstream's memory backend.
  - Headless Chrome over CDP adopted the page with only the Live subscription on load and toggled a todo. This closes LR-3's pending browser check.
- **Next.** M9-5 (the showcase), which first needs a decision on the render-to-live gap.

## 2026-10-03 — M9-3 step 2b: R page views read Remote query pages

- **Change.** `planPage` maps named views to their planned queries, and NativeRemote builds each as upstream's `Page` of a Ready read for the render's typed third input (`R.Remote.Page`). Views and their item fields are checked against the plan while compiling.
- **Validation.** `remote-page` passes: the todo list rendered from the engine equals upstream with the browser's replay-then-read `init`, and mismatched and partial views are refused. `remote-auth`, `html-page`, `html-flags` and `remote-resume` pass, and `vp check` is clean.
- **Review fix.** Item fields are now checked against the selection (`eead254`).
- **Next.** M9-4: todo-remote's first screen natively; R function calls as needed.

## 2026-10-03 — M9-3 step 2a: native pages read Remote data for resume

- **Change.** `planReads` plans a page's requests from upstream `Data.satisfy` while compiling. NativeRemote pages run them against the engine under the page request's principal and carry the `{ now, exchanges }` resume in their Flags. Pages on bearer-authenticated servers need a principal (401).
- **Validation.**
  - `remote-page` (byte-equal to upstream, browser resume `Ready` with no fetch) and `remote-auth` (401s, per-principal answers equal the RPC answers) pass.
  - `html-page`, `html-flags` and `remote-resume` pass, and `vp check` is clean on the changed files.
- **Review fix.** The principal requirement first applied only with `authorize`; it now applies whenever `auth` is configured (`54dc329`).
- **Next.** Step 2b, typed view data ([design](docs/research/ssr-data.md#m9-3-step-2-design-2026-10-03)).

## 2026-10-03 — LIVE-008: after-commit hook and LiveHub service

- **Change.** Store sessions take `after_commit(action)`, and signals go through a `LiveHub` service on the execution context. SQL runs the actions after `COMMIT` and drops them on rollback; memory runs them at once.
- **Validation.** `remote-live`, `remote-sql-live`, `remote-mutate` and `remote-sql-mutate` pass, and `vp check` is clean on the changed files ([record](docs/research/remote-live.md#improvement-plan-2026-10-03)).

## 2026-10-03 — LIVE-012: runtime Rust in checked files (first slices)

- **Change.** The SSR runtimes, the Remote engine and the Query evaluator moved from TypeScript strings into the check-only crate `packages/reffect/runtime`.
  - `scripts/runtime-sources.ts` generates `src/runtime-sources.generated.ts`; `runtime-module.ts` wraps each body in its `mod` item.
  - `vp run runtime:gen` regenerates; `vp run runtime:check` runs rustfmt, clippy `-D warnings` and `cargo test`.
- **Validation.**
  - `runtime:check` is clean: 8 Rust tests, including hub cursor, selection and authorization tests.
  - The `runtime-sources` sync test passes and was mutation-checked.
  - These suites pass: `ssr-serialize`, `html`, `html-native`, `html-page`, `html-flags`, `remote-acceptance`, `remote-live`, `remote-query`, `remote-read`, `remote-sql-live` and `foldkit`. `foldkit` passed when run alone; its fixed 120 s budget timed out under concurrent builds.
- **Remaining.** The RPC, SQL and page runtimes ([LIVE-012](docs/research/remote-live.md#improvement-plan-2026-10-03)). Next is LIVE-008, then M9-3 step 2.

## 2026-10-03 — M9-1: pages read the request and carry Flags

- **Change.** Native pages may read their request URL, resolved against a configured origin. `R.Html.renderToString` takes Flags and writes upstream's payload with a JS-exact JSON writer. Flags holding Numbers are refused.
- **Validation.**
  - `vp test tests/html-flags.test.ts` passed: five targets equal `handleRequest` around upstream `renderToString` with the same Flags, `init` and view.
  - `html-page`, `html-native`, `html` and `number-text` pass.
  - `vp check` is clean.
- **Divergence.** Hyper refuses raw non-ASCII bytes in request targets; this is recorded in native divergences.
- **M9-3 step 1 delivered: Numbers in Flags.** The program form `R.Html.renderToString({ init, view }, { flags })` hands `init` the Flags' JSON round trip, as upstream does, and adds a `FlagsEncodeError` render error. `html-flags`, `html-native`, `html-page`, `html` and `html-hydrate` pass, and `vp check` is clean on the changed files.
- **M9-2 upstream half delivered** (`reffect/remote-resume`: `record`/`replay`, tested on entity, windowed, paged and second-pass reads). **Next:** M9-3, native recording from R pages. M9-2 was redesigned (2026-10-03). The server records its Query/Read exchanges into the Flags, and the client `init` replays them through upstream `Data.satisfy`. An upstream-only probe showed equal Models, a `Ready` read and no planned fetch. The `RemotePersistence` snapshot was dropped because `Hydrated` restores connections as stale with unknown boundaries ([design change](docs/research/ssr-data.md#design-change-resume-from-protocol-answers-not-the-snapshot-2026-10-03)).

## 2026-10-03 — Fallible tasks and lexical coordination preparation

- Implemented common Bool/U64/Unit failures for static All/Race, ordered bounded Cause propagation, cancellation-aware recovery and Cause-preserving framed reference execution. The CLI reconstructs compound exits; NativeRpc explicitly refuses the new failure profile pending protocol conformance. Scalar values and legacy infallible artifacts keep their existing representation.
- Controlled official/reference/native scenarios cover reversed completion, All deduplication versus Race duplicates, all three scalar payloads, three simultaneous failures, cancellation during failing/loser cleanup, skipped catch/result, masked acquisition recovery, and cleanup ordering. Native debug/release and None/Bounded policies are exercised. No new Cargo dependency. Validation: fallible conformance 3/3 (136.19s), existing structured/admission 8/8 (193.39s), host refusal 1/1, native cost 1/1; strict TypeScript, workspace build and `vp check` pass. The refusal fixture initially used unsupported Void/default payload schemas; corrected to explicit Undefined before validation.
- Native cost probes measure a 64-byte Cause/error carrier, 16-byte failure tag, 24/32-byte context, and 456/488-byte future for the measured fallible pair. One hundred groups allocate 200 times with frames disabled (existing watch channels), 400 with bounded frames, and retain zero allocations. Cause/context/unpolled construction allocate zero; generated library sizes are 7,651/9,911 UTF-8 bytes. These are Rust 1.98.1 Linux fixture measurements, not universal layout guarantees.

- Reviewed stable Effect 4.0.0 Cause/recovery/cancellation and Deferred/Semaphore sources with independent controlled probes. [Semantic research](docs/research/fallible-concurrency.md), [native design](docs/research/fallible-native.md), [core decisions](docs/research/fallible-core.md), [conformance preparation](docs/research/fallible-conformance.md) and [lexical coordination](docs/research/lexical-coordination.md) record scope, alternatives, lifetime/cost obligations and decisions before feature implementation.
- The chosen task carrier is emitted only when fallible groups are reached: ordered inline scalar failure payloads independent of the current declared error channel, plus interruption state. This preserves an original error when pending cancellation skips a catch that changes its channel to Never. Scalars gain no metadata fields. All and Race require different cause-combination/cancellation rules. Owned coordinator borrowing and independent waiter cancellation remain acceptance gates for Deferred/Semaphore; implementation proceeds in that order. Synced upstream streaming/interruption work through 0eb11a1; core PLAN remains separately owned.

## 2026-10-03 — Milestone 9 plan; milestone 9 before 8B

- [ssr-data.md](docs/research/ssr-data.md) records upstream's SSR data path in foldkit-remote 0.11.0: `Data.prefetch` through a `RemoteClient`, then a `RemotePersistence` snapshot (`snapshotOf`/`dehydrate`/`hydrate`/`mergeStores`, cache version 5).
- **Plan M9-1..5:**
  1. pages that read the request, with Flags;
  2. a native snapshot;
  3. R projections and async pages;
  4. `todo-remote`'s first screen;
  5. the showcase.
- **Decision.** By user decision, milestone 9 is taken before 8B.

## 2026-10-03 — Milestone 8A step 5: native page serving

- **Change.** NativeRpc's `pages` option serves an R page beside `/rpc`, as foldkit's `handleRequest` does. The template is split at build time by upstream `injectIntoTemplate`. Host rules are ported to Rust, with WHATWG paths via `url` 2.5.8.
- **Validation.**
  - `vp test tests/html-page.test.ts` passed: 21 requests equal upstream `handleRequest` in status, content type, `Vary`, `Allow` and body, and TRACE/TRACK are refused as upstream refuses them.
  - Removing one asset extension makes the test fail.
  - `html-native`, `html-hydrate`, `rpc-ndjson` and `ported-runtime` pass.
  - `vp check` is clean.
- **Next:** the todo example's first screen rendered natively (step 6). Pages that read the request (URL and Flags) follow.

## 2026-10-03 — Milestone 8A step 4: the stock client hydrates native HTML

- **Change.** With `happy-dom` 20.14.5, foldkit's own test DOM, the stock `Runtime.hydrate` adopts HTML from a native server. Every server node is kept, and a click on an adopted node updates it.
- **Fault check.** A markup mismatch makes the test fail.
- **Fix.** The upstream version guard no longer throws when the compiler module is not loaded from a file URL.
- **Validation.**
  - `vp test tests/html-hydrate.test.ts` passed.
  - `ported-runtime` and `html` pass.
  - `vp check` is clean.
- **Next:** page serving (step 5): template splicing and `handleRequest`'s rules, beside `/rpc`.

## 2026-10-03 — Milestone 8A step 3: native rendering, byte-equal to `renderToString`

- **Change.** R views lower to a Rust serializer, ported from Foldkit's handling of the admitted attributes as measured against `renderToString`. `R.Html.renderToString` returns a typed `Result`, with upstream `renderToString` as its reference.
- **Validation.**
  - `vp test tests/html-native.test.ts` passed: 12 RPC responses are byte-equal to the official server.
  - `html`, `ssr-serialize`, `number-text` and `numbers` pass.
  - `vp check` is clean.
- **Next:** hydration with the stock client under `happy-dom` (step 4), then page serving.

## 2026-10-03 — Milestone 8A step 2: `R.Html` and the reference view

- **Change.** `R.Html` builders mirror Foldkit's `h` (SSR-009), and event attributes construct the app's own Messages per variant (SSR-010). `toFoldkitView` hands an R view to Foldkit.
- **Validation.**
  - `vp test tests/html.test.ts` passed (4 tests). An R view's `renderToString` output equals the hand-written Foldkit view's.
  - `vp check` is clean.
- **Next:** native rendering (step 3): lower `Html` operations to a Rust writer and compare byte for byte with `renderToString`.

## 2026-10-03 — SSR-012: `R.String.fromNumber`

- **Change.** `R.String.fromNumber(n)` writes JS `String(n)` text, natively through the pinned `ryu-js`. The crate enters the plan, the core manifest and the RPC manifest only when the operation is reachable.
- **Validation.**
  - `vp test tests/number-text.test.ts tests/numbers.test.ts` passed. That covers 17 edge values, natively and in the reference.
  - `vp check` is clean.

## 2026-10-03 — Milestone 8A open questions resolved (SSR-009..012)

- **SSR-009.** `R.Html` mirrors Foldkit's data-first `h` (`html/index.d.ts`). Children are a list, or one mapped array.
- **SSR-010.** Event Messages are built per variant with the app's own constructor and erased natively. A whole-union witness fails for a real app's Message (measured on the todo app).
- **SSR-011.** Headless hydration uses `happy-dom` 20.14.5. That is what foldkit 0.165.0 itself tests hydration with (`runtime/hydrateBoot.test.ts`, which keeps server node identity), and it is the latest release.
- **SSR-012.** `R.Number.toString` lowers to the already pinned `ryu-js`, which the native code uses for JS number text.
- Recorded in [native-ssr.md](docs/research/native-ssr.md#open-questions-resolved-2026-10-03).

## 2026-10-03 — Milestone 8A step 1: SSR escaping and key markers

- **Change.** The native ports of Foldkit's `escapeText`/`escapeAttributeValue` (with NUL refusal) and the hydration key fingerprint (FNV-1a over UTF-16) are registered as `foldkit/ssr-serialize@1` (foldkit 0.165.0).
- **Validation.**
  - `vp test tests/ssr-serialize.test.ts tests/ported-runtime.test.ts` passed. The native results equal upstream `renderToString` on a 12-value corpus.
  - A fault injected into the attribute escaper fails the test.
  - `vp check` is clean.
- **Next:** `R.Html` builders and the reference view (step 2).

## 2026-10-03 — Milestone 8A design: native Foldkit SSR

- [native-ssr.md](docs/research/native-ssr.md) records upstream foldkit 0.165.0 SSR from the installed sources:
  - `renderToString`: its overloads, errors, the Flags round trip and the dropped init commands;
  - the hydration markers and the UTF-16 FNV fingerprint;
  - the serializer: attribute ordering, escape sets, element kinds and the parse5 post-checks;
  - template injection and `handleRequest`;
  - the stock client's tolerant hydration, which makes byte equality the acceptance bar.
- **Proposed decisions SSR-001..008:**
  - `R.Html` views mirroring Foldkit's `h`, whose reference builds real Foldkit VNodes for the browser and the oracle;
  - a bounded profile that refuses parse5-dependent constructs;
  - a ported serializer subset registered as `foldkit/ssr-serialize@1`;
  - init and Flags in R;
  - build and runtime ids as compile options;
  - page serving after rendering;
  - JS number text before numeric views.
- **Open:** a headless DOM dev dependency for hydration tests; the `R.Html` builder shape and Message typing.

## 2026-10-03 — The browser "regression" diagnosis retracted

- **Finding.** An in-page trace shows the read entry's `QueryStarted` and `ConnectionMerged` reaching `update`. A Node emulation of Foldkit's subscription loop reaches a `Ready` list for both the original and the live app.
- **Likely cause.** Foldkit renders on `requestAnimationFrame`, which pauses in background tabs, so the stale `Initial` screen most likely came from an automation tab that was never visible.
- **Correction.** The previous entry's "client-side regression, suspected in foldkit-remote 0.11.0" is withdrawn. The record and the example README are corrected.
- **Unconfirmed.** The browser extension disconnected before tab visibility could be checked. The visible-tab check remains open.

## 2026-10-03 — Browser live rendering, and a browser regression found

- **Change.** `examples/todo-remote/web/app.ts` follows every visible todo with one `Data.live` read, composed with `Projection.struct`. Strict `tsc` and `vp check` pass.
- **Not verified in Chrome.** The browser app stays `Initial` with the native server, with upstream's in-browser memory backend, and with the pre-live JSON build. So this is a client-side regression since the milestone 4 browser run, suspected in foldkit-remote 0.11.0 and not in reffect. The evidence is in [remote-live](docs/research/remote-live.md#review-fixes-delivered-2026-10-03).
- **Unaffected:** the Node session, including the `Data.live` second screen.
- **Open:** diagnose the regression, possibly as a foldkit-plus issue, before the Chrome run.

## 2026-10-03 — LIVE-010: ported runtimes in artifacts, with upstream version guards

- **Change.** RPC artifacts list the ported protocol engines they run, with upstream pins and conformance tests (`runtime.ported`). When a FileSystem is available, compilation refuses installed packages that differ from the pins (`UPSTREAM_VERSION`); otherwise it reports `upstream: "unchecked"`.
- **Validation.**
  - `vp test tests/ported-runtime.test.ts` passed (4 tests).
  - `remote-live` and `rpc-ndjson` pass with the guard active.
  - `vp check` is clean.
- **Next:** browser live rendering for `todo-remote` (rest of LR-3), then milestone 8 research.

## 2026-10-03 — LR-3: Foldkit's `Data.live` path over the native server

- **Change.** `examples/todo-remote` adds a second screen that reads t2 with `Data.live` and folds the `LiveReceived` messages of Remote's own live Subscription entry with `Data.reduce`. It shows the toggle without refetching, and its screens equal upstream's memory backend with `liveHub`.
- **Harness note.** The in-process upstream session needs the entry's stream joined; an un-joined fiber never ran, because nothing yielded after the mutation.
- **Validation.** `vp exec node --experimental-transform-types examples/todo-remote/main.ts` printed `second screen [x] Compile it natively` and "native screens equal upstream's memory backend". `vp check` is clean.
- **Open:** browser live rendering (one `Data.live` read per todo) and a Chrome run.

## 2026-10-03 — Live review fixes LR-1, LR-2 and LR-4

- **LR-4.** `live: true` requires NDJSON serialization.
- **LR-2 with LIVE-009.** One `forward_chunks` serves R streams and Live. An opt-in `REFFECT_LIVE_TRACE` record now shows native disconnects unsubscribing (counts 1, 2, 1, 0).
- **LR-1 with LIVE-007.** A failed live re-read skips the cursor (a client-visible gap) instead of failing the committed mutation, and later signals still apply. This is registered as a divergence.
- **SQLX-019, found by the LR-1 test.** SQLite read a missing double-quoted column as a string literal. SQLite identifiers are now backtick-quoted.
- **Validation.**
  - `vp test` of `remote-live`, `stream-rpc` and `stream-interrupt` passed.
  - `sql-plan`, `remote-sql`, `remote-sql-mutate` and `remote-sql-live` passed: 16 tests on SQLite and Postgres.
  - `vp check` is clean.
- **Process note.** `5a1d12d` fixed formatting that `350c67f` committed, because `vp check | tail` hid the failing status.
- **Next:** LR-3 (`Data.live` end to end).

## 2026-10-03 — Milestone 7 assessment and improvement plan

- [remote-live.md § Improvement plan](docs/research/remote-live.md#improvement-plan-2026-10-03) assesses the design.
  - It is correct within the tested envelope, except LR-1 and LR-2.
  - The SQL oracle checks self-consistency with LIVE-003, not equivalence with upstream.
  - The surface is elegant, but the internals are expedient.
  - It is coherent with the Remote ports, but ported runtimes are opaque to planning.
- **Proposed decisions LIVE-007..014:**
  - failed re-reads as cursor gaps;
  - an after-commit hook and a separate LiveHub service;
  - one stream forwarder;
  - a semantic runtime registry with upstream version guards;
  - typed signals;
  - runtime Rust as `.rs` files;
  - randomized hub conformance;
  - a written boundary between R policy and ported protocol engines.
- **Next:** the LR-1..4 fixes.

## 2026-10-03 — Milestone 7 review

- [remote-live.md § Review](docs/research/remote-live.md#review-2026-10-03) records the review of the milestone 7 commits (`900322b`..`9ecd4ad`).
- **Defects (LR-1..4):**
  - LR-1: a failed re-read after a SQL commit misreports the committed mutation and skips the remaining signals;
  - LR-2: native unsubscription on disconnect is untested;
  - LR-3: the status claims overstated delivery; PLAN.md and the record are corrected here;
  - LR-4: `live: true` with JSON can never answer.
- **Debts and minor items (LR-5..12)** are recorded in [open work](docs/open-work.md).
- **What held up:** explicit signals checked against upstream's own hub, byte-exact differential tests, cursor/queue ordering under one lock, and shared limit and authorization code.
- **Next:** fix LR-1..4 as `review(live):` commits.

## 2026-10-03 — Milestone 7 step 3: stock live client and a live todo example

- **Stock client.** Remote's stock `RemoteClient.live`, over a stock `RpcClient` with NDJSON, decodes native Live into the same `LiveEvent`s as over upstream's handlers.
- **Example.** `examples/todo-remote` serves Live natively. Its session watches two todos while another screen toggles and deletes them.
- **Validation.**
  - `vp test tests/remote-live.test.ts` passed (3 tests).
  - `vp exec node --experimental-transform-types examples/todo-remote/main.ts` printed `watched live #1 t2 {"done":true} #2 t1 deleted` and "native screens equal upstream's memory backend".
  - `vp check` is clean.
- **Open:** browser-side live rendering needs per-item `Data.live` projections ([remote-live](docs/research/remote-live.md#order-of-work-and-acceptance)).

## 2026-10-03 — Milestone 7 step 2: live signals after SQL commits

- **Change.** On the SQL backend, `R.LiveHub` signals are queued in the mutation's session and applied after commit; a rollback drops them (LIVE-003).
- **Validation.** `vp test tests/remote-sql-live.test.ts` passed on SQLite and Postgres: Chunk lines and answers equal the official server, which calls upstream's `liveHub` after its own commit. `remote-sql-mutate`, `remote-sql` and `remote-live` pass; `vp check` is clean.
- **Open:** the stock `Data.live` client and live `todo-remote` (step 3).

## 2026-10-03 — Milestone 7 step 1: native Remote Live on the memory backend

- **Signals and hub.** `R.LiveHub.changed(ref, fields)` and `R.LiveHub.deleted(ref)` signal a native port of `RemoteServer.liveHub` from R mutations. `NativeRemote.compile(..., { live: true, serialization: "ndjson" })` serves `FoldkitRemoteLive` from it. Without `live`, Live is an empty stream, as `handlers` serves it without a hub. NativeRpc gains runtime-served streaming procedures.
- **Validation.**
  - `vp test tests/remote-live.test.ts` passed. It compares raw Chunk lines with upstream's own hub across selected, unselected and missing fields, windowed aliases (three events in one chunk), deletes, resume cursors (`after`), disconnect, the protocol check and the id limit.
  - `remote-mutate` and `remote-read` pass. `stream-rpc`, `stream-interrupt`, `stream`, `remote-auth`, `remote-sql-mutate`, `remote-wire-rpc` and `remote-acceptance` pass. `tsc`, `vp lint` and `vp fmt --check` are clean.
- **Authorization (LIVE-006).** A second scenario re-authorizes each subscriber under its own bearer principal; native and official outcomes are equal.
- **Open:** SQL after-commit signals and the stock-client step ([remote-live](docs/research/remote-live.md#order-of-work-and-acceptance)).

## 2026-10-03 — Milestone 7 design: native Remote Live

- [remote-live.md](docs/research/remote-live.md) records upstream's `liveHub` and `FoldkitRemoteLive` semantics (foldkit-plus 0.14.0), read from the installed sources. It covers subscriber selection, grouping by principal and windows, re-authorization, re-reads, per-stream cursors, limits, the protocol check and `takeAll` chunking.
- **Decisions LIVE-001..006:**
  - `R.LiveHub.changed/deleted` effect nodes. The reference runs them on upstream's own hub.
  - A native hub ported into the Remote engine.
  - Memory signals apply inline; SQL signals apply after commit.
  - A runtime-served Live stream, enabled by `live: true`.
- Milestone 6 step 5 (the Live skeleton) is absorbed into milestone 7 step 1.

## 2026-10-03 — Milestone 6 step 4: interruption by disconnect

- **New stream operators:**
  - `Stream.fromSchedule(Schedule.spaced(d))` gives timed sources;
  - `Stream.ensuring` runs a finalizer however the stream ends. It is native as a consumed stream's outermost operator, through the masked `Effect.ensuring`.
- **Validation.** `vp test tests/stream-interrupt.test.ts` passed: incremental delivery, and exactly one finalizer run on disconnect, natively and officially, with the server serving afterwards. `stream`, `stream-rpc`, `async-effect`, `effect-combinators` and `exit-cause` pass.
- **Race fix.** The other session's Exit capture (`effect-exit.ts`) landed beside `StreamEmit`, and its exhaustive walk missed the new node. Fixed in `17c5b48`.
- **Limits** are listed in [streaming-rpc.md](docs/research/streaming-rpc.md#order-of-work-and-acceptance) and the open-work register.

## 2026-10-03 — Milestone 6 step 3: streaming RPC procedures

- **`R.Stream.fn`** answers `stream: true` procedures. Native servers send each chunk as a `Chunk` message, then the `Exit`. Under NDJSON chunks stream as they are produced, through the 16-message body channel; under JSON they are buffered.
- **Reference.** `Reference.stream` serves the official oracle.
- **Validation:**
  - `vp test tests/stream-rpc.test.ts`: 2 passed, NDJSON and JSON, with a stock client;
  - `stream`, `rpc-ndjson`, `async-effect`, `remote-mutate` and `schema-json-rpc` pass.
- **Next:** step 4, interruption by disconnect with timed and effectful operators (`fromSchedule`, `ensuring`).

## 2026-10-03 — Bounded Exit/Cause values

- Recorded stable Effect 4.0.0 source checks, independent mixed-Cause probes and representation decisions in [exit-cause.md](docs/research/exit-cause.md), before implementation. The first slice uses explicit Fail-only Cause data and Exit values over existing checked records/unions/arrays; synchronous Effect.exit refuses async and Clock/Random work inside capture. Runtime mixed causes, defects and child handles remain separate gates. Cause arrays allocate only when represented data is requested; scalar values and execution context gain no fields.
- Delivered constructors, pure maps/matches, predicates and first-error/Option observers, including arbitrary Fail-only arrays and duplicate/empty reasons. Cause.map preserves every reason; Exit.mapError/mapBoth rebuild from the first error. Native debug/release cover non-Copy strings, synchronous capture inside an async parent and both failure-frame policies. Three agents supplied source/design/conformance findings before their implementation turns hit a usage limit; root implemented and self-reviewed the resulting slice. Core PLAN.md remains owned by the other instance.
- A separate std-only allocator probe measures zero allocations for scalar/empty/success paths, one per materialized failure in release, and one additional existing diagnostic allocation for bounded failure capture. Debug retains intermediate composite clones; each 100-call workload returns to its starting live allocation count. Concrete u64/Cause/Exit layouts are 8/24/24 bytes on this Rust 1.98.1 Linux build. The research record describes measurement limits and EXIT-001–006 decisions. Affected integration passes 27/27 in seven files (187.81s total), strict TypeScript and workspace builds.
- Synced remote SQL, foldkit-plus 0.14.0 adoption and finite Stream work through 143b3ee. Added the new synchronous StreamRunCollect capture case and official/reference/native success/failure evidence; async Stream remains gated. Merged validation passes 10/10 in four files (137.56s), formatting/lint, strict TypeScript and workspace builds. Updated the open-work register and module inventory; no core PLAN edits.

## 2026-10-03 — Milestone 6 step 2: NDJSON serialization

- `NativeRpc.compile` takes `serialization: "json" | "ndjson"`, chosen as `RpcSerialization` is (STREAM-001). NDJSON reproduces the official server's line handling and quirks byte for byte.
- **Validation:**
  - `vp test tests/rpc-ndjson.test.ts`: 2 passed, synchronous and asynchronous;
  - `native-rpc`, `rpc`, `async-rpc`, `records-rpc`, `remote-wire-rpc` and `rpc-auth` pass unchanged.
- **Next:** streaming procedures (step 3), designed in [streaming-rpc.md](docs/research/streaming-rpc.md#order-of-work-and-acceptance).

## 2026-10-03 — Milestone 6 step 1: finite Stream pipelines

- **`R.Stream`** mirrors Effect v4: `make`, `fromIterable`, `range`, `empty`, `fail`, `map`, `filter`, `take`, `rechunk`, `concat`, `chunks` and `runCollect`.
  - A pipeline is data, consumed by a `StreamRunCollect` computation.
  - The reference rebuilds it with official `Stream`.
  - Natively it is one push-fused chunk loop that keeps Effect's chunk boundaries (STREAM-004).
- **Validation:** `vp test tests/stream.test.ts` passed, comparing 24 cases with the official server, every chunk boundary included. The effect, array, combinator and schema-json suites also pass (5 files, 16 tests).
- **Next:** NDJSON serialization (step 2), then streaming procedures with the async, effectful operators. [streaming-rpc.md](docs/research/streaming-rpc.md#order-of-work-and-acceptance)

## 2026-10-03 — Milestone 6 research and design

- [streaming-rpc.md](docs/research/streaming-rpc.md) records the Effect 4.0.0 HTTP stream protocol, read from the installed `effect/rpc` sources and captured from the official server:
  - over HTTP the client sends only requests, with no acks or interrupts;
  - an interrupt is the connection closing;
  - only framed NDJSON streams; JSON buffers the whole response;
  - the server buffers 16 messages and interrupts handlers when a client disconnects;
  - chunk boundaries follow the stream's internal chunks and are visible on the wire.
- **Decisions STREAM-001..006:**
  - an explicit `serialization` option, as `RpcSerialization` is chosen;
  - a bounded 16-message buffer and no acks;
  - interruption by disconnect, with awaited finalizers;
  - Effect's chunk boundaries reproduced;
  - a first finite Stream subset lowered as pull state;
  - streaming procedures.
- Order of work: Stream IR, NDJSON, streaming procedures, interruption, then a `FoldkitRemoteLive` skeleton.

## 2026-10-03 — Mutations read stored rows (RS-007)

- **New operations:**
  - `R.RemoteStore.get(entity, id)` yields the stored, wire-shaped row as `Option<Unknown>`, read where the mutation runs: the memory store, or a `SELECT` in the mutation's SQLite/Postgres transaction.
  - `R.Schema.decodeUnknownOption(R.Schema.toCodecJson(W))` mirrors Effect's and yields `Option<W>`. Natively it uses the server's verified decoders, which the library's `reffect_json` module now carries (shared through `decodeArgs`).
- **Reference.** The reference reads upstream's `MemoryStore` through `memoryStoreApi`, as `memory` looks rows up.
- **Workloads:**
  - `Bump` reads, decodes and increments a rank, refusing a null rank or an absent row. It matches upstream over memory and runs on SQLite and Postgres.
  - Overlapping read-modify-writes lose no update. On Postgres, `SERIALIZABLE` refuses one, natively and on the official server. On SQLite they serialize.
  - `examples/todo-remote` toggles by reading the stored todo; the client sends only its id.
- **Filed** foldkit-plus [#145](https://github.com/doeixd/foldkit-plus/issues/145) (Postgres `contains` folding), [#146](https://github.com/doeixd/foldkit-plus/issues/146) (NUL search defect) and [#147](https://github.com/doeixd/foldkit-plus/issues/147) (`memory` without `authorize`).
- **Validation:**
  - `remote-mutate` (3) and `remote-sql-mutate` (6, both dialects);
  - `schema-json-rpc`, `remote-acceptance`, `remote-auth`, `unknown`/`records`/`numbers` RPC, `remote-sql`;
  - `async-effect` (2; it times out only when run alongside seven crate builds);
  - `examples/todo-remote` equals upstream.
- **Design:** [RS-007](docs/research/remote-mutations.md#rs-007-reading-stored-rows-2026-10-03).

## 2026-10-03 — foldkit-plus 0.14.0 adopted

- **Upgrade.** reffect pins `foldkit-entity` 0.7.0, `foldkit-remote`/`-server` 0.11.0 and `foldkit-remote-drizzle` 0.9.1. These fix every issue reffect filed (#135–#143).
- **Native Query semantics follow upstream:**
  - containment folds ASCII only, admits non-ASCII text and refuses NUL with upstream's message (#136);
  - an ordering over a null key is refused before sorting, naming the first null in row order (#142).

  Three divergences close: NR-017 (refusals are now byte-identical), non-ASCII containment, and `Object.prototype` field names (#143).

- **Retired workarounds:**
  - the `RpcClientError` transport adapters in tests and `examples/todo-remote` (#141);
  - the vendored wire contract;
  - the Drizzle `compile.ts` snapshot;
  - the vendored memory read, except in the authorization test, because `memory` takes no `authorize`.

  The read, query, mutation and wire suites and the bench scripts serve `RemoteServer.memory(...).server` (#140), which also brings `locate` into the oracle.

- **Tests.** Tests that pinned the upstream bugs now pin their fixes. Fixtures that mutated now-frozen nodes build altered copies (#138).
- **New divergence, SQLX-018.** A NUL search is a protocol `Defect` from upstream's Drizzle source; native answers a typed `RemoteQueryError` with the same message. On Postgres, upstream's own SQL still folds `contains` by collation; that conformance case is asserted to differ there. Both are candidate upstream issues, not filed.
- **Validation:**
  - `foldkit` (6), `foldkit-upstream` (4), `remote-read`/`remote-wire-rpc` (5), `remote-query` (2), `remote-mutate` (3), `remote-auth`;
  - `sql-plan`, `remote-sql`, `remote-sql-mutate` and `remote-acceptance` (13, SQLite and Postgres);
  - `examples/todo-remote` equals upstream.

## 2026-10-03 — Upstream issues fixed in foldkit-plus 0.14.0

- All nine foldkit-plus issues reffect filed (#135–#143) were closed as completed by three upstream commits, released in v0.14.0: `foldkit-entity` 0.7.0, `foldkit-remote`/`-server` 0.11.0 and `foldkit-remote-drizzle` 0.9.1. reffect still pins the previous versions.
- What the upgrade unblocks is recorded in [foldkit-plus-issues.md](docs/research/foldkit-plus-issues.md#resolution-all-fixed-in-foldkit-plus-0140-checked-2026-10-03):
  - retiring the vendored memory fixture and the `RpcClientError` adapters;
  - the deterministic ordering refusal (NR-017);
  - ASCII-folded non-ASCII containment, with NUL searches refused;
  - closing the `Object.prototype` read divergence.

  It is now the first item of the frontier in PLAN.md and the open-work register.

- One disagreement remains upstream: its Postgres SQL folds `contains` by collation, while its evaluator now folds ASCII only. It is recorded as a candidate issue and not filed.

## 2026-10-03 — Open work register

- [docs/open-work.md](docs/open-work.md) collects every still-open item from the design and research records, PROGRESS entries, native divergences and milestones 6–15, each linked to its owning record (158 links, all anchors checked).
- It also lists stale records to refresh and notes that the foldkit-plus findings older entries call "not posted" are now filed (#135–#143).
- AGENTS.md now asks that deferred work be added there and removed when done.

## 2026-10-03 — Milestone 5 step 5: Postgres as the second SQL dialect

- The SQL planner and the native `remote_sql` module are dialect-explicit (SQLX-009..011). `NativeRemote.compile` takes `sql.dialect` (`"sqlite"` or `"postgres"`), and only that dialect's SQLx driver becomes a dependency.
  - Postgres plans use `$N` placeholders and a boolean `CASE WHEN` fold.
  - Every parameter binds as the kind its context gives it, so nulls are typed.
  - Values decode by wire type.
  - Mutations run in `SERIALIZABLE` transactions, without retries (SQLX-012).
- Columns are admitted by a per-dialect allowlist of Drizzle column types (SQLX-010). This also tightens SQLite.
- The reference store may return an Effect, for asynchronous drivers (SQLX-016).
- Validation by execution against `postgres:18.6-alpine`, with the builtin `PG_UNICODE_FAST` locale. Each test starts its own container and is skipped when Docker is unavailable. The commands, each run on both dialects:
  - `vp test tests/sql-plan.test.ts`: 5 passed;
  - `vp test tests/remote-sql.test.ts`: 2 passed;
  - `vp test tests/remote-sql-mutate.test.ts`: 4 passed.
- The Postgres untyped-parameter edge is registered in [native divergences](docs/native-divergences.md), as are the SQL-versus-memory differences that SQLX-002 promised.
- Design and findings: [sqlx-remote.md, step 5](docs/research/sqlx-remote.md#step-5-postgres-as-a-second-dialect). Milestone 5's order of work is complete.

## 2026-10-03 — Milestone 5 step 4: SQL mutations in one transaction each

- The Remote store is now a per-mutation session: an `Arc<dyn RemoteStore>` with async operations, plus `finish`/`failure`. The host commits it on success and rolls it back on failure or interruption.
  - A store failure aborts like a defect: R cannot catch it, finalizers run, and the answer is `Database query failed`.
  - Memory sessions apply at once, as upstream's memory backend does. SQL sessions are `BEGIN IMMEDIATE` transactions doing update-then-insert of the given columns.
- Found while testing: an upsert cannot partially update a row with NOT NULL columns in SQLite (NOT NULL is checked before `ON CONFLICT`). SQLX-006 is revised to update-then-insert.
- [remote-sql-mutate.test.ts](packages/reffect/tests/remote-sql-mutate.test.ts) passes: 17 stateful steps against the reference running the same R sources in a SQLite transaction, including both kinds of rollback. Details are in [sqlx-remote.md](docs/research/sqlx-remote.md#order-of-work).
- The stock Remote client gets the same results over SQL. A `Remote.clientLayer` session runs prefetch, `mutateInto` rename/create/archive, a refusal and a reload. Every model read matches between the native SQL server and upstream's handlers over Drizzle, with each run on its own SQLite file. Validation: `vp test tests/remote-sql-mutate.test.ts` (2 passed).

## 2026-10-03 — Milestone 5 step 3: Remote Read and Query over SQLite with SQLx

- `NativeRemote` gains an `sql` backend: `foldkit-remote-drizzle` bindings plus a database-URL environment variable. It is served by a SQLx 0.9.0 / bundled SQLite 3.51.3 source ([sql-runtime.ts](packages/reffect/src/sql-runtime.ts)).
  - Reads mirror upstream `source`; pages run the build-time statements and port upstream's window and page logic.
  - The engine's `Source::declares` now withholds undeclared fields.
- [remote-sql.test.ts](packages/reffect/tests/remote-sql.test.ts) passes. Its 23 wire steps match the official server using upstream's Drizzle sources over the same SQLite file. Details are in [sqlx-remote.md](docs/research/sqlx-remote.md#order-of-work).
- Probe findings recorded:
  - SQLx's SQLite decoder is strict about storage classes, so values are decoded by class.
  - The bundled SQLite builds with MSVC in about 28 s cold.

## 2026-10-03 — Milestone 5 step 2: async engine over a Source trait

- The Remote engine now reads and pages through an async `Source` trait, and the memory backend implements it with ready futures (SQLX-007). NativeRemote servers are always asynchronous. Details are in [sqlx-remote.md](docs/research/sqlx-remote.md#order-of-work).
- No behaviour change. remote-read, -query, -mutate, -auth, -acceptance and -wire pass (6 files, 15 tests), and `examples/todo-remote` still equals upstream.

## 2026-10-03 — Milestone 5 step 1: storage metadata and SQL planning

- Added [sql-plan.ts](packages/reffect/src/sql-plan.ts).
  - `storageOf` extracts static storage from `foldkit-remote-drizzle` bindings and refuses `visible`, computed members and relations other than `one`.
  - `planQuery` compiles `Query.define` bodies to fixed SQLite statements with a typed parameter plan, using upstream's lowering and keyset paging. Nullable sort columns are refused (SQLX-005).
- [sql-plan.test.ts](packages/reffect/tests/sql-plan.test.ts) passes 3/3. The planned SQL runs on `node:sqlite` against upstream's own `query` source: all 27 shared conformance cases and a tie-heavy custom set, with every cursor checked both ways, plus refusals.
- Toolchain: local stable Rust 1.99.0 (SQLX-008).

## 2026-10-03 — Native test build cache: measured, not adopted

- Tried `sccache` 0.18.0 (Scoop) on a typical generated NativeRpc crate on Windows:
  - no cache: 15 s;
  - cold cache: 18 s;
  - warm cache in a fresh directory: 14 s, with all 40 cacheable crates hitting.
- `cargo --timings` breakdown:
  - About 47 s of compilation across 58 units runs in parallel to 14 s of wall time, led by `windows-sys`, `syn`, `serde_core`, `axum`, `tokio` and `futures-util`.
  - Rebuilding only the generated crate takes 2 s.
  - The cache's per-crate overhead on Windows cancels its gain, so it is not wired in and was uninstalled.
- The lever that would pay off is compiling the pinned dependencies once: a shared target directory, which needs unique generated crate and binary names and a `CargoApi` binary-path helper for the tests. That would bring each native test's build close to the 2 s floor. Deferred until the suite's runtime blocks work.

## 2026-10-03 — Milestone 5 research and design

- Researched SQLx 0.9.0, SQLite and Postgres semantics, and upstream `foldkit-remote-drizzle` 0.9.0 against primary sources, and recorded the design in [sqlx-remote.md](docs/research/sqlx-remote.md) (SQLX-001..007).
  - SQLite comes first, and the Drizzle-backed official server is the oracle.
  - Storage metadata comes from upstream bindings at build time; callbacks are refused.
  - Nullable sort columns are refused, because upstream's keyset predicate is wrong for them on SQLite.
  - Writes are upserts, with one transaction per mutation.
- Added `foldkit-remote-drizzle` 0.9.0 as an exact devDependency. It depends on exactly our pinned Foldkit versions and imports on Effect 4.0.0, replacing the vendored compiler snapshot as a future oracle.
- Decided (delegated by the owner): SQLx 0.9.0, with the toolchain upgraded (SQLX-008); the Drizzle-backed server governs SQL behaviour (SQLX-002).
- `rustup update` took the local stable toolchain from 1.90.0 to 1.99.0. The foldkit, string-profile, remote-read, rpc-auth, async-effect and failure-frames suites pass on it (6 files, 20 tests).

## 2026-10-03 — Bounded structured task kernel

- [Stable-source preparation](docs/research/structured-concurrency.md) records TASK-001–007. Parallel agents implemented checked IR/reference/planning, native context/lowering and independent conformance. Static Unit/Never All (two/three children) and Race (two children) use independent child contexts and cancellation channels, inline futures and awaited cleanup. No task metadata accompanies scalar values or dependency is added to programs without groups. Core PLAN.md remains owned by the other instance; synced its Remote authentication/field-authorization through 6b6f59d.
- [TASKCONF-001–006](docs/research/structured-concurrency-conformance.md) evidence: 5/5 focused tests pass (137.85s); strengthened explicit-success/interruption comparisons pass 2/2 (61.81s). Seven native scenarios run debug/release under both frame policies. Controlled cancellation proves parent/loser cleanup, explicit child Scope LIFO order, masked acquisition, log-context isolation and immediate winner admission. Positive child Ref, captured parent Ref/file refusal, mutable/host-service refusal, type contracts and Full/None provenance are checked. Independent review found no blocking issue.
- Quiet two-child setup allocates twice per completed group (200 allocations for 100 groups), with no net retained allocations. Context and unpolled-future construction add zero allocations. Concrete None/Bounded contexts measure 24/32 bytes; group futures 400/424 bytes. Logging/Scope are absent from this cost fixture; enabled snapshots can allocate. Exact source-size/layout boundaries are in TASKCONF evidence.
- This is the first task kernel step, not general Fiber support or the full Deferred prerequisite. Typed failure remains refused because upstream can preserve mixed failure/interruption Cause. Explicit child handles, represented Exit/Cause and coordinator borrowing precede Deferred/Semaphore. Native hosts must cooperatively cancel and await; panic unwinding or dropping the parent future does not provide async finalization. Committed integration passes 72/72 tests in 15 files (642.63s total / 623.13s tests), formatting/lint, strict TypeScript, cached workspace builds and 320 local documentation links. The subsequent sync through 36a00d2 brings principal-aware mutations and the proposed R-language direction. Merged Remote authorization/mutation/stock-client checks pass 7/7 (97.68s); the exact quiet setup allocation budget passes 1/1 selected (66.40s). Formatting/lint, strict TypeScript and workspace builds pass after normalizing incoming documentation. A final documentation/example-only sync through 076da16 preserves the updated tiny R-language direction and browser acceptance; no compiler/runtime source changed in that sync.

## 2026-10-03 — Milestone 4 accepted in a browser

- Added [`examples/todo-remote/web`](examples/todo-remote/web): a stock Foldkit application with `Remote.fold`, `Data.active` and `foldData.mutate`, and a stock `RpcClient` as `resources`.
  - It reaches the native server through a Vite same-origin proxy. `main.ts --serve` keeps the native server running.
- Ran it in Chrome: the list rendered; add (by connection change), toggle and delete worked; a reload showed the server persisted them. `/rpc` answered 200 and the console showed no errors.
- With that run, milestone 4 is accepted within the memory profile ([status](docs/research/native-remote.md#milestone-4-status-2026-10-03)).
- The example type-checks (`vp check`). The browser run was manual with browser automation; it is not a repeatable test.

## 2026-10-03 — R language direction, simplified

- Replaced [R language direction](docs/r-language.md) with the smaller design that converges back on the original architecture: **TypeScript is the unrestricted macro/metaprogramming language; R is the tiny typed semantic language it constructs.**
- Public control stays minimal. `Match` is the branch primitive. There is no planned semantic `If`, `Let`, `Loop`, `While`, `For`, `Break`, `Continue`, `Return`, `Recur`, public `.call()`, `recursive()` annotation or `self` parameter.
- `R.fn` / `R.Effect.fn` values should be naturally callable in TypeScript. Calling one with symbolic arguments creates a hidden statically resolved `Call(FunctionRef, args)`; lazy body materialization permits self and mutual references. SCC analysis discovers recursion; semantic tail analysis lowers self-tail recursion to loops and mutually tail-recursive SCCs to state machines with bounded native stack.
- Pure naming/sharing uses ordinary TypeScript `const`; effect-result binding uses Effect composition. Future `loop`, `while`, `for`, `use`, guards, folds/unfolds and similar ergonomics belong first in ordinary build-time libraries over functions + Match + Effects. They become core only if they introduce a semantic fact the compiler cannot otherwise preserve.
- Richer native value types and opaque native extensions remain planned but are orthogonal to control-flow minimalism. Backend lowering may freely use locals, mutation, CFGs, loops and returns; those are not R surface constructs.
- Updated [PLAN.md](PLAN.md), the [docs index](docs/README.md) and [named-call research](docs/research/function-calls.md) to match. The milestone-4 → SQLx execution frontier remains unchanged.

## 2026-10-03 — Native Remote authentication and field authorization (RM-004a/b)

- Runtime-served procedures accept the checked bearer middleware; authentication is shared with NativeRpc handlers.
- `NativeRemote.compile` takes `auth` and per-entity `authorize` R functions. The engine ports `allowedFields`.
- [remote-auth.test.ts](packages/reffect/tests/remote-auth.test.ts) passes 2/2 against `RemoteServer.handlers` bound per request: three principals, denials, settled withheld fields, IDs that are not read, relations not followed, query `select`. Details are in [remote-mutations.md](docs/research/remote-mutations.md#rm-004ab-as-implemented-2026-10-03).
- Upstream finding recorded in [foldkit-plus issues](docs/research/foldkit-plus-issues.md): `RemoteServer.entity(Entity, …)` drops relation fields.
- RM-004c: mutation sources take `({ input, principal })`, as upstream's do. Reading the principal requires an authenticated Mutate. remote-auth passes 2/2 with admin, member and guest claims and an unauthenticated claim.
- Fixed: a server whose runtime functions are all synchronous no longer emits a missing `AsyncContext`.

## 2026-10-03 — Owned Clock/Random drivers

- Three agents implemented checked IR/reference/planning, native lowering/drivers and independent conformance after stable-source research. [CLOCK/RANDOM](docs/research/clock-random-modules.md), [RTS](docs/research/runtime-services-implementation.md), [DRV](docs/research/runtime-services-lowering.md) and [RTCONF](docs/research/runtime-services-conformance.md) decisions record configuration, lifetime, alternatives and limits. Core PLAN.md remains owned by the other instance; synchronized its Remote Query/Store, limits and benchmark work through b52f360.
- Added R.Clock.currentTimeMillis and R.Random.next/nextBoolean. Compile.withRuntimeServices selects services separately from primitive implementations, with explicit refusal of unselected Random. Direct live Clock stays std/context-free; injected fields and scripts are reachable and owned by native SyncContext/AsyncContext. Scalar metadata and Cargo dependencies stay unchanged. Host-script faults bypass typed recovery; full defect-finalizer semantics remain deferred. Observer clocks and real Sleep are separate from scripted computation reads.
- Focused 7/7 pass (53.86s total; 51.20s tests): official/plain/framed reference, native debug/release, both frame policies, repeat/retry/recovery, interleaved contexts and interrupted valid-script cleanup. Reviews corrected a framed Map binder evaluation bug, missing Rust helper body braces and an RPC smoke fixture's unsupported default Void payload (now explicit Undefined). Added NativeRunner frame decoder cases. The measured injected context fields add 64 bytes; prepared context/script/future construction and the specified scripted invocation allocate zero additional times. Detailed limits and raw-layout claims are in the research records. Stock-client live Clock RPC and missing-driver refusal pass 2/2 (50.23s). Registered cleanup extension passes 2/2 (29.80s), proving normal/interrupted LIFO script consumption in a separate artifact; original measurements remain unchanged. Two independent core/backend reviews found no blocking defects. Committed validation passed 200/200 tests in 59 files (1491.10s total), formatting/lint, strict TypeScript and workspace builds. A subsequent sync brings Remote mutations and Schema JSON encoding through d1fd696. The combined state passes 61/61 tests in 14 affected files (469.65s total / 449.41s tests): Clock/Random, live Clock RPC, Remote mutations/read/query/acceptance, Schema JSON, async RPC/effects, registered Scope, compiler, source maps and artifact/frame policies. Formatting/lint (291 files / 164 TypeScript files), strict TypeScript and workspace builds pass; the workspace build reused 3/4 cached tasks. Independent merge review found no blockers; DRV-006 records the separate store/driver selections. The final sync through 76b2963 adds Remote connection changes, stock-client mutation acceptance and String.concat. All 21 tests in six affected files pass (227.61s total / 216.61s tests), including fresh driver/cleanup and live Clock RPC probes; formatting/lint, strict TypeScript and builds pass again.

## 2026-10-03 — Native Remote todo example

- Added [`examples/todo-remote`](examples/todo-remote/README.md): a Foldkit domain, R mutation sources (add with an `append` connection change, toggle, delete with `remove`, a refused empty title), and a stock-client session.
  - The session runs against the native server and against upstream's memory backend running the same R sources. The example fails unless the screens are equal; run on 2026-10-03, they were.
- Findings from the workload:
  - Connection changes were required for an added todo to appear without a refetch (done, RM-005).
  - `RemoteStore.get` was not needed, because the client sends the new `done` value.
  - Appending into a title-ordered list puts the item last until a reload, which is upstream's semantics too.

## 2026-10-03 — Connection changes (RM-005) and String.concat

- `R.String.concat` mirrors Effect's `String.concat`. [string-profile.test.ts](packages/reffect/tests/string-profile.test.ts) passes 3/3, with native output equal to the reference in debug and release under both frame policies.
- `NativeRemote.connection(Query, input)` equals upstream `Query.ref(input).identity`.
  - It is built from `concat` and a host `stableStringify`, emitted beside the JSON encoders with `ryu-js` number text.
  - Host functions generalize RM-006's encoder mechanism.
- `NativeRemote.prepend/append/remove` and outcome `connections` mirror upstream. [remote-mutate.test.ts](packages/reffect/tests/remote-mutate.test.ts) passes 3/3: identity parity against upstream, and Insert/Remove changes over the wire (25 steps). Details are in [remote-mutations.md](docs/research/remote-mutations.md#connection-changes-as-implemented-rm-005-2026-10-03).

## 2026-10-03 — Native Remote mutations over a writable store

- **Store effects (RS-001):** `R.RemoteStore.write(entity, id, values)` and `remove(entity, id)` are effect nodes.
  - The reference reaches `RemoteStoreHost`, which tests give upstream's own `MemoryStore`.
  - Natively, `AsyncContext.remote_store()` is set by the host on every execution context.
  - Store nodes without a `NativeRemote` host are refused.
- **Runtime functions:** NativeRpc runtimes can call compiled R effect functions with a decoded input and get back a `RuntimeCall`. Runtime-served arms now answer through `Served`, which includes interruption.
- **Mutations (RM-001):** `NativeRemote.mutation`, `outcome`, `patch` and `ServerError` mirror `RemoteServer.mutation`, `MutationOutcome`, `Remote.patch` and `RemoteServerError`. The dispatcher keeps upstream's order and messages.
  - Mutation schemas are limited to the subset where `decodeUnknown`/`encodeUnknown` and the JSON codecs agree: finite numbers, no `optional`, and no numbers in outputs yet.
  - Non-finite numbers written or patched are registered as a divergence.
- **Validation:**
  - [remote-mutate.test.ts](packages/reffect/tests/remote-mutate.test.ts) passes 2/2. It runs a 23-step stateful corpus against the published handler over `MemoryStore`, compares raw key order, and asserts that each path is reached.
  - Regression suites pass: remote-read, remote-query, remote-acceptance, async-rpc, server-layer and async-effect (13 tests). One stale refusal assertion in remote-read was updated, because Mutate is now served.
- **Acceptance through the stock client:** [remote-acceptance.test.ts](packages/reffect/tests/remote-acceptance.test.ts) passes 2/2. `Remote.mutateInto`, a refusal, a synchronous (store-free) source and a fresh read all equal upstream's memory layer running the same R sources over its `MemoryStore`.
- **Remaining for milestone 4:** authorization as compiled R functions (RM-004) and connection changes (RM-005).

## 2026-10-03 — Linux measurements and the writable store

- **Linux benchmark** ([remote-bench.md](docs/research/remote-bench.md#linux-with-a-native-load-generator-bench-003), oha 1.16.0 as the client, glibc):
  - Native uses 15.4 MiB resident memory against 334.6 MiB for the official server.
  - read-one: 14,175 versus 2,545 req/s.
  - read-batch-50: 1,225 versus 1,032 req/s; engine allocation dominates, as recorded under BENCH-002.
  - query-page-20: 1,438 versus 743 req/s.
  - The bench now retries its pre-timing equality check once, because oha leaves fetch's pooled socket past the server's keep-alive.
- **Store phase A** ([remote-mutations.md](docs/research/remote-mutations.md#store-progress)):
  - The memory tables are one writable store behind an `RwLock`, with a version counter.
  - Rows are shared `Arc<JsObject>` values.
  - `get`/`write`/`remove` follow upstream `MemoryStore`.
  - Query cells are cached per store version.
  - Remote read, query and acceptance pass (6/6).
- **Design:** mutations use typed, wire-shaped values (RM-006, RS-001/RM-001 refined), because upstream `Remote.patch` takes `Partial<Struct.Encoded<F>>`.
- **RM-006 implemented:** `R.Schema.encodeSync(R.Schema.toCodecJson(witness))` turns typed values into `Unknown`.
  - Each witness is an interned operation that needs the host `JsonEncoders` capability; a plain `Compile` refuses it.
  - NativeRpc emits a `reffect_json` library module from its verified encoders.
  - [schema-json-rpc.test.ts](packages/reffect/tests/schema-json-rpc.test.ts) matches official `toCodecJson` byte for byte (2/2).
  - Array and record encoders now take slices. Regression: arrays, records, records-js, unknown, optional, tagged-errors, literals and remote-read RPC suites pass (8 files, 17 tests).

## 2026-10-03 — First native versus official Remote measurements

- Added a benchmark ([remote-bench.md](docs/research/remote-bench.md)): both servers in separate processes, the same workloads, and answers checked equal first. **Peak memory: native 20 MiB versus official about 270 MiB.**
- Over HTTP, native is never slower, but the numbers are bound by the Node client (a Windows timer-tick floor of about 15.6 ms per `fetch`, the same for both servers). Throughput claims wait for a native load generator or a Linux host.
- Engine timed in-process against V8 (official handlers in-process):
  - The literal port started **2× slower** on Read (660 versus 334 µs).
  - Fixed: per-request evaluator cells are now cached per query (HTTP query 103 → 400 req/s); grouping merges in place; record values move instead of being cloned three times (Read 660 → 568 µs).
  - Allocation dominates the rest: with `mimalloc`, Read is 287 µs and Query 405 µs, ahead of V8 (334/885). The allocator choice is recorded as an option, not adopted.
- The native server now sets `TCP_NODELAY` like Node's HTTP server. Remote read, query and acceptance suites pass (6/6) after each change.

## 2026-10-03 — Request limits, depth and upstream findings

- Probed transport limits against the official server. 1–8 MB bodies are accepted officially; natively they were refused (connection reset at the 64 KiB hardening limit). Payloads nested about 127+ levels deep are accepted officially, but refused whole natively by `serde_json`'s recursion limit. Both are now in the [divergence register](docs/native-divergences.md), along with the 64-request batch limit.
- `NativeRpc.compile` accepts `limits: { bodyBytes, batch }` (defaults 64 KiB / 64). `NativeRemote` defaults to a 4 MiB body, because Remote batches whole screens into one Read; a 130 KB Read batch is now a `remote-read.test.ts` scenario that fails with `413` under the old limit.
- Recorded four upstream suggestions in [foldkit-plus issues](docs/research/foldkit-plus-issues.md#native-remote-integration-findings-2026-10-03-foldkit-plus-0130): export the memory server definition; accept `RpcClientError` in `RemoteRpcClient`; give ordering refusals deterministic text; use own-key lookups.

## 2026-10-03 — Native test parallelism

- Every native test runs a `cargo build` that already uses all cores, so default Vitest parallelism oversubscribed the CPU: earlier, six heavy suites hit their budgets. A shared Cargo target directory was rejected because Cargo reports only the uplifted binary path, which would collide between crates.
- `packages/reffect/vite.config.ts` now sets `maxWorkers: 4`. Full suite: **188/188 tests in 56 files pass, 572 s, no timeouts** (`vp test --maxWorkers=4`, Effect 4.0.0).

## 2026-10-03 — Divergence register; byte-identical key order

- Added [native divergences](docs/native-divergences.md), the single register of observable differences from official Effect/Foldkit: 9 runtime differences with their decisions and possible fixes, closed entries, and the compile-time profile. It is linked from the docs index and AGENTS.md; new accepted differences must be added there.
- Closed REC-005. Every NativeRpc crate enables `serde_json`'s `preserve_order`, so envelopes and structs keep schema/insertion order. `records-rpc.test.ts` now asserts raw response bytes equal to the official server's; removing the feature fails it (the envelope's `requestId` position already differed).

## 2026-10-03 — Milestone 4 acceptance for Read and Query

- [remote-acceptance.test.ts](packages/reffect/tests/remote-acceptance.test.ts) runs the stock Foldkit Remote client flow (`Data.prefetch`, `projection.read`, `Data.more`) twice:
  - once against upstream's own `RemoteServer.memory(...).layer`, entirely official code;
  - once through `Remote.clientLayer` over an ordinary Effect RPC HTTP client to the native server.

  It covers an entity with a relation, an absent id, a paged to-many relation, a query read forward over three pages and backward. The resulting projections are strictly equal.

- A native engine that ignores `first` makes the test fail. `foldkit-surface` 0.6.0 is now an exact devDependency (it was only transitive).
- **Upstream finding:** `RemoteRpcClient` admits only Remote's errors, so a stock Effect RPC client (which adds `RpcClientError`) needs a small transport adapter (`catchTag("RpcClientError", die)`). Upstream examples avoid it with hand-written transports. Remote could accept, or document mapping, transport errors.

## 2026-10-02 — Native Remote Query

- Recorded the [Query design](docs/research/native-remote.md#query-design-step-3-accepted-2026-10-02) (NR-014–017). `NativeRemote.compile(group, { domain, rows })` now takes the same `Remote.define`/`Remote.make` descriptor as `RemoteServer.memory`, and refuses body-less queries as `memory` does.
- How queries are compiled:
  - `Foldkit.embed` compiles each `Query.define` body, plus an order-only twin for keyset `locate`, with the milestone-1 adapter into the generated crate.
  - The Remote engine encodes rows and inputs per slot, ports `pageOf` with `locate` and the reference messages, and answers `select` through the read engine.
  - Inputs are validated with `decodeUnknown` semantics (primitive Structs; excess keys ignored), and rows are checked against the queries' field kinds while compiling.
- Validation (focused):
  - `remote-query.test.ts` 2/2: 22 wire scenarios equal the published `RemoteServer.handlers` with memory query sources (vendored run closure; real `evaluate`), raw key order included.
  - The null-ordering refusal (NR-017: same error class, different text) is asserted.
  - Making `locate` exact fails the test.
  - Read, Foldkit conformance and NativeRpc suites pass (17 tests), as does `vp check`.

## 2026-10-03 — Prioritized Effect module expansion

- At the user’s request, six agents implemented or inventoried missing Effect v4 modules in parallel while leaving the core PLAN.md untouched. [Preparation decisions](docs/research/module-expansion.md) establish isolated file ownership, checked specialization and bounded admission. [Coverage](docs/effect-module-coverage.md) accounts for 138 root namespaces and 213 grouped exports with six dependency-ordered waves; it verifies actual pinned package paths rather than the stale historical API reference. Initial research used rc.118; synchronized remote through 46a0cfc, including the coordinated Effect 4.0.0 stable migration and native Remote wire contract.
- Added structural Option and Result modules, Effect.result, canonical catch/tap/as/asVoid/catchIf/matchEffect, Array some/every/findFirst and empty predicates, Record emptiness and Boolean/Predicate composition. Duration reuses official authoring-time functions and widens Sleep inputs through checked normalization; Schedule behavior remains unchanged. Existing IR/native representations implement these additions without new crates or per-value metadata. Module decisions include alternatives, costs and revisit triggers.
- Focused Option 3/3, Result 3/3, Effect helpers 3/3 and collections 4/4 pass official/reference and fresh native debug/release checks. Duration 3/3 and a cheap existing Schedule case pass without native builds. A public composition fixture passes through Option, Result, predicates, arrays and typed recovery under both frame policies. Review corrected callback duplication, variant-order assumptions, a callable Array namespace length descriptor collision and test setup/type mistakes. Lexical Ref adds make/get/set/update/modify over native scalar locals, preserving allocation identity, lexical Layer sharing, async ownership and explicit escape/capture refusals. Ref focused 2/2 passes, including isolation, cancellation/finalization, provenance and release allocation/layout probes. Two independent Ref reviews found no additional defects. After synchronization, all seven new module/composition suites pass on Effect 4.0.0: 19/19 tests in 99.72s (89.07s tests), serial workers and fresh native debug/release builds. Formatting/lint, strict package TypeScript and workspace build pass. Committed serial stable validation passes **183/183 tests in 54 files**, 1231.03s total / 1182.07s tests, with `CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 vp test --maxWorkers=1 --reporter=verbose`. Formatting/lint, strict TypeScript and workspace builds pass after review. An earlier full run was interrupted by workspace restart and is not counted. Subsequently rebased onto remote 037d61c (native Remote read engine and published Foldkit-plus packages), preserving both progress records; Combined-state validation passes **35/35 tests in 13 files**, 361.80s total / 341.27s tests: native RPC, authorization, constrained schemas, server Layers, Remote wire/read and all seven new module suites, serial with fresh native builds. Formatting/lint, strict TypeScript and workspace builds pass on the combined state. Coverage now names injected Clock/Random as the next module workload.

## 2026-10-02 — foldkit-entity 0.6.0

- Moved reffect's `foldkit-entity` pin from 0.4.0 to **0.6.0**, the version `foldkit-remote` 0.10.0 builds queries with (NR-007 recheck). The 0.4.0 → 0.6.0 dist diff adds `SchemaShape`/`Words`, tightens an internal `tagOf`, and refactors entity input mapping into `switch`es. `Expr`, `Query` and `evaluate` are unchanged.
- Validation: `foldkit.test.ts` and `foldkit-upstream.test.ts` (milestone-1 Query conformance through official `evaluate`, Drizzle/SQLite and native debug/release, plus the shared upstream conformance cases) and `remote-read.test.ts` pass 13/13. The Query operation IDs keep `@0.4.0`, since they name semantics first verified at that version and unchanged since.

## 2026-10-02 — Native Remote read engine

- Ported the reference read path into a Rust runtime module ([remote-engine.ts](packages/reffect/src/remote-engine.ts), NR-008–013):
  - `readHelper`, `splitAliases`, `groupByEntity`, `mergeRelation`, `refsIn`, the id/page/depth limits with exact messages, the protocol check with JS number text (`ryu-js`), and the memory backend's `valueFor`/`pageOf`;
  - JS objects (`JsObject`: index keys first), `Map`/`Set` insertion order, and absent/`undefined` collapsing to `Option`.
- NativeRpc gained a runtime-procedure hook (`compileServer`, `RpcRuntime`). The generated decoder validates the payload with official messages, then runtime Rust serves it. Result contracts are admitted against a scratch registry, and payload types stay reachable so their native types are emitted.
- `NativeRemote.compile(group, { entities, rows })` embeds memory rows at build time (JSON data; string ref lists) and serves `FoldkitRemoteRead`. Mutate and Query are refused until steps 3–4, and `Live` remains NR-006.
- Validation (focused):
  - `remote-read.test.ts` 3/3. The vendored wire fixture derives exactly the published `RemoteRpc` witnesses for Read, Mutate and Query.
  - 27 wire scenarios match `RemoteServer.handlers` with memory sources, raw key order included; a stock `RpcClient` reads through the native engine.
  - Mutations that drop window grouping or `ryu-js` number text fail.
  - NativeRpc, remote-wire, TaggedError, schema, auth and server-layer suites pass, as does `vp check`.
- foldkit-plus 0.13.0 was published during this work. `foldkit-remote`/`foldkit-remote-server` 0.10.0 and `foldkit` 0.165.0 are now exact devDependencies, and `remote-read.test.ts` passes 3/3 against the npm packages, with a single Effect 4.0.0 copy. `foldkit-entity` 0.6.0 is nested under them; reffect's own pin stays 0.4.0 until the Query adapter recheck.

## 2026-10-02 — Remote wire contract compiles natively

- Vendored the `foldkit-remote` 0.9.0 wire module (MIT) as a [test fixture](packages/reffect/tests/fixtures/foldkit-remote-wire.ts). Only the Effect 4.0.0 import paths, class self types and an unrolled `relationLevel` changed; the schemas are identical.
- Added `NativeRpc.witness(schema, { position })`, which derives the R witness that a contract schema maps onto, plus the `WireValue` type. Handlers read Remote's large request types (eight nested relation levels) through it. R-built result witnesses intern to the same contract witnesses, which the test asserts.
- `NativeRpc` now refuses streaming procedures by name (`Live`, NR-006) instead of failing on the stream schema. The binding types already reject any R handler for a stream success.
- Moved the order-preserving JSON reader into `tests/raw-json.ts`.
- Validation (focused):
  - `remote-wire-rpc.test.ts` 3/3. Read (version check → `RemoteProtocolError`; settled fields), Mutate (Unknown output; `Insert` connection with a literal position) and Query (`Cursor` boundary; `RemoteQueryError`) run over 22 raw requests, all strictly equal to the official server, raw key order included. Coverage: nested relations to the last level and beyond, 257 fields, invalid page sizes, wrong versions and missing keys.
  - A stock `RpcClient` for the unchanged contract round-trips and receives class instances.
  - `unknown-rpc` and `native-rpc` pass, as does `vp check`.

## 2026-10-02 — String literal unions

- Recorded [literal-union decisions](docs/research/literal-unions.md) (LIT-001–003) from Remote's `position: "prepend" | "append"` and probes on Effect 4.0.0. Mismatches read `Expected "a" | "b"`, and inside `optional` only non-strings gain `| null`.
- Added `R.Literals([...])` (string literals; a Copy unit-variant Rust enum; values from `.literal(...)`). `NativeRpc` maps plain string literal unions and single string literals onto it, with Effect's own mismatch text.
- Validation (focused):
  - `literals-rpc.test.ts` 2/2: 32 raw requests at the top level, in fields and in `optional` fields, plus handler-built literals, all strictly equal to the official server. Numeric literals are refused.
  - Records, TaggedError, records reference and compiler suites pass (18 tests), as does `vp check`.

## 2026-10-02 — Plain Schema.String in requests (STR-008)

- Per the user's decision (option 1), `NativeRpc` now decodes plain `Schema.String` onto `R.String`, as Remote's requests require. It is recorded as [STR-008](docs/research/string-profile.md#plain-schemastring-in-requests-2026-10-02): the official server accepts lone-surrogate escapes and runs the handler, while the native server refuses the whole body (`Invalid JSON`). `StringJson` remains the exact choice for new contracts.
- Validation (focused): `string-rpc.test.ts` 2/2, with plain-String successes, wrong kinds and a missing field matching the official server, and the divergence asserted on both sides. `records-rpc` 3/3: the old refusal test now checks witness agreement.

## 2026-10-02 — Raw Unknown as JSON data

- Recorded [Unknown decisions](docs/research/unknown-json.md) (UNK-001–004) from Remote's `values`/`input`/`output` and probes on Effect 4.0.0. The official server returns Unknown data **as `JSON.parse` saw it**: objects in JS key order at every depth, numbers as doubles (`1.0`→`1`, `-0`→`0`, large integers rounded), duplicate keys last-wins. `1e400` is a per-request `Expected JSON value`.
- Added `R.Unknown` (natively `serde_json::Value`; no literals or operations). A reachable Unknown, including inside layouts, derives `reffect/capability/json@1`. The plan then lists `serde_json`, and generated crates depend on it with `preserve_order`. Programs without Unknown are unchanged. The native runner excludes Unknown functions.
- `NativeRpc` decodes Unknown by rebuilding it in `JSON.parse` form (`js_json`) and encodes it unchanged. It works at the top level, in fields, in records, in arrays and in projected payloads. Refused: `optional(Unknown)`, annotated Unknown and literals.
- **Open decision:** Remote's requests decode plain `Schema.String` (ids, names, `requestId`, field lists), which STR-006 refuses. Options are recorded in the [Unknown record](docs/research/unknown-json.md#open-question-for-the-remote-contract-recorded-2026-10-02). Remote's responses also use a non-tagged literal union (`"prepend" | "append"`).
- Validation (focused):
  - `unknown-rpc.test.ts` 2/2: about 55 raw requests strictly equal to the official server, with **raw** key order compared through an order-preserving reader, since `JSON.parse` hides index-key order. Capability and crate derivation, literal refusal and the `1e400` divergence are asserted.
  - Dropping the JS key partition in `js_json` fails the test.
  - Records, TaggedError, compiler, effect, native RPC, numbers and emission suites pass (8 files, 29 tests), as does `vp check`.

## 2026-10-02 — TaggedError classes in RPC error schemas

- Recorded [TaggedError decisions](docs/research/tagged-errors.md) (TE-001–004) from Remote's error classes and probes on Effect 4.0.0. A class is a `Declaration` encoding to its tagged struct. Failures go over the wire as the struct form. A handler failing with a plain object (not an instance) is a defect, so JS boundaries must build instances.
- `NativeRpc` maps TaggedError classes in success and error schemas onto `R.TaggedUnion` cases: a union of classes becomes the union, and one class becomes a one-case union. Each class is verified by round-tripping a generated struct sample through it. Plain `Schema.String` is now admitted in encoded positions, where native strings encode exactly. Binding types map classes to their field data (`ErrorData`).
- Validation (focused):
  - `tagged-errors-rpc.test.ts` 2/2. Read/protocol failures (including `-0`, `Infinity` and non-ASCII messages), successes, invalid payloads and a single-class error are strictly equal to the official server. A stock client receives `instanceof ReadError`/`ProtocolError` with the same fields.
  - Refusals: a class in a payload, an untagged `Schema.Class`.
  - String, records, native, schema, optional and auth RPC suites pass, as does `vp check`.

## 2026-10-02 — Array length checks

- Recorded [length-check decisions](docs/research/array-length.md) (LEN-001–003) from Remote's only use (`Fields = Array(String).check(isMaxLength(256))`, requests only) and probes on Effect 4.0.0. Elements decode before checks run, and only the first failing check is reported. `NonEmptyArray` is a tuple.
- `NativeRpc` admits decode-only `isMaxLength`/`isMinLength`/`isBetweenLength` (including `isNonEmpty`) on `Schema.Array`. Each is recognized by representation id and verified by running Effect's filter on probe lengths. The generated decoder checks `out.len()` after the elements. Fixed-size `[T; N]` stays deferred because no workload needs it.
- Validation (focused):
  - `array-length-rpc.test.ts` 2/2: 26 raw requests strictly equal to the official server (top-level, nested and optional checked arrays; bounds ±1; element failures before length failures); refusals of checked outputs and `isUnique`.
  - An off-by-one mutation in the native `isMaxLength` predicate fails the test.
  - `arrays-rpc`'s refusal test now covers `isUnique` and `NonEmptyArray`, since length checks are admitted.
  - Arrays, optional, numbers, records-js and native RPC suites pass, as does `vp check`.

## 2026-10-02 — Oracle moved to Effect 4.0.0 stable

- Pinned `effect` and `@effect/platform-node` to **4.0.0**, replacing rc.118, ahead of the Remote harness (NR-007). One Effect copy is installed. I compared the rc.118 and 4.0.0 sources for the modules reffect uses (Schema/SchemaAST, union codecs and formatter, Record, HttpEffect, RpcClient). The changes are internal: candidate indexing, codec member ordering, and request scopes closing with the failure cause. None changes a pinned message.
- Validation (full suite, needed for an oracle change):
  - `vp check` passes.
  - `vp test`: 146/152 pass.
  - Six heavy native suites stopped exactly at their 120/240/360 s budgets under parallel Cargo builds: arrays, async-effect, async-rpc, error-recovery, records and scope-registration.
  - Rerun serially (`vp test --fileParallelism=false` on those six files), they pass 17/17 in 409 s. No semantic differences were found.

## 2026-10-02 — String-keyed records in JS key order

- Recorded [record decisions](docs/research/records-js-order.md) (RECJS-001–005) after probing `Schema.Record(Schema.String, V)` under rc.118:
  - Decoding follows JS own-property order: array-index keys first, ascending, then insertion order.
  - A duplicate key keeps its first position and its last value.
  - The first failing entry is reported in that order.
  - Clients observe key order after decoding.
- Added `R.Record(R.String, V)` (natively `Vec<(String, V)>` in JS order) with `keys`, `values`, `size` and `has`, mirroring `effect/Record`. A kernel `RecordQuery` node backs them.
- `NativeRpc` decodes records through a JS-order entry partition and encodes in that order. Crates that reach a Record enable `serde_json`'s `preserve_order` feature; others are unchanged. Refused: checked or non-String keys, optional values, records combined with properties.
- Validation (focused):
  - `records-js.test.ts` 1/1 (reference parity with `effect/Record` on index-like, `__proto__` and ordinary keys).
  - `records-js-rpc.test.ts` 2/2. About 30 raw requests are strictly equal to the official server, and key sequences are equal at every depth. Stock-client round trips succeed, and the refusals are covered.
  - Removing the index-key partition fails the test; so does removing `preserve_order`.
  - 16 related files (50 tests) pass, and `vp check` passes.

## 2026-10-02 — Qwik closure-conversion research

- Researched current Qwik v2 optimizer closure extraction/capture analysis and Oxc/SWC scope handling as prior art for milestone 8B. The new [Qwik closure-conversion note](docs/research/qwik-closure-conversion.md) adopts boundary-first capture analysis, binding-aware free-variable resolution, explicit CapturePlans and mutation/ownership classification, while rejecting Qwik's serialized QRL environment as reffect's target representation.
- Key conclusion: the Foldkit SSR inventory's 1,184 closures are an upper-bound syntax count, not 1,184 runtime closure requirements. The next migration measurement should add function-level SSR reachability and classify callbacks by known semantic boundary, capture type, writes/escapes and mechanical transformability. The proposed QC-0–QC-5 slices keep the work in migration tooling and reuse the existing R IR/compiler rather than widening the core parser.
- Verified upstream Qwik v2 at commit `8eb4589be115eb8f2dabfd12c107dcc23647caec`, including the TypeScript Oxc capture/gather passes, Rust optimizer architecture, block/loop/computed-key regression tests, generated-name hygiene guidance and current optimizer/serialization documentation. Qwik is MIT; the note recommends adapting design/tests rather than taking a runtime dependency.

## 2026-10-02 — Native types research (proposed)

- Searched the docs (architecture §9–10 already lists sized/tuple/fixed-array representations; no JS-type crate was recorded) and crates.io. Recorded the [native types proposal](docs/research/native-types.md):
  - `ryu-js` is a candidate for byte-exact number encoding.
  - Boa's `JsString` has the right UTF-16 semantics but is `!Send`, so it is limited to single-task helpers.
  - Sized integers, tuples, fixed arrays and bytes become witnesses selected from verified Effect checks (`isInt32`, `isBetweenBigInt`, `isBetweenLength`, `Schema.Tuple`), with overflow behaviour named per operation.
- The Remote wire order is unchanged: `Record`, then array length checks (as `[T; N]`). No code changed.

## 2026-10-02 — Optional struct fields

- Recorded [optional-field decisions](docs/research/optional-fields.md) (OPT-001–005) after probing `Schema.optional`/`optionalKey` JSON codecs under rc.118. Findings: `null` decodes as a **present** `undefined`; a present `undefined` encodes as `null` while an absent key is omitted; type mismatches gain `| null` only for JSON kinds the item rejects; `optional(Struct({}))` accepts any value.
- Added `R.UndefinedOr(T)` (native `Option<T>`) with `match` and `map` mirroring `effect/UndefinedOr`, plus `R.optional(T)`/`R.optionalKey(T)` struct fields. `make` may omit optional keys, and `Struct.get` reads `T | undefined`. Natively, `optionalKey` is `Option<T>` and `optional` is `Option<Option<T>>`, so presence round-trips. The kernel gains `MatchUndefined`, `Defined` and `Undefined` nodes, and `Make` admits absent entries.
- `NativeRpc` decodes and encodes optional fields by presence. Each `optional` field's mismatch text is verified while compiling by running Effect's decoder on one probe per rejected JSON kind. Refused: `optional(Struct({}))`, optional fields in projected payload bindings, and non-plain key contexts.
- Validation (focused): `optional-fields.test.ts` 3/3 (Schema parity, presence and key order, `UndefinedOr` parity with Effect, type-level construction errors). `optional-rpc.test.ts` 2/2: about 170 raw requests strictly equal to the official server, including echo and rebuild handlers; stock-client round trips keep absent versus present `undefined`; refusals. Making native `null` decode as absent fails the differential test. Records, arrays, numbers, string, native/schema RPC, compiler, effect, emission and scope suites pass (14 files, 47 tests). `vp check` passes; TypeScript 5.9.3, 6.0.3 and 7.0.2 typecheck clean.

## 2026-10-02 — Remote version assumption (NR-007)

- Checked versions. Effect 4.0.0 stable was published on 2026-10-01, and `foldkit` 0.165.0 already peers on it. `foldkit-remote`/`foldkit-remote-server` 0.9.0 cannot load under rc.118 (`effect/unstable/rpc` moved to `effect/rpc`), so their narrow peer range is accurate.
- Per the user's decision, reffect assumes foldkit-plus will be upgraded to Effect 4.0.0 stable. It does not isolate, vendor or patch the rc.116 packages. The wire slices continue with locally mirrored schemas. Before the differential harness, reffect moves its oracle pin to 4.0.0 and rechecks the Query adapter against the upgraded `foldkit-entity`. Details: [native RemoteServer design → Versions](docs/research/native-remote.md#versions). No code changed.

## 2026-10-02 — JS numbers, part B (RPC codec)

- `NativeRpc` admits `Schema.Number` (plain, and checked with `isInt`/`isFinite`/range filters recognized by representation id and verified by running them) at top level, in fields, in structs and in arrays. Generated codecs follow `toCodecJson`'s finite rule and encode like `JSON.stringify`. Codec names now derive from the full codec structure. Verification found that Effect range filters order NaN below every number (upper bounds accept NaN); native predicates match.
- Validation (focused): `numbers-rpc.test.ts` 2/2 (about 70 raw requests strictly equal to the official server; stock-client round trips; refusals); dropping the native safe-integer bound fails it. `records-rpc`, `arrays-rpc`, `string-rpc`, `native-rpc`, `schema-rpc`, `rpc-auth`, `server-layer` and `async-rpc` pass 18/18 in 8 files. TypeScript and `vp check` pass.

## 2026-10-02 — JS numbers, part A (witness and operations)

- Recorded [number decisions](docs/research/number-profile.md) (NUM-001–005) after reading `SchemaAST.Number.toCodecJson` and probing plain and checked codecs. Added `R.Number` (f64; Copyable, not Eq/ordered) with `literal` (bit-exact native literals), `add`, `eq` and `lt`; the runner passes doubles as their hex bits.
- Validation (focused): `numbers.test.ts` 2/2 (169 pairs including NaN, ±Infinity, ±0, subnormals and 2^53 neighbours against JS; native debug/release bit-exact on a subset). `string-profile`, `effect`, `rust-emission-output` and `compiler` still pass. TypeScript and `vp check` pass. The RPC codec is part B.

## 2026-10-02 — Native RemoteServer design (proposed)

- Read the full `foldkit-remote-server` 0.9.0 handler implementation and the shared `foldkit-remote` helpers, then recorded the [native RemoteServer design](docs/research/native-remote.md). Proposed: a literal semantic-port engine (the milestone-1 precedent), wire codecs generated from the unchanged `RemoteRpc` group, explicit JS ordering rules, the memory backend first, compiled Sources and authorization next, and a differential harness against the official server plus a stock client. Open: the published packages' `effect` peer range excludes rc.118, and they use `foldkit-entity` 0.5.0. No code changed.

## 2026-10-02 — Milestone 4 gap analysis

- Measured the `foldkit-plus` Remote wire and server against admitted features and probed pinned Effect codecs for `Schema.Number` (non-finite strings, safe-integer `isInt`), `Schema.optional` (null decodes as absent; undefined encodes as null) and `Schema.Record` (JS key order: integer keys first). Recorded in the [gap analysis](docs/research/remote-gap-analysis.md): design the native Remote engine next, since it decides which generic schema features are needed (for example, `Unknown` becomes typed per-entity codecs and two-stage input decoding). No code changed.

## 2026-10-02 — Arrays, part C (RPC codecs)

- `NativeRpc` recognizes plain `Schema.Array(item)` recursively and generates decoders and encoders with official `Expected array` text and unquoted index path segments; tuples and checked arrays are refused.
- Validation (focused): `arrays-rpc.test.ts` 2/2 (15 raw requests identical to the official server, stock-client round trips, refusal); quoting index segments natively fails the test. `records-rpc`, `string-rpc`, `native-rpc`, `schema-rpc`, `rpc-auth`, `server-layer` and `arrays` pass 17/17 in 7 files. TypeScript 5.9, 6.0.3 and 7.0.2 report no errors; `vp check` passes.

## 2026-10-02 — Arrays, part B (Effect.forEach)

- Added dual `R.Effect.forEach` with optional `discard` as a Computation `ForEach` node (sequential, fail-fast; concurrency refused), delegating to official `Effect.forEach` in the reference and lowering to one awaited loop with early return natively.
- Validation (focused): `arrays.test.ts` 3/3 (official vs reference exits and log counts; native exits, log order, discard and async bodies under both frame policies). `records`, `effect`, `error-recovery`, `flow`, `async-effect`, `scope-registration` and `failure-frames` pass with it, 27/27 in 8 files. TypeScript 7 and 5.9 report no errors.

## 2026-10-02 — Arrays, part A (pure structured iteration)

- Searched architecture §6/§9/§10/§15/§27 and the Foldkit IR sketches, probed pinned `effect/Array`, `Effect.forEach` and `Schema.Array` decoding, and recorded [array decisions](docs/research/arrays.md) (ARR-001–006) first. Implemented `R.Array` with `make`/`empty`/`length` and dual `map`/`filter`/`reduce` (element and u64 index binders) as kernel `ArrayMake`/`ArrayLength`/`ArrayLoop` nodes. Native lowering emits one loop per operation over borrowed elements.
- Validation (focused): `arrays.test.ts` 3/3 (reference vs `effect/Array`; native debug/release under both frame policies). `records`, `records-rpc`, `string-profile`, `effect`, `rust-emission-output`, `flow`, `compiler` and `scope-registration` pass 35/35 in 8 files. TypeScript 7 and 5.9 report no errors; `vp check` passes.

## 2026-10-02 — Records and tagged unions, part 2 (RPC codecs)

- `NativeRpc` now recognizes contract Structs (with optional `identifier`) and `_tag`-literal unions recursively, maps them onto interned R witnesses, decodes whole or projected payloads, and encodes composite results and typed errors through generated serde_json codecs. Top-level messages come from Effect's default formatter at compile time; paths are appended natively. `CaseType` became an explicit interface after TypeScript 5.9 and 7 disagreed on the earlier `Omit` intersection.
- Validation (focused): `records-rpc.test.ts` 2/2 with 28 raw requests identical to the official server plus stock-client round trips. `native-rpc`, `schema-rpc`, `string-rpc`, `rpc`, `rpc-auth`, `async-rpc`, `server-layer`, `records` and `module-composition` pass 30/30 in 9 files. Strict package TypeScript (7.0.2) and TypeScript 5.9 both report no errors; `vp check` passes. The full suite was not run.

## 2026-10-02 — Records and tagged unions, part 1b

- Added effectful tagged-union branching: `match`/`valueTags` handlers that all return Computations build a Computation `MatchTags` (channels joined like `R.Match.bool`), with checking, substitution, both reference evaluators, scope analysis and native lowering over borrowed case values, including across `.await`.
- Validation (focused): `records.test.ts` 3/3, adding sync and async effectful branching against official `TaggedUnion.match` and native debug/release on Tokio under both frame policies. `effect`, `error-recovery`, `flow`, `async-effect`, `rust-emission-output`, `failure-frames`, `string-profile` and `frame-policy` pass 24/24 in 8 files. Strict package TypeScript and `vp check` pass.

## 2026-10-02 — Records and tagged unions, part 1a

- Probed pinned RC.118 Schema/RPC decoding for structs, tagged unions and literals, and recorded refined decisions REC-001–006 in [records and tagged unions](docs/research/records-unions.md) before implementation.
- Implemented expression-level `R.Struct`/`R.TaggedUnion`/`R.Struct.get`/`Union.match`/`R.Match.valueTags` with structural interning, an `IRType` `Layout`, and kernel `Make`/`Get`/`MatchTags` nodes. Native lowering emits Rust structs and enums. Non-Copy values follow one rule (borrowed names, owned locals, borrowed operands, copies only in value positions), replacing the string-only rendering. Delayed cleanup refuses all non-Copy captures; runner arms skip composite signatures.
- Validation (focused): `records.test.ts` 3/3 (official `TaggedUnion.match` vs reference; refusals and type contracts; native debug/release under both frame policies). Regression suites `string-profile`, `string-rpc`, `effect`, `rust-emission-output`, `flow`, `compiler`, `unit`, `error-recovery`, `server-layer` and `source` pass 47/47 in 10 files; `scope-registration`, `heartbeat`, `resource-layer` and `scoped-files` pass 14/14 in 4 files. Strict package TypeScript and `vp check` pass. The full suite was not run.

## 2026-10-02 — Records and tagged unions proposal

- Searched existing designs (architecture §7–§13, compiler design §5, basic Effect IR, schema/unary-RPC/string records, Foldkit Remote) and the `foldkit-plus` Remote wire schemas, then drafted [records and tagged unions](docs/research/records-unions.md) (REC-001–005, proposed). Core `foldkit/foldkit` does not contain Remote; the Remote packages live in `foldkit-plus`, the Foldkit ecosystem package collection (corrected from an earlier "fork" description), which milestone 4 targets. Implementation waits for review.

## 2026-10-02 — Well-formed strings at the RPC boundary

- Consulted SCHEMA-001/003 and the unary-RPC record, then probed the pinned official `RpcServer`. Plain `Schema.String` accepts lone surrogates; a well-formed check refuses them per request. Added canonical `RpcCodecs.StringJson`/`NativeRpc.StringJson` (STR-006) with a shared `unicode.ts` check, a native `string_arg` decoder and JSON string encoding for payloads, fields, results and typed errors; plain `Schema.String` is refused. A lone-surrogate escape fails the whole native body (STR-007, documented divergence).
- Validation: `vp test packages/reffect/tests/string-rpc.test.ts` passes 2/2. Nine raw requests give identical official/native response JSON, the divergence is asserted exactly, and stock-client round trips succeed; a mutated native message fails the test. `native-rpc`, `schema-rpc`, `string-profile`, `rpc` and `rpc-auth` pass 22/22 in 5 files. Strict package TypeScript and `vp check` pass.

## 2026-10-02 — AGENTS.md conformance cleanup and milestone 8 split

- Re-read AGENTS.md in full and fixed deviations in this session's work: manual `_tag` comparisons in the literal-argument check, string rendering, launch-tuple collection and string boundary detection now use `Match`/`Option`, and test casts became Schema decoding or plain inference.
- Per user direction, split milestone 8 like 3A/3B. 8A is fully native SSR authored in R; 8B mechanically transforms pinned upstream SSR into R builders under the same acceptance, as the migration track's first milestone-level target. Recorded in PLAN.md, implementation milestones, migration tooling and AGENTS.md.
- Validation: strict package TypeScript and `vp check` pass. `server-layer`, `resource-layer`, `rust-emission-output` and `effect` pass 14/14. The native `string-profile` test caught a refactor regression (string literal operands rendered as owned `String`); after the fix it passes 3/3.

## 2026-10-02 — Prior-design reconciliation for strings and roadmap

- Per user direction, the existing PLAN sequence stands: the north-star review now records that its inputs are context only, and the frontier returns to milestone 4 preparation (portable Schema, owned strings/records, explicit unions, wire validation).
- Searched the docs for existing string designs and reconciled [the string record](docs/research/string-profile.md) with architecture §11/§14, the initial ownership rules (§17), Foldkit IR/compiler-design operation sketches and the Rust literal encoder. Fixed the one conflict: lowering now moves an owned computed local in a block's final position instead of copying it.
- Validation: `string-profile`, `rust-emission-output` and `effect` pass 11/11 in 3 files; strict package TypeScript passes.

## 2026-10-02 — Bounded well-formed string profile

- Recorded [string decisions](docs/research/string-profile.md) (STR-001–005) after comparing JS UTF-16 and Rust UTF-8 semantics, ECMAScript `replaceAll`/`GetSubstitution`, and Effect v4 `String`. Added `R.String` (`reffect/string@1`, refusing lone surrogates at decode) with `literal`, `eq`, `includes` and literal-only `replaceAll` (non-empty search, no `$`), enforced by a new checked `Operation.withLiteralArguments`. Native lowering uses owned `String` at boundaries, `&str` in helpers and `str::contains`/`str::replace` with no crate; the native runner passes hex-encoded UTF-8. Delayed-cleanup string captures are refused.
- Vendored pinned upstream Foldkit `escapeText`/`escapeAttributeValue` as a licensed fixture and ported them as R functions.
- Validation (focused): `vp test packages/reffect/tests/string-profile.test.ts` passes 3/3. Upstream, reference and native debug/release (both frame policies) agree on the corpus; NUL fails; lone surrogates are refused at decode (20.9s native). Affected suites `compiler`, `effect`, `rust-emission-output`, `flow`, `unit`, `error-recovery` and `source` pass 39/39 in 7 files. Strict package TypeScript, workspace `vp check` and the build pass. The full suite was not run.

## 2026-10-02 — North-star review and Foldkit SSR inventory

- Reviewed [docs/north_star.md](docs/north_star.md) and [docs/suggestions.txt](docs/suggestions.txt) against the roadmap in [the review record](docs/research/north-star-review.md). Verified the pinned upstream `foldkit/foldkit@0b2a4fd` SSR files and their small Effect surface; adopted corpus-driven priorities (NS-1), the codemod as syntax frontend (NS-2) and semantic foreign operations as registry entries (NS-3). Milestone 8's "unmodified upstream" acceptance/reordering (Q-1) and which Foldkit tree to target (Q-2) are left for the user.
- Added the exploratory [inventory script](packages/reffect/scripts/foldkit-ssr-inventory.ts). It caches the pinned commit in gitignored `.cache/` and walks runtime-reachable modules with Vite's bundled oxc parser, adding no dependency. [Results](docs/research/foldkit-ssr-inventory.md): 43 files and 16,186 lines (module-level upper bound); 73 Effect members, of which 6 have same-named `R` members; ordinary TypeScript (1,184 closures, 698 branches, mutation, Sets/Maps, regex) dominates. Strings are the first representation gate, starting with Foldkit's `escapeText`/`escapeAttributeValue`.
- Validation: the script ran successfully and regenerated the committed JSON; `vp check` passes. No compiler code changed, so no tests were run.

## 2026-10-02 — Server-lifetime RPC services and graceful shutdown

- Researched pinned RC.118 `RpcGroup.toLayer` (handlers built once in `Layer.effectContext`), `RpcServer.make` shutdown (interrupt and await in-flight request fibers before dependent layers release) and the generated Axum server, then recorded decisions SL-001–005 in [server-lifetime Layers](docs/research/server-layer.md) before implementation.
- Added an internal `Launch` node (publish scalar values once, then wait like `Effect.never`), `NativeRpc.bindServices`, and `NativeRpc.compile(..., { layer })`. Layered servers run the layer before binding, copy scalar services into handlers from a set-once executable `OnceLock`, exit 1 with LIFO cleanup and a startup record on acquisition failure, and shut down on Ctrl-C or opt-in stdin EOF by interrupting/awaiting in-flight requests before releasing server-lifetime registrations. Servers without a layer are unchanged; `AsyncContext` gains launch fields only when reachable. Protected procedures cannot yet also bind services.
- Validation (focused): `vp test packages/reffect/tests/server-layer.test.ts` passes 3/3 (official `RpcTest`/`toLayer` vs reference traces; refusals and unchanged no-layer output; debug/release native stock-client concurrency, shutdown order and startup failure, 48.6s). A mutation disabling the shutdown forwarder fails it. Affected suites `native-rpc`, `async-rpc`, `rpc-auth`, `rust-emission-output` and `async-effect` pass 11/11 in 5 files. Strict package TypeScript, workspace `vp check` and `vp run -r build` pass. The full suite was not run.

## 2026-10-02 — Per-invocation resource-bearing Layers

- Researched pinned Effect 4.0.0-rc.118 `Layer.effect`/`fromBuild`/`MemoMap`/`provideLayer` source and ran official programs before implementation; decisions RL-001–006 are recorded in [resource-bearing Layers](docs/research/resource-layer.md). v4 has no `Layer.scoped`: `R.Layer.effect` acquisition may now retain `addFinalizer`/`acquireRelease`/`RegisteredFile` registrations and may fail; `R.Layer.provide` wraps resource-bearing graphs in a provide-owned scope (matching `scopedWith`), tracks acquisition errors in its error channel and accepts `{ local }`.
- Fixed a divergence in CTX-003: official Effect reuses the outer provide's memoized layers inside a nested provide (`CurrentMemoMap.forkOrCreate`). Nested provides now inherit the enclosing memo through a build-time staging stack; `fresh` and `local` reacquire. Escaping inner computations are refused by the existing `FOREIGN_PARAMETER` check. CTX-005 is superseded by RL-001/RL-003.
- No new IR node, Cargo crate, `AsyncContext` field or native service map. `analyzeScopes` now reports the root's retained registration count.
- Validation (focused, per user direction not to run the full suite unnecessarily): `vp test packages/reffect/tests/resource-layer.test.ts` passes 3/3 — official vs reference traces for sequential, shared, fresh, nested, nested-fresh, nested-local, failed acquisition, body failure and cancellation; staging/type/capacity/escape refusals; native debug/release under both frame policies including a registered-file size layer and an in-process failure/cancellation probe (56.4s). A mutation disabling nested inheritance fails the reference test. `context-layer` and `module-composition` pass 3/3. Strict `vp exec tsc --noEmit -p packages/reffect/tsconfig.json`, workspace `vp check`, `vp run -r build` and `git diff --check` pass. The full suite was not rerun; `scope-registration` was not rerun (its only source change is an added return field).

## 2026-10-02 — Bounded sequential resource Scope registration

- Implemented the bounded lexical profile decided in [resource Scope registration](docs/research/resource-scope-registration.md): lexical `R.Effect.scoped`, ordinary-computation `R.Effect.addFinalizer`, scalar `R.Effect.acquireRelease` and `R.File.acquireReadOnly` (`RegisteredFile`). The checker proves execution multiplicity before IO with a 16-registration admission ceiling per lexical scope, retains registration-time log annotations/span starts, and native closure runs masked sequential LIFO with owned scalar captures. Manual Scope values/close, child/fork, parallel release, Exit-aware/fallible cleanup, registration within cleanup, dynamic services and resource Layers remain outside this profile.
- Validation uses exact evidence: full `vp test --maxWorkers=1` with `CARGO_PROFILE_DEV_DEBUG=0` and `CARGO_INCREMENTAL=0` passed 120/120 in 28 files (1063.68 seconds total, 1022.08 seconds tests). The scope-registration fixture passed 5/5 in 129018ms within that suite. After a test-only `FailureFramePolicy` warning fix with no runtime semantic change, the dedicated suite reran successfully at 5/5 (112.43 seconds tests, 114.32 seconds total). `vp exec tsc --noEmit -p packages/reffect/tsconfig.json` passed. `vp check packages apps tools examples docs PLAN.md PROGRESS.md AGENTS.md README.md package.json vite.config.ts tsconfig.json` passed (186 formatted files and 101 checked TypeScript files, zero warnings/errors). `vp run -r build` passed all four workspace tasks. Runnable `examples/scope-registration/main.ts` passed with reference/native `5n` and the required registration-returned, file-closed, cleanup-awaited, session-released order. Final Markdown verification passed for 231 links/anchors across all changed Markdown files. Toolchain: installed Effect 4.0.0-rc.118, Tokio 1.53.1, Rust 1.90.0 x86_64-pc-windows-msvc, host Node v26.5.0.
- Full-suite reconciliation: this 120/120 in 28 files result supersedes the earlier committed counts recorded below (104 tests in 23 files for the parallel batch, 112 tests in 26 files for the Schedule slice, 110 tests in 25 files for the heartbeat slice). Those entries remain history; the counts above are the current integrated baseline.

## 2026-10-02 — Parallel resource Scope review and preparation

- At the user's request, parallel agents reviewed pinned RC.118 reference behavior, generated native storage/lifetimes and a real registered-file workload in the current branch/workspace. [The corrected preparation](docs/research/resource-scope-registration.md) supersedes runtime overflow/closed-scope divergence and token-only workload: prove capacity statically, retain registration-time context, and register actual read-only file ownership. Evidence documents are linked from the index. Implementation follows this bounded lexical profile; explicit Scope close/fork and resource Layers remain later gates.

## 2026-10-02 — Dynamic resource Scope registration preparation

- Frontier step 1: reviewed prior brackets/async/file work and checked pinned Effect 4.0.0-rc.118 Scope source online (`addFinalizer`, reverse-order sequential close, uninterruptible close, `fork` children, `acquireRelease` requiring Scope, closed-scope registration). Recorded [dynamic Scope registration decisions](docs/research/resource-scope-registration.md) before any IR/API: a bounded typed registered-finalizer list (SR-1) in reverse order under mask, sequential-only, Unit/Never finalizers, no OS-handle type, existing `AsyncContext` and no new Cargo crate. Full Exit-aware Scope service (SR-2), parallel strategy, `fork` and closed-scope immediate registration remain deferred. Acceptance gates and open questions recorded; no implementation started.

## 2026-10-02 — Effect v4 `flow` utility

- Exposed the official Effect 4.0.0-rc.118 `flow` (left-to-right function composition, 1–9 function overloads) from the package root and as `R.flow`. It is pure build-time composition with no IR semantics, so it delegates to the pinned implementation instead of duplicating it, matching Effect's behavior and inference exactly.
- `packages/reffect/tests/flow.test.ts` checks observed composition order and arity, that `R.flow` is the official function, and that `flow` composes reffect `Expr`-building functions into a reference-executed `R.fn`. `packages/reffect/tests/flow-types.ts` pins inference for single- and multi-argument forms and the reffect `Expr<bigint>` type.
- Implemented the [proposed](docs/research/flow-composition.md) IR composer: `R.flow` now composes `Fn`/`EffectFn` values left-to-right (first function any arity, rest unary) via capture-free binder substitution (`Expr.substitute` in `kernel.ts`, `substituteComputation` in `effect-ir.ts`), returning a `Fn` for all-pure chains and an `EffectFn` otherwise with `joinType`-compatible errors. Plain composition stays in `effect`'s `flow`; the top-level `flow` re-export now points at `R.flow`. Reference/native parity holds in debug/release and no new IR nodes, Cargo crates or context fields are introduced. Composed components are inlined and are not separate logical-frame/name boundaries. Runtime refusals cover non-IR functions, non-unary later functions and witness mismatches.
- Recorded the longer-term decision in [named function calls and recursion](docs/research/function-calls.md): first-class function values (Option D2) are out of scope under the representation model; a named call node (D1) is deferred but likely, with explicit blast radius per compiler pass and triggers (recursion, inlining duplication, shared effectful/resource helpers). `R.flow` stays as shipped, independent of that decision.

## 2026-10-02 — Bounded Schedule generalization

- Replaced the single `spaced` special case with a first-class `R.Schedule` value (`recurs`, `spaced`, `exponential`, `forever`) and added `R.Effect.retry`; `R.Effect.repeat` now accepts a bare schedule or `{ schedule, times }`. Both delegate reference execution to official `Effect.repeat`/`Effect.retry` and lower to one generated loop with a `completed` counter, continuation test and computed delay. Retry retries only typed domain failures, drops retried attempt frames and appends one boundary frame on final failure. [Design decisions](docs/research/schedule.md) precede implementation.
- No new `AsyncContext` fields, dynamic dispatch or Cargo crates. Exponential delays compute in `f64` and saturate at `u64::MAX`. Fixed cadence, jitter, `while`/`until`, `upTo`-by-duration and schedule combinators remain deferred; `repeat` still discards the schedule output.
- `docs/research/schedule.md` now records delivered evidence. `packages/reffect/tests/schedule.test.ts` compares official Effect 4.0.0-rc.118, reference and native debug/release under both frame policies for all four schedules, retry exhaustion and immediate-success retry; a native probe cancels during a retry delay. `packages/reffect/tests/schedule-types.ts` covers inference and refusals. Validation: focused test passes 2/2 (45.41s); full `vp test --maxWorkers=2` passes all 112 tests in 26 files (489.48s); strict package TypeScript, scoped `vp check` and workspace build pass.
- Recorded in [PLAN.md](PLAN.md#current-frontier) that resource Scope/acquire-release registration is the immediate next workstream once this schedule slice lands.

## 2026-10-02 — Effect v4 scoped heartbeat vertical slice

- Added `R.Schedule.spaced`, Unit `R.Effect.repeat` with optional additional-run count, and the pinned v4 `addFinalizer → andThen → scoped` authoring shape. Pending sequential registrations are typed `ScopedSequence` values and specialize into existing masked scalar brackets; native repetition emits a concrete loop. Dynamic Scope services, Exit-aware cleanup and general Schedule remain separate. [Decisions and supported boundaries](docs/research/heartbeat.md) precede implementation.
- [examples/heartbeat](examples/heartbeat/README.md) contains the authored application, independently authored v4 equivalent, reference runner and standalone Rust build with executable-owned Tokio Ctrl-C/timed shutdown. The release binary's 2200ms smoke run prints startup, three heartbeats and exactly one exit record. `R.Log.info` intentionally uses Effect logging/structured stderr in place of Console/stdout.
- Differential tests compare official Effect 4.0.0-rc.118, reference and native debug/release with both frame policies: immediate first run, times+1 executions, failure short-circuit/skipped registration, nested LIFO awaited cleanup, cancellation during spacing and pre-entry cancellation. Failure-frame chains agree. Strict type contracts cover inference, unclosed scope sequences, fallible/Exit-aware finalizers and unrepresentable repeat inputs.
- Mirrored the Effect v4 logging surface on `R.Effect` (`log`, `logTrace`, `logDebug`, `logInfo`, `logWarning`, `logError`, `logFatal`, `annotateLogs`, `withLogSpan`) as aliases of the single `Log` node; `R.Log` remains the equivalent lower-level namespace. The example, tests and type contracts use the v4 names, so native logging continues to compare against the official `Effect.logInfo` oracle.
- Validation: `vp test packages/reffect/tests/heartbeat.test.ts` passes 2/2 (58.82s); final `vp test --maxWorkers=2` passes all 110 tests in 25 files (678.17s). The initial unrestricted `vp test` passed 103/110 but exhausted disk in concurrent native builds and hit two fixture timeouts; the lower-worker rerun passes without weakening assertions. Strict `vp exec tsc --noEmit -p packages/reffect/tsconfig.json`, explicit-workspace `vp check packages apps tools examples docs PLAN.md PROGRESS.md AGENTS.md README.md package.json vite.config.ts tsconfig.json` (168 formatted files, 91 TypeScript files), fresh `vp run -r build` and `git diff --check` pass. Packaging review fixed an unexported AndThen helper type. Bare `vp check` also encountered formatting in preserved root native-fixture directories; actual workspace source/docs checks pass. In-progress file-resource changes are preserved.

## 2026-10-02 — Scoped heartbeat preparation

- Reviewed existing async/bracket lowering and the in-progress file-resource work; verified pinned Effect repeat/spaced behavior and Tokio signal requirements. Recorded [heartbeat decisions](docs/research/heartbeat.md) before implementation: concrete repetition and bounded sequential registrations specialized into existing masked brackets.

## 2026-10-02 — Native file ownership preparation

- Reviewed the roadmap, scalar bracket/static Layer decisions and actual IR/lowering/reference paths. Checked pinned Effect Scope, Node 24 FileHandle and Rust File primary sources online; recorded [scoped file decisions](docs/research/scoped-files.md) before implementation. The chosen slice owns a real read-only handle, checks lexical resource captures and generates borrowed helpers plus awaited cleanup. It establishes the real-resource gate; dynamic Scope registration/resource Layers remain subsequent work.

## 2026-10-02 — Schema boundary review corrections

- Integrated review found three admitted-profile mismatches: reordered handler arguments changed first-error order, nonempty Struct shape failures used different wording, and empty Struct incorrectly rejected scalar/array inputs. The correction decodes in contract field order while retaining handler argument positions, and mirrors the pinned empty/nonempty Struct acceptance rules. [SCHEMA-005/006](docs/research/schema-profile.md#follow-up-boundary-review-preparation) record alternatives, costs and revisit triggers; the module index now covers 21 decisions.
- Clarified that schema WeakMap entries and eager parser caches also exist in TypeScript clients constructing shared contracts. They are per-schema costs, absent from generated Rust; their construction costs are unmeasured and distinct from native allocation probes.
- Regression coverage extends the existing differential HTTP fixture with reversed bindings, multiple invalid fields, successful projection, malformed shapes before auth and empty Struct acceptance. Focused native debug tests pass 2/2 (26.43s): 42 raw requests and seven stock-client calls agree with Effect, including exact responses and 23 accepted handler invocations. Workspace formatting/lint (79 TypeScript files), strict package TypeScript, fresh compiler packaging/workspace builds and local links pass. The required post-commit full regression repeat follows before publication.

## 2026-10-02 — Parallel module implementation and integration

- Four agents implemented structured scalar acquire/use/release, lexical Context/Layer providers, typed catchAll/mapError/orElse and inclusive u64 RPC payload ranges. [The module index](docs/effect-modules.md) links 19 decisions with alternatives, consequences and concrete revisit triggers. These are bounded admitted subsets; resource Scope registration/OS handles, dynamic services/resource Layers, richer Cause/Schema and general concurrency remain pending.
- Acquisition/release mask cancellation and await completion; failed acquisition skips release. Context/Layer specializes into checked IR with per-provide sharing/freshness, explicit sequential acquisition and pure-only merge. Recovery bypasses interruption/compiler failures and releases handled frame storage before awaiting its handler. Error-specialized helper memoization prevents invalid Rust channel reuse. No native scalar wrappers, service maps, boxed helper futures or new runtime crates are introduced by these extensions beyond already-reachable Tokio.
- Schema factories preserve ordinary stock contracts and validate before authentication. Differential native tests fixed three existing boundary issues: frozen lazy parser accessors, nonstring u64 error wording and missing-key diagnostic paths. Constrained outputs/derived filters remain refused. Range helpers emit only when reachable.
- Focused resource tests pass 2/2 (82.21s), Context/Layer 2/2 (79.54s), Schema 2/2 (93.32s), original recovery matrix 2/2 (95.02s), and reference defect checks 1/1 (7.69s). The composition test passes (66.46s) across debug/release and both frame policies, verifying shared service acquisition, release-before-recovery, precise values and empty recovered frames. The committed integrated suite also passes the latest recovery shared-node assertions. Parallel Rust compilation exposed 120s fixture budgets; four-crate fixtures now allow 240s without weakening assertions. Test setup/type errors were corrected.
- [Resource layout/allocation evidence](docs/research/resource-scope.md) and [metadata consequences](docs/metadata-cost.md#resource-recovery-and-static-service-costs) distinguish zero context/unpolled-future construction allocations from polling/logging/HTTP costs. Integrated vp check reports zero warnings/errors across 79 TypeScript files; strict package TypeScript, fresh compiler packaging/workspace builds, git diff --check and 207 local links pass. Independent cross-reviews found no blocking issue in recovery/bracket cancellation or Context/Layer staging. Post-commit whole-suite validation passes all 104 tests in 23 files (637.41s); repeated formatting/lint, strict TypeScript and cached workspace builds pass. Subsequent Schema boundary review corrections are recorded separately below.

## 2026-10-02 — Parallel Effect module preparation

- Following the user's explicit request, delegated resource lifetime/Scope foundations, Context/Layer wiring, typed error recovery and Schema boundary validation to four implementation agents. Each reviews prior constraints and pinned online Effect sources, records decisions before coding, and owns isolated files or coordinated compiler patches. [Module work and decisions](docs/effect-modules.md) documents priorities, integration ownership and the review contract. Final admission depends on integrated reference/native evidence; broad upstream module coverage is not implied.

## 2026-10-02 — Async RPC post-commit review

- Post-commit regression caught an observation race: the final HTTP response arrived before the stderr consumer collected the Public log (54 of 55 records). The remaining 94 tests passed. Added a bounded log-collection barrier before the unchanged exact count/context/order assertions; this synchronizes independent transport channels without relaxing conformance. The committed implementation/docs review and 259 local links passed; formatting, strict TypeScript and workspace builds passed. Follow-up focused RPC tests pass (2 tests, 173.95s); vp check, strict package TypeScript, cached workspace builds and 50 changed-document links pass. Publication awaits the required post-commit full regression repeat.

## 2026-10-02 — Bounded async execution and suspended RPC

- Added checked literal Sleep (0–60000 ms) and non-failing Unit/Never Ensuring IR, official Effect reference interpretation, an explicit Rust.tokio capability and explainable reachable Tokio runtime/dependencies. Existing std and synchronous Tokio-target programs stay dependency-free. Native helpers have concrete futures; scalar values remain plain.
- AsyncContext owns cancellation/masking, optional log scopes/request JSON and optional bounded failure storage. Async-only modules omit failure TLS; capture None removes the trail field/propagation. Context and finalizer state survives suspension without a TLS guard. Entered cleanup is awaited once in reverse nesting order; pre-entry cancellation skips it. Interrupted successful cleanup and preserved typed failure during masked cleanup match Effect.
- Async HTTP groups use owned workers and response-body cancellation signals. Stock-client interruption and real socket disconnects await both delayed finalizers, skip the next batch handler and preserve subsequent/concurrent principal/ID/annotation/span isolation. Debug/release and both frame policies pass. General Scope/acquireRelease, fallible finalizers, Services/Layers, process-abort cleanup and graceful draining remain outside the slice. [Example](examples/rpc-async/README.md) and [design/results](docs/research/async-rpc.md) document the boundary.
- [Release probe](packages/reffect/scripts/async-cost.ts) and [raw results](docs/research/async-cost-results.json) record context sizes 24–32 bytes without scopes and 96–104 with scopes; tested future construction/context construction adds zero allocations, while the cancellation watch allocates once. Shared depth 4/8 futures grow linearly in the checked corpus. Polling/logging/HTTP allocations and throughput are separate; [cost limits](docs/metadata-cost.md#async-context-and-future-costs) make that distinction explicit.
- Full vp test passes 95 tests in 18 files (556.58s), including existing native conformance. vp check, strict package TypeScript, workspace build, runnable stock-client example, git diff --check and 259 local links/anchors pass. The compiler build is fresh; unrelated tasks use cache. Final review makes the masked-cleanup probe signal on its first suspension rather than depend on competing timers; both focused tests pass (51.82s). Publication requires rereading the committed diff and repeating checks/full tests/build.
- Review corrected async borrowed-context lifetime, pre-entry cancellation, missing test imports, reference annotation normalization, synchronous-only interruption output refusal and optional frame ownership. Native interruption frames are bounded diagnostics; the reference frame observer does not claim interruption-frame parity. PLAN now puts the next frontier at resource Scope preparation, followed by Services/Layers.

## 2026-10-02 — Execution roadmap clarification

- Applied the user’s planning guidance: preserved the thesis and semantic gates, made the current frontier explicit, promoted minimal async ownership/cancellation/finalization/Scope into milestone 3A, and separated unary RPC/services at 3B from later streaming. Roadmap profile names are provisional commitments, not invented CLI APIs; SQL remains independently composable. Added milestone decision deadlines and [performance evidence/gates](docs/performance.md); detailed observability/source-map matrices remain in their specifications. General Scope is explicitly distinguished from the active non-failing Ensuring slice.

## 2026-10-02 — Suspended RPC preparation

- Reviewed existing scalar RPC/auth, frame policies, source mapping and scoped logging. Checked pinned Effect finalization/HTTP lifetimes and Tokio/http-body primary sources online. Recorded the explicit execution context, cooperative cancellation, concrete futures and narrow Sleep/Ensuring profile in [async RPC research](docs/research/async-rpc.md) before planning or implementation.

## 2026-10-01 — Failure-frame construction bounds and opt-out

- Replaced intermediate native vectors with one lazily allocated boxed 32-entry trail per failure. Propagation retains innermost frames and counts omitted boundaries; reference arrays obey the same construction bound. Observation drains frames/omitted together; RPC cleanup drops directly without allocating an observer Vec.
- Added nominally typed, registered FailureFrames.Bounded/None selection independent of Full/None source artifacts and authored logging. Complete Compile.run/build requests, verified staged plans, lowered modules, artifacts and NativeRpc preserve it. NativeRunner.runWithFrames refuses stripped capture before spawning; malformed oversized/false-truncation envelopes are rejected. Frame-off HTTP generation omits even no-op cleanup calls through a typed RsStmt boundary.
- Measured actual generated helper layout, representative Result shapes, allocation counts and five release timing samples with [the reproducible probe](packages/reffect/scripts/frame-cost.ts) and [raw results](docs/research/frame-cost-results.json). On Rust 1.98.1/x86-64, success allocates zero diagnostic bytes; deep failure allocates one 528-byte capsule, versus zero with frames stripped. Actual u64/u64 helper Result is 16 bytes in either profile (legacy vector form: 32); Boolean and Unit Result layouts do grow when capture is enabled. [Metadata costs](docs/metadata-cost.md#native-failure-frame-costs) records bounds, ownership, shallow-failure tradeoffs and timing limits.
- Conformance extends both debug/release frame policies across stock RPC clients/corpus, log ordering/filtering, same-process annotation/span restoration after failure, deep/shared boundary paths, exact omitted counts, repeated drain, source-policy independence, staged compilation/build and nominal type/registration refusals. Updated the roadmap: owned async request context and cancellation/finalization are next; sink/export and future-layout work remain separate.
- Review corrected unwarranted layout assumptions using the actual generated type, a new test comparing an Exit to the reference unwrapped value, policy structural compatibility, stale omitted-state draining and frame-off HTTP no-op calls. Focused corrected diagnostics/logging tests pass all 8 cases; final full vp test passes 91 tests in 16 files (250.65s). vp check (127 formatted files, 65 checked TypeScript files), strict package TypeScript, workspace build, git diff --check and 221 local links/anchors pass. The compiler package was freshly rebuilt after the HTTP cleanup change; the final workspace build is cached. Post-commit re-reading/checks follow before publication. An environment restart interrupted the prior full-run process handle, so final validation was restarted from the preserved workspace.

## 2026-10-01 — Failure-frame hardening preparation

- Reviewed frame propagation, metadata costs, compiler stages and RPC cleanup; checked primary Rust layout and pinned Effect sources online. Recorded alternatives, the bounded boxed trail, independent frame policy and validation criteria in [failure-frames research](docs/research/failure-frames.md#construction-bounds-and-frame-policy-preparation--2026-10-01) before implementation.

## 2026-10-01 — Authenticated native RPC and request logging

- Added a checked bearer adapter for one stock middleware, typed string-literal authorization failure and exact bigint principal-service projection through NativeRpc.bindPrincipal. Payloads decode before auth; header normalization/override agrees with Effect. Domain errors remain separate. General Context/Layer/middleware and async execution are not admitted.
- Runtime-only credentials are bounded, immutable shared server state; missing/invalid configuration refuses startup without exposing values. subtle 2.6.1 is selected only for auth. Dispatch owns a stack context borrowing ID/tag from the HTTP-owned body; native values remain plain u64/bool/(). Reachable local logging attaches a separate request field via a lexical RAII guard with nested/unwind restoration.
- [Shared example](examples/rpc-auth/README.md) and [research/results](docs/research/rpc-auth.md) cover stock server/client parity, native debug/release, typed denial, payload-before-auth defects, header precedence/case/repetition, batches, 16 overlapping principals, 25 isolated logs, configuration limits and unsupported adapter/type refusals. Existing RPC corpus and logging conformance remain intact.
- Validation: vp test passes 87 tests in 15 files; vp check, strict package TypeScript, workspace build, authenticated example and 233 local links/anchors pass. Compiler package build is fresh; unrelated packages use cache. Review corrected Rust closure shape, test logger ownership, Cargo-warning parsing and prelude adjacency; batch assertions use request IDs because the oracle can complete out of order. Post-commit checks repeat before publication.
- Post-commit review repeated the complete 87-test suite successfully, then identified declaration emission escaping beside shared example sources. Packaging now uses a source-only tsconfig; the original strict config still checks tests and imported examples. Fresh packaging leaves no extra declarations in the workspace, with unchanged public bundle/type sizes.
- Updated the plan: bounded intermediate failure accumulation and independent instrumentation selection next, then explicit async context/cancellation/finalization. This establishes synchronous request isolation, not async task isolation, JWT/identity-provider support or telemetry export.

## 2026-10-01 — Authenticated RPC preparation

- Recorded [middleware semantics and request ownership](docs/research/rpc-auth.md) before implementation: pinned Effect payload/header ordering, explicit bearer verifier, typed denial, scalar principal projection, runtime-only credentials and lexical synchronous log context. General services, async context and telemetry remain outside this slice.

## 2026-10-01 — Native scalar unary HTTP server

- Recorded substrate/profile preparation before implementation in [unary RPC research](docs/research/unary-rpc.md). Added NativeRpc typed bindings/compilation and schema-only RpcCodecs, projecting shared flat RPC payloads into existing plain scalar Fn/EffectFn arguments through the checked compiler pipeline. Unsupported schemas, middleware, layouts and witnesses are refused.
- Generates unmapped HTTP main with internal Rs fragments and static audited Axum/Tokio substrate; handler explanations and selected pinned crates/features remain reviewable. Added explicit CargoApi.fetch while preserving offline build/run. JSON bodies/batches are bounded, malformed envelopes cannot dispatch, and synchronous handlers drain frame stashes without carrying diagnostics across an await.
- Real HTTP debug/release tests replay the portable corpus and use unchanged stock clients for precision/wrapping/Unit/typed failure, concurrent success/error recovery, trace metadata, malformed requests, route/method refusal and body/batch limits. Added compiler refusal and negative TypeScript contracts; the [runnable example](examples/rpc/README.md) prints native success and typed failure and closes its process/crate scope.
- The HTTP transport is async; compiled effects remain synchronous. Native auth/request services, async context ownership, full Schema/defect formatting parity, propagation/exporters, CORS, graceful draining and RPC source maps remain follow-ups. This completes a scalar unary demonstration, not all of milestone 3.
- Review corrected empty-string field projection, Unit/undefined type adaptation, HTTP dependency features and initial Rust macro ambiguity. Batches now refuse duplicate IDs before dispatch, matching JavaScript numeric ID equality. Native build budgets account for fresh HTTP dependency compilation in both profiles and scoped server cleanup; no conformance assertions were skipped.
- Validation: full workspace suite passes 83 tests in 14 files; final native debug/release checks also pass after the duplicate-ID/float-roundtrip review. Full formatting/lint, strict package TypeScript, workspace builds, runnable example and 217 local links/anchors pass. The example confirms stock client → native Rust with sum=0 and typed failure=false. Post-commit checks repeat the complete suite before publication.
- Post-commit review verified the full suite/build/example again, then identified eager compiler-module loading through the root barrel in shared contracts. Added the dedicated reffect/rpc-codecs source export and switched the example contract to it; canonical schema identity is shared with the compiler without importing compiler modules from client contracts.

## 2026-10-01 — Unary RPC conformance foundation

- Reviewed milestone 3, current scalar handlers and diagnostic context; verified pinned Effect RC.118 source online and recorded decisions before implementation in [unary RPC research](docs/research/unary-rpc.md).
- Added a shared RpcGroup with decimal-string bounded u64, Boolean success/error and exact Unit, backed by existing reffect reference handler IR. The injectable Fetch harness captures stock HTTP request/response bytes and owns the official server fiber through each scoped scenario. Fixed JSON vectors and the replay helper can target a future native server without replacing the stock client or codecs.
- Tests cover exact success/typed-error/Unit envelopes, u64 precision and wrapping, schema rejection before handler execution, malformed JSON/unknown tags, overlapping requests and scoped header restoration, batch correlation/header precedence, broken-response refusal and independent RPC/HTTP trace locations.
- Updated stale roadmap/package status. Native RPC serving, async compiled effects, general schema lowering, middleware, socket cancellation and request-safe native diagnostics remain unimplemented. Recorded intermediate failure-vector growth as a runtime hardening follow-up; the current 32-frame cap applies at storage.
- Validation: all 81 workspace tests in 13 files pass, including 12 RPC tests and fresh native crates for existing profiles; strict package TypeScript, full `vp check`, workspace build and `git diff --check` pass. Reviewed the complete diff and verified 127 local document links/anchors. No feature exports, dependencies or generated Rust were changed.

## 2026-10-01 — Internal Rust emission helpers

- Recorded scope, alternatives, byte-identity obligations and validation in [Rust emission research](docs/research/rust-emit.md). Added an internal `Rs` module with role-branded fragments, checked identifiers/types/literals, syntax and standard-library helpers, typed fragment templates, and `defineFn` for custom generated helpers. The custom helper's symbolic declared parameters produce an inferred argument tuple and runtime arity check; negative type contracts verify wrong-role interpolation and wrong call arity without casts. `Rs` remains off the package barrel.
- Migrated selected `lower.ts` constructs—escaping, supported types, literals/identifiers/calls, function signatures and unreachable matches—to `Rs`. Mapped writes stay imperative to preserve source occurrence ranges; Foldkit's separate emitter remains untouched.
- Validation: after the module/macro extension, all 65 workspace tests pass, including fresh native debug/release builds and exact source-map checks. `vp check --no-fmt`, strict package TypeScript, `vp run -r build`, changed-file Oxfmt and `git diff --check` pass. Full `vp check` remains blocked only by formatting in four unrelated preserved, untracked Effect reference docs; none were modified.
- Review confirmed role and call-arity checks, unchanged mapped-write boundaries, and that Rustc remains authoritative for generated Rust semantics. This is a guarded early migration, not a wholesale rewrite of every emitter template.
- Continued from the gap review: added typed Rust paths/visibility, recursive nested `use` trees and re-exports, inline/external modules, module-file assembly, attributes, and role-indexed `macro_rules!` token trees with metavariables/literals/repetition and `#[macro_export]`. Type contracts reject matcher/transcriber swaps, invalid module bodies, and unstructured visibility strings. Exact-output tests cover nesting and formatting; a Rust 2021 fixture compiles under rustc 1.90.0 with `--deny=warnings`.
- Rewrote the core emitter onto `Rs`: both runtime preludes, all result/signature types, frame/log JSON literals, `print` expressions, the CLI match arms and `src/main.rs` are now built from typed fragments. Interleaved mapped-write glue keeps sequential writes (nested definition/use ranges are asserted exactly) but all interpolated identifiers, literals and strings go through `Rs`. New builders for this pass: generic/path/enum/const/static/thread-local items, `let`-else and discard-lets, char literals, non-parenthesizing dot chains and comparisons, statement blocks and multi-line `match`.
- Byte identity verified by diffing generated `src/lib.rs`/`src/main.rs` from the pre-migration emitter against the migrated one across pure Boolean/Unit, effect U64/Boolean/Unit/Never and scoped-logging programs: both files matched character-for-character. Validation: all 65 workspace tests pass with fresh native debug/release builds, `vp check --no-fmt`, strict package TypeScript and workspace build pass.
- Completed the migration by composing helper/function bodies from `MappedFragment`s instead of hand-assembled raw Rust templates. `SourceWriter` gained relative UTF-8 span fragments (`joinFragments`/`mapFragment`/`textFragment`/`writeFragment`) so nested definition/use attribution survives composition; offset measurement is lazy so artifact-off compilation never touches `TextEncoder`. Generated `src/lib.rs`, `src/main.rs` and the full `sources.ranges` array are all byte-identical to the pre-refactor emitter across the same program matrix. All 67 workspace tests pass.
- Migrated Foldkit's separate emitter (`emitQuery`, `literalRust`, CLI arms) onto `Rs`, leaving only its static `foldkitRuntime`/`foldkitMain` shells as audited `verbatim*` scaffolding. `src/main.rs` is byte-identical; `src/lib.rs` matches line-for-line except that the old template's blank lines in empty statement lists are gone. Foldkit three-interpreter conformance passes unchanged. All 68 workspace tests pass.

## 2026-10-01 — Bounded logical failure frames

- Added reference `runWithFrames` with memoized canonical first-seen adaptation and native traced helpers plus a failure-only thread-local stash. The CLI keeps its stdout payload protocol and prints a versioned frames envelope to stderr on failure; `runWithFrames` relays and validates it while `run` stays unchanged.
- Frame agreement passes in fresh debug/release crates across branch, nested FlatMap/Match, short-circuit, shared-helper, depth-40 truncation and mapped/None origin cases, plus seven malformed envelope refusals. Strict type contracts require no casts.
- Scoped vp check, strict TypeScript and workspace builds pass. Full suite passes 51 tests with fresh native crates; probe confirms normalized value-level identity across Full/None.
- Published after re-reading the implementation diff and repeating checks, full tests, probe and workspace build. Review fixed two real issues found by the new tests: shared-node path aliasing (canonical first-seen adaptation on both sides) and three Rust brace/type codegen errors. Pre-existing size assertions were updated honestly for frame-literal bytes (linear helper sharing plus sub-exponential path-string bound). Next: scoped logging research.

## 2026-10-01 — Scoped logging implementation

- Added `Log`/`Annotate`/`Span` computation nodes with `R.Log` factories and dual combinators. Reference execution delegates filtering, shadowing, restoration and span stacking to official Effect; native prints versioned `reffect.log@1` JSON to stderr under a default Info minimum, with nested annotations, innermost-first spans, static-wins shadowing and save/restore on both exit paths.
- Three conformance tests pass in fresh debug/release crates: ordering/levels/attributes/filtering, restoration/span/branch/shared/escaping agreement and authoring refusals. Strict type contracts require no casts.
- Scoped vp check, strict TypeScript and workspace builds pass. Full suite passes 54 tests with fresh native crates. Published after re-reading the diff and repeating checks, tests and build. Test failures during development caught a real unconditional-comma emission bug, an innermost-first span ordering mismatch and stale expectations; one pre-existing envelope scenario needed a new unknown kind. Next: unary RPC as the driver.

## 2026-10-01 — Bounded failure-frame preparation

- Verified the Effect oracle: span-less failures carry no StackTrace; `withSpan('inner')` inside `withSpan('outer')` annotates `{name:"inner",parent:{name:"outer"}}`. Only explicit boundaries create observable context.
- Recorded the frame design in [failure-frames research](docs/research/failure-frames.md): explicit Fn/Fail/Map/FlatMap/Match boundaries, logical IR paths innermost-first, 32-frame bound with omitted count, unchanged domain payloads, stderr companion envelope, reference `runWithFrames` oracle.

## 2026-10-01 — Unit implementation

- Added canonical R.Unit/UnitType as IRType<void> with owned frozen Schema.Undefined, typed capability and Rust `()` representation. Unit supports parameters, pure results and success/error channels; it remains distinct from Never and discarding Schema.Void.
- Added R.Effect.void and pipeable asVoid using existing succeed/map IR, preserving reference execution, errors and short-circuiting. Extended lowering/runner tokens with exact unit/ok:unit/err:unit while keeping existing Boolean/u64 protocols and logical arity unchanged.
- Unit conformance passes in fresh Rust debug/release crates: primitive identity, mixed input tuples, zero-sized layout, success/failure(undefined), Match/Never joins, nested map/flatMap and failed-source discard. Schema/capability/type and malformed native channel cases are refused; strict type contracts require no casts.
- Scoped vp check, strict TypeScript and workspace builds pass; all 48 tests pass with fresh native crates, including the existing Query/Effect/source conformance. Self-review traced exact Undefined admission, canonical identity/capabilities, Unit/ Never distinction, zero-sized layout, binder/branch behavior, retained failure payloads and strict bridge tokens. Publication/post-commit checks follow; bounded failure context/logging remain the next researched slice.

## 2026-10-01 — Unit preparation

- Reviewed the current compiler/Effect/runner and observability delivery constraints; checked installed RC.118 Schema.Void/Undefined and Effect.void/asVoid behavior against primary sources and Rust unit semantics.
- Recorded alternatives, exact runtime admission, internal protocol and acceptance in [Unit research](docs/research/unit.md) before implementation. Unit uses IRType<void> with exact Undefined validation; result-discarding is an explicit computation combinator rather than permissive native input coercion.

## 2026-10-01 — Source-artifact opt-out preparation

- Reviewed current compiler/lowering/provenance/writer/hash behavior and upstream metadata cost/source-map contracts before planning the next slice. Recorded choices and acceptance in [source-artifact policy research](docs/research/source-artifact-policy.md).
- The chosen path is a typed, immutable per-request Full/None policy with the mapped default preserved. None must skip collection/ranges/hashing/JSON, not delete files afterward; authoring capture and semantic function identities remain independent.

## 2026-10-01 — Implemented source-artifact policy

- Added Full/None typed singleton policies and complete pipeable CompileSpec factories/combinators, preserving default mapped call-site inference. None artifacts/lower results honestly omit source maps, auxiliary files and provenance; NativeRunner/semantic Plans remain compatible.
- None skips collection, origin/use metadata copies, byte-range encoding, SourceMaps hashing/JSON and authored error enrichment. Fault injection proves those paths are not called. Generated Rust/Cargo files are identical; native scalar and typed Result success/failure semantics pass in debug/release, including real rustc missing-map diagnostics.
- Extended the isolated-process probe to annotated/unannotated × Full/None. All twenty snapshots have identical 115,086 generated bytes; program+artifact retained medians fall from roughly 6.1/6.5 MB Full to 0.97/1.10 MB None, with zero auxiliary JSON. Timing observations and explicit ownership/peak/native limitations are recorded in [metadata costs](docs/metadata-cost.md#fullnone-implementation-measurement) and [policy research](docs/research/source-artifact-policy.md).
- Validation: all 44 tests pass with fresh native crates; task-scoped vp check and strict package TypeScript pass without warnings; workspace builds pass freshly. Type contracts cover default/source-off/spec pipelines and build inference without casts. Full-root formatting remains separately blocked by the preserved untracked user documents.
- Published bb2d7de after re-reading its policy/lowering/writer diff and repeating all 44 tests, strict checks and workspace build (reffect fresh, starter tasks cached). Self-review verified singleton identity/immutability, typed pipeline inference, default compatibility, shared-helper preservation, skipped work and missing-map fallback; no semantic corrections were found. Next follows the updated roadmap: Unit, bounded logical failure context and scoped logging under separate instrumentation policy.

## 2026-10-01 — Reconciling concurrent upstream implementation

- Fetched twelve incoming commits through e91efa1 and fast-forwarded master after saving the unfinished local Query draft/research/dependency experiment in stash 0ca3899ac5100c02f3c8f2f29cbc88a766fc4eea. The four untracked effect reference documents remain preserved.
- Reviewed the incoming Query, Effect, source-map/Cargo and design work. Recorded evidence and choices in [reconciliation research](docs/research/upstream-reconciliation.md): retain the broader dynamic UTF-16/encoded-primitive evaluator and RC.118 family instead of adding the narrower closed-fixture backend or retaining RC.116 overrides.
- The fresh merged baseline initially passed 35 of 37 tests, including published three-interpreter Query conformance. Two multi-failure tests timed out on this Windows host; direct taskkill probing reproduced a 61.87-second host timeout, and the official Node spawner uses that path for failed processes. This identified the need for bounded test-budget adjustments alongside reachable inherited/accessor cell refusal before integrated validation.
- Completed and pushed 2a52cb4: retain all broader upstream APIs, reject reachable inherited/accessor cells before native I/O, preserve unrelated row fields/original identities, use built-in scalar predicates, and apply bounded Windows multi-failure test budgets without weakening cleanup/assertions. Added LF checkout policy to make cross-platform formatting consistent; no Git user configuration changed.
- Post-commit validation: all 38 tests pass with fresh native debug/release compilation, all 27 original evaluate/SQLite/Rust cases and actual mapped rustc failures. Task-scoped vp check and strict package TypeScript pass without warnings; workspace builds pass freshly; Expr, Query, Effect and Source examples pass. Root lint/type checking (`vp check --no-fmt`) passes; full formatting remains blocked only by the four preserved untracked user documents. The host taskkill delay recovered during the repeat: the same full suite fell from about 329 seconds to 42 seconds with unchanged native semantics.
- Self-review traced reachable property reads, source snapshots, row identity, UTF-16/f64 protocol, data rejection before getters/native execution, diagnostic fallback, LF/coordinate fixtures and test failure counts. The unfinished local closed-fixture draft remains preserved in the named stash as historical work; no duplicate evaluator or RC.116 overrides were applied over the verified upstream implementation.

## 2026-10-01 — Facet evaluation

- Reviewed Facet source at 65bae5c31a7ce401bc44630fb96250ea884cfd3e and registry releases before selecting a role. Recorded static SHAPE/borrowed Peek versus allocated Partial plans, feature/MSRV/version distinctions, unsafe layout/invariant boundaries and Schema/wire compatibility gates in [Facet research](docs/research/facet.md).
- Kept Facet optional for later native record inspection/Schema codecs alongside generated operations and Serde. Deriving static type metadata does not add a field to every number, but it cannot identify executed source occurrences or establish Effect RPC/SchemaBinary compatibility. Linked the evaluation from metadata/runtime designs, docs index and PLAN; no dependency or native code changed.
- Next implementation remains honest artifact-off compilation with skipped provenance/ranges/hashing/serialization, unchanged generated sources/domain results and reduced-diagnostic/retention checks, then Unit, bounded failure frames and scoped logging.
- Review verified static derive output, pointer/view construction, allocated reflection state, stable versus prerelease MSRVs/features and identity/wire boundaries. Validation: vp check passes without warnings, strict package TypeScript passes, all 37 tests pass with fresh native debug/release builds, workspace builds pass with all four tasks cached, and all 114 local documentation links/anchors in changed/new Markdown resolve. This evaluates source/APIs; it does not claim a compiled Facet integration or benchmark.

## 2026-10-01 — Metadata cost, Volar and Rust emission design

- Reviewed current annotation/provenance/emission lifetimes and the source-map, observability and migration designs. Checked Volar upstream/registry interfaces, Rust representation/static/reference-counting guarantees, JavaScript WeakMap behavior and tracing callsites. Recorded alternatives, choices and performance/editor acceptance before proceeding in [metadata and editor research](docs/research/metadata-and-editor-tooling.md).
- Added [metadata ownership/costs](docs/metadata-cost.md): compiler-only current annotations, measured retained heap/artifacts, wrapper-keyed WeakMap tradeoffs, plain Rust scalars/static IDs, Result/future layout caveats, dynamic-context/export ownership and independent capture/artifact/instrumentation policies. Current builder compile API has no metadata-off path; plan that before runtime frames/logging rather than per-value tags or a global native map.
- Added [Volar/editor integration](docs/editor-tooling.md) based on upstream commit 44d58aee and observed npm 2.4.28: useful optional virtual-code/navigation infrastructure after compiler diagnostics/read-only previews, with TypeScript-native checker compatibility, revision/coordinate/feature gates and no arbitrary module evaluation or inverse Rust fixes. No Volar dependency installed.
- Added [typed Rust emission guidance](docs/rust-emission.md), keeping verified tagged IR and one byte-counting writer while extracting identifier/type/literal/expression/item helpers as supported constructs need them. Updated PLAN, milestones, compiler/migration/source/observability docs, package README, docs index and AGENTS. No native runtime or new helper API was implemented.
- Added [a reproducible isolated-process performance probe](scripts/measure-source-metadata.mjs). Five samples/variant of 128 functions × 16 additions showed identical 115,086 generated Cargo/Rust bytes; annotation medians added about 133 KiB retained program heap. Both variants serialized about 2.4 MB auxiliary JSON. Compile timing differences were inconclusive; this measures compiler retention, not peak allocation or native throughput.
- Validation: vp check and strict package TypeScript pass, all 37 tests pass with fresh native debug/release crates, workspace build passes with all four tasks cached, and all 249 local documentation links/anchors in changed/new Markdown resolve. Review checked storage lifetimes, failure layout costs, profile semantics, Volar source/registry-version distinctions, native checker wrappers, mapping boundaries and probe limitations.

## 2026-10-01 — Source-provenance foundation

- Rechecked current immutable builders, checker/pass boundaries, shared Rust helpers, artifact writing, Effect RC.118 and official rustc/Cargo JSON. Recorded annotation/identity, bounded graph, writer/range, digest/privacy, diagnostic and validation choices before planning in [foundation research](docs/research/source-maps.md#foundation-implementation-preparation--2026-10-01).
- Implemented immutable Source.file/site/at/use/named and R.Source on Expr/Fn/Computation/EffectFn, retaining generic inference, semantic node/binder identity and callback counts. Compiler errors now expose explicit/related/contextual locations; reference/lowering sharing uses semantic nodes and NativeRunner accepts metadata copies with unchanged body/witnesses/channels.
- Replaced mapping-critical Boolean/u64 template emission with a UTF-8 source writer and immutable lower-stage provenance. Added version-1 reffect.sources.json/build manifests, SHA-256 identity, compact parent/edge occurrence encoding, source/definition/use ranges, offline digest-checked resolution and omitted source contents. Shared helper declarations and use ranges remain distinct; normalization/optimization still preserve IR unchanged.
- Extended GeneratedFiles with validated optional auxiliary files and exclusive writing. Cargo build parses JSON diagnostics, preserves raw/stdout/stderr, verifies optional map/manifest/generated identities and maps real primary/related/macro spans. Missing/malformed/stale maps preserve native failures. Runner stdout and typed domain-error protocols remain unchanged. Foldkit retains its existing unmapped emitter and passes native conformance.
- Added ten source conformance tests and strict type contracts: callback/identity immutability, UTF-16/UTF-8/CRLF/BOM/astral/separator positions, shared helper use sites and native parity in debug/release, aliases/ancestry, depth-128 metadata growth, revision-specific digests, malformed/cyclic/stale maps, actual rustc type errors and output-path refusal. Added [the source example](examples/source/main.ts) and aligned the [API](packages/reffect/README.md#source-provenance-and-build-diagnostics), design, plan and milestone status.
- Validation: all 37 tests pass with fresh native debug/release crates; strict package TypeScript and root vp check pass without warnings; workspace builds pass with reffect rebuilt and starter tasks cached. Expression, Query, Effect and Source examples pass fresh native/reference checks; all 24 checked added/current documentation links/anchors resolve. Initial full-suite failures were missing Cargo on this shell PATH; sourcing $HOME/.cargo/env resolved them.
- Self-review corrected function-alias context, helper-definition versus invocation attribution, semantic sharing across metadata copies, immutable lowered provenance, source snapshot indexing and compact wire ancestry. Post-commit review also corrected the documentation to distinguish implemented byte tracking from future generated line/column projections. Automatic AST/MagicString/JS maps, v3 projections, imported Foldkit sites, runtime logical frames/logging and native symbols remain follow-ups. Next: named failure frames and scoped logging/Unit under the observability gates.

## 2026-10-01 — Source-map research and design

- Reviewed the current IR/emitter/artifact/Cargo boundaries and observability/migration plans; checked ECMA-426, installed MagicString, jridgewell map tools, Vite/Rollup, Node 24.19, rustc/Cargo JSON and native symbols. Recorded alternatives, coordinate contracts, version limits and acceptance before design integration in [source-map research](docs/research/source-maps.md).
- Added [source maps and authored diagnostics](docs/source-maps.md): three mapping layers, explicit UTF-16/UTF-8/Unicode-scalar coordinates, immutable definition/use/transform origins, AST/MagicString boundaries, authoritative Rust ranges plus optional v3 maps, rustc JSON diagnostics, native symbol lookup, source/privacy policy and conformance gates. Integrated the foundation/optional-adapter/deployment sequence into PLAN, observability, milestones, compiler/conformance/migration references, docs index and AGENTS.
- Self-review checked shared helper attribution, exact versus point precision, native/async stack limits, coordinate conversions, fixed artifact writer extension, source digest checks, host map composition and unchanged runner stdout. All 40 added/new local links and anchors resolve. `vp check` passes without warnings; strict package TypeScript passes; all 27 tests pass including fresh native debug/release crates; workspace builds pass with all four tasks cached (documentation-only change).
- Post-commit review clarified that AST parser span units are producer-specific: normalize verified parser offsets to the JS/TS contract rather than assuming every parser uses UTF-16. All other mapping/identity/host/native boundaries remain as designed.
- This is researched design and plan integration; no map producer, runtime feature or new dependency is implemented. Next: immutable source/use metadata and provenance-aware Rust emission before optional automatic annotations.

## 2026-10-01 — Observability design and roadmap integration

- Reviewed implemented compiler/reference/native boundaries and roadmap references; inspected Effect RC.118 Logger/Tracer/Metric/Cause and built-in OTLP source, Rust tracing/OTel release metadata/manifests, W3C propagation, error/log/metric conventions, native backtraces and diagnostic tools. Recorded evidence, alternatives and compatibility gaps before design integration in [observability research](docs/research/observability.md).
- Added [the full observability design](docs/observability.md): compiler provenance/source artifacts, three separate stack/trace views, failure annotations, typed logging and severity/stream routing, scoped async context, Effect versus OTel status policies, metrics, Rust substrate choices, optional dependency profiles, redaction and bounded export/shutdown. Integrated delivery/acceptance gates into PLAN, detailed milestones, runtime/compiler/conformance references, docs index and agent guidance.
- Review checked existing scalar/typed-error compatibility, source capture limits, Effect versus OTel policies, Fatal/integer preservation, shared-source occurrences, context restoration, signal-independent filtering and exporter lifetimes. Validation: all 42 new local documentation links/anchors resolve; published RC.118 OtlpTracer source matches the installed source byte-for-byte; `vp check` passes without warnings, strict package TypeScript passes, all 27 tests pass with fresh native debug/release crates, and workspace builds pass (all cached because only Markdown changed).
- This work specifies the design and milestone obligations; it does not install crates or claim native telemetry/logging/source maps are implemented.

## 2026-09-30 — Milestone 2 synchronous Boolean/u64 profile

- Added immutable Boolean/Never witnesses, Boolean/u64 predicates, exhaustive pure/computation `R.Match.bool`, separate typed Computation nodes, and `R.Effect.succeed/fail/map/flatMap`. The four-argument `R.fn` and `R.Effect.fn` declare success/error channels; mixed pure/effectful programs retain the existing pipeline. Builders execute once with symbolic lexical continuation parameters.
- Official Effect interpretation preserves selected branches, failed-source short-circuiting and nested continuation scope. Checking rejects escaped parameters, inconsistent channels and unsupported reachable operations. Planning records typed effect/capability references and the selected generated Rust Result adapter; canonical representations and the target are checked even without operations. Ownership explicitly uses primitive copying.
- Rust emission uses branch-local helpers, bool/u64/Result/Infallible, and no dependencies. A fresh depth-32 release test exposed optimizer inlining that rebuilt an exponential branch tree and exhausted rustc memory; helper `#[inline(never)]` preserves sharing and debug/release now pass. Depth-128 source-size checks cover linear lowering.
- Added `NativeRunner.run` with tuple/result inference, artifact/function identity checking, input/output Schema validation and official Exit results. Domain failures return status zero; malformed/wrong-channel/out-of-range outputs and process failures remain distinct errors. The existing pure-u64 decimal bridge/Cargo.validate remain compatible.
- Added strict type contracts, native/reference differential cases for both branches, all predicates, nested map/flatMap, overflow, Boolean/u64 failures and Never channels, plus a runnable [Effect example](examples/effect/main.ts). Typed failure payloads are compared separately from reference debug stack annotations.
- Validation: root `vp check` passes without warnings; strict `vp exec tsc -p packages/reffect/tsconfig.json --noEmit` passes; all 27 tests in five files pass, including fresh native debug/release and malformed-output checks; `vp run -r build` passes (reffect fresh, starter builds cached). All three expression, Query and Effect examples pass fresh native/reference checks.
- Self-review traced channel widening, lexical binder checks, selected-branch evaluation, implementation/target identity, immutable canonical schemas, shared graph lowering and native protocol boundaries. Corrected forged channel joins, mutable Never schema exposure and empty-graph target acceptance before publication; no new Foldkit-Plus issues were found.
- Scope: this completes the initial synchronous Boolean/u64 slice of milestone 2. Owned strings/records, explicit union representations/full tagged Match and move/borrow/clone inference remain the next work; async effects, defects, interruption, services and finalizers are unsupported. See [research](docs/research/basic-effect-ir.md) and [public API](packages/reffect/README.md#synchronous-effect-profile).

## 2026-09-30 — Basic Effect IR preparation

- Reviewed milestone 2, the revised pipeline, current scalar kernel/compiler and existing native/Foldkit evidence. Checked installed Effect RC.118 success/failure/sequencing/Exit APIs against official source and Rust Result/Infallible semantics.
- Recorded the explicit Boolean/u64 channels, exhaustive Boolean Match, lexical continuation binding, fixed synchronous Result adapter and fresh native/official Effect acceptance in [basic Effect IR research](docs/research/basic-effect-ir.md). Owned/union representations and asynchronous runtime semantics remain separate future work.

## 2026-09-30 — Milestone 1 Foldkit encoded-primitive Query profile

- Added direct consumption of published `foldkit-entity@0.4.0` Expr/Query through `Foldkit.compile/build/run` and `Compile.fromFoldkitQuery`. Checked snapshots preserve Entity owner tokens and field/input witnesses, reject unsupported representations, derive memoized support reports, and lower each shared expression node once. Artifacts explain selected generated operation implementations and have no Cargo dependencies.
- Generated Rust accepts dynamic encoded input/row vectors through a versioned stdin bridge, borrows UTF-16/f64/boolean/null scalar values and returns ordered row indices. It preserves complete original row objects, SQL unknown under nested comparisons, where short-circuiting, stable ordered ties, exact string equality and nonfinite numeric equality. Cargo now shares a GeneratedFiles contract and scoped stdin execution across compiler consumers.
- Added a runnable Query search example, public API docs and strict type contracts. Every one of the 27 published conformance cases agrees across official evaluate, upstream Drizzle compileWhere/compileOrderBy over real Node SQLite, and fresh native debug/release crates. Additional cases cover nullable/missing values, escaped/lone-surrogate strings, stable/boolean ordering, malformed input, decoded timestamps, source mutation snapshots and depth-128 shared graphs.
- Recorded user-requested Foldkit-Plus findings and reproductions in [the issue document](docs/research/foldkit-plus-issues.md): Unicode/NUL containment disagreement, exponential ownership/dependency walks, mutable clauses, identity loss in dependency reports, and Remote/Drizzle's incompatible `effect/unstable/rpc` import under RC.118. Both upstream repositories are cloned outside this checkout; no upstream code was changed or issues posted.
- Drizzle's incompatible Remote dependency chain requires a test-only MIT-licensed snapshot of its unchanged query compiler at upstream `f98f4d5cbaebb7aecf2ec636dd198fae01db5b1c`. Pinned Drizzle RC.4's declarations fail TypeScript 7, so skipLibCheck excludes dependency declarations while authored sources, tests and type contracts remain strict. The initial apparent missing build output was disproven by registry tarball inspection and reinstall; it is not recorded as a confirmed packaging defect.
- Validation: `vp check` passes without warnings; `vp exec tsc -p packages/reffect/tsconfig.json --noEmit` passes; `vp test` passes all 21 tests (four files), including fresh native debug/release conformance; `vp run -r build` passes with reffect rebuilt freshly and starter builds cached; both `vp exec node --experimental-transform-types examples/expr/main.ts` and `examples/query/main.ts` pass fresh native/reference validation.
- Self-review traced support/type/identity boundaries, cycle/DAG handling, stdin arity and scalar encoding, index output validation, immutable artifact snapshots, sort stability and scoped cleanup. Sort keys are validated before Rust sorting so nullable/nonfinite keys cannot create an inconsistent comparator. No law-driven rewrite or general native Effect runtime was added.
- Committed implementation as `3be927c`; re-read the committed compiler/runtime/Cargo diff and repeated root checking, strict TypeScript, all 21 tests with fresh native crates, and workspace builds (cached). No review corrections were required. `GIT_TERMINAL_PROMPT=0 git push origin master` failed because this environment has no GitHub username/credentials; the implementation is committed locally and not published.
- Publication resolved after user-authorized GitHub CLI device sign-in as `doeixd`: pushed `3be927c` and `2698c03` to origin/master. The preconfigured GH_TOKEN worked for API reads but returned HTTP 401 for Git pushes; this checkout's GitHub credential helper uses the newly stored CLI sign-in without the environment token overriding it.
- Supported limits: evaluated containment operands must be non-NUL ASCII; when two or more rows survive, every order key must be present and numeric keys finite. Text ordering follows JS UTF-16, with no universal SQL collation claim. Reachable objects/arrays/bigint/opaque scalar schemas, decoded Date values, non-field ordering and implicit domain encoding remain unsupported. Structured result rows are preserved rather than interpreted field-by-field.
- Next: milestone 2 general compiled functions, Match/Predicate and basic Effect IR, following its required research/design preparation. Native SQLx, Remote, RPC, concurrency and later workloads remain unimplemented.

## 2026-09-30 — Foldkit Query preparation

- Reviewed milestone 1 and the current arithmetic compiler; inspected Foldkit-Plus at `f98f4d5cbaebb7aecf2ec636dd198fae01db5b1c`, published Entity/Drizzle packages, Effect RC.118 Schema/process APIs, Rust stable sorting and ECMAScript string comparison.
- Recorded the selected direct-IR adapter, encoded primitive profile, upstream Unicode containment discrepancy, dependency-free evaluator bridge and acceptance checks in [Foldkit Query research](docs/research/foldkit-query.md). Implementation and conformance results follow below when validated.

## 2026-09-30 — Milestone 0 arithmetic compiler path

- Implemented `packages/reffect` with immutable, pipeable IRType/Expr/Fn/Program factories, typed semantic references, operation signatures/metadata, subject-indexed laws and evidence policy. `R.U64` is exact bigint/u64 with modular add/sub/mul; data-first and data-last arithmetic preserve tuple inference without user casts.
- Added the official Effect v4 reference evaluator, structured diagnostics, public check/derive/normalize/plan/verify/optimize/ownership/lower/emit/build API, Compiler/Cargo services, explainable implementation selection, Rust library/evaluator emission, and scoped offline Cargo validation. Pure Expr rejects effects/requirements; the backend refuses unregistered operations/representations and invalid plans. Law registrations remain claims; normalization/optimization are identity stages and ownership is primitive copy.
- Added `examples/expr/main.ts`, package usage docs and strict type-contract fixtures. User examples/tests have no casts or semantic-object spreading. IR consumers use exhaustive Effect Match handlers and built-in Exit predicates.
- Pinned Effect/platform-node to 4.0.0-rc.118, installed language-service editor support, and aligned utils Vite+ to 0.3.2. The prior starter suite-detection failure is resolved. Native conformance covers 23 cases in both debug/release, plus public build/evaluator failure and overwrite-refusal behavior.
- Native setup initially found Coreutils `link.exe`; installed minimal Visual Studio Build Tools 18.10.2 C++ compiler/Windows SDK components and validated under `VsDevCmd.bat -arch=x64 -host_arch=x64`. No global PATH change or alternate semantic backend was added. See [research/evidence](docs/research/semantic-kernel.md) for exact dependencies, decisions and installer outcomes.
- Added the requested commit/push cadence, current-branch/workspace constraint, and deliberate post-work/post-commit review checklist to AGENTS.md.
- Published `962bb9d` (compiler path) and `cb99634` (review corrections) to origin/master after post-commit validation. Task-scoped `vp check` passes without warnings; `vp exec tsc -p packages/reffect/tsconfig.json --noEmit` passes; `vp test` passes 12 tests, including fresh Cargo debug/release builds and shared-DAG native parity; `vp run -r build` passes (the review change rebuilt reffect freshly; the post-commit repeat was cached). `vp exec node --experimental-transform-types examples/expr/main.ts` passes native/reference overflow parity.
- Full-root `vp check` is blocked by formatting in four concurrently added, untracked documents: docs/effect-adjacent-projects.md, docs/effect-ecosystem.md, docs/effect-schema.md and docs/effect-v4-api-scope.md. These files are preserved and excluded from task commits; all task files pass scoped checking.
- Review checked binder/type/arity boundaries, semantic identity collisions, evidence policy, target capabilities, output exclusivity, native failure reporting and call-site inference. Windows cleanup of a failed child process takes about 60 seconds through the official Node process adapter; successful native parity runs take about 9 seconds. This is an upstream/platform integration limitation to investigate before broader process-heavy workloads, not a skipped failure test.
- Independent review identified mutable builtin Schema internals and exponential expansion of shared expression graphs. The follow-up freezes the local checked Schema/AST/checks and lowers shared applications into dependency-ordered Rust locals. Regression tests cover both failures, and independent follow-up review plus strict/non-native checks found no corrections; main-agent fresh native validation also passes.
- Remaining roadmap: milestone 1 Foldkit Entity Expr/Query adaptation and existing evaluator/Drizzle/Rust conformance. General Effect IR, RPC, runtime adapters, migration and later milestones remain unimplemented.

## 2026-09-30 — Semantic kernel preparation

- Reviewed the revised kernel and milestone acceptance alongside the starter workspace; checked primary Gen2, Effect v4 migration, package registry, and Rust arithmetic sources.
- Recorded the milestone 0 design and validation obligations in [docs/research/semantic-kernel.md](docs/research/semantic-kernel.md). Implementation follows that record: bigint/u64 modular arithmetic, explicit symbolic IR, public Effect stages and scoped platform dependencies.
- Incorporating user-directed authoring refinements: IRType naming, pipeable typed factories/combinators, typed semantic references, and cast/spread-free examples/tests; rationale and API source checks are recorded in the same research document.

## 2026-09-30 — Commit hooks and discretionary delegation

- Removed the tracked pre-commit hook, staged-file configuration, and package prepare script that installed the Vite+ dispatcher. Disabled the local dispatcher, removing its generated pre/post-commit shims and hooksPath; installs no longer recreate it.
- Updated AGENTS.md to use subagents only when needed, with direct self-review for routine work, and to keep commit hooks disabled unless requested. Aligned PLAN.md with the discretionary review guidance.
- Self-reviewed this routine configuration/documentation change. `vp install` and `vp check` pass; hook status after installation confirms disabled preference, unset hooksPath, missing dispatcher, and no project hooks. `vp test` reproduces the known starter suite-detection failure.

## 2026-09-30 — Section-local design update links

- Added 48 **Later update** notes beside affected sections in PLAN.md and 13 earlier design references. Notes link directly to revised kernel/passes, Query-first milestones, early RPC middleware, conservative ownership, optional Cruster, runtime registry/adapter guidance, migration diagnostics/validation, and the reffect/R naming decision.
- Distinguished superseded sequencing from additive detail while preserving the historical discussion bodies and examples. The docs index explains how to read these notes; existing top-level precedence guidance remains in place.
- Validation: all 62 breadcrumb file/heading links resolve; `vp check` and workspace builds pass (website cached, utils rebuilt). `vp test` reproduces the previously documented starter Vitest suite-detection failure. No feature code or dependencies changed.
- Subagent review found no actionable issues and independently verified the update/index links, design precedence, milestone scope, and preserved historical bodies.

## 2026-09-30 — Migration design preparation

- Reviewed prior compiler/API/milestone/conformance/runtime references and researched current Codemod, Effect-tsgo, upstream Effect migration material, and Grit/GritQL pages before integrating the supplied migration proposal.
- Recorded sources, date/version limits, alternatives, design constraints, acceptance, and open questions in [docs/research/migration-tooling.md](docs/research/migration-tooling.md). Codemod remains a candidate; no tool dependencies or migration implementation are added. A passing native check establishes representability, not source-rewrite semantic equivalence.
- Integrated the supplied conversation into docs/migration-tooling.md and linked design/research from PLAN.md, AGENTS.md, the index, and relevant API/compiler/conformance/milestone/reuse references. All migration commands, packages, and agent-skill layouts remain proposals; target scope and existing core milestone order are preserved.
- Research/preparation review found no corrections to design or source claims; its request to index the research record is addressed by the migration integration.
- Validation: `vp check` passes; workspace builds pass using cached results. Root/workspace tests reproduce the documented starter Vitest suite-detection failure; no feature code was changed.

## 2026-09-30 — Project naming and GitHub publication

- Recorded the user's canonical project name `reffect` and compiled DSL namespace `R` in AGENTS.md. Earlier Effect Native/effect-native and C examples remain historical context; naming does not imply existing exports.
- Published the reviewed project and existing starter workspace to [doeixd/reffect](https://github.com/doeixd/reffect) as a public GitHub repository using gh. Added a project README, design-stage About description, and topics: effect, effect-ts, typescript, rust, compiler, semantic-compiler, intermediate-representation, ahead-of-time, codemod, and vite-plus. Verified public visibility, metadata, and the master default branch; origin tracks the GitHub repository.
- Subagent review confirmed migration design coverage, target/profile boundaries, semantic verification limits, naming guidance, links, and accurate publication status. Removed starter package author/repository/homepage/bugs placeholders identified during review before publication.

## 2026-09-30 — Preparation before features and plans

- Added an explicit AGENTS.md requirement to review prior docs/code, research current primary sources online, assess the design and alternatives, and record evidence/decisions before creating an implementation plan or changing feature code.
- Research/design records belong in the relevant docs/ reference, with source links, checked versions/dates, rationale, uncertainties, and validation criteria; PROGRESS.md links the record and the docs index tracks new documents.

## 2026-09-30 — Rust substrate and semantic adapter guidance

- Added docs/runtime-lowering.md from the supplied conversation, integrating one copy of the duplicated passage and cleaning formatting. It retains the mapping catalogue, specialization/wiring examples, caching/pools, batching, Schedule/Stream, runtime boundaries, and implementation-research leads as proposals.
- Integrated direct/generated lowering, substrate adapters, dedicated semantic runtime, and separate operation/service/semantic implementation registries into PLAN.md and AGENTS.md; cross-linked the docs index and relevant design, reuse, architecture, API, milestone, and conformance references.
- Made semantic parity and reachable Cargo dependency selection explicit acceptance obligations. Clarified that timer/semaphore mappings may need interruption handling, similarly named Sink/collection primitives require semantic comparison, percentages are unmeasured, and ordinary Effect.gen authoring belongs to later syntax support.
- No crate dependencies or compiler features were added; the revised milestone order remains unchanged. External API/crate claims and original unresolved citation placeholders are not newly verified.
- Validation: `vp install` and `vp check` pass; `vp run -r build` passes using cached workspace results. `vp test` and `vp run -r test` reproduce the existing starter's “Vitest failed to find the current suite” failure. `vp env doctor` passes with the existing Volta PATH notices.
- Subagent review found no blocking issues: major conversation topics are retained, registry families and semantic obligations are clear, candidate mappings remain provisional, builder-only scope/milestones are unchanged, and local Markdown links resolve.

## 2026-09-30 — Operation/expression design revision

- Read all 5,875 lines of docs/op-expr-revision-convo.md and split its four prior-art discussions and final revised plan into seven focused documents with scripts/Split-DesignConversation.ps1. Exact source reconstruction is checked before repository formatting.
- Replaced the original conversation path with a linked revision overview. Updated docs/README.md, AGENTS.md, PLAN.md, and all six earlier reference docs with relevant cross-links and precedence notes.
- Updated the roadmap to the detailed revised milestones 0–15: kernel/law evidence, Foldkit Query conformance before general Effect IR, early RPC middleware, Remote/SQL/streaming/live/SSR/resume, then codecs, broader concurrency, and optional distributed targets. The final condensed sequence uses different later numbering; the overview records how to interpret it.
- Added explicit knowledge of checked traits, evidence policies, separate capabilities/effects/requirements, explainable planning, conservative initial ownership, deferred shared-kernel extraction, and optional Cruster isolation.
- Compiler implementation remains unstarted. Upstream APIs and licensing observations in the preserved conversation have not been re-verified.
- Validation: `vp install` and `vp check` pass; `vp run -r build` passes using cached workspace results. `vp test` and `vp run -r test` reproduce the unchanged starter's “Vitest failed to find the current suite” failure. `vp env doctor` passes with the previously observed Volta PATH notices.
- Subagent review verified formatted extraction parity for all seven bodies, local file links, extraction refusal behavior, and revised milestone sequencing. Fixed repeated Acceptance contents links and added duplicate-heading counters to the extraction script.
- Expanded AGENTS.md at the user's request with the semantic compiler goal, concrete workload/showcase targets, design precedence, Effect v4 guidance, IR/evidence rules, compiler planning, scope/conformance guidance, and commit/review workflow.
- Follow-up review confirmed the anchor fix and formatted extraction parity; clarified AGENTS.md to allow early claim-level law registration while gating tested evidence and rewrites appropriately.

## 2026-09-30 — Design documentation

- Read the original PLAN.md in full and extracted its six design discussions into docs/ using scripts/Split-Plan.ps1. The script verifies exact body preservation before repository formatting; the final documents match a freshly extracted, formatted copy.
- Replaced PLAN.md with a concise entry point: constraints, document map, consolidated implementation sequence, acceptance evidence, validation strategy, and open decisions.
- Added docs/README.md and linked all design documents from AGENTS.md.
- Compiler implementation has not started; the repository currently contains the Vite+ starter. The design documents describe proposed capabilities and APIs.
- Validation: `vp install`, `vp check`, and `vp run -r build` pass. Both `vp test` and `vp run -r test` fail in the unchanged starter test (`packages/utils/tests/index.test.ts`) with “Vitest failed to find the current suite.” `vp env doctor` passes its checks and reports that several PATH entries use Volta rather than Vite+ shims.
- Subagent review verified all six formatted extractions, local document links, contents anchors, and script refusal behavior. Corrected the preservation note to distinguish exact extraction from subsequent formatting.
