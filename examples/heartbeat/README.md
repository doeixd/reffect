# Scoped native heartbeat (Effect v4)

This vertical slice compiles a long-running reffect application to Rust. It logs startup, runs the first heartbeat immediately, waits one second **after each successful heartbeat**, and awaits its registered finalizer on shutdown.

```ts
const Application = R.fn([], R.Unit, R.Never, () =>
  R.Effect.addFinalizer(() => R.Effect.logInfo("Application is about to exit!")).pipe(
    R.Effect.andThen(R.Effect.logInfo("Application started!")),
    R.Effect.andThen(
      R.Effect.repeat(R.Effect.logInfo("still alive..."), {
        schedule: R.Schedule.spaced("1 second"),
      }),
    ),
    R.Effect.scoped,
  ),
);
```

The pinned **Effect 4.0.0-rc.118** supports the same `addFinalizer`, `andThen`, `repeat` options and `scoped` shape, and reffect mirrors the v4 logging names (`R.Effect.log`, `logInfo`, `logDebug`, `logWarning`, `logError`, `logFatal`, `logTrace`, `annotateLogs`, `withLogSpan`). [reference.ts](reference.ts) shows the independently authored v4 equivalent. This example uses structured logging in place of `Console.log`, keeping stdout available for compiler evaluator protocols.

## Run

```sh
# Official Effect interpreter of the reffect program; Ctrl-C runs cleanup.
vp exec node --experimental-transform-types examples/heartbeat/reference.ts

# Build into an exclusive new output directory (requires Cargo and the native toolchain).
vp exec node --experimental-transform-types examples/heartbeat/build.ts examples/heartbeat/generated

# Windows PowerShell:
& "examples/heartbeat/generated/target/release/reffect_generated.exe"
# Unix:
./examples/heartbeat/generated/target/release/reffect_generated
```

Press **Ctrl-C** to cooperatively interrupt the timer and await cleanup. The executable runs without Node. Native records are `reffect.log@1` JSON on stderr, with messages:

```text
Application started!
still alive...
still alive...
...
Application is about to exit!
```

For deterministic smoke runs, pass a shutdown delay in milliseconds, e.g. `reffect_generated.exe 2200`. A build refuses an existing output directory; use a new path when rebuilding. Signal errors/process termination are outside typed effect semantics; forcibly killing the process cannot run async cleanup.

## Supported boundary

- Schedules: `R.Schedule.recurs`, `spaced`, `exponential` and `forever` (see the package README). This example uses positive integral 1–60000 ms spacing.
- Repeat: Unit body, preserves its typed error, optional `times` counting additional runs; otherwise runs until failure/interruption.
- `R.Effect.retry` is available for typed failures with the same schedules and `times` option.
- `addFinalizer(() => Unit/Never computation)` now produces ordinary IR that can occur in conditional branches and finite repetition, discharged by `scoped`. Callbacks build cleanup IR once and receive no runtime Exit; closed scopes compose with recovery and brackets.
- The checker proves at most 16 retained registrations per live scope before execution. Dynamic order is retained in generated finalizer records, with registration-time logging context and awaited masked LIFO release. An indefinite heartbeat is admitted because it repeats logging rather than registration. Manual Scope values/close, child/fork, parallel release, Exit-aware/fallible cleanup, registration within cleanup and resource Layers remain separate; arbitrary Schedule combinators remain outside this profile.

See [design and conformance criteria](../../docs/research/heartbeat.md).
