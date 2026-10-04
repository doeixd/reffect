# Deferred bounded semantic-turn prototype

Prepared 2026-10-04, before feature edits. This is an internal kernel experiment, not admitted Deferred authoring support. Read AGENTS, PLAN, PROGRESS, the structured coordinator and [LCOORD-009/010](lexical-coordination.md#deferred-completion-scheduling-gate-2026-10-03), plus [DN-007](deferred-native.md). Checked the published [Effect 4.0.0 Deferred](https://unpkg.com/effect@4.0.0/src/Deferred.ts) and [internal evaluator](https://unpkg.com/effect@4.0.0/src/internal/effect.ts) against installed source. `doneUnsafe` detaches callbacks, resumes them in registration order and returns after their synchronous prefixes. The callback primitive resumes a suspended fiber through `fiber.evaluate`.

## Candidate and decisions

**DTP-001 — Route requests through an inline turn bank.** A checked invocation owns a fixed Mutex-protected stack. A frame contains the completing caller slot, selected waiter slot and acknowledgement Boolean. Primitive semantic suspension or whole-task completion acknowledges the selected waiter. Adapter-internal Pending does not. There is no counter, pointer to sibling futures, thread-local current task or general task registry. Only reached coordination eventually receives this bank; ordinary AsyncContext and scalar values remain unchanged.

**DTP-002 — Gate polling, rather than merely prefer polling.** While a frame is active, only its selected task (or an enclosing coordinator routing to that descendant) runs. After acknowledgement, only the completing caller runs, pops its frame, releases the next registered waiter or returns Ready. Allowing unrelated runnable children while the request is pending changes synchronous broadcast order. Child futures remain safely pinned and polled by their owning coordinator, never through a reference stored in Deferred state.

**DTP-003 — Completion and its following prefix stay in the same Rust poll.** Returning Ready from an awaited completion resumes the caller's async continuation immediately in that same poll. Thus popping the finished frame cannot allow a different child between completion return and `producer:true`. If future lowering splits those into independently scheduled futures, it must retain an explicit ResumeProducer phase instead. A caller resumed inside an outer completion remains the outer target: nested adapter Pending does not acknowledge the outer frame.

**DTP-004 — Bound simultaneous active completion callers, independently of owner count.** Each frame has a distinct blocked caller. One future cannot execute a second completion while its first is pending. A caller cannot be assigned a new registration while its own active completion is pending. This permits a stack bound by checked live task contexts, rather than all statically authored owners or a monotonic generation. Repeated sequential calls reuse cleared frames. The proposed profile still refuses task-group creation in a resumed waiter continuation until its startup/ancestor-routing semantics are proved.

**DTP-005 — Broadcast itself does not observe producer cancellation.** Completion installs its retained outcome and drains its detached ordered cohort even when a callback interrupts the producer. The caller restores its pre-existing interruptibility after completion and checks pending cancellation before its next continuation. A masked caller may run that continuation and becomes interrupted at its existing restoration boundary. Actual watch-driven cancellation and async finalizers require an integration proof; an AtomicBool simulation is evidence only for the kernel trace shape.

## Initial runnable evidence

The temporary safe Rust prototype at `/tmp/reffect-turn-prototype/main.rs` compiles with Rust 1.98.1 and no dependencies. It independently models inline retained state, removable linked waiter slots, a bounded turn bank and manually polled async tasks. It has no unsafe code or peer-future references. The first harness uses Box only to store heterogeneous test futures; the production candidate must use fixed-arity pinned futures.

Exact assertions pass for registration reversal, nested completion, nested semantic yield, producer interruption with the remaining cohort still resumed and mask restoration:

- `w1:resumed, other:resumed, nested:true, w2:resumed, producer:true`
- `w1:resumed, other:resumed, nested:true, w2:resumed, producer:true, other:after-yield`
- `w2:resumed, w1:resumed, other:resumed, nested:true, producer:true`
- `w1:resumed, interrupt-producer, w2:resumed, producer:cleanup`
- `w1:resumed, interrupt-producer, w2:resumed, producer:true, producer:cleanup`

This does not discharge public acceptance: the temporary test does not use stock watch cancellation, nested task-group routing, actual finalizer suspension, independent waiter interruption, allocation accounting, full Cause behavior or automatic scheduler yields. The state fixture stores a single u64 success solely to isolate the scheduling protocol.

## Implementation and acceptance boundary

The first checked-in change is a focused, unused internal emitter and a kernel test. No authoring export, compiler visitor or normal generated artifact may start depending on it. Validate fixed-arity safe pinning, selected-descendant routing, Boolean slot reuse, executor wake discipline and nested semantic versus adapter suspension before integrating with the lexical owner implementation. Add real watch cancellation with awaited cleanup, controlled stable Effect trace oracles and None-policy construction/registration/completion allocation accounting. Preserve the existing reachability and fallible-group restrictions.

Automatic scheduler yield is a separate outstanding issue: the stable evaluator consults `scheduler.shouldYield`, while native synchronous prefixes currently have no matched evaluator operation budget. A completion adapter must not claim unlimited synchronous waiter execution agrees with every Effect scheduler configuration. Resolve a checked prefix/profile bound or an explicit scheduler contract before enabling Deferred. A timer-free short trace proof cannot establish that broader claim.

## Internal kernel experiment completed (2026-10-04)

The unused `src/deferred-turn-runtime.ts` emitter now contains the invocation-owned turn bank only. It has no compiler/authoring integration. `tests/deferred-turn-runtime.test.ts` emits an independently authored Rust protocol fixture around that bank and compares seven exact traces with the independent stock Effect oracle in `tests/fixtures/deferred-turn-oracle.ts`.

The fixture uses safely pinned fixed-arity futures, a root driver that rechecks priority after every child poll, a nested two-child driver routing through one outer future, and task wrappers that acknowledge their own semantic suspension rather than an ancestor's Pending. Only changed adapter progress is retried. A bounded per-poll adapter burst wakes the executor and returns Pending when exhausted; unchanged genuine Pending waits for its actual executor Waker. No sibling future pointers, heap task boxes or unsafe polling appear in the protocol. Actual Tokio yield, watch cancellation and timer readiness progress under a two-second timeout, rather than an eager manual retry executor.

Debug and release pass with pinned Tokio 1.53.1, edition 2021 and Rust 1.98.1. Seven callback traces agree exactly, including interruption of the next waiter and interrupted/masked producer broadcasts. The producer cancellation fixture awaits its cleanup timer before the fixed-arity driver returns; this is an actual finalizer-future experiment, not generated Scope conformance. Mask restoration and scalar retained state are fixture code, not methods supplied by the bank emitter. The nested driver demonstrates routing through a safely pinned parent future; it does not establish compiler admission of nested TaskGroups.

One hundred Boolean request/acknowledgement cycles reuse the same bank; completed frames clear and no generation counters exist. One hundred parked await/drop cycles reclaim every waiter registration. A warmed isolated allocator probe measures zero allocations for 100 inline bank construction/request/acknowledgement/drop cycles using `Waker::noop`. It excludes trace Vec, Tokio executor, watch channels and test owner state; it does not establish complete Deferred execution allocation cost. The allocator uses the standard unsafe GlobalAlloc interface solely in measurement code; the emitted bank and coordinator polling stay safe Rust. Measured Linux layouts are bank 168 bytes for six slots, bank state 160 bytes and individual turn 24 bytes, unchanged between debug/release. No frame trail policy is added; this is the disabled-diagnostics core measurement.

A host that force-drops the enclosing parent future can abandon its detached broadcast and async cleanup. That remains the existing trusted-host/drop limitation; represented interruption instead keeps polling and drains the cohort. The invocation owns all borrowed futures/state and the turn bank, so this limitation does not justify retaining peer references or leaking global scheduler state.

Still outstanding before public admission: generated owner/lowering integration, proven per-invocation static slot assignment, actual generated Scope/mask restoration, independent authored waiter cancellation, frame-policy and owner/continuation layout costs, retained/peak complete-execution allocations, and scheduler operation-budget policy. These kernel tests are protocol evidence, not an implementation of the entire Deferred module.
