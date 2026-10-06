# Bounded Latch cohorts

Preparation checked 2026-10-06 against installed Effect **4.0.0** and byte-identical online [Latch.ts](https://unpkg.com/effect@4.0.0/src/Latch.ts) and [internal/effect.ts](https://unpkg.com/effect@4.0.0/src/internal/effect.ts). This implements COORD-004 from [coordination decisions](coordination-modules.md), following the bounded Deferred/Semaphore ownership work and [uniform timer waves](semaphore-timer-ordering.md).

## Verified semantics

- `make(open?)` defaults closed. `open` returns false when already open; otherwise it changes state and schedules current waiters. `close` returns whether it changed state. Closed `release` returns true even without waiters and does not open the latch; open `release` returns false.
- Effectful open/release detach waiting callbacks immediately into a scheduled array. Additional pulses before dispatch append their current waiters to that array. `close` does not revoke these grants.
- Dispatch detaches the scheduled array before resuming any callback. Reentrant waits and pulses belong to a later dispatch, never the current detached cohort. Callback order follows registration order, not child-slot order.
- Cancellation removes pending/scheduled registrations independently. Once dispatch has detached its array, upstream may still invoke a canceled callback; the interrupted fiber does not execute its continuation. Native dispatch may skip an invalidated ticket, preserving the observable continuation behavior.
- `whenOpen` is await-then-body, not a continuously held guard. The upstream synchronous `isOpen` becomes an explicitly effectful projection in IR because runtime state cannot be a build-time Boolean.

## Decisions

- **LAT-001 — Inline lease and detached ticket cohorts.** Use a mutex-protected fixed registration array, registration tickets and waiting/scheduled/granted phases. Await futures borrow the lexical owner; Drop removes only their own ticket. A dispatch snapshots scheduled tickets into a fixed array before callbacks and grants each still-live ticket immediately before polling its child. No lock crosses callback execution. A closed late waiter cannot use an earlier pulse. Fixed storage requires compiler-proved live task bounds before production selection.
- **LAT-002 — Separate signal and dispatch.** Signal updates state and detaches the waiting cohort without resuming children synchronously. The owner continuation runs to semantic suspension/completion before the driver dispatches. Keep this adapter private until All scheduling, timer/yield phases, cancellation and finite driver receipts are integrated. A Boolean watch channel loses pulses; a general Notify queue adds allocation without establishing Effect callback order.
- **LAT-003 — Lexical IR first, explicit native refusal.** Private make/await/open/close/release/isOpen builders and composed `whenOpen` execute through official Effect. Check lexical binding and reject handle escape. Every compiler traversal must handle the new nodes; unavailable native execution returns a structured refusal. No public namespace or unsafe constructor until checked generated ownership and admission are delivered.
- **LAT-004 — No accumulating registrations.** At most one live await per admitted task. Drop/completion frees its slot immediately. Monotonic tickets distinguish stale cohort entries from a new await in a reused task slot; overflow fails explicitly. No per-scalar metadata, Arc, heap queue or borrowed raw waker is introduced.

- **LAT-005 — Compact operation IR, distinct semantic identities.** Three tags (`LatchMake`, `LatchScope`, `LatchOperation`) avoid five duplicate leaf visitors. Operation-specific semantic refs and checker output/error witnesses still distinguish Await/Open/Close/Release/IsOpen. `whenOpen(latch, body)` and `whenOpen(latch)(body)` match upstream argument order. Native detection reuses the exhaustive authored-child visitor rather than reflecting over arbitrary object fields.
- **LAT-006 — Cleanup borrowing stays lexical.** Inline Ensuring may use the owner while its lifetime encloses cleanup; registered/delayed Scope cleanup cannot retain the handle. This conservative boundary matches existing coordination ownership. Framed typed failures retain fail → flatMap → latchScope → function; A private interruption-boundary test captures latchAwait → latchScope → function at the actual suspended wait. Broader interruption trails and ownership are public-admission gates.

## Acceptance and next admission gate

Controlled official/native scenarios cover transition Booleans, release before registration, reverse slot/registration order, release then close/reopen, coalesced pulses, cancellation before signal/after signal/during detached dispatch, and reentrant await/release in a callback. Compare continuation logs exactly; use barriers and direct polling rather than elapsed time as proof. Repeat cycles with allocation counting and inspect owner/future/cohort size in debug and release builds. IR tests cover reference execution, handle escape, binder substitution, exhaustive traversals and structured compiler refusal.

Before public native admission: reuse the borrowed task ownership/context adapter; integrate scheduled-cohort dispatch with All/timer phases; derive finite driver and code-growth receipts; prove cancellation joins masked cleanup and disabled metadata costs. General fibers, RPC, dynamic waiter counts, unsafe host APIs and mixed coordinator owners remain separate work.

## Adapter evidence

`tests/latch-cohort-runtime.test.ts` compares ten controlled scenarios against the default official scheduler, including reverse child-slot/registration order, independent canceled waiter removal from waiting/scheduled/detached phases, stale slot reuse, renewed cohorts, close after open, late registrations, coalesced pulses and reentrant release. Each native case repeats ten times in both unoptimized and optimized Rust executables. Additional native probes cover initial open, empty release, all capacities1..4, cancellation after grant before polling, and reopening with an older scheduled cohort.

On this 64-bit host: owner 120 bytes, await 40 bytes, detached cohort 96 bytes. One thousand repeated release/cancel/reopen cycles on the same owner allocate **zero** times, including owner construction and slot registration. Scalar payloads are absent; this is adapter-local evidence, not a generated-root/context/logging/metadata or whole-program peak-memory result. Completed/canceled registrations return to zero each cycle. The Rust state needs only std; it uses ordinary mutexes and driver-owned polling, not a new scheduler or timer dependency.

Mutation checks reject both reverse ticket ordering (native ordering assertion) and selecting a stale cohort entry by reused task slot (official/native continuation-order mismatch). Correct source is restored and rerun afterward. Independent review found no adapter blocker; its recommended renewed-cohort and granted-drop cases are covered. Unsafe host APIs remain deliberately absent.

## Private IR delivery

`tests/latch-ir.test.ts` covers both reference paths, transition results, release-pulse cancellation cleanup, data-first/data-last whenOpen, typed failure and private suspended-await interruption frames, substitution, independent invocation state, lexical/public channel escape, provenance/async/scope traversal, and structured native refusal. Deferred/Semaphore receipts explicitly refuse the new nodes. Private source modules are intentionally absent from package exports and R. The generated adapter is not selected by lower.ts; its conformance proves the local protocol, not full compiled Latch semantics.

## Verification commands

- `. "$HOME/.cargo/env"` then `vp test packages/reffect/tests/latch-ir.test.ts packages/reffect/tests/latch-cohort-runtime.test.ts --maxWorkers=1` (12 tests; native adapter compiled using rustc with/without optimization).
- Coordination/reference regression selection additionally covers semaphore-ir/traversals/structure/budget/timer-profile/execution and deferred-generated-profile/budget: ten suites,67 tests.
- `CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 vp test packages/reffect/tests/semaphore-public.test.ts packages/reffect/tests/semaphore-generated.test.ts packages/reffect/tests/semaphore-timer-ordering.test.ts packages/reffect/tests/deferred-public.test.ts --maxWorkers=1`: four suites,19 tests, native builds serial.
- `vp check`; `tsc --noEmit --strict --project packages/reffect/tsconfig.json`; `vp run -r build`: pass. reffect rebuilt; other workspace build results were cached.
