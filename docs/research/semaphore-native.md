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

## Scheduled scan continuation experiment (2026-10-06 preparation)

Rechecked [pinned Effect 4.0.0 Semaphore source](https://unpkg.com/effect@4.0.0/src/Semaphore.ts) online before this extension. `releaseUnsafe` queues one scan only when waiters exist; the scan iterates the live Set, deletes an eligible callback before resuming it, and rechecks free permits before the next callback. Set iteration can see additions made during resumption. The existing Deferred turn storage is reusable inspiration, but its inline completion ordering remains unsuitable for release.

- **SNAT-006 (experimental):** build a separate inline, borrowed owner and explicit scheduled-scan driver. Release records pending scans; the driver starts them only after the releasing continuation suspends or completes. During a scan it resumes one registered task through its synchronous continuation before selecting the next live registration. No permit reservation and no Tokio wake-all selection.
- **SNAT-007 (experimental):** fixed task slots with monotonically increasing registration tickets model live insertion order, including deletion/re-registration and slot reuse. Remove registration before callback; release the state lock before polling peer work. Ordinary parent re-polls cannot resume a still-registered observer; only scan selection detaches it. Borrowed permits return capacity once on Drop. Checked counter overflow panics in this private experiment; production admission needs derived registration/dispatch budgets instead.
- **SNAT-008 (boundary):** this is a scripted dispatcher experiment, not generated compiler integration. Driver callbacks must run the selected acquisition and continuation to semantic suspension/completion; an arbitrary Rust Pending or an ordinary Waker is not that contract. Raw task abortion is still not asynchronous Effect finalization. Native/public Semaphore stays refused.

Alternatives: retaining wake-all leaves waiter selection to substrate scheduling; FIFO reservation prevents synchronous barging; sharing Deferred completion turns would block the releasing continuation. A full Effect scheduler port is disproportionate. The separate scan prototype tests the smallest required scheduling boundary without modifying admitted Deferred machinery.

Acceptance: controlled (no elapsed sleeps for ordering) official traces for multiple waiters, capacity two, reentrant release/reacquisition, cancellation before scan, and new registrations during an active scan; assert final capacity and empty registrations. Exercise debug/release and deliberately reversed ordinary ready-task polling to show why wake-all cannot establish scan order. Measure quiet allocation and inline owner/guard size only for the prototype; generated future size, interrupted frames, mask/cleanup handoff and shared Deferred/Semaphore dispatcher integration remain unproved.

### Delivered prototype and counterexample

`src/semaphore-dispatch-runtime.ts` is separate from the earlier wake-all experiment. Its owner stores a Mutex and a four-slot array inline; acquisitions and permits borrow the owner. Release restores availability and increments a pending-scan counter. `dispatch_one` removes one live registration at a time, polls its task through the supplied callback, then checks availability and the remaining live insertion order again. Locks never cross a callback. A registered acquisition ignores incidental parent polls until explicitly selected; a fresh acquisition can still barge.

`tests/semaphore-dispatch-runtime.test.ts` registers B before A but deliberately re-polls A before B with the same parent Waker. The earlier wake-all adapter grants A first, unlike official Effect's B-first observer scan. This is an experimental counterexample, not an accepted divergence. The replacement preserves B-first selection without FIFO reservation.

Seven controlled official fixtures cover registration order, synchronous holder barging, reentrant waiter release/reacquisition, cancellation before a scan, appending C during B's callback, cancellation/re-registration of A during that callback (reusing its slot behind C), and capacity two with suspended holders. The harness asserts live additions and re-registrations are visited in the first active scan, final availability equals capacity, and registrations are empty. Official fixtures use `startImmediately` and Deferred barriers rather than elapsed sleeps. Dynamically added/restarted test fibers use `forkDetach` and explicit joins so the originating waiter's completion does not cancel them; this researches Set mutation and does not admit detached/dynamic topology into IR.

Measured on this 64-bit Rust 1.98.1 target: four-slot owner **144 bytes**, acquisition future **40 bytes**, borrowed permit **8 bytes**. Each debug/release build runs 1,000 quiet contention invocations with a counting allocator: **zero allocations** in both modes. Sizes and allocator checks concern these prototype objects and primitive calls only. They do not establish generated authored-future layout, full execution-context cost, stack peak, compiler heap or interrupted metadata costs.

Generated admission gates remain: compiler-derived scan/registration budgets independent of Deferred, task-group failure semantics, masked acquisition/cleanup registration and every selected-before-body cancellation boundary, defects/panics (callback panic currently leaves the private scanning flag set), generated layout and disabled-frame costs. The separate real-future driver below establishes conditional authored-suspension and awaited-cleanup evidence, without closing those generated admission gates. Arbitrary concurrent driver invocation, global ordering across owners, multiple scheduler priorities and multi-thread conformance are not established. Semaphore stays private and rejected by compiler/native lowering.

## Bounded real-future driver (2026-10-06 preparation)

Rechecked pinned [Semaphore](https://unpkg.com/effect@4.0.0/src/Semaphore.ts) and [callback resumption](https://unpkg.com/effect@4.0.0/src/internal/effect.ts) online, plus the admitted Deferred coordinator/generated driver and AsyncContext. A short observer callback resumes acquisition and its synchronous continuation before the scan visits the next live callback. Context interruption is cooperative; dropping a Rust task cannot stand in for awaiting Effect cleanup.

- **SNAT-009 (private driver):** integrate one inline owner with unnested heterogeneous two/three-child outcome-collecting futures and distinct task slots. Poll each selected future to completion or an explicitly marked authored suspension before proceeding. Use the existing unconstrained/semantic-marker pattern; retry protocol-only Pending within a fixed experimental ceiling and refuse excess by assertion rather than treating it as authored suspension. This is not a derived compiler budget.
- **SNAT-010 (cancellation experiment):** use existing AsyncContext/watch cancellation. Pending acquisition selects cancellation first; permit ownership is stored before checking interruption at the body boundary. Test independently canceled waiters and masked asynchronous holder cleanup, with the group collecting every child's outcome after cleanup. Selected-before-acquisition cancellation injection is an invariant probe, not an authored Effect differential or proof of every grant-to-body race.
- **SNAT-011 (admission):** keep native/public refusal. This proves a private bounded execution candidate, not compiler lowering, mixed Deferred/Semaphore ordering, general scheduler priority/ready-queue behavior, arbitrary callbacks, defects or multi-thread conformance.

Alternatives: ordinary join/ordered Wakers reproduce the prior selection bug; integrating directly into admitted Deferred machinery would expand its trusted boundary without joint dispatcher evidence. Chosen separate driver borrows pinned futures and inline banks; no Box, Arc or value metadata is proposed. Acceptance: independently authored official traces with controlled gates for reversed registration order, reentrant reacquisition, queued cancellation, holder cleanup and parent interruption during cleanup; native invariant injection after selection; protocol-Pending stress; quiet driver allocation/layout measurement in debug/release.

### Real-future driver boundary and evidence

`semaphore-task-runtime.ts` adds a separate private semantic-marker bank, borrowed `Pin<&mut F>` two/three-child join driver, AsyncContext-aware acquisition and interruptible-parent cancellation wrapper. Selected callbacks poll through completion or a marked authored suspension; bounded protocol-only retries preserve synchronous tails. The parent wrapper broadcasts interruption but keeps polling all children until their awaited cleanup finishes. Existing admitted Deferred drivers and public compiler selection are untouched.

The controlled real-future harness compares six separately authored official workloads: reversed registration/static polling order with a suspended holder; holder barging; waiter reentrant release/reacquisition; independently interrupted queued waiter; interrupted holder with masked suspended cleanup; and parent interruption while that cleanup is active. Each asserts occupancy and registration state at the gates, final capacity and empty registrations. Selected-before-acquisition cancellation and a pre-aborted parent are separate native invariants; an explicitly interrupted official root also executes no guarded body. These do not introduce an authored yield between acquisition and cleanup installation. A deliberately unmarked Retry future verifies protocol Pending cannot let another observer overtake the releasing synchronous tail.

Quiet allocation/layout probes measure the borrowed driver, simple contending child futures and marker bank, with no authored logging, watch-channel/context construction or gate/timer allocation inside the counting window. They are incremental primitive/driver measurements, not a zero-allocation claim for a complete canceled/context-bearing invocation.

The wrapper currently assumes an interruptible parent. Real waiting paths must use `ScanTask.semantic`; its marker contract is not inferred from arbitrary Rust futures. Synchronously signaling parent cancellation from a resumed callback, cross-thread cancellation during one driver poll, and relative ready-task ordering across owners remain outside the measured contract: the parent watcher is checked at outer polling boundaries. The generic join collects child outcomes; it does not implement general Effect.all typed-failure/sibling-interruption semantics. Fixed retry/scan ceilings still need structural compiler derivation. Generated lowering, defects/panics, mixed Deferred/Semaphore phases, interrupted frames and complete generated/context layout admission remain open.

The pre-start interruption oracle uses `Effect.interrupt` at the root boundary. Pinned `runForkWith` evaluates the Effect before checking RunOptions.signal, and returns immediately for a completed synchronous root; a bare already-aborted signal can therefore still execute synchronous work. Our native parent-watch preflight matches the existing owned Deferred execution boundary rather than claiming that bare upstream RunOptions provides this guarantee.

Measured on the current 64-bit Rust 1.98.1 target in both debug/release: quiet borrowed join2 future **144 bytes**, one simple contending child future **176 bytes**, four-slot marker bank **12 bytes**. One thousand invocations per build allocate **zero** inside the quiet window. Cancellation/watch construction and the larger authored cleanup fixtures are excluded from this measurement.

Mutation evidence: allowing protocol-only Pending to finish a task turn makes the native Retry probe fail; the original retry behavior was restored before regression validation.
