# Bounded fallible concurrency preparation

Recorded **2026-10-03**, before implementation, against installed and published **Effect 4.0.0 stable**. This extends the [Unit/Never structured kernel](structured-concurrency.md) using the preparation in [checked Exit/Cause](exit-cause.md). It does not claim general Fiber, asynchronous Effect.exit, defects, arbitrary Cause annotations or coordinator sharing. The other instance owns PLAN.md.

## Evidence and prior design

Checked the published [internal Effect source](https://unpkg.com/effect@4.0.0/src/internal/effect.ts), [internal core](https://unpkg.com/effect@4.0.0/src/internal/core.ts), [Cause](https://unpkg.com/effect@4.0.0/src/Cause.ts), [Effect](https://unpkg.com/effect@4.0.0/src/Effect.ts) and [Fiber](https://unpkg.com/effect@4.0.0/src/Fiber.ts). Relevant implementations are `iterateConcurrentImpl`, `raceAll`, `causeCombine`, `findError`, `catch_`, `FiberImpl.interruptUnsafe`, `exitFailCause` and `setInterruptible`. Reviewed current AsyncError, AsyncContext, generated fixed-arity task coordinator, scope/lowering passes, framed reference interpreter and [coordination module prerequisites](coordination-modules.md). Pure Cause values currently allocate an explicitly requested Vec; replacing every async failure with that Vec would impose a new cost on unrelated programs.

Effect v4 Cause is an ordered flat reasons array. All and Race do **not** have the same failure aggregation rule. All establishes its terminal failure when a child exits after cleanup; later non-Interrupt sibling reasons are merged using Cause.combine. That operation deduplicates with Effect equality/hash, including reason annotations. Race collects failed child reasons in completion order using array concatenation: duplicates remain. Race selects the first success, interrupts losers and awaits their cleanup. Immediate All failure or Race success stops later admission; a failure whose cleanup suspends is not an already completed child.

An All child's first failure completes its own cleanup **before** canceling pending siblings. Returning on the first failure or dropping pending futures skips required cleanup. A successful Race must likewise await the loser. Existing borrowed, pinned futures and independent watch cancellation channels remain suitable; no owned spawned task or global fiber registry is justified by this slice.

## Controlled stable probes

Executable research used public Effect/Deferred/Fiber APIs and Deferred start, failure and cleanup-release gates. Synchronous completion gates force the logged order; sleeps do not establish it. These are independent upstream probes, not native conformance. The conformance implementation must preserve the same causal structure and compare its own native execution.

| Controlled workload                                                                            | Observation                                                                                                                   |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A fails but cleanup waits; B fails and finishes before A cleanup releases                      | All and all-failing Race: Fail(B), then Fail(A).                                                                              |
| The same workload with both errors 7                                                           | All: one Fail(7); Race: two Fail(7) reasons.                                                                                  |
| All A cleanup held after failure; B remains pending                                            | Before releasing A cleanup, B cleanup has not started. After release: A cleanup completes, then B cancellation cleanup runs.  |
| Interruptible All parent canceled while A failure cleanup is held, B pending                   | Interrupt, then Fail(A); both cleanups finish.                                                                                |
| Same All canceled after Fail(A) was already selected and B cancellation cleanup is held        | Interrupt, then Fail(A); B cleanup finishes.                                                                                  |
| Interruptible Race canceled while A failure cleanup is held, B pending                         | Sole Interrupt; pending Race failures do not become the parent's failure.                                                     |
| Successful Race parent canceled while loser cleanup is held                                    | Sole Interrupt; cleanup finishes.                                                                                             |
| All mixed outcome above wrapped in typed catch, result or exit                                 | Same outer mixed Failure; recovery/capture continuation does not run.                                                         |
| Explicit failCause containing Interrupt(99), Fail(5), with no ambient cancellation request     | Typed catch succeeds with 5; result succeeds containing Failure(5); exit succeeds containing both reasons.                    |
| All runs in masked acquireUseRelease acquisition; parent canceled during failing child cleanup | Raw acquisition retains sole Fail(5), without adding Interrupt; acquisition failed so no release is installed.                |
| Same masked acquisition catches its failure before returning                                   | Catch runs with 5; successful acquisition installs release; use is interrupted; release runs; outer result is sole Interrupt. |
| Same masked acquisition uses upstream result or exit                                           | Capture runs; acquisition succeeds, release runs, outer result is sole Interrupt.                                             |

For example, the independent cleanup/cancellation recipe is:

```js
import { Deferred, Effect, Fiber } from "effect";
const started = await Effect.runPromise(Deferred.make());
const finish = await Effect.runPromise(Deferred.make());
const failing = Effect.fail(5).pipe(
  Effect.ensuring(
    Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
  ),
);
const fiber = Effect.runFork(
  Effect.all([failing, Effect.never], {
    concurrency: "unbounded",
    discard: true,
  }),
);
await Effect.runPromise(Deferred.await(started));
fiber.interruptUnsafe(99);
await Effect.runPromise(Deferred.succeed(finish, undefined));
const outcome = await Effect.runPromise(Fiber.await(fiber));
// outcome is Failure with ordered Interrupt(99), Fail(5).
```

Parent interruption is **ambient state**, distinct from an explicit Interrupt reason value. The stable interpreter discards error continuations when its current fiber is interruptible and has a pending interruption request. A masked parent may still recover. Native checks must use the context's interruptibility-aware cancellation predicate, rather than treating a true watch value as an unconditional recovery prohibition. Bracket cleanup must retain a failed masked acquisition's existing error; globally prepending Interrupt at every bracket boundary would contradict the probes.

## Admission and representation

Retain fixed topology: All has two or three children, Race two, explicit All unbounded/discard options, no nesting or group creation in cleanup. Unit success remains the group result; a child with Never success that only fails can participate if the checker proves the same no-value-crossing boundary. Ignore Never error witnesses when finding the group's one common error witness. First errors are **Bool, U64 or Unit**: generated equality matches their Effect equality and values have known compact native representations. Composite values, floating-point errors, arbitrary Error objects and annotation-sensitive equality are separate gates. String is a possible later expansion with measured owned-payload costs.

Existing restrictions remain: infallible finalizers, explicit child-local Scope, no outer Ref/file handle capture, no mutable scripted Clock/Random inheritance, no RemoteStore/Launch or general Fiber identity. There is no authored failCause, explicit self-interrupt or Die primitive in this slice. Every admitted child therefore contributes at most one Fail; canceled siblings do not introduce extra typed failure from cleanup. Sequential composition may propagate an existing group Cause, but cannot merge independent old and new failures. With nesting refused, the maximum admitted All outcome is **three Fail reasons plus one parent Interrupt marker**. Capacity four is compiler-proved for this profile, not a silent cap on the general upstream Cause API.

Prefer a conditional, fixed-capacity runtime cause buffer over Vec, SmallVec dependency or boxed outcomes. Keep the existing singleton Fail(E)/Interrupted paths where possible, adding the richer carrier only to artifacts reaching fallible groups. Store reason ordering explicitly. All combines equal scalar failures and filters group-induced sibling Interrupt reasons; Race preserves duplicate failures when every child fails, and parent cancellation returns sole Interrupt. All parent cancellation prepends one admitted parent marker while retaining observed typed failures. Repeated observation of the same watch request must not add duplicate markers. Pending cancellation and an explicit reason must remain separate concepts.

Interrupting fiber IDs and upstream reason annotations are outside the first **runtime observation** profile. Compare reason tags and typed payloads; do not expose an invented numeric ID. This is a deliberate declared observation boundary, not full Cause equality, a wire-compatible RPC Cause or the existing Fail-only public Cause value witness. Async Effect.exit stays refused until its checked value witness can represent every admitted runtime reason. A host requiring richer protocol causes must reject the profile or implement an independently verified adapter; it must never silently choose one Fail and report it as the entire failure.

### Error-channel changes require a carrier decision

Upstream Effect can retain an original typed Fail after an interrupted catch/result continuation is skipped, even though the wrapper's declared error channel changed to another type or Never. A generic `Combined<E>` cannot represent an old Bool failure inside `Combined<Never>`. The buffer capacity proof alone does not resolve this ownership/type problem.

Two sound choices are available before admission:

1. Keep generic inline E storage and explicitly refuse E-changing recovery around a reachable fallible group, including transformations to Never. Same-E recovery is still testable and useful; exact reachability checks must cover wrappers and finalizers.
2. Use a conditional runtime failure-payload enum for the three admitted scalar families, independently of the current computation E. A checked first-error conversion uses the source witness when recovery actually runs; forwarding a mixed pending-cancellation Cause retains the original payload tag. The tag belongs only to materialized runtime failure reasons, never every ordinary scalar. This supports error-channel changes but adds representation/conversion obligations and must preserve old scalar programs' layouts.

**Implementation decision:** root/core review selected option 2 before feature edits: a nongeneric finite RuntimeFailure payload for Bool/U64/Unit inside the reached-only Combined carrier. Destination error witnesses need not be artificially constrained; a skipped recovery forwards the original represented scalar payload. The private framed reference preserves that original payload too. Any conversion of a singleton source Fail into this richer carrier must check its actual source witness. If a widened source can carry an unsupported composite old error, reject that retained-payload path or supply a verified wider representation. Reachability of a scalar child group alone does not prove every error elsewhere in the enclosing graph is scalar. An unsafe cast, unreachable assumption or conversion to an arbitrary replacement E would erase an observable failure.

## Framed reference and diagnostics

### Host integration decision

Recorded before host feature edits: the scalar CLI emits ordered `cause:` reasons tagged `interrupt`, `u64:…`, `bool:…` or `unit`. NativeRunner validates each scalar representation independently of the final declared E: skipped recovery can retain an earlier channel's error. It reconstructs the observed Effect Exit without inventing an interruptor identity. NativeRpc refuses handlers reaching fallible groups until compound protocol causes and retained earlier-channel errors have a verified wire adapter. Existing infallible groups remain admitted; projecting a combined failure to one RPC error is not permitted.

Effect.mapError itself selects the first typed error through catch; it is not a Cause-preserving mapper. Frame wrapping/unwrapping must instead use Cause.map through catchCause, preserving reason order and non-Fail reasons. At the invocation boundary observe the actual outer Exit, rather than using typed catch to reconstruct a singleton Failure. Pending ambient cancellation must not be neutralized by the diagnostic adapter.

Frame envelopes are internal diagnostic sidecars. If they replace E with plain fresh objects, equal scalar errors become unequal to Cause.combine, changing All deduplication. Make their equality/hash delegate to semantic E, or use an equivalently verified adapter; frames must not change failure identity. Keep the first retained failure trail separately from ordered semantic reasons. This slice does not promise a diagnostic trail for every child failure. Authored logging annotations remain owned context state; they are not a reason-annotation equality API.

## Decisions and revisit triggers

| ID           | Decision                                                                                                                                                  | Revisit trigger                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| FALLIBLE-001 | Preserve ordered runtime causes; All deduplicates scalar failures, Race retains duplicates.                                                               | Composite/annotated errors or authored failCause.                         |
| FALLIBLE-002 | Fixed buffer bound four follows from three non-nested children and infallible cleanup; machinery is reachability-selected.                                | Nested groups, fallible cleanup or dynamic task topology.                 |
| FALLIBLE-003 | All pending parent cancellation retains typed failures; Race cancellation produces sole Interrupt.                                                        | Child self-interruption, multiple interruptors or explicit Cause input.   |
| FALLIBLE-004 | Sticky cancellation suppresses recovery only when the current context is interruptible; masked failure is preserved.                                      | Public masking combinators or wider bracket semantics.                    |
| FALLIBLE-005 | Bool/U64/Unit errors initially; no scalar metadata wrapper, full fiber ID/annotation/defect profile deferred.                                             | Real wire/outcome consumer or broader equality requirement.               |
| FALLIBLE-006 | Frame adapters preserve whole Cause and semantic error equality; selected diagnostic trail is external.                                                   | Multi-child trail presentation or reason annotations.                     |
| FALLIBLE-007 | Use a reached-only independent Bool/U64/Unit failure payload carrier to retain old errors across E-changing recovery; check source conversion boundaries. | Wider represented error families or verified generic existential storage. |
| FALLIBLE-008 | Async exit and richer RPC Cause exposure remain independent gates.                                                                                        | Checked Interrupt/Die value witnesses and wire conformance.               |

## Validation and costs

Compare independent official programs with plain/framed reference and native debug/release under None/Bounded failure-frame policies. Observe ordered reasons, selected first typed error, success, interruption, continuation execution and cleanup completion. Required workloads include immediate failure skipping later children; deferred first failure cleanup before sibling cancellation; reversed completion order; equal-error All dedup versus Race duplication; Race failure followed by success; parent cancellation during failure and loser cleanup; masked acquisition failure and same-profile recovery; and all three scalar error families. Test structured refusals for widened error types, topology, resources, services, async exit, protocols and unsupported channel changes.

Use controlled start/cleanup/cancel barriers or manually polled futures with a documented first-Pending state. Wide timer gaps can support a regression fixture but do not prove an ordering theorem. Timeout fixtures must expose their actual start observations; a start signal before an interpreter suspension may require an explicit scheduler yield in the probe.

Measure actual Cause/context/future layouts, complete group setup allocations, retained allocation changes over repetitions, generated Rust growth and dependency reachability. None-frame execution must not allocate a frame trail. Inline buffer storage may enlarge error/future layouts even without allocating; report this separately. Existing no-fallible-group artifacts must retain their prior native error representation and task-group cost measurements. No general zero-allocation execution claim follows: independent child watch channels already allocate once per child at setup.

After this complete failure lifecycle path passes, the next separate workload is lexical coordinator ownership: Deferred completion broadcast, late awaiters and independently interrupted waiting children. Fallible groups alone do not make an outer Ref safe to share, provide a Fiber handle, or justify Tokio Semaphore FIFO semantics. Continue through [the coordination admission gates](coordination-modules.md) before adding those modules.
