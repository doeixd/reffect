# Private scoped Semaphore IR preparation

Recorded 2026-10-06 before implementation against installed Effect 4.0.0.
This supplements [lexical coordination](lexical-coordination.md) and
[coordination modules](coordination-modules.md); neither historical proposal
establishes public support. Deferred's owned execution and generated profile
remain unchanged.

Primary sources checked: installed `effect/src/Semaphore.ts` and the pinned
[upstream source](https://unpkg.com/effect@4.0.0/src/Semaphore.ts), including
`SemaphoreImpl.take`, `updateTaken`, and `withPermits`. Workstream conventions,
lexical Ref/Deferred elaboration, checker bindings, ordinary/framed reference
interpreters, and capture substitution were reviewed.

SIR-001: use dedicated `SemaphoreMake { capacity }`, `SemaphoreScope { capacity,
binder, body }`, and `SemaphoreWithPermits { binder, permits, body }` nodes.
Direct flatMap of make elaborates allocation into its lexical owner. The handle
is a compiler witness, never an ordinary expression or public native channel.
No metadata is added to scalar values. Capacity is a positive safe integral
literal and this first experimental slice admits only one-permit requests.
Zero, negative, fractional, resizing, manual imbalance, and mixed-size acquisition
are refused rather than assigned alternative semantics.

SIR-002: the reference interpreter uses official `Semaphore.make` and the lexical
instance's `withPermits`. Upstream masks acquisition bookkeeping, restores
interruptibility for pending acquisition and the guarded body, and returns
permits after body finalization. A canceled waiter must never run its body;
a canceled holder must finalize before reuse. Matching method names alone does
not prove a native adapter correct.

SIR-003: retain a private experimental boundary. Public native admission stays
refused until owned scheduler/callback budgets, cancellation handoff, waiter
routing, bounded observation and native costs are proved. Task-group borrowing
may share this lexical coordinator but cannot leak it or turn it into a Ref/file
capture. The checker must verify the exact live owner and preserve body channels.
Public promotion and any broader permit domain require separate decisions.

## Implementation and reference evidence

The private builder, lexical checker/elaboration and both reference interpreters
now implement the three-node contract. Capture substitution traverses owner and
guarded bodies; guarded effects are async and handle-containing values are
refused at ordinary expressions and exported channels. Framed typed failures
add `semaphoreWithPermits` then `semaphoreScope` after the body's own frames.
This is internal support and does not establish public/native admission.

`vp test packages/reffect/tests/semaphore-ir.test.ts --maxWorkers=1` passes
**6/6** (2026-10-06). It verifies retained success channels, curried permit reuse,
invalid capacities/escaped owners, outer-expression substitution, fresh ownership
on concurrent reference runs and typed failure/finalizer-before-recovery reuse.
Cause assertions compare observable reason/payload rather than upstream private
stack annotations. No native Cargo tests were run for this IR-owned work.
