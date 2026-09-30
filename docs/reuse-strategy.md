# Reuse and adaptation strategy

[Roadmap](../PLAN.md) · [Documentation index](README.md) · [Revision overview](op-expr-revision-convo.md)

[Migration tooling](migration-tooling.md) extends the reuse approach to AST/workflow execution: investigate Codemod as an external engine and reuse verified Effect editor tooling hooks, while retaining compiler compatibility analysis and conformance in this project. See its [research record](research/migration-tooling.md) for current sources and limits.

See [runtime lowering](runtime-lowering.md) for the later candidate Rust-substrate catalogue and the distinction between operation implementations, service implementations, and semantic adapters. Prefer eliminating abstractions or adapting verified execution machinery; crate availability alone does not establish parity with Effect.

This document preserves part of the later design conversation. Read the revision overview for how it updates earlier proposals. Examples and upstream API, repository, and licensing claims are historical design material, not verified current facts or implemented guarantees.

## Contents

- [What I would reuse](#what-i-would-reuse)
- [1. Gen2's representation code can almost become the starting point](#1-gen2s-representation-code-can-almost-become-the-starting-point)
- [2. Gen2's `Operation` should be adapted, not rewritten](#2-gen2s-operation-should-be-adapted-not-rewritten)
- [3. Gen2's traits are almost directly reusable](#3-gen2s-traits-are-almost-directly-reusable)
- [4. Gen2's pass system can seed the compiler driver](#4-gen2s-pass-system-can-seed-the-compiler-driver)
- [Foldkit-Plus is even more reusable in some areas](#foldkit-plus-is-even-more-reusable-in-some-areas)
- [5. Reuse Foldkit-Plus's dependency analysis](#5-reuse-foldkit-pluss-dependency-analysis)
- [6. Most importantly: reuse Foldkit-Plus's conformance tests](#6-most-importantly-reuse-foldkit-pluss-conformance-tests)
- [7. `remote-server` semantics should be ported, not redesigned](#7-remote-server-semantics-should-be-ported-not-redesigned)
- [8. Remote protocol code can be shared directly at compile time](#8-remote-protocol-code-can-be-shared-directly-at-compile-time)
- [9. `remote-drizzle` should mostly supply metadata](#9-remote-drizzle-should-mostly-supply-metadata)
- [10. Effect itself should be reused much more than copied](#10-effect-itself-should-be-reused-much-more-than-copied)
- [11. Effect should become the reference interpreter](#11-effect-should-become-the-reference-interpreter)
- [12. But some Effect algorithms may be worth porting](#12-but-some-effect-algorithms-may-be-worth-porting)
- [13. Foldkit itself should be a dependency/contract](#13-foldkit-itself-should-be-a-dependencycontract)
- [I think there is a shared package hiding in all this](#i-think-there-is-a-shared-package-hiding-in-all-this)
- [For v0, copy/adapt intentionally](#for-v0-copyadapt-intentionally)
- [There are also pieces I would explicitly _not_ reuse](#there-are-also-pieces-i-would-explicitly-not-reuse)
- [Licensing](#licensing)

---

Yes. I think we can reuse a **surprisingly large amount**, but we should be selective about _how_ we reuse it.

The clean model is:

```text
                     ┌─────────────────────┐
                     │  shared semantic IR │
                     │       kernel        │
                     └──────────┬──────────┘
                                │
          ┌─────────────────────┼──────────────────────┐
          ▼                     ▼                      ▼
       gen2              effect-native          foldkit-plus
 domain compiler        native compiler         domain/remote/UI
```

I would **not** make `effect-native` depend wholesale on Gen2 or Foldkit-Plus. Instead, reuse/extract the small primitives that genuinely belong underneath all three.

### What I would reuse

| Source             | Reuse strategy                               | Good candidates                                                                                             |
| ------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Gen2**           | Extract/adapt heavily                        | representations, operations, laws, capabilities, traits, runtime/target model, diagnostics, compiler passes |
| **Foldkit-Plus**   | Import existing semantic IR where possible   | Entity `Expr`, Query, dependency analysis, conformance tests, Remote protocol/requirements                  |
| **Effect**         | Depend on public APIs, avoid copying runtime | Schema/Schema AST, Effect/Layer/Context concepts, RPC/HTTP declarations, Stream/Schedule/etc.               |
| **Foldkit**        | Depend/adapt public contracts                | app/view/SSR/hydration contracts, routing                                                                   |
| **Rust ecosystem** | Direct dependency                            | Tokio, Hyper/Axum/Tower, Serde, SQLx                                                                        |

There are some especially obvious wins.

## 1. Gen2's representation code can almost become the starting point

`doeixd/gen2/src/types/representation.ts` already has:

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
endianness
text encoding
fixed/dynamic
comparison semantics
aggregate semantics
```

That's extremely close to the native representation layer we've designed.

I would take that code and evolve it:

```ts
Representation;
```

into probably:

```ts
NativeRepresentation;
WireRepresentation;
StorageRepresentation;
```

while keeping a shared underlying representation vocabulary.

So:

```ts
const UserId = CType.make({
  schema: UserIdSchema,

  native: Repr.u64(),

  wire: Repr.text({
    encoding: "utf8",
  }),

  storage: Sql.bigint(),
});
```

That's not a hypothetical greenfield design anymore. Gen2 already gives us the skeleton.

---

## 2. Gen2's `Operation` should be adapted, not rewritten

`src/types/operation.ts` already contains the exact conceptual split we want:

```ts
Operation;
Capability;
Law;
Effect;
Implementation;
Runtime;
```

including runtime-specific implementations.

I'd fork that into the new kernel and improve the type relationships.

Current Gen2:

```ts
interface Law {
  kind: LawKind;
  assurance: "claim" | "tested" | "proven";
}
```

Effect Native:

```ts
Law.Associative<typeof Add>;
Law.Identity<typeof Add, typeof Zero>;
Law.RoundTrip<typeof Encode, typeof Decode>;
```

So we'd reuse the machinery but strengthen the typing.

Likewise this:

```ts
interface Implementation {
  runtime: string;
  body: ImplementationBody;
}
```

naturally becomes something richer like:

```ts
Operation.withImplementation(
  Rust,
  Rust.intrinsic(...)
)

Operation.withImplementation(
  Reference,
  Effect.fn(...)
)
```

There is no reason to reinvent that model.

---

## 3. Gen2's traits are almost directly reusable

`src/kernel/trait.ts` already provides:

```ts
TraitDef
defineTrait
implies
conflictsWith
target
typed payload
```

That's a very good foundation for:

```text
Eq
Hash
Ord
Copyable
Cloneable
Shareable
ThreadSafe
AtomicCompatible
SQLComparable
BinarySerializable
```

and compiler semantic traits such as:

```text
Pure
Deterministic
ParallelSafe
RetrySafe
RollbackSafe
```

I'd probably pull this into the shared kernel nearly intact and improve the transitive implication/checking machinery.

---

## 4. Gen2's pass system can seed the compiler driver

Current Gen2 already has:

```text
check
derive
lower
emit
```

with:

```ts
PassResult;
PassDiagnostic;
KernelArtifact;
PassRegistry;
```

`doeixd/gen2/src/kernel/pass.ts`

That's a useful chunk of real code.

Effect Native could extend it to:

```text
check
derive
normalize
plan
verify
optimize
ownership
lower
emit
build
```

and drive it from the Effect API:

```ts
const compiler = Compile.make("server", {
  target: Rust.native(),
}).pipe(Compile.withProgram(program));

yield * Compile.run(compiler);
```

Internally `Compile.run` executes that pass graph.

Again, not greenfield.

---

# Foldkit-Plus is even more reusable in some areas

I would **not copy** its Entity expressions into a second expression implementation.

Where possible, support them directly.

Current:

```ts
Expr.eq(...)
Expr.contains(...)
Query.where(...)
Query.orderBy(...)
```

already produces static semantic IR.

So the native compiler can have an adapter:

```ts
Compile.fromFoldkitQuery(query);
```

or register the IR as a supported foreign node family.

Conceptually:

```text
foldkit-entity Expr
        │
        ▼
Native.Import.expr(...)
        │
        ▼
canonical effect-native Expr
```

Or perhaps it doesn't even require conversion until lowering.

That means Foldkit-Plus stays the source of truth for its own semantics.

---

## 5. Reuse Foldkit-Plus's dependency analysis

The current Entity `Expr` already computes:

```text
fields
inputs
operations
```

and supports the idea that an interpreter refuses unsupported operations.

That's essentially a compiler analysis pass already.

We should either reuse that code directly or generalize it into a shared visitor:

```ts
Dependencies.of(expr);
```

Effect Native adds:

```text
operations
services
effects
capabilities
types
schemas
refs
scopes
fibers
```

This is an obvious extraction target.

---

# 6. Most importantly: reuse Foldkit-Plus's conformance tests

This might save more effort than any code reuse.

You already have tests establishing the semantics of:

```text
Eq
contains
NULL
ordering
queries
Remote behavior
normalization
nested relationships
etc.
```

The native backend should run the same fixtures:

```text
                 test fixture
                     │
          ┌──────────┼───────────┐
          ▼          ▼           ▼
      JS evaluator  Drizzle    Rust/SQLx
          │          │           │
          └──────── same ─────────┘
```

That's fantastic because it turns existing work into a compiler specification.

I would make cross-backend conformance one of Effect Native's foundational testing mechanisms.

---

# 7. `remote-server` semantics should be ported, not redesigned

`packages/remote-server/src/index.ts` has a lot of actual semantic logic:

```text
field authorization
selection filtering
request limits
nested traversal
normalization
mutation outcomes
live changes
pagination
requirements
```

Some of that TypeScript code cannot literally execute in the native Rust binary.

But we absolutely shouldn't invent different semantics.

There are two forms of reuse:

```text
TS implementation
      ↓
reference semantics / conformance oracle
```

and:

```text
algorithm / state machine
      ↓
Rust port
```

So:

```text
RemoteServer TS
       │
       ├── continues being JS implementation
       │
       └── semantic specification for
               NativeRemoteServer.rs
```

Then differential tests prove the port behaves identically.

That is much safer than attempting to share low-level implementation code across languages.

---

# 8. Remote protocol code can be shared directly at compile time

Things such as:

```ts
Requirement;
NormalizedPatch;
Boundary;
LiveChange;
ConnectionChange;
QueryWindow;
MutationDescriptor;
QueryDescriptor;
```

are Schema-backed values.

Don't redefine those in `effect-native`.

Consume the existing schemas:

```ts
import {
  Requirement,
  LiveChange,
  ...
} from "foldkit-remote"
```

and compile their Schema into native Rust codecs/types.

So:

```text
existing Effect Schema
         ↓
Schema compiler
         ↓
generated Rust type
```

That's exactly the kind of reuse this system is supposed to enable.

---

# 9. `remote-drizzle` should mostly supply metadata

We don't want to port Drizzle itself.

But the existing declarations can be reused at **compile time**:

```text
Drizzle table
Foldkit Entity
binding
relations
query IR
```

The compiler executes those TypeScript declarations and extracts:

```text
table name
column mappings
SQL types
relations
primary keys
indexes
query expressions
```

Then Rust gets:

```text
SQLx
```

The Drizzle library never ships in the binary.

That's a nice kind of reuse:

> **Use JS libraries as compile-time metaprogramming APIs even when their runtime implementation disappears completely.**

---

# 10. Effect itself should be reused much more than copied

This distinction matters.

Effect is MIT, so legally we _can_ copy substantial pieces while preserving the license notice. But architecturally I would avoid creating a fork of Effect.

Instead:

```ts
import {
  Effect,
  Schema,
  Layer,
  Context,
  Stream,
  ...
} from "effect"
```

should remain the compiler's **reference semantics and authoring infrastructure**. Effect's current repository is MIT. `Effect-TS/effect` repository metadata confirms that.

Especially reuse directly:

```text
Schema
Schema AST
Schema codecs

RPC declarations
HTTP/API declarations

Context.Service identities
Layer descriptions where inspectable

Exit/Cause public semantics

Schedule descriptions where portable

Stream/RPC schemas
```

For something like Schema, copying would actually be worse.

We want:

```text
Effect.Schema
      ↓
effect-native compiler
```

not:

```text
OurSchemaFork
```

---

# 11. Effect should become the reference interpreter

This is an enormous form of reuse.

Instead of writing:

```text
Effect Native JS runtime
```

from scratch:

```text
compiled IR
    ↓
reference interpreter
    ↓
real Effect
```

So:

```ts
C.Effect.flatMap(a, f);
```

reference interpretation becomes:

```ts
Effect.flatMap(interpret(a), (value) => interpret(f(value)));
```

and:

```ts
C.Effect.race(...)
```

becomes:

```ts
Effect.race(...)
```

Likewise:

```text
Scope
Fiber
Ref
Queue
Deferred
Stream
Layer
```

can be interpreted by actual Effect.

That gives us a **correct reference runtime for free**.

Rust then has to match it.

That's substantially more useful than copying Effect internals.

---

# 12. But some Effect algorithms may be worth porting

> **Later update:** The [later runtime guidance](runtime-lowering.md#what-remains-in-the-semantic-runtime) asks whether generated code or a verified Rust substrate adapter suffices before porting an algorithm. Preserve exact observable semantics whichever approach is selected.

For semantics that are unusually subtle:

```text
Cause combination
Scope finalization order
Fiber interruption
Layer memoization
Schedule stepping
```

we might inspect the Effect implementation and port the algorithm fairly literally where appropriate.

Since Effect is MIT, that's viable with proper attribution.

But I would do this selectively.

The desired hierarchy is:

```text
1. use public Effect semantics as oracle
2. implement native semantics naturally in Rust
3. differential-test them
4. port Effect implementation details only when parity is difficult
```

Rather than translating Effect's runtime into Rust line by line.

---

# 13. Foldkit itself should be a dependency/contract

Foldkit is also MIT (`foldkit/foldkit` has an MIT `LICENSE`).

Again, don't fork it.

Use its public:

```text
Model
Message
init
view
routing
SSR/hydration contract
```

and compile the pieces we support.

The browser still literally uses Foldkit.

Only the server implementation changes.

---

# I think there is a shared package hiding in all this

> **Later update:** The [subsequent revised plan](compiler-design-revision.md#3-do-not-extract-a-shared-mega-kernel-yet) explicitly defers shared mega-kernel extraction. The package idea below is a future possibility, not a bootstrap dependency.

After seeing the duplication between these projects, I'd seriously consider extracting something neutral.

Not:

```text
effect-native-core
```

because then Gen2 depending on it would conceptually be backwards.

Something more like:

```text
@doeixd/semantic-ir
```

or a better eventual name.

It would contain only things that are genuinely universal:

```text
Id / Ref / Identity

Representation
SemanticType witness

Trait
Capability
Requirement
EffectFootprint

Operation
Law
Evidence

Expr core primitives

DependencySet

Target / Runtime

Diagnostics

Pass / PassResult
```

Then:

```text
                 semantic-ir
                 /    |     \
                /     |      \
             gen2  native  foldkit-plus
```

But I would **not do that extraction first**.

That risks turning the first month into abstraction archaeology.

---

# For v0, copy/adapt intentionally

I'd start a fresh `effect-native` repo and take concrete pieces:

```text
FROM gen2
─────────
representation.ts
operation.ts
runtime.ts
trait.ts
pass.ts
diagnostic pieces
ID/ref machinery

Then heavily simplify/refine them.


FROM foldkit-plus
─────────────────
Expr semantics
dependency walker ideas
query evaluator fixtures
conformance tests
Remote protocol Schemas
RemoteServer semantics/tests


FROM Effect
───────────
normal npm dependencies
Schema/SchemaAST
real Effect reference interpreter
RPC/HTTP declarations
public semantic APIs
```

Once the Effect Native kernel settles, **then compare it back against Gen2 and Foldkit-Plus and extract the true common subset**.

That avoids designing the common package before we know which commonality is real.

---

## There are also pieces I would explicitly _not_ reuse

I wouldn't drag these across merely because they exist:

- **Gen2's whole graph/node architecture:** Effect Native doesn't need a full application-domain compiler.
- **Gen2's existing law typing unchanged:** the concept is excellent, but Effect Native should make laws more strongly type-indexed.
- **Drizzle runtime implementation:** only consume its compile-time metadata.
- **Foldkit-Remote JS runtime on the server:** port semantics to Rust instead.
- **Effect's scheduler/runtime wholesale:** Tokio should do the underlying scheduling.
- **Effect internals when public descriptors exist:** compile from public APIs instead, reducing coupling to internal implementation changes.

So reuse is aggressive, but **reuse the semantic assets, not accidental implementation baggage**.

### Licensing

The current state I checked is:

```text
doeixd/foldkit-plus   MIT + LICENSE file
foldkit/foldkit       MIT + LICENSE file
Effect-TS/effect      MIT
doeixd/gen2           package.json says MIT,
                      but no root LICENSE file currently
```

Since Gen2 is yours, I'd simply add a normal MIT `LICENSE` to that repo before extracting/copying it into another public project. For copied Effect/Foldkit code, retain the required MIT copyright/license notices for substantial copied portions. For normal package dependencies, their packages handle their own notices.

The upshot is that **this project is much less greenfield than it initially looked**. We can bootstrap the semantic compiler kernel from Gen2, immediately get a substantial real IR + conformance suite from Foldkit-Plus, and use Effect itself as the executable specification/reference interpreter. The genuinely new work is then concentrated where it should be: **native lowering, ownership planning, Rust runtime semantics, and target integrations.**
