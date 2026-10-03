# Clock and Random conformance workload

Preparation record, 2026-10-03. This file defines the test obligations for the bounded Clock/Random slice; implementation and measurement results are appended after validation. Core API/runtime decisions live in the module's implementation record.

Primary sources inspected online before authoring fixtures: Effect **4.0.0** [Clock](https://unpkg.com/effect@4.0.0/src/Clock.ts), [Random](https://unpkg.com/effect@4.0.0/src/Random.ts), and [internal Effect/Clock](https://unpkg.com/effect@4.0.0/src/internal/effect.ts). Installed package version agrees with this stable pin.

## Semantic observations

`Clock.currentTimeMillis` delegates to the provided Clock's effectful `currentTimeMillis` property. The default property calls its unsafe wall-clock reader, but a fake Clock may define separate methods. Runtime logging, timeouts and caching also use unsafe Clock methods: these observer reads must not consume an authored timestamp script. Wall time may move backward; no monotonicity guarantee applies. Clock's sleep method belongs to the same official service but a scripted wall-clock reader does not establish virtual timers.

`Random.next` calls the supplied Random service's `nextDoubleUnsafe`. `Random.nextBoolean` consumes one draw from that same method and uses **`draw > 0.5`**. Equality to 0.5 yields false. No second Boolean stream or independent Boolean draw generator is equivalent. This bounded slice admits these two operations only; it does not claim seeded PRNG parity, integer generation or cryptographic suitability.

## Fixture decisions before tests

- **RTCONF-001 — Independent official oracle.** Construct a concrete official `Clock.Clock` and `Random.Random` implementation for each invocation. Scripted effectful milliseconds consume authored timestamps; unsafe milliseconds/nanos, monotonic reads and sleep delegate to a captured live Clock. Use official `Effect.provideService`, so logging or scheduler observations cannot advance the authored cursor. Compare authored programs with official Clock/Random operations, not a second arithmetic evaluator.
- **RTCONF-002 — One draw stream with exact consumption.** Exercise boundary draws 0, 0.5, adjacent doubles around 0.5 and the largest double below 1. Branches consume only selected draws; repeat/retry/recovery consume in execution order. Compare consumption by exhausting the exact-length script and separately testing a one-element-short script; a final-value equality alone does not prove consumption.
- **RTCONF-003 — Invocation owns scripts and defects.** Fresh script state for each reference invocation and native context. Interleave suspended contexts with distinct scripts. Invalid/exhausted scripted reads must fail outside typed catch/retry/result capture: official reference uses Effect defects; native trusted-host validation/read faults panic. This slice does not claim Cause/defect payload or finalizer equivalence on those faults. Include cleanup evidence on interrupted execution, without requiring an unsupported general Cause/defect payload representation.
- **RTCONF-004 — Isolate measurement phases.** Allocate script buffers and cancellation/runtime setup before counting context construction and unpolled future construction. Count pure scripted reads separately from async polling/timers/logging. Measure enabled/disabled service context and both frame policies without claiming existing infrastructure allocations are introduced by these operations. Keep live-clock smoke assertions broad: finite representable milliseconds, not exact host synchronization or monotonic elapsed time.

## Required workload

The complete path is ordered authored Clock/Random reads through Boolean branches, sequential repetition, retry of typed failure and recovery, with a real unchanged Sleep between reads. A selected script should produce the same scalar outputs and operation order under official Effect, reffect's plain/framed reference, native debug and release, and both failure-frame policies. A canceled sleep must await cleanup and skip all later authored reads. Two contexts must remain isolated while their futures are interleaved.

Native direct probes may inspect context cursor/layout/allocations according to the generated host API. They must not infer a native value metadata wrapper from test instrumentation or require a new dependency. Scripted wall time is a test provider, not timer virtualization. Public native hosts remain responsible for installing any explicitly supported script/provider configuration. Compile configuration selects driver modes only; scripts are trusted-host context setters, not browser request fields or implicit CLI/RPC injection. An injected Clock context defaults to live reads until overridden; an unconfigured Random context faults and never falls back to nondeterministic draws.

## Validation results

Focused command (Rust environment loaded):

```sh
env REFFECT_RUNTIME_SERVICES_MEASUREMENTS=/tmp/reffect-clock-random-layouts.log \
  CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 \
  vp test packages/reffect/tests/clock-random.test.ts --maxWorkers=1
```

**7/7 tests pass**, 53.86 seconds total / 51.20 seconds tests. Fresh generated crates cover enabled drivers in debug/release under FailureFrames.None and Bounded, disabled-service baselines in release under both policies, and a std-only live Clock release executable. The reference tests cover official/service-injected plain and framed execution. Strict package TypeScript and targeted fixture lint pass.

No additional Cargo dependency is selected by either driver. The async workload selects existing `tokio@1.53.1`; live Clock alone selects no crates or SyncContext. Missing Random selection reports `MISSING_RUNTIME_SERVICE`, and selecting an unreachable Random driver does not emit it. Tests preserve exact signed-zero draw/time bits and signed safe-integer clock bounds, including backward timestamps and the strict 0.5 Boolean boundary.

Measured with Rust **1.98.1**, `x86_64-unknown-linux-gnu`, logging reachable in both enabled and disabled async fixtures:

| Failure policy | Enabled SyncContext | Enabled AsyncContext | Enabled interleaved future | Disabled AsyncContext | Disabled baseline future |
| -------------- | ------------------: | -------------------: | -------------------------: | --------------------: | -----------------------: |
| None           |            64 bytes |            160 bytes |                  464 bytes |              96 bytes |                312 bytes |
| Bounded        |            64 bytes |            168 bytes |                  504 bytes |             104 bytes |                320 bytes |

Enabled layout values agree in debug and release; disabled baselines were measured in release. Script buffers, watch channels and Tokio runtime setup precede allocation counters. Context construction, moving prepared buffers into setters and unpolled future construction allocate **zero** in these probes. One valid synchronous scripted branch invocation allocates **zero**. Buffer allocation, async polling/timers, logging, panic formatting and failure-frame capture are outside those zero-allocation measurements. The future workloads differ, so their size difference is not a pure per-service overhead estimate. Within this fixture, adding both reachable drivers increases AsyncContext by 64 bytes under either policy; this is a measured configuration, not a stable ABI promise.

Conformance exposed and corrected two integration issues in their owners' files: the framed interpreter's existing Map helper used outer bindings instead of its freshly bound value; initial native Clock/Random helper emission omitted Rust body braces. The final fixture includes regressions for both through framed Boolean/ordered reads and rustc-built native helpers.

Fault probes distinguish reference Effect defects from native trusted-host panics and prove typed catch cannot recover them. They intentionally do not establish native Cause/finalizer equivalence on fault paths. Valid-script cancellation checks cleanup reads the expected remaining clock/draw values and skips the post-sleep draw; independently interleaved contexts return their own results. Live Clock smoke checks representability without elapsed-time bounds.

Parent integration has added the public native frame decoder's new `clockReadMillis` / `randomDraw` kinds and central documentation; broader regression checks and commit/publish are recorded in PROGRESS.md. The direct service probes and live success runner do not exercise those decoder tags.

## Registered Scope cleanup extension

**RTCONF-005 — Scope close shares invocation service cursors.** Registered finalizers must use the same owned Clock/Random drivers as the body and continuation, including during interruption. Use two registered finalizers with distinct expected timestamps/draws to prove LIFO ordering and cursor continuity. On normal close, a subsequent authored read must observe the fourth script entry; on interrupted close, that continuation must not run. This extends the existing Ensuring cancellation proof to `addFinalizer` / `scoped` without changing the main measurement program.

The independent official Effect workload, plain reference and framed reference agree on normal success and interrupted Exit, with traces `started → second → first → after-close` and `started → second → first` respectively. Cleanup consumes the body's remaining script in both cases, including the exact 0.5 Boolean boundary. The native workload suspends on the existing live timer, signals cancellation, awaits registered cleanup and verifies the interrupted result. These are valid-script guarantees; trusted-host script faults remain outside the finalizer-equivalence claim.

```sh
env CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 \
  vp test packages/reffect/tests/clock-random.test.ts --maxWorkers=1 -t registered
```

**2/2 selected tests pass**, 29.80 seconds total / 28.30 seconds tests (the previous seven tests deliberately skipped). The registered native workload uses its own generated artifact and freshly builds/runs debug and release under both frame policies. Strict package TypeScript and targeted fixture lint pass. The earlier seven-test artifact and its context/future/allocation measurements remain unchanged; this extension makes no new Scope-storage cost claim.
