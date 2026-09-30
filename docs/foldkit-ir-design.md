# Foldkit Expr and Operation design

[Roadmap](../PLAN.md) · [Documentation index](README.md) · [Revision overview](op-expr-revision-convo.md)

This document preserves part of the later design conversation. Read the revision overview for how it updates earlier proposals. Examples and upstream API, repository, and licensing claims are historical design material, not verified current facts or implemented guarantees.

## Contents

- [`Expr` is almost exactly the right model](#expr-is-almost-exactly-the-right-model)
- [The biggest thing I'd generalize is `Expr<T>`](#the-biggest-thing-id-generalize-is-exprt)
- [`InputExpr` is basically `C.fn` already](#inputexpr-is-basically-cfn-already)
- [`dependenciesOf` is even more important](#dependenciesof-is-even-more-important)
- [I would preserve the “interpreter declares support” model](#i-would-preserve-the-interpreter-declares-support-model)
- [The conformance architecture is probably the most important thing to copy](#the-conformance-architecture-is-probably-the-most-important-thing-to-copy)
- [Even the semantics lessons from `contains` matter](#even-the-semantics-lessons-from-contains-matter)
- [Your `Query` normalization is also instructive](#your-query-normalization-is-also-instructive)
- [Composition `Operation` inspires a different part](#composition-operation-inspires-a-different-part)
- [It suggests a useful distinction in Effect Native](#it-suggests-a-useful-distinction-in-effect-native)
- [I would probably generalize the existing operation registry idea](#i-would-probably-generalize-the-existing-operation-registry-idea)
- [Fields carrying Schema is directly reusable too](#fields-carrying-schema-is-directly-reusable-too)
- [Entity identity also points in the right direction](#entity-identity-also-points-in-the-right-direction)
- [`show()` should absolutely exist for Effect Native](#show-should-absolutely-exist-for-effect-native)
- [It also suggests Foldkit-Entity should perhaps become a dependency, not duplicated logic](#it-also-suggests-foldkit-entity-should-perhaps-become-a-dependency-not-duplicated-logic)
- [In fact, I think `foldkit-entity/Expr` could be the first compiler experiment](#in-fact-i-think-foldkit-entityexpr-could-be-the-first-compiler-experiment)
- [So yes: I think doeixd/Foldkit-Plus should influence Effect Native substantially](#so-yes-i-think-doeixdfoldkit-plus-should-influence-effect-native-substantially)

---

Very much. After looking at `foldkit-entity/Expr` and the composition `Operation` model, I think doeixd/Foldkit-Plus already contains **two miniature versions of what `effect-native` needs**:

- **`Expr` is the prototype for the expression/compiler IR.**
- **Composition `Operation` is the prototype for executable/transition IR.**

I would borrow the design philosophy heavily rather than starting the compiler IR from scratch.

### `Expr` is almost exactly the right model

The current `Expr` design already has several of the decisions we independently arrived at:

```ts
Expr.input("title", Schema.String)
Expr.field(Post.fields.slug)
Expr.literal("hello")

Expr.eq(...)
Expr.contains(...)
Expr.isNull(...)
```

These are immutable descriptions. Constructing them does nothing. Different interpreters decide what they mean operationally.

That's exactly:

```text
TypeScript
   ↓
typed symbolic values
   ↓
IR
   ├── reference JS interpreter
   ├── SQL interpreter
   └── Rust interpreter
```

The README even explicitly says the expression is deliberately **not SQL and not arbitrary JavaScript** and that the operation set grows from actual use rather than from everything a database could theoretically express. That is almost word-for-word the philosophy I would use for `effect-native`.

## The biggest thing I'd generalize is `Expr<T>`

Right now it is intentionally tiny:

```ts
type Expr<T> = LiteralExpr<T> | FieldExpr<T> | InputExpr<T>;
```

and computations like equality/contains are separately represented as predicates.

For Effect Native, I'd generalize that to:

```ts
Expr<T extends CType.Any>
```

where operations can themselves produce expressions:

```text
Literal
Input
Field
StructField

Intrinsic {
  operation
  arguments
}
```

Then:

```ts
C.U32.add(a, b);
```

is:

```text
Expr<U32>(
  Op("u32.add", [a, b])
)
```

and:

```ts
C.String.concat(a, b);
```

is:

```text
Expr<String>(
  Op("string.concat", [a, b])
)
```

and:

```ts
C.Vector.length(users);
```

is:

```text
Expr<U64>(
  Op("vector.length", [users])
)
```

So Foldkit's current:

```text
Expr
+
Predicate
```

naturally expands into:

```text
Expr<A>
+
Predicate = Expr<Bool>
```

or perhaps keeps Predicate nominally distinct if that continues to give better TypeScript safety.

Your comment in `expr.ts` about keeping `Predicate` separate because a structural phantom would let it get confused with `Expr<string>` is exactly the kind of type-system subtlety we'd want to preserve.

---

# `InputExpr` is basically `C.fn` already

This part is especially striking.

Foldkit currently says:

> an input is a placeholder, not a value; the query body is built once, so there is nothing there yet to branch on.

That is **exactly** the model we arrived at for:

```ts
C.fn(UserId, User, id => ...)
```

Inside:

```ts
id;
```

isn't really a `UserId`.

It's:

```text
InputExpr<UserId>
```

or more generally:

```text
Expr<UserId>
```

Your existing warning about this mistake:

```ts
input.archived ? a : b;
```

being wrong because the symbolic input object is always truthy is precisely the same issue we'd face in Effect Native.

So we can reuse that conceptual model nearly verbatim:

```text
Query.define callback
    receives symbolic Input

C.fn callback
    receives symbolic Input
```

The existing Foldkit solution — static expression constructors plus lint/tooling preventing accidental JS branching — is already evidence that the model works.

---

# `dependenciesOf` is even more important

This is possibly the strongest reusable concept.

Today:

```ts
dependenciesOf(expr);
```

finds:

```text
fields
inputs
operations
```

That becomes Effect Native's generalized compiler analysis.

Imagine:

```ts
Compile.dependencies(program);
```

returning:

```text
Inputs
Types

Operations
  u32.add
  string.contains
  vector.map

Services
  Database
  Clock

Effects
  Async
  Scoped
  Concurrent

Resources
  Queue
  Ref

Access
  Borrow<User>
  MutBorrow<Vector<Item>>

Capabilities
  HTTP
  SQL
  RPC
```

In other words, your existing:

```text
dependenciesOf
```

could grow conceptually into the compiler's **capability/effect analysis pass**.

And this:

```ts
Query.unsupported(query, supported);
```

is basically the prototype of:

```ts
Compile.unsupported(program, target);
```

returning:

```text
Effect.race
Schema.SomeTransform
String.graphemeCount
WhateverOperation
```

that the selected Rust profile doesn't implement yet.

That's excellent.

---

# I would preserve the “interpreter declares support” model

I really like this rule from Foldkit-Entity:

> An interpreter must refuse an operation it cannot run rather than silently answering a different question.

That's exactly what we want.

For Effect Native:

```text
program requires:
    string.contains
    u64.add
    vector.filter
    effect.sleep
    effect.race

Rust backend supports:
    string.contains
    u64.add
    vector.filter
    effect.sleep

missing:
    effect.race
```

Compiler:

```text
EN1004

Target rust-v0 cannot execute:
  Effect.race

required by:
  GetRecommendations
    → RaceProviders
```

Not fallback semantics.

Not “best effort.”

Not silently execute something different.

That principle should become fundamental.

---

# The conformance architecture is probably the most important thing to copy

Your current system has:

```text
IR semantics
     ↓
evaluate
```

as the reference implementation.

Then:

```text
same Query
    │
    ├── in-memory evaluator
    └── Drizzle/SQL

must produce same answer
```

And you've deliberately chosen conformance cases where implementations are likely to disagree:

```text
NULLs
case
LIKE semantics
% / _
booleans
ordering
```

This is exactly how I would build Effect Native.

For every intrinsic/semantic group:

```text
Reference Effect/JS implementation
             │
             ├─────────────┐
             ▼             ▼
         JS result      Rust result
             │             │
             └──── equivalent
```

For serialization:

```text
Effect Schema encode → bytes
Rust decode          → value

Rust encode          → bytes
Effect Schema decode → value
```

For concurrency:

```text
Effect program
   → Exit / finalizer trace

Rust program
   → Exit / finalizer trace
```

For Remote:

```text
evaluate/query semantics
Drizzle
Rust SQLx

→ same rows/order
```

You already have the right testing philosophy.

---

# Even the semantics lessons from `contains` matter

Your current `Expr.contains` deliberately defines:

- case-insensitive behavior,
- ASCII folding,
- null behavior,
- empty-string behavior,
- allowed operand types,

rather than saying:

> “whatever SQL LIKE does.”

That's exactly how we should think about every Effect Native operation.

For example, don't define:

```text
String.length = whatever Rust does
```

Define:

```text
String.scalarCount
```

with precise semantics.

Don't define:

```text
Map iteration = HashMap iteration
```

Define:

```text
HashMap iteration order is unspecified
```

Don't define:

```text
float equality = backend equality
```

Define exact NaN/-0 semantics.

The **IR owns semantics; the backend implements them**.

Foldkit's query IR already embodies that principle.

---

# Your `Query` normalization is also instructive

This is a small but important design decision:

```ts
Query.where(a).pipe(Query.where(b), Query.where(c));
```

is represented as:

```text
where: [a,b,c]
```

rather than:

```text
And(
  And(a,b),
  c
)
```

because the list itself means conjunction.

That's exactly the kind of **canonical IR shape** we should prefer in Effect Native.

Don't blindly mirror source composition.

Normalize it.

For example:

```ts
C.Vector.map(A).pipe(C.Vector.map(B));
```

could perhaps normalize to:

```text
MapPipeline [A,B]
```

or eventually fuse them.

Likewise:

```text
Effect.provide(A)
Effect.provide(B)
```

might normalize into environment information.

And:

```text
Layer.merge
```

should become a dependency graph, not nested `Merge(Merge(...))` forever.

Your existing `Query` design demonstrates the right instinct:

> representation should capture semantics in the form that makes interpretation/optimization simplest, not reproduce the syntax tree exactly.

---

# Composition `Operation` inspires a different part

`packages/composition/src/operation.ts` has another important pattern:

```text
Document + Operation
    →
Document
or Refusal

pure
deterministic
no hidden ID generation
Schema-backed
replayable
```

The comment that **every ID an operation creates is inside the Operation and `apply` never invents one** is especially relevant.

That's a general rule I'd steal:

> **Compiled IR should contain all nondeterministic/external choices explicitly.**

Don't let the Rust backend secretly decide things that the reference interpreter doesn't.

If something needs:

```text
random ID
current time
random number
```

that is an Effect:

```text
Random
Clock
Uuid
```

and its result becomes explicit data.

Then the actual state transition remains deterministic.

That gives you:

```text
replayability
differential testing
deterministic debugging
```

and keeps the JS and Rust interpreters aligned.

---

# It suggests a useful distinction in Effect Native

We've been using “operation” somewhat loosely.

Foldkit makes me think the compiler should probably distinguish three major IR categories:

```text
Expr<A>
────────────────────
pure value computation

Examples:
add
field
concat
map lookup
predicate


Effect<A,E,R>
────────────────────
effectful computation

Examples:
database call
sleep
fork
queue take
RPC


Operation<S>
────────────────────
data describing a deterministic
state transition / action

Examples:
Remote patch
document edit
sync operation
possibly Foldkit Message
```

That's cleaner than trying to put everything under one generic AST node.

And all three can ultimately compose.

---

# I would probably generalize the existing operation registry idea

> **Later update:** The [revised semantic definitions](compiler-design-revision.md#6-operations-become-first-class-semantic-definitions) add laws/evidence and traits; [runtime lowering](runtime-lowering.md#three-implementation-registries) subsequently separates operation, service, and semantic runtime implementations.

Today `Expr` has:

```ts
type Operation = "eq" | "isNull" | "isNotNull" | "contains";
```

For Effect Native, I'd make an internal definition richer:

```ts
Operation.define({
  id: "u32.add",

  inputs: [U32, U32],
  output: U32,

  purity: "pure",

  access: ["borrow", "borrow"],

  reference: (a, b) => a + b,

  rust: Rust.intrinsic("add"),
});
```

And:

```ts
Operation.define({
  id: "effect.sleep",

  inputs: [Duration],
  output: EffectType(Unit),

  capabilities: ["async", "interruptible"],

  reference: (duration) => Effect.sleep(duration),

  rust: Rust.runtime("sleep"),
});
```

Not necessarily public exactly like that, but conceptually.

Then:

```ts
C.U32.add;
```

is just the ergonomic typed constructor for the registered operation.

This registry drives:

```text
typing
IR construction
dependency extraction
support checking
JS reference interpretation
Rust lowering
documentation
LSP information
```

That is basically the scalable evolution of your existing `Operation` string union.

---

# Fields carrying Schema is directly reusable too

Current `FieldExpr<T>` contains:

```ts
owner;
key;
schema;
```

That's already very close to:

```text
Expr<T> carries its CType
```

For native compilation we'd enrich:

```ts
schema;
```

into:

```text
compiled type witness
```

which still includes Schema:

```ts
CType {
  schema
  repr
  capabilities
}
```

So the evolution is almost:

```text
FieldExpr today

owner
key
Schema<T>

        ↓

Native FieldExpr

owner
key
CType<T>
    ├─ Schema<T>
    ├─ native repr
    └─ capabilities
```

Very natural.

---

# Entity identity also points in the right direction

Foldkit doesn't identify an Entity merely by its name.

It has actual identity, and `FieldExpr` carries the owner's identity so two Entities both named `"Post"` aren't treated as the same field source.

I'd use that philosophy throughout Effect Native:

```text
Service identity
Schema/type identity
FiberRef identity
Layer node identity
Function identity
Compiled operation identity
```

should be explicit stable descriptors, not inferred from display names.

Names are diagnostics.

Identity is semantics.

---

# `show()` should absolutely exist for Effect Native

Current:

```ts
Expr.show(...)
Query.show(...)
```

is meant for humans, explicitly **not for interpreters**.

That is a great distinction.

Effect Native should have:

```ts
Native.show(program);
Compile.show(program);
```

perhaps yielding something like:

```text
fn GetUser(id: UserId)
  requires Users

  let result =
    Users.find(id)

  match result
    Some(user) -> succeed user
    None       -> fail NotFound(id)
```

or:

```text
SERVICE Users
CALL Users.find($id)
MATCH
  Some($user) => SUCCESS $user
  None => FAIL NotFound { id: $id }
```

Then CLI:

```bash
effect-native emit ir
```

can use the same pretty-printer.

Again, **pretty representation belongs beside the IR, but isn't itself the IR** — exactly the distinction you've already made with Query.

---

# It also suggests Foldkit-Entity should perhaps become a dependency, not duplicated logic

> **Later update:** The [later reuse decision](compiler-design-revision.md#3-do-not-extract-a-shared-mega-kernel-yet) defers a shared kernel until demonstrated commonality. Reuse existing contracts/IR deliberately without requiring that extraction for v0.

For the Foldkit integration in particular, I would not invent:

```text
NativeExpr
NativeQuery
```

separate from:

```text
foldkit-entity Expr
foldkit-entity Query
```

We should probably compile those **directly**.

So the graph becomes:

```text
                foldkit-entity Expr / Query
                         │
           ┌─────────────┼─────────────┐
           ▼             ▼             ▼
       evaluate       Drizzle      Effect Native
                                      │
                                      ▼
                                    Rust
```

That is cleaner and gives Effect Native an immediate real IR to support.

---

# In fact, I think `foldkit-entity/Expr` could be the first compiler experiment

Before implementing a general `C.fn`, build:

```text
foldkit Entity Query
       ↓
Effect Native compiler
       ↓
Rust evaluator
```

Take your existing exported conformance suite.

Generate a Rust executable that evaluates:

```text
Expr.eq
Expr.isNull
Expr.isNotNull
Expr.contains
Order
Query
```

against the same fixtures.

Then require:

```text
JS evaluate
    ==
Rust evaluate
    ==
Drizzle SQLite
```

That would validate several of the hardest architectural assumptions very cheaply:

```text
Effect Schema → native representations
typed IR → Rust
operation registry
backend support checking
string semantics
nullable semantics
vectors/structs
compiled functions
Rust build pipeline
cross-language conformance
```

And there's no Effect runtime or fibers involved yet.

That's probably a **better “compiler milestone 0” than compiling an artificial add function.**

Then extend that same machinery:

```text
Expr
 ↓
general C.Expr

Query
 ↓
higher-level application IR

evaluate
 ↓
general JS reference interpreter
```

---

## So yes: I think doeixd/Foldkit-Plus should influence Effect Native substantially

Not by making Effect Native Foldkit-specific, but because you've already independently discovered a lot of the right compiler abstractions:

```text
Foldkit-Plus                    Effect Native
──────────────────────────────────────────────

Expr                       →    typed expression IR

InputExpr                  →    symbolic C.fn argument

FieldExpr + Schema         →    typed symbolic value + CType

Operation union            →    intrinsic registry

dependenciesOf             →    capability/effect analysis

Query.unsupported          →    target compatibility checking

evaluate                   →    reference interpreter

conformance cases          →    cross-backend semantic tests

Query / pipe fragments     →    compositional normalized IR

Query.show / Expr.show     →    compiler IR diagnostics

Entity identity            →    stable semantic identities

Composition Operation      →    Schema-backed transition IR

apply(Operation)           →    deterministic/replayable semantics

Drizzle compiler           →    precedent for alternative Rust backend
```

The really nice realization is that **Effect Native doesn't start from zero anymore**. `foldkit-entity/Expr + Query + evaluate + remote-drizzle` already demonstrate the core pattern on a small domain:

> Define semantics as typed immutable data, give it a reference interpreter, let backends declare what they support, and compile the same description into different execution systems.

Effect Native is essentially that idea **generalized from query expressions to an entire Effect program**.
