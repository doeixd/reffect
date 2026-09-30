# Basic Effect IR and Boolean branching

Checked 2026-09-30 before implementation. Scope: the first complete milestone 2 profile, extending the existing public compiler pipeline rather than adding another compiler.

## Prior decisions and checked sources

- [Milestone 2 and initial ownership](../implementation-milestones.md#16-milestone-2--general-compiled-functions-and-effect-ir) require symbolic builders, Match/Predicate, succeed/fail/map/flatMap, the official Effect interpreter and conservative ownership. [Revised passes](../compiler-design-revision.md#10-compilation-passes) require checked support and explainable selection before lowering. Milestones 0/1 already establish immutable witnesses, identity-aware validation, dependency-free Cargo and native/reference conformance.
- Inspected installed `effect@4.0.0-rc.118` Effect.ts, Exit.ts, Cause.ts and Schema.ts. [Current official Effect source](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Effect.ts) was retrieved as supplemental primary evidence; installed RC.118 is the API authority. `succeed` returns a success, `fail` uses the typed error channel, map transforms only success, and flatMap sequences only success and preserves either error. Inspect Exit with official predicates/Match and Cause.squash for this single-failure profile, not discriminator comparisons.
- [Rust Result](https://doc.rust-lang.org/std/result/enum.Result.html) provides synchronous success/failure and explicit match sequencing; [Infallible](https://doc.rust-lang.org/std/convert/enum.Infallible.html) represents a never-valued channel. No scheduler, Tokio, allocator-dependent payload or external crate is required for Boolean/u64 values.
- Existing pure IR's binders and DAG locals can be reused, but continuation expressions require lexical scopes. Both validation and reference evaluation must avoid treating one node evaluated under different continuation bindings as the same cached value. Branch-local expressions must not be eagerly hoisted across Match arms.

## Supported contract

Add canonical Boolean and Never IRType witnesses, Boolean/u64 equality, unsigned ordering and Boolean negation. Keep exact bigint/u64 modular arithmetic. Pure `R.Match.bool(condition, onTrue, onFalse)` requires both branches, executes only the selected branch, and preserves the result witness. It is exhaustive for Boolean, not a claim to support arbitrary tagged unions yet.

Represent effectful computations separately from Expr with immutable success/error witnesses and nodes for succeed, fail, map, flatMap and Boolean Match. Callbacks execute once at authoring with symbolic values; runtime interpretation invokes no opaque builder callback. `R.fn(input, output, error, build)` declares an effectful function, while the existing three-argument pure form stays supported. `R.Effect.fn` offers the explicit effectful factory. Programs can mix pure and effectful functions.

Succeed has Never error; fail has Never success. Continuations and branches can widen a Never channel to an existing witness. Joining distinct non-Never witnesses is refused: automatic error unions/struct schemas need a later representation design. Function declarations explicitly check both channels. Pure and effectful branching may use Boolean/u64 values, and failures use Boolean/u64 payloads. Unsupported operations, effects and representations in either statically reachable branch are refused even if a particular execution would not choose it.

Interpret the computation through official Effect.succeed/fail/map/flatMap/suspend, with typed compiler diagnostics separate from domain payloads. Compare observable success or a single typed failure; defects, async effects, services, resource finalizers, interruption and concurrency are outside this synchronous compiled profile. Reference computations still run inside the official runtime; do not infer native support for the rest of that runtime.

## Lowering and ownership choices

Extend check/derive/plan/verify/ownership/lower/emit rather than bypassing operation support. Select verified scalar intrinsics and a fixed generated synchronous Result adapter; report required Boolean/u64 and synchronous-result capabilities with semantic references. Verify literal-only/identity functions too, since an empty operation list does not establish representation/capability support.

Use Rust bool/u64 by value and Infallible for Never. Lower Match into branch-local blocks and continuations into explicit Result matches; do not precompute the losing arm or continuation of a failed source. Preserve shared pure DAG locals within each lexical execution block, without caching effect executions. Shared branches emit memoized helper functions rather than recursively duplicated source; the memo includes lexical scope and does not cache execution. Fresh depth-32 release compilation showed optimizer inlining can recreate exponential branch trees and exhaust rustc memory. Shared helpers therefore use `#[inline(never)]`, preserving graph sharing through optimized compilation. No law-based optimization is introduced. This first slice exercises primitive copying; owned strings/records and move/borrow/clone inference are deferred, not treated as Copy.

Keep the existing arithmetic evaluator's decimal protocol and Cargo.validate working. Extend a typed native runner for Boolean/pure and success/failure outputs with explicit tagged scalar tokens. A domain failure is a valid native result with process status zero; malformed arguments or evaluator failures remain Cargo/compiler errors. Avoid dependencies and JSON bigint coercion.

## Acceptance and open work

Strict type fixtures cover tuple arity, Boolean condition types, mapped values, explicit error witnesses and pure/effectful distinction without user casts. Runtime checks cover escaped continuation binders, branch/channel mismatches, stale plans, unsupported capabilities/representations and unreachable unsupported operations. Differential tests compile fresh Rust debug/release crates and compare with official Effect Exit for both Match arms, overflow, success mapping, failed-source short-circuiting, nested flatMap, repeated execution and Boolean/u64 error payloads. Validate public stages/build/runner and keep arithmetic/Foldkit conformance green.

Before broader milestone 2 completion: design owned String/record/union representations, full tagged Match, automatic error unions and advanced ownership. RPC and services remain milestone 3; async scopes/interruption remain later. Record actual commands/results and profile boundaries in PROGRESS.md and package docs.
