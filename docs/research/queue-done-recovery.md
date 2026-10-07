# Private Queue Done carrier and local recovery

Prepared 2026-10-07 before feature code against PLAN/PROGRESS, QTERM, QIR, QPUB, Queue protocol/bridge, compiler marker audits and existing CatchAll lowering. This verifies a typed native substrate for local recovery; it does not admit generated completion programs.

## Primary evidence

Fresh Effect 4.0.0 [Queue.ts](https://unpkg.com/effect@4.0.0/src/Queue.ts) and [internal/effect.ts](https://unpkg.com/effect@4.0.0/src/internal/effect.ts) retain SHA-256 `6781fd0ac6fad03057ebeaa838d0f9723913027a4f6845d57dc3c17da70d1953` and `68c43e18e167d17b39f224d3793f11c7732cd857b7908ecd3ff1d1edf0affac2`. Fresh [Cause.ts](https://unpkg.com/effect@4.0.0/src/Cause.ts) (`1291ff90df538c8d52d171a36a2ce90a52c8ab7505b9318e18236114673279db`) defines typed Done with an optional leftover value. [Pull.ts](https://unpkg.com/effect@4.0.0/src/Pull.ts) (`5e3168eb4cf18fa9cafa4afebd18ffd20c5e563f2ea77667700f1a91b053f77c`) distinguishes Done recovery and mixed-Cause filtering. Effect v4's public typed recovery is `Effect.catch`; reffect retains a CatchAll IR node and compatibility alias. Interruption bypasses the typed handler. This slice supports only unit Done and single local failures, not Pull's general leftover/combined-Cause semantics.

## Decisions before implementation

- **QDONE-001 — Distinct zero-sized Done value.** Emit a private `QueueDone` struct, never an alias for Unit, Bool, Option or a payload. A private QueueTakeFailure enum holds Done(QueueDone), owner interruption and requesting-child control interruption separately. Add take_done_exit translating existing take_exit, preserving scalar success directly. No owner/bridge fields, heap envelope, per-value metadata or new crates. This raw-driver carrier does not replace QueueDoneType's deliberately unadmitted IR native marker or promise JavaScript object identity.
- **QDONE-002 — Static local recovery.** A generic private queue_catch_done future awaits its source, returns scalar success unchanged, invokes its FnOnce handler only for Done, and propagates both interruption categories unchanged. The handler receives the typed QueueDone and returns a statically stored recovery future. Borrowed Queue operations may occur in that recovery; no boxes, dynamic dispatch or new scheduler. Recovery failure remains failure. This models Effect.catch when Done is the sole domain error, not general mixed-Cause Pull.catchDone.
- **QDONE-003 — Preserve driver lifetime and cancellation boundaries.** Take retirement returns the bridge slot to Idle before a recovery may post another operation; synchronous terminal peer recovery must finish before the initiating End returns. Actual driver interruption must bypass the handler and unregister before completion. Explicit masked cleanup remains separate. Source/recovery futures are ordinary owned Rust fields; whole-driver Drop still retires registrations without implementing semantic finalization. Foreign pending, host abandonment, Send/RPC and retained failures across groups are not proved here.
- **QDONE-004 — Keep compiler gates explicit.** Public constructors remain Never/end-free. Neither generic nor public lowering selects this raw helper. Checked generated local Done needs new Queue CatchAll/End/shutdown operation receipts, full-edge growth traversal, marker-aware narrow selection, a proven native type mapping, frame reset/recovery rules and returned-root costs. Current Queue profiles and marker/host refusals stay unchanged; do not broaden them based on this fixture.
- **QDONE-005 — Acceptance.** Compare official Effect.catch traces for success bypass, completed Done recovery, recovery with another Queue operation, failure from the handler, Open-shutdown interruption bypass, and actual child cancellation. Cover Bool/U64/Unit success, repeated failure, unopened handler paths and settled children. Rust compile-fail proves Done is not Unit. Negative mutations recover interruption, discard handler failure or erase Done's category. Measure zero-sized Done, error-carrier size, zero quiet allocations and actual child/recovery future layouts in debug/release; retain Queue public/generated/terminal regressions serially.

## Alternatives and next gate

Using QueueTerminal::Done without a typed value loses the handler payload type contract. Treating typed Done as AsyncError::Interrupted prevents recovery. A heap-backed JS-shaped Cause envelope adds unnecessary storage for a unit-only local channel. A separate generated scheduler would duplicate the proved bridge. Reuse the inline enum and borrowed protocol first.

Next integrate an explicitly checked local Done profile into private generated lowering, with default2048 receipts, growth, both failure-frame policies and actual emitted/root costs. Retained/fail-fast Done across All, generated finalizers/timers and public completion admission remain subsequent gates. The pinned reentrant shutdown defect is already fixed upstream; no issue or baseline upgrade. PLAN.md belongs to the core instance and is unchanged.

## Delivered private extension

`take_done_exit` preserves scalar success and returns the distinct inline failure carrier. `queue_catch_done` stores generic source/handler futures directly and invokes its FnOnce handler only for typed Done. Owner and child control interruptions bypass it; recovery failure propagates unchanged. Recovery can post another Queue operation after the original request retires. No compiler/profile/public admission changes.

The differential fixture covers seven U64 trace families plus Bool and Unit success/recovery against official Effect.catch. Debug and release agree. Four deliberate mutations fail the interruption, Done-category and recovery-failure contracts; a Rust compile-fail rejects a Unit-typed Done handler. Nine families over 1,000 quiet rounds allocate zero times. QueueDone occupies zero bytes and QueueTakeFailure one byte. Actual child future pairs are `360/120` bytes for each U64 family and `96/208` for Bool and Unit, below the fixture's 512-byte per-child gate. These are borrowed-driver fixture costs, excluding host setup/output and compiler memory; they do not establish generated root/frame costs. Independent read-only review found no material blocker.

Exact validation commands (source Cargo first and run native builds serially):

```bash
vp test packages/reffect/tests/queue-done-recovery.test.ts packages/reffect/tests/queue-terminal-control.test.ts packages/reffect/tests/queue-continuation-runtime.test.ts packages/reffect/tests/queue-bounded-runtime.test.ts packages/reffect/tests/queue-host-runtime.test.ts packages/reffect/tests/queue-generated.test.ts packages/reffect/tests/queue-generated-frames.test.ts packages/reffect/tests/queue-public.test.ts packages/reffect/tests/queue-ir.test.ts --maxWorkers=1
tsc --noEmit --strict --project packages/reffect/tsconfig.json
vp check
vp run -r build
```

Results are recorded in PROGRESS.md after verification. Run these checks again after the focused commit before pushing.
