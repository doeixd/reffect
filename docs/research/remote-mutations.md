# Native Remote mutations, Store and authorization (step 4)

Status: **proposed (2026-10-03)**, not implemented. Step 4 of the [native RemoteServer design](native-remote.md#order-of-work) (NR-005) and [milestone §21](../implementation-milestones.md#21-authorization-must-become-portable). Read from `foldkit-remote-server` 0.10.0 (`handlers.FoldkitRemoteMutate`, `MutationSource`, `MutationOutcome`, `memory`'s `MemoryStore`, `allowedFields`), its memory test's `Rename` mutation, and `foldkit-remote` 0.10.0 (`Remote.patch`, `connectionIdentity`).

## What the reference does

- **Handler.** An unknown mutation → `RemoteMutationError("Unknown mutation: <name>")`. The input is decoded with the mutation's `Input` schema (`decodeUnknown`, not the JSON codec); failure → `"Invalid mutation input"`. Then `run({ input, principal })`; a source's `RemoteServerError` → `RemoteMutationError(message)`. The output is encoded with `Output`; failure → `"Invalid mutation output"`. The result is `{ output, entities, connections, deleted }`.
- **Memory backend.** Mutations are **user callbacks** given the `MemoryStore`:
  - `rows(entity)`;
  - `write(entity, id, values)`, which sets `{ ...existing, id, ...values }` and keeps a new row's position at the end;
  - `remove(entity, id)`.

  The next read sees the change. A typical body writes the store and returns `Remote.patch(Entity, id, values)` and connection changes (`RemoteServer.prepend/append/remove(connection, ref)`).

- **Authorization.** An entity source's optional `authorize(principal, fields) → fields` filters the declared, requested fields. Only requested fields survive, even if it returns more (`allowedFields`). The memory backend authorizes nothing.

## Options

| Option                                                               | Assessment                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: R-authored mutation functions over a native `RemoteStore` service | Mirrors upstream (a mutation is code given the store). Needs R surface that mostly exists: services, `R.Struct`/`R.Record`/`R.UndefinedOr`, `Effect.fail`. Adds three things: a server-lifetime mutable store service, typed-value → `Unknown` encoding, and record construction |
| B: declarative mutations (create/update/delete patches as data)      | Simpler to execute, but invents an API upstream does not have; most real mutations need logic                                                                                                                                                                                    |
| C: keep mutations in JS (hybrid host)                                | Milestone 9 territory; contradicts "fully native" for this milestone                                                                                                                                                                                                             |

## Proposed decisions

- **RM-001 — Option A, mirroring `RemoteServer.mutation(Mutation, run)`.** `NativeRemote.mutation(Mutation, fn)` binds an R `EffectFn` whose input witness is derived from `Mutation.Input` (decodeUnknown semantics, as NR-015). The function returns a `MutationOutcome` R struct: `output` (the `Mutation.Output` witness), optional `entities`/`connections`/`deleted`. Failing with the R witness of `RemoteServerError` becomes `RemoteMutationError(message)`.
- **RM-002 — `RemoteStore` as a native service.**
  - Exposed to R as a service with `get(entity, id) → UndefinedOr<Record<String, Unknown>>`, `write(entity, id, values)` and `remove(entity, id)`. Each follows `MemoryStore` exactly, including spread order and new-row position.
  - The memory tables move behind a `Mutex` in server-lifetime state (reusing the server-layer machinery).
  - Reads, queries and mutations see one store. Requests that run concurrently serialize on the store, which matches the single-threaded JS reference.
- **RM-003 — encoding typed values into `Unknown`.** `R.Json.encode(witness)(value) → Unknown` uses the witness's JSON codec, the generated encoders natively, exactly as `Schema.encode(toCodecJson(...))`. Building a `values` record needs `R.Record.fromEntries` (or `set`), mirroring `effect/Record`.
- **RM-004 — authorization as a compiled R function (§21 option 1).**
  - `NativeRemote.entity(Entity, { authorize })` takes an R function `(principal, fields: Array<String>) → Array<String>`. The engine keeps only declared, requested fields that the result lists, ported from `allowedFields`.
  - The principal comes from the checked bearer adapter (u64) or `Unit` for public servers. R already has `Array.filter`, string equality and booleans, so typical rules ("owner sees `email`") compile today.
- **RM-005 — `connectionIdentity` and patch helpers as R functions.** `Remote.patch` and `RemoteServer.prepend/append/remove` become R builders producing the wire structs. A connection identity is the query name plus canonical input text, which needs canonical JSON of the input, so it waits for RM-003.

## RM-002 refined: `RemoteStore` as a service implementation (2026-10-03)

The Store is not an R value. It is a native resource whose operations the runtime implements: the **service implementation** family of [runtime lowering](../runtime-lowering.md#three-implementation-registries). It follows the [Clock/Random precedent](clock-random-modules.md) (CLOCK-001/002).

- **RS-001 — store operations are effect nodes.**
  - `R.RemoteStore.get(entity, id)` returns `Computation<UndefinedOr<Record<String, Unknown>>, never>`.
  - `write(entity, id, values)` and `remove(entity, id)` return `Computation<void, never>`.
  - Each node has a semantic effect identity and a reachable `RemoteStore` requirement. Derivation, checking, provenance and lowering must recognize the nodes, and graph construction never touches the store.
- **RS-002 — the reference uses upstream's own store.** The reference interpreter provides the requirement from an Effect `Context.Service` whose memory implementation is the `MemoryStore` returned by `RemoteServer.memory(...)` (`rows`/`write`/`remove`, with `get` as a lookup in `rows`). Store semantics therefore come straight from the published package, without vendoring.
- **RS-003 — native implementation selected while planning.**
  - The memory store lives in server-lifetime state, and Read and Query use the same store.
  - The plan explanation lists it as a service implementation. A later SQLx implementation (milestone 5) satisfies the same requirement.
  - Generated functions receive it through the invocation-owned execution context, never a hidden global.
- **RS-004 — ordering and concurrency.** The memory operations are synchronous and the reference runs them between awaits. Native requests are dispatched on one `current_thread` runtime, and store operations hold the lock per operation, so a request's operations interleave with others exactly where the reference's can, at suspension points. Asynchronous sources (SQLx) must record their own isolation policy.
- **RS-005 — caches follow the store.** Writes and removes bump a store version. Per-query evaluator cells (BENCH, query cache) are keyed by that version, so a read after a write sees the change, as `memory`'s next read does.
- **RS-006 — ownership (BENCH-002).** Stored rows are shared immutable values (`Arc`), so reads hand out shared rows rather than deep copies, and `write` replaces a row (`{ ...existing, id, ...values }`) copy-on-write. This is the first workload where the ownership stage shares instead of cloning.

### Store progress

- **Phase A (engine, 2026-10-03): done.** `remote_engine::Memory` holds the tables behind one `RwLock` with a version counter. Rows are `Arc<JsObject<Value>>` (JS own-property order, so a written index key lands where JS puts it). `get`/`write`/`remove` follow `MemoryStore`: `{ ...existing, id, ...values }`, a new row last, `remove` then `write` appends again. Query cells are cached per store version (RS-005). A query takes its page from one view of the table and releases the lock before reading the selected rows, as upstream reads them. Read and Query behaviour is unchanged.
- **Open for phase B:** NR-017 checks only the embedded rows against query field kinds. A written value outside a query's kinds makes the native evaluator refuse that query, while the JS evaluator compares any value. Writes either need the same check at the `RemoteStore` boundary (typed `values`) or the evaluator needs JS comparison semantics for mixed kinds; record the choice with RS-001.

## Typed values refined (2026-10-03)

Checked against `foldkit-remote` 0.10.0 `index.d.mts`: `Remote.patch(entity, id, values)` and `Entity.patch` take `Partial<Schema.Struct.Encoded<F>>`, the entity's **wire-shaped** values. The memory store holds the same shape. Mutations therefore never need hand-built `Unknown` values; they need typed values encoded the way the wire encodes them.

- **RM-006 — one encoding primitive, mirroring Effect.** `R.Schema.encodeSync(R.Schema.toCodecJson(witness))(value) → Unknown` is a pure expression node (encoding admitted witnesses cannot fail), spelled as Effect v4 spells `Schema.encodeSync(Schema.toCodecJson(S))`.
  - The reference runs official `Schema.encodeSync(Schema.toCodecJson(witness.schema))`.
  - Natively, the generated module declares a `ToJson` trait and lowers the node to `ToJson::to_json(&value)`. The RPC server crate implements `ToJson` for each witness the node reaches, with the NativeRpc encoders already verified against the official codec (numbers, optional keys, JS key order, literals, tagged unions). This avoids a second, unverified encoder in core lowering.
  - Outside an RPC host there are no `ToJson` impls; such functions already reach `Unknown`, which the native runner excludes, so the node is refused there rather than failing in Cargo.
- **RS-001 refined — typed store writes.** `write(entity, id, values)` takes any Struct witness and stores its JSON encoding, so a row keeps the entity's wire shape. That is narrower than upstream's untyped `Record<string, unknown>` (spreading a non-object is not admitted) and settles the NR-017 question for written rows: the values are the entity's own encoded field types. `remove(entity, id)` is unchanged. `get` returns raw `Unknown` rows and waits for typed decoding (`Schema.decodeUnknown`, fallible) with the first mutation that needs it.
- **RM-001 refined — patches and outcomes.** `NativeRemote.patch(Entity, id, values)` builds `{ entity, id, values: encode(values) }`, checking at authoring time that `values` is a Struct whose fields are declared entity fields with the witnesses of their encoded schemas. All patches share one Struct type, so `entities` stays an ordered Array as upstream returns it. `connections` waits for RM-005.

## Order of work

1. RM-002 store with read/query sharing it (no behaviour change). **Done (phase A).**
2. RM-006 typed → `Unknown` encoding, tested over NativeRpc against the official server.
3. `RemoteStore` write/remove nodes (RS-001), tested through mutations.
4. RM-001 mutations, with Rename-style and create/delete scenarios ported from the memory and server tests, compared over the wire and through `Data.mutate` acceptance.
5. RM-004 authorization, with nested-authorization scenarios from `nested.test.ts` (authorized levels, a relation the principal may not read).

## Open questions

- Should mutation outputs encode through `Output`'s JSON codec natively (exact, but needs output codecs for arbitrary schemas), or must the R function produce the encoded form?
- How should concurrent mutations behave in Rust (one Mutex) compared with JS's run-to-completion between awaits? They are identical for synchronous bodies; asynchronous sources need a recorded policy.
- Should `RemoteServer.memory` export its server definition upstream (removing vendored fixtures), and should `RemoteRpcClient` admit `RpcClientError`? Both are recorded as upstream suggestions.
