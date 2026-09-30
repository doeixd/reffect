# Compiler architecture

[Roadmap](../PLAN.md) · [Documentation index](README.md)

The [runtime lowering reference](runtime-lowering.md) expands the small-runtime principle into a candidate substrate catalogue and three lowering strategies. Use it for service registries, Layer wiring, specialization, and adapter conformance before adding runtime machinery.

For updated kernel and sequencing decisions, read the [revised compiler design](compiler-design-revision.md), [Gen2 law/evidence design](gen2-semantic-kernel.md), and [revised milestones](implementation-milestones.md). This original discussion remains a detailed semantic reference; the later revision introduces checked semantic traits, first-class law evidence, and an expanded planning/verification pipeline.

This document preserves a design discussion from the original PLAN.md. APIs and package names are proposals, not implemented guarantees. Original citation placeholders are retained; verify external API and protocol claims against the installed dependencies before implementation.

## Contents

- [Effect Native](#effect-native)
- [Thesis](#thesis)
- [1. Do not fork Effect](#1-do-not-fork-effect)
- [2. The compiler does not initially parse TypeScript programs](#2-the-compiler-does-not-initially-parse-typescript-programs)
- [3. TypeScript outside the DSL remains unrestricted](#3-typescript-outside-the-dsl-remains-unrestricted)
- [4. Control flow is deliberately tiny](#4-control-flow-is-deliberately-tiny)
- [5. Predicates are data too](#5-predicates-are-data-too)
- [6. There are no user-written loops initially](#6-there-are-no-user-written-loops-initially)
- [7. Every compiled value has a compiled type](#7-every-compiled-value-has-a-compiled-type)
- [8. Effect Schema is the semantic type system](#8-effect-schema-is-the-semantic-type-system)
- [9. Native representation does not mean fixed payload size](#9-native-representation-does-not-mean-fixed-payload-size)
- [10. JavaScript Array/Object semantics are not part of the initial runtime language](#10-javascript-arrayobject-semantics-are-not-part-of-the-initial-runtime-language)
- [11. Strings](#11-strings)
- [12. Struct versus dynamic Map](#12-struct-versus-dynamic-map)
- [13. Immutable semantics can compile into mutation](#13-immutable-semantics-can-compile-into-mutation)
- [14. Ownership and borrowing are inferred](#14-ownership-and-borrowing-are-inferred)
- [15. Operations carry access requirements](#15-operations-carry-access-requirements)
- [16. Structured concurrency gives us lifetime information](#16-structured-concurrency-gives-us-lifetime-information)
- [17. Effect Ref is not a Rust borrow](#17-effect-ref-is-not-a-rust-borrow)
- [18. Ref specialization](#18-ref-specialization)
- [19. SubscriptionRef, Queue, PubSub and Deferred already have strong Rust substrates](#19-subscriptionref-queue-pubsub-and-deferred-already-have-strong-rust-substrates)
- [20. Services](#20-services)
- [21. Layers](#21-layers)
- [22. Effect itself](#22-effect-itself)
- [23. No `yield*`](#23-no-yield)
- [24. Fibers](#24-fibers)
- [25. Structured fiber groups](#25-structured-fiber-groups)
- [26. Fiber cancellation](#26-fiber-cancellation)
- [27. No arbitrary loops improves fibers](#27-no-arbitrary-loops-improves-fibers)
- [28. `uninterruptible`](#28-uninterruptible)
- [29. Scope](#29-scope)
- [30. FiberRef](#30-fiberref)
- [31. Concurrency combinators](#31-concurrency-combinators)
- [32. HTTP is an ideal first major platform backend](#32-http-is-an-ideal-first-major-platform-backend)
- [33. Native HTTP stack](#33-native-http-stack)
- [34. Request-scoped services](#34-request-scoped-services)
- [35. HTTP streaming](#35-http-streaming)
- [36. SQL](#36-sql)
- [37. Serialization](#37-serialization)
- [38. Streams](#38-streams)
- [39. Rc / Arc / Box are backend choices](#39-rc--arc--box-are-backend-choices)
- [40. RcRef / RcMap are different](#40-rcref--rcmap-are-different)
- [41. Application root](#41-application-root)
- [42. Build pipeline](#42-build-pipeline)
- [43. TypeScript types versus Oxlint versus compiler](#43-typescript-types-versus-oxlint-versus-compiler)
- [44. Effect tooling integration](#44-effect-tooling-integration)
- [45. Operation registry](#45-operation-registry)
- [46. JavaScript widening later](#46-javascript-widening-later)
- [47. Ordinary strings, objects and Promises remain ordinary source constructs](#47-ordinary-strings-objects-and-promises-remain-ordinary-source-constructs)
- [48. Native and hybrid targets](#48-native-and-hybrid-targets)
- [49. What actually lives in the Rust runtime](#49-what-actually-lives-in-the-rust-runtime)
- [50. The important optimization principle](#50-the-important-optimization-principle)
- [51. A complete example](#51-a-complete-example)
- [52. Implementation milestones](#52-implementation-milestones)
- [Final shape](#final-shape)

---

# Effect Native

## Thesis

> **Later update:** The project is now named **reffect**, with **R** as the DSL namespace; see the [naming decision](../AGENTS.md#project-goal). The C/Effect Native examples below retain their historical spellings.

**Effect Native is an AOT compiler for a statically representable subset of Effect programs.**

TypeScript is the authoring and metaprogramming language. The actual program being compiled is a typed intermediate representation constructed by a small Effect-shaped DSL.

```text
TypeScript authoring
        │
        │ executes builders
        ▼
┌──────────────────────────────┐
│      Compiled Effect IR      │
│                              │
│ CType / Schema               │
│ Expr / Predicate / Match     │
│ Fn / Effect                  │
│ Service / Layer              │
│ Fibers / Scope / concurrency │
│ HTTP / SQL / Stream          │
└──────────────┬───────────────┘
               │
      semantic optimization
               │
      ownership / lifetime pass
               │
               ▼
          Native Rust IR
               │
               ▼
             Rust
        ┌──────┼──────┐
        ▼      ▼      ▼
      Tokio  Hyper   SQLx
             Tower
             Axum
```

The guiding principle is:

> **Compile Effect abstractions away wherever possible. Use Rust's native facilities wherever possible. Implement a small Effect-specific runtime only where Effect adds semantics Rust does not already provide.**

Effect v4 is particularly suitable because its core already separates Schema, services/Context, Layers, fibers/concurrency, streams, platform abstractions, and related data structures; HTTP, HttpApi, SQL, persistence and other facilities are likewise represented as distinct modules.

---

# 1. Do not fork Effect

Effect remains a dependency and the **semantic reference implementation**.

The project should be something like:

```text
effect-native/
```

rather than:

```text
effect-fork/
```

The npm side would provide compiled builders:

```ts
import { Schema } from "effect";
import { Compiled as C } from "effect-native";
```

Names are provisional, but conceptually:

```ts
C.fn;
C.Match;
C.Predicate;

C.Effect;

C.Service;
C.Layer;

C.Vector;
C.HashMap;
C.Ref;
C.Queue;

C.Http;
C.Sql;
```

These don't implement a second Effect runtime in JavaScript.

They construct IR.

For example:

```ts
C.U32.add(a, b);
```

constructs something resembling:

```ts
{
  _tag: "Add",
  type: U32,
  left: a,
  right: b
}
```

while:

```ts
C.Effect.flatMap(effect, f);
```

constructs:

```text
FlatMap {
  input: ...
  continuation: ...
}
```

There is then a JavaScript interpreter:

```text
Compiled IR
     ↓
Effect interpreter
     ↓
ordinary Effect.Effect
     ↓
official Effect runtime
```

and separately:

```text
Compiled IR
     ↓
Rust backend
     ↓
native executable
```

That gives us an extremely useful testing property:

```text
             ┌── Effect JS runtime ──→ Exit A
Program IR ──┤
             └── Rust backend ───────→ Exit B

             assert equivalent
```

Effect itself becomes the executable specification for much of the compiler.

---

# 2. The compiler does not initially parse TypeScript programs

This is one of the most important decisions.

Inside compiled functions we do **not** initially support arbitrary:

```ts
if
switch
for
while
await
yield
throw
try/catch

a + b
a === b

randomMethodCall()
```

Instead:

```ts
const f = C.fn(..., x =>
  pipe(
    x,
    ...
  )
)
```

runs once during compilation with symbolic values.

If `x` has compiled type `U64`, then at build time it is conceptually:

```ts
Expr<U64>;
```

rather than an actual JavaScript number.

Operations on it construct IR.

Therefore:

```ts
C.U64.add(x, 10);
```

creates:

```text
Add<U64>(
  Local(0),
  Const<U64>(10)
)
```

No source-to-source compiler is needed to understand what the function does.

The JavaScript callback is effectively a macro used to build the actual program.

---

# 3. TypeScript outside the DSL remains unrestricted

This distinction is useful:

```text
build-time TypeScript
    unrestricted metaprogramming

compiled program
    restricted typed IR
```

So this is perfectly fine at module construction time:

```ts
const endpoints = someArray.map(...)
const generatedServices = config.map(...)
```

because that JS executes while constructing the program.

The runtime program itself remains statically representable.

This gives us a macro system almost for free.

---

# 4. Control flow is deliberately tiny

The initial compiled language has **one branching construct**:

```ts
C.Match;
```

Not JavaScript `if`, `switch`, ternaries, or implicit boolean control flow.

For example:

```ts
C.Match.value(user).pipe(
  C.Match.when(C.Predicate.field("age", C.U8.gte(18)), (user) => Adult(user)),

  C.Match.orElse((user) => Minor(user)),
);
```

Tagged unions become:

```ts
C.Match.value(result).pipe(
  C.Match.tag("Success", success => ...),
  C.Match.tag("Failure", failure => ...),
  C.Match.exhaustive
)
```

`Option`, `Result`, enums and Schema discriminated unions use the same mechanism.

TypeScript tracks the unhandled cases so `exhaustive` only becomes valid after every variant is handled.

This maps directly into Rust `match`.

---

# 5. Predicates are data too

A predicate isn't initially:

```ts
(x) => x.age >= 18;
```

It is:

```ts
C.Predicate.field("age", C.U8.gte(18));
```

which builds:

```text
FieldPredicate(
  age,
  GreaterThanOrEqual(U8, 18)
)
```

Predicates form an algebra:

```ts
C.Predicate.and(...)
C.Predicate.or(...)
C.Predicate.not(...)

C.String.startsWith(...)
C.String.contains(...)

C.U32.eq(...)
C.U32.lt(...)
C.U32.gte(...)

C.Option.isSome
C.Option.isNone
```

This makes predicates reusable by:

```text
Match
Vector.filter
HashMap.filter
SQL planning where possible
routing
validation
```

without parsing arbitrary JavaScript functions.

---

# 6. There are no user-written loops initially

No:

```ts
for
while
do
```

and probably no arbitrary recursion.

Instead:

```ts
C.Vector.map
C.Vector.filter
C.Vector.reduce
C.Vector.find

C.Effect.forEach
C.Effect.all

C.Effect.repeat
C.Schedule.*
```

The generated Rust can contain loops.

For example:

```ts
pipe(users, C.Vector.filter(IsActive), C.Vector.map(GetName));
```

might compile into one fused Rust loop:

```rust
let mut out = Vec::with_capacity(users.len());

for user in users {
    if user.active {
        out.push(user.name);
    }
}
```

That is an important optimization opportunity.

It also gives the compiler control of every loop, which helps with fiber cancellation and cooperative yielding.

---

# 7. Every compiled value has a compiled type

> **Later update:** The [revised CType model](compiler-design-revision.md#5-core-semantic-model) separates semantic Schema, native representation, wire encoding, and storage mapping. Use those distinctions when extending the type catalogue below.

This is the fundamental invariant:

> **There is no value inside the IR whose native representation is unknown.**

A compiled type conceptually contains:

```ts
interface CType<A> {
  schema: Schema.Schema<A>;
  native: NativeRepresentation;
  traits: TypeCapabilities;
}
```

The important pieces are:

```text
semantic type
    +
Effect Schema
    +
native representation
    +
capabilities
```

Not merely a TypeScript type.

TypeScript types are erased.

---

# 8. Effect Schema is the semantic type system

We should reuse Effect Schema rather than invent another validator/type-description system.

A native type can effectively be an Effect Schema carrying native representation metadata.

For example:

```ts
const UserId = C.U64;

const User = C.Struct({
  id: UserId,
  name: C.String,
  age: C.U8,
});
```

`User` is usable as Schema information, but also contains enough metadata to generate:

```rust
struct User {
    id: u64,
    name: String,
    age: u8,
}
```

Effect v4 already exposes Schema and its underlying AST/compiler-related machinery, making Schema a natural source of structured type metadata.

Not every arbitrary Effect Schema is necessarily portable. A Schema containing arbitrary JavaScript callbacks is native-compilable only if those callbacks themselves have a native representation.

Therefore every Schema can conceptually be classified:

```text
Effect Schema
   │
   ├── portable
   │      native backend available
   │
   └── host-dependent
          JS runtime required
```

---

# 9. Native representation does not mean fixed payload size

The compiler does **not** require:

> every value has N bytes total.

It requires:

> every value has a statically known representation.

So these are all valid:

| Compiled type     | Native representation            |
| ----------------- | -------------------------------- |
| `U8`              | `u8`                             |
| `U32`             | `u32`                            |
| `I64`             | `i64`                            |
| `F32`             | `f32`                            |
| `Bool`            | `bool`                           |
| `String`          | Rust UTF-8 string representation |
| `Bytes`           | byte vector/buffer               |
| `Array<T,N>`      | `[T; N]`                         |
| `Vector<T>`       | `Vec<T>`                         |
| `Tuple<A,B>`      | `(A, B)`                         |
| `Struct`          | Rust `struct`                    |
| `Enum`            | Rust `enum`                      |
| `Option<T>`       | `Option<T>`                      |
| `Result<T,E>`     | `Result<T,E>`                    |
| `HashMap<K,V>`    | `HashMap<K,V>`                   |
| `OrderedMap<K,V>` | `BTreeMap<K,V>`                  |

`String`, `Vec` and `HashMap` have dynamically sized heap contents, but their Rust value representations are statically understood.

That is enough.

---

# 10. JavaScript Array/Object semantics are not part of the initial runtime language

We should distinguish:

```text
Struct
Tuple
Array<T,N>
Vector<T>
HashMap<K,V>
```

rather than collapsing them into JavaScript `object` and `Array`.

However, **ordinary JS literal syntax can still be ergonomic**.

If the expected type is:

```ts
C.Array(C.U8, 3);
```

then:

```ts
[1, 2, 3];
```

can be normalized into a fixed array.

If the expected type is:

```ts
C.Vector(User);
```

then an array literal can become a Vector constant.

Likewise:

```ts
{
  (id, name);
}
```

can become a `Struct<User>` when the expected CType is `User`.

The source syntax may look normal. The semantics are not JavaScript object/array semantics.

---

# 11. Strings

Source-level strings should simply be normal TypeScript:

```ts
string;
```

and string literals should simply be:

```ts
"hello";
```

No `Js.String`, `NativeString`, etc.

The canonical native storage should be UTF-8.

Depending on ownership analysis, the Rust representation might be:

```text
literal                         &'static str
temporary borrowed input       &str
owned value                    String
long-lived shared text         Arc<str>
```

Those are codegen choices, not DSL types.

Serde's data model likewise treats strings as UTF-8 text and supports owned and borrowed representations.

### String semantics

We should avoid ambiguous operations initially.

Instead of one vague:

```ts
String.length;
```

provide explicit concepts such as:

```ts
C.String.byteLength;
C.String.scalarCount;
C.String.graphemeCount;
```

If we later support ordinary JS:

```ts
str.length;
```

through source transformation, it should preserve JavaScript's observable semantics rather than silently changing them.

Likewise arbitrary integer string indexing should not be part of the first portable core.

Equality, concatenation, trimming, prefix/suffix checking, splitting and related structured operations are straightforward.

---

# 12. Struct versus dynamic Map

These are semantically different.

```ts
C.Struct({
  id: C.U64,
  name: C.String,
});
```

means statically known named fields.

Rust:

```rust
struct User {
    id: u64,
    name: String,
}
```

Whereas:

```ts
C.HashMap(C.String, User);
```

means dynamic keys.

Rust:

```rust
HashMap<String, User>
```

And:

```ts
C.OrderedMap(Key, Value);
```

means iteration/order is part of the semantic contract, likely lowering to `BTreeMap`.

Compiled types can carry capabilities such as:

```text
Eq
Hash
Ord
Copy
Clone
Send
Sync
```

So `HashMap<K,V>` requires a key with `Eq + Hash`, while `OrderedMap` requires ordering.

These traits can be derived structurally.

---

# 13. Immutable semantics can compile into mutation

Suppose `HashMap` is semantically immutable:

```ts
const next = C.HashMap.set(current, key, value);
```

If the compiler proves `current` is dead after that operation, Rust can simply mutate it in place:

```rust
current.insert(key, value);
let next = current;
```

No copy.

If both versions remain live, the backend can choose:

```text
clone
copy-on-write
shared representation
persistent structure
```

as appropriate.

This principle extends to:

```text
Vector
Struct updates
String building
collection pipelines
```

The source language stays immutable and compositional while generated Rust uses mutation where ownership proves it observationally equivalent.

---

# 14. Ownership and borrowing are inferred

> **Later update:** Start with the [conservative ownership rules](implementation-milestones.md#17-initial-ownership-implementation); the [structured concurrency ownership pass](implementation-milestones.md#33-structured-concurrency-ownership-pass) comes later. The full inference described here is not a prerequisite for the first evaluator.

This is another central part of the design.

Users should **not** normally write Rust-like:

```text
&T
&mut T
Arc<T>
Rc<T>
Box<T>
```

The semantic IR contains:

```text
Value<User>
```

and an ownership analysis pass decides whether a particular use becomes:

```text
User
&User
&mut User
Arc<User>
Clone<User>
```

The preferred order is:

```text
move
  ↓
borrow
  ↓
shared ownership
  ↓
clone only when genuinely necessary
```

Not “clone everything unless it is a Ref.”

Knowing a native type does not make cloning its owned heap payload cheap.

Moving `String`, `Vec<T>` or `HashMap<K,V>` is usually dramatically cheaper than cloning their contents.

---

# 15. Operations carry access requirements

An intrinsic can declare what kind of access it needs.

For example:

```text
Vector.length
    Borrow<Vector<T>>

Vector.push
    BorrowMut<Vector<T>>
    Owned<T>

consumeSomething
    Owned<T>
```

Then access requirements propagate upward through the IR.

A compiled function semantically declared as:

```text
Vector<User> → U64
```

might actually generate:

```rust
fn count(users: &[User]) -> u64
```

because it only reads.

Another might generate:

```rust
fn clear(users: &mut Vec<User>)
```

because exclusive mutation is required.

The TypeScript author never writes a lifetime.

---

# 16. Structured concurrency gives us lifetime information

This is unusually powerful.

Consider:

```ts
C.Effect.all([A(config), B(config)]);
```

Both children are guaranteed to finish before the parent continues.

Therefore they may be able to borrow:

```rust
&config
```

rather than use:

```rust
Arc<Config>
```

But a detached fiber that can outlive its parent cannot safely borrow parent-owned data.

It requires:

```text
move ownership
or
Arc
```

So Effect's structured-concurrency graph naturally supplies information to Rust lifetime analysis.

This could let us infer a substantial amount of Rust borrowing automatically.

---

# 17. Effect Ref is not a Rust borrow

This distinction should remain strict.

Effect `Ref<A>` means explicitly shared mutable state; Effect documents it as a way to safely share state between parts of an Effect program.

It should not mean:

```rust
&A
```

or:

```rust
&mut A
```

Those are inferred ownership relationships for ordinary values.

Instead:

```text
ordinary value
    compiler chooses move / borrow / borrow-mut

MutableRef<T>
    mutable identity

Ref<T>
    concurrency-safe mutable identity

SynchronizedRef<T>
    effectful serialized mutation

SubscriptionRef<T>
    mutable state + change subscription
```

---

# 18. Ref specialization

> **Later update:** The [later specialization guidance](runtime-lowering.md#ref-specialization) conditions atomic/lock/local-state selection on operations, escape analysis, and observable behavior; a type alone does not justify a representation.

Because the compiler knows the exact type and all operations, `Ref` can be specialized.

For example:

```ts
C.Ref.make(C.U64, 0);
```

used only with:

```ts
get;
increment;
add;
compareAndSet;
```

can become:

```rust
AtomicU64
```

A structured:

```ts
C.Ref.make(AppState, initial);
```

can become:

```rust
Mutex<AppState>
```

or eventually `RwLock<AppState>` if read-heavy access justifies it.

A synchronous update should use a synchronous lock. Tokio explicitly notes that ordinary mutexes are often preferable when the lock does not need to survive an `.await`; its async Mutex is specifically useful when the guard must live across await points.

An effectful `SynchronizedRef` operation that can suspend maps more naturally to an async lock.

So the lowering ladder could eventually be:

```text
unique mutable state
    → let mut T

single-thread primitive
    → Cell<T>

single-thread structured
    → RefCell<T>

cross-thread primitive
    → Atomic*

cross-thread structured
    → Mutex<T> / RwLock<T>

effectful mutation across await
    → async Mutex<T>
```

---

# 19. SubscriptionRef, Queue, PubSub and Deferred already have strong Rust substrates

> **Later update:** The [candidate catalogue](runtime-lowering.md#candidate-mapping-catalogue) and [semantic runtime boundary](runtime-lowering.md#what-remains-in-the-semantic-runtime) qualify these mappings: shutdown, queue strategies, scoped subscriptions, and completion semantics still require verification/adapters.

Tokio supplies most of the mechanical concurrency infrastructure.

`watch` retains the current value and notifies consumers when it changes, making it a natural substrate for SubscriptionRef-like semantics.

Tokio supplies bounded and unbounded `mpsc`, `broadcast`, `oneshot`, Mutex/RwLock, Semaphore and notification primitives.

Effect still has semantics that must be preserved—for example Queue shutdown interrupts suspended takers/offers, and PubSub has dropping/sliding policies—so these should be wrappers/adapters rather than naive aliases. Effect's Queue shutdown and PubSub policies are observable semantics.

Likely mappings:

```text
Semaphore
    → Tokio Semaphore + Effect adapter

Queue
    → mpsc/custom queue + shutdown/policy adapter

PubSub
    → broadcast/custom ring + policy adapter

SubscriptionRef
    → watch + state wrapper

Deferred
    → shared completion cell + Notify/watch

Ref
    → Atomic / Mutex / RwLock specialization
```

---

# 20. Services

> **Later update:** Service selection is now part of [three implementation registry families](runtime-lowering.md#three-implementation-registries), alongside operations and semantic runtime entries. Crate/feature candidates are proposals, not established support.

A compiled service must carry actual method representations.

Plain TypeScript:

```ts
find(id: UserId): Effect<User, Error>
```

does not tell the backend whether `UserId` is a `u64`, UUID bytes or string after TS erasure.

So service declarations should be Schema/compiled-type described.

Conceptually:

```ts
const Users = C.Service.make("Users", {
  find: C.Method({
    args: [UserId],
    success: User,
    error: UserNotFound,
  }),

  list: C.Method({
    args: [],
    success: C.Vector(User),
    error: DatabaseError,
  }),
});
```

This declaration should also create or contain an Effect-compatible Context service key for the JS interpreter.

Effect itself treats services as globally identified keys stored in Context, conceptually a service-key→service map.

Native compilation can usually erase the lookup.

For example:

```ts
Users.find(id);
```

builds:

```text
ServiceCall {
  service: Users
  method: find
  arguments: [id]
}
```

and carries requirement:

```text
R = Users
```

Generated Rust might simply be:

```rust
users.find(id).await
```

---

# 21. Layers

> **Later update:** The [later wiring design](runtime-lowering.md#service-and-layer-wiring) explains static constructors/fields while retaining Layer identity, sharing/freshness, acquisition failure, and finalizer semantics.

Layers require first-class compiler treatment.

They are not merely dependency injection constructors.

A compiled Layer needs to describe:

```text
provides
requires
error
acquisition
release
sharing identity
scope/lifetime
```

Effect Layers model dependency construction, and Effect also has observable memoization semantics: globally shared Layer instances are memoized while `Layer.fresh` deliberately requests independent instances.

Therefore the compiler should have a Layer graph IR.

For example:

```text
ConfigLive
    ↓
DatabaseLive
    ↓
UsersLive
    ↓
ApiLive
```

can compile into startup construction:

```rust
let config = ConfigLive::new();
let database = DatabaseLive::new(&config).await?;
let users = UsersLive::new(&database);
let api = ApiLive::new(&users);
```

If two services share the same Layer node, construct it once.

If it is marked fresh, construct separate instances.

Most Layer machinery then disappears at runtime.

---

# 22. Effect itself

A compiled effect still conceptually carries:

```text
success type A
error type E
requirements R
```

but internally we should add capability information:

```text
Pure
Async
Scoped
Interruptible
Concurrent
UsesFiberLocal
MayDefect
ObservesCause
```

This lets the compiler specialize aggressively.

For example:

```text
Effect<A, never, never>
pure
```

might become:

```rust
fn() -> A
```

A normal fallible async effect might become:

```rust
async fn() -> Result<A, E>
```

Only code that actually observes full Effect failures/interruption may need:

```rust
Exit<A,E>
Cause<E>
```

at runtime.

Therefore:

> **Do not represent every native Effect as an Effect object or interpreter node at runtime.**

Compile the abstraction away.

---

# 23. No `yield*`

The compiled language should use composition:

```ts
pipe(
  Users.find(id),

  C.Effect.flatMap(user =>
    ...
  )
)
```

rather than generators:

```ts
yield*
```

That keeps the program explicitly data/composition driven.

Convenience APIs can eventually make this less verbose, but the semantic IR remains the same.

---

# 24. Fibers

Fibers are where this design initially sounds difficult, but Rust already provides most of the execution machinery.

Effect fibers are running effect computations with identity, lifecycle, interruption and local state.

We should **not write our own scheduler**.

Tokio supplies tasks, scheduling, timers, async I/O and synchronization.

A native Effect Fiber might conceptually be:

```rust
struct Fiber<A, E> {
    task: JoinHandle<Exit<A, E>>,
    cancellation: CancellationToken,
    scope: Scope,
    context: FiberContext,
}
```

But even this object only needs to exist when Fiber semantics are actually observable.

Sequential:

```ts
Users.find(id).pipe(
  C.Effect.flatMap(...)
)
```

can just generate ordinary sequential `async` Rust.

---

# 25. Structured fiber groups

For concurrent collections of children, Tokio `JoinSet` already provides task-group-like mechanics for spawned tasks.

Our runtime adds Effect semantics:

```text
parent
   │
   ├── child A
   ├── child B
   └── child C
```

with rules such as:

```text
parent interruption
      ↓
cancel children
      ↓
children run finalizers
      ↓
await child termination
      ↓
close parent scope
```

Tokio executes tasks.

Effect Native defines their relationships.

---

# 26. Fiber cancellation

`CancellationToken` from tokio-util already supports a parent→child cancellation tree: cancelling a parent cancels derived child tokens without child cancellation propagating upward.

That maps extremely naturally onto supervised Effect fibers.

And because our compiler owns every async operation, it knows every suspension point.

Something like:

```text
DatabaseQuery
```

can lower approximately to:

```rust
tokio::select! {
    result = query => result,
    _ = fiber.cancel.cancelled() => interrupted(),
}
```

The exact implementation can be optimized, but the important fact is that cancellation observation is under compiler control.

---

# 27. No arbitrary loops improves fibers

Because users can't hide:

```rust
loop { ... }
```

inside opaque compiled code, every generated loop comes from:

```text
Vector.map
Vector.reduce
Effect.repeat
Effect.forEach
Stream processing
```

The compiler may insert:

```text
cancellation check
cooperative yield
```

at appropriate points.

This makes reliable cooperative interruption substantially easier than when compiling unrestricted source code.

---

# 28. `uninterruptible`

An IR node can explicitly mark:

```text
Uninterruptible(subtree)
```

The backend simply masks cancellation observation inside that region and observes pending cancellation once the region ends.

This maps well to Effect's resource semantics: `acquireRelease` treats acquisition as uninterruptible and guarantees release after successful acquisition.

---

# 29. Scope

Rust RAII handles a great deal of synchronous cleanup, but Effect finalizers may themselves be asynchronous.

Therefore the native runtime genuinely needs:

```rust
Scope
AsyncFinalizer
```

conceptually:

```text
Scope
  resources
  child fibers
  finalizers
  Exit state
```

with:

```text
scope.close(exit)
```

running finalizers according to Effect semantics.

This is one of the pieces we really do need to implement.

But it is far smaller than implementing Effect's entire interpreter.

---

# 30. FiberRef

Fiber-local state can be compiled much more efficiently than a completely dynamic map.

Because the whole application is known, something like:

```text
FiberContext {
  traceContext
  logAnnotations
  requestId
  currentUser
}
```

can be generated directly for the FiberRefs actually used.

Forking copies/inherits according to each FiberRef's semantics.

Joining applies its join semantics where required.

If no FiberRefs are reachable, no FiberContext needs to exist at all.

---

# 31. Concurrency combinators

`Effect.all` can lower to different Rust strategies based on shape.

Fixed static arity:

```text
All(A,B,C)
```

might become a `join!`-style operation.

Dynamic collections:

```text
forEach(vector, f, concurrency = N)
```

can use task sets/semaphores.

Race can use select-style execution.

The semantic layer must preserve:

```text
sibling failure/interruption behavior
scope ownership
finalizer completion
error/Cause semantics
```

rather than merely spawning arbitrary Tokio tasks.

---

# 32. HTTP is an ideal first major platform backend

> **Later update:** The [revised sequence](implementation-milestones.md#15-milestone-1--foldkit-entity-exprquery-as-the-first-real-compiler-target) puts Foldkit Query conformance first; [unary RPC](implementation-milestones.md#18-milestone-3--unary-effect-rpc) remains the first major public demo.

Effect's current `HttpApi` is explicitly **data**: it describes groups, endpoints, inputs, outputs, middleware and route metadata, and the same description is used for server builders, generated clients and OpenAPI.

That is exactly the sort of input an AOT compiler wants.

We should therefore reuse or adapt actual Effect `HttpApi` descriptions wherever feasible rather than invent another route-definition language.

Conceptually:

```ts
const Api = /* Effect HttpApi */

export default C.application({
  api: C.Http.handlers(Api, {
    getUser: GetUser,
    createUser: CreateUser
  }),

  layer: AppLive
})
```

---

# 33. Native HTTP stack

A good first backend is:

```text
Effect HttpApi
      ↓
compiled route graph
      ↓
Axum router
      ↓
Tower middleware
      ↓
Hyper
      ↓
Tokio
```

This fits remarkably well.

Tower's core `Service` abstraction is essentially an asynchronous request→response function, while Tower `Layer` composes middleware around services.

Axum is built directly on Tokio/Hyper/Tower and uses Tower middleware instead of inventing its own.

So Effect middleware can often compile into:

```text
Tower Service / Layer composition
```

rather than a custom middleware runtime.

---

# 34. Request-scoped services

Effect HttpApi middleware can provide typed services such as authentication results, authorization information or request-specific state.

Native code can map these to:

```text
request context
Axum extensions
generated request struct
task/fiber-local context
```

Global Layer services become application state.

Axum already supports typed application state for things like configuration and database pools.

So Effect Context lookups can often disappear entirely.

---

# 35. HTTP streaming

Hyper uses streaming request and response bodies and naturally applies connection-level backpressure by polling the body as data is needed.

Therefore:

```ts
C.Http.stream(stream);
```

can potentially become:

```text
generated Rust Stream
     ↓
Hyper Body
     ↓
network socket
```

without intermediate JS streams.

Effect itself has special scope handling for streamed responses, so the compiler must likewise keep the request scope alive until the body completes or is abandoned.

---

# 36. SQL

The native SQL backend should target an established Rust database library rather than implement drivers.

SQLx is attractive because rows can map directly into Rust types through `FromRow`/`query_as`.

So:

```ts
C.Sql.queryOne({
  query: "...",
  params: [UserId],
  row: User,
});
```

can become conceptually:

```rust
sqlx::query_as::<_, User>(...)
    .bind(id)
    .fetch_one(&db)
    .await
```

Compiled Schema already knows the Rust `User` representation.

Transactions and scoped connections naturally integrate with Scope.

Effect's own current SQL abstraction likewise exposes scoped connection acquisition, reinforcing that lifecycle is part of the semantics we need to preserve.

---

# 37. Serialization

Schema should generate:

```text
Rust types
JSON codecs
validation
OpenAPI schemas
RPC codecs
SQL row mappings
```

without declaring the model repeatedly.

Serde is an excellent native serialization substrate because it derives static `Serialize`/`Deserialize` implementations rather than requiring runtime reflection.

However:

```text
semantic type
native memory representation
JSON representation
SQL representation
binary representation
```

should remain conceptually separate.

A `UserId` could eventually be:

```text
memory: u64
JSON: decimal string
SQL: BIGINT
binary: varint
```

The CType contains semantics plus native representation; boundary codecs can provide alternate external representations.

---

# 38. Streams

General Effect Stream/Channel support should come after HTTP.

The likely native substrate is Rust's asynchronous Stream/Sink ecosystem, but full Effect Stream semantics include:

```text
typed failure
scope
resource ownership
backpressure
channels
sinks
```

We should first support the streaming primitives needed by HTTP/SQL rather than trying to recreate the full Channel system immediately.

---

# 39. Rc / Arc / Box are backend choices

Users generally should not write:

```text
Rc<T>
Arc<T>
Box<T>
```

in ordinary compiled application logic.

For immutable `config`:

```ts
C.Effect.all([A(config), B(config)]);
```

the compiler might generate simple borrows if the operations remain structured:

```rust
a(&config)
b(&config)
```

If a value escapes into independently owned tasks, it may become:

```rust
Arc<Config>
```

If recursive storage requires indirection, a generated type may contain:

```rust
Box<T>
```

Those are ownership-lowering decisions.

---

# 40. RcRef / RcMap are different

Effect's `RcRef` / `RcMap` are semantic constructs dealing with reference-counted **resource lifetime**, not merely Rust memory ownership.

They should therefore remain visible Effect-level concepts.

A native implementation may internally use:

```text
Arc
lease count
resource table
Scope
async finalizer
```

but the compiler must preserve the resource lifecycle semantics rather than equating `RcRef` with Rust `Rc`.

---

# 41. Application root

There should be an explicit compilation root.

Something like:

```ts
export default C.application({
  layer: AppLive,
  api: ApiHandlers,
});
```

The compiler traverses only things reachable from that root.

That lets it perform:

```text
dead-code elimination
service graph analysis
Layer planning
capability analysis
ownership analysis
native dependency selection
```

and avoids compiling unused parts of the module.

---

# 42. Build pipeline

> **Later update:** Use the expanded [compilation passes](compiler-design-revision.md#10-compilation-passes), including derive/plan/verify and evidence-gated optimization, in place of treating the shorter pipeline below as the complete stage list.

The actual build might be:

```text
1. load TS application module

2. execute declarations/builders

3. obtain typed Effect Native IR

4. validate IR

5. resolve Layers and services

6. run semantic optimization

7. perform ownership/lifetime analysis

8. lower platform operations

9. emit Rust crate

10. cargo build
```

The TypeScript compiler is still used for normal type checking.

But the semantic compiler does not initially need to parse arbitrary TS function bodies to understand their meaning.

---

# 43. TypeScript types versus Oxlint versus compiler

All three have different responsibilities.

### TypeScript

Types can enforce:

```text
correct CType arguments
effect success/error/environment
service requirements
Map key capabilities
Match exhaustiveness
Layer requirements
function signatures
```

### Oxlint / Effect language tooling

Syntax tooling catches things TypeScript cannot express.

Inside `C.fn`, reject:

```text
if
switch
for
while
await
yield
throw
try/catch
unknown function calls
mutating ordinary JS operations
```

For example:

```text
Compiled functions cannot use JavaScript `if`.
Use C.Match.
```

This source inspection is for diagnostics, not program compilation.

### IR validator

The IR validator is the actual authority.

It verifies:

```text
every operation is known
every CType has a native representation
every Schema operation is portable
every service method resolves
every Layer graph is valid
every backend operation exists
every Match is complete
```

Even `as any` cannot invent a Rust operation that doesn't exist in the IR.

---

# 44. Effect tooling integration

> **Later update:** The [migration editor design](migration-tooling.md#editor-tooling) adds a shared diagnostic/fix workflow. Integration with upstream language tooling remains research, not an established plugin contract.

Long term, integrating with Effect's own language tooling would be ideal.

Useful editor information could include:

```text
Compiled Function

(UserId)
→ Effect<User, NotFound, Users>

native:
async fn get_user(
  users: &impl Users,
  id: u64
) -> Result<User, NotFound>
```

Quick fixes could convert unsupported control flow into Match or identify a nonportable Schema transform.

Oxlint is suitable for cheap syntax-level constraints; type-aware Effect/tsgo tooling would handle deeper diagnostics.

---

# 45. Operation registry

> **Later update:** The [revised operation model](compiler-design-revision.md#6-operations-become-first-class-semantic-definitions) adds typed laws and checked traits; [runtime registry families](runtime-lowering.md#three-implementation-registries) distinguish operation implementations from service and semantic runtime implementations.

Supporting a large surface should be declarative.

Each supported operation can have metadata resembling:

```text
Operation:
  id
  input types
  output type
  effect capabilities
  access modes
  JS interpreter
  Rust lowering
```

For example:

```text
U64.add
  inputs: Borrow<U64>, Borrow<U64>
  output: U64
  Rust: +

Effect.sleep
  input: Duration
  output: Effect<Unit>
  capability: Async
  JS: Effect.sleep
  Rust: tokio timer

Ref.increment
  input: Ref<U64>
  Rust specialization:
    AtomicU64::fetch_add
```

From this registry we could generate portions of:

```text
TS APIs
IR types
validator tables
JS interpreter bindings
Rust lowering tables
docs
LSP metadata
```

This is how the supported Effect surface can eventually become large without becoming unmaintainable.

---

# 46. JavaScript widening later

> **Later update:** The [migration transformation layers](migration-tooling.md#three-transformation-layers) help users reach the supported IR subset. Migration tooling does not bring arbitrary TypeScript parsing forward from [milestone 15](implementation-milestones.md#39-milestone-15--source-syntax-widening).

The initial language is intentionally narrow because that gives us a clean, provable backend.

But the IR does **not** lock the source syntax permanently.

Later, a source-transform stage can recognize ordinary TypeScript:

```ts
age >= 18;
```

and lower it into the same:

```text
GreaterThanOrEqual(age, 18)
```

Ordinary:

```ts
if (...)
```

can become Match/branch IR.

Ordinary:

```ts
await operation();
```

can become Effect sequencing.

Ordinary:

```ts
Promise.all(...)
```

can become concurrent Effect IR.

None of this requires changing the Rust backend.

It only adds additional syntax producers for the same IR.

---

# 47. Ordinary strings, objects and Promises remain ordinary source constructs

There should not be a:

```text
Js.String
Js.Object
Js.Promise
```

user-facing universe.

This is already TypeScript.

Eventually the compiler may classify values internally as:

```text
native
host-JS
foreign
```

but the programmer still writes:

```ts
string;
Promise<User>;
User;
```

A hybrid Node/native backend could use N-API/Neon/napi-rs underneath when a normal JS/npm function genuinely must stay in JavaScript.

That is purely a backend concern.

---

# 48. Native and hybrid targets

Eventually the compiler can expose target compatibility.

A fully portable application:

```text
RequiresNative       yes
RequiresTokio        yes
RequiresHTTP         yes
RequiresSQL          yes
RequiresJsHost       no
```

can become a standalone binary.

An application using an npm-only operation might become:

```text
RequiresJsHost       yes
```

and compile as a Node/native hybrid.

The same CType source types remain visible to the programmer.

---

# 49. What actually lives in the Rust runtime

> **Later update:** The [later runtime boundary](runtime-lowering.md#what-remains-in-the-semantic-runtime) narrows custom machinery further: generate code first, reuse a substrate with semantic adapters next, and retain dedicated runtime only where observable behavior requires it.

The native Effect runtime should remain deliberately small.

Things we should **not** implement because the ecosystem already does:

```text
scheduler
thread pool
async I/O
timers
basic task execution
basic channels
HTTP protocol
routing machinery
serialization
database drivers
```

Things we **do** need Effect-specific semantics for:

```text
Scope
async finalizers

Fiber supervision
Effect interruption/cancellation
FiberRef inheritance/join behavior

Exit/Cause when observable

exact Queue/PubSub/Deferred semantics

resource lifecycle primitives such as RcRef/RcMap
```

Tokio already supplies a rich set of async synchronization primitives including Mutex, RwLock, Semaphore, mpsc, broadcast, oneshot and watch.

So the native runtime is **semantic glue**, not another asynchronous runtime.

---

# 50. The important optimization principle

Every abstraction should have the opportunity to disappear.

```text
Effect.map
    → normal Rust expression

Effect.flatMap
    → sequential statements / await

Context service lookup
    → direct parameter / struct field

Layer
    → startup construction

Schema.Struct
    → Rust struct

Option
    → Rust Option

Result
    → Rust Result

HashMap pipeline
    → fused Rust mutation/iteration

Ref<U64>
    → AtomicU64

structured child task
    → borrowed parent value

shared escaped immutable value
    → Arc<T>
```

Only semantics that cannot be eliminated survive into the native runtime.

---

# 51. A complete example

Conceptually, source could eventually look roughly like:

```ts
const UserId = C.U64;

const User = C.Struct({
  id: UserId,
  name: C.String,
});

const NotFound = C.TaggedError("NotFound", {
  id: UserId,
});

const Users = C.Service.make("Users", {
  find: C.Method({
    args: [UserId],
    success: C.Option(User),
    error: DatabaseError,
  }),
});

const GetUser = C.fn(
  {
    args: [UserId],
    success: User,
    error: NotFound,
    requires: Users,
  },

  (id) =>
    Users.find(id).pipe(
      C.Effect.flatMap((maybeUser) =>
        C.Match.value(maybeUser).pipe(
          C.Match.some((user) => C.Effect.succeed(user)),

          C.Match.none(() => C.Effect.fail(NotFound.make({ id }))),

          C.Match.exhaustive,
        ),
      ),
    ),
);
```

IR:

```text
Function GetUser(UserId) -> Effect<User,NotFound,Users>

  ServiceCall Users.find(Local 0)

  FlatMap result

    Match result

      Some(user)
        Succeed(user)

      None
        Fail(NotFound {
          id: Local 0
        })
```

After service resolution, generated Rust might be little more than:

```rust
async fn get_user<U: Users>(
    users: &U,
    id: u64,
) -> Result<User, NotFound> {
    match users.find(id).await {
        Ok(Some(user)) => Ok(user),
        Ok(None) => Err(NotFound { id }),
        Err(error) => {
            // determined from the enclosing error policy
            todo!()
        }
    }
}
```

The Effect representation itself is gone.

---

# 52. Implementation milestones

> **Later update:** The ordering below is historical. Follow the [detailed milestones 0–15](implementation-milestones.md#14-milestone-0--bootstrap-the-semantic-kernel) and [current roadmap](../PLAN.md#implementation-sequence), which introduce the kernel and Query conformance before general functions/RPC.

**Milestone 0 — IR kernel:** implement CType, Expr, Predicate, Match, Fn, Effect and stable IR serialization. Support integer/floating primitives, Bool, String, Bytes, Struct, Enum, Tuple, fixed Array, Vector, Option and Result.

**Milestone 1 — JS reference interpreter:** interpret the IR into actual Effect programs. Build differential/property tests before writing serious Rust.

**Milestone 2 — pure Rust compiler:** generate Rust for pure functions, Match, predicates, collections, Strings and structs. Implement ownership/move/borrow analysis.

**Milestone 3 — Effect basics:** async Effects, typed failure, Services, Layers, Scope, sleep/timeouts/retry. Produce real command-line applications.

**Milestone 4 — native concurrency:** fibers, cancellation, `Effect.all`, race, Semaphore, Ref, Deferred, Queue, PubSub, FiberRef. Tokio provides execution; Effect Native provides semantics.

**Milestone 5 — server platform:** Effect HttpApi → Axum/Tower/Hyper, Schema → Serde, SQL → SQLx. At this point the project becomes practically useful for native TypeScript server applications.

**Milestone 6 — streaming and resources:** HTTP streaming, general Stream subset, RcRef/RcMap, pools, persistent queues, more platform services.

**Milestone 7 — wider Effect coverage:** Cache, RequestResolver/batching, workers, sockets, RPC, persistence, increasingly rich Layer/runtime behavior.

**Milestone 8 — syntax widening:** optional source transform allowing ordinary operators, `if`, `await`, Promise combinators and other normal TypeScript syntax to lower into the exact same IR.

**Milestone 9 — hybrid JS target:** ordinary JavaScript/npm operations can remain hosted in Node while the rest of the graph compiles to Rust; N-API/Neon/napi-rs are implementation details rather than source-level concepts.

---

# Final shape

The project is best thought of as:

```text
                   EFFECT NATIVE

      TypeScript is the authoring language
                       │
                       ▼
          Effect-shaped typed program IR
                       │
           ┌───────────┴───────────┐
           ▼                       ▼
     Effect interpreter       Rust compiler
           │                       │
           ▼                       ▼
    official JS runtime       optimized native
                                  program

                                  │
             ┌────────────────────┼────────────────────┐
             ▼                    ▼                    ▼
           Tokio               Tower                SQLx
         concurrency         Axum/Hyper             etc.
```

Its most important design rules are:

1. **Do not compile arbitrary TypeScript initially.**
2. **Do not fork Effect.**
3. **Everything in compiled runtime code has a known CType/native representation.**
4. **Effect Schema supplies semantic data descriptions.**
5. **Match is the initial universal control-flow construct.**
6. **Predicates and operations are IR, not arbitrary callbacks.**
7. **Iteration is structured rather than user-written loops.**
8. **Values have semantic ownership; Rust borrowing/moves/Arc are inferred.**
9. **Effect Ref means mutable state, not Rust borrowing.**
10. **Compile Context, Layers and Effect composition away whenever possible.**
11. **Use Tokio/Hyper/Tower/Axum/Serde/SQLx rather than rebuilding what Rust already has.**
12. **Keep only Effect-specific lifetime, cancellation, Fiber and resource semantics in the native runtime.**
13. **Keep the IR stable while making the source syntax progressively more TypeScript-like over time.**
14. **Eventually allow ordinary JS strings, objects, Promises and npm code in hybrid builds without creating a parallel `Js.*` user-facing language.**

The deepest advantage is that Effect's explicit structure gives the compiler information a normal TypeScript→Rust compiler would struggle to recover: **types, effects, dependencies, scopes, structured concurrency, resource lifetimes, error channels and high-level collection operations are already explicit.**

Rust then gives the backend something Effect's JavaScript runtime cannot globally exploit in the same way: ownership, borrowing, moves, atomics, native structs/enums, zero-cost generics, native async tasks and specialized synchronization.

So the eventual proposition is not merely:

> “Write TypeScript and get Rust.”

It is closer to:

> **Write high-level Effect programs with immutable, typed semantics; let the compiler derive the low-level ownership, concurrency, resource and memory implementation that an expert Rust programmer might otherwise have had to write manually.**

That is the version of the idea I would build.
