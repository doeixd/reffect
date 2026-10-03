# Lexical Deferred and scoped Semaphore preparation

Recorded **2026-10-03** against installed **Effect 4.0.0 stable**, before coordination feature implementation. This is an implementation design, not a support claim. It follows the current fallible-task/Cause work and supplements [the earlier coordination record](coordination-modules.md), whose baseline was rc.118. Core PLAN.md is maintained separately.

## Evidence and current boundaries

Primary sources checked online: stable [Deferred](https://unpkg.com/effect@4.0.0/src/Deferred.ts), [Semaphore](https://unpkg.com/effect@4.0.0/src/Semaphore.ts), [Tokio 1.53.1 Semaphore](https://docs.rs/tokio/1.53.1/tokio/sync/struct.Semaphore.html) and [std Mutex](https://doc.rust-lang.org/std/sync/struct.Mutex.html). Existing [structured tasks](structured-concurrency.md), [Exit/Cause](exit-cause.md), [metadata cost](../metadata-cost.md), [tiny R language](../r-language.md), `effect-ir.ts`, `structured-concurrency.ts` and compiler admission were reviewed.

The stable implementation retains the relevant rc.118 semantics:

- Deferred stores an effect and an optional waiter array. Awaiting after completion evaluates that stored effect. `succeed`/`fail` store reusable outcome effects; completion is first-install-wins, returning Boolean. Await cancellation removes only that waiter. Completion detaches the entire waiter cohort before resuming callbacks.
- `complete` evaluates a pending computation and stores its outcome; competing calls can start evaluation before installation. `completeWith` stores an effect that each awaiter may evaluate separately. They must remain separate admissions.
- Semaphore's public stable `take` documentation now explicitly says a smaller later request may overtake an earlier larger request. Release schedules an insertion-order scan, skips requests that do not fit, and does **not** reserve/deduct permits for woken waiters. Resumed acquisition checks availability again; losing contenders re-register. Tokio's FIFO multi-permit semaphore is not an equivalent general implementation.
- `withPermits` masks acquisition bookkeeping, restores interruptibility while waiting and in the body, and installs release before entering the body. Release occurs after the body's own finalization. `withPermitsIfAvailable` returns None without evaluating an unavailable body.

Independent installed-stable probes, run with `node --input-type=module` from `packages/reffect`, observed:

| Probe                                                                         | Result                |
| ----------------------------------------------------------------------------- | --------------------- |
| `succeed(7)`, `succeed(9)`, two awaits                                        | `[true, false, 7, 7]` |
| Fork two awaiters; interrupt first; succeed(11); join second and late await   | `[11, 11]`            |
| `completeWith(sync(++n))`, two awaits; then `complete(sync(++n))`, two awaits | `[[1, 2], [3, 3]]`    |
| Semaphore capacity 2: `take(-1)`, `release(0)`, `release(-2)`, `release(8)`   | `[-1, 3, 1, 9]`       |

A separate barrier-driven stable probe held both permits, forked an earlier two-permit requester and a later one-permit requester, released one permit, joined the small requester, then released the remaining held permit. The body trace was `["small", "large"]`. Child-start Deferred signals occurred immediately before the synchronous take-to-suspension path, without a timer or intervening yield. This verifies fitting-request overtaking for that fixture; it does not prove every dispatcher interleaving.

The unrestricted-count probe is evidence against silently normalizing upstream's unrestricted number domain into unsigned native permits. These are research probes, not native conformance.

The current TaskGroup owns two or three inline pinned futures and awaits their cancellation/finalization. It rejects nested groups and captured outer Ref/file handles. It exposes no general Fiber handle or child-specific interruption API. Pure Cause data currently admits Fail reasons; that does not establish general asynchronous Exit or Deferred.done.

## Public shape and lexical ownership

Follow the existing `Ref.make`/flatMap lexical elaboration, rather than adding a new imperative language or public task scheduler:

```ts
R.Effect.flatMap(R.Deferred.make(R.U64, R.Never), (deferred) =>
  R.Effect.all(
    [
      R.Effect.asVoid(R.Deferred.await(deferred)),
      R.Effect.asVoid(R.Deferred.await(deferred)),
      R.Effect.asVoid(R.Deferred.succeed(deferred, R.literal(R.U64, 7n))),
    ],
    { concurrency: "unbounded", discard: true },
  ),
);
```

This is a **proposed** sketch; Deferred is not currently exported by R. Official Deferred.make needs no runtime type witness; R needs A/E witnesses for native representation, following existing represented builders. Await/succeed/fail preserve upstream names, argument order and applicable dual forms.

Proposed Semaphore construction is `R.Semaphore.make(2)` consumed directly by flatMap. The symbolic handle exposes `semaphore.withPermits(1)(body)`, `withPermit(body)` and `withPermitsIfAvailable(1)(body)`, matching the stable instance API. Module-level equivalents should only be added where upstream exports them, using the same underlying nodes. Do not invent a TaskGroup callback overload merely to distribute handles: children already capture symbolic lexical inputs during TypeScript graph construction.

Elaboration produces dedicated `DeferredScope`/`SemaphoreScope` nodes, analogous to RefScope. The allocation belongs to the lexical owner, not to every task context. Child helpers borrow `&DeferredState<A,E,N>`/`&SemaphoreState<N>`; parent futures retain the state until all borrowed children finish. The resulting pinned owner future stores the local state and borrowers safely through ordinary Rust async lowering. No unsafe self-pointer or manual self-referential struct is needed.

Opaque handles have dedicated semantic witnesses and cannot masquerade as ordinary native data. Add a recursive `containsCoordinator` check over arrays, tuples, structs, unions and operation/function channels. Refuse:

- Returning a handle or embedding it in returned data, typed errors, Cause/Exit, Ref payloads, Layer services, Schema/wire/storage data or host function arguments.
- Capturing a handle outside its binder region, across an unrelated function invocation, in detached work or in any unproved parallel primitive.
- Dynamic make escaping direct lexical consumption, opaque service objects containing a handle, and arbitrary user operations claiming to serialize/copy a handle.

Passing a handle to an internal synchronous builder is graph construction, not runtime escape; represented runtime function calls still need explicit borrowing contracts. Initial implementation should refuse those calls rather than infer a general lifetime model.

TaskGroup admission must distinguish allowed shared coordinator borrowing from forbidden captured exclusive Ref/file access. Do not relax the latter. In particular, sharing a coordinator is not evidence that arbitrary mutable service identity may be cloned or borrowed across children.

## Capacity is a proof, not a hidden API limit

Derive maximum simultaneously active awaits/acquisitions for each lexical owner from the checked execution graph. With the present non-nested groups, sequential parent execution and no concurrent Stream operator, it is at most three during a group and one outside. Multiple sequential uses or sequential ForEach/Repeat iterations do not multiply the live bound; alternatives take the maximum. A parent awaiting a group is not also awaiting its coordinator.

The checker must account for cleanup paths, shared graph occurrences and every admitted concurrent primitive. A waiter unregisters before that task begins its cancellation cleanup; a cleanup await can then reuse its slot. Keep the owner alive through parent cleanup and reject any path where the bound or lifetime is unknown. If nested groups or concurrent stream operators later land, extend the analysis before admitting their coordinator captures.

Generate fixed `[Option<Waiter>; N]` storage sized from this proof. Refuse an unproved topology at compile time, rather than returning a new runtime "too many waiters" outcome. Slots are dynamically reused; registration order uses a bounded linked order or equivalent array ordering, not a monotonic ticket whose overflow a long-running Repeat could trigger. No dynamic global registry, Arc, per-waiter Box or user-supplied hidden capacity is required.

## Deferred state and completion adapter

First profile: Bool/u64/Unit success payloads and Bool/u64/Unit/Never typed errors. Payloads are Copy native values; no resource or handle payloads. Admit make, await, succeed, fail and isDone. Explicitly defer done/failCause/interrupt/interruptWith/complete/completeWith, lazy factories and unsafe host mutation. `fail` installs a typed error, not arbitrary runtime Cause; each await constructs that waiter's own failure trail outside the retained payload.

Use a lexical `std::sync::Mutex<State<A,E,N>>` holding `Option<Result<A,E>>` and fixed waiter slots with Wakers. The mutex gives a safe linearization point even if the Tokio executor later moves the parent future between threads. Never hold its guard across await, callback execution or wake calls. Existing trusted-host panic policy governs poisoning; this design does not establish Die capture.

Await is a small custom future:

1. Under the mutex, inspect completion; return its copied result immediately if complete.
2. Otherwise register or update this future's Waker in one owner slot while still holding the same lock. Checking and registration are atomic with respect to completion, eliminating lost wakeup.
3. On cancellation/drop, unregister just this slot. A slot identity remains valid until removed; a reused slot must not be erased by an old guard.

Completion locks, returns false if already installed, otherwise installs the retained result and moves the whole current Waker cohort out of the slots. It unlocks before waking. Future cancellation after broadcast therefore cannot mutate the wake cohort or remove a new registration. Late awaiters read the retained result. No condition-variable/watch notification replaces that result.

The generated await wrapper integrates existing per-child cancellation and frame policy. A cancellation request does not mutate retained completion. The actual pending-interruption-versus-completion precedence must be tested against the stable reference in controlled fixtures; deriving it from Mutex acquisition order alone is insufficient. Independent cancellation applies to a waiter future, not the coordinator owner.

## Scoped Semaphore adapter

First profile: compile-time integral capacity in `0..=u32::MAX`; literal integral counts in `0..=capacity`. Zero-count acquisition succeeds without occupying permits, including at zero capacity. A positive request at zero capacity is outside that initial count profile; requests above capacity, negative/nonintegral/nonfinite counts, resize and manual balancing are explicit compile refusals. A later wider profile can support indefinitely pending oversized requests without clamping. Admission limits are authoring restrictions, not runtime divergences.

Use a lexical Mutex-protected free count and fixed insertion-ordered waiter slots. Borrowing and slot bounds match Deferred. Release restores accounting and selects the current fitting wake cohort, skips a larger blocked request and wakes outside the lock. It does **not** pre-reserve permits for every woken waiter. Each resumed acquisition atomically rechecks/deducts; a loser re-registers at the end, matching the stable algorithm. Do not advertise FIFO, starvation freedom or exact scheduler trace equivalence before evidence.

Fit scanning and repeat wake behavior require careful conformance: stable release schedules a scan, allowing additional work before scanning, and callbacks can resume synchronously. A direct eager Rust wake snapshot may match capacity/progress while differing in an observable body order. Compare controlled traces with the pinned Effect dispatcher; if the broad profile cannot match, narrow the accepted topology explicitly or implement an audited scheduled scan adapter. This is an **open implementation gate**, not permission to substitute a reservation/FIFO algorithm.

Represent acquisition success with a borrowed native permit guard. Acquisition bookkeeping and guard installation are one masked, non-suspending step. Waiting is interruptible according to the surrounding mask, and the body restores the inherited interruptibility. Cancellation after deduction but before body entry releases through the installed guard; canceled registered waiters only remove their registrations. Keep the guard through the entire body, including its awaited Scope/ensuring cleanup, then release exactly once before returning its success/error/interruption outcome.

Synchronous Drop can repair native permit accounting if a future is dropped, but this does not prove awaited Effect finalization on host future drop or panic. The host must still cancel cooperatively and await the owning computation. Do not hold a Rust mutex guard across a user body, and do not substitute a Tokio owned permit that would impose different fairness or Arc ownership.

`withPermitsIfAvailable` checks/deducts under the same mask, returns represented Option.none when unavailable without evaluating the body, otherwise installs the guard before restoring the body and returns Some(success). Typed failure/interruption follow the body rather than becoming None. Cause combination remains the task runtime's obligation, not semaphore state.

## Missing isolation witness and implementation order

The present flat All/Race topology cannot express "interrupt waiter one while producer and waiter two keep running": parent cancellation interrupts all children; Race completion cancels all losers and closes the group. A successful producer/two-waiter demo and whole-parent cancellation do not prove independently addressable child interruption.

### Chosen smallest witness: one nested infallible Race

Prefer a narrowly checked nested Race over adding child handles for this workload. The admitted grammar is an **infallible outer All of two or three Unit/Never children**, with at most one simultaneously reached **infallible inner Race of two Unit/Never children**. The inner Race may occur through ordinary sequential, conditional, Scope or bracket wrappers in one outer child, but may contain no further group. Every other outer child is group-free. All existing cleanup-group, shared Ref/file, mutable driver and host-operation refusals remain active at both boundaries. Any fallible ancestor or descendant TaskGroup is refused in this nested topology; fallible groups elsewhere in sequential code retain their existing unnested profile.

The restriction is about actual execution regions, not only direct node shape. A Catch or Match wrapper around a nested fallible group does not make that group admissible merely because its resulting child error witness is Never. Shared DAG nodes used twice in different outer children count twice for simultaneous execution. Mutually exclusive alternatives take the maximum; parallel children sum. Existing boolean `child` memoization is insufficient for the new ancestry-sensitive admission: cache/check with the enclosing group mode/error, depth and cleanup context, or derive context-independent summaries and apply them per occurrence.

For an outer arity n, there are at most **n+2 descendant child contexts** (five for arity three), plus the invoking root context. One outer child is a coordinator waiting on its inner Race, so at most **n+1 leaf computations** can actively await a Deferred (four for arity three). The compiler can initially use this conservative four-waiter proof per shared owner; refine per-owner use only after the complete path works. Context size and child watch allocation count increase for this authored topology; ordinary unnested programs retain their existing layouts/costs.

The inner Never group cannot contribute a typed failure. It returns success after its winner interrupts and awaits its loser, or propagates its own pending parent interruption. Outer All propagates interruption using its existing Unit/Never semantics. Therefore this choice does not invalidate the fixed typed-failure buffer proof for **unnested fallible groups**. Revisit that proof before admitting any fallible nested group, not merely when increasing the total leaf count.

A concrete authored differential witness uses three lexical Deferred owners:

1. `main` retains the eventual u64 payload; `cancelWaiter` and `loserFinalized` retain Unit.
2. Outer child one runs Race(await(main) with ensuring(succeed(loserFinalized)), await(cancelWaiter)), discarding the main payload.
3. Outer child two awaits main, records the payload, and returns Unit.
4. Outer child three succeeds cancelWaiter, awaits loserFinalized, then succeeds main(7).
5. After outer All completes, the parent awaits main again to prove retained late completion.

The second inner Race branch succeeds without changing main, interrupts only the first inner branch and awaits its cleanup. The unrelated outer waiter remains live. The producer explicitly awaits that cleanup before completing main, so cancellation cannot be mistaken for winning the completion race. Stable Effect 4.0.0 executed this program with trace `["isolated-finalized", "inner-race-done", "complete-main", "survivor:7"]` and late result 7. It required no timer or explicit Fiber API. Child-start/registration observations should accompany the native fixture, and a manually polled first-Pending check can verify that both main awaiters were registered before triggering cancellation; source input order alone is not a universal scheduler claim.

Test parent cancellation while inner loser cleanup is masked: outer cancellation reaches its coordinator child, that child cancels both inner children, and each group drains before its parent cleanup continues. Test cancellation before the inner winner, while inner loser finalization is suspended, and after the inner Race returned. Test immediate first inner success suppressing the unstarted loser body, logging/annotation inheritance at both boundaries, and child-local Scope versus forbidden parent-scope registration. Repeated groups must reclaim nested watch senders and coordinator waiter slots.

### Why lexical interrupt-and-await handles wait

A child handle needs a represented join outcome, ownership of cancellation and completion, start/interrupt/join race rules, no escape across the owner, independent per-handle borrower accounting and task identity API boundaries. A fake `Fiber.interrupt` around the existing group watch sender would expose cancellation without a separately awaitable completion contract. Even if initial handles are compile-time symbols, they need a new region construct and exhaustive per-pass support. Those capabilities are valuable later; the nested Race witness uses already represented control flow and existing awaited cancellation semantics with a much smaller admission change.

### Suggested file ownership for implementation

- **Admission/ownership agent:** `src/structured-concurrency.ts` for ancestry/topology summaries and exported maximum live context/leaf bounds; `src/effect-ir.ts` only if its checker needs boundary-context changes; `src/scope-analysis.ts` for verification that fresh child Scope rules survive both levels. Preserve every fallible-group carrier/refusal condition.
- **Native agent:** `src/lower.ts`, `src/structured-runtime.ts` and `src/async-runtime.ts` for nested helper lifetime/context review and any necessary corrections. Existing generic inline coordinator should be reusable without new arity or scheduler primitives. Validate generated Rust before deciding runtime edits are necessary.
- **Conformance agent:** dedicated `tests/nested-taskgroups.test.ts` and type fixture, covering the narrow topology, forbidden variants, parent cancellation/finalization and cost accounting. The Deferred isolation workload can follow once Deferred builders exist; admission tests must not claim it already ships.
- **Coordinator implementation after this gate:** its own model/IR module, owner/waiter state emitter and tests, coordinated with the core/native agents for exhaustive union visitors and opaque-witness refusal. Root owns docs/index/PROGRESS staging and any common exports.

Paths above are relative to `packages/reffect`. Do not let two agents edit effect-ir/lower simultaneously; declaration changes and exhaustive visitor updates require explicit handoffs.

Suggested delivery: fallible TaskGroup acceptance → narrow nested-infallible acceptance → lexical coordinator/escape/live-bound checks → complete Deferred isolation path → scoped Semaphore path. Native state-unit tests can prove unregister behavior while the authored witness is being built, but do not replace it. Implementing pure Cause/Exit data or a sequential Deferred completion demo does not discharge these gates.

## Decisions and revisit triggers

| ID         | Decision                                                                                                | Revisit trigger                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| LCOORD-001 | Lexical make/flatMap elaboration, dedicated owner nodes, opaque handles and borrowed child helpers.     | Detached tasks, cross-function runtime sharing or request-external services.                 |
| LCOORD-002 | Generate waiter capacity from maximum live checked borrowers; no runtime capacity failure.              | Nested groups, concurrent streams or dynamic task topology.                                  |
| LCOORD-003 | Inline owner Mutex/state plus fixed Waker slots; no Arc/global registry by default.                     | Proven owned Send tasks or measured lock/state cost.                                         |
| LCOORD-004 | Deferred initially retains Copy success/typed error, with first-install/broadcast/late await semantics. | Non-Copy payloads, done/Cause completion, effect-valued completion APIs.                     |
| LCOORD-005 | Semaphore preserves fitting-request overtaking and rechecks after wake; guard installed under mask.     | Controlled stable/native traces expose eager wake differences; dynamic/manual count support. |
| LCOORD-006 | Independent waiter cancellation needs an authored ownership witness beyond current All/Race.            | Narrow nested Race acceptance and Deferred differential isolation workload.                  |
| LCOORD-007 | Scalars remain plain; diagnostic trails belong to each awaiting execution, not stored payloads.         | Retained full runtime Cause outcomes or payload observability APIs.                          |

**LCOORD-008 — Choose one nested Never Race inside a Never All for the first independent-cancellation witness.** Prove at most five descendant contexts/four leaf awaiters, retain every fallible nesting refusal, and reuse existing borrowed task coordinators. Revisit for deeper/multiple nesting, typed nested failures, independently addressable child handles or concurrent Stream operations.

## Acceptance and costs

Deferred: producer/two waiters/late waiter; first and losing completion Booleans; success and typed error; completion before registration and during registration; reentrant cancellation during broadcast; independent waiter cancellation; repeated slot reuse. Compare official/plain/framed/native outcomes and logs. Use controlled registration/start barriers, not sleeps as an ordering proof.

Semaphore: capacity safety; mixed one/two-permit contention where the later fitting request progresses; canceled queued waiter; cancellation precisely after grant and before body; finalizer-before-reuse order; typed failing body release; zero counts; unavailable body never evaluated; slot reuse; restored capacity and no pending registrations at owner close. Validate nested masked cleanup and parent interruption with the fallible runtime outcome adapter.

Refusals cover nested data escape, unknown coordinator witness, wrong lexical binder, service storage, unproved topology, manual/unsafe completion or count operations, resource payloads and unsupported full Cause APIs. Every admitted path updates substitution, reference/framed interpretation, derive/requirements, scope analysis, provenance, failure frames, ownership and native lowering exhaustively.

Measure owner/state and future layouts for one/two/three simultaneous waiters; allocations at construction, registration, completion, wake and cancellation; live registrations after repeated cycles; payload copies; generated Rust growth, binary/dependency footprint and compile time. Waker cloning may have executor-dependent costs, so do not infer zero allocation merely from fixed slots. Report lock cost separately from disabled provenance/frame policy. Modules without coordination must gain no owner fields, dependencies, scalar wrappers or runtime allocations.

No native coordination implementation or cost result is claimed here. Link this record from PROGRESS and the docs index when scheduling the implementation; accepted observable differences still belong in [native divergences](../native-divergences.md).
