# Suspended scalar RPC preparation — 2026-10-02

This follows the checked scalar RPC/auth adapter, scoped logging and independent source/frame policies. The first async workload is a bounded literal delay under annotations and a non-failing `ensuring` cleanup. It does not admit general fibers, Scope, services, streams or arbitrary Promise/generator authoring.

## Checked primary sources

- [Effect 4.0.0-rc.118 internal execution](https://unpkg.com/effect@4.0.0-rc.118/src/internal/effect.ts): `ensuring` delegates to `onExit`; its continuation masks interruption while executing cleanup and preserves the body exit. Nested cleanup unwinds inside first. Installed public APIs are the reference interpreter, including interruption through a real Effect fiber.
- [Pinned HTTP RPC implementation](https://unpkg.com/effect@4.0.0-rc.118/src/rpc/RpcServer.ts): the HTTP protocol owns client lifetimes and disconnects; leaving a request closes its resources. [Wire messages](https://unpkg.com/effect@4.0.0-rc.118/src/rpc/RpcMessage.ts) distinguish Interrupt from typed Fail. JSON interruption uses `_tag: Interrupt`, with optional fiberId; native execution has no matching JS fiber identifier.
- [Tokio 1.53.1 sleep](https://docs.rs/tokio/1.53.1/tokio/time/fn.sleep.html): dropping the timer cancels it, without async cleanup. Requires a time-enabled runtime. [watch](https://docs.rs/tokio/1.53.1/tokio/sync/watch/index.html) retains the latest cancellation flag; closing senders wakes receivers.
- [http-body 1.0.1 Body](https://docs.rs/http-body/1.0.1/http_body/trait.Body.html): response production can await a channel through poll_frame. A body-owned cancellation sender can signal a surviving worker on drop. Actual Axum/Hyper disconnect behavior must be tested over a socket, not inferred from the trait.

Sources accessed online on 2026-10-02; versions match existing generated HTTP dependencies. Rust 1.98.1 is the local validation compiler.

## Chosen boundary and alternatives

Add `R.Effect.sleep(milliseconds)` for integer literals 0–60000, and `R.Effect.ensuring` for Unit/Never cleanup. Validation checks forged IR too. A separate RPC-only suspended wrapper would introduce a second composition language and miss authored annotation scopes; use the existing IR, reference, checked lowering and mapped writer instead. An explicit `Rust.tokio` capability profile enables async lowering; default std compilation refuses reachable async nodes. Only reachable async code selects Tokio time/sync features.

Generate concrete async helper futures, without boxing each helper. Every effect helper in a suspended function receives a mutable execution context; pure helpers remain ordinary functions. Context owns cancellation and interruption masking, annotations/spans/request JSON when logging is reachable, and optional failure storage. Scalar values remain plain bool/u64/Unit. No TLS guard survives an await. Frame capture None must remove the trail field and propagation, independently of source artifacts and logging. Context-owned trails preserve the existing 32-frame construction cap and drain behavior.

Cooperative cancellation is an execution outcome separate from domain errors. A delay checks cancellation and selects the timer versus cancellation. `ensuring` awaits the body, masks cleanup, awaits cleanup exactly once and restores the mask; enclosing cleanup still runs. Restricted non-failing cleanup avoids claiming full finalizer Cause combination. Cancellation is observed at generated effect boundaries; synchronous expressions cannot be preempted.

For async HTTP groups, a worker owns parsed input, headers and immutable auth state. Returned response body awaits its oneshot result and signals cancellation when dropped. The worker remains alive to await finalizers; never abort it on disconnect. ID/tag may borrow from the worker-owned JSON during dispatch, while projected principal stays a plain u64. Construct owned request log metadata only for reachable logging. Validate bounds and duplicate IDs before dispatch; batch dispatch remains sequential. Stop beginning new requests after cancellation. Synchronous groups retain their existing runtime/dependencies.

Dropping a generated future directly cannot guarantee async cleanup. Native callers must signal cancellation and await completion. Process crash, panic/task abort and server shutdown/draining are outside this guarantee; this slice does not advertise resource Scope or graceful shutdown.

## Acceptance

Compare official Effect with debug/release native execution for delayed success/domain failure, nested finalizer ordering, interruption with delayed cleanup, scoped logs and frame paths. Exercise both frame policies, std refusal, forged invalid nodes and cast-free authoring. Real HTTP tests must prove concurrent ID/principal/annotation isolation and socket-disconnect cleanup exactly once, with no post-delay body log and no stale state in subsequent requests. Stock Effect clients must call the async endpoint unchanged. Record representative future/context sizes and allocation limits without asserting all futures are cheap. Keep existing sync conformance passing.

## Implementation and observed conformance

The bounded slice is implemented as Sleep/Ensuring IR, the official Effect
reference interpreter, explicit Rust.tokio capability selection and concrete
async helpers through the existing mapped writer. AsyncContext owns interruption,
log scopes and optional failure storage. Tokio time/sync are selected for reachable
async code; std-only programs remain dependency-free. Rs gained async function
and Tokio main helpers; the static borrowed RequestContext lifetime is explicit.

Focused native tests pass debug/release for both frame policies, with matching
typed exits and failure paths, nested masked delayed cleanup, cancellation before
entry, and cancellation during successful versus failed cleanup. Effect preserves
a failed body's typed failure when interruption arrives during masked cleanup;
a successfully completed body becomes interrupted. That distinction is tested,
not inferred from a Tokio select. Native cancellation frames remain bounded
internal diagnostics; the existing reference frame observer propagates interruption
and does not provide an interruption-frame oracle.

The HTTP corpus uses unchanged stock clients, eight overlapping principals per
run and a real socket disconnected after the started log. Native workers await
both delayed finalizers once, emit no post-delay body log, skip the next batched
handler and leave subsequent contexts clean. Debug/release and Bounded/None pass.
The stock web-handler oracle must wrap its raw HTTP effect in Effect.interruptible,
matching HttpRouter's route behavior: HttpEffect.toHandled starts uninterruptible
for response handling. Without that wrapper the test would exercise a different
request policy. [Pinned HTTP effect](https://unpkg.com/effect@4.0.0-rc.118/src/http/HttpEffect.ts)
and installed router code establish this boundary.

[Layout/allocation probe](../../packages/reffect/scripts/async-cost.ts) and
[raw results](async-cost-results.json) record context/future sizes, shared-helper
growth and construction allocations. [Metadata costs](../metadata-cost.md#async-context-and-future-costs)
explains the separate watch, polling/logging/HTTP costs and measurement limits.
[Example](../../examples/rpc-async/README.md) demonstrates the public path. Full
regression and post-commit evidence will be recorded in PROGRESS.md.
