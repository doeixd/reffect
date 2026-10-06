# Semaphore traversal integration preparation

Recorded 2026-10-06 against installed Effect 4.0.0 before traversal changes.
This supports [the private Semaphore IR](semaphore-ir.md) and follows the
[Effect v4 workstream](../effect-v4-workstream.md). It does not admit Semaphore
into public Compile, DeferredExecution or native request profiles.

Sources checked: the installed `effect/src/Semaphore.ts`, also available in the
[pinned primary source](https://unpkg.com/effect@4.0.0/src/Semaphore.ts), particularly
`take`, `releaseUnsafe`, and `withPermits`; current nesting, provenance, Scope,
structured-concurrency and Deferred admission visitors. Upstream release schedules
waiter observers, and `withPermits` masks bookkeeping while restoring the wait/body.
Those receipts are absent from the Deferred operation-budget proof.

STRAV-001: generic structural visitors traverse SemaphoreScope and
SemaphoreWithPermits bodies. SemaphoreMake has no authored child. The iterative
nesting visitor already discovers these children without tag changes. Provenance
records body occurrences rather than hiding source nodes beneath a new coordinator.

STRAV-002: Scope analysis retains registrations in a permit body, because acquiring
permits creates no resource Scope. Delayed registered cleanup cannot capture a
lexical Semaphore owner. This uses the existing resource-escape policy; it is not
an assumption that permit release may precede body finalization.

STRAV-003: structured-concurrency analysis walks both bodies in their original
child/cleanup context. Semaphore is conservatively a retained-failure risk until
its asynchronous cancellation adapter is proved. Deferred topology sees children
for its task bound but does not count Semaphore owners as Deferred owners or
pretend acquisition has a verified Deferred callback budget.

STRAV-004: bounded Deferred budget, trusted execution, generated profile, growth and
interruption-frame visitors refuse Semaphore nodes. Adding permissive traversal
would incorrectly widen an existing public proof. The ordinary reference interpreter
is the only admitted execution path for this experimental IR, using official
Semaphore operations as recorded in the IR preparation.

Validation: strict TypeScript catches missing exhaustive visitors; existing Scope,
structured-concurrency, provenance and bounded Deferred tests must remain green.
Semaphore conformance must test cancellation of a waiting acquisition, holder
finalization before re-acquisition and explicit mixed-Deferred refusal. Native
admission remains a separate future decision.

## Implementation evidence

The structural visitors now walk permit bodies and lexical owners. Scope checks
reject both addFinalizer and acquireRelease callbacks that retain an owner.
Deferred budget/profile handlers explicitly refuse all three new tags; the growth,
trusted-reference and interruption-frame visitors retain their existing fail-closed
fallbacks. No new Deferred receipt or native runtime representation was added.

`vp test packages/reffect/tests/semaphore-traversals.test.ts --maxWorkers=1`
passes 3/3 (1.83 s): child Clock paths and provenance remain visible, registration
capacity is retained correctly, delayed captures are refused, and a mixed Deferred
execution produces no authored logs before rejection. These tests use no Cargo.

Review clarification: the delayed-cleanup refusal is conservative for all Semaphore acquisitions, even if the owner is created locally inside registered cleanup. It does not implement precise outer-owner capture inference. Keep that broader refusal documented until a lifetime-aware narrowing is proved.
