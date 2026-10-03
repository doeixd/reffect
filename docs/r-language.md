# R language direction: the tiny semantic language

Status: **current design direction (2026-10-03)**.

This document replaces the broader control-flow proposal previously recorded here. The direction is deliberately smaller.

R is not trying to become Rust syntax in TypeScript, a conventional imperative language, or an arbitrary TypeScript-to-Rust frontend. R is a **tiny typed semantic language constructed from TypeScript**.

The central idea is the same one that appeared in the project's original architecture:

> **TypeScript is the authoring and metaprogramming language. R is the small runtime-semantic language being constructed.**

That means many things that would normally become language syntax do not belong in R at all. They can live as build-time TypeScript abstractions over a very small semantic core.

## Summary

The public semantic language should stay close to:

```text
values
types
operations
Match
functions
Effects
```

Functions are ordinary callable TypeScript values produced by `R.fn` / `R.Effect.fn`. Calling one with symbolic R values creates an internal statically-resolved call edge.

There is no public semantic:

```text
If
Let
Loop
While
For
Break
Continue
Return
Recur
.call()
recursive()
self parameter
```

Instead:

- **branching** is exhaustive `Match`;
- **pure naming/sharing while constructing IR** uses ordinary TypeScript `const`;
- **effect-result binding** uses Effect composition;
- **function invocation** uses ordinary TypeScript call syntax;
- **recursion** is discovered from function-reference identity in the call graph;
- **tail recursion** is discovered by compiler analysis and lowered to loops/state machines;
- **loop/use/while/for/fold/guard/do-style ergonomics** are future user-land/build-time abstractions unless they prove to require new runtime semantics.

This is not a restriction on generated Rust. The compiler may lower R into locals, branches, loops, jumps, state machines, mutation, borrowing and returns. Those are backend mechanisms, not R language constructs.

---

## 1. R returns to its original idea

The original architecture already established three unusually strong ideas:

1. **TypeScript outside the DSL is unrestricted.**
2. **The callback passed to an R function is effectively a macro that constructs symbolic IR.**
3. **Control flow is deliberately tiny, with Match as the branching construct.**

That was the right instinct.

The project temporarily accumulated pressure toward a more conventional target language because milestone 8B must ingest ordinary TypeScript and because direct R authoring is becoming realistic. The conclusion is not that R needs to mirror those source-language constructs.

The better conclusion is:

> **The source frontend and user-land libraries may be rich; the semantic language should remain small.**

The project is therefore not reversing direction so much as returning to the original abstraction after learning enough about the hard cases to trust it.

What is new compared with the earliest design:

- real native workloads now validate the semantic/compiler split;
- named function calls are needed as internal IR;
- function identity can be carried by ordinary TypeScript references;
- recursion can be discovered from the resulting call graph;
- semantic tail-position analysis can guarantee bounded-stack recursion;
- the value/type system can grow substantially without growing the control-flow language;
- the milestone-8B codemod can target the same tiny R core rather than forcing R to resemble TypeScript.

---

## 2. Two languages are involved

The clean mental model is:

```text
TypeScript
──────────
modules
const bindings
higher-order helpers
configuration
metaprogramming
macro-like libraries
code generation
source migration

        executes builders

R
─
typed values
semantic operations
Match
functions / internal calls
Effect computations
services / resources
```

TypeScript is not merely syntax around R. It is R's **host and macro language**.

This distinction should be preserved deliberately.

### Build-time TypeScript may be rich

For example:

```ts
const fields = config.map(makeField)
const handlers = routes.map(makeHandler)

const escaped = R.String.replaceAll(value, "<", "&lt;")
```

The array maps over `config` and `routes` can run at build time. They do not become native runtime loops unless they construct R operations that say so.

Likewise:

```ts
const doubled = R.U64.mul(x, R.U64.literal(2n))

R.U64.add(doubled, doubled)
```

does not require an R `Let` node. The TypeScript variable names one IR value while building the graph.

The compiler later decides whether the shared graph node should become a Rust local, be recomputed, be inlined, or otherwise scheduled.

---

## 3. Match is the control-flow primitive

R should not have a separate semantic `If`.

Boolean branching is matching on a two-case value.

Likewise Option, Result, literals and tagged unions are all elimination of sum-like values.

Conceptually:

```ts
R.Match.bool(condition, {
  true: () => yes,
  false: () => no,
})
```

or an eventual unified API such as:

```ts
R.Match(value, {
  Some: ({ value }) => ...,
  None: () => ...,
})
```

The exact user API can evolve, but the semantic idea should remain one concept:

> **Inspect a typed value and exhaustively select a result.**

A sufficiently capable Match should support the cases actually needed by the language and codemod:

```text
Bool
Option
Result
TaggedUnion
literal unions
other finite discriminants
```

Potential future pattern conveniences such as destructuring or guards should first be considered user-land/source sugar. Only add core semantics when the compiler genuinely needs a new fact that cannot be represented by existing Match + operations.

### Why Match matters so much

If Match is the only branch primitive:

- exhaustiveness is natural;
- branching semantics stay explicit;
- source migration has one target for `if`, `switch`, ternaries and discriminated unions;
- Rust lowering maps naturally to `match` or `if`;
- tail-position analysis needs to reason about fewer forms;
- optimization becomes easier;
- the language keeps a coherent identity.

---

## 4. Functions are callable values at build time, not runtime function values

An R function should look like a function in TypeScript:

```ts
const double = R.fn(
  [R.U64],
  R.U64,
  x => R.U64.mul(x, R.U64.literal(2n)),
)

const quadruple = R.fn(
  [R.U64],
  R.U64,
  x => double(double(x)),
)
```

There should be no public:

```ts
double.call(x)
```

Calling `double(x)` executes the TypeScript builder wrapper and produces an internal call expression referencing `double`'s semantic function identity.

Conceptually:

```text
surface:
    double(x)

IR:
    Call(FunctionRef(double), [x])
```

The public function is callable because that is the natural TypeScript authoring shape. It is **not** a runtime first-class function value in the compiled program.

### Internal function identity

Each function returned by `R.fn` / `R.Effect.fn` should have stable hidden semantic identity, for example through an internal symbol or registry.

Conceptually:

```text
TypeScript function object
        │
        └── FunctionRef
```

The compiler reasons over `FunctionRef`, not source names.

This means:

- renaming a TypeScript variable does not change recursion semantics;
- shadowing is not confused with function identity;
- shared helpers produce real call edges;
- recursion is graph structure, not syntax.

### Runtime first-class functions remain out of scope

This is allowed because TypeScript resolves it at build time:

```ts
const helper = BUILD_FLAG ? foo : bar
```

provided `BUILD_FLAG` is actually build-time host logic and only the chosen function reaches the constructed IR.

A runtime R value selecting between `foo` and `bar` is different:

```text
runtime function value
dynamic dispatch
closure representation
```

That remains outside the language unless a future design explicitly adds it.

---

## 5. Recursion needs no special syntax

There should be no:

```text
R.fn.recursive
self parameter
Recur node
recursive annotation
```

Ordinary TypeScript references are enough.

Example:

```ts
const factorial = R.fn(
  [R.U64],
  R.U64,
  n =>
    R.Match.bool(R.U64.eq(n, R.U64.literal(0n)), {
      true: () => R.U64.literal(1n),
      false: () =>
        R.U64.mul(
          n,
          factorial(R.U64.sub(n, R.U64.literal(1n))),
        ),
    }),
)
```

The semantic body contains a `Call` to the same `FunctionRef`.

The compiler derives:

```text
factorial ──▶ factorial
```

and therefore knows the function is recursive.

### Lazy body materialization

The implementation should not eagerly execute the body builder before the `const factorial = ...` binding has been initialized.

A suitable shape is:

```text
R.fn(...)
  ↓
create callable wrapper + FunctionRef immediately
  ↓
retain body builder unevaluated
  ↓
return wrapper

R.program / Compile.check
  ↓
materialize reachable bodies with symbolic parameters
  ↓
ordinary references such as factorial(...) create Call edges
```

This also supports mutual recursion naturally:

```ts
const even = R.fn(..., n =>
  R.Match.bool(isZero(n), {
    true: () => R.Bool.literal(true),
    false: () => odd(dec(n)),
  }),
)

const odd = R.fn(..., n =>
  R.Match.bool(isZero(n), {
    true: () => R.Bool.literal(false),
    false: () => even(dec(n)),
  }),
)
```

The compiler sees the SCC:

```text
even ──▶ odd
 ▲       │
 └───────┘
```

No recursion-specific authoring construct is necessary.

---

## 6. Tail calls are derived compiler facts

The IR needs ordinary statically resolved `Call` nodes.

It does not need a distinct authored `TailCall` or `Recur` node.

The compiler derives:

```text
Call
  +
callee belongs to same recursive SCC
  +
semantic tail position
  =
recursive tail edge
```

### Proper-tail guarantee

R should guarantee:

> **If every recursive edge in an SCC is semantically tail-position and tail-safe, the generated native program executes that recursive cycle with bounded native stack.**

Do not rely on LLVM or Rust to happen to optimize normal recursive calls.

### Self recursion

A self-tail-recursive function lowers to a Rust loop by rebinding its parameters/state.

### Mutual recursion

A mutually tail-recursive SCC lowers to a generated state machine inside a loop.

Conceptually:

```text
functions { even, odd }
        ↓
recursive SCC
        ↓
all cyclic edges tail-safe
        ↓
state enum + loop + match
```

### Non-tail recursion

Initially, a recursive SCC containing a non-tail recursive edge should be refused explicitly.

General native stack recursion can be considered later if a real workload justifies its stack, resource and diagnostic semantics.

---

## 7. Tail position is semantic

Tail-call detection cannot be a source-text or AST trick.

A call is tail-position only if the function's result is exactly the call's result and no observable continuation remains.

Tail:

```text
Match value
  A → Call f(...)
  B → Call g(...)
```

Not tail:

```text
Add(Call f(...), 1)
```

Potentially not tail even when syntactically last:

```text
Ensuring(
  Call f(...),
  cleanup
)
```

because cleanup remains observable.

Tail safety must account for:

- result transformation;
- typed recovery;
- finalizers and Scope;
- resource/layer lifetime;
- cancellation semantics;
- logical frame semantics;
- ownership/drop obligations.

This is exactly why tail recursion belongs in compiler analysis rather than in user syntax.

---

## 8. There is no semantic Let

For pure values, ordinary TypeScript bindings are the authoring abstraction:

```ts
const normalized = normalize(x)
const encoded = encode(normalized)

R.Struct.make({ normalized, encoded })
```

The bindings exist while constructing the graph.

The IR should preserve node identity/sharing; lowering decides whether that becomes a native local.

This separation is valuable:

```text
TypeScript const
    = author names an IR value

Rust let
    = backend schedules/evaluates a value
```

They are not the same semantic concept.

### Effects are different

An Effect value describes a computation. Naming the same computation in TypeScript does not imply memoized execution.

Runtime binding of an effect result already has explicit semantics through Effect composition:

```ts
fetchUser(id).pipe(
  R.Effect.flatMap(user =>
    ...
  ),
)
```

The `flatMap` binder is the runtime result binding.

Therefore R does not need a general Let merely to support runtime sequencing.

---

## 9. There is no semantic Loop

Once R has named calls, Match and proper-tail analysis, iteration is derivable from recursion.

A looping helper can be defined in user land as a TypeScript abstraction that constructs a tail-recursive R function.

Conceptually:

```text
user-land loop helper
        ↓
R function + Match + recursive Call
        ↓
compiler detects tail-recursive SCC
        ↓
native loop/state machine
```

The public language does not need to expose the lowering mechanism.

The same applies to:

```text
while
for
repeatUntil
unfold
stateMachine
iterator helpers
```

They can be build-time libraries over functions, Match, operations and effects.

This is Lisp-like in the important sense: powerful control abstractions can be libraries because the underlying representation is expressive enough.

---

## 10. User-land is the default home for syntax-like abstractions

Adopt a strong language-design rule:

> **Do not add a core R construct when the behavior can be expressed completely and transparently as build-time TypeScript over existing R semantics.**

Likely user-land responsibilities:

```text
if-like convenience
loop
while
for
fold
unfold
use
guard
when / unless
do-style sequencing
pipeline helpers
visitor helpers
state-machine builders
parser combinators
algorithm libraries
```

These helpers may be shipped by reffect itself as libraries. “User-land” means they are ordinary build-time abstractions, not new semantic IR forms.

### Why this is effectively a macro system

A TypeScript helper can:

1. accept R values/functions;
2. construct more R functions, Match nodes and operations;
3. return the resulting symbolic value/computation;
4. disappear completely before native execution.

The generated program pays for the semantics it constructs, not for the abstraction used to construct them.

That is the desired zero-cost macro property.

---

## 11. Match quality determines language power

A tiny core only works if Match is excellent.

Invest in Match rather than multiplying control constructs.

Desired properties:

- exhaustive typing;
- good inference;
- tagged-union cases;
- Bool;
- Option;
- Result;
- literal unions;
- ergonomic handler binders;
- pure/effectful result compatibility where semantically valid;
- excellent diagnostics;
- source provenance for each branch.

Potential conveniences such as nested destructuring, alternatives or guards should first be investigated as build-time expansion into simpler Match/predicate structure.

The question should always be:

> Does the compiler need a new semantic construct, or can the host language construct existing R semantics for us?

---

## 12. The tiny core and the larger libraries

A useful conceptual boundary is:

```text
R semantic core
───────────────
typed values
construct/project
semantic operations
Match
Function definitions
internal statically-resolved Call
Effect semantics

R / Effect libraries
────────────────────
Array.map/filter/reduce
Option / Result combinators
retry / repeat / Schedule
Services / Layers
Remote / RPC
user-land loop/use/guard/etc.
domain libraries
```

Some library operations still deserve dedicated IR because they carry important semantics or enable better specialization. Being “library-level” does not imply they must be expanded into the absolute primitive kernel.

The important rule is that they do not require statement-language syntax.

---

## 13. Native types remain orthogonal

Keeping control flow tiny does not require keeping the type system tiny.

R can still deliberately add native value types useful for direct authoring, SQLx and FFI:

```text
I8 / I16 / I32 / I64 / I128
U8 / U16 / U32 / U64 / U128
F32 / Number(F64 semantics)
Tuple
FixedArray
Bytes
native Option / Result where semantically distinct
Newtype
explicit map/set families
opaque native extension types
```

The principles from [native-type research](research/native-types.md) remain:

- semantic type and native representation are separate;
- arithmetic overflow/rounding is explicit;
- ordering guarantees are explicit;
- wire/storage codecs are separate contracts;
- native extensions state crates/features/traits and conformance obligations.

A rich value universe does not require a rich statement language.

---

## 14. Opaque native extensions remain explicit

Direct R authors should eventually be able to declare a semantic value backed by a Rust-library type, such as:

```text
Uuid
DateTime
Decimal
SocketAddr
PathBuf
database-native identifiers
application domain types
```

This needs a structured extension contract covering:

- semantic identity;
- native representation;
- target/crate requirements;
- traits/evidence;
- operations;
- boundary codecs;
- storage mappings;
- conformance/reference behavior.

It should not become arbitrary embedded Rust strings or a generic JavaScript-value escape hatch.

---

## 15. Ownership remains compiler-owned

R source should describe semantics, not Rust lifetime mechanics.

Do not make normal authors choose:

```text
&T
&mut T
Arc<T>
clone
move
Rc<T>
```

The ownership/lifetime pass derives those choices from:

- value representation;
- sharing;
- call graph;
- effects;
- scopes/resources;
- target implementation.

This remains one of the main reasons for having R rather than merely generating Rust-shaped code from TypeScript.

---

## 16. Migration should target the tiny language, not reshape it

Milestone 8B must translate ordinary TypeScript containing:

```text
if
ternary
loops
const/let
closures
returns
helper calls
mutation
```

That does not imply one R construct per source construct.

The migration frontend is allowed to perform real analysis.

Examples:

```text
TS if / ternary
    → Match

TS const naming a pure symbolic value
    → host-language naming / graph sharing

TS helper call
    → callable R function / internal Call

TS recursive helper
    → same Call graph; compiler discovers recursion

TS loop
    → user-land recursion/state-threading expansion
    → tail calls
    → native loop after compiler analysis

TS callback
    → Qwik-style capture analysis
    → symbolic parameters / explicit dependencies
```

The source frontend can be sophisticated while R remains simple.

That is preferable to permanently growing R until it resembles every source language it might ingest.

---

## 17. Internal lowering IR may be imperative

None of this constrains the compiler's internal lower IR.

A later backend-oriented representation may contain:

```text
basic blocks
temporaries
SSA/phi-like values
branches
jumps
loops
returns
mutable locals
drops
borrows
state-machine discriminants
```

That layer exists to generate good Rust.

It is not R.

This separation lets the public semantic language remain elegant while the compiler uses conventional machinery internally.

---

## 18. Direct R authoring

A recursive R function should look ordinary:

```ts
const gcd = R.fn(
  [R.U64, R.U64],
  R.U64,
  (a, b) =>
    R.Match.bool(R.U64.eq(b, R.U64.literal(0n)), {
      true: () => a,
      false: () => gcd(b, R.U64.rem(a, b)),
    }),
)
```

No:

```text
.recursive
.call
self
return
loop
continue
```

The compiler discovers:

```text
gcd ──▶ gcd
       recursive SCC
       recursive edge is tail
       ↓
native loop
```

That is the desired character of the language: authors state the computation; the compiler discovers structure worth specializing.

---

## 19. Implementation direction

### RT-1 — callable FunctionRef

Change `R.fn` / `R.Effect.fn` so a function application builds a resolved internal `Call`.

Requirements:

- lazy reachable-body materialization;
- stable hidden function identity;
- arity/witness checking;
- pure and effectful call signatures;
- call-site and definition provenance;
- no public `.call()`.

### RT-2 — call graph

Derive:

- reachability;
- function dependencies;
- SCCs;
- cross-call effects/requirements/resources;
- call frames.

Acyclic calls lower normally.

### RT-3 — semantic tail analysis

For recursive SCCs, classify every cyclic call edge as:

```text
tail-safe
not tail position
tail position but resource/continuation unsafe
```

Diagnostics explain the reason.

### RT-4 — proper-tail lowering

- self-tail SCC → loop;
- mutually tail-recursive SCC → state machine + loop;
- non-tail recursive SCC → initially refuse.

Verify bounded stack with deep logical recursion.

### RT-5 — Match investment

Before adding branch/control syntax, improve Match ergonomics and coverage for the finite types needed by direct authoring and migration.

### RT-6 — user-land control library

Experiment with ordinary TypeScript helpers for:

```text
loop
while
for
use
guard
fold/unfold
state machines
```

No new IR nodes unless experiments reveal missing semantics.

### RT-7 — native type batch

Proceed independently with the richer native value universe described above and in [native types](research/native-types.md).

### RT-8 — migration integration

Teach the Qwik-inspired frontend to translate server-reachable TypeScript into the tiny core plus user-land expansions rather than introducing statement-level R constructs.

---

## 20. Design law: semantic minimalism

The core design rule is:

> **R grows when the compiler needs a new semantic fact, not when an author wants new syntax.**

New syntax or ergonomics should first be attempted as host-language abstraction.

A candidate becomes core only if expansion cannot preserve an important fact needed for:

- semantics;
- type safety;
- resource lifetime;
- ownership;
- effects;
- optimization;
- diagnostics/provenance;
- target selection.

This should keep R small even as its ecosystem becomes powerful.

---

## 21. Non-goals

The current direction does not include:

- arbitrary TypeScript compilation as the semantic model;
- statement-level R control-flow syntax;
- semantic `If`;
- semantic `Let`;
- semantic `Loop`/`While`/`For`;
- `Break`/`Continue`/`Return`;
- recursion annotations;
- public `.call()`;
- runtime first-class function values;
- generic boxed closures;
- prototype/dynamic JavaScript object semantics;
- implicit coercion;
- embedded JS runtime values;
- author-written Rust borrow/lifetime syntax.

These can only be reconsidered if real workloads demonstrate missing semantics rather than merely missing convenience.

---

## 22. Decision summary

**RT-D1 — TypeScript is R's macro language.**  
Use ordinary TypeScript for naming, metaprogramming and syntax-like build-time abstraction.

**RT-D2 — Match is R's branch primitive.**  
Do not add semantic If/switch/ternary constructs.

**RT-D3 — functions are naturally callable.**  
`fn(x)` builds an internal statically resolved Call; there is no public `.call()`.

**RT-D4 — recursion is discovered, not declared.**  
Ordinary function-reference identity and the derived call graph reveal self and mutual recursion.

**RT-D5 — tail calls are compiler facts.**  
No authored TailCall/Recur node. SCC + semantic tail-position analysis determines proper-tail lowering.

**RT-D6 — proper tail recursion is guaranteed.**  
Tail-safe recursive SCCs execute with bounded native stack via generated loops/state machines.

**RT-D7 — there is no semantic Let.**  
Pure authoring bindings are TypeScript bindings; effect-result binding uses Effect semantics.

**RT-D8 — there is no semantic Loop.**  
Iteration belongs first in user-land abstractions over recursion + Match; generated Rust may still use loops.

**RT-D9 — ergonomics default to user land.**  
`use`, `loop`, `while`, `for`, guards and similar constructs are macro-like TypeScript libraries unless they require genuinely new semantics.

**RT-D10 — the type universe may still grow.**  
Native types and opaque extensions are orthogonal to control-flow minimalism.

**RT-D11 — backend control flow is not language control flow.**  
Lower IR may freely use locals, mutation, CFGs, loops and returns.

**RT-D12 — milestone 8B adapts to R, not vice versa.**  
The migration frontend performs analysis and expansion so the target language can stay small.
