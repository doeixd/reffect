# Private Queue interruption settlement

Prepared 2026-10-07 before planning/code. Builds on [QCB](queue-continuation-bridge.md) and [QOWN](queue-driver-ownership.md). First prove resumed interruption plus non-suspending masked cleanup; awaited asynchronous finalizers and hosted parent cancellation remain subsequent gates.

## Sources and evidence

Freshly checked [Effect4.0.0 internal effect source](https://unpkg.com/effect@4.0.0/src/internal/effect.ts): interruptUnsafe evaluates interruption immediately when a fiber is suspended; fiberInterruptAll visits children sequentially then awaits every Exit; ensuring uses onExit's masked finalizer path. [Queue source](https://unpkg.com/effect@4.0.0/src/Queue.ts) removes a pending waiter before evaluating cancellation cleanup. Existing Drop retirement is deliberately not a semantic finalizer implementation.

An independent official witness interrupts a waiting taker then a pending producer. The taker's finalizer observes no taker registration, shuts down the Queue, and synchronously resumes the producer with false. That producer and its finalizer finish before the taker's finalizer returns and before the parent visits the producer for interruption. Trace: producer:A, taker:cleanup:start, taker:unregistered, producer:false, producer:cleanup, taker:cleanup:end, parent:settled. Broadcasting cancellation before cleanup would suppress the producer's legitimate false continuation.

## Decisions

- **QINT-001 — Interrupted control result.** Add a distinct private Interrupted request response, separate from offer false, Queue terminal interruption and typed Done. Cancellable offer/take helpers return a native control Result and child futures explicitly follow the interrupted branch into cleanup. Scalars remain plain; per-child interruption state lives on the execution bridge.
- **QINT-002 — Remove before resume.** Interrupt only at a quiescent Queue-wait boundary. Mark the selected child interrupted, invalidate its ticket, remove the owner registration using normal cancel and its synchronous peer callback routing, then publish Interrupted and resume the child. Never mark the child completed or drop it to implement semantic interruption. Repeated interruption after completion is a no-op.
- **QINT-003 — Sequential parent settlement.** The parent visits slots0 then1 and fully runs each selected child's non-suspending cleanup. A cleanup may complete its sibling normally through a Queue callback before that sibling is visited. Retain completed-future guards; report completion only after both actual child futures are done. The old abandoning cancel and whole-driver Drop retain their narrower resource-hygiene meaning.
- **QINT-004 — Narrow masking.** The first cleanup operation helper is masked Queue shutdown, which cannot wait. It bypasses the persistent child interrupt bit; ordinary cancellable requests after interruption immediately return Interrupted. Do not make all future work on that child silently uninterruptible. Synchronous fixed-array logging is the other cleanup workload. Unknown Pending and a cleanup that genuinely suspends remain refused; this step is not asynchronous finalizer settlement.
- **QINT-005 — Evidence before native admission.** Compare plain cleanup and shutdown-induced sibling completion against public official Fiber.interruptAll/ensuring, including unregister-before-cleanup and cleanup-before-parent-return. Test repeated interruption, distinct shutdown false/terminal interruption, an interrupting child whose next ordinary request is refused, and a negative mutation dropping the child instead of resuming cleanup. Measure actual layouts and zero allocations. Whole-program receipts, failure frames, typed Cause/Exit, host cancellation, request Drop/select, suspended cleanup and checked generated lowering remain open.

## Alternatives and limits

Abandoning a child future removes its registration but skips authored cleanup. Broadcast-first parent interruption matches neither the demonstrated callback ordering nor Effect's sequential interruptAll. Treating interruption as false corrupts offer semantics. Always masking the entire child allows later ordinary requests to run after cancellation. Keep explicit interruption separate from scoped Drop fallback, and keep the masked helper narrow until existing AsyncContext/finalizer machinery is integrated into checked lowering.

This is a private two-child serialized experiment with Never/Unit child completion. Native control results do not establish full Effect Exit/Cause agreement or general resource cleanup. No new authoring exports, public Queue selection or baseline upgrade is introduced.

## Delivered evidence

Ten official traces match in debug/release, including plain sequential child cleanup and shutdown cleanup that completes its sibling normally. Native control interruption remains distinct from successful offer false and owner terminal/Done. Repeated interrupt-all is a no-op after actual completion; a separate local misuse probe verifies sticky interruption refuses a subsequent ordinary request without registering or buffering it.

Four negative mutations fail: delayed producer continuation, missing scoped Drop, abandoning an interrupted child instead of pumping cleanup, and reversing child interruption order. The last mutation prevents the first cleanup from completing its sibling normally. Independent source/fixture review found no ordering, generation, masking or completion blocker within this synchronous subset.

The three Queue suites pass16 tests with native builds serial. Quiet1000 rounds include complete execution, Open Drop, Closing close, plain interruption and shutdown interruption; all allocate0 times. Linux owner/bank/borrowed driver/ordinary producer/consumer sizes remain120/144/72/168/152 bytes; the actual interruption-cleanup child futures measure128/120 bytes. This remains fixture evidence, not default-context operation receipts or generated root/context cost. Individual request Drop/select, suspending/fallible/nested finalizers, full Cause/Exit/failure frames, hosted cancellation and checked native/public admission remain open.

Validation commands: `vp test packages/reffect/tests/queue-continuation-runtime.test.ts packages/reffect/tests/queue-bounded-runtime.test.ts packages/reffect/tests/queue-ir.test.ts --maxWorkers=1` after sourcing Cargo; `vp check`; `tsc --noEmit --strict --project packages/reffect/tsconfig.json`; `vp run -r build` (4/4 cached). All pass. Native builds run serially.
