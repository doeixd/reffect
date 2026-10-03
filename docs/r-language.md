# R language direction: a small typed native language

Status: **proposed direction (2026-10-03)**. This document consolidates the current direction for expanding the public `R` authoring surface beyond the minimal Effect/Foldkit-driven subset. It updates the earlier “wait for a workload” posture in [native types](research/native-types.md) and [named calls](research/function-calls.md): the combination of direct R authoring, milestone 8B migration, Remote, SQLx and generated Rust is now itself a concrete workload.

The goal is not to turn reffect into a TypeScript-to-Rust transpiler. The goal is to make `R` a **small statically typed semantic language** that can be authored directly, produced mechanically by codemods, interpreted through reference semantics where applicable, and compiled to efficient Rust.

## Summary

The recommended direction is:

- **Treat R as a language, not only an IR-builder API.** Effect/Foldkit remain important frontends and semantic oracles, but they should not define the entire expressive ceiling of R.
- **Keep semantic types separate from native representation types.** JS/Effect `Number` is not the same semantic type as an `i32`; a narrow Rust representation does not silently change arithmetic semantics.
- **Add named monomorphic calls now.** `FunctionRef` + `Call` are basic language structure for directly-authored R, shared helpers, recursion, code size and honest diagnostics.
- **Keep runtime first-class function values out of scope.** Closures remain compile-time/source-frontend constructs unless a future representation decision deliberately admits them.
- **Make proper tail recursion a language guarantee.** Detect semantic tail position in IR, lower self-tail recursion to loops and mutually tail-recursive SCCs to explicit state machines.
- **Add structured control flow.** `Block`, `Let`, `If`, `Loop`, `While`, `Break`, `Continue`, `Return` and `Call` give both humans and the milestone-8B codemod a natural target.
- **Add a deliberate batch of Rust-native value types.** Sized integers, `F32`, tuples, fixed arrays, bytes, explicit map/set families, newtypes and an opaque native-extension mechanism should become first-class.
- **Do not expose Rust borrow syntax as the semantic language.** The ownership pass remains responsible for borrow/move/copy/clone/share choices.
- **Use the richer language to make milestone 8B easier.** Ordinary TypeScript should lower into ordinary structured R instead of being squeezed into only `Match`, collection combinators and ad-hoc mutation encodings.

## 1. Why the direction changes now

The earlier design correctly kept R intentionally small while the compiler proved its semantic kernel. That risk profile has changed.

The project now has real native workloads and a broad enough verified substrate:

```text
scalars
strings / numbers
structs / tagged unions
arrays / records
optional / undefined
Unknown JSON
Ref
Option / Result
async / cancellation
Scope / resources
Layers
Schedule
RPC
Remote Read / Query / Mutate
compiled authorization
Clock / Random
```

At the same time, the north-star migration target requires translating ordinary server-side TypeScript into R.

Those two facts create a new concrete requirement:

> R should be pleasant and structurally complete enough that a person could reasonably write a native program in it, and a codemod can translate ordinary structured source into it without unnatural encodings.

That does **not** imply arbitrary JavaScript compatibility. It means R should deliberately cover the common structured-programming core while preserving its explicit semantic model.

## 2. Revised architecture

The conceptual architecture becomes:

```text
            TypeScript / Effect / Foldkit
                     │
              migration frontend
                     │
                     ▼
          ┌──────────────────────┐
          │      R language      │
          │                      │
          │ semantic types       │
          │ native value types   │
          │ ADTs                 │
          │ functions / calls    │
          │ structured control   │
          │ Effects / resources  │
          │ native extensions    │
          └──────────┬───────────┘
                     │
                semantic IR
                     │
      ┌──────────────┼───────────────┐
      ▼              ▼               ▼
Effect/reference   Rust backend   future targets
where applicable
```

Effect remains the semantic oracle for the Effect-shaped subset. Native-only R types and operations must instead carry their own explicit reference/conformance contract.

The compiler pipeline remains:

```text
check → derive → normalize → plan → verify → optimize
      → ownership → lower → emit → build
```

The language expansion should reuse this pipeline rather than introduce a second compiler.

---

## 3. Type model: semantic types versus native representation types

### 3.1 Semantic types

These express source-language/application semantics and should remain the primary targets for Effect/Foldkit migration.

Current examples include:

```text
Bool
Unit
Never
Number
String
U64
Struct
TaggedUnion
Array
Record
UndefinedOr
Unknown
Ref
```

More can be added when they have clear semantic meaning.

### 3.2 Native representation types

Direct R authors also need types whose semantics are intentionally narrower and map directly to efficient Rust representations.

Recommended additions:

| R type | Rust representation | Notes |
| --- | --- | --- |
| `I8/I16/I32/I64/I128` | matching signed integer | Explicit arithmetic semantics |
| `U8/U16/U32/U128` | matching unsigned integer | `U64` already exists; unify the family |
| `Isize/Usize` | native word integer | Native-profile only; avoid portable wire assumptions |
| `F32` | `f32` | Reference semantics should use `Math.fround` where JS parity is claimed |
| `Tuple(...)` | Rust tuple | Fixed heterogeneous product |
| `FixedArray<T, N>` | `[T; N]` | Distinct from dynamic `Array<T>` |
| `Bytes` | `Vec<u8>` or selected bytes representation | HTTP, files, SQL, codecs |
| `Option<T>` | `Option<T>` | Native semantic option; distinct from JS property presence |
| `Result<T, E>` | `Result<T,E>` | Pure/native result value; distinct from Effect failure channel |
| `Newtype<T>` | transparent newtype | Domain modeling and nominal identity |
| ordered/hash map families | selected Rust maps | Ordering must be explicit |
| ordered/hash set families | selected Rust sets | Ordering must be explicit |

Do not define a single vague `Map` or `Set` with implementation-dependent iteration.

Prefer explicit families such as:

```text
R.HashMap
R.OrderedMap
R.HashSet
R.OrderedSet
R.Record   // JS own-property semantics
```

`R.Record` should keep its existing JavaScript key-order contract rather than being conflated with a generic Rust map.

### 3.3 Arithmetic semantics are explicit

A narrow representation does not imply a default arithmetic behavior.

For example, two `I32` values can participate in several distinct operations:

```ts
R.I32.addChecked(a, b)
R.I32.addWrapping(a, b)
R.I32.addSaturating(a, b)
R.I32.toNumber(a)
```

Plain JavaScript `+` over int32-valued Numbers widens to JS Number semantics, so `R.I32.add` should not silently choose checked or wrapping arithmetic.

The same rule applies to subtraction, multiplication, conversion, division and shifts. Each operation owns its overflow/rounding behavior and law evidence.

---

## 4. Opaque native types and extension operations

R should have a first-class escape hatch for types owned by Rust libraries without pretending they are JavaScript values.

Conceptual API:

```ts
const DateTime = R.Native.type({
  name: "DateTime",
  rust: "chrono::DateTime<chrono::Utc>",
  schema: Schema.DateTimeUtc,
  traits: [
    R.Trait.Clone,
    R.Trait.Send,
    R.Trait.Sync,
  ],
  crates: {
    chrono: "0.4",
  },
})
```

And native operations:

```ts
const now = R.Native.operation({
  name: "chrono_now",
  output: DateTime,
  effects: [R.Effect.Clock],
  implementation: ...
})
```

The exact API should remain structured rather than accepting arbitrary Rust source strings as the primary extension model.

A native type definition should specify:

- semantic identity,
- native Rust type/path,
- construction/destruction/lifetime rules,
- Effect/Schema codec when a JS or wire boundary exists,
- traits such as Copy/Clone/Send/Sync/Eq/Hash,
- target requirements and Cargo crates/features,
- available operations,
- reference/conformance evidence,
- serialization/storage mappings where relevant.

This creates a clean separation:

```text
portable R value
   ├── reference semantics
   └── verified target implementations

native extension value
   ├── explicit Rust representation
   ├── explicit target requirement
   └── explicit boundary codec if it crosses JS/wire/storage
```

Likely early native extensions include:

```text
Uuid
DateTime
Decimal / BigDecimal
SocketAddr
PathBuf
Bytes-like buffers
database-native ids
application-specific opaque structs
```

A JS engine or generic boxed runtime value is not the desired native-extension model.

---

## 5. Named functions should become core language structure

The earlier [function-call record](research/function-calls.md) separated:

- **D1 — named monomorphic calls** resolved statically;
- **D2 — first-class function values** passed/stored/returned dynamically.

Keep that distinction, but revise the decision:

> D1 should move from “deferred until forced” to “planned language foundation.” D2 remains out of scope.

Direct R authoring needs ordinary reusable helpers:

```ts
const normalize = R.fn(...)
const validate = R.fn(...)
const save = R.Effect.fn(...)

const handler = R.Effect.fn(..., input =>
  save.call(
    validate.call(
      normalize.call(input)
    )
  )
)
```

Conceptually add:

```text
FunctionRef
Call {
  callee: FunctionRef
  args: Expr[]
}
```

Properties:

- monomorphic;
- resolved at compile time;
- arity/type checked;
- no dynamic function object;
- no `dyn Fn`;
- no arbitrary closure environment;
- call-site and callee provenance both retained.

`R.flow` can continue to inline/substitute when that is useful. It does not need to become a runtime call.

### 5.1 Call-graph analysis

Once calls exist, derive a call graph:

```text
Program
  ↓
FunctionRef graph
  ↓
SCC decomposition
```

Acyclic components lower to ordinary Rust functions in dependency order.

Recursive strongly connected components require an explicit recursion policy.

Effects, capabilities, resource requirements and failure types must propagate across calls during derive/plan.

---

## 6. Proper tail recursion as a language guarantee

Tail recursion should not merely be an optimizer hint.

Recommended semantic guarantee:

> A recursive call graph whose recursive edges are all in semantic tail position executes with bounded native stack.

Do not depend on LLVM or Rust to decide whether ordinary recursion is optimized.

Rust has experimental explicit tail-call work around `become`, and current Rust project work also explores `loop_match`, but stable Rust should not be assumed to guarantee tail-call elimination. reffect can generate portable bounded-stack control flow itself.

References:

- [Rust `become` keyword documentation](https://doc.rust-lang.org/stable/core/keyword.become.html)
- [Rust 2026 tail-call / loop-match goal](https://rust-lang.github.io/goals/2026/tail-call-loop-match.html)

### 6.1 Tail-position analysis is semantic, not syntactic

A call is tail-position only when no observable semantic continuation remains after it.

Simple tail positions:

```text
return f(x)

if cond:
  return f(x)
else:
  return g(x)

match value:
  A → return f(...)
  B → return g(...)
```

Non-tail:

```text
return f(x) + 1
```

Also potentially non-tail even if syntactically last:

```text
ensuring(
  f(x),
  cleanup
)
```

because cleanup remains observable.

Tail analysis therefore needs to understand:

- Effect continuations;
- recovery handlers;
- Scope/finalizer boundaries;
- Layer/resource lifetime;
- logging/span restoration where observable;
- ownership/destructors;
- result transformation.

It belongs after semantic normalization, not in a source-level AST pattern matcher.

### 6.2 Self-tail recursion lowers to a loop

Example source shape:

```ts
const gcd = R.fn.recursive(
  [R.U64, R.U64],
  R.U64,
  (self, a, b) =>
    R.If(
      R.U64.eq(b, R.U64.literal(0n)),
      a,
      self(b, R.U64.rem(a, b)),
    ),
)
```

Conceptual IR:

```text
gcd(a, b)
  If b == 0
    Return a
    TailCall gcd(b, a % b)
```

Rust lowering:

```rust
fn gcd(mut a: u64, mut b: u64) -> u64 {
    loop {
        if b == 0 {
            return a;
        }

        let next_a = b;
        let next_b = a % b;
        a = next_a;
        b = next_b;
    }
}
```

The backend should generate this explicitly.

### 6.3 Mutual tail recursion lowers to a state machine

For a recursive SCC such as:

```text
even → odd
odd  → even
```

where every recursive edge is tail-position, emit one state machine rather than mutually recursive Rust functions:

```rust
enum State {
    Even(u64),
    Odd(u64),
}

let mut state = State::Even(n);

loop {
    state = match state {
        State::Even(n) => {
            if n == 0 {
                return true;
            }
            State::Odd(n - 1)
        }
        State::Odd(n) => {
            if n == 0 {
                return false;
            }
            State::Even(n - 1)
        }
    };
}
```

This also makes mutual recursion portable across backends.

### 6.4 Non-tail recursion

Initially:

```text
recursive SCC
  ├── all recursive edges tail
  │      → loop/state-machine lowering
  └── any non-tail recursive edge
         → explicit refusal
```

General stack recursion can be admitted later with:

- explicit policy;
- stack/recursion diagnostics;
- resource semantics;
- conformance and performance evidence.

Do not quietly emit potentially unbounded Rust recursion merely because the source typechecks.

---

## 7. Resource and ownership interaction with tail calls

Tail-call elimination is not sound if the caller still owns semantic cleanup that must happen after the call.

A conservative condition is:

```text
TailSafe(call)
iff

no semantic continuation remains
AND
no caller-owned finalizer must run after callee completion
AND
no result transformation/recovery remains
AND
caller-owned values can be dropped/rebound at the transition point
```

Where legal, generated loop transitions can:

```text
drop/release iteration-owned temporaries
        ↓
move/borrow/copy next arguments according to ownership plan
        ↓
rebind loop state
        ↓
continue
```

This should reuse the existing ownership and Scope analysis rather than create recursion-specific lifetime logic.

The diagnostic should explain why a recursive edge failed tail safety:

```text
recursive call to walk is not tail-safe
  enclosing Scope owns finalizer registered at ...
  finalizer must run after the call returns
```

---

## 8. Structured control flow should be first-class IR

If R is directly authored and is the codemod target, it should not force ordinary structured programs into only `Match`, collection combinators and `Ref`.

Recommended semantic nodes:

```text
Block
Let
If
Loop
While
Break
Continue
Return
Call
```

These are structured constructs, not arbitrary JavaScript execution.

They provide a natural translation target for:

```text
if / else
for
while
local variables
early return
continue / break
helper calls
tail recursion
```

### 8.1 Authoring API

The exact builder syntax is open.

A lower-level API could be:

```ts
R.loop(initial, state =>
  R.If(
    done(state),
    R.break(result(state)),
    R.continue(next(state)),
  )
)
```

A higher-level builder API could later make this more pleasant.

The important part is the semantic IR, not the surface spelling.

### 8.2 Why this helps milestone 8B

Without structured control flow, a codemod translating Foldkit SSR must repeatedly encode ordinary TypeScript patterns through:

```text
Match
Array.reduce
Ref
nested combinators
```

That creates unnatural output and makes equivalence harder to reason about.

With structured R:

```text
TypeScript if      → R If
TypeScript loop    → R Loop/While
return             → R Return
named helper       → R Call
tail recursion     → R Call + compiler tail analysis
```

The migration frontend can remain mechanical while the core compiler remains semantic.

---

## 9. Ownership stays inferred

Do not make normal R authors write Rust lifetime syntax.

Avoid a public semantic model centered on:

```text
R.Ref<'a, T>
R.Mut<'a, T>
R.Slice<'a, T>
```

Instead authors describe values and operations:

```text
String
Array<T>
Struct
Native<T>
Bytes
Map
```

The ownership pass selects:

```text
copy
move
&T
&mut T
&str
&[T]
clone
Arc<T>
other verified representation
```

based on use, lifetime, target representation and effects.

Explicit lifetime-sensitive native FFI can be a later advanced feature.

This preserves one of reffect's major advantages over “Rust syntax embedded in TypeScript”: semantic intent is separate from backend ownership mechanics.

---

## 10. Direct R authoring

A mature direct-authoring experience could look conceptually like:

```ts
import { R } from "reffect"

const User = R.Struct({
  id: R.U64,
  name: R.String,
})

const find = R.Effect.fn(
  [R.U64],
  R.UndefinedOr(User),
  DbError,
  (id) => ...
)

const factorial = R.fn.recursive(
  [R.U64, R.U64],
  R.U64,
  (self, n, acc) =>
    R.If(
      R.U64.eq(n, R.U64.literal(0n)),
      acc,
      self(
        R.U64.sub(n, R.U64.literal(1n)),
        R.U64.mul(acc, n),
      ),
    ),
)

export default R.program({
  find,
  factorial,
})
```

Then:

```text
reffect build
```

produces a native executable/library according to the selected target profile.

Effect becomes one frontend/reference semantics provider rather than the total definition of R.

---

## 11. Relationship to the migration/codemod frontend

The Qwik-inspired frontend design remains complementary.

Source frontend:

```text
TypeScript closure/control flow
        ↓
scope + free-variable analysis
        ↓
CapturePlan / binding resolution
        ↓
structured R
```

The richer R target improves closure conversion:

- zero/immutable captures become explicit inputs;
- local callback structure becomes ordinary `Call`/`If`/`Loop`;
- reducible mutation can become local structured state;
- recursion becomes named calls;
- tail recursion can be guaranteed by the backend;
- opaque higher-order escaping callbacks can still be refused.

The codemod does not need to emulate the JavaScript runtime. It needs to translate the server-reachable structured subset into R.

---

## 12. Proposed implementation sequence

This language work should be incremental and tested through existing compiler passes.

### RL-1 — named calls

Add:

```text
FunctionRef
Call
```

Requirements:

- resolved monomorphic calls;
- argument/result witness checking;
- call graph;
- cross-call effects/requirements/resources;
- call-site + definition provenance;
- logical call frames;
- conservative ownership across boundaries;
- no recursion yet or recursive SCC refusal.

Acceptance:

- shared pure helper;
- shared effectful helper;
- helper called by several entry points without inlining;
- reference/native parity;
- generated-size comparison against substitution.

### RL-2 — recursion graph and tail analysis

Add:

- SCC detection;
- semantic tail-position analysis;
- detailed refusal reasons.

Acceptance:

- self tail recursion recognized;
- mutual tail recursion recognized;
- non-tail result use refused;
- cleanup/recovery boundary prevents false tail classification.

### RL-3 — self-tail lowering

Lower self-tail recursion to generated loops.

Acceptance:

- deep recursion (for example millions of logical iterations) uses bounded stack;
- reference/native result and observable effects agree;
- cancellation remains observable at admitted suspension points;
- logical frames remain bounded according to policy.

### RL-4 — mutual-tail lowering

Lower tail-recursive SCCs to one explicit state machine.

Acceptance:

- `even/odd` style mutual recursion;
- different parameter shapes across functions;
- typed failures/effects union correctly;
- no native stack growth.

### RL-5 — structured control flow

Add:

```text
Block / Let / If / Loop / While
Break / Continue / Return
```

Acceptance:

- ordinary imperative examples;
- early exits;
- nested loops;
- ownership and finalization behavior;
- source-provenance mapping.

### RL-6 — core native type batch

Implement deliberately:

```text
signed/unsigned integer families
F32
Tuple
FixedArray
Bytes
Option
Result
Newtype
```

Each operation has explicit arithmetic/conversion semantics and evidence.

### RL-7 — collection families

Add explicit:

```text
HashMap / OrderedMap
HashSet / OrderedSet
```

Keep `Record` separate.

Select representations based on semantic requirements and reachability.

### RL-8 — native extension mechanism

Add structured native types/operations with:

- crates/features;
- trait evidence;
- boundary codecs;
- reference/conformance requirements;
- target diagnostics.

### RL-9 — migration integration

Teach the milestone-8B frontend to prefer structured R nodes and named calls instead of synthetic combinator encodings.

Use the function-level Foldkit SSR inventory to prioritize missing constructs.

---

## 13. Sequencing relative to the roadmap

This language work should not block finishing the current Remote memory profile or SQLx.

Recommended practical sequence:

```text
finish milestone 4
      ↓
start milestone 5 / SQLx
      ↘
       RL-1 named calls
       RL-2/3 tail recursion
       native type batch
      ↘
migration analyzer / Foldkit SSR
```

Structured control flow and named calls are particularly valuable before serious milestone-8B transformation work.

The language additions should remain workload-verified even though they are now planned proactively: direct R examples, SQLx, Remote helpers and Foldkit SSR provide the validation corpus.

---

## 14. Non-goals

This direction does **not** imply:

- arbitrary TypeScript compilation;
- a complete JavaScript object model;
- runtime `eval`;
- prototype semantics;
- dynamic property dispatch;
- implicit coercion;
- first-class arbitrary closures;
- generic boxed `dyn Fn`;
- automatic embedding of a JS engine;
- Rust syntax/lifetimes exposed directly to ordinary authors;
- trusting LLVM tail-call optimization;
- making all Rust crates automatically usable without a semantic/codec contract.

Those can only enter through separate, explicit design decisions.

---

## 15. Diagnostics and tooling

The compiler should expose the new language properties directly.

Examples:

```text
✓ gcd is self-tail recursive
  lowering: loop
  stack: bounded

✓ recursive group { even, odd } is proper-tail recursive
  lowering: state machine

✗ walkTree contains a non-tail recursive edge
  call result is consumed by Array.append
  at src/tree.ts:84

✗ retryLoop recursive edge is not tail-safe
  caller-owned finalizer must execute after the call
  scope acquired at src/job.ts:21

✗ native type DateTime is unavailable for target wasm32
  required implementation: chrono/utc
```

Support reports should state:

- semantic type;
- selected native representation;
- reachable native crates/features;
- recursion SCC classification;
- tail-call lowering;
- ownership result;
- native-extension requirements;
- source provenance.

---

## 16. Performance implications

The richer language should generally improve generated code rather than introduce a generic runtime.

Expected wins:

- named calls reduce repeated inlining and generated size;
- tail recursion becomes explicit loops/state machines;
- sized values avoid unnecessary dynamic representations;
- fixed arrays/tuples improve layout;
- bytes avoid text/JSON detours;
- native extension types avoid boxing through generic data;
- structured loops can lower directly rather than through intermediate combinator objects.

Measure:

- generated Rust size;
- compile time;
- binary size;
- call overhead;
- stack growth;
- allocation count;
- representation size/alignment;
- direct versus inlined helper performance.

Inlining can remain an optimization decision after calls exist.

---

## 17. Decision summary

**RL-D1 — R is a small language.**  
Treat the public R surface as a coherent statically typed semantic language usable directly and by migration frontends.

**RL-D2 — semantic type is not native representation.**  
Keep JS/Effect meaning separate from narrower native Rust types.

**RL-D3 — named monomorphic calls move into the planned foundation.**  
`FunctionRef` + `Call` should be implemented; first-class function values remain out of scope.

**RL-D4 — proper tail recursion is guaranteed.**  
Tail-recursive SCCs lower to loops/state machines rather than relying on Rust/LLVM optimization.

**RL-D5 — tail position is semantic.**  
Effects, Scope/finalizers, ownership and continuations participate in the analysis.

**RL-D6 — structured control flow becomes IR.**  
Add blocks, locals, branches, loops and returns so direct authors and codemods have a natural target.

**RL-D7 — add a deliberate native type batch.**  
Sized numbers, tuples, fixed arrays, bytes, native Option/Result, newtypes and explicit map/set families are now planned rather than indefinitely workload-deferred.

**RL-D8 — native extensions are explicit.**  
Opaque Rust types require a structured representation, target requirements and boundary semantics; no generic JS/runtime value.

**RL-D9 — ownership remains backend analysis.**  
Normal R source does not expose Rust lifetime syntax.

**RL-D10 — this supports, rather than distracts from, milestone 8B.**  
A richer structured R gives the Foldkit SSR codemod a simpler and more semantically honest target.
