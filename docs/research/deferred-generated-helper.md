# Generated Deferred helpers

Prepared 2026-10-04. This implements DGEN-001–005 after reviewing the private IR, real-context turn adapter, helper memoization and existing cooperative All emitter. Primary semantics and pinned upstream links are recorded in [generated lowering](deferred-generated-lowering.md).

**DHELP-001:** Share the ordinary lowerer through a private validated entry point. Ordinary lowering continues to refuse Deferred; selected profile data is build-owned and optional, so ordinary generated artifacts retain their current shapes.

**DHELP-002:** Carry owner borrows in a separate helper capture list, never as scalar parameters. Lexical owners are inline `DeferredState<A, Infallible, N>` locals. Invocation-owned bank and copied borrowed turn handles are separate helper arguments; no AsyncContext changes, global state, boxed owners or per-scalar metadata.

**DHELP-003:** Retain lexical owner captures for child and immediate Ensuring helpers. Deferred is excluded from delayed resource cleanup by the private profile. Child slots are statically 1 through arity, root is 0; unnested groups may reuse slots after their futures finish.

**DHELP-004:** Wrap only whole child tasks and verified Sleep/Await primitive suspension. Completion masking uses the existing turn adapter; artificial completion Pending never becomes semantic suspension. Bank-aware All retains ordinary cancellation channels and waits for child finalization.

Validation requires generated debug/release and frame-policy conformance, borrow signatures, public refusal, and unchanged ordinary runtime omission; root owns these integration tests.

The private host function is asynchronous even for a sequential owner with only synchronous queries: this keeps one real AsyncContext interruption/error boundary. Pure helpers remain synchronous and receive no turn or owner captures. Ordinary functions do not acquire profile/capture fields or emitted coordinator code.

Initial scoped validation: strict TypeScript passes; ordinary Rust-emission and public Deferred-refusal suites pass (7 tests in 2 files). Full generated conformance is recorded by the integration owner.
