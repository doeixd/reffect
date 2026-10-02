# Bounded Schedule generalization

Preparation checked 2026-10-02 against installed Effect **4.0.0-rc.118** and Tokio **1.53.1**. This replaces the single `Schedule.spaced` special case with a small, first-class schedule value so `R.Schedule` / `R.Effect.repeat` / `R.Effect.retry` read like Effect v4. It is a bounded subset, not a general schedule engine.

## Pinned semantics

- `Schedule.recurs(n)` is `while(forever, ({ attempt }) => attempt <= n)` with zero delay: one initial evaluation plus at most `n` recurrences ([source](https://unpkg.com/effect@4.0.0-rc.118/src/Schedule.ts)).
- `Schedule.spaced(d)` returns a constant delay `d` after each run and outputs `attempt - 1`.
- `Schedule.exponential(base, factor = 2)` delays `base * factor^(attempt - 1)`; the first step is `base`.
- `Schedule.forever` is `spaced(zero)`; `Schedule.fixed` observes elapsed clock time, `Schedule.jittered` randomizes, and `Schedule.upTo`/`while` bound or filter an existing schedule.
- `Effect.repeat` / `Effect.retry` accept `{ schedule, times, while, until }`; the source always runs once before the schedule is stepped, so `times` counts additional runs ([Effect.ts](https://unpkg.com/effect@4.0.0-rc.118/src/Effect.ts)). `retry` never retries defects or interruption.

## Bounded decisions

- **SCHED-001:** Admit `recurs`, `spaced`, `exponential` and `forever` as a tagged, frozen `Schedule` value carrying a plain `SchedulePlan`. `spaced`/`exponential` bases are integral 0–60000 ms (matching `Sleep`); `recurs`/`times` are 0–1000000; `exponential` factors are finite `> 0` and `<= 1000`. Runtime exponential delays saturate to `u64::MAX` rather than overflowing. Fixed cadence, jitter, `upTo`-by-duration, `while`/`until` predicates and schedule combinators (`union`, `intersect`, `compose`, `andThen`) are deferred; the `times` option covers count limiting.
- **SCHED-002:** `R.Effect.repeat` and `R.Effect.retry` accept either a bare schedule (v4 dual form) or `{ schedule, times }`. Both build one shared node and delegate reference execution to official `Effect.repeat`/`Effect.retry`. `repeat` keeps a Unit body and discards the schedule output (a documented narrower boundary than v4's schedule-output return); `retry` preserves the body's success value and last failure.
- **SCHED-003:** Native lowering emits one concrete loop with a generated `completed: u64` counter, a continuation test and a delay expression. `recurs` stops at the count; `spaced`/`exponential`/`forever` continue until interruption or the `times` cap. Retry retries only typed domain failures, discards the retried attempt's logical frames, appends one retry boundary frame on the final failure, and never retries interruption. No dynamic schedule driver, boxed futures, clock reads or new Cargo crates.

Alternatives: unrolling schedule steps would not terminate for `forever`/`spaced`; a boxed step-trait object would add dynamic dispatch where a build-time tag suffices; delegating native execution to a Tokio interval would change `spaced`/`exponential` timing. A tagged value plus generated loop reuses the existing `AsyncContext::sleep` cancellation contract with the smallest extension.

## Acceptance and costs

Differential official-Effect/reference/native traces for `recurs`, `spaced`, `exponential`, `forever` and `retry` across debug/release and both frame policies: exact run counts, failure short-circuit, retry exhaustion, interruption of a retry delay, and repetition inside a scoped finalizer sequence. Refuse invalid durations, counts and factors, non-schedule values and unrepresentable schedule combinators at the type/authoring boundary. Failure-frame chains agree for final retry failures. Measure that repetition adds no context fields and no per-step heap allocation. Exact commands and results belong in [PROGRESS.md](../../PROGRESS.md).

## Delivered evidence

Implemented and validated. [schedule.test.ts](../../packages/reffect/tests/schedule.test.ts) compares an independently authored official Effect 4.0.0-rc.118 program against reference execution and native debug/release for `recurs`, `spaced`, `exponential`, `forever`, exhausting `retry` and an immediate-success `retry`, under both frame policies. Log sequences and Exits agree; final retry failure frame chains agree between `Reference.runWithFrames` and `NativeRunner.runWithFrames`. A native probe cancels during a retry delay and observes exactly one attempt and `Interrupted`. Forged IR with an invalid exponential factor is refused as `TYPE_MISMATCH`. Strict type contracts cover inference, dual schedule/options forms, and refusals (unrepresentable schedule values, non-Unit repeat bodies, stock runtime schedules).

Costs: repetition adds no `AsyncContext` fields and no per-step heap allocation; it emits one `completed` local and one generated loop. The exponential delay is computed with `f64` and saturates at `u64::MAX`; loop-count-independent future sizes are unchanged from the heartbeat slice and are not separately re-measured here. PROGRESS.md records exact commands and results.

## Deferred

General Scope/acquire-release registration remains the next frontier; this slice must not displace it for long. Revisit schedule combinators, `while`/`until` predicates, fixed cadence, jitter and returning schedule outputs when a real workload needs them.
