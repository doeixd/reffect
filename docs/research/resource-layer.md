# Bounded resource-bearing Layer profile

Status: **accepted for implementation** (milestone 3B, PLAN frontier). Checked 2026-10-02 against installed Effect **4.0.0-rc.118** source (`node_modules/effect/src/Layer.ts`, `src/internal/layer.ts`; upstream [Layer.ts](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.118/packages/effect/src/Layer.ts)) and by running official programs under the installed version. Extends the [static Context/Layer profile](context-layer.md) with the [bounded sequential Scope registration](resource-scope-registration.md) substrate.

## Prior work

- CTX-001–005: lexical scalar services, ID/witness compatibility, per-provide memo, explicit `sequence`, pure-only `merge`, non-failing resource-free `Layer.effect`.
- Scope registration: lexical `scoped`/`addFinalizer`/scalar `acquireRelease`/`RegisteredFile`, compiler-proved 16-slot capacity, registration-time context, masked sequential LIFO close. Registrations are ordinary computations; the checker proves an enclosing `Scope` node discharges each one.

## Pinned upstream semantics

- v4 has no `Layer.scoped`. `Layer.effect(service, effect: Effect<S, E, R>)` returns `Layer<I, E, Exclude<R, Scope>>`: acquisition runs in the layer's scope, so registrations live as long as the layer.
- `Effect.provide(self, layer)` is `scopedWith(scope => flatMap(Layer.buildWithScope(layer, scope), ctx => provideContext(self, ctx)))`. The provide owns one scope that closes after the body.
- `fromBuild` forks a child scope per occurrence and closes it on failed construction. Children close in reverse order with the provide scope.
- `MemoMap.getOrElseMemoize` builds a shared layer once in a separate entry scope; each observing scope registers a refcount finalizer, and the entry closes when the last observer releases — i.e. at the LIFO position of the first occurrence.
- `buildWithScope` uses `CurrentMemoMap.forkOrCreate(fiber.context)`, and `buildWithMemoMap` adds `CurrentMemoMap` to the built context. A provide executed inside another provide's body therefore **reuses layers the outer provide memoized** (parent lookup); new entries stay local. `Layer.fresh` and `provide(..., { local: true })` start an unrelated memo map.

Observed with the installed version (each line is the official log trace):

| Scenario                                    | Official trace                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| Sequential A then B, body                   | acquire A, acquire B, body, release B, release A                        |
| Shared A observed twice                     | acquire A, acquire A2 (depends on A), body, release A — one acquisition |
| Nested provide of the same A                | acquire A, outer body, inner body, release A — inner reuses             |
| Nested provide of `fresh(A)`                | acquire A, acquire A, inner, release A, after inner, release A          |
| Nested provide with `{ local: true }`       | acquire A, acquire A, inner, release A, release A                       |
| A then failing F (registers before failing) | acquire A, acquire F, release F, release A; failure                     |
| Body failure                                | acquire A, release A; failure                                           |

## Decisions

- **RL-001 — accepted: `Layer.effect` admits scoped acquisition.** The acquisition may contain registrations (`addFinalizer`, `acquireRelease`, `RegisteredFile`) not discharged inside it. A layer is resource-bearing when its acquisition retains at least one registration for the enclosing scope. Alternative: a separate `Layer.scoped` spelling — diverges from v4. Consequence: no new IR node; the layer still provides one scalar service value.
- **RL-002 — accepted: provide-owned scope.** When the provided graph is resource-bearing, `Layer.provide` expands to `Effect.scoped(acquisitions → body)`, matching `scopedWith`. Sequential occurrences release in reverse acquisition order after the body; memoized occurrences acquire once and release at their first occurrence's position, which equals the upstream refcounted entry. Graphs without registrations are not wrapped: a scope with no finalizers is unobservable, and wrapping would move log-only providers into the async profile. Revisit if an Exit-observing feature makes an empty scope observable.
- **RL-003 — accepted: fallible acquisition.** Acquisition errors join the body error channel through `joinType` (same witness or Never), the layer error parameter tracks them, and provide's output error is their union. A failure after earlier registrations closes them in LIFO order before propagating, matching `fromBuild` plus the provide scope. Acquisition is not masked beyond the existing `acquireRelease`/`RegisteredFile` masking, as upstream.
- **RL-004 — accepted: nested provides inherit the enclosing memo.** While a provide's build callback stages its body, a nested provide's memo map forks the enclosing one: lookups consult the parent chain; new entries stay local. `fresh` occurrences and `provide(layer, build, { local: true })` use unrelated maps. Because inherited values are binders of the outer expansion, an inner computation that escapes the outer body is refused by the existing `FOREIGN_PARAMETER` check rather than silently reacquiring. This **revises CTX-003** for nested provides; the earlier per-provide table reacquired effectful providers inside nested provides, which diverged from upstream.
- **RL-005 — accepted: shared capacity budget.** Layer registrations count toward the provide scope's 16-slot proved budget alongside registrations made directly by the body; excess is the existing `SCOPE_CAPACITY` diagnostic before IO.
- **RL-006 — accepted: real workload.** A layer whose acquisition is `R.File.acquireReadOnly` provides the file size while the read-only file stays owned until the provide scope closes. No new Cargo crate, `AsyncContext` field or native service map is introduced; generated code remains scalar binders plus the existing finalizer enum.

## Implementation notes

- `StaticLayer` gains an error witness and a `resource` flag computed from `analyzeScopes(acquisition).retained`; `provide` wraps the expansion in `EffectIR.scoped` only when the flag is set. A nested provide whose resource providers all come from the enclosing memo still gets an empty scope; it is unobservable but selects the async profile.
- Nested inheritance uses a build-time stack of memo maps pushed while a provide's `build` callback runs (exception-safe), mirroring `CurrentMemoMap` in the fiber context. The provide's root memo is pushed, so entries created under `fresh` stay invisible to nested provides, as upstream.

## Deferred

Concurrent effectful/resource `merge`, `Layer.effectDiscard`/`effectContext`, service objects or methods, cross-invocation (server-lifetime) layers such as `Layer.launch`/`ManagedRuntime`, Exit-aware release, and child/parallel scopes. Server-lifetime layers are the likely next workload for RPC services and need a separate ownership decision: native values would outlive one invocation.

## Acceptance

Differential official Effect vs reference vs native debug/release, both frame policies: sequential LIFO release after body; shared one acquisition; `fresh`; nested inheritance, nested `fresh` and `local`; failed acquisition releasing earlier registrations; body failure; cancellation during the body awaiting release; registered-file size service with the file closed only at provide exit; capacity refusal; type contracts for error tracking and refusal of escaping inner provides.
