# Dynamic resource Scope registration

Preparation for the [current frontier](../../PLAN.md#current-frontier), step 1: research and record acquisition masking, registration, reverse release order, nested closure, interruption and the supported Exit/Cause subset **before** choosing IR/API or an implementation. Checked 2026-10-02 against installed Effect **4.0.0-rc.118** and its pinned source; Tokio **1.53.1**.

Status: **decision record only.** No IR, API or lowering changes are proposed for implementation here. This generalizes the existing structured [scalar bracket](resource-scope.md) and [real read-only file adapter](scoped-files.md) into a bounded _dynamic registration_ profile, the prerequisite for resource Layers.

## Prior art in this repo

- [Structured scalar bracket](resource-scope.md): lexical `R.Effect.acquireUseRelease`, masked acquisition/release, non-failing Unit/Never release, no registry.
- [Scoped native files](scoped-files.md): one real owned `std::fs::File` per lexical `R.File.scoped`, borrowed helpers, explicit close before awaited cleanup, escaping-capture refusals.
- [Bounded async RPC](async-rpc.md): owned `AsyncContext`, cooperative cancellation, awaited once-only finalizers.

Both current forms specialize a **lexically reachable** bracket into generated control flow. Neither has a runtime collection of finalizers. Dynamic Scope registration is precisely "finalizers whose count/order is only known at runtime", so it needs a different mechanism.

## Pinned Effect v4 semantics

- `Scope.addFinalizer(scope, finalizer)` appends a finalizer to the scope; `Scope.close(scope, exit)` runs them. Sequential finalizers run in **reverse registration order** ([Scope.ts](https://unpkg.com/effect@4.0.0-rc.118/src/Scope.ts) examples: `["work","memory","file","database"]`).
- `Scope.make("sequential" | "parallel")`; `fork(scope, strategy?)` creates a child registered with its parent. Closing the parent closes children with the same exit; closing a child detaches. Example cleanups `["child","parent"]`.
- Closing finalizers run **uninterruptibly by default**: interrupting the closing fiber waits for them; a finalizer may explicitly restore interruptibility.
- `Effect.acquireRelease(acquire, release, { interruptible? })` returns `Effect<A, E, R | Scope>` — it **requires a Scope**. Release receives the resource and the use `Exit`.
- `Effect.addFinalizer` requires `Scope` and returns `Effect<void, never, R | Scope>`; `Effect.scoped` provides it.
- Closed scopes have immediate-registration semantics: registering after close runs immediately (or the finalizer observes the closing Exit).
- `Scope.close` accepts an `Exit` and finalizers can receive it; `Effect.ensuring`/`onExit` are the Exit-aware non-scoped forms.

Uninterruptible release and reverse registration order are the two properties the current lexical brackets already satisfy; the new work is the _runtime-sized, runtime-ordered_ collection and its exit/interruption interaction.

## Decision options

| Option                                 | Approach                                                                                                                        | Assessment                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| SR-0: keep lexical-only                | Reject dynamic registration; require `R.Flow`-style specialization for each lifecycle                                           | Cannot express resource Layers or user-driven lifecycle; blocks the milestone                                |
| SR-1: **bounded typed finalizer list** | A scope value owns a typed, bounded collection of registered Unit/Never finalizers; close drains it in reverse order under mask | Matches v4 ordering/Exit-independent cleanup; bounded and verifiable; recommended first slice                |
| SR-2: general Effect Scope service     | Port `Scope` as a first-class Context service with `make/fork/close` and Exit-aware finalizers                                  | Requires Exit/Cause representation, Context service plumbing and unbounded/fallible finalizers; too wide now |
| SR-3: RAII-only                        | `Drop` + detached async cleanup                                                                                                 | Cannot await ordering/completion or restore interruption; rejected (already recorded in SCOPE-004)           |

## Proposed bounded decisions (for review, not yet implemented)

- **SCOPER-001:** Admit a typed, **bounded** registered-finalizer scope. The bound is a compile-time maximum (`maxScopeFinalizers`) so native storage is a fixed-capacity collection; exceeding it is a checked refusal, not unbounded growth. This keeps the "no global mutable finalizer stacks" property while allowing runtime-sized registration.
- **SCOPER-002:** Admit **sequential** close only, in reverse registration order. Parallel strategy (`"parallel"`) and `fork`/child scopes are deferred; sequential reverse order is the common case and matches the pinned examples. Finalizers are Unit/Never (reusing the established cleanup contract); Exit-aware and fallible finalizers are deferred.
- **SCOPER-003:** Close runs **uninterruptibly** (reusing `AsyncContext.interruptible = false`), and closing waits for completion. Cancellation before close, during use, enters close and awaits cleanup; cancellation does not skip registered finalizers.
- **SCOPER-004:** Registration is masked, mirroring acquire. A failed/aborted acquisition registers nothing; a registered finalizer runs exactly once. Closed-scope registration (immediate-run) is deferred unless a workload needs it; the bounded slice may simply refuse registering after close.
- **SCOPER-005:** No OS-handle type is admitted by this decision. The first slice registers Unit/Never cleanup (tokens/logs/close calls) over the existing scalar/resource values; an OS-handle registration contract (ownership, escaping captures) requires the separate resource-implementation-registry decision named in the frontier.
- **SCOPER-006:** Lowering uses the existing owned `AsyncContext` (no TLS across await, no boxed dynamic futures); the registered collection is a generated, bounded value owned by the scope's generated control flow. No new Cargo crate.

## Interaction with existing work

- **Frames:** each registered finalizer keeps its authored origin; close-time failures are Unit/Never so no new failure frames arise, but the close boundary may add one logical frame kind (`scopeClose`) for diagnostics.
- **Source/observability:** registered finalizers retain provenance; logs inside finalizers keep existing ordering/annotation semantics.
- **Resource Layers:** SR-1 is the substrate resource Layers need (a Layer acquires a resource and registers its release), but Layer wiring/sharing is the separate 3B decision and is not admitted here.

## Acceptance gates (for the eventual implementation)

Differential official-Effect vs reference vs native debug/release, both frame policies:

1. Registration order vs close order (reverse), including nested scopes closing inner-first.
2. Exactly-once release on success, domain failure, and cancellation during use; cancellation before close still awaits registered cleanup.
3. Cancellation during close is deferred until cleanup completes (uninterruptible close), matching pinned v4.
4. Refusals: exceeding `maxScopeFinalizers`, registering after close (if refused), fallible/Exit-aware finalizer attempts, escaping an OS handle.
5. No new `AsyncContext` fields beyond `{ interruptible }` already present; measure scope/future growth and construction allocations separately from polling/logging.

## Resolved for the first slice

- **Bound:** `maxScopeFinalizers = 16`, per open scope instance (a fixed-capacity array in the generated scope value), not per function. Exceeding it fails the close path deterministically rather than growing; the IR checker also bounds statically reachable registrations per scope. 16 covers realistic request/connection cleanup without unbounded growth.
- **Closed-scope registration:** refused at runtime (the scope value records `closed`) to keep the bounded slice simple and avoid immediate-run semantics; `Effect`'s immediate-run-on-closed behavior remains a deferred SR-2 concern and is recorded as a divergence.
- **First workload:** an in-process registry of **unit cleanup callbacks** (log/token finalizers) proving registration/order/cancellation. Real OS-handle registration stays behind [SCOPER-005](#proposed-bounded-decisions-for-review-not-yet-implemented); the read-only file adapter already proves one real handle, so the next real handle is deferred to the resource-Layer milestone.
- **`fork`/child scopes:** deferred to milestone 12; this slice has one open scope per lexical `R.Effect.scoped` region plus nested scopes closing inner-first.

## Recommendation

Adopt **SR-1** as the bounded next slice after confirming the exact bound and closed-scope policy, keeping SR-2 (full Exit-aware Scope service) for the milestone that introduces Exit/Cause and resource Layers. This proceeds only after the current small slices are published and must not be conflated with Layer wiring. This record promotes [SCOPE-001](resource-scope.md) from "structured bracket only" toward a minimal registration profile; it does not yet admit native OS handles (SCOPER-005).
