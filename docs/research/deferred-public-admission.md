# Bounded public Deferred compiler admission

Prepared 2026-10-05 before changing compiler admission. This supersedes the blanket public refusal in earlier private Deferred records only for the bounded standalone profile described here. Reviewed the compiler check/derive/plan/verify/lower path, lexical resource checks, generated-profile topology and callback receipts, owned execution boundary, growth limits and exact-root native layout gate.

## Sources and semantic boundary

Verified installed **Effect 4.0.0** `src/Deferred.ts`, and consulted the [upstream Deferred source](https://github.com/Effect-TS/effect-smol/blob/main/packages/effect/src/Deferred.ts). Effect's make creates a one-shot cell; succeed is dual/data-first or data-last and reports whether it won; await retains the first completion for all waiters; isDone observes completion. The upstream module also accepts typed failures and more completion forms. Those signatures do not establish native support: public R authoring exposes only make/await/succeed/isDone, with an explicit success witness needed for native representation.

Existing decision records remain authoritative for scheduling, masking, cleanup, growth and layout: [owned execution](deferred-execution-boundary.md), [nested integration](deferred-nested-integration.md), [interrupted frames](deferred-interruption-frames.md), [generated growth](deferred-generated-growth.md), and [native layout](deferred-native-layout.md). Public default-context parity is established by the owned Promise boundary, not arbitrary embedding inside a caller's Effect runtime.

## Decisions

**DPUBA-001 — Admit the proven standalone subset through the ordinary compiler pipeline.** Replace the unconditional plan-stage Deferred refusal with complete generated-profile validation. The subset remains zero authored inputs, Boolean/u64/Unit success, Never error, lexical scalar owners and at most six live task contexts; supported task nesting remains outer All2/3 with an initial inner Race2. Callback-created groups, deeper/multiple concurrent races, rich outcomes, service/resource scopes and unsupported computations remain refused. Apply the shared owned-execution trusted type/operation identity validator too, so compiler and supported reference execution admit the same expressions. This prevents a custom reference callback from bypassing the scheduling receipt.

**DPUBA-002 — Waive only the replaced nested-task diagnostic.** Public check ordinarily refuses all nested groups. A Deferred function may waive NESTED_TASK_GROUP only after the complete generated profile has admitted that program. All other type, lexical binding, escape and task-group diagnostics remain intact. General non-Deferred nested groups retain their original refusal. Cache validated profiles by immutable Program identity to avoid redundant recursive validation across pipeline stages.

**DPUBA-003 — Reuse the generated lowering and native gates.** Route verified Deferred programs through the existing lowerDeferredFunctions adapter; ordinary programs retain their current lowering. Mixed modules keep ordinary functions unchanged. Direct ordinary lowerFunctions remains incapable of bypassing Deferred admission. Both frame policies and source-artifact policies retain independent structural, source-byte and exact-native-future size gates. Emitting Rust is not evidence that cargo check/native code generation will accept its concrete layout.

**DPUBA-004 — Hosting remains separate.** Do not imply Deferred RPC support merely because standalone exports compile. NativeRpc needs an explicit refusal until request-context, cancellation and cross-request adaptation have their own evidence. Owned default-context DeferredExecution is the public supported reference boundary; existing ordinary Reference behavior is preserved but ambient hooks/context are not a scheduling parity contract. Typed-error completion remains private pending a compound outcome adapter.

## Validation obligations

Public compilation must emit the proven coordinator for sequential retained completion and admitted nested Race, under both frame/artifact policies, and preserve ordinary exports in mixed modules. Meaningful refusal cases include ordinary nested groups, typed-error owners, callback-started groups, escaped handles, custom reference operations, structural/budget limits and unsupported hosting. Existing native suites must verify cancellation, awaited finalizers, exact interrupted frames, inline storage/no-allocation behavior and concrete layout refusal; run Cargo suites sequentially. Focused compiler tests may validate pipeline admission without spawning Cargo.

Remaining decisions: richer error/Cause channels, supported ambient Effect composition, RPC embedding, wider task/capture/input profiles, target/compiler drift, build receipts and referenced/peak heap budgets.

## Post-implementation review

DPUBA-005: route synchronous emission refusals through the compiler's typed CompileError channel. Review reproduced a real mixed module whose ordinary log pushes emitted Rust beyond 2MiB: the prior unguarded emitFunctions call produced an Effect defect, so callers could not recover the documented diagnostic. Wrap emission in Effect.try and preserve existing CompileError diagnostics; unexpected emitter exceptions become EMIT_FAILURE. The new public regression fails before the fix and checks both artifact policies, including source-location wrapping. Generated Rust and native representations are unchanged.
