# Gen2 semantic kernel and typed laws

[Roadmap](../PLAN.md) · [Documentation index](README.md) · [Revision overview](op-expr-revision-convo.md)

This document preserves part of the later design conversation. Read the revision overview for how it updates earlier proposals. Examples and upstream API, repository, and licensing claims are historical design material, not verified current facts or implemented guarantees.

## Contents

- [The kernel should look more like Gen2](#the-kernel-should-look-more-like-gen2)
- [Typed laws are probably the biggest improvement](#typed-laws-are-probably-the-biggest-improvement)
- [There should actually be several kinds of law](#there-should-actually-be-several-kinds-of-law)
- [Gen2's assurance level is also worth keeping](#gen2s-assurance-level-is-also-worth-keeping)
- [And Schema gives us a way to test laws automatically](#and-schema-gives-us-a-way-to-test-laws-automatically)
- [Gen2's separation of capability/effect/law is important](#gen2s-separation-of-capabilityeffectlaw-is-important)
- [Traits are another thing I'd borrow](#traits-are-another-thing-id-borrow)
- [But I wouldn't expose Rust traits directly](#but-i-wouldnt-expose-rust-traits-directly)
- [Gen2's Representation is almost exactly what we need](#gen2s-representation-is-almost-exactly-what-we-need)
- [Gen2's compiler-pass architecture also improves ours](#gen2s-compiler-pass-architecture-also-improves-ours)
- [Gen2's explicit fallback planning is also valuable](#gen2s-explicit-fallback-planning-is-also-valuable)
- [Laws become particularly interesting for ownership/concurrency](#laws-become-particularly-interesting-for-ownershipconcurrency)
- [It also makes Effect Native's operation registry much better](#it-also-makes-effect-natives-operation-registry-much-better)
- [I would _not_ copy all of Gen2](#i-would-not-copy-all-of-gen2)
- [The revised mental model](#the-revised-mental-model)

---

Yes. After looking through `gen2`, I think it should change the `effect-native` design in some important ways. The biggest lesson is that we were treating the IR mostly as “typed nodes that Rust can lower.” Gen2 suggests it should instead be **typed semantic nodes carrying enough evidence for the compiler to reason about which transformations are valid**.

The strongest pieces are in `src/types/operation.ts`, `src/types/representation.ts`, `src/kernel/trait.ts`, the expression system, and the composition model described in `docs/core-primitives.md`. Gen2 already separates **semantic type, physical representation, operation, capability, effect, law, runtime implementation, and checked traits**. That separation is almost exactly what `effect-native` needs.

### The kernel should look more like Gen2

I would now make the low-level model something approximately like:

```ts
CType<A>;
Representation;

Operation<Args, Out, Laws, Effects, Capabilities>;

Expr<T>;

Law<Subject, Kind, Evidence>;

Fn<Input, Output, Effects>;

Service;
Layer;

Program;

Target;
Implementation;
```

And an operation is not merely:

```ts
{
  op: "u64.add";
}
```

but semantically closer to:

```ts
Operation {
  id: "u64.add"

  inputs: [U64, U64]
  output: U64

  capabilities: [...]
  effects: []

  laws: [...]

  implementations: {
    reference: ...,
    rust: ...,
    wasm: ...
  }
}
```

That is very close to what Gen2 already does for its operations. [`src/types/operation.ts`](https://github.com/doeixd/gen2/blob/main/src/types/operation.ts)

The compiler then doesn't ask merely:

> “Do I know how to emit `u64.add`?”

It can ask:

> What does this operation mean? What can it do? What laws hold? Which runtimes implement it? Which transformations are legal?

That's much stronger.

---

## Typed laws are probably the biggest improvement

Gen2 already has the right conceptual idea:

```text
associative
commutative
idempotent
identity
inverse
distributive
```

plus an assurance level:

```text
claim
tested
proven
```

and elsewhere it has behavioral law traits such as deterministic, parallel-safe, rollback-safe, monotonic, etc. [`docs/core-primitives.md`](https://github.com/doeixd/gen2/blob/main/docs/core-primitives.md)

But I would go **further than the current Gen2 implementation**.

Right now Gen2's:

```ts
interface Law {
  kind: LawKind;
  assurance: "claim" | "tested" | "proven";
}
```

is basically typed metadata. It isn't actually indexed by the operation it proves something about.

For `effect-native`, laws should be **witnesses**.

Something like:

```ts
Law.Associative<typeof AddU64>;
Law.Commutative<typeof AddU64>;

Law.Identity<typeof AddU64, typeof Zero>;

Law.Distributive<typeof MulU64, typeof AddU64>;
```

So you couldn't accidentally attach:

```ts
Law.associative();
```

to some nonsensical unary operation.

Conceptually:

```ts
const AddU64 = Operation.binary({
  name: "u64.add",
  left: U64,
  right: U64,
  output: U64,
  reference: ...
}).pipe(
  Operation.withLaw(
    Law.associative({
      evidence: Law.builtin
    })
  ),

  Operation.withLaw(
    Law.commutative({
      evidence: Law.builtin
    })
  ),

  Operation.withLaw(
    Law.identity(0, {
      evidence: Law.builtin
    })
  )
)
```

And the operation's type itself can carry its law set:

```ts
Operation<
  [U64, U64],
  U64,
  {
    associative: true;
    commutative: true;
    identity: 0;
  }
>;
```

This makes laws usable by generic APIs **at the TypeScript level**.

For example:

```ts
C.Vector.parallelReduce(vector, op);
```

could require:

```text
op is associative
```

because arbitrary reassociation is only safe under associativity.

If the compiler also wants to reorder work, it may require commutativity.

That's much stronger than running a validator afterwards.

---

## There should actually be several kinds of law

Gen2 mostly starts from algebraic laws, but `effect-native` needs a broader concept of semantic evidence.

I think we want four families:

| Law family         | Examples                                                                | Compiler use                            |
| ------------------ | ----------------------------------------------------------------------- | --------------------------------------- |
| **Algebraic**      | associative, commutative, identity, inverse, distributive               | reduction, fusion, reordering, rollback |
| **Execution**      | deterministic, idempotent, retry-safe, parallel-safe, cancellation-safe | retry/concurrency planning              |
| **Representation** | encode/decode roundtrip, lossless, canonical, order-preserving          | codecs, storage, SchemaBinary           |
| **Implementation** | Rust implementation equivalent to reference semantics                   | backend conformance                     |

For example:

```ts
Law.roundTrip(encode, decode);
```

means:

```text
decode(encode(x)) = x
```

while:

```ts
Law.canonical(encode);
```

might mean equivalent values have one canonical encoding.

Those become enormously useful for:

```text
SchemaBinary
RPC codecs
database mappings
native/wire conversion
```

Likewise an Effect operation might carry:

```text
deterministic
idempotent
```

which can enable caching, deduplication, replay strategies, or stronger compiler diagnostics.

---

## Gen2's assurance level is also worth keeping

I really like:

```text
claim
tested
proven
```

but I'd probably add:

```text
builtin
```

or `trusted`.

For example:

```ts
Law.associative({
  evidence: Law.tested(MyPropertySuite),
});
```

versus:

```ts
Law.associative({
  evidence: Law.builtin,
});
```

The compiler can then have an optimization trust policy:

```ts
Compile.withLawPolicy({
  optimizeUsing: "tested",
});
```

Meaning:

```text
builtin  ✓
proven   ✓
tested   ✓
claim    ✗
```

A development compiler might accept claims but warn.

A safety-critical/native-release profile could refuse to perform transformations relying on mere claims.

That is much better than treating all annotations equally.

---

## And Schema gives us a way to test laws automatically

This is where Effect Native could go beyond Gen2.

Every operation already knows its CType/Schema.

So an operation:

```text
U64 × U64 → U64
```

plus:

```text
Associative
```

gives us enough information to automatically generate a property test:

```text
op(op(a, b), c)
==
op(a, op(b, c))
```

for generated `a`, `b`, `c`.

Same for:

```text
Commutative:

op(a,b) == op(b,a)
```

and:

```text
Identity:

op(a, zero) == a
op(zero, a) == a
```

Even more importantly, every backend implementation can be tested against the reference interpreter:

```text
JS reference implementation
             │
      generated inputs
             │
        ┌────┴────┐
        ▼         ▼
       JS        Rust
        │         │
        └── same ─┘
```

So a Rust implementation isn't just:

```ts
rust: "a + b";
```

It has a **conformance obligation**.

That's a very Gen2 idea: semantic declaration first, implementation later, conformance checked against meaning.

---

# Gen2's separation of capability/effect/law is important

We were blurring some of these.

They should stay distinct.

```text
Capability
    what the runtime/backend CAN provide

Effect
    what the program MAY DO

Requirement
    which external service/resource is needed

Law
    what semantic property is guaranteed
```

For example:

```text
Operation Database.query

requirements:
    Database

effects:
    db_read

capabilities required:
    async
    sql

laws:
    deterministic? maybe no
    idempotent? depends
```

And:

```text
Target Rust/Tokio/SQLx

capabilities:
    async
    threads
    sql
    streams
    atomics
    sockets
```

This gives compatibility as a proper relation:

```text
program requirements
        ⊆
target capabilities
```

instead of a pile of backend special cases.

Gen2 already has this idea in its runtime/operation checking. That's directly reusable.

---

# Traits are another thing I'd borrow

Gen2's newer kernel makes an important move:

> A trait is a **checked semantic claim**, not an arbitrary metadata tag.

Traits can:

```text
apply only to certain things
imply other traits
conflict with traits
require capabilities
require laws
```

That is perfect for our CType system.

For example:

```text
U64

traits:
    Eq
    Ord
    Hash
    Copy
    Clone
    Send
    Sync
    AtomicCompatible
```

while:

```text
F64

traits:
    Eq? special
    Ord ✗ normal total order
    Hash? special
    Copy ✓
    Send ✓
    Sync ✓
```

And:

```text
Vector<User>

Clone
    only if User: Clone

Eq
    only if User: Eq

Send
    only if User: Send
```

The compiler derives these.

Then a container can state requirements:

```ts
C.HashMap(K, V);
```

requires:

```text
K: Eq + Hash
```

and:

```ts
C.OrderedMap(K, V);
```

requires:

```text
K: Ord
```

Likewise:

```ts
C.Ref.atomic(U64);
```

might require:

```text
AtomicCompatible
```

This feels much cleaner than scattering checks through the compiler.

---

# But I wouldn't expose Rust traits directly

Our semantic system shouldn't say:

```text
std::marker::Send
std::marker::Sync
```

as the source model.

It should express semantic/native requirements like:

```text
ThreadSafe
Shareable
Copyable
Hashable
TotallyOrdered
AtomicCompatible
```

and the Rust target maps those onto:

```text
Send
Sync
Copy
Hash
Ord
Atomic*
```

A future WASM/backend might interpret them differently.

This is another Gen2 lesson: keep target semantics downstream.

---

# Gen2's Representation is almost exactly what we need

This part is striking.

Its current `Representation` includes:

```text
u8...u128
i8...i128
f32/f64
bool
text
fixed_string
bytes
fixed_bytes
optional
array
set
map
struct
tagged
document
```

plus:

```text
byte width
signedness
floating-point format
text encoding
length prefix
fixed-size flag
endianness
comparison semantics
aggregate semantics
```

[`src/types/representation.ts`](https://github.com/doeixd/gen2/blob/main/src/types/representation.ts)

That's basically our CType representation conversation already implemented in another form.

I would borrow this heavily.

But for Effect Native I'd split one thing more clearly than Gen2 currently does:

```text
CType
  semantic Schema

NativeRepresentation
  Rust in-memory representation

WireRepresentation
  JSON / SchemaBinary / RPC

StorageRepresentation
  Postgres / SQLite etc.
```

Because those can differ:

```text
UserId

semantic:
    UserId

native:
    u64

JSON:
    decimal string

SQL:
    BIGINT

binary:
    varint
```

Gen2 already points strongly in this direction; Effect Native should make the layers explicit.

---

# Gen2's compiler-pass architecture also improves ours

We had:

```text
validate
optimize
ownership
lower
emit
```

Gen2's clean distinction:

```text
check
derive
lower
emit
```

is useful.

I'd now use something like:

```text
check
  ↓
derive
  ↓
normalize
  ↓
plan
  ↓
verify
  ↓
optimize
  ↓
ownership
  ↓
lower
  ↓
emit
  ↓
build
```

Where:

**check** verifies local/static invariants.

**derive** computes things not manually declared:

```text
dependencies
effect footprint
required capabilities
service requirements
type traits
scope relationships
```

**normalize** turns convenient composition into canonical IR.

**plan** chooses:

```text
runtime implementation
ownership strategy
Ref representation
transport
SQL pushdown
serialization
```

**verify** checks that the chosen plan has the laws/capabilities it needs.

**optimize** performs only transformations justified by those laws.

**ownership** assigns moves/borrows/Arc/etc.

Then normal Rust lowering occurs.

And, as we discussed earlier, every stage should be available through the public Effect compiler API:

```ts
Compile.check(...)
Compile.derive(...)
Compile.plan(...)
Compile.verify(...)
Compile.optimize(...)
Compile.analyzeOwnership(...)
Compile.lower(...)
```

---

# Gen2's explicit fallback planning is also valuable

This is something I'd now make first-class.

Instead of silently choosing:

```text
Ref<AppState>
  → Mutex
```

the planner could record:

```text
preferred:
    Atomic representation

rejected:
    AppState is not AtomicCompatible

selected:
    Mutex<AppState>
```

Or:

```text
RPC serialization

preferred:
    SchemaBinary

unsupported:
    custom Schema transform has no native codec

fallback:
    JSON
```

Or:

```text
Remote query

preferred:
    SQL pushdown

rejected:
    operation `containsUnicode` unsupported by Postgres backend

fallback:
    bounded server evaluation

safety:
    valid because maximum candidate set = 100
```

Gen2 is very explicit about not silently degrading when a fallback changes correctness/security semantics. That's absolutely the right philosophy here too.

Then:

```ts
yield * Compile.explain(program);
```

could give a genuinely useful explanation of what the compiler chose and why.

---

# Laws become particularly interesting for ownership/concurrency

This is where Gen2 could make our Rust compiler smarter.

Suppose:

```ts
C.Vector.reduce(items, Add);
```

If `Add` is associative:

```text
sequential fold
can safely become tree reduction
```

If associative + parallel-safe:

```text
can become parallel reduction
```

If commutative too:

```text
work partition/order can vary freely
```

Likewise:

```text
Effect retry
```

doesn't generally _require_ idempotence—Effect itself allows repeated effect execution—but the compiler can say:

```text
This operation has an externally visible write effect
and is being retried.

No Idempotent/RetrySafe evidence exists.
```

That could be a warning or a strict-profile error.

For optimistic updates:

```text
Inverse
```

can justify automatic rollback.

For Remote/Sync:

```text
Commutative + Associative + Idempotent
```

is extremely useful for merge/reconciliation.

For live/IVM:

```text
Monotonic
```

can tell us whether incremental maintenance is safe.

Gen2 already applies essentially this thinking to merge strategies: set union carries associativity, commutativity and idempotence; sum-delta carries associativity/commutativity; planning warns around retries and parallel writes. [`src/merge/merge.ts`](https://github.com/doeixd/gen2/blob/main/src/merge/merge.ts)

That's highly relevant.

---

# It also makes Effect Native's operation registry much better

I would revise the registry we discussed into something like:

```ts
const AddU64 = Operation.binary({
  id: "native/u64/add",

  left: U64,
  right: U64,
  output: U64,

  effects: EffectSet.empty,

  laws: LawSet.make(
    Law.associative(...),
    Law.commutative(...),
    Law.identity(0, ...)
  ),

  implementations: {
    reference: JS.operation(...),

    rust: Rust.expression((a, b) =>
      Rust.add(a, b)
    )
  }
})
```

And something effectful:

```ts
const Sleep = Operation.effect({
  id: "effect/sleep",

  input: Duration,
  output: Unit,

  effects: [Effect.clock, Effect.suspend],

  requiresCapabilities: [Capability.timer, Capability.async],

  implementations: {
    reference: Effect.sleep,
    rust: Tokio.sleep,
  },
});
```

This is much richer and cleaner than a hard-coded giant `switch`.

Plugins could contribute operations using exactly the same mechanism.

---

# I would _not_ copy all of Gen2

There are a few areas where Effect Native should remain smaller.

Gen2 is an **application semantic graph compiler**, so it needs concepts like general Nodes, Edges, domain rules, auth topology, reactivity topology, etc.

Effect Native's core problem is narrower:

```text
typed computation
        ↓
native execution
```

So I wouldn't immediately create:

```text
everything is Node
everything is Edge
```

in the user-facing core.

But I _would_ derive a graph internally:

```text
Fn calls Fn
Fn requires Service
Effect forks Effect
Layer provides Service
Expr reads Input
Ref escapes Scope
Operation uses Capability
```

because that graph helps with:

```text
ownership
lifetimes
dead code
Layer planning
effect analysis
target compatibility
```

So Gen2's graph architecture is useful as a **compiler analysis layer**, not necessarily as the API users author against.

---

## The revised mental model

I think the design now becomes:

```text
                    CType
                      │
                Representation
                      │
                      ▼
             typed symbolic Expr
                      │
                 Operation
            ┌─────────┼─────────┐
            │         │         │
         Effects   Laws     Capabilities
            │         │         │
            └─────────┼─────────┘
                      ▼
                     Fn
                      │
              Service / Layer
                      │
                   Program
                      │
             ┌────────┴────────┐
             ▼                 ▼
        Effect reference      Compiler
        interpreter             │
                                ▼
                      check / derive
                                │
                             normalize
                                │
                               plan
                                │
                       law verification
                                │
                            optimize
                                │
                     ownership/lifetimes
                                │
                              lower
                                │
                               Rust
```

And I think **laws become one of the things that differentiates this from a normal DSL-to-Rust compiler**.

The compiler doesn't merely know:

> "`Vector.reduce` can be emitted as this Rust loop."

It can know:

> "`Vector.reduce` is using an associative operation with tested equivalence on the Rust backend, so I am allowed to reassociate it; it is also commutative and parallel-safe, so I can partition it across tasks; its identity is known, so empty partitions are valid."

That is a much more interesting compiler.

So yes: `doeixd/gen2` should be treated as serious prior art for this project. In particular I would directly carry forward its **semantic type ↔ representation separation, operation metadata, law evidence, capabilities/effects distinction, checked traits, target implementations, explicit fallback planning, compiler-pass architecture, and conformance-first philosophy**—while making the laws substantially more type-indexed than they currently are in Gen2.
