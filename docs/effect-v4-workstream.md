# Resuming the Effect v4 implementation work

This is the handoff for the parallel module work: extend the statically representable Effect v4 API through checked IR, official Effect interpretation and native Rust conformance. The core roadmap, Remote/SQL and SSR are also advancing in this shared checkout. Coordinate shared compiler edits with their owner; this workstream does not replace [PLAN.md](../PLAN.md).

Updated 2026-10-06. The installed oracle is **Effect 4.0.0**; current Deferred native evidence uses **Rust 1.98.1 / Tokio 1.53.1**. Earlier research used Effect rc.118. Check the installed version and current source before extending an old decision.

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

The next module now has a private foundation, recorded in [LAT-001–006](research/latch-cohorts.md). `latch.ts`/`latch-model.ts` construct opaque lexical IR; make is consumed directly by flatMap into LatchScope. LatchOperation groups Await/Open/Close/Release/IsOpen; whenOpen composes await then body. Both reference evaluators use official Effect4.0.0. isOpen is an effectful projection because compiled mutable state cannot become a build-time Boolean. The namespace is private, and Compile returns LATCH_NATIVE_UNSUPPORTED before native lowering.

`latch-cohort-runtime.ts` supplies the separately verified borrowed adapter. Await leases use monotonically increasing tickets and Waiting/Scheduled/Detached/Granted phases. Signal detaches current waiters logically; dispatch snapshots tickets before any callback, grants still-live tickets in registration order and polls a selected child through its semantic continuation. Drop removes only the matching ticket, so canceled slots may be reused without old callbacks granting new awaits. Close does not revoke grants. Reentrant release produces a later cohort; unlike Semaphore's live scans, it must never extend the current dispatch.

Resume with `tests/latch-{ir,cohort-runtime}.test.ts`. The native adapter suite compiles std-only Rust using rustc in debug/release and compares controlled traces with the official default scheduler. Source-tree IR tests include structured compiler refusal and fail-closed Deferred/Semaphore admission. Do not export R.Latch or select the adapter merely because these pass.

Next implement the checked generated borrowed All driver: coordinator owner counts and task slots, exact pulse/cohort dispatch phase versus timer waves and queued yields, parent cancellation and awaited masked cleanup, reference operation receipts, finite scheduling/growth limits, and generated-root layout/allocation gates. Follow Semaphore's task/context ownership without copying its live-scan arbitration. Keep manual/unsafe host APIs, dynamic tasks and RPC refused until separately admitted.
