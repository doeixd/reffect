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

- Spaced durations: positive integral 1–60000 milliseconds, parsed with Effect v4 Duration.
- Repeat: Unit body, preserves its typed error, optional `times` counting additional runs; otherwise runs until failure/interruption.
- Sequential `addFinalizer(() => Unit/Never computation)` registration and `andThen`, closed with `scoped`. Registration callbacks build IR once and receive no runtime Exit. Closed scopes compose with existing branching/recovery/brackets.
- Pending scope sequences are a separate typed authoring value: close them before passing to functions, branching or repeating. This specializes reachable sequential registrations into the existing masked acquire/use/release adapter, with reverse-order awaited release. It does not implement dynamic Scope services, Exit-aware cleanup or arbitrary Schedule combinators.

See [design and conformance criteria](../../docs/research/heartbeat.md).
