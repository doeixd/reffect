# Deferred, Latch and semaphore admission plan

This is a proposed implementation track, not shipped coordination support. It follows the bounded async/resource kernel and needs a minimal structured task workload before suspended operations are useful. General Fiber/FiberRef and cross-fiber mutable ownership remain separate gates.

## Pinned primary sources and observations

Baseline: installed Effect **4.0.0-rc.118**, inspected online on 2026-10-02: [Deferred](https://unpkg.com/effect@4.0.0-rc.118/src/Deferred.ts), [Latch](https://unpkg.com/effect@4.0.0-rc.118/src/Latch.ts), [Semaphore](https://unpkg.com/effect@4.0.0-rc.118/src/Semaphore.ts), [PartitionedSemaphore](https://unpkg.com/effect@4.0.0-rc.118/src/PartitionedSemaphore.ts), and [internal Latch implementation](https://unpkg.com/effect@4.0.0-rc.118/src/internal/effect.ts).

Read both public contracts and their implementations. A future stable-version upgrade must rerun these fixtures; source observations are version-specific and do not establish stronger public scheduling promises.

| Module                           | Public contract and pinned implementation details                                                                                                                                                                                                                                                                                        | Consequence for native design                                                                                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deferred                         | Any number of awaiters, including late awaiters; first installed completion wins and completion returns Boolean. `done` installs an Exit including typed failure, defect and interruption. Await cancellation removes that waiter, not the completion.                                                                                   | A consuming Tokio oneshot is insufficient. Keep reusable completion plus independent waiter registrations.                                                                           |
| Deferred completion              | `complete(effect)` checks for prior completion, evaluates a pending effect and stores its Exit; every awaiter shares that result. Concurrent completers can both start before either installs a result. `completeWith(effect)` instead stores an environment-free effect which each awaiter may run independently.                       | Do not treat all completion APIs as one memoized promise, or claim globally once-only evaluation under competing completion. Admit APIs independently.                               |
| Deferred cleanup                 | `doneUnsafe` detaches the waiter array before broadcasting. A resumed interrupted waiter can synchronously unregister; mutating the broadcast list in place previously skipped other waiters. `sync`/`failSync` evaluate their thunk before attempting completion, even if already completed.                                            | Detach or stabilize the wakeup cohort before callbacks/reentrant cleanup. Preserve losing-completion side effects when admitting lazy factories.                                     |
| Latch                            | Closed by default; `open` returns false when already open, otherwise opens and wakes current waiters. `close` reports whether it changed state. `release` wakes current waiters while keeping the latch closed; it returns true even with no waiters while closed, false while open. `whenOpen` waits once, then executes its effect.    | A reusable latch needs state plus pulse/cohort semantics. `release` is not `open` followed by `close`, and `whenOpen` does not continuously guard its body.                          |
| Latch wakeup                     | Effectful open/release schedule a detached waiter cohort; close does not retract already scheduled grants. Unsafe open flushes immediately. Cancellation removes a waiter from pending or scheduled cohorts. Reentrant close/new-await must not drain the new waiter.                                                                    | A Boolean watch channel alone loses release pulses and open/close grants. Store per-waiter grants or a generation/cohort model. Defer unsafe host APIs initially.                    |
| Semaphore                        | Manual `take(n)` returns n; `takeIfAvailable(n)` returns Boolean. `release(n)` returns free count; `releaseAll` releases the current taken count; `resize` can make free negative. There is no validation/clamping of the JS number n in the implementation.                                                                             | Raw negative/oversized/noninteger arithmetic is not interchangeable with Rust unsigned permits or Tokio capacity semantics. Restrict an admitted profile explicitly.                 |
| Semaphore waiters                | Waiters are an insertion-ordered Set, but wake scanning skips a waiter whose requested n does not fit. Deduction happens when the resumed acquisition runs, so resumed acquisitions can contend again. Public docs do not promise strict FIFO. Interruption unregisters a pending waiter.                                                | Tokio Semaphore's documented FIFO and `acquire_many` head-of-line blocking differ. A direct alias needs a narrower proof, not a fairness assumption.                                 |
| Semaphore scoped use             | `withPermits` masks acquisition bookkeeping, restores interruptibility while waiting and in the body, and installs release before the body runs. `withPermitsIfAvailable` returns Option and does not wait.                                                                                                                              | Permit grant, cancellation and cleanup registration must be atomic as a semantic step; canceled queued waiters must not leak permits.                                                |
| PartitionedSemaphore             | One shared pool, not a separate semaphore per key. Public contract promises round-robin distribution across partitions. Capacity is `max(0, permits)`; nonfinite capacity takes a special unlimited path. Nonpositive take is a no-op; requests above finite capacity wait forever.                                                      | Preserve shared accounting and key-level arbitration. Per-key Tokio semaphores cannot implement this contract. Initially admit finite integral capacity and bounded known keys only. |
| Partitioned release/cancellation | Positive release caps availability at capacity. Zero/negative release does nothing. Waiters can reserve part of a request; released permits are distributed one at a time by partition iteration to the oldest waiter in each partition. Canceling a partial waiter removes its remaining demand and redistributes its reserved portion. | Reservation state is observable in contention; a simple FIFO complete-request queue is insufficient. Cancellation must repair both demand and reserved counts.                       |

Executable probes against the installed pin (`/tmp/reffect-coordination-probes.log`): `completeWith` await results `[1,2]`, `complete` results `[3,3]`; latch `[releaseClosed,open,openAgain,releaseOpen,close,closeAgain]` gives `[true,true,false,false,true,false]`. For ordinary capacity 2, `[take(-1),release(0),release(-2),release(8)]` gives `[-1,3,1,9]`; partitioned releases `[-2,8]` both leave availability 2. These are research probes, not native conformance.

Reproduce the completion distinction from `packages/reffect` with `node --input-type=module`:

```js
import { Deferred, Effect } from "effect";
console.log(
  await Effect.runPromise(
    Effect.gen(function* () {
      let n = 0;
      const d = yield* Deferred.make();
      yield* Deferred.completeWith(
        d,
        Effect.sync(() => ++n),
      );
      const repeat = [yield* Deferred.await(d), yield* Deferred.await(d)];
      const memo = yield* Deferred.make();
      yield* Deferred.complete(
        memo,
        Effect.sync(() => ++n),
      );
      const cached = [yield* Deferred.await(memo), yield* Deferred.await(memo)];
      return { repeat, cached };
    }),
  ),
);
```

## Minimum structured task prerequisite

Before implementing these modules, admit one compiler-owned task group with a static bound of two or three children, literal task topology and explicit join. Use Tokio futures/tasks for execution; do not reproduce Effect's scheduler.

- Parent cancellation cancels every child and awaits all child cleanup before closing the owning Scope. Parent cannot return while a coordinator borrower is live.
- Child interruption is independent: canceling one waiter cannot cancel its sibling or poison the Deferred. Each child needs its own cancellation state and owned logging/annotation context snapshot according to the existing observability contract.
- Define the bounded join observation: successful value, admitted typed failure and interruption. Do not expose a general Cause tree or claim upstream interrupting-fiber identity until their representation exists.
- Decide first whether scoped borrowed futures suffice or owned spawned tasks are necessary. Borrowed task-group futures avoid unconditional Arc allocation; owned task handles need Send/lifetime checks and explicit sharing ownership.
- Initially admit scalar/Unit completion payloads and immutable copied service values. No file lease escape, arbitrary service object, mutable alias, detached fiber, child Scope transfer or FiberRef inheritance by assumption.

This prerequisite is a semantic admission gate. A sequential `make; complete; await` demo alone cannot prove reusable broadcast, waiter isolation or cancellation-safe permit ownership.

## Priority profiles and implementation workloads

| Order                   | First admitted surface                                                                                                                              | Complete workload                                                                                            | Required observations                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Deferred             | make with explicit A/E witnesses, await, succeed, fail, isDone; scalar/Unit results; no arbitrary completion effect                                 | One producer and two waiters, then a late waiter; interrupt one waiting child while the other remains        | One winning install, every surviving waiter observes the same payload/error; canceled waiter unregisters; producer and Scope cleanup finish once |
| 2. Latch                | make, await, open, close, release, whenOpen, effectful isOpen projection                                                                            | Two blocked children receive a release pulse; latch stays closed and a third waiter stays blocked until open | Transition Booleans match, release/open wake the correct cohort; close before polling granted children does not revoke their grant               |
| 3. Semaphore            | bounded positive integral make, withPermits/withPermit, withPermitsIfAvailable; literal nonnegative counts and no resize/manual imbalance initially | Capacity two with mixed one/two-permit requests, interrupt a queued child and a granted child                | Maximum occupancy, no capacity leak, finalizer-before-reuse ordering, Option result when unavailable; contention matches admitted wake policy    |
| 4. PartitionedSemaphore | finite integral capacity, fixed finite key set, scoped withPermits/withPermit, available/capacity projection                                        | Busy partition A and sparse B/C, multi-permit requests, partial reservation followed by cancellation         | Shared pool bound, round-robin key progress, oldest waiter within a partition, canceled reservation redistribution                               |
| Later                   | Deferred done/failCause/interrupt/complete/completeWith; semaphore manual take/release/releaseAll/resize; arbitrary partition keys                  | Explicit Exit/Cause propagation and task identity; dynamic resource admission                                | Full selected failure/defect/interruption representation, key equality/hash semantics, count domain and ownership checks                         |

Each profile needs its own support entry and refusals. A module namespace appearing in R must not imply the later rows work. Zero counts need explicit tests; negative/manual counts are either correctly implemented under a named wider profile or rejected at authoring/validation.

## Implementation checklist by admission gate

**Before Deferred:**

1. Write task-group ownership and cancellation specification, including fail-fast versus collect-all join and which child failure wins; pick one bounded contract and differential oracle.
2. Add a task-group IR node only after showing existing sequential nodes cannot represent independent suspension. Define per-pass checker/reference/ownership/lowering obligations.
3. Prove two child contexts survive suspension, one-child interruption leaves the sibling live, and parent Scope close waits for both cleanup paths.
4. Add opaque coordinator handle witnesses tied to lexical owner lifetime. Reject returning the handle, storing it in a longer-lived Layer or borrowing it across an unrelated invocation.
5. Name the representable completion channels and the static maximum simultaneously registered children before choosing inline state or Arc.

**Deferred implementation:**

1. Create the pending/completed state and first-install operation with broadcast cohort detachment.
2. Add await registration/removal and a lost-wakeup test at the register-versus-complete boundary.
3. Compare two waiting children plus a late waiter for success and typed failure, repeated completion Booleans, and interrupted-waiter isolation.
4. Keep public `done`, `completeWith`, `interruptWith`, lazy factories and arbitrary Cause APIs explicitly unsupported until their separate semantics are admitted.

**Latch implementation:**

1. Specify registration and grant epochs; distinguish no-waiter release from state transition and never let a new waiter consume a previous release.
2. Cover effectful scheduled cohort wake, reopen/close cycles and reentrant new registrations.
3. Confirm cancellation of a granted-but-unpolled waiter removes only that waiter; instrument repeated cycles for retained registrations.

**Semaphore implementation:**

1. State integral capacity/count bounds and the supported zero-count rules in diagnostics and user docs.
2. Implement masked grant-plus-finalizer-registration with interruptible waiting/body; use controlled cancellation precisely between those phases.
3. Demonstrate small-request progress with an earlier oversized-for-current-free request, or constrain the profile so the difference cannot arise and report that constraint.
4. Compare unavailable Option results and release-before-next-body logs; every run ends with original capacity and no pending reservations.

**Partitioned implementation:**

1. Port partial reservation and per-permit rotation to compiler-known key slots; record cursor update rules when a partition disappears and reappears.
2. Compare A/B/C progress with uneven request sizes and cancel a partially funded request before it completes.
3. Only after parity, consider dynamic keys with a verified Effect equality/hash subset; string equality alone does not establish generic key semantics.

## Rust substrate and semantic adapters

[Tokio 1.53.1 Notify](https://docs.rs/tokio/1.53.1/tokio/sync/struct.Notify.html) supplies wakeups, not stored Effect outcomes, pulse grants or permit accounting. Register/enable notification before checking condition, then recheck in a loop, so completion between checking and waiting cannot be lost. A mutex-protected completion/state and waiter cohort can establish the linearization point; never hold a mutex across `.await` or executing callbacks.

Deferred candidates: completion `Option<AdmittedExit<A,E>>` plus broadcast Notify, or a retained watch value with independent receivers. Prefer inline state in the owning task group for borrowed children; use Arc only when real owned sharing requires it. Avoid repeated owned-string cloning by restricting the first payload profile; adding shared payload ownership later must preserve observable mutation/ownership semantics. A notification-only design with no retained result fails late awaiters.

Latch candidate: state Boolean plus explicit grant generation/cohort, cancellation-removable registrations, and Notify for scheduling. A generation number without identifying registrations may incorrectly admit a waiter registered after release; test that interleaving. Native wake scheduling can differ internally, but observable grant/cancellation/reentrancy traces must satisfy the pinned profile.

[Tokio 1.53.1 Semaphore](https://docs.rs/tokio/1.53.1/tokio/sync/struct.Semaphore.html) promises FIFO, including multi-permit head-of-line blocking. Use it directly only for a separately proven restricted workload where that difference cannot occur. Otherwise build the small Effect permit-accounting/waiter-selection adapter using Tokio task/wake facilities and generated typed RAII/scoped release. It must match admitted non-FIFO behavior; do not advertise either starvation freedom or strict FIFO absent a corresponding upstream contract.

PartitionedSemaphore needs a dedicated accounting adapter: shared free count, per-key ordered waiter buckets, rotation cursor, per-waiter outstanding/reserved counts, and cancellation repair. Begin with compiler-known key slots; a dynamic hash map is a later choice. This ports coordination semantics, not the Effect scheduler. Do not add it unconditionally to ordinary native programs.

## Decisions to retain

- **COORD-001 — Task ownership precedes suspended coordination.** Reject cross-task coordination until parent join/cancel/cleanup and independent child contexts are verified. Alternative: global task registry or request-wide token; rejected because lifetime and waiter cancellation become implicit. Revisit for dynamic child topology.
- **COORD-002 — Deferred is reusable completion, not consuming delivery.** Retain an immutable admitted outcome and fan it out; first install wins. Alternative: oneshot per consumer; adds allocation and requires retained state anyway. Revisit payload sharing after scalar evidence.
- **COORD-003 — Admit completion APIs separately.** succeed/fail first; done and Cause operations follow Exit representation; completeWith requires per-await execution semantics. Alternative: normalize all APIs to memoized Exit; rejected as observably wrong. Revisit arbitrary effect captures only after environment/ownership proofs.
- **COORD-004 — Latch retains waiter grants across close.** Model release cohorts and late waiters explicitly. Alternative: watch Boolean only; rejected for lost pulses and revoked grants. Revisit queue-free generation representation only after adversarial interleaving evidence.
- **COORD-005 — Permit domains are explicit profiles.** First use bounded integral nonnegative counts with balanced scoped release; no silent reinterpretation of ordinary negative release or partitioned clamping. Alternative: Rust unsigned aliases for upstream number counts; rejected. Revisit manual count/resize semantics on a concrete workload.
- **COORD-006 — Verify arbitration, do not borrow fairness claims.** Ordinary and partitioned semaphores need distinct adapters/acceptance. Alternative: Tokio Semaphore everywhere or semaphore per partition; both change behavior. Revisit substrate specialization if compiler proves contention topology makes policies equivalent.
- **COORD-007 — Sharing and capacity are costed at the owner.** Inline/bounded state where possible; Arc/mutex/map allocations justified by ownership and measured reachability. Never wrap every scalar or put coordination metadata in value payloads. Revisit static capacity when dynamic admission is required; do not silently impose a bounded queue on an unbounded upstream API.

## Acceptance and cost gates

Build a deterministic reference/native harness using controlled start/register/grant/cancel barriers, not timing sleeps as proof of ordering. Exercise completion before/after registration, simultaneous completion, cancellation before grant and after grant, cleanup that registers another waiter, close before a scheduled latch wake, and permit release while a large request cannot fit. Compare payloads, selected Exit observations, task/context logs, transition return values and finalizer order. Admit only matched observations; pin implementation-specific traces separately from public guarantees.

Measure native owner/context/child-future sizes and total live state for 0/1/2/max waiters, disabled frame/log policies, allocations at construction/registration/wakeup/cancellation, payload clones, binary/dependency size and generated code growth. Test waiter nodes are reclaimed after cancellation/completion; no accumulating tombstones across repeated latch cycles or partition-key removal. Generated bounded arrays require a compiler-proved maximum live count or an explicit separately named capacity contract, not silent rejection of valid waiters.

Before widening: verify lock contention and Send constraints, pending-future drops, counter overflow, cancellation grant rollback, and nested Scope finalization. General fibers, FiberRef, defects/Cause identity, dynamic keys and cross-fiber resource access remain blocked until their own ownership and semantic representations land. No native implementation or performance pass is claimed by this document.
