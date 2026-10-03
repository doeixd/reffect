# Fallible structured task conformance

Preparation checked 2026-10-03 against installed Effect 4.0.0 and the [published implementation](https://unpkg.com/effect@4.0.0/src/internal/effect.ts). This is the evidence companion to the runtime design; it does not by itself establish native support.

## Independent oracle observations

The official programs are authored with Effect, Deferred and Fiber directly, independently of the R graph and reference interpreter.

- All reports failing children in **completed exit order**, after their cleanup. Two masked failing children whose cleanup is released B then A produce Fail(B), Fail(A). This differs from input order.
- All removes interruption reasons from later sibling exits after selecting its terminal failure; ordinary cancellation of a sibling must not add a spurious reason.
- Parent interruption while a failing All child's masked cleanup is suspended can yield Interrupt followed by Fail(error). Surrounding Effect.catch and Effect.result do not run recovery while that parent interruption is pending. Merely finding a Fail reason is insufficient permission to execute recovery.
- Under the same pending-parent-cancellation fixture, Race reports Interrupt alone. All and Race do not share a blanket failure-combination policy.
- Repeated scalar failure values collapse when All combines child Causes, but Race's accumulated all-failed reasons retain duplicates. Equal u64/bool/Unit payloads need the official All equality behavior; arbitrary structural payload equality is a separate admission gate.
- Start barriers must identify a genuinely suspended cleanup. A Deferred completion can resume the parent synchronously before the child reaches its following await. The probe yields the official dispatcher after receiving the start signal, and between releasing completion gates. Omitting that scheduling step produced misleading singleton-only results.
- A direct fail with ensuring has different cancellation behavior from All's callback lifecycle. Its pending cancellation can retain the Fail outcome while skipping a surrounding recovery callback. Tests must exercise the admitted composition rather than extrapolating a blanket projection law.

## Validation decisions

| ID           | Decision                                                                                                                                                                     | Reason / revisit trigger                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| FALLCONF-001 | Author official fixtures separately; compare ordered observable reasons and cleanup events, never only a success/interrupted Boolean.                                        | Avoid shared interpreter bugs and erased mixed failures.                           |
| FALLCONF-002 | Use explicit completion/cancellation barriers or a controlled virtual timer; do not use wall-clock sleeps as an ordering proof.                                              | Close races around masked cleanup and observer admission.                          |
| FALLCONF-003 | Assert cleanup order as required partial orders; preserve reason order exactly when the fixture controls it.                                                                 | Independent child scheduling is otherwise unconstrained.                           |
| FALLCONF-004 | Keep interrupt identity and diagnostic frames distinct from the admitted semantic reason projection. Assert all represented reason kinds and reject unexpected Die outcomes. | The bounded native profile does not establish arbitrary Fiber identity or defects. |
| FALLCONF-005 | Check debug/release and both failure-frame policies, plus existing infallible allocation/layout regressions.                                                                 | Cause storage must not silently tax the old Never task path.                       |

## Required acceptance matrix

All: success, immediate failure preventing later admission, suspended failure cancelling a sibling only after its own finalization, two independently completed failures, duplicate failure behavior, and parent cancellation during both failing-child and already-selected sibling cleanup.

Race: failure followed by success, success cancelling and awaiting a loser, all-failed completion order (including duplicates), and parent cancellation during failure cleanup or loser cleanup after a winner.

Observers: typed recovery and result selection for non-interrupted multiple failure; pending interruption suppressing recovery; masked acquisition ownership/restoration; child and parent finalization traces. Unsupported Cause observers must remain explicit refusals rather than be tested through an erased projection.

Native fixtures observe the generated runtime carrier directly from a harness, without widening the public Fail-only Cause value witness. The approved design uses reachability-gated Combined outcomes containing bounded scalar RuntimeFailure values independently of the current function error channel. This preserves canceled catch/result outcomes even when the current channel is Never; semantic payloads remain separate from logical trails. Bool/u64/Unit are admitted; arbitrary payloads and general Cause observers are not established by this harness.

## Controlled timer proof

The installed `effect/testing` TestClock supplies a practical independent oracle without real timer ordering. Each child uses acquireUseRelease with a failing masked acquisition; ensuring logs its cleanup entry, sleeps on the test clock, and logs its exit. Child A cleanup takes 20 ms of virtual time, child B takes 10 ms. Advancing 10 ms twice produces cleanup B then A and reasons Fail(B), Fail(A). All collapses repeated scalar errors; Race retains both. Advancing zero first parks the children before parent interruption, giving All Interrupt+Fail(A) versus Race Interrupt only when B remains pending.

The corresponding native harness may add Tokio's `test-util` feature **only to its temporary Cargo manifest**, pause the current-thread clock, poll the complete parent future to Pending, advance virtual time, and poll again. Production dependency selection must remain unchanged. Manual polling is specific to these known fixtures: an arbitrary first Pending does not prove that every possible program has reached the desired barrier.

Cancellation delivery is polled before advancing the clock, so canceled sibling cleanup starts at the intended virtual timestamp. The cancellation-after-terminal-failure fixture advances 6 ms across a 5 ms timer boundary before polling and interrupting: Tokio's millisecond timer wheel can leave an exactly-boundary timer pending. Both official/native programs assert that failing-child cleanup finishes before sibling cleanup begins; a virtual timestamp alone is not the assertion.

The implemented test matrix additionally covers the three-failure capacity boundary, Bool and Unit error payloads, masked acquisition allowing typed recovery before interruption restoration, its awaited release, and a structured refusal for interruption-retained composite recovery with a legacy recovery control. NativeRunner's normal CLI decodes a two-reason Race outcome under None/Bounded policies; Bounded runWithFrames reports its logical trail.

## Validation snapshot

`fallible-concurrency.test.ts` passed three tests: independently authored official/plain/framed reference comparison across 17 scenarios; composite retention refusal and unchanged legacy recovery; and native conformance across all 17 scenarios under debug/release and None/Bounded failure-frame policies, including normal CLI multi-reason decoding. The final Cargo run took 131.76 seconds of test execution (136.19 seconds total) with concurrent workspace validation. Package strict TypeScript also passed. The performance agent's separate cost fixture owns allocation/layout evidence; this document does not infer zero allocation from a fixed Cause array.
