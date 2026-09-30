# Conformance, diagnostics, and the fullstack target

[Roadmap](../PLAN.md) · [Documentation index](README.md) · [Revision overview](op-expr-revision-convo.md)

This document preserves part of the later design conversation. Read the revision overview for how it updates earlier proposals. Examples and upstream API, repository, and licensing claims are historical design material, not verified current facts or implemented guarantees.

## Contents

- [41. Testing architecture from day one](#41-testing-architecture-from-day-one)
- [Operations](#operations)
- [Laws](#laws)
- [Queries](#queries)
- [RPC](#rpc)
- [Serialization](#serialization)
- [Remote](#remote)
- [Foldkit SSR](#foldkit-ssr)
- [Effect runtime semantics](#effect-runtime-semantics)
- [42. Diagnostics are first-class output](#42-diagnostics-are-first-class-output)
- [43. What we deliberately postpone](#43-what-we-deliberately-postpone)
- [44. Recommended implementation sequence](#44-recommended-implementation-sequence)
- [45. The key architectural division](#45-the-key-architectural-division)
- [46. First concrete target](#46-first-concrete-target)
- [Final design principle](#final-design-principle)

---

# 41. Testing architecture from day one

Every subsystem gets semantic conformance tests.

## Operations

```text
JS reference
vs
Rust
```

## Laws

Generated property tests.

## Queries

```text
evaluate
vs
Drizzle
vs
SQLx
```

## RPC

```text
official Effect client
vs
native server
```

## Serialization

```text
Effect encoder ↔ Rust decoder
Rust encoder ↔ Effect decoder
```

## Remote

```text
JS RemoteServer
vs
Native RemoteServer
```

## Foldkit SSR

```text
JS SSR
vs
native SSR
```

and most importantly:

```text
native HTML
    ↓
stock Foldkit hydration
    ↓
successful adoption
```

## Effect runtime semantics

Compare:

```text
Exit
Cause
finalizer traces
interruption behavior
```

between Effect and Rust.

---

# 42. Diagnostics are first-class output

Compiler errors should be semantic:

```text
EN2041

PostsBySearch cannot be lowered to target `rust-postgres`.

Required operation:
  text.unicodeContains

Supported by:
  reference-js

Not supported by:
  postgres
  rust-postgres

Required from:
  PostsBySearch
    → where
      → contains(...)
```

Likewise:

```text
EN3102

Parallel reduction requires an Associative operation.

Operation:
  UserMerge

Evidence found:
  none
```

This is where the laws/capability architecture pays off in developer experience.

---

# 43. What we deliberately postpone

Do **not** initially build:

```text
full Effect runtime
STM / Tx ecosystem
all Streams/Channels
arbitrary TS parsing
arbitrary npm compatibility
native browser DOM
full Effect Cluster
distributed runtime
advanced compiler optimization
general WASM backend
```

Each is unlocked by a real workload rather than implemented speculatively.

---

# 44. Recommended implementation sequence

The condensed sequence is:

```text
0. Semantic kernel from Gen2
   ↓
1. Foldkit Expr/Query → Rust conformance
   ↓
2. C.fn / Match / basic Effect IR
   + Effect reference interpreter
   ↓
3. Unary Effect RPC + middleware
   ↓
4. Native foldkit-remote-server
   ↓
5. Query → SQLx
   ↓
6. Streaming RPC + Scope + cancellation
   ↓
7. Remote live
   ↓
8. Native Foldkit SSR
   ↓
9. Data.satisfy + Remote resume
   ↓
   ★ COMPLETE NATIVE FOLDKIT WEB APP ★
   ↓
10. SchemaBinary
   ↓
11. WebSocket / notifications / reverse RPC
   ↓
12. Broader Effect fibers/concurrency
   ↓
13. advanced ownership/lifetime inference
   ↓
14. Cruster distributed/durable profile
   ↓
15. syntax widening
   ↓
16. hybrid JS / additional targets
```

---

# 45. The key architectural division

After everything we've learned, the responsibilities are remarkably clean:

```text
GEN2
────────────────────────
compiler architecture
representations
operations
laws
traits
capabilities
passes


EFFECT
────────────────────────
user-facing effect model
Schema
services
Layers
RPC
HTTP
reference semantics


FOLDKIT-PLUS
────────────────────────
real semantic IR
Entity/Expr/Query
Remote
normalized data
SSR/resume use cases


CRUSTER
────────────────────────
native distributed runtime
sharding
persisted delivery
workflows
durability
cluster infrastructure


RUST ECOSYSTEM
────────────────────────
Tokio
Axum / Hyper / Tower
Serde
SQLx
etc.


EFFECT-NATIVE
────────────────────────
the connective compiler

semantic IR
planning
verification
ownership
native lowering
cross-backend conformance
```

That last line is important.

The novel project is no longer:

> “implement everything ourselves in Rust.”

It's:

> **build the semantic compiler that connects these already-existing pieces correctly.**

---

# 46. First concrete target

If I were starting the repository now, I would optimize every early design decision toward this one executable:

```text
examples/todo-fullstack
```

Authored with:

```text
Foldkit
foldkit-remote
foldkit-entity Query
Effect
Effect RPC
Effect Schema
```

Compiled to:

```text
single Rust executable
    │
    ├── Foldkit SSR
    ├── Effect RPC
    ├── RemoteServer
    ├── streaming live updates
    └── SQLx/Postgres
```

while the browser remains:

```text
normal Foldkit
normal foldkit-remote
normal Effect RpcClient
```

That application gives every subsystem a reason to exist.

And once it works, turning on:

```ts
distributed: Cruster.cluster(...)
```

becomes the natural next demonstration:

```text
same TypeScript program
        ↓
native distributed deployment
```

rather than a separate framework.

---

# Final design principle

The compiler should increasingly know not merely **what code to emit**, but:

```text
what a program means
what it requires
what laws hold
which representations are valid
which backends can implement it
which transformations preserve meaning
why a particular implementation was selected
```

That is the synthesis of the best ideas we've found across Foldkit-Plus, Gen2, Effect and Cruster.

It turns Effect Native from a syntax transpiler into a **semantic compiler**.

And that is the architecture I would build.
