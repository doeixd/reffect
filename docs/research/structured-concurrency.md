# Bounded structured concurrency preparation

Status: bounded Unit/Never kernel implemented with [conformance evidence](structured-concurrency-conformance.md). Admission contract recorded before feature implementation on **2026-10-03**. This record updates the prerequisite in [coordination modules](coordination-modules.md); it does not admit general Fiber APIs or change PLAN.md. Installed dependency: **Effect 4.0.0 stable**. Previous coordinator research used rc.118; do not assume those observations establish the stable task-group behavior.

## Primary sources checked online

- Published [Effect API](https://unpkg.com/effect@4.0.0/src/Effect.ts): `all` options and success/error shapes.
- Published [internal Effect implementation](https://unpkg.com/effect@4.0.0/src/internal/effect.ts): `all`, `forEach`, `iterateConcurrentImpl`, `forkUnsafe`, `fiberInterruptAll`, `causeCombine` and `FiberImpl.interruptUnsafe`.
- [Tokio 1.53.1 join](https://docs.rs/tokio/1.53.1/tokio/macro.join.html) and [try_join](https://docs.rs/tokio/1.53.1/tokio/macro.try_join.html): borrowed inline futures, polling order and short-circuit behavior.

The published implementation starts/evaluates children in input order until an immediate failure stops admission. An already-started failing child completes its own finalization before its exit observer cancels remaining children. The group waits for remaining exits. Additional **non-interruption** sibling failure reasons are combined into the terminal Cause; interruption reasons from siblings canceled by the group are filtered. Consequently, "first failure wins" alone is an insufficient native specification.

`forkUnsafe` constructs the child from the parent's Context; All inherits interruptibility, while Race explicitly starts interruptible children. Immutable Context association maps can be inherited, but service values inside that Context retain their identity: cloning a mutable service implementation silently changes the program. The parent does not receive a child's local annotation mutations. Scope in inherited Context is also a shared service; copying a Scope stack into a child is not equivalent.

Project prerequisites reviewed: [Scope registration](resource-scope-registration.md), [native Scope evidence](scope-native-evidence.md), [owned runtime-service decisions](runtime-services-implementation.md), [runtime-service lowering](runtime-services-lowering.md), [metadata cost](../metadata-cost.md), existing `AsyncContext`, lexical Ref/file lowering and Scope analysis. Native contexts currently use a watch receiver for cancellation, owned annotation/span vectors, optional failure trail, bounded Scope frames and optional driver/store/launch fields.

## Chosen first surface

`R.Effect.all([childA, childB], { concurrency: "unbounded", discard: true })`, admitting a compile-time tuple of **two or three Unit/Never computations**. Options are literal and exact. Also admit `R.Effect.race(childA, childB)` and its data-last form for **exactly two Unit/Never computations**, without race options. Both return Unit; no value/resource handle crosses the group boundary. A shared task-group node has mode All or Race. Race success cancels its pending loser and waits for loser cleanup before continuation.

- **All children must have Never error witnesses and Unit success witnesses.** No typed failure is admitted, even if recovery might make a larger design representable. This avoids both multi-child failure combination and mixed parent interruption/failure Cause information loss. Typed fail-fast joins are a later Exit/Cause gate. A common error witness alone does not prevent combined failures.
- Finalizers remain the existing admitted infallible cleanup subset. No group creation inside cleanup. Initially refuse nested groups; later bounds must prove total simultaneously active tasks and account for repeated groups.
- No arbitrary iterable, records, numeric concurrency, sequential/default options, `mode: "result"`, collected output, explicit Fiber handle, race options or fallible races, detached child, dynamic spawn or exposed fiber identity.
- Ordinary immutable represented inputs and statically provided scalar services may be copied/borrowed. Child-local lexical Ref cells and file brackets are safe when the binder originates inside that child; external Ref/file capture is refused. A deliberately more conservative implementation may initially refuse all Ref operations, but should report that narrower limitation.
- Registered resources require an **explicit child-local Scope**. Registrations cannot target the parent's inherited Scope. Existing outer resources can surround the group only if children do not capture their handles or register into them. Child Scope close and every child cleanup finish before the group returns and before enclosing parent cleanup begins.
- Reachable **injected Clock or scripted Random in any child, including cleanup, is refused**. Copying scripts duplicates cursor history; assigning disjoint ranges predicts execution; sharing a driver introduces mutable ownership and interleaving semantics not yet proved. Default live Clock reads are admitted. Services reachable elsewhere in the artifact do not justify silently cloning them into children; analysis should distinguish child reachability from module-wide context layout.
- Remote store/launch participation is explicitly refused in the first profile until host identity and ownership paths receive separate evidence. Never clone a launch sender. Sharing an immutable store reference may become admissible later, but observable mutation interleaving is a distinct workload.

Unsupported admitted-shape violations need structured diagnostics before emission. TypeScript authoring should mirror Effect's name, argument order and options without user casts; construction may accept only the bounded tuple overload, while checker/planner still validates serialized or directly constructed IR.

## Native adapter and lifecycle

Use generated inline futures borrowed from distinct child contexts, pinned within the parent's future. No `tokio::spawn`, thread-local registry, scheduler port, boxed task future or `'static` resource escape is needed. Ordinary `try_join!` is insufficient: early return drops unfinished children and skips awaited async cleanup. `join!` alone does not cancel a race loser. A small generated poll state machine can retain each future/outcome, detect race success after that child's cleanup or parent cancellation, signal every pending sibling, then continue polling until all child cleanup is complete. All success waits for every child. Typed failure-driven cancellation is explicitly deferred.

Each child needs independent cancellation state. Reusing the parent's cancellation receiver alone cannot cancel a race loser without canceling unrelated parent work. Existing watch channels are a compatible first substrate; they allocate during group setup, which must be measured and reported rather than hidden by excluding setup. Parent cancellation must be observed even while the group is already waiting for canceled siblings to finalize. Once interruption is requested, child cleanup remains masked under the existing runtime contract.

Start children in tuple order. In All, an immediate success does not prevent later children from starting. In Race, an immediately completed success prevents later children from starting; a suspended earlier child remains live while subsequent children start. Stable `raceAll` uses `forkUnsafe(..., false)` for child interruptibility, while All inherits parent interruptibility: preserve this distinction when the parent is masked. Do not describe a fixed overall event order for independent ready children as a public fairness guarantee. Avoid head-of-line polling that lets a pending child prevent another child from progressing. Differential fixtures should use deliberate suspension barriers or broad timing separation and assert causal order, rather than brittle equal-deadline wake order.

Child contexts inherit request identity and annotation/span snapshots, not the parent's open Scope stack, launch sender or failure trail. Cloning enabled owned logging vectors/strings may allocate; disabled logging must not allocate merely to represent an empty snapshot. Child annotations must not leak into siblings or back into the parent. Scope finalizers inside the child capture the child's current annotation/span state under existing registration semantics.

The admitted Unit/Never groups have no typed failure trail to transfer. Preserve their occurrence provenance and cancellation observation without fabricating a child failure. A later fallible join must retain the failing child's logical trail, append the group occurrence once and prevent sibling teardown from overwriting it. Disabled frame policy must not create trail storage.

## Why typed failure is deferred

Even a one-fallible-child restriction does **not** eliminate mixed interruption/failure Cause. If a child fails and is running masked cleanup when the parent is interrupted, stable Effect can produce `[Interrupt, Fail(error)]`. Existing native `AsyncError<E> = Fail(E) | Interrupted` cannot retain both. The chosen Unit/Never surface does not introduce a new projection/divergence: it refuses typed children until the Exit/Cause gate. Parent cancellation still awaits every cleanup and bypasses typed recovery.

Host panics/defects, failure inside cleanup, exposed Cause APIs and interrupting-fiber identity remain outside this profile. Previously recorded trusted driver host-fault divergence is unchanged. Returning early while child cleanup is pending is never allowed.

This is a narrower prerequisite than the full [coordination plan](coordination-modules.md): it establishes independently suspended children, loser cancellation, lifetime closure and context isolation. Deferred.fail, typed child completion and general failure joins remain gated by a later represented outcome/Cause design.

## Independent stable-source probes

Run from `packages/reffect` with `node --input-type=module`, using public Effect APIs:

1. `all([ensuring(sleep(40), slowCleanup), ensuring(sleep(2) then fail("bad"), badCleanup)], { concurrency: "unbounded", discard: true })`: trace was `slow:start, bad:start, bad:resume, bad:cleanup:start, bad:cleanup:end, slow:cleanup:start, slow:cleanup:end`; sole Fail reason. This establishes failing-child cleanup precedes sibling cancellation observation for this controlled workload.
2. Two immediate failures: only the first Fail was retained; the later child never started.
3. Two children whose cleanup fails: Cause retained `cleanup-one` and `cleanup-two`; this falsifies selecting one failure merely because both witnesses are String.
4. `runPromiseExit(all([bad after sleep(3) with sleep(15) cleanup, sleep(100) with sleep(15) cleanup]), { signal })`: abort before failure yielded Interrupt; abort during failing-child cleanup yielded Interrupt plus Fail("bad"). Both children logged cleanup completion before the promise resolved. Millisecond timing is exploratory evidence, not a production conformance barrier.

5. Infallible race: controlled winner sleep(3), loser sleep(60), loser cleanup sleep(3), followed by parent continuation sleep(15). Trace: `loser:start, winner, loser:cleanup, loser:cleaned, after-race, parent:end`; loser cleanup is awaited before race continuation. Online `raceAll`/`race` source checks the first success, stops admitting later children after an immediate winner, and interrupts/awaits the remaining fibers via its exit cleanup. Race error handling is intentionally outside the chosen profile.

Raw source snapshots were downloaded to `/tmp/structured-effect-stable.ts` and `/tmp/structured-effect-api.ts`; upstream links above are canonical. These probes are research, not claims of shipped native support.

## Validation and cost gates

- Independent stock Effect, plain and framed reference, native debug/release and both frame policies: All success with independently suspended children, Race winner/loser interruption, immediate Race success skipping later starts, all-finalizers-once, LIFO child registrations, enclosing cleanup after every child cleanup, and parent cancellation.
- Cancel during child or loser cleanup; confirm masked cleanup completes, sibling cleanup also completes, continuation does not run and interruption bypasses typed recovery. Keep mixed failure/interruption research evidence as a refusal rationale, not an admitted conformance claim.
- Context inheritance and isolation: parent annotations/request visible to children, child changes absent from sibling/parent; child-local registered finalizer annotation snapshots preserved.
- Capture/refusal cases: external Ref/file, parent Scope registration, any non-Never or non-Unit child, injected Clock/Random including cleanup, nested groups, unsupported option shapes and host-specific store/launch work.
- Source/provenance and disabled frame absence: group occurrences remain attributable, with no fabricated typed failure trail for Unit/Never children.
- Measure native allocation count including watch-channel/context setup, disabled/enabled context and future sizes, repeated completed groups for retained allocations, generated Rust size/Cargo dependencies and compiler/build time. Prepared harness/runtime setup may be reported separately but cannot make group creation allocations disappear.
- Future drop is not semantically verified interruption: supported hosts must cooperatively cancel and await the parent group. Dropping the whole parent future externally is an explicit unsupported host action until an owned cleanup boundary exists.

## Decisions retained for review

| ID       | Decision                                                                                                                               | Revisit trigger                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| TASK-001 | Static two/three-child Unit/Never `all`, unbounded/discard; two-child Unit/Never `race`; mirror public names and pipeability.          | Multiple typed failures or result collection requires a represented Cause/result tuple.                       |
| TASK-002 | Borrowed inline futures and independent child contexts/tokens; cancel then drain all children.                                         | Owned handles, dynamic topology, cross-invocation sharing or measured setup cost motivates another substrate. |
| TASK-003 | No mutable external resource capture, inherited parent Scope registration or injected driver cursor splitting.                         | Explicit cross-task ownership/service identity and Scope sharing conformance.                                 |
| TASK-004 | Refuse typed child failure until represented Cause avoids mixed interruption/failure information loss; no new projection is admitted.  | Public Exit/Cause APIs or requirement to inspect simultaneous failure/interruption reasons.                   |
| TASK-005 | Inherit immutable service/request/log context; child-local mutation isolated; defer typed failure trail transfer until the Cause gate. | FiberRef-like joins, context merge semantics, distributed span identities or wider defect propagation.        |
| TASK-006 | Setup costs measured, watch allocations allowed and reported; no per-scalar metadata/task handles.                                     | Inline cancellation machinery can reduce proven overhead without changing wake/cleanup semantics.             |

## Native implementation decisions

**TASK-007 — fixed-arity coordinator and precise startup.** Emit only reached two/three-child adapters. Inline child futures normalize the admitted outcome to success/interruption; no native Fiber or Exit value is exposed. Biased polling preserves initial input order, while cancellation guards prevent the body of an unstarted loser from executing. Pending children keep independent watch tokens and contexts until every cleanup finishes. This is not a scheduling fairness guarantee. Revisit for a broader admitted topology or explicit task handles.

Lowering filters child helper captures using the existing delayed-capture analysis, so even an unused outer mutable cell is not lent to multiple child futures. Child contexts retain no parent Scope entries or failure trail. Logging/request snapshots are copied only where existing reachability selects them; unused selected driver fields start at their empty/default state, and child reads of mutable drivers are refused. No context fields or Cargo dependency were added for programs without groups.

Native panic/defect supervision remains outside the admitted cooperative cancellation contract. A panic that unwinds the parent future can drop pending children; this slice does not establish async cleanup on unwinding. The existing trusted-host fault limitation is unchanged. Typed-failing and defective child programs are not newly admitted by Unit/Never authoring.
