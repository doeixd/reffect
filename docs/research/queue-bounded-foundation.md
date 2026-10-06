# Bounded Queue foundation

Recorded 2026-10-06 before implementation. This is a private protocol foundation, not public Queue admission or generated async execution.

## Evidence

Effect 4.0.0's [Queue.ts](https://unpkg.com/effect@4.0.0/src/Queue.ts) is byte-identical to the installed source, SHA-256 `6781fd0ac6fad03057ebeaa838d0f9723913027a4f6845d57dc3c17da70d1953`. Relevant sections: offerUnsafe (780), failCauseUnsafe (1226), shutdownUnsafe (1446), take (1888), takeUnsafe (2021), releaseTakers (2440), registration cleanup (2495), releaseCapacity (2546), finalize (2593). Controlled official-source probes establish the contracts below. This updates the older channel research's release-candidate evidence only for this slice.

## Decisions

- **QBF-001 — Separate lifecycle and termination.** Lifecycle is Open, Closing or Done; terminal category is normal Done or interruption in this slice. Buffered values remain distinct from termination. Typed failures, defects and full Cause representation need separate IR/native witnesses; never substitute Option.None, Unit or a user payload for Done. Upstream failCause preserves the original failure; it does not append Done to typed failures.
- **QBF-002 — Bounded inline storage.** First adapter uses a positive constant capacity, Copy scalar payloads, suspend strategy and a fixed registration bank. No per-message metadata, Arc, heap queue or unconditional Tokio dependency. A short Mutex protects mutations, released before callbacks. The host serializes dispatcher operations and synchronously drives each selected continuation; the lock alone does not prove multithreaded callback ordering. Record measured layouts and allocations independently from generated future costs.
- **QBF-003 — Retry wakeups and live scans.** Waiting takers receive a retry signal with no value reservation. Offer buffers before scheduling release. An immediate take may steal that value before the scheduled pass. Release visits live registrations in ticket order, removes a registration before callback and rechecks state after callback. This is not Latch's detached cohort or Tokio mpsc's single receiver/reservation contract.
- **QBF-004 — Closing drains registered producers.** End refuses new offers but retains already-registered offers. Taking a buffered value admits pending payloads before the taker's continuation resumes. Producer callbacks can reenter operations; mutations must precede callback and locks must not cross callback. Closing finalizes only after both buffer and pending offers are empty. Cancellation of the last pending offer can finalize an empty Closing queue.
- **QBF-005 — Terminal ordering and cancellation.** Shutdown clears buffered values, changes Open to interrupted Done, preserves a Closing terminal, resumes terminal takers before completing pending offers with successful false. Each registration has a monotonic ticket; removal must match the ticket, so a stale cancellation cannot remove a reused slot. Admission transfers payload before producer true; cancellation after admission cannot retract it.
- **QBF-006 — Explicit private protocol boundary.** First implementation exposes synchronous protocol operations with explicit callback routing and cancellation. It is not a Future or RAII lease adapter: cancellation may synchronously trigger terminal callbacks, which a bare Drop cannot silently defer. Future ownership, Drop integration, task/dispatcher routing and generated helper composition remain gates. Do not advertise public authoring builders or Compile support from these local tests.
- **QBF-007 — Admission sequence.** After protocol conformance: lexical typed IR/reference, explicit unit Done witness, structured compiler refusals and escape/provenance audit; then private generated All2/3 with default-scheduler operation receipts, cancellation and masked cleanup, both frame policies, debug/release future layout and allocation measurements; finally owned execution/public exports. Preserve default automatic yields and existing coordinator profiles. Capacity zero, unbounded/dropping/sliding, batches, richer errors, mixed owners, escaping handles, streams and RPC remain separate gates.

## Acceptance workloads

Compare controlled traces with official Effect: full A/pending B/end drains A then B then Done; cancel pending B admits no B; cancelled empty taker cannot consume a later A; scheduled taker does not reserve A; live callbacks may register another ready taker; shutdown Open yields interruption and pending false, while end/shutdown preserves Done; producer resume happens during capacity release before taker continuation; cancellation slot reuse rejects stale tickets. Run native protocol tests in debug and release, serially. Measure quiet adapter operations with a counting allocator, excluding trace logging and host setup.

Negative mutations should fail: reserving values at wakeup, dropping pending offers on end, overwriting Done on shutdown, keeping cancelled registrations, or detaching taker cohorts. Local category tests do not prove full Cause identity or general fiber scheduling.

## Upstream reentrant shutdown defect — QBF-UPSTREAM-001

Confirmed in pinned Effect4.0.0, using public APIs:

```ts
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const q = yield* Queue.bounded<string>(2);
    yield* Queue.offer(q, "A");
    yield* Queue.offer(q, "Z");
    yield* Effect.forkChild(Effect.andThen(Queue.offer(q, "B"), Queue.shutdown(q)), {
      startImmediately: true,
    });
    yield* Effect.forkChild(Queue.offer(q, "C"), { startImmediately: true });
    return yield* Effect.exit(Queue.take(q));
  }),
);
```

The take defects with `TypeError: Cannot read properties of undefined (reading 'delete')` at Queue.ts:2569. Capacity release admits B, whose resumed producer shuts down and completes C with false. The outer releaseCapacity continues its captured offers Set and attempts `self.state.offers.delete` after state became Done. Published and installed source are identical. No upstream issue was filed in this bout.

The private adapter rechecks lifecycle after callbacks and safely stops; this local difference is intentional and is recorded in [the divergence register](../native-divergences.md#private-queue-protocol-difference). Generated/public admission must refuse or explicitly resolve reentrant terminal operations with remaining pending offers before claiming parity. A native protocol safety check is not a proof that this topology matches official Effect. Ordinary end/shutdown workloads and callbacks without this topology retain differential obligations.

## Delivered evidence

The private `queueBoundedRuntime` emitter uses a fixed combined bank (one active registration per task, at most4) and monotonic tickets. Explicit callback notices are Retry, Offer(Boolean) and Terminal; registration is removed before resumption, and Done cancellation leaves outstanding completions intact. Debug/release traces agree with official Effect in seven controlled scenarios. Local safety/edge assertions cover ticket reuse, irrevocable admission, terminal callback cancellation and the separately recorded upstream defect topology. Mutation experiments removing the Done guard, overwriting the Closing terminal and snapshotting the live scan all fail; original source is restored.

On this Linux toolchain, Bool/Unit/U64 owners are136/136/184 bytes at capacity1 and136/136/216 at capacity3, with four registration slots. The u64 registration bank is128 bytes. Construction plus1,000 quiet registration/cancel/admission/dispatch cycles allocate0 times. Trace allocation and generated future/context/dispatcher costs are outside this measurement. No new Cargo dependency or production selection is introduced.

The official typed oracle explicitly uses `Queue.bounded<string, Cause.Done>(1)` when calling end. Upstream defaults E to never; do not silently change that default or allow the future IR to report take's error as Never after normal Done termination. End requires a representable terminal error witness; interruption remains distinct from ordinary typed failure.

## Resume

Use `queue-bounded-runtime.ts` and `queue-bounded-runtime.test.ts` for the private protocol. Follow [channel decisions](channel-stream-modules.md) and [coordination ownership](coordination-modules.md). Next implement typed lexical IR and official reference execution without widening native admission. The generated driver must resume producers within capacity release, before returning to a consuming continuation; a generic delayed waker is insufficient without conformance evidence.
