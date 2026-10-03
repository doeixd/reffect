# Named function calls and recursion in the IR

Status: **historical design analysis; decision refined 2026-10-03.** Written 2026-10-02 after `R.flow`. The per-pass blast-radius analysis remains useful, but [R language direction](../r-language.md) now treats **D1 as an internal IR fact behind naturally callable `R.fn` values**, not a public `.call()` API. Ordinary TypeScript function-reference identity supplies `FunctionRef`; recursion is discovered from the call graph and proper-tail lowering is derived by the compiler. **D2 runtime first-class function values remains out of scope.**

## The distinction that matters

Two very different things travel under "first-class functions":

- **D1 — named call node.** A `Call` node that references another function already declared in the same `Program` (or a resolved library function). Call sites are monomorphic and resolved at compile time. This is ordinary structured programming: helpers and recursion.
- **D2 — first-class function values.** Functions passed as arguments, returned, stored, or dispatched dynamically (closures, `dyn Fn`, higher-order IR). This is a representation model change.

The project thesis — "statically representable subset", every value has an `IRType` with a known native representation — **excludes D2** for the foreseeable future. A function value has no scalar native representation in the current model, and admitting one would undermine "compile abstractions away" by retaining dynamic dispatch. D2 is out of scope unless the representation model is deliberately reopened, which would be a much larger, separately justified decision.

D1 is the interesting question.

## What `flow` already settled

`R.flow` composition is **authoring-time composition of entry functions**, not calls _within_ the IR. The shipped substitution approach answers exactly "compose these functions into one" by inlining, so it does not build D1 and does not need it. Conflating the two would be a mistake; `flow` remains correct on its own terms.

## Why D1 is probably inevitable eventually

- **Recursion.** A self-referential computation (walking a tree, paginating, retrying with state) cannot be expressed by inlining; it needs a named node that refers to itself.
- **Real multi-function programs.** Once `Program` holds several named RPC and Remote handlers, shared helpers will be wanted without duplicating their bodies at every call site.
- **Diagnostics and size.** Named calls give stable logical frames (the existing `functions.name` paths already key on names) and avoid generated-size growth from repeated inlining.
- **"Compile abstractions away" applies to Effect abstractions, not to user structure.** User-defined functions are not an abstraction to erase; preserving them is what enables recursion and honest diagnostics.

None of these are pressing today. All of them are true of a mature program.

## Blast radius (why it is not a small slice)

Adding a `Call` node touches essentially every pass:

| Pass / module | New obligation                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `kernel.ts`   | `Call` node; function reference identity; argument binding and arity/witness checking across functions |
| derive        | Dependency graph between functions; reachable-requirement/effect union across call boundaries          |
| normalize     | No-op today, but call identity must survive; cycle handling semantics (recursion) defined here         |
| plan / verify | Cross-function implementation selection; ensure a callee is lowered before/with its caller             |
| provenance    | Call-site occurrence plus callee definition origin; logical-frame boundaries at calls                  |
| ownership     | Argument/return value ownership across the boundary; borrow vs move rules                              |
| lower / emit  | Call graph ordering, recursion, forward references, generated function signatures                      |
| reference     | Official-Effect interpretation of calls with matching frame, interruption and finalizer behavior       |
| frames        | `Call` becomes a logical-frame kind; recursion depth is a new bound/frame concern                      |

The hardest parts are **cross-function effects, requirements and resources** (a callee's error/requirement/finalizer surface must be modeled at the call site) and **recursion semantics** (termination is the program's concern, but the runtime must not add depth limits that alter observable behavior). These amount to real effect inference across a call graph — a generational step, not an authoring convenience.

## Triggers that should justify D1

Implement D1 only when a concrete workload demands it:

1. **Recursion is required** by a real admitted workload (self-referential computation).
2. **Inlining duplication is unacceptable** — a shared helper composed into many entry functions produces generated-size or compile-time growth beyond the recorded budget in [performance.md](../performance.md).
3. **Cross-function effects/resources** are needed, e.g. a handler that must call shared effectful/resource-bearing helpers with correct finalization and cancellation.

Absent one of these, substitution inlining is the simpler correct choice and stays.

## Likely design shape (so it is not rediscovered)

- A `Call` node carrying a resolved `FunctionRef` plus argument expressions; monomorphic call sites; no closures.
- Callee error/requirement channels unioned into the call site during derive/plan using existing `joinType` semantics.
- Self/mutual recursion represented by reference identity, with an explicit, documented recursion policy (no artificial depth limit that changes observable behavior).
- `Call` is a logical-frame boundary (kind `"call"`), with `functions.name` paths as today.
- Ownership stays conservative: primitives copied, single-use moved, read-only borrowed; complex cross-call lifetime inference deferred until real concurrency workloads exist.
- Definition-time specialization preferred over dynamic dispatch; keep generated calls monomorphic.

## Recommendation

- **D2: out of scope** under the current representation model; reopening it is its own decision.
- **D1: deferred but likely**, gated on the triggers above; it is a foundational IR change to be sequenced only after the current small, verified slices (Query→Rust, async/RPC, resource Scope) are established.
- **`R.flow` stays as shipped** (authoring-time substitution), independent of D1.

This record should be revisited when a milestone names recursion or shared effectful helpers as an acceptance requirement; at that point, promote it to a researched plan with per-pass conformance obligations before any IR change.
