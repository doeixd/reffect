# IR function composition for `R.flow`

Status: implemented (Option C). Prepared 2026-10-02 against installed `effect@4.0.0-rc.118`; implementation and validation recorded in [PROGRESS.md](../../PROGRESS.md). This responds to the question "does `flow` compose `R.fn`?" and to the direction that `R.flow` should compose reffect functions while plain functional composition stays in `effect`.

## Observed behavior

`flow` from Effect is left-to-right function composition with 1–9 overloads; the first function may have any arity and every following function must be unary ([`effect/src/Function.ts`](https://unpkg.com/effect@4.0.0-rc.118/src/Function.ts)). It composes **callable functions**.

reffect functions are not callable:

- `Fn`, `EffectFn`, `Expr`, `Computation` and `Program` all `extend Pipeable.Class`; they expose `.pipe`, not `[[Call]]`.
- TypeScript rejects `R.flow(fnA, fnB)` where `fnA`/`fnB` are `R.fn(...)`, and forcing it at runtime throws `ab.apply is not a function` when the returned wrapper is invoked.
- Single-argument `flow(fn)` is identity, so `flow(fnA)` "works" but does not compose.
- `Expr` nodes are `Parameter | Literal | Apply | Match`; `Computation` nodes are the effect set. There is **no call node and no binder-substitution API** in the IR.

Plain function composition still composes the builder callbacks passed to `R.fn` (`(Expr<A>) => Expr<B>` / `(Expr<A>) => Computation<B, E>`), because those are ordinary functions. That is what the temporary `flow.test.ts` demonstrates and why the current `R.flow = flow` alias looks like it works until an actual `Fn` is passed.

## Decision question

What should `R.flow` mean?

| Option                   | Behavior                                                                       | Assessment                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| A. Plain alias (current) | `R.flow` is Effect `flow`; composes build-time functions only                  | Does not satisfy "compose `R.fn`"; duplicates Effect under a reffect-specific name                                         |
| B. Overloaded dual       | Compose `Fn`/`EffectFn` when given IR functions, else delegate to plain `flow` | One name, two semantics; harder inference/errors; still duplicates Effect                                                  |
| C. IR-only `R.flow`      | Compose `Fn`/`EffectFn`; plain `flow` imported from `effect`                   | Clear separation; matches the stated direction; small surface; recommended                                                 |
| D. IR call node          | Program functions callable by name; `flow` desugars to calls                   | Enables recursion/named reuse but touches reference, frames, provenance, lowering; see [function calls](function-calls.md) |

**Recommendation: C**, as a bounded substitution/inlining slice, with D deferred until a workload needs recursion or named reuse. Overloading (B) is rejected because two different meanings under one exported name makes inference and diagnostics worse, and it re-duplicates Effect's utility. The top-level `flow` re-export added alongside the current alias should be dropped; callers wanting plain composition import `flow` from `effect`.

## Bounded semantics

`R.flow(f1, …, fn)` returns a new `Fn` when every argument is a `Fn`, otherwise an `EffectFn`. By induction on a pair:

- Result inputs are `f1`'s inputs; result output is the last function's output.
- Every function after the first must have exactly one input whose witness equals the previous function's output. `f1` may be multi-ary or zero-ary.
- Result error channel is `never` for an all-pure chain, otherwise the union of the `EffectFn` errors.
- A single argument is identity.

Composition is build-time inlining, chosen per pair:

- `Fn → Fn`: `body = subst(f2.body, f2.binder ↔ f1.body')`, where `f1.body'` re-binds `f1`'s parameters to the result's new parameters.
- `Fn → EffectFn`: substitute the pure expression into `f2.body`'s input parameter.
- `EffectFn → Fn`: `Effect.map(f1.body', value => subst(f2.body, f2.binder ↔ value))`.
- `EffectFn → EffectFn`: `Effect.flatMap(f1.body', value => subst(f2.body, f2.binder ↔ value))`.

Substitution is capture-free: binders are fresh `Symbol`s created per `make`, replacements reference only the new parameters or the immediately enclosing `map`/`flatMap` binder, and each component's own binders are fully replaced.

## Consequences

- **Reference/native behavior.** Only existing `Expr`/`Computation` nodes are nested, so reference interpretation and native lowering are unchanged. Interruption, cancellation masking and finalizer ordering are inherited from `flatMap`/`map`.
- **Frames and provenance.** Inlined component nodes keep their `source`, so authored diagnostics still resolve. The composed body is a single function boundary: component boundaries do **not** appear as separate logical frames. Per-component frames would require D or explicit `R.Log.span` boundaries; record this explicitly rather than implying parity.
- **Sharing and size.** Memoized substitution preserves sharing inside an inlined body (identical nodes map to identical results). Composing the same component into several functions duplicates its graph per composition; lowering still deduplicates by node identity within one function. Measure generated size before promising anything.
- **Resources.** Substitution does not change lexical scoping; a composed `EffectFn` containing a `ScopedSequence` must already close it with `scoped` inside the component.
- **Naming.** The result is unnamed; callers use `R.program({ Composed })` or `Source.named`. Do not invent automatic names, since they would not be stable.

## Refusals

- Type level: non-unary functions after the first; input/output witness mismatch; missing/extra arguments.
- Authoring: non-IR-function arguments raise `TypeError` (do not silently fall back to plain composition).
- Check stage: replacement preserves binder identity, so `FOREIGN_PARAMETER`/`TYPE_MISMATCH` continue to fire on malformed forged IR. Composed channels are taken from the constructors and re-checked by the existing `checkExpression`/`checkEffectFunction` passes.

## Implementation outline

1. Add a memoized `Expr.substitute(root, binder, replacement(index))` in `kernel.ts` (private-constructor access; not on the public barrel), rebuilding `Apply`/`Match`/`Literal` and replacing matching `Parameter` nodes.
2. Add a memoized `substituteComputation` in `effect-ir.ts` that rewrites parameters inside embedded expressions and recurses through `Map`/`FlatMap`/`Match`/`CatchAll`/`Ensuring`/`AcquireUseRelease`/`FileScope`/`Repeat`/`Retry`/`Annotate`/`Span` bodies.
3. Implement `R.flow` in a small `flow.ts` using those helpers plus `Fn.make`/`EffectFn.make` and the existing `map`/`flatMap` constructors. Provide 1–9 overloads mirroring Effect's arity, typed over `Fn`/`EffectFn`.
4. Remove the top-level `flow` re-export; keep `R.flow` IR-only. Move the plain-composition assertions to import `flow` from `effect`.

## Acceptance criteria

- Differential reference/native agreement for pure→pure, pure→effect, effect→pure, effect→effect, multi-ary first, zero-ary first, identity and 3+ chains, including the unioned error channel and interruption.
- No new IR node kinds, Cargo dependencies or `AsyncContext` fields.
- Provenance retains component origins; generated-size growth is measured, not assumed linear.
- Type contracts cover arity/unary/witness refusals; forged-IR checks still report `FOREIGN_PARAMETER`/`TYPE_MISMATCH`.
- Documented boundary: composed components are inlined and are not separate logical-frame or naming boundaries.

## Open questions

- Should `R.flow` also accept `Expr`/`Computation` values, or strictly functions? Proposal: strictly `Fn`/`EffectFn`.
- Requirements union once `EffectFn` gains typed requirements (currently none).
- Whether preserving per-component logical frames matters for the first real workload; if so, D or explicit spans become the path.
- Whether to add constant-folding/CSE for repeated compositions later.

## Relationship to the roadmap

This is authoring ergonomics, not a new semantic capability. It was implemented as a small side slice and must not displace the agreed next frontier, **resource Scope/acquire-release registration** ([PLAN.md](../../PLAN.md#current-frontier)).

## Delivered implementation

`R.flow` (and the package-level `flow`) is implemented in `packages/reffect/src/flow.ts` using `Expr.substitute` (`kernel.ts`) and `substituteComputation` (`effect-ir.ts`), both memoized and cycle-refusing. `FlowResult` types the outcome as `Fn`/`EffectFn`; runtime refusals raise `CompileError` diagnostics (`ARITY_MISMATCH`, `TYPE_MISMATCH`). `packages/reffect/tests/flow.test.ts` covers pure→pure, pure→effect, effect→effect, multi-ary first, identity, 3+ chains, runtime refusals and native debug/release reference parity; `flow-types.ts` covers inference and the `@ts-expect-error` for non-IR functions. Plain `effect` `flow` is no longer re-exported under the same name; it is imported from `effect` directly.
