# Bounded Latch admission and owned execution

Prepared 2026-10-06 against Effect **4.0.0**, following [generated Latch evidence](latch-generated.md), [Semaphore admission](semaphore-public-admission.md) and [Deferred operation receipts](deferred-budget.md). Published [internal/effect.ts](https://unpkg.com/effect@4.0.0/src/internal/effect.ts) was fetched again and byte-compared with installed source. The Latch scheduler detaches the scheduled waiter array before synchronous callback continuations; each resumed evaluator starts a new operation counter. Default automatic yielding begins at 2048 operations.

## Decisions

- **LPUB-001:** retain the existing checked lexical/scalar/Never, zero-input, unnested All2/3, uniform positive competing timers profile. Public exposure requires a separate conservative whole-invocation operation sum strictly below 2048 for both plain and framed evaluation. Source-growth and runtime driver bounds remain independent gates. Mixed owners, Race, typed errors, RPC, delayed finalizers and cleanup Await stay refused.
- **LPUB-002:** reuse audited ordinary evaluator receipts and observer policies from Deferred/Semaphore. Latch owner construction and state transitions need their own upstream receipts; await includes registration, asynchronous resumption and cancellation cleanup. Independent source audit approves Scope4/6, Await11/11 and transitions3/3, with entry24 and observer20 where observed. Each Await registers once and resumes at most once; its returned exit and recursive continuation are already counted, so no Semaphore-style retry allowance is needed. Detached cohort iteration itself is synchronous JavaScript. All sums every child, ordinary Match uses the executed branch maximum, and each incoming DAG edge contributes its full weight. Do not raise MaxOpsBeforeYield or disable yielding to make a graph compile.

  Await's conservative eleven-operation allowance covers outer Suspend, callback/terminal result, unregister Sync/Success, AsyncFinalizer, failure combination and interruption/restoration. Success and cancellation paths are deliberately over-counted together. Framed LatchOperation has no additional mapFramedError decoration; the separate observer allowance covers retained interruption paths.

- **LPUB-003:** add owned LatchExecution run/runWithFrames using the established owned execution API: default MixedScheduler, threshold 2048, default clock/tracer, captured logger, no custom hooks or surrounding source effects, and only a brand-checked optional AbortSignal. Validate options and checked profile before any authored logs; pre-aborted calls remain unopened. Keep interruption trails context-owned and scalar values plain.
- **LPUB-004:** expose R.Latch and LatchIR/LatchExecution only after compiler selection, capability reporting, actual returned-future layouts and native/reference conformance pass. Direct generic lowering must continue to refuse unchecked Latch. Keep RPC refusal explicit. Decisions and remaining limits belong here and in the resume guide, not the core plan owned by the other instance.

## Validation

Budget tests must exercise executed branch maxima, shared DAG incoming edges, strict threshold refusal, unknown context, observer modes and constructor/builtin auditing. Owned execution tests cover success/logs, cancellation with awaited masked cleanup, frames, invalid/getter options, forged AbortSignal and pre-aborted/no-log behavior. Public compiler tests must build generated Rust with both frame policies, include independent coordinator exports, reject unsupported shapes/contexts/hosts, and preserve existing cohort/timer/cost conformance. Run native builds serially and retain Deferred/Semaphore regressions when changing shared code.

## Delivered boundary

Public R.Latch/LatchIR builders, LatchExecution run/runWithFrames and Compile use the bounded profile. Scalar-only Latch roots also require AsyncResult/Tokio because cancellation context remains part of execution. Direct generic lowering, manual plans and RPC cannot bypass admission. Profile-specific diagnostics (including reference identity, growth and budget errors) remain specific; execution-option errors use LATCH_EXECUTION_CONTEXT. No diagnostic remapping hides a refused graph.

Six budget tests include below-threshold/no-yield probes, executed branch/shared-edge accounting, cancellation cleanup and actual default automatic yields on a long graph in both reference modes. Nine owned execution tests cover immutable observations, ambient-context isolation, preflight options/signals and interrupted Await/Scope/function trails after cleanup. Public compiler tests exercise both frame policies with independent ordinary/Deferred/Semaphore/Latch exports. Generated debug/release tests retain detached cohorts, timer waves, cleanup, frames, actual future layout and zero disabled-frame interruption allocation gates.

The already recorded generated costs/layouts remain mandatory conformance tests; public exposure adds no scalar fields or generated runtime machinery. Broader scheduling, typed failures, resource ownership and request hosting remain separate admission work. Resume in [the workstream guide](../effect-v4-workstream.md#latch-generated-continuation--2026-10-06).

## Validation receipts

Fourteen selected suites pass 102 tests; native builds ran serially. Final generated debug/release rerun uses MaxOpsBeforeYield 2048 and compares exact interruption frame paths as well as kinds. Construction/scalar allocations remain 0, quiet All2 costs 2 and blocked root interruption costs 0/1 under None/Bounded, matching [generated measurements](latch-generated.md). Full vp check and strict TypeScript pass; workspace build rebuilt reffect and cached three other tasks. Independent compiler-admission review found no remaining blocker.

```sh
vp test packages/reffect/tests/latch-budget.test.ts packages/reffect/tests/latch-execution.test.ts packages/reffect/tests/latch-generated-profile.test.ts packages/reffect/tests/latch-lowering.test.ts packages/reffect/tests/latch-ir.test.ts packages/reffect/tests/semaphore-execution.test.ts packages/reffect/tests/semaphore-structure.test.ts packages/reffect/tests/semaphore-timer-profile.test.ts packages/reffect/tests/deferred-budget.test.ts packages/reffect/tests/deferred-generated-profile.test.ts --maxWorkers=1

. "$HOME/.cargo/env"
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 vp test packages/reffect/tests/latch-public.test.ts --maxWorkers=1
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 vp test packages/reffect/tests/latch-generated.test.ts packages/reffect/tests/semaphore-public.test.ts packages/reffect/tests/deferred-public.test.ts --maxWorkers=1

vp check
tsc --noEmit --strict --project packages/reffect/tsconfig.json
vp run -r build
```
