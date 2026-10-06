# Bounded Semaphore native preparation

Checked 2026-10-06 against installed Effect 4.0.0 `src/Semaphore.ts` and reffect's generated Deferred turn, owner, and coordinated task-group adapters. This record describes research and proposed experiments; it does not establish native support.

## Primary-source behavior

[Effect Semaphore source](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Semaphore.ts), especially `waitForPermits`, `SemaphoreImpl.releaseUnsafe`, and `SemaphoreImpl.withPermits`, establishes three separate obligations (online source checked against the installed implementation on the date above):

- Acquisition is inside an uninterruptible mask. Waiting restores the caller's interruptibility; after resumption acquisition rechecks the available count before taking a permit. A wake is not a reserved permit.
- Each waiter is a callback in an insertion-ordered Set. Interrupted waiting unregisters that callback. A callback removes itself before resuming when enough permits are available; smaller requests can overtake larger requests in the general API.
- Release decrements the taken count and **schedules** an observer scan through the current dispatcher at priority zero. It does not await waiter work or resume it inline in the releasing fiber. The releasing fiber's synchronous continuation therefore precedes a scheduled wake unless it reaches a semantic suspension or scheduler yield.

`withPermits` installs an exit cleanup before restoring the guarded body. The guarded body's own finalizers finish before the permit is released. The acquisition/cleanup handoff must not leak a permit when cancellation arrives immediately after acquisition.

The first proposed IR has lexical `SemaphoreScope { capacity, binder, body }` and `SemaphoreWithPermits { binder, permits, body }`. Capacity is a positive safe integer; the first admitted request count is exactly one. Public channels cannot contain the lexical handle. The private native experiment would narrow further to capacity at most three, zero-input scalar-success/Never-error functions, one unnested All2/3 group, and ordinary Sleep/Log/Ensuring/Map/FlatMap/Match computations. This narrowing does not by itself solve scheduling or callback-budget compatibility.

## Decision ledger

- **SNAT-001:** Native admission stays refused while scheduled-dispatch and ownership evidence is incomplete; lexical/reference delivery is a separate capability.
- **SNAT-002:** Do not alias Tokio FIFO permit reservation or Deferred inline completion turns to Effect Semaphore release.
- **SNAT-003:** The raw current-thread experiment owns fixed registration slots, rechecks availability, and schedules wakes. Arc/spawn overhead is explicitly experimental.
- **SNAT-004:** Cooperative holder cancellation awaits authored asynchronous cleanup before dropping the guarded permit; arbitrary Tokio task abortion is outside this contract.
- **SNAT-005:** Exact authored event traces establish only the tested slice. Wake-all scans, larger topology, dispatcher budgets, and production costs remain gates rather than accepted divergences.

## Adapter alternatives

Tokio's Semaphore provides cancellation-safe acquisition machinery but reserves permits according to its FIFO queue. It is not a proven alias for Effect's scheduled callback scan and subsequent acquisition recheck. Using it directly would erase an observable scheduling distinction.

The existing DeferredState and DeferredTurns code stores invocation-owned registrations in fixed arrays and routes resumed waiters until they suspend or finish. The storage pattern is reusable. DeferredComplete's inline callback-turn protocol is **not** reusable for Semaphore release: blocking the releasing fiber until waiter work runs reverses the scheduled-release ordering above.

A dedicated adapter can reuse fixed inline registration slots, cancellation watch channels, Tokio timer/wake facilities, and the coordinated static group driver. It needs a separate dispatcher-phase queue for scheduled scans. A release restores availability and marks a scan pending; the authored releasing task must run through its synchronous continuation before that phase is dispatched. Scans must recheck availability, and callbacks awakened by a scan must reacquire rather than receive a permanent reservation. The adapter must also define what happens when a resumed body synchronously releases again during a scan, registration occurs while scanning, or a waiter is cancelled before the scheduled scan.

An alternative initial native slice admits only scopes without overlapping guarded work. That would prove masked cleanup but would not prove the important queued-waiter behavior, so it should not be presented as the Semaphore concurrency milestone.

## Chosen initial boundary

Implement and test the lexical IR against the official Effect interpreter first. Keep native/public compiler admission explicitly refused while scheduled dispatch, owned execution context, callback budgets, cancellation, layout, and allocation evidence remain open. Do not remove the native gate merely because a mutex and Tokio semaphore compile.

A private raw adapter experiment may proceed independently after the scheduling model is fixed. Integrating `lowerSemaphoreFunctions` should wait for meaningful traces proving scheduled release rather than borrowing Deferred's completion turns speculatively. Generated direct execution remains the goal; no heap metadata on scalar values and no global coordinator are proposed.

## Required differential evidence before integration

Compare guarded entry/exit, acquisition, authored logs, interruption, and cleanup against official Effect:

1. Capacity one, three guarded children: no overlapping holders, queued registration order, and the releasing task's continuation before awakened-body entry.
2. Cancellation of an independently queued waiter: its body never enters, its registration disappears, and remaining waiters can acquire.
3. Cancellation of a holder with an asynchronous inner finalizer: cleanup completes before another guarded body enters.
4. Cancellation after acquisition but before the guarded body starts: cleanup releases exactly once.
5. A synchronous release followed by immediate reacquisition: acquisition rechecks rather than consuming a reserved FIFO permit.
6. Capacity two, repeated scheduled releases, newly registered waiters during a scan, and callback cancellation before scan execution.
7. Pre-aborted root and parent interruption during cleanup: exact outcomes, no permit leakage, and finalization before group completion.

Run Cargo/native suites sequentially in the shared workspace. Public admission additionally needs a closed scheduler/context contract, structural growth limits, measured future layout and quiet allocation costs, and disabled-frame-path evidence. Record any accepted timing difference in the divergence register; do not relax comparisons to hide authored event order differences.

## Raw scheduled-wakeup experiment

`semaphore-native-runtime.ts` now contains an explicitly private adapter used only by `semaphore-native-runtime.test.ts`. It stores registrations in a fixed array with insertion-order links, updates registered Wakers on re-poll, unregisters dropped acquisitions, and rechecks availability before granting. An explicit guarded permit releases once when dropped; the harness awaits holder cleanup before dropping it. A release schedules a Tokio task to scan live registrations and enqueue wakes, preserving the releasing task's uninterrupted continuation in the pinned current-thread harness.

This prototype deliberately uses an Arc-owned Mutex and Tokio spawned scan tasks. It has not established inline storage, future-size, zero-allocation, multi-thread execution, or general Scope guarantees. Ordinary task abortion can drop a permit without awaiting asynchronous cleanup; the harness uses cooperative watch-channel interruption and explicitly awaits cleanup. This adapter is not a replacement for owned Effect finalization.

The prototype also differs algorithmically from the official scan: Wakers schedule polls, so it can wake every currently registered waiter before any resumed acquisition consumes availability. Effect's observer callbacks may resume a fiber inline during the scheduled scan and change availability before the next callback. Exact traces for one queued acquirer, synchronous barging, and queued/holder cancellation are meaningful evidence for those cases only. Multiple waiter order, simultaneous scheduled scans, resumption/register/delete during scanning, and dispatcher-budget compatibility remain open. Native lowering intentionally rejects every Semaphore node rather than selecting this adapter.

The differential harness runs debug/release on Tokio 1.53.1, ten repetitions of each of three scenarios, with exact official Effect event sequences and assertions that available count returns to capacity and all registrations disappear. The primary agent ran the suite sequentially: 1/1 passes, with all 60 exact trace repetitions across debug/release. This is raw adapter evidence, not generated IR admission or ownership/cost proof.
