# Scoped heartbeat vertical slice

**Current extension:** [bounded resource Scope](resource-scope-registration.md)
supersedes the pending-sequence-only registration boundary below. `addFinalizer`
now returns an ordinary computation and `scoped` is explicit lifetime IR with
compiler-proved capacity. This original preparation remains historical context.

Preparation checked 2026-10-02 against installed Effect 4.0.0-rc.118 and Tokio 1.53.1.

## Evidence and prior decisions

- Existing Sleep, Ensuring and scalar AcquireUseRelease already provide owned cancellation and masked, awaited Unit/Never cleanup. The file-resource work in progress is independent.
- [Pinned repeat implementation](https://cdn.jsdelivr.net/npm/effect@4.0.0-rc.118/src/internal/schedule.ts) runs the body immediately, stops on failure, and sleeps between successful runs. Options preserve the body's output; `times` counts additional runs.
- Installed `Schedule.ts:1546` implements spaced as a duration after each body, not fixed wall-clock cadence. Installed `Effect.ts:13237` accepts an Exit-aware non-failing finalizer; this slice admits Exit-independent callbacks only.
- [Tokio Ctrl-C](https://docs.rs/tokio/1.53.1/tokio/signal/fn.ctrl_c.html) works on Windows/Unix and requires the signal feature. Signal handling belongs to the example executable, not the compiler library.

## Chosen boundary

`R.Schedule.spaced` admits integral positive 1–60000 ms durations. `R.Effect.repeat` admits Unit bodies, a spaced schedule and optional 0–1000000 additional runs; output is Unit. Emit one concrete loop with cooperative sleeps, retaining body failures and interruption. Do not unroll repeats or introduce a general Schedule driver.

`addFinalizer` produces a distinct, immutable pending scoped sequence. `andThen` appends computations or registrations; `scoped` closes it into checked existing bracket IR. A registration becomes masked Unit acquisition followed by the remaining sequence and awaited release. This preserves reach/registration timing, sequential LIFO closure, scalar captures and skipped registrations after failure. Pending sequences cannot be function bodies, branch arms or repeat bodies: dynamic registration, Exit-aware/fallible finalizers, arbitrary Scope services and escaping resources remain refused by the type boundary. Existing ordinary computations can also be passed through scoped. This is bounded lexical specialization, not general resource Scope.

Use the existing log records through their Effect v4-mirrored names (`R.Effect.log`, `logInfo`, `logWarning`, `logError`, `logDebug`, `logFatal`, `logTrace`, plus `annotateLogs`/`withLogSpan`), preserving structured stderr and machine stdout; `R.Log.*` remains the equivalent lower-level namespace. The authored application lifecycle corresponds to the user's Console example; literal Console/stdout compilation remains outside this slice.

Alternatives: a boxed dynamic finalizer stack would widen lifetime/capture ownership and add allocation; a blanket ensuring wrapper would lose registration timing; using Tokio interval would change spaced scheduling. Specialized brackets and a concrete loop reuse verified machinery with the smallest semantic extension.

## Acceptance

Compare an independently authored official Effect addFinalizer/scoped/repeat oracle with reference and native traces: immediate first run, exactly times+1 runs, failure short-circuit, reverse awaited cleanup, nested scopes and cancellation before entry/during spacing. Test both frame policies and debug/release. Refuse invalid durations/counts and unclosed scope sequences at types. Build a runnable native heartbeat with Ctrl-C and deterministic timed shutdown for automation. Record exact validation results in PROGRESS.md.

## Delivered evidence

The bounded profile and example are implemented. The heartbeat tests independently construct the pinned v4 oracle with real `Effect.addFinalizer`/`Effect.scoped`, rather than treating bracket specialization as its own proof. Native/reference traces and failure frames agree under both frame policies and debug/release. The native interruption probe cancels at its first pending poll, verifying a heartbeat occurs before the first spacing delay and cleanup is awaited; an already-cancelled context emits no application/finalizer records. The timed standalone release smoke run exits successfully after three heartbeats with one cleanup record. Portable Ctrl-C handling is compiled against Tokio's signal API; automated evidence uses the same cancellation path with timed shutdown, not an injected OS console signal.

Repetition adds no execution-context fields or dynamic future dispatch: its finite counter is a generated local and its body helper is reused. Loop-count-independent heap/future allocation costs have not been measured. Pending sequences allocate immutable authoring arrays and specialize at definition time; there is no native finalizer registry. See PROGRESS.md for exact commands, full regression results and the disk-pressure rerun.
