# Resuming the Effect v4 implementation work

This is the handoff for the parallel module work: extend the statically representable Effect v4 API through checked IR, official Effect interpretation and native Rust conformance. The core roadmap, Remote/SQL and SSR are also advancing in this shared checkout. Coordinate shared compiler edits with their owner; this workstream does not replace [PLAN.md](../PLAN.md).

Updated 2026-10-07. The installed oracle is **Effect 4.0.0**; current Deferred native evidence uses **Rust 1.98.1 / Tokio 1.53.1**. Earlier research used Effect rc.118. Check the installed version and current source before extending an old decision.

## Get situated

Read [AGENTS.md](../AGENTS.md), the current frontier in [PLAN.md](../PLAN.md), and the newest relevant entries in [PROGRESS.md](../PROGRESS.md). Then use these three documents for different questions:

- [Module decisions](effect-modules.md): what bounded behavior has been chosen, and which record owns it.
- [Coverage and priority waves](effect-module-coverage.md): module families and their semantic dependencies; namespace presence does not mean complete upstream support.
- [Open work](open-work.md): remaining refusals, measurements and revisit gates.

Confirm those claims against exports and tests. Historical research sections often describe a gate that a later record closes; read the current implementation and latest delivery record together. Passing an internal prototype does not establish public admission.

Start in the existing checkout and branch:

```bash
cd /workspace/reffect
git status --short --branch
git fetch origin
git log --oneline --max-count=8 HEAD origin/master
```

If the tree is clean and only behind, use `git pull --ff-only`, then `./node_modules/.bin/vp install`. If local commits or another agent's edits are present, coordinate integration before pulling or rebasing. Preserve their work; do not reset, stash another agent’s edits, reformat their active files, create a worktree/branch, or force-push to clear the way. The user has authorized pushing confident changes; repository review and post-commit validation still apply.

## What this stream has built

The early parallel tracks delivered bounded resource brackets/Scope, lexical Context/Layer providers, typed recovery and Schema boundaries. Subsequent slices added Option/Result, selected collection/control-flow helpers, local Ref, Duration configuration, Clock/scripted Random, Exit/Cause values, structured tasks and scalar fallible-task recovery. See their records for exact supported functions and representation limits.

The recent frontier is **lexical Deferred and Semaphore shared by statically bounded child computations**. Bounded Semaphore now has public owned execution and generated live scans, described in the continuation section below. It has progressed beyond a sequential completion demo: retained first completion, broadcast order, late awaiters, independent waiter cancellation, masked cleanup, initial nested Race, exact interrupted logical frames, owned reference execution, capture pruning and native/code-growth admission have differential evidence. Native owner and child state are specialized and inline; children borrow caller-pinned futures. This does not expose detached fibers or arbitrary coordinator sharing.

**Public bounded Deferred:** `R.Deferred` (also exported as `DeferredIR`) provides `make(successWitness)`, `await`, dual `succeed`, and `isDone`. `DeferredExecution.run` and `runWithFrames` are the owned Promise reference boundary; options accept only an optional AbortSignal and observations contain Exit plus captured logs. `Compile` selects the checked generated backend for admitted standalone programs, including mixed modules, with `Compile.withTarget(Rust.tokio)` for the asynchronous generated backend. Ordinary `Reference.run` keeps its prior interpreter behavior, including refusal of nested task groups; it does not promise parity under arbitrary ambient scheduler/context. Full typed `fail` remains internal, and RPC embedding is explicitly refused. See [public execution decisions](research/deferred-public-execution.md) and [admission](research/deferred-public-admission.md).

The bounded generated profile currently requires zero authored inputs, Bool/U64/Unit success and Never error, and lexical nonescaping owners. A root All has two or three children; supported initial inner Race has two. At most six task contexts are live. Callback-started groups, nested All, deeper/multiple Race, richer completion causes, handle escape, general Ref/resource sharing and dynamic spawn remain separate gates. Builder availability must not imply these programs compile.

## Where to change code

Paths below are relative to `packages/reffect/src/`.

| Concern                               | Files and responsibility                                                                                                                                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public authoring and exports          | `authoring.ts` assembles `R`; `index.ts` is the package barrel. Focused module files such as `option.ts`, `ref.ts`, `deferred.ts` implement typed builders.                                                                                                           |
| Types, expressions and operations     | `kernel.ts`: IRType witnesses, symbolic Expr/Fn/Program, semantic references, operations, representations and pure interpretation. New runtime values need checked witnesses and native representations.                                                              |
| Computation semantics                 | `effect-ir.ts`: computation union/builders, checker and ordinary official-Effect interpreter. Every new node needs all relevant traversals, not only an authoring helper.                                                                                             |
| Public reference boundary             | `reference.ts`: public channel checks and normal interpretation. `deferred-execution.ts`: fresh owned standalone execution, trusted expressions, closed cancellation options and immutable observations.                                                              |
| Compiler admission and selection      | `compiler.ts`: check → derive → normalize → plan → verify → optimize → ownership → lower → emit → build. Capability/service selection and compiler-issued stage receipts must remain valid.                                                                           |
| Rust generation                       | `lower.ts`: helper capture/binding plans, async/group lowering, root construction and emission. `rust-emit.ts` supplies typed internal emission helpers; source writers preserve mapped byte ranges.                                                                  |
| Deferred representation/topology      | `deferred-model.ts`, `deferred-generated-profile.ts`, `deferred-budget.ts`: lexical channels, admitted task topology and maximum reference-operation receipt.                                                                                                         |
| Deferred reference and frames         | `deferred-generated-reference.ts`, `deferred-interruption-frames.ts`: conditional official-Effect integration, root interruption observers and scope-indexed shared diagnostic paths.                                                                                 |
| Deferred state/turn adapters          | `deferred-state-runtime.ts`, `deferred-turn-runtime.ts`, `deferred-coordinator-runtime.ts`, `deferred-generated-runtime.ts`: retained outcomes, removable waiters and bounded cooperative routing. Read generated source integration before altering scheduler steps. |
| Independent size/growth gates         | `nesting.ts`, `deferred-growth.ts`, `deferred-layout.ts`: iterative nesting preflight, full-edge expanded structural/source bounds and exact native returned-future layout checks.                                                                                    |
| Runtime services and failure carriers | `runtime-service-model.ts`, service implementation/lowering records and retained-outcome analysis: explicit drivers and reachable failures. A declared error channel alone does not determine retained runtime outcomes.                                              |
| Native artifacts and execution        | `cargo.ts`, `native-runner.ts`, runtime Rust sources and test fixtures: build failures, actual Rust execution, frame/outcome observations. `rg --files` locates each module's fixture.                                                                                |

If a helper expands into existing nodes, prefer that over adding a semantic runtime. When a new node is necessary, search its neighboring tags across the repository: checkers, derivation, scope/free-reference analysis, effect/reference interpretation, provenance, ownership, lowering and budget visitors all need a conscious decision. A default branch can hide an omitted obligation.

## Deferred contracts that must survive public admission

Use these records as the shortest route to the current design:

- [Generated lowering](research/deferred-generated-lowering.md), [nested integration](research/deferred-nested-integration.md) and [nested conformance](research/deferred-nested-conformance.md): admitted ownership/topology, first-poll/broadcast ordering and awaited cancellation cleanup.
- [Owned execution](research/deferred-execution-boundary.md) and [context audit](research/deferred-context-audit.md): a fresh official MixedScheduler/context, 2048 operation limit with automatic yielding enabled, trusted builtin expression references, no inherited host hooks, and a closed same-realm AbortSignal option. Do not expose a mutable Fiber or arbitrary execution callbacks.
- [Interruption frames](research/deferred-interruption-frames.md): masked root observers, pre-aborted work unopened, started interruption observed after cleanup, scope-indexed shared paths and a separate 4096-entry diagnostic-plan ceiling.
- [Capture costs](research/helper-capture-costs.md) and [future storage](research/nested-future-storage.md): full lexical binding scope with only used captures, caller-pinned borrowed children, quiet zero-allocation evidence and measured future layouts.
- [Generated growth](research/deferred-generated-growth.md): charge every incoming edge and dormant branch independently of the maximum executed branch. Per-function weighted computation depth ≤50, computation occurrences ≤512, expression depth ≤64, expression occurrences ≤4096 and authored UTF-8 text ≤64KiB. Deferred-bearing modules separately limit aggregate occurrences/text and emitted Rust to 2MiB.
- [Native layout](research/deferred-native-layout.md): every actual exported Deferred root must fit **2560 target pointers** at native code generation. The cold non-inlined report forces checks even for optimized uncalled library exports. `cargo check`, emitted source and standalone reference success do not prove that layout gate.

These are independent constraints. Frame/source-metadata opt-outs do not relax them. The inline future ceiling does not bound referenced context, retained heap, peak construction stack or compiler memory. Preserve plain native scalar layouts and avoid introducing Box/Arc/metadata fields to make a conformance fixture pass without a recorded representation decision.

The Effect-valued generated interpreter remains useful for controlled-clock research, with conditional context assumptions. Its success must not be substituted for owned production-reference evidence. Trusted operation identity matters: a new object sharing a builtin display name or semantic reference can still contain an arbitrary JavaScript callback.

## Implement one bounded module slice

1. Choose an executable workload and its observations. State supported functions, payload/error types, lifetime, topology and unsupported cases before promising a module.
2. Read installed Effect source/types and consult current online primary sources. For example, start from [Effect 4.0.0 Deferred](https://unpkg.com/effect@4.0.0/src/Deferred.ts) or the corresponding pinned module. Check argument order, dual/pipeable forms, return values and cancellation behavior; similarly named Tokio machinery is not semantic evidence.
3. **Record preparation before an implementation plan or feature edits**, as AGENTS.md requires. Add/update a proportional `docs/research/<module>.md` with checked versions/date, primary links, alternatives, chosen subset, assumptions, representation/lifetime costs, refusal behavior and validation criteria. Link it from progress and the docs index.
4. Keep stable decision IDs: status, choice, rationale, consequences and a concrete revisit trigger. Separate official-reference observations, actual native evidence and remaining assumptions. Accepted observable differences also belong in [native divergences](native-divergences.md).
5. Implement the smallest complete builder → checked IR → official reference → selected native lowering path. Mirror Effect v4 naming, argument order and data-first/data-last conventions. Witness arguments are an explicit representability boundary; avoid casts in authored user code.
6. Test meaningful semantics and rejection. Include a separately authored upstream workload when possible; success from the same IR interpreter alone can share the same mistake. Add type-level inference/refusal checks, not tests that just repeat node construction.
7. Verify composition with the likely neighboring module: cleanup/recovery, services/context, shared children, frames, cancellation and public host boundaries. Measure any new dependency, allocation, context/future size or code-growth consequence.
8. Review and publish the bounded slice. Update coverage, decisions, progress and open work with current facts. Close only the gates actually proved; keep remaining work linked to its owning record.

For parallel work, delegate independent primary-source research, isolated module helpers/tests and read-only reviews. Assign explicit file ownership. One integrator owns shared IR/compiler/lowering/exports and commits. Agents must coordinate before crossing that ownership or launching native builds; shared-tree edits become visible immediately.

## Run checks without competing native builds

Use the local toolchain and activate Rust if needed:

```bash
cd /workspace/reffect
. "$HOME/.cargo/env"
./node_modules/.bin/vp check
./node_modules/.bin/tsc --noEmit --strict --project packages/reffect/tsconfig.json
PATH="$PWD/node_modules/.bin:$PATH" vp run -r build
```

Run native suites **one at a time**, with one worker and reduced debug/incremental memory. Do not launch a second Cargo build from an agent while the integrator is running these:

```bash
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 ./node_modules/.bin/vp test packages/reffect/tests/deferred-execution.test.ts --maxWorkers=1
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 ./node_modules/.bin/vp test packages/reffect/tests/deferred-nested-conformance.test.ts --maxWorkers=1
```

Select tests for the change; do not cargo-run every family for a reversible helper edit. For Deferred boundary changes, useful suites are `deferred-execution`, `deferred-generated-profile`, `deferred-budget`, `deferred-integration-admission`, `deferred-pipeline`, `deferred-interruption-frames`, `deferred-generated-growth`, `deferred-native-layout`, `deferred-nested-conformance` and `helper-capture-costs`. Several contain real native matrices; read the test before choosing a selector. Keep debug/release and None/Bounded coverage when changing cancellation, root construction or layout admission. Public acceptance must additionally exercise imports and the ordinary public compiler stages.

After every commit, reread the committed diff and rerun the relevant checks, including explicit `vp check`. Fix review findings in `review(<scope>): ...` follow-up commits. Fetch remote again before publication, integrate any new work without dropping it, install if synchronization changes dependencies, and validate the merged result. Record actual suite counts/results and any blocked checks honestly in PROGRESS.md. Do not claim a cached build or metadata-only Cargo check as a native execution/layout result.

## Choose the next module by its missing theorem

1. **Preserve public bounded Deferred** while selecting the next workload: its owned reference policy, public admission/refusals and native layout enforcement are the baseline. Broader payloads, general nested topology, custom services and arbitrary callbacks need separate evidence.
2. **Widen bounded Semaphore scheduling or start Latch**, using [coordination decisions](research/coordination-modules.md) and the existing task ownership adapter. Semaphore proves atomic grant/cleanup registration and cancellation-safe permit return; Latch proves release pulses and detached waiter cohorts. Start with literal positive capacity and scoped one-permit use: interrupt one queued child and one granted child, verify occupancy never exceeds capacity and cleanup finishes before the permit is reused. Admit multi-permit requests only after mixed-size waiter-selection conformance. Tokio Semaphore's FIFO behavior differs from Effect's waiter scanning; a Boolean watch channel cannot represent Latch release pulses.
3. **Bounded Queue**, then PubSub, from [channel/stream research](research/channel-stream-modules.md). Prove full/empty suspension, cancellation-removable waiters and shutdown/termination before broadening strategies. The native Remote Live hub is a workload-specific adapter, not general public PubSub support.
4. **Finite Stream/Sink composition** over verified pull/channel state: demand, chunk boundaries, interruption/finalization and bounded memory. Existing RPC streaming support does not establish the entire Effect Stream module.
5. **Shared lifecycle**: SynchronizedRef, Cache/ScopedCache, Request/RequestResolver and Pool, guided by [configuration/cache research](research/config-cache-modules.md). Require overlapping-request sharing, cancellation-safe followers and exactly-once cleanup before selecting a substrate.

Pure helper gaps (Record.get/filterMap, richer Option/Result/collection helpers, selected scalar operations) can proceed independently when an actual authoring workload needs them. Check exports after syncing: another instance may already have implemented a listed gap. Config/Redacted is also a separate startup/secret-handling track. General fibers, transactional/durable systems and broad syntax widening retain their own gates rather than being implied by this sequence.

Leave the next agent a specific workload, current failing/refused boundary, owning files/decision IDs and a command that exercises it. This guide is the current route through the work; Git and PROGRESS.md retain its history.

## Minimal public Deferred example

```ts
import { Effect } from "effect";
import { Compile, DeferredExecution, R, Rust } from "reffect";

const work = R.fn([], R.U64, R.Never, () =>
  R.Deferred.make(R.U64).pipe(
    R.Effect.flatMap((cell) =>
      R.Deferred.succeed(cell, R.U64.literal(7n)).pipe(R.Effect.andThen(R.Deferred.await(cell))),
    ),
  ),
);
const observation = await DeferredExecution.run(work);
const artifact = await Effect.runPromise(
  Compile.make(R.program({ work })).pipe(Compile.withTarget(Rust.tokio), Compile.run),
);
// Build artifact with CargoApi before claiming native layout admission.
```

## Semaphore dispatcher continuation (2026-10-06)

`R.Semaphore` / `SemaphoreIR` now expose lexical `make`, `withPermit` and `withPermits`, with owned `SemaphoreExecution.run` and `runWithFrames`. Use `Compile.withTarget(Rust.tokio)` for standalone native exports. Read [SPUB-001–007](research/semaphore-public-admission.md) before extending admission; private prototypes and their default fixed ceilings are not public certificates.

The admitted profile is zero-input Bool/U64/Unit-success, Never-error, exactly one nonescaping root owner with capacity1..3, one permit per acquisition and at most one unnested All2/3. **Multiple Sleep-bearing All children require one uniform positive duration**, including masked finalizers and source branches. The [timer adapter](research/semaphore-timer-ordering.md) uses inline ticketed leases and frozen due waves before scheduled release scans. Single-child positive durations can vary; root sleep0 is a real yield, while zero inside All remains refused. RPC embedding, nested guarded acquisition, acquisition/group creation in finalizers, mixed coordinators within a function and general fibers remain refused. Independent ordinary/Deferred/Semaphore exports can share one generated module.

Owning files: `semaphore-generated-profile.ts` composes structure, trusted-expression audit, timer restriction, budgets and growth; `semaphore-budget.ts` supplies conservative default-context operation receipts; `semaphore-execution.ts` owns the fresh official scheduler/log capture/cancellation boundary. `lower.ts` specializes borrowed owners, scalar captures, semantic waits and actual returned-future layout assertions. `semaphore-all-runtime.ts` supplies started-sibling cleanup and live-scan routing, while `semaphore-task-runtime.ts` certifies generated Pending markers. Preserve Deferred's distinct completion protocol and the shared frame/builtin audit without widening Deferred admission.

Resume verification with `tests/semaphore-{public,generated,budget,execution,structure,conformance}.test.ts`; native public/generated/All/task/dispatch suites must run sequentially. Public tests exercise compiler→Cargo→NativeRunner with both frame policies; generated tests additionally probe host cancellation, root layout, scalar results and incremental quiet allocations in debug/release. The watch/context construction and logging costs are outside quiet allocation measurements. SourceArtifacts opt-outs and FailureFrames opt-outs are independent.

Next module workload: bounded Latch release cohorts, following [coordination decisions](research/coordination-modules.md). Preserve detached grants through close/reopen and prove independent canceled waiter removal before public admission. Semaphore mixed-duration timers and queued child yields remain separate scheduling gates. Uniform timer conformance is in `tests/semaphore-timer-{profile,ordering}.test.ts`, including fully-overdue barging, renewed reverse registration, cancellation at the final poll phase, stale ticket removal and masked cleanup. `semaphore-timer-runtime.ts` owns inline leases; one group wake timer is reset before Pending. All checks cancellation/settles before its final scan drain, so no scheduled scan crosses a timer suspension. Do not reuse Tokio Semaphore FIFO reservation or the rejected wake-all prototype.

```ts
import { Effect } from "effect";
import { Compile, R, Rust, SemaphoreExecution } from "reffect";

const work = R.fn([], R.U64, R.Never, () =>
  R.Semaphore.make(1).pipe(
    R.Effect.flatMap((owner) => R.Semaphore.withPermit(owner)(R.Effect.succeed(R.U64.literal(7n)))),
  ),
);
const observation = await SemaphoreExecution.run(work);
const artifact = await Effect.runPromise(
  Compile.make(R.program({ work })).pipe(Compile.withTarget(Rust.tokio), Compile.run),
);
// Build with CargoApi before claiming native layout admission.
```

## Latch cohort continuation — 2026-10-06

The next module now has a private foundation, recorded in [LAT-001–006](research/latch-cohorts.md). `latch.ts`/`latch-model.ts` construct opaque lexical IR; make is consumed directly by flatMap into LatchScope. LatchOperation groups Await/Open/Close/Release/IsOpen; whenOpen composes await then body. Both reference evaluators use official Effect4.0.0. isOpen is an effectful projection because compiled mutable state cannot become a build-time Boolean. The bounded public namespace and compiler admission are described in the continuation below; unsupported graphs remain refused.

`latch-cohort-runtime.ts` supplies the separately verified borrowed adapter. Await leases use monotonically increasing tickets and Waiting/Scheduled/Detached/Granted phases. Signal detaches current waiters logically; dispatch snapshots tickets before any callback, grants still-live tickets in registration order and polls a selected child through its semantic continuation. Drop removes only the matching ticket, so canceled slots may be reused without old callbacks granting new awaits. Close does not revoke grants. Reentrant release produces a later cohort; unlike Semaphore's live scans, it must never extend the current dispatch.

Resume with `tests/latch-{ir,cohort-runtime}.test.ts`. The native adapter suite compiles std-only Rust using rustc in debug/release and compares controlled traces with the official default scheduler. Source-tree IR tests include structured compiler refusal and fail-closed Deferred/Semaphore admission. These adapter-local tests do not establish public admission; continue with the checked generated path below.

The checked generated driver and public operation receipts/owned execution are described below. Keep manual/unsafe host APIs, dynamic tasks and RPC refused until separately admitted.

## Latch generated continuation — 2026-10-06

Bounded Latch is public through R.Latch, LatchIR, LatchExecution and Compile. Read [LPUB-001–004](research/latch-public-admission.md) and [LGEN-001–007](research/latch-generated.md) before widening it. lowerLatchFunctions remains a private source helper; generic lowerFunctions refuses unchecked Latch. Public Compile selects the checked helper after growth, trusted-identity and plain/framed operation-budget admission.

Files and responsibilities:

- `latch-generated-profile.ts`: exactly one lexical owner, zero inputs, scalar/Never channels, at most one All2/3, source expansion and trusted identity audit. Uniform positive competing timers only; root sleep0 is allowed, child sleep0 and cleanup Await are refused.
- `lower.ts`: borrowed owner/task/context generation, captures, interruption trails, returned-future layout checks and combined coordinator module growth. Independent exports may mix Deferred/Semaphore/Latch; a single function may not mix owners.
- `semaphore-task-runtime.ts`: shared ScanTask/ScanTasks and inline timer leases; emits only reachable coordinator methods. Preserve the default Semaphore output when changing this shared template.
- `latch-all-runtime.ts`: eager startup, poll-entry timer waves, detached cohort dispatch and cancellation settlement. Inline per-child cancellation flags route idle cancellation once. Parent interruption cancels all children immediately; independent child interruption finishes its own masked cleanup before fail-fast peer cancellation.
- `latch-cohort-runtime.ts`: ticketed Waiting/Scheduled/Detached/Granted leases. Do not replace detached snapshots with Semaphore scans or a Boolean watch latch.

Resume with `vp test packages/reffect/tests/latch-generated-profile.test.ts packages/reffect/tests/latch-lowering.test.ts --maxWorkers=1`. Then source Cargo's environment and run `latch-all-runtime.test.ts` and `latch-generated.test.ts` **one native process at a time**, using CARGO_PROFILE_DEV_DEBUG=0 and CARGO_INCREMENTAL=0. Redirect generated-suite output to a log if debugging Rust errors; full compiler stderr is large. Preserve the existing `latch-ir`/`latch-cohort-runtime` evidence and run Semaphore task/All/generated regressions after edits to shared runtime or lowering. Finish with `vp check`, strict reffect TypeScript and `vp run -r build`; recheck after committing.

`latch-budget.ts` sums audited evaluator costs, including all children and masked cleanup, with executed branch maxima and full incoming DAG edges. Both plain/framed bounds must be below 2048; automatic yielding is never disabled or assigned a larger threshold. `latch-execution.ts` owns default official context, captures logs, brand-checks optional AbortSignal and returns Exit or framed Exit. runWithFrames preserves interrupted Await/Scope/function trails after cleanup. Public compiler/API tests live in latch-public.test.ts; budget and execution suites are source-only and can run before native tests. Keep scalar metadata plain and context-owned.

Next prioritize bounded Queue lifecycle and cancel-safe waiter ownership using [communication decisions](research/channel-stream-modules.md), after reading the coordination ownership requirements. General Fiber ownership, typed Latch errors, mixed timer arbitration, child yields, cleanup waits and RPC embedding need separate workloads and decision records. Broader coordination/communication admission must retain below-threshold/default-context receipts or implement a separately proved yield adapter.

## Queue protocol continuation — 2026-10-06

The first communication slice is the private bounded protocol in `queue-bounded-runtime.ts`; read [QBF-001–007](research/queue-bounded-foundation.md) first. It emits std-only Rust with an inline ring and fixed combined registration bank. Positive capacities, Copy payloads, suspend policy, scalar offers/takes, end and shutdown are the research surface. Callback events identify task and monotonic ticket: Retry carries no payload, Offer carries successful Boolean admission, Terminal distinguishes Done/interruption. One serialized dispatcher must synchronously drive selected continuations.

Offer schedules a live taker pass; an immediate take may consume the value before that pass. Take mutates the ring, then admits and resumes pending producers before returning to the consumer. End retains pending offers; shutdown preserves a Closing terminal and settles takers before false producers. Explicit cancellation removes only matching live tickets; cancellation in Done cannot suppress mandatory shutdown completions. These semantics differ from Latch cohorts and Semaphore permits; reuse task ownership machinery only after proving Queue-specific routing.

Run `queue-bounded-runtime.test.ts` after sourcing Cargo's environment for rustc. It compiles the protocol in debug/release and compares controlled official Effect traces, with adapter-only edge/cost probes. No Cargo dependencies, Future/Drop integration, authoring namespace, compiler selection or owned Queue execution are claimed. The private safety treatment of [QBF-UPSTREAM-001](research/queue-bounded-foundation.md#upstream-reentrant-shutdown-defect--qbf-upstream-001) differs from a pinned upstream defect and must be refused or explicitly resolved before generated/public admission.

Next: typed lexical Queue IR and official reference execution with a distinct Done error witness, lifetime/escape/provenance checks and structured native refusals. Then prove generated bounded All2/3, cancellation/Drop routing, producer reentry ordering, default-scheduler receipts below 2048, failure frames, actual future/layout and allocation costs before owned/public admission. Do not widen public APIs merely because the local protocol passes. Broader strategies, rendezvous, batches, errors, PubSub, streams and RPC each need separate workloads.

## Queue lexical IR continuation — 2026-10-06

Read [QIR-001–006](research/queue-lexical-ir.md). Private source imports are QueueIR from queue.ts and QueueDoneType from queue-model.ts; there are no package/R exports yet. `QueueIR.make(A, { capacity, strategy?: "suspend" }, E = Never)` and `bounded(A, capacity, E = Never)` accept scalar payloads and capacity1..3. offer is dual; take preserves E; end requires explicit QueueDoneType; shutdown is Boolean/Never. QueueDoneType validates only Cause.Done with undefined value, independently of Unit.

queue-model.ts interns handle witnesses and keeps channel metadata in a compiler-owned WeakMap. queue-profile.ts detects Queue nodes through provenance children. effect-ir.ts consumes make via direct flatMap into QueueScope, checks owner channels/binders and delegates ordinary/framed execution to official Queue. QueueOperation carries payload only for Offer. Queue scopes/operations participate in substitution, async classification, frame trails and lifetime/task analysis. Kernel pure guards reject private markers without importing Queue's initialized witnesses. Compiler and every native entry refuse Queue before coordinator/scalar admission; all existing coordinator budgets/profiles remain fail-closed.

Resume with `vp test packages/reffect/tests/queue-ir.test.ts --maxWorkers=1`; source Cargo's environment and run queue-bounded-runtime.test.ts serially for the separate native protocol. Preserve Latch/Deferred/Semaphore checks when modifying shared visitors. Reference workloads cover scalar fresh owners, backpressure, end/Done, shutdown false/interruption, cancellation cleanup and queueOffer/queueTake/queueScope frames. Never-error All and simple Done recovery are admitted only for the official reference; changing Done after a fallible group or asynchronous cleanup remains refused. Registered cleanup cannot retain a Queue owner, while inline ensuring can borrow the enclosing lifetime.

Next implement the private generated driver: explicit producer callback continuation before consumer continuation, live retry scans, cancellation/Drop routing and pinned version reconciliation for the already-fixed upstream shutdown defect. Then prove operation receipts below default2048, both frame policies, actual future layouts, growth and allocations; add owned execution before public admission. The existing std-only adapter is useful evidence but does not itself establish native/generated support.

## Queue continuation bridge — 2026-10-06

Read [QCB-001–005](research/queue-continuation-bridge.md) before connecting Queue to generated helpers. Queue protocol calls must execute outside child future poll: post a request, release the pinned child borrow, execute the operation and synchronous peer callbacks, then publish the result. Processing protocol Pending must not flush scheduled takers; immediate offer's continuation has priority until a real wait/completion. Retry repeats take rather than reserving a payload.

The private queue-continuation-runtime.ts/test are a delivered bridge experiment, separate from checked lexical IR lowering. Six debug/release official traces and a delayed-producer negative mutation pass. Quiet1000-invocation construction/execution allocates0 times; Linux owner/bank/driver/producer/consumer layouts are120/136/72/168/152 bytes. Natural retry re-registration and new third-task live scanning are not proved by the two-slot fixture. Native fixtures run serially after sourcing Cargo's environment, in debug/release, against official Effect traces. Inspect active/done guards, request/ticket matching, short RefCell borrows and explicit driver cancellation. No arbitrary future Drop, host cancellation, failure frames, scheduler receipts, Send/multithread hosting or public admission follows from these fixtures.

Next integrate only through a checked Queue profile and the existing lowering pipeline. Prove operation/default2048 receipts, bounded drain and stack depth, interruption/finalizer settlement, both frame policies, generated root layout/growth/costs and owned execution. Keep public Queue refusals until that complete path passes. The fixed upstream shutdown defect still needs pinned-version reconciliation or topology refusal.

## Queue scoped driver ownership — 2026-10-07

Read [QOWN-001–005](research/queue-driver-ownership.md) before extending cancellation. QueueDriver owns both task IDs under an inline installation lease; overlapping drivers/bridges are refused. Explicit close requires no active continuation or held owner lock. Guard Drop marks both children inactive, closes the bridge and retires owner registrations without polling, allocating, normal cancel assertions or trusting published tickets. It preserves buffered values and terminal/lifecycle, except empty Closing becomes Done. Closed requests and replacement drivers are protected. This is a private exclusive-resource guard, not task finalization; caller-owned child futures may only be destroyed after closure.

Resume by running the three Queue suites serially after sourcing Cargo. Eight official traces, two negative mutations and local poison/active-panic/borrow/reuse/overlap fixtures pass. Quiet complete execution and pending scope cleanup allocate0; Linux owner/bank/driver/producer/consumer sizes120/144/72/168/152 bytes.

Next design per-request cancellation and parent interruption with awaited finalizer settlement, then integrate a checked Queue profile into lower.ts. Keep default-context operation receipts, scheduling/yield behavior, provenance/failure frames and generated root costs as admission gates. Guard Drop does not permit arbitrary select, foreign futures, reentrant root cancellation or multi-thread hosting. Public Queue remains refused.

## Queue interruption and synchronous cleanup — 2026-10-07

Read [QINT-001–005](research/queue-interruption-settlement.md). Private Rust offer_exit/take_exit use Interrupted control results, distinct from offer false and owner terminal outcomes. interrupt removes the waiting child's ticket before callbacks/cleanup, resumes its future and requires actual completion. interrupt_all visits slots sequentially; the first masked cleanup_shutdown may complete the second normally before its interruption turn. Legacy cancel/Drop do not run authored finalizers. Native scalars remain plain; sticky interruption belongs to the bridge.

Resume in queue-continuation-runtime.ts and its serial debug/release fixture. Ten official traces and four negative mutations pass; quiet complete/pending/interrupted workloads allocate0. New helpers do not establish full Cause/Exit or failure-frame agreement. Cancellable children branch directly from Interrupted into fixed synchronous cleanup and return; recovery, suspending/fallible/nested finalizers and host interruption stay refused.

Next connect awaited cleanup and parent cancellation to existing AsyncContext machinery, then add the checked lexical Queue profile/lowering, default2048 receipts, provenance/frame policy and actual generated root costs before owned/public admission. Keep Queue-specific inline producer callbacks and scheduled taker passes separate throughout.

## Queue asynchronous cleanup and host cancellation — 2026-10-07

Read [QASYNC-001–005](research/queue-async-settlement.md). `queue-continuation-runtime.ts` now passes the real host Waker through every poll/callback and distinguishes CleanupWaiting from Queue protocol Waiting. `begin_interrupt` initiates cleanup through its first suspension; synchronous `interrupt` still requires complete cleanup. A late interrupt of normal masked cleanup marks sticky interruption without replacing pinned Sleep.

`queue-host-runtime.ts` is the private current-thread adapter emitted beside `asyncRuntime(false,false)`. Its `cleanup_sleep` saves/restores the mask, and `run_hosted` monitors the existing watch receiver, visits children in order then awaits cleanup. True/disconnected preflight opens no child; cancellation between startup polls skips the unopened peer. False updates and masked root context do not trigger cancellation. Return bool reports root interruption, not full Cause/Exit. The two borrowed children remain non-Send; no spawn, boxes or new child channels.

Resume with the four Queue suites, native builds serial after sourcing Cargo. Hosted fixtures compare sleeping interruption, synchronous shutdown, late cancellation and callback-started sleep with official Effect4.0.0 in debug/release. Negative mutations remove the actual Waker and return before cleanup completes. Local probes cover preabort/disconnection, false updates, masking and saved-mask restoration on child destruction. Costs and final validation are recorded in QASYNC/PROGRESS.

Next connect the private lexical Queue IR to a checked generated profile/lowering. Prove operation receipts/default2048 scheduling, provenance/Cause/Exit frames and actual generated root growth/layout/costs before owned/public admission. General foreign futures, competing timers, fallible/nested cleanup, intra-dispatch root cancellation and hosted future Drop/select remain gated. Dropping the hosted future does not settle cleanup; destroying a child restores its mask, while driver Drop only retires registrations. Preserve the pinned upstream shutdown-defect refusal/reconciliation gate.

## Private checked Queue lowering — 2026-10-07

Read [QGEN-001–005](research/queue-generated.md). `queue-generated-profile.ts` selects one root Bool/U64/Unit/Never owner, capacity1..3 and one unconditional All2. Offer/take occur only inside Unit/Never children; existing scalar helpers, captures, pure implementations and SourceWriter are reused. `lowerQueueFunctions` is an internal entry point, not a package export/public Compile admission. Parents receive no task; children receive separate optional QueueTask handles and inherited AsyncContexts sharing the parent watch. Group-local bridge/driver and success receipts retain actual child interruption outcomes without new child channels. Runtime/control state belongs to invocation/group storage, never scalar payloads.

Resume in the profile, lower.ts Queue routes and source/native generated tests. Frame policy None remains the private default; explicit Bounded is now verified by [QFRAME](research/queue-generated-frames.md). Source artifacts Full/None are independent. Exactly one generated runtime/context is emitted across independent Queue/ordinary exports. Both emitted-byte and actual returned-future limits apply, separate from full-edge source growth. Differential debug/release evidence covers pressure/capacity/payload/capture/Boolean/Unit agreement, blocked interruption and a lost-continuation negative mutation; layouts/costs are recorded in QGEN/PROGRESS.

Next add checked reference-operation receipts under default2048 and final Cause/Exit/provenance frame/owned execution evidence before public admission. End/shutdown/Done, All fail-fast terminal routing, generated async finalizer markers/masking, broader timers/tasks, parent Queue operations, RPC/Send and hosted-future abandonment remain refused. QASYNC's handwritten sleeping-cleanup evidence must not be mistaken for generated Ensuring/Sleep support.

## Queue default-scheduler receipts — 2026-10-07

Read [QBUD-001–004](research/queue-budget.md) and resume in `queue-budget.ts`, its scheduler-probe tests and `queue-generated-profile.ts`. Private selection now requires a conditional whole-invocation bound below2048 in both reference modes, independently of source/text/module/emitted Rust/native layout bounds. Shared incoming edges contribute full summaries; Match alternatives use independent maxima; each Take's retry allowance is bounded by all finite offer occurrences. Framed All children retain framed decorations but omit root interruption observers.

No scalar metadata or generated runtime fields are added. Receipts assume zero inputs, default scheduler/clock/tracer, absent effectful hooks and bounded outer host observation. They do not enforce an arbitrary Effect host's context. Next establish owned reference execution and generated interruption-frame/Cause/Exit evidence before public Queue admission. End/shutdown/Done fail-fast, generated Ensuring/Sleep markers and mask restoration, broader ownership, RPC/Send and host-future abandonment remain separate gates.

## Queue owned reference execution — 2026-10-07

Read [QEXEC-001–004](research/queue-execution.md). Internal `QueueExecution.run`/`runWithFrames` in queue-execution.ts apply private profile/trusted expression/growth/QBUD checks before eager evaluation and own the default2048 scheduler/context/captured logger. Options accept only a same-realm brand-checked signal; intrinsic getter/listener operations forward cancellation to a fresh owned controller and retire the forwarding listener after settlement. Preabort produces an interrupted outer Exit with no logs or opened trail. Native/public Queue remains refused.

Resume in queue-execution.test.ts and queue-generated.test.ts. The generated debug/release differential now executes its reference through this boundary, while execution tests independently compare with raw official Effect. Framed cancellation retains All/QueueScope/function parents after child unregistering, with no child Queue wait trails. Frames/logs/signal controllers belong to each invocation and do not travel with scalar payloads.

Next establish generated interruption frames/Cause/Exit parity before public standalone Queue admission. Keep End/shutdown/Done, generated Ensuring/Sleep, fail-fast, broader ownership, RPC/Send and host-future abandonment separate. The [shared cancellation repair](research/owned-execution-cancellation.md) now closes the Deferred/Semaphore/Latch external-signal override gap; all four runners use the internal relay.

## Shared owned cancellation repair — 2026-10-07

Read [OCAN-001–004](research/owned-execution-cancellation.md). `owned-execution-signal.ts` owns native-signal option validation and relay lifetime; each runner supplies its diagnostic constructor, unopened preabort observation and typed start callback. Semantic identity/growth/budget/profile checks remain before listener installation, and context/log/frame interpretation remain local to Deferred/Semaphore/Latch/Queue. Only a fresh owned signal enters the official Effect runner. Native values, generated Rust and public APIs are unchanged.

Resume with owned-cancellation.test.ts, owned-execution-signal.test.ts and the four existing execution suites. The lying-aborted reproducer failed all three old public runners. Current plain/framed cases exclude property hooks and await actual masked cleanup; direct helper probes verify fulfillment, rejection, synchronous start errors, no-signal behavior and unrelated-listener preservation. Queue generated debug/release differential retains previous costs/layouts and negative continuation evidence.

Next implement generated Queue interruption frames/Cause/Exit, then review public standalone admission. Do not bypass default2048 receipts or extend End/shutdown/Done, async finalizer markers, broader ownership, RPC/Send or hosted-future abandonment merely because cancellation mechanics are now shared.

## Generated Queue interruption frames — 2026-10-07

Read [QFRAME-001–004](research/queue-generated-frames.md). Internal lowerQueueFunctions accepts explicit FailureFrames.Bounded using the existing helper error capsule and invocation-local AsyncContext stash. QueueScope appends its boundary; Queue waits construct interrupted child capsules, discarded when recording child success. The driver settles both children before All starts its parent trail. Public Result and the None default remain unchanged; no metadata is added to scalar values or Queue protocol state.

Resume in queue-generated-frames.test.ts, queue-lowering.test.ts and the Queue routes in lower.ts. Exact authored trails agree with the owned official interpreter for blocked offer/take, shared children, Map/FlatMap parents and a 35-wrapper truncation witness (32 retained, six omitted). Native debug/release tests verify observation consumption, stale-trail reset, direct-native preabort, success and policy-specific costs. Corrupting All's frame kind fails. None remains stripped; bounded diagnostics allocate only on interruption in the quiet fixture, including discarded child capsules. QFRAME records measured future layouts and cost exclusions.

Next review public standalone Queue admission end to end, including API/export/check/derive/plan routes, profile limits and refusal diagnostics. Keep End/shutdown/Done, retained outcome/fail-fast, generated Ensuring/Sleep markers/masking, parent Queue operations, wider ownership/timers/tasks, RPC/Send and host-future abandonment separate. The pinned upstream shutdown defect does not affect this offer/take-only profile; do not extend shutdown admission implicitly.

## Bounded public Queue — 2026-10-07

Read [QPUB-001–005](research/queue-public-admission.md). `queue.ts` retains the richer internal QueueIR and exports a frozen make/bounded/offer/take facade as `R.Queue` and package `QueueIR`. `QueueExecution` is public. Compiler check caches successful immutable Program profiles; derive reports owner payload/error witnesses, including idle owners; plan rederives rather than trusting supplied analysis. Hidden Queue/Done signatures remain refused. Public Compile selects `lowerQueueFunctions`, which now preserves independent coordinator profiles and runtime-service selection. NativeRpc rejects Queue before request-host selection.

Resume in `queue-public.test.ts`, `queue-generated-profile.ts`, compiler.ts and Queue routes in lower.ts. Public contracts cover inference, capabilities, policies, malformed hidden expressions, forged plans and budget/growth/refusal diagnostics. Actual public native artifacts exercise all scalar payloads, capacity1..3, independent coordinator exports and injected Clock/Random under both frame policies. Keep native builds serial after sourcing Cargo; retain queue-generated and queue-generated-frames debug/release conformance, mutation and allocation/layout checks. These gates are separate from owned reference execution; ambient custom Effect contexts are not admitted by the runner.

Next research End/shutdown/Done retained outcomes and failure/cancellation ordering before extending public APIs. Reconcile pinned shutdown source with the fixed upstream implementation. Prove generated cleanup/masking and actual costs before admitting Ensuring/Sleep or resource scopes. Wider owners, mixed coordinators, RPC/Send, other strategies and hosted-future abandonment remain separate gates. Record decisions before implementation; the core instance owns PLAN.md.

## Queue terminal control foundation — 2026-10-07

Read [QTERM-001–005](research/queue-terminal-control.md). `queue-continuation-runtime.ts` now offers private cancellation-aware `end_exit`/`shutdown_exit` alongside offer_exit/take_exit. They return the existing bool/control-interruption Result and use the same posted request protocol. Done/owner interruption remain QueueTake terminal categories, distinct from requesting-child cancellation. Only explicit cleanup_shutdown bypasses sticky interruption. No public/profile/compiler/RPC support is widened, and no runtime fields are added.

Resume in `queue-terminal-control.test.ts`. Its official Effect traces cover an empty waiting consumer completed inside End, registered producer drain, Closing shutdown retaining Done, Open shutdown returning interruption, and repeated terminal operations. Local actual-driver interruption probes refuse subsequent ordinary End/shutdown without posting or changing the owner, then distinguish masked cleanup. Debug/release tests measure fixed-log quiet allocations and actual child future layouts; mutations change control interruption to false, overwrite Closing Done and delay terminal peer settlement. Keep native builds serial and retain bounded/continuation/host/generated/frame/public Queue regressions. Cost receipts describe these raw borrowed-driver fixtures, not generated terminal roots or full Cause identity.

The dedicated native unit Done carrier and raw local recovery are delivered below; generated local recovery is the current gate. Then prove retained outcomes/fail-fast across All, terminal-specific frames/default2048 receipts and generated cleanup/masking before public End/shutdown/Done admission. Reentrant shutdown remains unsafe in the pinned oracle topology identified by QBF-UPSTREAM-001; upstream fixed it, so do not file another issue or silently upgrade the dependency. Hosted-future abandonment, RPC/Send and wider strategies remain separate. The core instance owns PLAN.md.

## Queue typed Done recovery foundation — 2026-10-07

[QDONE-001–005](research/queue-done-recovery.md) delivers private raw-driver unit Done recovery. `QueueDone` is a distinct zero-sized Rust type; `QueueTakeFailure` distinguishes Done, owner interruption and child control interruption. `take_done_exit` preserves plain scalar success, and generic `queue_catch_done` recovers only Done with a statically stored handler future. Recovery can issue another Queue operation and its own failure remains failure. Official Effect.catch conformance, cancellation probes, negative mutations, compile-fail and debug/release allocation/layout measurements cover that bounded contract. This is not general Pull.catchDone or combined-Cause recovery.

**Checked private generated local Done is now delivered**, before public completion. Read the QDONE record and `queue-generated-profile.ts`, `queue-budget.ts`, `deferred-growth.ts`, `lower.ts` and the compiler's Queue marker audits. CatchAll/End/shutdown budget receipts and Queue-only full-edge recovery growth are now delivered ([QDONE-006–008](research/queue-done-recovery.md#generated-recovery-safeguards--preparation-2026-10-07)). The End-only selector requires Done recovery inside each child so it cannot escape All/root; the native mapping and handled-frame reset have differential/cost evidence. Preserve default2048, both frame policies, current public end-free admission and independent coordinator/service exports. Measure actual emitted artifacts and returned-root futures; raw helper sizes do not substitute for those checks.

QueueDoneType's marker remains private: only the checked internal End profile maps canonical helper error channels to QueueDone. Do not blanket-bypass marker guards, route Done through interruption, or expose End/shutdown on the strength of this fixture. Retained/fail-fast group outcomes, generated cleanup/masking and pinned reentrant-shutdown reconciliation remain later gates.

## Private generated Queue End/local Done — 2026-10-07

Read [QDONE-009–012](research/queue-done-recovery.md#private-generated-endlocal-recovery--preparation-2026-10-07). Import `analyzeGeneratedQueueDoneProfile` from `queue-generated-profile.ts` and `lowerQueueDoneFunctions` from `lower.ts` for this private work; neither is used by public Compile/QueueExecution. One root scalar Done owner, zero authored inputs, one unconditional All2 UnitNever group and local typed recovery are admitted. Handler expressions may not consume Done; End/Offer/Take and scalar composition are supported, while Shutdown, timers/finalizers, richer owners/topology and error escape are refused.

`queue-generated-done.test.ts` is the differential/native fixture. It covers synchronous End recovery ordering, buffered/scalar success bypass, nested re-take, closed Offer/repeated End, caught-source cancellation, hidden-marker/private-selection refusal and Full/None artifacts × None/Bounded frames × debug/release. A mixed ordinary fallible export exercises Combined exhaustiveness; Deferred and Never Queue exports exercise independent coordinator composition. Bounded handled errors allocate one temporary trail in quiet recovery; allocation release is measured and mutations erase Done or leak the handled trail. Read actual root-layout measurements in the record rather than substituting raw helper sizes.

Frame planning now indexes scope/node/error witness to mirror native specialization; CatchAll source uses its own error channel and handler uses fresh lexical scope. Current Done recovery cannot suspend on this same terminal owner. Next prove retained outcomes/fail-fast across All and generated cleanup/masking, reconcile safe Shutdown topology against pinned/upstream semantics, and revisit public completion admission. Keep public end-free receipts and marker guards intact. PLAN.md remains owned by the core instance.
