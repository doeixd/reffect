# Qwik optimizer lessons for reffect closure conversion

Checked: 2026-10-02.

This note investigates whether Qwik's optimizer is useful prior art for reffect's Foldkit SSR migration frontend, especially the apparent problem posed by closures in the server-reachable TypeScript graph.

## Conclusion

Yes. Qwik is unusually relevant prior art, but mainly for **frontend analysis**, not for reffect's target representation.

Qwik already solves a closely related problem:

1. identify compiler-significant callback boundaries,
2. find the closure's free variables using lexical scope information,
3. distinguish enclosing locals from imports/module bindings,
4. make captures explicit,
5. rewrite the callback into another execution form,
6. preserve source/debug information and reject unsafe cases.

Qwik then preserves the closure as a lazy-loadable QRL and serializes or lifts its captures.

reffect should normally do something different after the same analysis:

1. identify **semantic callback boundaries** such as supported Effect, Array, Match, Layer, resource, and foreign-operation calls,
2. compute the callback's parameters and captures,
3. classify every capture by representability, mutability, ownership, service/resource lifetime, and semantic role,
4. turn representable captures into explicit IR dependencies or inline constants,
5. lower the callback body into structured reffect IR,
6. reject the remaining higher-order/escaping cases instead of emulating arbitrary JavaScript closures.

The practical result is important for the Foldkit SSR inventory: the current count of 1,184 closures is **not** 1,184 closure-conversion problems. Only closures in the true server-reachable graph matter, and only a subset of those cross a native semantic boundary. Many should collapse to ordinary symbolic callbacks or structured loops with no runtime closure at all.

The first implementation should therefore be a **non-mutating closure/boundary classifier over the Foldkit SSR corpus**, not a general JavaScript closure compiler.

---

## Verified upstream snapshot

Research used the current Qwik v2 tree at GitHub commit
[`8eb4589be115eb8f2dabfd12c107dcc23647caec`](https://github.com/QwikDev/qwik/tree/8eb4589be115eb8f2dabfd12c107dcc23647caec)
and current Qwik/Oxc documentation on 2026-10-02.

Relevant Qwik sources:

- [Optimizer overview](https://qwik.dev/docs/advanced/optimizer/)
- [Optimizer tutorial: closure capture and `useLexicalScope`](https://qwik.dev/tutorial/qrl/optimizer/)
- [Serialization boundaries](https://qwik.dev/docs/guides/serialization/)
- [QRL design](https://qwik.dev/docs/advanced/qrl/)
- [Rust optimizer architecture](https://github.com/QwikDev/qwik/blob/8eb4589be115eb8f2dabfd12c107dcc23647caec/packages/optimizer/core/README.md)
- [TypeScript capture analysis](https://github.com/QwikDev/qwik/blob/8eb4589be115eb8f2dabfd12c107dcc23647caec/packages/ts-optimizer/src/optimizer/analysis/capture-analysis.ts)
- [TypeScript fused module gather / scope analysis](https://github.com/QwikDev/qwik/blob/8eb4589be115eb8f2dabfd12c107dcc23647caec/packages/ts-optimizer/src/optimizer/analysis/module-gather-walk.ts)
- [Capture-analysis tests](https://github.com/QwikDev/qwik/blob/8eb4589be115eb8f2dabfd12c107dcc23647caec/packages/ts-optimizer/tests/optimizer/analysis/capture-analysis.test.ts)
- [Computed-key, block, and loop capture tests](https://github.com/QwikDev/qwik/blob/8eb4589be115eb8f2dabfd12c107dcc23647caec/packages/ts-optimizer/tests/optimizer/analysis/computed-key-block-scope-capture.test.ts)
- [Qwik optimizer development notes](https://github.com/QwikDev/qwik/blob/8eb4589be115eb8f2dabfd12c107dcc23647caec/.ruler/skills/qwik-optimizer-development/SKILL.md)
- [Qwik v2 changelog](https://github.com/QwikDev/qwik/blob/8eb4589be115eb8f2dabfd12c107dcc23647caec/packages/qwik/CHANGELOG.md)
- [Qwik license](https://github.com/QwikDev/qwik/blob/8eb4589be115eb8f2dabfd12c107dcc23647caec/LICENSE)

Relevant Oxc sources:

- [Oxc architecture](https://github.com/oxc-project/oxc/blob/main/ARCHITECTURE.md)
- [Oxc parser architecture](https://oxc.rs/docs/learn/architecture/parser)

Qwik is MIT licensed. Concepts and algorithms can be studied freely; if implementation code is copied or substantially adapted, preserve the applicable MIT notice and provenance. This note recommends adapting the design and tests rather than depending on Qwik's optimizer as a library.

---

## What Qwik actually does

### 1. It uses explicit optimizer boundaries

Qwik does not attempt to closure-convert every function in the program.

Its optimizer recognizes compiler boundaries marked by `$`: `component$`, `useTask$`, event handlers, and explicit `$()` calls. The callback at that boundary is extracted into a separately addressable symbol.

That is the first lesson for reffect.

reffect does not need a general closure pass over every arrow function. It needs a registry of **semantic callback consumers**.

Initial examples include:

```text
Effect.map / flatMap / catchAll / mapError
Effect.forEach
Effect.acquireRelease / addFinalizer
Array.map / filter / reduce
TaggedUnion.match / Match
Layer.effect / provide
registered foreign semantic operations
```

A callback passed to one of those operations has a known semantic role. A closure passed to an unknown function does not.

The codemod should transform the former and initially refuse or leave the latter outside the native graph.

### 2. It computes free identifiers with real scope information

Qwik's TypeScript optimizer uses Oxc parsing/walking and scope tracking. Its current implementation has a canonical per-module gather walk that collects closure free identifiers, lexical scopes, loop contexts, usage, and extraction information together.

The important shape is:

```text
closure body
   ↓
identifier references
   ↓
resolve against closure-local declarations
   ↓
free identifiers
   ↓
intersect with enclosing lexical scopes
   ↓
captures
```

This sounds simple, but the tests show why a source-text implementation is unsafe.

Qwik has explicit coverage for:

- destructured parameters,
- import bindings versus inner bindings with the same spelling,
- `var` and hoisting,
- declarations that textually occur after the closure,
- block-scoped values,
- loop bindings,
- computed member keys such as `record[key]`,
- nested extraction boundaries,
- function/class declarations versus variable captures,
- generated-binding collisions and shadowing.

reffect should treat capture discovery as compiler analysis, not as a codemod regex or name search.

### 3. It makes the environment explicit

A Qwik closure such as:

```ts
useTask$(() => {
  console.log(state.count)
})
```

is conceptually transformed into:

```text
extracted function
captures = [state]
```

and the extracted body retrieves the captured value from its explicit capture environment.

That is ordinary closure conversion in useful practical form: the implicit lexical environment becomes data.

For reffect, the analogous intermediate representation should be a `CapturePlan`, but the plan usually should not become a runtime environment object.

### 4. It specializes captures when possible

Qwik does more than blindly put every free variable into one capture array.

Current v2 work includes:

- const initializer inlining,
- hoisting QRLs that have no captures,
- moving event-handler captures into explicit parameters,
- consolidating special prop captures,
- excluding child-only nested extraction captures from parents,
- tracking loop variables specially.

This is directly relevant to reffect.

The ideal reffect transform should prefer, in order:

```text
inline compile-time value
    ↓ else
reuse an existing symbolic/IR value
    ↓ else
turn capture into explicit generated parameter/input
    ↓ else
represent it as an admitted service/resource dependency
    ↓ else
refuse
```

A generic closure environment should be a last resort, not the default.

### 5. Its bug history is a useful test inventory

Qwik's recent optimizer work is especially useful because it records the cases that break apparently-correct closure extraction.

Examples from the current changelog/tests include:

- block-scoped variables inside loops must be captured correctly,
- captures used only as computed keys must not disappear,
- nested optimizer boundaries must survive extraction,
- arguments after a transformed closure must not be dropped,
- more aggressive extraction exposed illegal mutation of module-level `let` bindings,
- generated names need deliberate hygiene across extracted sibling scopes,
- self references and nested QRL captures require explicit handling.

reffect should convert these into frontend regression categories even where the final semantics differ.

---

## Where reffect differs from Qwik

Qwik's objective is:

```text
closure
  ↓
extract code
  ↓
serialize / transport environment
  ↓
restore closure later in JavaScript
```

reffect's objective is usually:

```text
closure
  ↓
analyze callback semantics and captures
  ↓
turn both into explicit semantic IR
  ↓
specialize / erase closure
  ↓
ordinary Rust
```

For example:

```ts
const threshold = 10

users.filter((user) => user.age > threshold)
```

should not imply a Rust `Box<dyn Fn>` or a generic closure object.

The transformed representation should be conceptually:

```text
ArrayFilter
  input = users
  binder = user
  captures = [threshold]
  predicate =
    GreaterThan(
      Get(user, "age"),
      threshold
    )
```

and native lowering can emit an ordinary loop.

Likewise:

```ts
xs.reduce((total, x) => total + x, 0)
```

should become the existing structured Array loop IR and finally something like:

```rust
let mut total = 0;
for x in &xs {
    total += x;
}
```

The runtime closure has disappeared.

---

## Proposed reffect frontend model

### BoundarySpec

Do not hard-code closure rules independently in the migration package. Reuse semantic knowledge about the operation that consumes the callback.

A conceptual registry entry:

```ts
interface BoundarySpec {
  callee: SemanticRef
  callbackArgument: number
  kind:
    | "PureCallback"
    | "EffectCallback"
    | "Predicate"
    | "Reducer"
    | "Finalizer"
    | "AcquireUse"
    | "UnionCase"
    | "ForeignCallback"
  parameterShape: readonly ParameterRole[]
  capturePolicy: CapturePolicy
}
```

The source frontend recognizes the callee, finds its callback argument, and asks the corresponding boundary specification how the callback must be represented.

This keeps source migration tied to compiler semantics rather than a second handwritten model of Effect/Foldkit.

### CapturePlan

The migration frontend should construct an explicit analysis value before rewriting source:

```ts
interface CapturePlan {
  boundary: BoundarySpec
  callbackRange: SourceRange
  parameters: readonly BinderPlan[]
  captures: readonly Capture[]
}

type Capture =
  | ConstantCapture
  | SymbolicCapture
  | NativeValueCapture
  | ServiceCapture
  | ResourceCapture
  | MutableCapture
  | FunctionCapture
  | UnsupportedCapture
```

Every capture should retain:

```text
binding identity
authored name
declaration/use locations
source scope
mutability
known type / IR witness when available
representation status
ownership/lifetime constraints
classification rationale
```

Use binding identity internally. Human diagnostics can display names. Names alone are insufficient because shadowing is real.

### Capture classifications

#### ConstantCapture

Examples:

```ts
const prefix = "data-"
const limit = 100
```

If the initializer is safe to evaluate or already represented as an R literal, inline it into the generated builder graph.

Qwik's const-capture inlining is strong prior art here.

#### SymbolicCapture

A value is already an `Expr`, binder, or other reffect symbolic value.

Reuse it directly in the generated callback body.

This is the common case for nested builder callbacks and should require no runtime environment.

#### NativeValueCapture

An immutable value has a known native representation but is not a compile-time literal.

Make the dependency explicit in the IR/function inputs. Let the normal ownership pass decide borrow/move/copy behavior.

Do not invent closure-specific ownership rules.

#### ServiceCapture

A capture resolves to an admitted Context/Layer service.

Prefer making the service dependency explicit and compiling Context lookup/wiring away, consistent with current reffect design.

#### ResourceCapture

A value carries scoped ownership/lifetime.

The capture plan must consult existing Scope/resource rules. A closure that outlives the resource is a refusal, not a hidden clone.

Current delayed-cleanup restrictions on non-Copy captures are examples of exactly the kind of constraint the frontend must surface.

#### MutableCapture

Example:

```ts
let found = false
xs.forEach((x) => {
  if (predicate(x)) found = true
})
```

This is not ordinary immutable capture conversion.

Possible outcomes, depending on the pattern:

- mechanically rewrite into `reduce` / structured state,
- map to an admitted `Ref`/state primitive later,
- prove mutation remains purely local inside one generated loop,
- refuse.

Never silently snapshot the variable as Qwik-style serialized capture; that changes semantics.

#### FunctionCapture

A referenced helper function requires separate treatment.

Order of preference:

1. inline if small and semantically safe,
2. lower through existing `R.flow`/builder substitution,
3. use the future named IR call node when justified,
4. register it as a known semantic foreign operation,
5. refuse arbitrary first-class function capture.

This preserves the existing decision that general first-class function values are out of scope.

#### UnsupportedCapture

Opaque JS objects, unsupported class instances, dynamic proxies, functions with unknown semantics, or values whose lifetime/representation cannot be proven should remain explicit diagnostics.

---

## Proposed migration pipeline

The Qwik architecture suggests a clean reffect pipeline:

```text
1. Parse modules
      ↓
2. Build import graph + native target reachability
      ↓
3. Build lexical scope / binding graph
      ↓
4. Discover known semantic boundaries
      ↓
5. Compute callback free identifiers
      ↓
6. Resolve captures to bindings
      ↓
7. Build CapturePlan for every boundary
      ↓
8. Classify callback body + captures
      ↓
9. Produce compatibility diagnostics
      ↓
10. Rewrite only mechanically proven cases into R builders
      ↓
11. Compile/check rewritten program
      ↓
12. Differential semantic tests + native build
```

The first seven steps should work in **analysis-only mode** with no source edits.

That analysis is useful even before the codemod can transform a given callback.

---

## Oxc versus Qwik as a dependency

### Recommended: use Oxc directly, learn from Qwik

Qwik v2 currently has two optimizer implementations:

- a Rust/SWC optimizer,
- a TypeScript optimizer using Oxc parsing/walking and scope tracking.

The TypeScript implementation is especially relevant because reffect's existing Foldkit SSR inventory already uses Vite's Oxc parser.

The shortest migration path is therefore:

```text
reffect migration frontend
   ↓
Oxc AST + scope/binding analysis
   ↓
reffect-specific BoundarySpec / CapturePlan
   ↓
MagicString or equivalent AST-located edits
```

Do **not** make Qwik optimizer output or QRL semantics a dependency of reffect.

Qwik's extraction triggers, QRL encoding, serializer, JSX rewrite, segment bundling, and resumability runtime are unrelated to reffect's native semantic target.

### Initial TypeScript implementation versus Rust

Start in TypeScript.

Reasons:

- migration output is TypeScript,
- the current corpus analyzer is already TypeScript/Oxc-based,
- iteration and diagnostics will be easier,
- Qwik provides a production example of this architecture in TypeScript,
- reffect's compiler already supplies semantic verification after the rewrite.

A later Rust frontend can use Oxc's Rust parser/semantic crates if analysis scale or integration justifies it. Oxc's semantic layer explicitly provides scope chains and symbol tables.

Do not build both implementations now merely because Qwik has both.

---

## Scope-analysis rules to adopt immediately

Qwik's code and regressions imply several rules that should be non-negotiable.

### Resolve bindings, not names

```ts
const value = outer

{
  const value = inner
  operation(() => value)
}
```

The capture is the inner binding. A string set containing `"value"` is insufficient as the long-term representation.

### Computed property positions are references

```ts
record[key]
({ [key]: value })
```

`key` is a capture when it resolves outside the callback.

Qwik has a dedicated regression for this.

### Block and loop bindings matter

```ts
for (const item of items) {
  const name = item.name
  operation(() => name)
}
```

Both `item` and `name` can participate in capture analysis depending on the callback.

The current Foldkit SSR corpus contains many loops, so this is not theoretical.

### Declarations after the callback still exist in the lexical environment where JavaScript semantics permit them

Qwik defers some capture resolution until after the module walk so its enclosing scope information is complete.

reffect should likewise build a complete binding/scope model before final capture classification rather than rely only on declarations seen so far.

### Nested boundaries require ownership of captures

If a variable is referenced only by a nested transformed callback, the parent should not necessarily retain it as its own runtime capture.

The IR graph should express the actual dependency at the smallest semantic boundary that consumes it.

### Generated identifiers need deterministic hygiene

A transformed callback may introduce binders such as accumulator, item, context, raw input, or resource handles.

Generate collision-safe names deterministically, but keep semantic binder IDs separate from emitted source names.

Source rewriting should never depend on hoping the TypeScript compiler repairs collisions later.

---

## Closure taxonomy for Foldkit SSR

The current inventory reports 1,184 closures across the module-level over-approximation. Before using that number for planning, classify them.

### A. Non-native / unreachable closures

Client-only code or functions outside the function-level SSR graph.

Action: ignore.

### B. Ordinary local helper / immediately invoked closures

Example:

```ts
const result = (() => {
  if (condition) return a
  return b
})()
```

Action: leave alone until the containing function itself is transformed, then inline or structurally lower as needed.

No standalone closure environment is required.

### C. Callback to a known pure combinator

Examples:

```ts
items.map(...)
items.filter(...)
Array.findFirst(...)
Option.match(...)
```

Action: map the consumer to a structured R operation and convert the callback to symbolic binders.

This is likely a large class in Foldkit.

### D. Callback to a known effectful/resource combinator

Examples:

```ts
Effect.map(...)
Effect.flatMap(...)
Effect.forEach(...)
Effect.acquireRelease(...)
Effect.addFinalizer(...)
```

Action: build computation IR with explicit capture plan and existing effect/lifetime rules.

### E. Callback to a registered foreign semantic operation

Example future shape:

```ts
parse5-related helper
URL-related helper
regex operation
```

Action: transform only when the foreign-operation registry defines callback semantics and a verified native implementation.

### F. Escaping or arbitrary higher-order function value

Examples:

```ts
return callback
object.handler = callback
unknownLibrary(callback)
```

Action: initially refuse if reachable by the native target.

Do not implement general first-class closures merely to raise a migration percentage.

---

## Example transformation

Input:

```ts
const prefix = "data-"

const names = items
  .filter((item) => item.enabled)
  .map((item) => prefix + item.name)
```

Analysis:

```text
filter boundary
  params: item
  captures: none

map boundary
  params: item
  captures:
    prefix → ConstantCapture("data-")
```

Possible R-shaped output:

```ts
const prefix = R.String.literal("data-")

const names = R.Array.map(
  R.Array.filter(items, (item) =>
    R.Struct.get(item, "enabled")
  ),
  (item) =>
    R.String.concat(
      prefix,
      R.Struct.get(item, "name")
    )
)
```

The exact API is illustrative; use existing or subsequently admitted Effect-v4-aligned R APIs rather than introducing names solely for this example.

Native lowering should contain loops and ordinary values, not a serialized capture environment.

---

## Mutation is the line Qwik cannot solve for us

Qwik's serialization model can capture an object reference whose fields are mutable, but it deliberately rejects or complicates mutation of captured lexical `let` bindings. Its v2 upgrade notes document module-level mutable bindings that fail after aggressive extraction.

reffect's problem is stricter because native lowering must preserve JavaScript mutation and aliasing behavior.

Therefore closure capture analysis and mutation analysis should be separate passes:

```text
CapturePlan
    +
write/escape analysis
    ↓
Immutable capture
Local reducible mutation
Admitted mutable state primitive
Unsupported aliasing
```

For milestone 8B, prefer structural rewrites of local accumulator patterns over introducing a general JS heap model.

---

## Relationship to the existing reffect compiler

This frontend should not create a parallel compiler.

### Reuse existing IR and ownership

The output must be ordinary R builders accepted by the same:

```text
check
→ derive
→ normalize
→ plan
→ verify
→ optimize
→ ownership
→ lower
→ emit
→ build
```

Capture classification provides better source diagnostics, but Rust ownership remains the compiler's authority.

### Reuse source provenance

Every transformed callback, binder, capture, and generated R operation should preserve:

- source file,
- authored range,
- transformation ancestry,
- use/definition relationship.

The existing source-map/provenance design is therefore directly relevant.

### Keep migration separate from syntax widening

This work belongs to milestone 8B / migration tooling.

The compiler continues to accept explicit R IR. The codemod is a producer of that IR-shaped TypeScript.

A future direct-TypeScript compiler frontend could reuse `BoundarySpec`, `CapturePlan`, and the scope analyzer, but that does not need to be implemented now.

---

## Recommended first implementation experiment

Extend the existing Foldkit SSR inventory with **function-level reachability and closure classification**.

For each server-reachable closure, report:

```text
source location
enclosing reachable function
consumer/callee
known semantic boundary? yes/no
callback parameter count
free binding count
capture classes
writes to captures?
escapes as a value?
nested transformed boundaries?
mechanically transformable today?
blocking capability
```

Aggregate:

```text
total closures in module-level graph
total closures in function-level SSR graph
known-boundary callbacks
zero-capture callbacks
constant-only captures
R/IR-representable captures
resource/service captures
mutable captures
function captures
unknown consumers
escaping callbacks
```

This is the measurement that should replace the raw `1,184 closures` number in schedule estimates.

### Hypothesis

A substantial fraction of Foldkit SSR closures will fall into:

- unreachable/client-only,
- local helpers,
- callbacks to arrays/Effect/Option/pure collection operations,
- zero-capture or immutable-capture callbacks.

If that is true, closure conversion is not the dominant 8B risk.

The likely remaining hard cases are ordinary TypeScript mutation/aliasing, broad string/regex/Map/Set behavior, and external semantic ports such as HTML parsing.

---

## Suggested implementation slices

### QC-0 — Analyzer foundation

- Pin the Oxc parser/walker version used by migration tooling.
- Build binding IDs and lexical scopes.
- Compute free bindings for arbitrary callbacks.
- No rewriting.
- Differential tests from Qwik's capture categories.

Acceptance:

- shadowing, destructuring, computed keys, blocks, loops, `var`, catch bindings, nested functions, and later declarations resolve correctly,
- stable deterministic capture order,
- source ranges are retained.

### QC-1 — Boundary registry

- Describe known callback positions for already-supported R/Effect operations.
- Discover only registered boundaries.
- Generate `CapturePlan` values and structured diagnostics.

Acceptance:

- unknown higher-order consumers remain explicit,
- ordinary non-boundary closures are not spuriously treated as migration blockers.

### QC-2 — Pure callbacks

Start with operations already admitted by reffect:

- Array map/filter/reduce,
- tagged-union Match,
- simple predicates/string operations.

Rewrite mechanically eligible callbacks to R builders.

Acceptance:

- original Effect/JS reference and rewritten reference/native output agree,
- repeat-running the codemod is stable,
- no runtime closure representation is generated.

### QC-3 — Effect callbacks

Add:

- map/flatMap/recovery,
- forEach,
- resource/finalizer callbacks where existing capture/lifetime rules admit them.

Acceptance:

- success/failure/cancellation/finalization traces agree,
- invalid resource escapes are refused at the authored capture.

### QC-4 — Foldkit SSR corpus reporting

Run the analyzer against the pinned SSR graph and commit the classification report.

Use its blockers to choose the next representation/semantic-operation work.

### QC-5 — Helper lifting / named calls

Only when corpus evidence shows code-size duplication, recursion, or shared helper functions blocking migration, implement the previously deferred named IR call design.

Do not add first-class function values unless a real native workload requires them.

---

## Tests worth borrowing from Qwik

Do not copy Qwik's entire optimizer test suite. Re-express the failure classes against reffect's frontend.

Minimum capture corpus:

```text
simple enclosing const
multiple captures with deterministic order
global reference is not capture
import reference is not local capture
shadowed import name is local capture
function parameter is not capture
destructured parameter bindings
var binding
block const
for / for-of binding
loop-body const
computed member key
computed object key
nested function shadowing
nested transformation boundary
catch binding
later declaration / complete lexical scope
generated-name collision
module-level mutable let
capture read + capture write
escaping closure
resource capture crossing finalizer/suspension
```

Qwik's two-implementation convergence discipline also suggests a useful principle: whenever possible, keep an independent simple analyzer or fixture oracle for the hardest scope cases so refactors of the optimized gather pass do not silently redefine correctness.

---

## Direct reuse decision

Do **not** depend on `@qwik.dev/optimizer` or copy its extraction pipeline wholesale.

Reasons:

- QRL boundaries are not reffect semantic boundaries,
- serialization/resumability is the wrong target model,
- Qwik performs JSX/segment/bundle transformations reffect does not need,
- its runtime capture format would add machinery reffect is specifically trying to erase,
- coupling migration correctness to Qwik's private optimizer architecture would make reffect harder to evolve.

Potentially reusable/adaptable pieces under MIT:

- test cases for lexical capture edge conditions,
- the shape of Oxc-based free-identifier and lexical-scope analysis,
- deterministic generated-name/hygiene techniques,
- post-walk resolution patterns,
- nested-boundary exclusion logic.

If source code is copied substantially rather than independently reimplemented, retain Qwik's MIT notice and document provenance.

---

## Decision summary

**QC-D1 — Adopt Qwik's boundary-first model.**  
Analyze callbacks only where a known semantic consumer makes transformation meaningful.

**QC-D2 — Use compiler-grade lexical binding analysis.**  
No text/name heuristic is acceptable for capture discovery.

**QC-D3 — Make captures explicit before rewriting.**  
A typed `CapturePlan` is the handoff between source analysis and semantic transformation.

**QC-D4 — Erase closures where possible.**  
Unlike Qwik, reffect should normally lower callbacks to structured IR/native loops rather than transport a generic closure environment.

**QC-D5 — Classify mutation separately.**  
Free-variable capture is not enough to prove semantic portability.

**QC-D6 — Start with Oxc/TypeScript tooling.**  
Reuse the current migration/inventory toolchain; consider a Rust/Oxc frontend later only if justified.

**QC-D7 — Corpus evidence controls expansion.**  
The next migration features should be chosen from a function-level Foldkit SSR closure report, not from generic JavaScript completeness.

**QC-D8 — Qwik is prior art, not a dependency.**  
Study and selectively adapt its algorithms/tests; keep reffect's semantic registry and IR authoritative.

---

## Impact on the north-star estimate

The current module-level inventory's 1,184 closures should no longer be interpreted as 1,184 independent compiler features.

A Qwik-style scope analyzer plus reffect boundary registry can reduce the question to:

```text
How many server-reachable callbacks cross known semantic boundaries,
and what kinds of values do they capture?
```

That number is not yet measured.

Until QC-0/QC-4 exist, closure count should be treated as an upper-bound complexity signal, not as evidence that milestone 8B requires general closure compilation.

The next useful schedule update should be based on the function-level closure classification report.
