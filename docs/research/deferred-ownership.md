# Deferred ownership and retained outcomes

Recorded 2026-10-04 against Effect 4.0.0 and the existing bounded task kernel. This is an implementation audit, not a claim that Deferred is publicly supported. Read [Deferred core preparation](deferred-core.md), [continuation turns](deferred-turns.md), [fallible native outcomes](fallible-native.md), and [metadata costs](../metadata-cost.md) together.

Primary sources checked online before this audit: [Effect Deferred](https://unpkg.com/effect@4.0.0/src/Deferred.ts), especially `_await` and `doneUnsafe`; [Effect internal runtime](https://unpkg.com/effect@4.0.0/src/internal/effect.ts), especially `FiberImpl.interruptUnsafe`, `getCont`, `combineFinalizerCause`, and concurrent traversal's child observer. Installed sources agree. Rust ownership sources: [borrowing](https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html) and [Future polling](https://doc.rust-lang.org/std/future/trait.Future.html). No new runtime dependency follows from this design.

## An existing correctness issue precedes Deferred

**DOWN-001 — Declared Never is not an outcome storage proof.** The failure-retention problem in TURN-012 already exists with the current public operations. A child may declare Never after typed recovery while a canceled recovery preserves an earlier scalar failure. A task group whose children all declare Never can therefore require the richer carrier. This finding changes the next implementation priority: repair and verify the existing path before admitting new coordination nodes.

An independently authored official Effect witness was run on this date:

```ts
const child = Effect.fail(7n).pipe(
  Effect.asVoid,
  Effect.ensuring(
    Deferred.succeed(cleanupStarted, undefined).pipe(
      Effect.andThen(Deferred.await(cleanupRelease)),
    ),
  ),
  Effect.catch(() => Effect.logInfo("caught")),
);
const fiber =
  yield *
  Effect.forkChild(Effect.all([child, Effect.never], { concurrency: "unbounded", discard: true }), {
    startImmediately: true,
  });
yield * Deferred.await(cleanupStarted);
fiber.interruptUnsafe();
yield * Deferred.succeed(cleanupRelease, undefined);
const result = yield * Fiber.await(fiber);
```

Observed ordered reasons: `Interrupt, Fail:7`; the recovery did not run. Deferred here is solely an oracle synchronization tool. The R workload can reproduce the same causal ordering using admitted Sleep/Ensuring and controlled clocks, so this does not depend on adding Deferred authoring support.

Current source audit explains the gap:

- `structured-concurrency.ts` seeds `hasFallibleGroups` only when the TaskGroup's declared error is not Never.
- `lower.ts` independently selects `fallibleArities` and each group's rich wrapper from child declared errors. Its ordinary wrapper reduces child outcomes to a Boolean.
- `lower.ts` enables the cancellation guard in CatchAll only when its source reaches a syntactically fallible group. This witness's source is Fail/Ensuring, so the guard is absent.
- If a rich carrier is emitted elsewhere in the same artifact, an apparently infallible child producing Combined currently panics instead of forwarding it.
- RPC refuses syntactically fallible groups; widening carrier selection must also widen that refusal before exposing these outcomes through the existing wire adapter.

The official observation is established. The durable regression in `packages/reffect/tests/retained-child-failure.test.ts` checks that ordered observation with controlled clocks, then asserts explicit refusal from both reference entry points and Compile.run. Reference execution also checks admission, so the refused graph is not executed through those interpreters. No native build or divergent native output is claimed.

The independent official probe was also run with `body = child` directly, without All. Interruption during the same held cleanup returned `Fail:7` alone and skipped recovery. The root-level native source uses the same unguarded typed catch when no fallible group is reachable. This identifies a separate retained-outcome audit priority; the current child-only refusal does not repair it. Its expected observation is established, while native differential support remains open.

## Representation and analysis decisions

**DOWN-002 — Separate declared channels from reachable outcomes.** Keep A/E witnesses for authoring and typed handlers. Compute build-owned summaries for cancellation-retained source failures and maximum returned failure count. Do not mutate E to describe interruption, attach metadata to scalar errors, or infer runtime infallibility from E = Never. The richer outcome is a property of a reached execution path.

**Current bounded repair — refuse unsafe child recovery.** The checked diagnostic `TASK_GROUP_RETAINED_FAILURE` rejects a child CatchAll when its source has a non-Never error and `isAsyncComputation(source)` is true. It rejects same-error and changed-error recovery, scalar and composite payloads. Synchronous source recovery remains accepted, including an asynchronous handler body; non-failing asynchronous sources remain accepted. This conservative rule also rejects some programs whose cancellation cannot actually retain a source failure. It avoids silently executing recovery or discarding the old error through the Boolean child adapter. Root-level async recovery outside task children remains a separate audit gate; this repair does not claim to correct every retained-outcome path.

The later complete carrier integration can seed retained-error reachability from CatchAll sources that can preserve failure across awaited finalization. Analyze the entire source, not only fallible TaskGroup occurrences. Overapproximation may select extra runtime code; underapproximation silently loses a cause. Composite source errors not represented by RuntimeFailure must be refused on these paths until another verified representation exists. Pure synchronous recovery with no interruption boundary should remain on its existing path where that exclusion is proved.

Use one authoritative analysis result for checker diagnostics, helper outcome selection, runtime emitter reachability, catch/retry guards, native host admission, and RPC refusal. Duplicated predicates in checker and emitter caused the present divergence. Summaries must include finalizer edges and shared nodes visited under distinct execution contexts. They are compiler data; no value carries them at runtime.

**DOWN-003 — Rich task wrappers are selected by outcomes.** A group with possible retained errors must consume `Result<(), TaskFailure>` even when every child declares Never. A child's Combined is forwarded without converting it to Interrupted or attempting to construct a Never value. Recovery checks the current interruption mask before executing a handler. Error-channel changes retain the original tagged Bool/U64/Unit payload when recovery is bypassed. This is already the purpose of RuntimeFailure; extend its reachability rather than inventing another error wrapper.

For the existing unnested profile, each leaf can retain at most one failure because cleanup has declared Never, runs masked, and cannot create task groups. The maximum remains three failures plus one interruption Boolean. Recheck this argument against every accepted finalizer form and refuse any unproved finalizer outcome rather than relying on a Never declaration alone. Parent-canceled All preserves failures; parent-canceled Race intentionally returns interruption alone; a winning Race discards loser failures after draining cleanup. Preserve those distinctions.

## Lexical ownership and the proposed nested profile

**DOWN-004 — One owned cell, borrowed opaque handles.** DeferredMake must elaborate directly through flatMap into DeferredScope. Store an inline `DeferredState<A,E,N>` in that owner and pass `&DeferredState` to reached helpers. Success/error payloads are admitted Copy scalar witnesses. A handle is a compiler binder, never a native public value, wire representation, storage column, service value, or independent executor resource. The existing outer Ref/file capture refusal remains valid; only checked coordinator binders gain a borrowing exception.

Use a private WeakMap keyed by compiler-owned native witness identity to recover the handle's channel witnesses. Intern canonical witnesses at build time. Also reject the reserved native typename recursively through layouts so a caller cannot forge an unrecognized witness using the same internal Rust type name. Recursive exclusion must cover structs, unions, arrays, records, UndefinedOr, pure Cause/Exit payloads, Ref contents, public function arguments/results/errors, and provider/schema boundaries. Builders' TypeScript types improve errors; the IR checker remains authoritative for raw or forged nodes.

**DOWN-005 — Ownership capacity and failure capacity are distinct.** The proposed outer All2/3 with one initial inner Race2 can have four live leaves. Each owner needs at most four simultaneous await registrations. Six task identities cover the invocation root, outer descendants, and the inner coordinator. The turn bank must retain coordinator identities for ancestor routing; it cannot use the four-leaf registration bound as its identity count.

If hidden scalar failures are accepted in the nested profile, conservatively allow four retained failures: the inner Race can return two and two other outer children can return one each. The existing RuntimeCause array of three is insufficient for that widening. Deduplication can reduce the count but is not a capacity proof; Race preserves duplicate failures. Either specialize cause capacity from the checked topology or retain a separate nested richer profile gate. Do not broadly raise ordinary artifact capacities before reachability warrants it.

**DOWN-006 — Prove retirement before identity reuse.** Sequential and alternative groups may reuse fixed storage only after every child has completed and cleanup drained, every await registration has unregistered or detached, and every active completion request has retired. Stable routes are build-owned. A task's physical poll position is not registration order. Completion snapshots an ordered cohort under the cell lock, releases the lock, and drives each selected continuation through the turn adapter; no peer Future pointer, MutexGuard across polling, or process-global registry is necessary.

Initial inner groups may exist before main await registration. Refuse group startup in a resumed continuation, cleanup, or recovery until the scheduling proof covers eager admission. Keep deeper nesting, nested All, multiple simultaneous inner groups, fallible nested groups, loops, detached tasks, host callbacks, and arbitrary completion effects refused. Context-sensitive checking must retain group ancestry, cleanup state, and whether execution follows a resumed await; a simple global visited set does not establish these conditions.

## Recommended implementation order

1. The current partial correction adds the existing Never-child official regression and asserts reference/compiler refusal. Full support still needs independent official/plain/framed/generated-native observations under None/Bounded frames in debug/release, richer carrier selection, cancellation guards and RPC refusal coverage. Keep that support gate closed before changing authoring APIs.
2. Complete the automatic-yield expansion audit and checker. A passing turn-kernel fixture alone does not prove a generated callback cannot cross Effect's automatic-yield threshold.
3. Connect an internal checked success-only lexical Deferred path with the existing unnested topology; keep public admission disabled until exact generated registration/cohort/cancellation traces pass. Success-only payloads avoid adding typed Deferred await failure before the retained-outcome repair, but do not exempt arbitrary surrounding existing failures from the analysis.
4. Add the checked initial nested Race isolation witness, separately proving identity/registration/turn capacities, safe generated borrows, and cleanup retirement. If richer nested outcomes are reachable, prove or specialize their four-failure capacity before admission.
5. Add typed fail broadcasting and late await recovery, with independent per-await diagnostic trails, then measure complete owner/future/context size and allocation behavior. Re-run legacy disabled-path costs to establish that unrelated programs retain their previous layouts and emitted dependencies.

General Cause completion, non-Copy values, multi-executor sharing, detached lifetimes, arbitrary scheduler injection and uncapped callback work remain deferred. This audit records safe steps and refusal gates; it does not authorize a partially checked public Deferred surface.
