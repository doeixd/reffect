# Foldkit Remote and SQL

[Roadmap](../PLAN.md) · [Documentation index](README.md)

The later [Foldkit IR design](foldkit-ir-design.md) and [reuse strategy](reuse-strategy.md) specify consuming existing Entity/Query IR, protocol schemas, and conformance fixtures. The [revised milestones](implementation-milestones.md) move Query → Rust conformance before general Effect functions and RPC. [Cruster](cruster-backend.md) is a later optional distributed implementation beneath native application services.

This document preserves a design discussion from the original PLAN.md. APIs and package names are proposals, not implemented guarantees. Original citation placeholders are retained; verify external API and protocol claims against the installed dependencies before implementation.

## Contents

- [The architecture](#the-architecture)
- [`foldkit-remote-server` is the part we'd implement natively](#foldkit-remote-server-is-the-part-wed-implement-natively)
- [Entity Sources become native traits/functions](#entity-sources-become-native-traitsfunctions)
- [The really interesting piece: `remote-drizzle`](#the-really-interesting-piece-remote-drizzle)
- [`Query.define` is almost already our IR](#querydefine-is-almost-already-our-ir)
- [And you've already written the specification tests](#and-youve-already-written-the-specification-tests)
- [What happens to the Drizzle schema?](#what-happens-to-the-drizzle-schema)
- [Some current Drizzle callbacks would not be portable](#some-current-drizzle-callbacks-would-not-be-portable)
- [Authorization should probably move in the same direction](#authorization-should-probably-move-in-the-same-direction)
- [Mutations are straightforward](#mutations-are-straightforward)
- [Live data also fits very well](#live-data-also-fits-very-well)
- [So native Remote and native RPC reinforce each other](#so-native-remote-and-native-rpc-reinforce-each-other)
- [Native SSR gets even better](#native-ssr-gets-even-better)
- [`remote-drizzle` becomes `remote-sqlx` conceptually](#remote-drizzle-becomes-remote-sqlx-conceptually)
- [I'd split the native implementation into three pieces](#id-split-the-native-implementation-into-three-pieces)
- [A native RemoteServer can also specialize aggressively](#a-native-remoteserver-can-also-specialize-aggressively)
- [And the normalized data format maps cleanly to Rust](#and-the-normalized-data-format-maps-cleanly-to-rust)
- [This might be a better early milestone than generic SQL](#this-might-be-a-better-early-milestone-than-generic-sql)

---

Yes. **`foldkit-remote` may actually be one of the best things to target with `effect-native`.** After looking at the current `remote-server` and `remote-drizzle` design, a Rust backend fits the architecture almost uncannily well.

The reason is that you already designed `remote` around **semantic descriptions + interpreters** rather than hard-coding transport/database behavior. `foldkit-remote-server` explicitly describes itself as an interpreter of semantic requirements, while `foldkit-remote-drizzle` compiles those requirements into SQL. Even better, `Query.define` bodies already have a pure reference evaluator and an exported conformance suite specifically meant to check other interpreters. [remote-server README](https://github.com/doeixd/foldkit-plus/blob/main/packages/remote-server/README.md) [remote-drizzle README](https://github.com/doeixd/foldkit-plus/blob/main/packages/remote-drizzle/README.md)

## The architecture

The browser side should need essentially **zero changes**:

```text
Browser
──────────────────────────────────

Foldkit Model
    │
Data.get / Data.query / Data.live
    │
Remote planner
    │
RemoteClient
    │
Effect RPC
    │
    ▼


Native server
──────────────────────────────────

Effect RPC-compatible Rust transport
    │
    ▼
Native RemoteServer
    │
    ├── validate requirement
    ├── authorize fields
    ├── group / deduplicate ids
    ├── traverse relations
    ├── resolve queries/windows
    ├── normalize patches
    ├── mutations
    └── live streams
            │
            ▼
       Native Sources
            │
      ┌─────┴──────┐
      ▼            ▼
    SQLx        compiled
   Postgres     services/API
```

From the client's perspective it is still:

```ts
Remote.clientLayer(rpcClient);
```

The client does not know or care that `RemoteRpc` is being answered by Rust.

That's important: **we wouldn't create `foldkit-remote-rust` on the client.**

---

## `foldkit-remote-server` is the part we'd implement natively

The existing server currently performs:

```text
requirement
    ↓
group by entity
    ↓
union selected fields
    ↓
validate declared fields
    ↓
authorization
    ↓
deduplicate ids
    ↓
Source.read
    ↓
follow normalized relation refs
    ↓
repeat for next entity level
    ↓
normalized Remote response
```

That's mostly plain algorithms over strongly typed data.

Rust is excellent at this.

And because the **domain is known at compile time**, we can make it better than a literal port.

For example, instead of runtime strings everywhere:

```text
"Project"
"id"
"name"
"owner"
```

we can generate:

```rust
enum Entity {
    Project,
    User,
}

enum ProjectField {
    Id,
    Name,
    Owner,
}
```

A field selection can internally become a bitset:

```text
Project selection

id    ✓
name  ✓
owner ✓
notes ✗

      ↓

0b0111
```

So after decoding the RPC boundary, most of the server engine operates on compact native IDs rather than string-keyed JS objects.

---

## Entity Sources become native traits/functions

Today you have roughly:

```ts
RemoteServer.entity(Project, {
  authorize: ...,

  read: ({ ids, fields, principal }) =>
    Effect<Rows, Error, Database>
})
```

Native lowering could produce something like:

```rust
trait ProjectSource {
    async fn read(
        &self,
        request: ProjectRead<'_>,
        principal: &Principal,
    ) -> Result<Vec<ProjectPatch>, RemoteError>;
}
```

But because the entire server graph is known, we may not even need trait objects.

Generated code could simply have:

```rust
struct Sources {
    projects: ProjectSource,
    users: UserSource,
}
```

and compile dispatch down to:

```rust
match entity {
    Entity::Project => ...,
    Entity::User => ...,
}
```

Again, most Effect/Context indirection disappears.

---

# The really interesting piece: `remote-drizzle`

I would **not try to execute Drizzle from Rust**.

Instead:

```text
foldkit-remote-drizzle

Remote semantic model
       ↓
Drizzle SQL compiler
```

gets a sibling backend:

```text
Remote semantic model
       ↓
Native SQL compiler
       ↓
SQLx
```

Conceptually:

```text
                    Query / Entity semantics
                            │
             ┌──────────────┴──────────────┐
             ▼                             ▼
    remote-drizzle                  native SQL backend
             │                             │
             ▼                             ▼
          Drizzle                        SQLx
             │                             │
             └──────── PostgreSQL ─────────┘
```

And you already laid much of the groundwork for exactly this.

The current `Query.define` documentation says its body names domain fields rather than table columns, and specifically notes that because the binding supplies the field→column knowledge, **the same body could be compiled by something else**. That's essentially an invitation to write the Rust compiler. [remote-drizzle README](https://github.com/doeixd/foldkit-plus/blob/main/packages/remote-drizzle/README.md)

---

# `Query.define` is almost already our IR

> **Later update:** The [revised first real target](implementation-milestones.md#15-milestone-1--foldkit-entity-exprquery-as-the-first-real-compiler-target) consumes existing Expr/Query IR and fixtures before general compiled functions; SQLx follows later at milestone 5.

For example:

```ts
const PostsBySlug = Query.define("PostsBySlug", { slug: Schema.String }, ({ input }) =>
  Query.from(Post).pipe(
    Query.where(Expr.eq(Post.fields.slug, input.slug)),
    Query.orderBy(Order.asc(Post.fields.id)),
  ),
);
```

This already isn't arbitrary JS query logic.

It produces a semantic query body:

```text
From(Post)

Where(
  Eq(
    Field(Post.slug),
    Input(slug)
  )
)

Order(
  Asc(Post.id)
)
```

Which is essentially exactly what we've been talking about for `effect-native`.

So:

```text
foldkit-entity Query IR
       ↓
remote-drizzle compiler
       ↓
Drizzle
```

can become:

```text
foldkit-entity Query IR
       ↓
effect-native remote compiler
       ↓
SQLx / SQL
```

No TypeScript parsing necessary.

---

# And you've already written the specification tests

This is unusually valuable.

`remote-server` exports:

```ts
cases;
rows;
Subject;
```

specifically so:

```ts
for (const { body, input, expected } of cases) {
  yourInterpreter(body, input, rows);
}
```

can be checked against the canonical semantics.

Your README says the test cases intentionally cover places where interpreters tend to disagree:

```text
case behavior
NULL semantics
% and _ handling
empty search
boolean predicate comparisons
ordering behavior
```

and that both the in-memory evaluator and Drizzle/SQLite interpreter are tested against those semantics.

So the Rust backend gets an immediate acceptance criterion:

```text
                  Query body
                      │
        ┌─────────────┼──────────────┐
        ▼             ▼              ▼
     evaluate       Drizzle        Rust
        │             │              │
        └──────── same IDs/order ─────┘
```

That's almost ideal compiler development infrastructure.

---

# What happens to the Drizzle schema?

There are two paths.

### Initially: consume Drizzle declarations at build time

You could continue writing:

```ts
const projects = pgTable("projects", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
});
```

and:

```ts
const Project = entity("Project", projects);
```

The TypeScript build process executes that declaration and extracts:

```text
Table:
  projects

Columns:
  id:
    postgres uuid
    primary key

  name:
    postgres text
    non-null
```

into our compiler IR.

Rust never sees Drizzle.

It gets generated metadata such as:

```rust
struct Project {
    id: Uuid,
    name: String,
}
```

plus SQL mappings.

That's actually pretty attractive because users don't have to rewrite their database schema.

### Longer term: backend-neutral storage IR

Your `bind(...)` design is even more promising.

Today:

```ts
bind(Blog, {
  User: {
    table: users,
  },

  Post: {
    table: posts,

    relations: {
      author: {
        field: posts.authorId,
      },
    },
  },
});
```

is logically:

```text
Domain Entity
     ↕
Storage Mapping
```

not fundamentally “a Drizzle thing.”

I could imagine eventually separating:

```text
Remote SQL binding IR
```

from:

```text
Drizzle interpreter
SQLx interpreter
```

Then:

```text
                  Storage Binding
                         │
                  ┌──────┴───────┐
                  ▼              ▼
               Drizzle          SQLx
```

But I **wouldn't require that refactor for the first prototype**. Reading static Drizzle table metadata at compile time gets us surprisingly far.

---

# Some current Drizzle callbacks would not be portable

> **Later update:** The [guided and architectural migration categories](migration-tooling.md#three-transformation-layers) apply here: an opaque callback may require a design choice, not an automatic AST rewrite. Native checking validates representability after that choice.

This is the important boundary.

Something like:

```ts
where: (input) => eq(projects.ownerId, input.ownerId);
```

is a Drizzle-specific JavaScript expression builder.

Rust can't inherently compile arbitrary:

```ts
eq(...)
```

from an npm package.

But:

```ts
Query.define(...)
```

with:

```ts
Expr.eq(Project.fields.ownerId, input.ownerId);
```

**is portable** because it is already semantic data.

So I'd make the native compatibility hierarchy:

```text
BEST
Query.define / Entity Expr IR
    ↓
fully portable


OK
static table/entity/relation Drizzle metadata
    ↓
extract at build time


NOT PORTABLE YET
arbitrary Drizzle callbacks
    ↓
requires native equivalent,
compiled predicate,
or JS hybrid target
```

This might actually encourage Foldkit-Plus toward an even cleaner architecture: anything semantically important should increasingly live in `foldkit-entity` IR rather than Drizzle callback expressions.

---

# Authorization should probably move in the same direction

> **Later update:** The revised plan makes [portable authorization](implementation-milestones.md#21-authorization-must-become-portable) an explicit requirement. Migration alternatives must preserve security behavior rather than silently substitute a weaker predicate.

Current:

```ts
authorize: (principal, fields) =>
  fields.filter((field) => field !== "privateNotes" || principal.isAdmin);
```

is ordinary JavaScript.

For native compilation, we eventually want something closer to:

```ts
authorize: RemoteServer.fields({
  id: true,
  name: true,

  privateNotes: C.Predicate.field(Principal.fields.isAdmin, C.Bool.isTrue),
});
```

or another prettier declarative API.

Then the compiler has:

```text
privateNotes
    allowed when
        Principal.isAdmin == true
```

and Rust generates direct code.

We don't necessarily need to change `remote-server` immediately; an `effect-native` compiled Source API can bridge it initially.

But longer-term, **authorization being data instead of arbitrary callbacks benefits Foldkit itself**, not just Rust compilation.

---

# Mutations are straightforward

Current mutation semantics are already clean:

```ts
RemoteServer.mutation(
  RenameProject,
  ({ input, principal }) =>
    renameProject(...).pipe(
      Effect.map(output => ({
        output,
        entities: [
          Entity.patch(...)
        ]
      }))
    )
)
```

If the body is a compiled Effect program, Rust can produce:

```text
decode input
    ↓
execute mutation
    ↓
possibly SQLx transaction
    ↓
produce MutationOutcome
    ↓
normalized patches
    ↓
encode Remote response
```

And the returned:

```text
Entity.patch
ConnectionChange.prepend
ConnectionChange.append
ConnectionChange.remove
```

are already semantic data.

Those are extremely easy to represent natively.

---

# Live data also fits very well

Your current direct live Source:

```ts
RemoteServer.live(Project, {
  subscribe: ({ requirements, after, principal }) =>
    projectEvents(...)
})
```

maps naturally to:

```rust
Stream<Item = LiveChange>
```

And `liveHub` is particularly native-friendly.

Today its semantics are:

```text
changed(Project:p1, [status])
       ↓

for each subscriber:
    did subscriber request status?
        │
        no → nothing
        │
        yes
        ↓
    re-authorize
        ↓
    re-read only status
        ↓
    emit normalized patch
        ↓
    increment cursor
```

Native implementation could use:

```text
HashMap<SubscriptionId, Subscriber>
Tokio channels
Stream
Atomic cursor / scoped sequence
```

This is almost exactly the sort of server concurrency Rust/Tokio is good at.

And because the Remote RPC live operation is streaming, it plugs directly into the Effect Native RPC streaming work we were just discussing.

---

# So native Remote and native RPC reinforce each other

The complete path becomes:

```text
Foldkit browser
    │
    │ Data.live(Project...)
    ▼
Remote planner
    │
    ▼
Effect RpcClient
    │
    │ stream
    ▼
══════════════════════════════════════
Rust server
══════════════════════════════════════
    │
Native Effect RPC
    │
    ▼
Native RemoteServer
    │
    ▼
liveHub / live source
    │
    ▼
SQLx / Postgres / application events
```

Cancellation naturally follows:

```text
Surface becomes inactive
      ↓
Remote subscription closes
      ↓
Effect RPC stream interrupted
      ↓
native fiber cancelled
      ↓
Remote live subscription removed
      ↓
Scope finalizes resources
```

That's a very good end-to-end demonstration of Effect semantics.

---

# Native SSR gets even better

This is where Foldkit SSR + Remote + Rust all come together.

Your Remote docs already have:

```ts
Data.satisfy(...)
```

for SSR, which repeatedly evaluates active Surface requirements and prefetches until nothing required remains.

Then `Remote.resume(Data)` can send only the server-owned data actually required by the rendered Surfaces to the browser.

So imagine:

```text
HTTP request
    ↓
native Foldkit routing
    ↓
native Flags/init
    ↓
active Surfaces
    ↓
Data.satisfy
    ↓
Native RemoteClient
    ↓
Native RemoteServer
    ↓
SQLx
    ↓
Postgres
    ↓
Remote.Model populated
    ↓
Foldkit native view renderer
    ↓
HTML
+
minimal Remote resume payload
    ↓
Browser hydrates
    ↓
Remote already knows those facts
    ↓
no duplicate startup fetch
```

And crucially:

### SSR doesn't need to RPC to itself

The native process can wire:

```text
RemoteClient
      ↓
in-process RemoteServer handlers
```

just as your current design already supports:

```ts
Remote.clientLayer(handlers);
```

for tests/SSR/workers.

So during native SSR:

```text
Foldkit SSR
   ↓
RemoteClient
   ↓
direct native function calls
   ↓
RemoteServer
   ↓
SQLx
```

No serialization.

No loopback HTTP.

No RPC overhead.

But once the browser hydrates, the same conceptual client talks to the same server through RPC.

That symmetry is excellent.

---

# `remote-drizzle` becomes `remote-sqlx` conceptually

I wouldn't necessarily expose that package name to users if the compiler handles it automatically.

Potential API:

```ts
const Server = RemoteServer.make({
  entities: [
    source(Db.Project),
    source(Db.User),
  ],

  queries: [
    query(PostsBySlug, {
      entity: Db.Post
    })
  ],

  mutations: [...]
})
```

Then:

```ts
Compile.make("app").pipe(
  Compile.withProgram(program),

  Compile.withBackend(
    Remote.sqlx({
      database: "postgres",
    }),
  ),

  Compile.run,
);
```

The compiler sees that these are Drizzle/storage-backed Sources and lowers them to the SQLx implementation.

Or even simpler, no explicit option if there is one obvious Rust lowering:

```text
remote-drizzle Source
        ↓
native compiler recognizes binding metadata
        ↓
SQLx Source
```

Although architecturally I'd probably rename the intermediate concept eventually so `remote-drizzle` doesn't become the semantic source of truth for non-Drizzle backends.

---

# I'd split the native implementation into three pieces

| Component                          | Responsibility                                          |
| ---------------------------------- | ------------------------------------------------------- |
| `effect-native-foldkit-remote`     | Rust implementation of Remote protocol/server semantics |
| `effect-native-foldkit-remote-sql` | Entity/query/storage IR → SQL/SQLx                      |
| existing `foldkit-remote`          | Browser Model/cache/planner, unchanged                  |

The npm-facing integration doesn't necessarily need three packages; that's more the internal architecture.

The Rust side might produce crates like:

```text
effect_native_remote
effect_native_remote_sqlx
```

and the compiler links them only when needed.

---

# A native RemoteServer can also specialize aggressively

Because the domain is known at compile time:

```text
Entities:
  Project
  User
  Comment
```

we don't need a completely generic server runtime.

The compiler can generate:

```rust
enum EntityKind {
    Project,
    User,
    Comment,
}
```

and entity-specific field sets.

A request like:

```text
Project:p1 [id,name,owner]
Project:p2 [id,name]
```

can normalize to:

```text
Project batch

ids:
  p1
  p2

fields:
  id | name | owner
```

using compact masks.

Authorization can mask fields:

```text
requested:
  11101

allowed:
  10101

effective:
  10101
```

Nested traversal becomes generated dispatch.

This could make `remote-server` **very cheap** natively.

---

# And the normalized data format maps cleanly to Rust

Remote's core wire model is essentially:

```text
entity ref
field patches
settled fields
connections
boundaries
query inputs
mutation outputs
live changes
```

All of those are strongly tagged data.

That means native types like:

```rust
enum Boundary {
    Terminal,
    Cursor(String),
    Unknown,
}

enum LiveChange {
    Patch(...),
    Delete(...),
    ConnectionInsert(...),
    ConnectionRemove(...),
    Invalidate(...),
}
```

rather than arbitrary JS values.

Schema/codegen can make serialization automatic.

---

## This might be a better early milestone than generic SQL

> **Later update:** The later [milestone sequence](../PLAN.md#implementation-sequence) adopts this direction: Query evaluator conformance at 1, native RemoteServer at 4, and Query → SQLx at 5. Use that order rather than the tentative alternatives below.

I'd now order the demo path roughly as:

1. **Effect Native unary RPC**
2. **Native `foldkit-remote-server` with in-memory Sources**
3. **Stock browser `foldkit-remote` talking to that Rust server**
4. **`Query.define` conformance suite running against a Rust interpreter**
5. **SQLx backend for `remote-drizzle`/storage bindings**
6. **native liveHub + streaming RPC**
7. **native Foldkit SSR + `Data.satisfy` + Remote resume**
8. **one generated binary serving Foldkit pages + Remote RPC + SQLx**

That final demo would be unusually compelling:

```text
TypeScript source
────────────────────────────────

Foldkit
Foldkit-Plus Remote
Effect
Effect RPC
Effect Schema
Entity/Query definitions


             COMPILE


Rust binary
────────────────────────────────

Axum / Hyper
Tokio
Native Effect RPC
Native RemoteServer
SQLx
Native Foldkit SSR

             ↕
          Postgres


Browser
────────────────────────────────

normal Foldkit
normal foldkit-remote
normal Effect RpcClient
```

And the biggest reason I like it is that this isn't forcing Rust onto an architecture that wasn't designed for it.

**`foldkit-remote` already has the compiler/interpreter seams.** `Query.define` is already an IR. `remote-server` is already an interpreter. `remote-drizzle` is already one compiled backend. The conformance suite already anticipates another interpreter. Sources already keep runtime dependencies explicit via Effect. RPC transport is already separate.

So yes: I would explicitly design `effect-native` so **`doeixd/foldkit-plus/remote` is a first-class target**, not merely an application someone could theoretically build on top of it.
