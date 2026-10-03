# Native RemoteServer design

Status: **proposed (2026-10-02)** for [milestone 4](../implementation-milestones.md#20-milestone-4--native-foldkit-remoteserver). It follows the [gap analysis](remote-gap-analysis.md). Reference: `foldkit-remote-server` 0.9.0 and `foldkit-remote` 0.9.0 (published; read at `foldkit-plus` `67cf3735`: `remote-server/src/index.ts`, `remote/src/{wire,relation,requirement,query}.ts`).

## What the reference server does

`RemoteServer.handlers(server, principal, options)` answers `RemoteRpc`:

- **Read** (`readHelper`). It checks the protocol version, the ids per entity (default 1,000) and the pages per relation (4), then resolves level by level up to depth 8. On each level it:
  1. splits each request's aliased fields (`comments@first=10`) into reads of their own (`splitAliases`);
  2. groups requests per entity and per `stableStringify` of their windows and renames (`groupByEntity` with `Requirement.mergeRelation`);
  3. filters fields to those the entity declares, then through `authorize`;
  4. settles refused fields per id;
  5. reads at most 1,000 ids per Source call and renames values back to their aliases;
  6. settles fields a record omits;
  7. records fetched fields and values, and follows relation refs (`refsIn`: a ref key string, an array of keys, or a page `{ refs, hasNext, hasPrevious }`) into the next level, skipping fields already fetched.

  Source failures become `RemoteReadError`.

- **Mutate.** An unknown mutation is refused. Input is decoded with the mutation's own `Input` schema (failure → `Invalid mutation input`); the Source runs; output is encoded with `Output`; entity patches, connection changes and deletes are returned.
- **Query.** An unknown query is refused, input is decoded per query, the select's pages are checked, and the Source runs. With a `select`, the page's items of the selected entity become read requirements, answered in the same response.
- **Memory backend** (`RemoteServer.memory`). Rows are given at build time, relation pages are windowed by `pageOf` (cursor semantics, `Terminal`/`Cursor`/`Unknown` boundaries, an empty page for an unknown cursor), and queries run the Query body through the `foldkit-entity` reference evaluator. It authorizes nothing.
- **Live** streams through a hub (milestones 6–7).

Order is observable. Read order and the order of returned `entities` follow JS own-property order of request records (integer-like keys first, ascending; then insertion order), and group keys use `stableStringify`, which sorts keys by UTF-16 code units.

## Options

| Option                                                                                                    | Assessment                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1: author the engine in R and compile it                                                                | R has no maps, sets or dynamic keys yet, and the algorithm is driven by client strings; this waits for those language features                                                                                               |
| **R-2: a literal semantic port of the engine as a Rust runtime module**, parameterized by generated parts | Matches the milestone-1 precedent (a checked Query adapter with a ported Rust evaluator). Observable ordering and alias rules are easiest to preserve line for line. Differential testing against the reference is direct    |
| R-3: a domain-specialized generated engine (entity/field enums, selection bitsets) from the start         | [`foldkit-remote.md`](../foldkit-remote.md#foldkit-remote-server-is-the-part-wed-implement-natively)'s optimization. It is more code before any conformance exists; it fits better as a later pass behind the same interface |

## Decisions (proposed)

- **NR-001 — semantic-port runtime.** A Rust module ports `readHelper`, `splitAliases`, `groupByEntity`, `mergeRelation`, `refsIn`, `stableStringify` and the limits literally, operating on `serde_json` values. It is a dedicated Foldkit semantic runtime, distinct from Effect operation implementations in the registry, and selected only when a Remote server is compiled. Domain specialization (R-3) comes later, with measurements.
- **NR-002 — the wire is generated from the unchanged `RemoteRpc` group.** Request and response codecs come from NativeRpc composite codecs with exact invalid-input parity. This needs `Schema.Number` (JSON doubles with non-finite strings, safe-integer checks), `optional`/`optionalKey` (including `optionalKey(Never)` on the last relation level), `Record` with JS key order, array length checks, `TaggedError` classes in error unions, and `Unknown` as raw JSON passthrough (values and inputs are produced and decoded by the engine, never by IR).
- **NR-003 — JS ordering.** The runtime uses an ordered map with JS own-property order (canonical array-index keys below 2^32 − 1 first, numerically; others in insertion order), and `stableStringify` compares keys by UTF-16 code units, not by Rust's byte order.
- **NR-004 — the first backend is the memory backend.** `NativeRemote` takes the `foldkit-remote` domain descriptor and its rows at build time. Queries declared with `Query.define` reuse the milestone-1 Query adapter's Rust evaluator. Read and Query come first; memory mutations (JS callbacks) wait for compiled Sources.
- **NR-005 — compiled Sources and authorization come next.** Entity reads become R functions returning typed rows (`R.Struct` of the entity's declared fields, with optional fields for omission), projected and encoded by the engine with per-entity field codecs. Mutation and query Sources become R `EffectFn`s with typed Input/Output. `authorize` becomes a compiled function or a declarative rule (milestone §21). The principal flows from the existing checked bearer adapter.
- **NR-006 — Live is deferred** to milestones 6–7; the native server refuses `FoldkitRemoteLive` explicitly rather than returning an empty stream.

- **NR-007 — versions: assume foldkit-plus moves to Effect 4.0.0 stable.** This is an assumption, not yet a published fact (recorded 2026-10-02). See [Versions](#versions).

## Versions

Checked 2026-10-02 with `npm view` and a scratch install:

- Effect **4.0.0** stable was published on 2026-10-01 and is npm `latest`. rc.118 was published on 2026-09-28. reffect pinned rc.118 and moved to 4.0.0 on 2026-10-02 (see below).
- `foldkit` 0.165.0 already declares the peer `effect: 4.0.0`.
- `foldkit-remote`/`foldkit-remote-server` 0.9.0 declare `effect >=4.0.0-rc.116 <4.0.0-rc.118`. The range is accurate: rc.118 moved `effect/unstable/rpc`, `effect/unstable/http` and `effect/unstable/httpapi` to `effect/rpc`, `effect/http` and `effect/http-api` (4.0.0 matches rc.118). Importing Remote 0.9.0 under rc.118 fails with `ERR_MODULE_NOT_FOUND …/effect/dist/unstable/rpc.js`. Running it under rc.118 is not an option.
- Remote 0.9.0 depends on `foldkit-entity` 0.5.0, while reffect pins 0.4.0. The published `dist` differs between the two versions, and the differences have not been reviewed yet.

**Assumption (user decision, 2026-10-02):** foldkit-plus (`foldkit-remote`, `foldkit-remote-server`, `foldkit-entity` and the related packages) will be upgraded to Effect 4.0.0 stable. Consequences:

- reffect does not run the reference Remote server in an isolated rc.116 process, and does not vendor or patch it.
- The wire slices (order of work, step 1) do not need the Remote packages at runtime. Their tests declare Remote's schemas locally, exactly as `foldkit-remote`'s wire module does, against the official server on reffect's own Effect version.
- Before the differential harness (step 2), reffect moves its pin from rc.118 to 4.0.0 in a focused commit and reruns the Effect-sensitive suites: Schema formatter messages, RPC, and Layer/Scope. It then adds the upgraded foldkit-plus releases as dev dependencies.
- The Query adapter's conformance is rechecked against the `foldkit-entity` release that the upgraded Remote depends on (0.5.0 or later), not against 0.4.0.
- If the upgraded releases are not available when step 2 starts, the harness waits; the wire slices continue.
- **Done 2026-10-02:** the oracle pin moved to Effect 4.0.0 (and `@effect/platform-node` 4.0.0), ahead of step 2, so the remaining wire slices are checked against the release Remote will use. Comparing the rc.118 and 4.0.0 sources showed only internal changes in the modules reffect uses:
  - union candidate indexing and codec member ordering;
  - HTTP request scopes now close with the failure cause.

  The full suite passes; six heavy native suites timed out under parallel Cargo builds and pass 17/17 when run serially.

**Upgrade status (checked 2026-10-02):**

- foldkit-plus `main` already moved to Effect 4.0.0 in commit `7e3ffdd0` ("deps: Effect 4.0.0 stable and Foldkit 0.165.0"). In remote and remote-server, only import paths changed (3 lines across `wire.ts` and `persistence.ts`); the changelog states behaviour is unchanged.
- Release 0.13.0 is prepared but not committed or published: `foldkit-remote`/`foldkit-remote-server` 0.10.0 and `foldkit-entity` 0.6.0. npm still serves 0.9.0/0.5.0.
- Once published, the vendored wire fixture can be replaced by the real `RemoteRpc` (identical schemas expected), and `RemoteServer.memory` + `handlers` become the engine oracle without vendoring engine code.
- The reference read path is about 400 lines (`readHelper`, `splitAliases`, `groupByEntity`, `pageOf`, `memory`), and its scenario tests are about 2,000 lines (memory, nested, nestedShared, alias, queryPayload, server). Effect 4.0.0's reversed `partition` does not affect reffect (no calls).

## Open questions

- Whether foldkit-plus changes any Remote wire schema during the 4.0.0 upgrade. The locally mirrored schemas must be re-diffed against the upgraded `foldkit-remote` wire module.
- Whether native `entities` arrays can expose a different but equivalent order when the client cache is order-insensitive. Until shown, order is preserved exactly.

## Acceptance

1. A scenario harness: a domain, rows and a sequence of RPC payloads, answered by the official `RpcServer` with `RemoteServer.memory` handlers and by the native server. Parsed response JSON is identical for success, typed errors and invalid input. Scenarios are ported from `memory`, `nested`, `nestedShared`, `alias`, `queryPayload` and `server` tests (excluding live).
2. A stock `Remote.clientLayer(RpcClient.make(RemoteRpc))` over HTTP reads and queries through the native server with no native-specific client code.
3. NativeRpc codec slices for the wire features in NR-002 each land with their own exact-parity tests first.

## Engine design (step 2, accepted 2026-10-02)

Read from the `foldkit-plus` source at `main` (`7e3ffdd0`):

- `remote-server/src/index.ts`: `readHelper`, `splitAliases`, `groupByEntity`, `allowedFields`, `windowsOf`, the limit checks, `pageOf` and `memory`.
- `remote/src/{relation,requirement,query}.ts`: `refsIn`, `aliasedField`, `mergeRelation`, `stableStringify`.

- **NR-008 — validated payloads become one recursive engine model.**
  - The generated codecs validate and decode the payload exactly as the official server does. The decoded value is re-encoded (dropping excess keys; a present `undefined` becomes `null`) and read into one recursive Rust `Requirement` type (entity, id, fields, windows, relations), whose optional members are `Option`s.
  - Absent and `undefined` are indistinguishable throughout the reference read path (`?? null`, `!== undefined`, `stableStringify` dropping `undefined`, whole-window spreads), so this model is exact.
  - The eight generated relation levels collapse into the one type; the last level simply never has relations.
- **NR-009 — JS collection semantics.** Ported code uses insertion-ordered maps and sets where the reference uses `Map`/`Set`. A `JsObject` type keeps canonical array-index keys first, ascending, then insertion order, wherever the reference builds or iterates plain objects: `Object.entries(relations)`, `values` built on `Object.create(null)`, and spreads that keep a key's first position while replacing its value. Row `values` are `Unknown` JSON in that order (UNK-002).
- **NR-010 — JS text where the reference formats.**
  - Errors carry the reference's exact messages: `Too many "<entity>" ids in one read batch`, `Too many pages of "<entity>.<field>" in one read`, `Nested selection deeper than 8 relation levels`, and `Remote protocol version <n> is not 4`.
  - Numbers in messages and in `stableStringify` follow `Number.prototype.toString`, via [`ryu-js`](native-types.md); this is the first workload that needs byte-exact number text.
  - `stableStringify` sorts keys by UTF-16 code units, not Rust byte order.
- **NR-011 — sources behind one interface.**
  - Each entity source is a Rust value with `entity`, optional declared `fields`, an optional `authorize`, and a `read(ids, fields, windows)` that returns a future. Memory reads are ready immediately, and SQLx (milestone 5) will be truly asynchronous. A source failure becomes `RemoteReadError` with its message.
  - The memory backend ports `valueFor` (relation pages over stored ref lists, cursor as ref key or bare id, an unknown cursor giving an empty page) and `pageOf`. Rows are embedded at build time as JSON.
- **NR-012 — packaging.**
  - The engine is a Rust runtime module emitted only when a Remote server is compiled, with `indexmap` and `ryu-js` declared in that case alone.
  - `NativeRemote.compile` takes the Remote wire group, a domain description (entity names and declared fields) and memory rows. It generates the Read handler from the engine, and refuses procedures it cannot serve (`Live`, NR-006; Mutate and Query until steps 3–4).
- **NR-013 — oracle.**
  - The differential harness serves the reference `RemoteServer.handlers` over the official `RpcServer`, using sources equivalent to the memory backend. It drives scenarios ported from `remote-server`'s memory, nested, nestedShared, alias and server tests (excluding live) against both servers, and compares raw JSON, key order included.
  - `RemoteServer.memory` exposes only its store and an in-process client layer, not its `ServerDefinition`. Until it does, the harness builds the memory sources with `RemoteServer.entity` and a read ported from `memory` (MIT, recorded as vendored).
  - An upstream export of the memory backend's server definition would remove that duplication.

## Query design (step 3, accepted 2026-10-02)

Read from `foldkit-remote-server` 0.10.0 (`handlers.FoldkitRemoteQuery`, `memory`'s query sources) and `foldkit-entity` 0.6.0 (`evaluate`, `ordered`):

- **NR-014 — the domain drives Query.**
  - `NativeRemote.compile(group, { domain, rows })` takes the same `Remote.define`/`Remote.make` descriptor as `RemoteServer.memory`. Entity sources come from `registry.entities`, and query sources from `registry.queries`.
  - A query without a `Query.define` body is refused while compiling, as `memory` refuses it when made.
- **NR-015 — bodies reuse the milestone-1 evaluator.**
  - Each body, plus an order-only twin (`where: []`) for keyset `locate`, is compiled by the [Query adapter](foldkit-query.md) into `r_<name>(input, rows)`. Rows are encoded per slot; an absent field is `null`, as `isNull` treats `undefined`.
  - Memory rows are checked against each query's field kinds while compiling.
  - Inputs are validated with `Schema.decodeUnknown` semantics, not the JSON codec. That means a Struct of primitive fields (string, number, boolean, null, literals, and their unions) with required keys, ignoring excess keys; other `Input` schemas are refused. Encoding such an input is the identity.
- **NR-016 — handler and paging, ported exactly.** The handler steps:
  - unknown query → `Unknown query: <name>`;
  - invalid input → `Invalid query input`;
  - the select page limit → `Too many pages of "<entity>.<field>" in one query select`;
  - the source run, then `pageOf` with `locate`. Window conflicts, missing cursors and `Cursor "<c>" names a row that no longer exists` all become `RemoteQueryError` with the reference text;
  - edges `{ entity, id, key }`, then `select` through the read engine. Read errors become `RemoteQueryError` with the same message.
- **NR-017 — recorded divergence: evaluation refusal text.**
  - The milestone-1 runtime refuses exactly when upstream `evaluate` throws, in this profile: ordering when two or more matched rows have a null or mixed-kind key. Its message differs, because upstream names the first pair its sort happened to compare. The error class and the absence of results are identical.
  - Non-ASCII containment, which upstream evaluates with `toLowerCase`, is refused natively (milestone-1 three-interpreter profile).

## Order of work

1. Wire features (NR-002), each as a small NativeRpc codec slice, ending with the full `RemoteRpc` Read/Query payloads compiling with parity. **Done 2026-10-02.** The slices were:
   - [numbers](number-profile.md);
   - [optional fields](optional-fields.md);
   - [records](records-js-order.md);
   - [length checks](array-length.md);
   - [TaggedError](tagged-errors.md);
   - [Unknown](unknown-json.md);
   - [literal unions](literal-unions.md);
   - plain `Schema.String` (STR-008).

   The vendored, unchanged contract ([fixture](../../packages/reffect/tests/fixtures/foldkit-remote-wire.ts)) compiles for Read, Mutate and Query, and matches the official server ([remote-wire-rpc.test.ts](../../packages/reffect/tests/remote-wire-rpc.test.ts)). `Live` is refused as a streaming procedure (NR-006). `NativeRpc.witness(schema)` derives the R witness of any contract schema for handlers and the engine.

2. Move the oracle pin to Effect 4.0.0, then the engine port and memory backend for Read (NR-001, NR-003, NR-004), with the differential harness against the upgraded foldkit-plus releases (NR-007). **Read done 2026-10-02:**
   - [`remote-engine.ts`](../../packages/reffect/src/remote-engine.ts) ports `readHelper`, alias splitting, grouping, limits and the memory backend's paging into a Rust module.
   - `NativeRemote.compile(group, { entities, rows })` serves `FoldkitRemoteRead` through a NativeRpc runtime hook (`compileServer`), after generated validation.
   - [remote-read.test.ts](../../packages/reffect/tests/remote-read.test.ts) compares 27 wire scenarios with the published-shape `RemoteServer.handlers`. The scenarios cover aliases, pages, cursors, cycles, shared targets, nested chunking past 1,000 ids, both limits and JS-formatted version messages. Raw responses are equal, key order included.
   - Mutations that drop window grouping or `ryu-js` number text fail the test.
   - Recorded divergences:
     - Field names that are `Object.prototype` members (`constructor`, `toString`): the reference's `in`/`renames[...]` lookups see prototype values; native sees own keys only.
     - Memory rows must keep relation lists as string refs (checked while compiling).
3. Query with the Query evaluator, then query `select`. **Done 2026-10-02:**
   - `FoldkitRemoteQuery` is served from the domain's `Query.define` bodies through `Foldkit.embed` (the milestone-1 evaluator plus an order-only twin for `locate`), with ported `pageOf` and `select` through the read engine.
   - [remote-query.test.ts](../../packages/reffect/tests/remote-query.test.ts) compares 22 scenarios with the published handlers and memory query sources. They cover pages both ways, cursors that stopped matching or are gone, window conflicts, containment, descending order, input validation, unknown queries, and `select` including the page limit. Responses are equal, raw key order included.
   - NR-017 is asserted explicitly. A mutation that makes `locate` exact fails the test.
4. Compiled Sources, authorization and mutations (NR-005). **Mutations done 2026-10-03** ([remote-mutations.md](remote-mutations.md#mutations-as-implemented-2026-10-03)):
   - R mutation sources run over a writable memory store, with typed patches and outputs.
   - `FoldkitRemoteMutate` matches the published handler over upstream's own `MemoryStore` in a 23-step stateful corpus.
   - Authorization (RM-004) and connection changes (RM-005) remain.

**Acceptance (2026-10-03):** a stock `Remote.clientLayer` over an Effect RPC HTTP client reads and queries through the native server, and its projections equal upstream `RemoteServer.memory(...).layer` ([remote-acceptance.test.ts](../../packages/reffect/tests/remote-acceptance.test.ts)).

It also **mutates**:

- `Remote.mutateInto` reconciles a native rename into the model.
- A refused rename returns its message.
- A store-free source (compiled synchronously) echoes its input.
- A fresh read sees the write.

All of it equals upstream's memory layer, whose sources run the same R functions over its own `MemoryStore`. Authorization, connection changes and Live remain.

## Milestone 4 status (2026-10-03)

Checked against [implementation milestones §20](../implementation-milestones.md#20-milestone-4--native-foldkit-remoteserver), within the memory profile and the [divergence register](../native-divergences.md):

| §20 scope                                                         | Evidence                                                                                                                                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requirement validation, limits                                    | [remote-wire-rpc](../../packages/reffect/tests/remote-wire-rpc.test.ts), [remote-read](../../packages/reffect/tests/remote-read.test.ts)                                    |
| Field grouping, ID deduplication, nested traversal, normalization | [remote-read](../../packages/reffect/tests/remote-read.test.ts) (28 scenarios)                                                                                              |
| Field authorization (§21, compiled R functions)                   | [remote-auth](../../packages/reffect/tests/remote-auth.test.ts)                                                                                                             |
| Query execution                                                   | [remote-query](../../packages/reffect/tests/remote-query.test.ts)                                                                                                           |
| Mutations, connection changes, compiled sources                   | [remote-mutate](../../packages/reffect/tests/remote-mutate.test.ts)                                                                                                         |
| Stock `Remote.clientLayer` with no native-specific client code    | [remote-acceptance](../../packages/reffect/tests/remote-acceptance.test.ts), [todo-remote example](../../examples/todo-remote/README.md): reads, queries, mutations in Node |

**Accepted in Node, with one item outstanding:** a real browser running a stock Foldkit app against the native server. That needs CORS or a same-origin host, and has not been demonstrated yet.

Out of milestone 4 by design:

- `Live` (milestones 6–7);
- SQL storage (milestone 5);
- `RemoteStore.get`, which no workload has needed yet;
- arbitrary principal types, beyond the `u64` bearer profile.
