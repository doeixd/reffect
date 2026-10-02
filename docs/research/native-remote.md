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

## Open questions

- Whether foldkit-plus changes any Remote wire schema during the 4.0.0 upgrade. The locally mirrored schemas must be re-diffed against the upgraded `foldkit-remote` wire module.
- Whether native `entities` arrays can expose a different but equivalent order when the client cache is order-insensitive. Until shown, order is preserved exactly.

## Acceptance

1. A scenario harness: a domain, rows and a sequence of RPC payloads, answered by the official `RpcServer` with `RemoteServer.memory` handlers and by the native server. Parsed response JSON is identical for success, typed errors and invalid input. Scenarios are ported from `memory`, `nested`, `nestedShared`, `alias`, `queryPayload` and `server` tests (excluding live).
2. A stock `Remote.clientLayer(RpcClient.make(RemoteRpc))` over HTTP reads and queries through the native server with no native-specific client code.
3. NativeRpc codec slices for the wire features in NR-002 each land with their own exact-parity tests first.

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

2. Move the oracle pin to Effect 4.0.0, then the engine port and memory backend for Read (NR-001, NR-003, NR-004), with the differential harness against the upgraded foldkit-plus releases (NR-007).
3. Query with the Query evaluator, then query `select`.
4. Compiled Sources, authorization and mutations (NR-005).
