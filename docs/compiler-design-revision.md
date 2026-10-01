# Revised compiler design

[Roadmap](../PLAN.md) · [Documentation index](README.md) · [Revision overview](op-expr-revision-convo.md)

The later [migration tooling design](migration-tooling.md) uses compiler reachability and structured diagnostics as a semantic authority, with an external AST/workflow engine for eligible source rewrites. Mechanical fixes and guided/architectural decisions share the library API without widening the initial source subset.

The later [runtime lowering reference](runtime-lowering.md) extends this design's implementation planning: distinguish operation, service, and semantic runtime entries; choose generated code, a verified substrate adapter, or dedicated runtime; record reachable crates/features and conformance obligations. It does not change the pass order or milestone sequence.

[Source-map design](source-maps.md) specifies provenance-preserving passes and emission: immutable definition/use origins, transform ancestry, final Rust byte ranges and optional standard-map projections. MagicString can support AST metadata edits but does not supply semantic lowering correspondence. Metadata annotations can arrive before general syntax widening.

This document preserves part of the later design conversation. Read the revision overview for how it updates earlier proposals. Examples and upstream API, repository, and licensing claims are historical design material, not verified current facts or implemented guarantees.

## Contents

- [Effect Native — Revised Implementation Plan](#effect-native--revised-implementation-plan)
- [1. Goal](#1-goal)
- [2. Reuse strategy](#2-reuse-strategy)
- [Gen2 → compiler kernel](#gen2--compiler-kernel)
- [Foldkit-Plus → real semantic IR and first applications](#foldkit-plus--real-semantic-ir-and-first-applications)
- [Effect → public authoring APIs + executable specification](#effect--public-authoring-apis--executable-specification)
- [Cruster → optional distributed/durable backend](#cruster--optional-distributeddurable-backend)
- [3. Do not extract a shared mega-kernel yet](#3-do-not-extract-a-shared-mega-kernel-yet)
- [4. Repository structure](#4-repository-structure)
- [5. Core semantic model](#5-core-semantic-model)
- [CType](#ctype)
- [6. Operations become first-class semantic definitions](#6-operations-become-first-class-semantic-definitions)
- [7. Typed laws become part of the kernel immediately](#7-typed-laws-become-part-of-the-kernel-immediately)
- [8. Schema-driven law testing](#8-schema-driven-law-testing)
- [9. Traits are checked claims](#9-traits-are-checked-claims)
- [10. Compilation passes](#10-compilation-passes)
- [`check`](#check)
- [`derive`](#derive)
- [`normalize`](#normalize)
- [`plan`](#plan)
- [`verify`](#verify)
- [`optimize`](#optimize)
- [`ownership`](#ownership)
- [`lower`](#lower)
- [11. Compiler planning must be explainable](#11-compiler-planning-must-be-explainable)
- [12. Compiler API comes first](#12-compiler-api-comes-first)
- [13. CLI](#13-cli)

---

# Effect Native — Revised Implementation Plan

## 1. Goal

`effect-native` is a compiler and native runtime toolkit for taking a statically representable subset of Effect/TypeScript programs and producing optimized native Rust applications.

The central pipeline is:

```text
TypeScript authoring APIs
        │
        │ builder execution
        ▼
Typed semantic IR
        │
        ├── Effect reference interpreter
        │
        └── compiler
              │
              ▼
   check → derive → normalize
              │
             plan
              │
            verify
              │
           optimize
              │
      ownership / lifetime
              │
             lower
              │
             emit
              ▼
             Rust
              │
    ┌─────────┼─────────────┐
    ▼         ▼             ▼
  Tokio    Axum/Hyper      SQLx
             │
             └── optional Cruster
```

The objective is **not**:

- arbitrary TypeScript → Rust;
- a fork of Effect;
- a Rust implementation of the entire Effect runtime;
- a new web framework;
- a second Foldkit runtime.

The objective is:

> **Turn explicitly structured Effect programs into native programs while preserving their semantics and compiling away as many abstractions as possible.**

---

# 2. Reuse strategy

We now have four unusually complementary sources of existing work.

## Gen2 → compiler kernel

Gen2 should seed the semantic compiler architecture.

Reuse/adapt:

```text
Representation
SemanticType ideas
Operation
Implementation
Runtime
Capability
Effect footprint
Law
Trait
Diagnostics
Pass
PassRegistry
```

Especially useful files include:

- `src/types/representation.ts`
- `src/types/operation.ts`
- `src/types/runtime.ts`
- `src/kernel/trait.ts`
- `src/kernel/pass.ts`

Gen2 already separates operation semantics, target implementations, capabilities, effects, representations, laws and compiler passes.

That is almost exactly what Effect Native needs.

We should **strengthen**, rather than merely copy, the law/type system.

---

## Foldkit-Plus → real semantic IR and first applications

Reuse directly where possible:

```text
foldkit-entity Expr
foldkit-entity Query
Query dependencies
reference evaluator
query conformance suite

foldkit-remote protocol Schemas
Requirement
NormalizedPatch
LiveChange
QueryWindow
MutationDescriptor
etc.

remote-server semantic behavior
remote-drizzle bindings
Remote resume protocol
```

Do not fork these concepts into `NativeExpr`, `NativeQuery`, etc.

Effect Native should be able to consume them.

Foldkit-Plus already demonstrates the architecture:

```text
semantic query description
       │
       ├── in-memory interpreter
       └── Drizzle compiler
```

Effect Native simply adds:

```text
       └── Rust / SQLx compiler
```

---

## Effect → public authoring APIs + executable specification

Use Effect itself as a dependency.

Reuse:

```text
Schema
Schema AST
Effect
Context
Layer
Exit
Cause
Stream
Schedule
RPC declarations
HttpApi declarations
etc.
```

Do not create:

```text
NativeSchema
NativeRpc
NativeContext
```

unless a genuinely separate compiled representation is required internally.

Most importantly:

```text
Native IR
   ↓
JS reference interpreter
   ↓
real Effect
```

Effect becomes our semantic oracle.

---

## Cruster → optional distributed/durable backend

Cruster should **not** be the base runtime.

It should become an optional target implementation for:

```text
Effect Cluster
distributed entities
persisted RPC
durable delivery
sharding
singletons
cron
durable workflows
activities
durable timers
signals/deferreds
cluster streaming
```

Cruster already maps several Effect Cluster concepts into Rust, including persisted RPC and interruption annotations, and provides SQL-backed workflow journaling, sharding, gRPC transport, transactional activities and durable timers.

Architecture:

```text
                Effect Native
                     │
            ordinary Rust runtime
                     │
             Tokio / SQLx / HTTP
                     │
                     ├─────────────┐
                     │             │
                local profile   distributed profile
                                      │
                                   Cruster
```

Cruster is therefore a target capability, not a universal dependency.

---

# 3. Do not extract a shared mega-kernel yet

There is clearly a common abstraction hiding across Gen2, Foldkit-Plus and Effect Native.

Eventually something like:

```text
semantic-ir
```

might contain:

```text
Representation
Operation
Law
Trait
Capability
Target
Diagnostic
Pass
```

But don't begin there.

First:

```text
copy/adapt Gen2 kernel
        ↓
build Effect Native
        ↓
discover which abstractions actually survive
        ↓
extract genuine shared kernel later
```

Otherwise we risk spending the early project designing an abstraction for three projects instead of building a compiler.

---

# 4. Repository structure

Start reasonably coarse-grained.

```text
effect-native/
│
├── packages/
│   │
│   ├── core/
│   │   CType
│   │   Expr
│   │   Operation
│   │   Law
│   │   Trait
│   │   Capability
│   │   Fn
│   │   Program
│   │
│   ├── compiler/
│   │   Compile API
│   │   passes
│   │   diagnostics
│   │   dependency analysis
│   │   planning
│   │
│   ├── rust/
│   │   Rust target
│   │   Rust IR
│   │   codegen
│   │   Cargo integration
│   │
│   ├── foldkit/
│   │   Foldkit SSR integration
│   │
│   └── cli/
│
├── crates/
│   │
│   ├── effect_native_runtime/
│   ├── effect_native_rpc/
│   ├── effect_native_remote/
│   └── effect_native_foldkit/
│
└── examples/
    ├── expr/
    ├── rpc/
    ├── remote/
    └── fullstack/
```

Later, split packages only when pressure appears.

Cruster can initially remain an external Cargo dependency rather than being wrapped in a large custom crate.

---

# 5. Core semantic model

## CType

The core invariant remains:

> Every compiled runtime value has a statically known semantic type and native representation.

```ts
interface CType<A> {
  readonly schema: Schema.Schema<A>;
  readonly native: NativeRepresentation;
  readonly traits: TraitSet;
}
```

But Gen2 suggests making representation boundaries more explicit:

```text
CType
├── semantic Schema
├── NativeRepresentation
├── WireRepresentation?
└── StorageRepresentation?
```

Example:

```text
UserId

semantic:
  UserId

native:
  u64

JSON:
  decimal string

SchemaBinary:
  varint

Postgres:
  BIGINT
```

These representations must not be accidentally conflated.

---

# 6. Operations become first-class semantic definitions

> **Later update:** The later [registry design](runtime-lowering.md#three-implementation-registries) distinguishes operation, service, and semantic runtime implementations while keeping selection under the same semantic planner.

Rather than hard-coded compiler switches:

```ts
Operation.define({
  id: "u64.add",

  input: [U64, U64],
  output: U64,

  effects: [],
  capabilities: [],

  laws: [...],

  implementations: {
    reference: ...,
    rust: ...
  }
})
```

Operations drive:

```text
IR construction
type checking
dependency analysis
capability checking
law reasoning
reference interpretation
Rust lowering
documentation
editor tooling
```

Examples:

```text
u64.add
string.contains
vector.map
effect.sleep
ref.get
rpc.call
```

The public ergonomic API can still be:

```ts
C.U64.add(a, b);

C.String.contains(a, b);

C.Effect.sleep(duration);
```

---

# 7. Typed laws become part of the kernel immediately

Gen2's laws should be upgraded from loose metadata into typed evidence.

Conceptually:

```ts
Law.Associative<typeof AddU64>;

Law.Commutative<typeof AddU64>;

Law.Identity<typeof AddU64, typeof Zero>;
```

Law families:

```text
Algebraic
─────────
Associative
Commutative
Identity
Inverse
Distributive

Execution
─────────
Deterministic
Idempotent
RetrySafe
ParallelSafe
RollbackSafe
CancellationSafe

Representation
──────────────
RoundTrip
Lossless
Canonical
OrderPreserving

Implementation
──────────────
EquivalentToReference
```

Evidence levels:

```text
claim
tested
proven
builtin/trusted
```

A compilation profile determines which evidence may justify optimization.

For example:

```ts
Compile.withLawPolicy({
  optimizeUsing: "tested",
});
```

allows:

```text
builtin
proven
tested
```

but not unsupported user claims.

---

# 8. Schema-driven law testing

Because every operation has schemas/types, many laws can automatically produce tests.

Associativity:

```text
op(op(a,b),c)
=
op(a,op(b,c))
```

Commutativity:

```text
op(a,b)
=
op(b,a)
```

Identity:

```text
op(a,identity)
=
a
```

Backend equivalence:

```text
reference JS operation
        │
 generated inputs
        │
     ┌──┴──┐
     ▼     ▼
    JS    Rust
     │     │
     └─==──┘
```

This becomes a foundational testing system rather than an afterthought.

---

# 9. Traits are checked claims

Borrow Gen2's trait approach.

Examples:

```text
Eq
Hash
TotallyOrdered

Copyable
Cloneable
ThreadSafe
Shareable

AtomicCompatible
SQLComparable
Serializable
```

Derive them structurally.

For example:

```text
Vector<T>: Cloneable
iff
T: Cloneable
```

and:

```text
HashMap<K,V>
requires:
  K: Eq + Hash
```

Do not expose Rust-specific names like `Send` and `Sync` as the source semantic vocabulary.

The Rust backend maps semantic traits onto Rust traits.

---

# 10. Compilation passes

Revise the compiler pipeline to:

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

### `check`

Local validity:

```text
types
schemas
Match exhaustiveness
service declarations
operation inputs
portable callbacks
```

### `derive`

Compute:

```text
operation dependencies
service requirements
effects
capabilities
traits
Layer requirements
scope graph
```

### `normalize`

Turn compositional syntax into canonical IR.

Example:

```text
where(a)
where(b)
where(c)
```

becomes:

```text
where = [a,b,c]
```

rather than retaining accidental source nesting.

### `plan`

Select implementations:

```text
Ref<U64>
→ AtomicU64

Ref<AppState>
→ Mutex<AppState>

Query
→ SQL pushdown

RPC serializer
→ JSON / SchemaBinary

distributed entity
→ Cruster
```

### `verify`

Check that the selected plan possesses the required:

```text
capabilities
traits
laws
implementations
```

### `optimize`

Only apply rewrites justified by semantics/laws.

### `ownership`

Infer:

```text
move
borrow
borrow mutable
shared Arc
clone
```

### `lower`

Generate target-specific Rust IR.

---

# 11. Compiler planning must be explainable

> **Later update:** The [later support-report requirements](runtime-lowering.md#planning-support-reporting-and-acceptance) add selected substrates/adapters, reachable crates/features, and conformance obligations. [Migration analysis](migration-tooling.md#target-scoped-analysis-and-reports) consumes the same target-reachable graph.

Every important decision should carry a reason.

Example:

```text
Ref<AppState>

preferred:
  Atomic

rejected:
  AppState does not satisfy AtomicCompatible

selected:
  Mutex<AppState>
```

Or:

```text
PostsBySlug query

selected:
  SQL pushdown

because:
  all required Expr operations supported by Postgres target
```

Or:

```text
SomeSearch query

SQL pushdown rejected:
  unicodeFold unsupported

fallback:
  server evaluation

bounded by:
  max candidate rows = 100
```

Expose:

```ts
Compile.explain(spec);
```

and:

```bash
effect-native explain
```

This becomes an important debugging feature.

---

# 12. Compiler API comes first

The compiler is an Effect library.

The CLI is only an adapter.

Canonical usage:

```ts
import { Compile, Rust } from "effect-native";
import program from "./program.native.ts";

const build = Compile.make("my-app").pipe(
  Compile.withProgram(program),

  Compile.withTarget(
    Rust.binary({
      profile: "release",
    }),
  ),

  Compile.withOutput("./dist"),

  Compile.run,
);
```

And then:

```ts
NodeRuntime.runMain(build);
```

Individual stages remain available:

```ts
Compile.check(...)
Compile.derive(...)
Compile.normalize(...)
Compile.plan(...)
Compile.verify(...)
Compile.optimize(...)
Compile.analyzeOwnership(...)
Compile.lower(...)
Compile.emit(...)
```

The compiler itself should use Effect services/Layers:

```text
Validator
Planner
Optimizer
RustBackend
Cargo
Cache
Diagnostics
```

---

# 13. CLI

> **Later update:** The [migration API/CLI design](migration-tooling.md#library-api-and-cli) adds proposed analyze/check JSON, migrate/report/apply, and diagnostic-linked fixes as library consumers. These are proposed commands, not implemented support.

Built over the public API:

```bash
effect-native check
effect-native build
effect-native run
effect-native dev

effect-native emit ir
effect-native emit rust

effect-native inspect dependencies
effect-native inspect layers
effect-native inspect ownership

effect-native explain
effect-native support
```

No hidden compiler functionality belongs in the CLI.

---
