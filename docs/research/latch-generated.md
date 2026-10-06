# Private generated Latch execution

Preparation 2026-10-06: reread [LAT-001–006](latch-cohorts.md), [Semaphore admission](semaphore-public-admission.md), [uniform timer waves](semaphore-timer-ordering.md), the existing borrowed task/All/lowering code and current module roadmap. Re-fetched Effect **4.0.0** [internal/effect.ts](https://unpkg.com/effect@4.0.0/src/internal/effect.ts); it is byte-identical to installed source. `scheduleUnsafe` moves current waiters into a scheduled array; `flushScheduled` detaches that array before synchronous callback resumes. This phase is distinct from Semaphore's live release scans.

## Decisions before implementation

- **LGEN-001 — Complete private generated slice before public admission.** Add private `lowerLatchFunctions` selection through a checked profile, preserving Compile's public LATCH_NATIVE_UNSUPPORTED refusal. Admit zero-input Bool/U64/Unit-success, Never-error roots, exactly one root lexical Latch and at most one unnested All2/3. No escaped handles, additional/mixed owners, dynamic tasks, Race, RPC, registered finalizers or general resource Scope. `whenOpen` keeps its composed await-then-body semantics. Typed failures remain outside this first native profile.
- **LGEN-002 — Reuse task/context machinery without unused coordinators.** Share the existing semantic Pending markers, inline positive timer leases, borrowed pinned futures and per-child watch cancellation. Emit acquisition methods and coordinator state only for reachable Semaphore/Latch profiles; independent exports may coexist. Latch All has its own named driver and detached cohort arbitration. Do not duplicate AsyncContext, metadata storage or cancellation semantics.
- **LGEN-003 — Bound source expansion and driver work separately.** Source preflight counts full incoming DAG edges, detects cycles and limits depths/counts before recursive auditing. Derive task slots, signal/cohort/callback/timer ceilings from finite source occurrences. Every Await Pending is semantic; no unexplained protocol polling retries. Reuse trusted builtin identity auditing and generated text/module/Rust-byte/layout gates. Public reference-operation receipts and owned execution context remain a separate admission obligation, not inferred from structural counts.
- **LGEN-004 — Uniform positive timers; no concurrent yields.** Preserve the verified positive-duration timer bank policy: competing Sleep-bearing children must use one uniform positive integer duration, including branches/finalizers. Reject child sleep0; sequential root sleep0 uses the cancellation-aware yield path. Timer waves are captured at poll entry, granted FIFO before scheduled Latch cohorts. Newly registered timers await a later wave. Mixed durations and queued yields require their own proof.
- **LGEN-005 — Cancellation settles before cohort draining.** Eagerly start children in source order, run each selected continuation to semantic suspension/completion, and settle started-child cancellation with awaited masked cleanup. Snapshot/grant detached cohorts through the owner adapter; never extend the current snapshot with callback-created waits/pulses. Final parent checking/settlement precedes final draining, so no scheduled cohort crosses Pending accidentally. Cleanup may signal/close, but cleanup awaiting a Latch and groups inside cleanup are initially refused; literal positive Sleep cleanup remains testable.
- **LGEN-006 — Public exposure requires additional evidence.** Keep builder/runtime private until reference evaluator operation receipts, owned-context/frame behavior, public compiler/host refusals, actual root layouts and construction/wakeup/cancellation allocation costs pass. Adapter-local zero allocation does not establish generated invocation cost. Scalars stay plain; owner/driver state is invocation-local, not attached to scalar metadata.

## Validation workload

Compiler/private lowering → emitted Rust → debug/release executables must agree with official Effect on release/open/close Booleans, late waits, coalesced pulses, registration order, close-before-dispatch, callback-created cohorts and scalar captures. Test parent cancellation while blocked, cleanup signals, asynchronous masked cleanup and final root frames under None/Bounded policies. Controlled native harnesses test independent child cancellation, stale tickets and timer/cohort phase boundaries. Mixed ordinary/Deferred/Semaphore/Latch exports must compile without duplicate runtime declarations; unsupported graphs must refuse before logs execute. Retain provenance, growth and actual returned-future layout checks.

## Delivered private path

`latch-generated-profile.ts` checks ownership, full-edge source growth, trusted scalar builtin identities and the narrow timer/group shape before lowering. `lowerLatchFunctions` emits the invocation-local owner, captured scalar operands, shared task/context runtime and distinct `latch-all-runtime.ts` driver. Independent Deferred/Semaphore/Latch exports share one runtime; combined coordinator growth is bounded across the module. Public `Compile`, public `lowerFunctions` and package exports still refuse/omit Latch.

- **LGEN-007 — Observe individual cancellation without general Fiber semantics.** Independent review found that a raw child watch could wake an idle All driver without a timer, parent signal or scheduled cohort to select the child. Inline per-child `cancellation_seen` flags now request settlement exactly once for each new child cancellation. An interrupted child's masked cleanup finishes before its terminal result triggers All fail-fast cancellation of peers. Parent cancellation interrupts all started children immediately. This is a borrowed All protocol proof, not admission of independently managed public fibers.

The generated tests compare scalar transitions, renewed/coalesced pulses, captures, delayed timer waves, parent interruption, asynchronous masked cleanup and final frames against official Effect. Native harnesses additionally force idle independent child cancellation and overdue timer/cohort arbitration. Both None/Bounded policies compile in debug/release; mixed coordinator exports compile together. Construction/scalar invocation measurements exclude creation of the parent AsyncContext, include child watch construction where reachable, and exclude logging. Allocation observations are workload-specific, not an all-program allocation bound.

On the tested 64-bit target, debug/release layouts and allocation counts agree:

| Failure-frame policy | Scalar / All2 / async-cleanup future bytes | Construct 1,000 futures | Run 1,000 scalar calls | Run 1,000 quiet All2 pulses | One blocked root interruption |
| -------------------- | ------------------------------------------ | ----------------------- | ---------------------- | --------------------------- | ----------------------------- |
| None                 | 864 / 1,712 / 3,080                        | 0                       | 0                      | 2,000                       | 0                             |
| Bounded              | 880 / 1,728 / 3,128                        | 0                       | 0                      | 2,000                       | 1                             |

All2's two allocations are child cancellation state; bounded interruption capture adds one failure-only frame allocation. Inline cancellation flags fit existing layout padding in these workloads. These observations exclude retained/peak heap and timer-specific allocation accounting; keep those separate from a zero-allocation claim.

## Validation receipts

Selected source/reference checks: 8 suites, 65 tests; shared native regressions: 6 suites, 21 tests; Latch All driver: 2 tests; generated roots: 3 tests, each frame policy compiling debug/release. Native suites ran serially. Full `vp check` and strict TypeScript pass. Workspace build passes: reffect rebuilt, other three workspace tasks cached. Independent runtime review found no remaining blocker in this private slice after LGEN-007.

```sh
vp test packages/reffect/tests/latch-generated-profile.test.ts packages/reffect/tests/latch-lowering.test.ts packages/reffect/tests/latch-ir.test.ts packages/reffect/tests/semaphore-structure.test.ts packages/reffect/tests/semaphore-timer-profile.test.ts packages/reffect/tests/deferred-generated-profile.test.ts packages/reffect/tests/deferred-budget.test.ts packages/reffect/tests/semaphore-execution.test.ts --maxWorkers=1

. "$HOME/.cargo/env"
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 vp test packages/reffect/tests/latch-all-runtime.test.ts --maxWorkers=1
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 vp test packages/reffect/tests/latch-generated.test.ts --maxWorkers=1
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 vp test packages/reffect/tests/semaphore-task-runtime.test.ts packages/reffect/tests/semaphore-all-runtime.test.ts packages/reffect/tests/semaphore-generated.test.ts packages/reffect/tests/semaphore-public.test.ts packages/reffect/tests/semaphore-timer-ordering.test.ts packages/reffect/tests/deferred-public.test.ts --maxWorkers=1

vp check
tsc --noEmit --strict --project packages/reffect/tsconfig.json
vp run -r build
```

## Resume / remaining public gate

Start with [the workstream handoff](../effect-v4-workstream.md#latch-generated-continuation--2026-10-06). Run source-only profile/lowering tests before native tests, and keep Cargo builds serial. Public admission requires reference evaluator operation-budget receipts (including automatic scheduler yields), an owned `LatchExecution` default-context boundary, matching public compiler/host refusals and retained layout/frame/cost checks. Structural occurrence/driver ceilings do **not** prove scheduling parity for every admitted private graph: automatic yields are not yet certified. Mixed timers, child sleep0, cleanup Await, typed failures, RPC and escaping/shared owners stay outside this slice.
