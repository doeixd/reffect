# Registered file session

Run from the workspace root:

```powershell
vp exec node --experimental-transform-types examples/scope-registration/main.ts
```

The runner creates a real five-byte read-only fixture, executes the authored session through official Effect reference interpretation, and builds/runs the same program as a native Rust executable. Temporary files and the generated crate belong to the runner's scope.

`R.File.acquireReadOnly` returns the metadata result from its callback while retaining ownership of the file in the surrounding `R.Effect.scoped` region. The next log and suspension happen after registration returns. Only when that outer scope exits does the file close, its delayed cleanup finish, and the earlier session finalizer run:

1. `registration returned; file still owned by session` (size 5)
2. `file closed`
3. `file cleanup awaited`
4. `session released`

NativeRunner consumes the native stdout value protocol; native log records are validated by the conformance tests rather than forwarded by this example. The final reference/native result record confirms completion after awaited cleanup.

This is a bounded sequential registration profile: at most 16 proved runtime registrations per lexical scope, Unit/Never Exit-independent cleanup, compile-time file paths and scope-owned read-only handles. It does not expose manual Scope values/close, closed-scope registration, child scopes, parallel release, Exit-aware/fallible finalizers, registration within cleanup or resource Layers. Caller cancellation must signal and await execution; dropping/aborting a future is outside the guarantee.

## Conformance coverage (executed)

The dedicated fixture is `packages/reffect/tests/scope-registration.test.ts`; strict authoring contracts live in `scope-registration-types.ts`. It compares independently authored Effect v4 programs against the IR reference and native debug/release with Bounded/None failure frames. It checks conditional registration, distinct scalar captures, registration-time annotation/span snapshots, repeated and retried registrations, all 16 capacity slots, failure short-circuiting, awaited cancellation cleanup, typed-failure precedence, recovery and typed-failure frames.

Real-resource checks include actual Node descriptor validity after the acquisition callback has returned, invalidity before cleanup logs, exactly one close attempt, and a post-open acquisition barrier under cancellation. The native fixture retains three simultaneously registered files and uses the exact live-handle delta and return to baseline on Windows/Linux as supplemental evidence.

The native identity/barrier extension instruments only the emitted test fixture's `src/lib.rs`. It wraps the four expected static File opens and observes the existing emitted log boundary; assertions refuse an unexpected emission shape. It captures non-owning raw Windows HANDLEs/Unix file descriptors without cloning or closing them. `GetHandleInformation` on Windows and `fcntl(F_GETFD)` on Unix verify validity after callback return, invalidity before after-close logging, and reverse-order closure of three files while earlier files remain valid. The probe prints the actual raw identities and checks one cleanup start/completion per successful open. These observations verify ownership and release dispatch; they are not close-syscall tracing.

A oneshot notification plus blocking-worker gate pauses a successful real open **before the worker returns the File**, independently of timer scheduling. The caller sends cancellation and polls again while the gate remains shut, requiring the future to stay Pending with a valid actual handle and no body/release events. After the gate opens, the caller awaits interruption, the file closes, its delayed cleanup finishes once, and the previously registered finalizer runs once afterward. The existing queued-open barrier remains a separate case. Test instrumentation is removed before ordinary native runner/frame checks; no production API or runtime hook is added.

Other Windows/Unix hosts can run identity checks without a Linux process counter; the explicit Unix `F_GETFD = 1`/`EBADF = 9` ABI assumption needs validation on each claimed Unix host.

Executed validation from the workspace root:

```powershell
vp test --maxWorkers=1
vp exec tsc --noEmit -p packages/reffect/tsconfig.json
vp check packages apps tools examples docs PLAN.md PROGRESS.md AGENTS.md README.md package.json vite.config.ts tsconfig.json
vp run -r build
vp exec node --experimental-transform-types examples/scope-registration/main.ts
```

Results use the exact parent evidence: full `vp test --maxWorkers=1` with `CARGO_PROFILE_DEV_DEBUG=0` and `CARGO_INCREMENTAL=0` passed 120/120 in 28 files (1063.68 seconds total, 1022.08 seconds tests), including the scope-registration fixture at 5/5 in 129018ms. After a test-only `FailureFramePolicy` warning fix with no runtime semantic change, the dedicated suite reran successfully at 5/5 (112.43 seconds tests, 114.32 seconds total). The TypeScript check passed; the scoped `vp check` passed (186 formatted files and 101 checked TypeScript files, zero warnings/errors). The workspace build passed all four tasks. The runnable example passed with reference/native `5n` and the required registration-returned, file-closed, cleanup-awaited, session-released order. Toolchain: installed Effect 4.0.0-rc.118, Tokio 1.53.1, Rust 1.90.0 x86_64-pc-windows-msvc, host Node v26.5.0.

Construction/layout observations beyond the admitted capacity proof remain separate workload measurements. Filesystem work, timer polling, registration/drain execution and log formatting have separate costs from context/future construction.
