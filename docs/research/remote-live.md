# Native Remote Live (milestone 7)

Status: **steps 1–3 delivered (2026-10-03)**. Review fixes LR-1, LR-2 and LR-4 are delivered. LR-3 is delivered for Foldkit's `Data.live` Subscription entry and reducer. The browser app's live rendering remains open. See [Review](#review-2026-10-03) and the [improvement plan](#improvement-plan-2026-10-03). It begins [milestone 7](../implementation-milestones.md#25-milestone-7--native-foldkit-remote-live) and absorbs milestone 6 step 5 (the `FoldkitRemoteLive` skeleton, [streaming-rpc](streaming-rpc.md#order-of-work-and-acceptance)). It closes NR-006 ([native-remote](native-remote.md#decisions-proposed)) once delivered.

Sources, read 2026-10-03 from the installed packages (foldkit-plus 0.14.0):

- `foldkit-remote-server` 0.11.0 `dist/index.mjs`: `liveHub`, `RemoteServer.live`, `handlers.FoldkitRemoteLive`, `checkIdsPerEntity`, `checkPagesPerRelation`, `protocolMismatch`. `index.d.mts`: `LiveHub`, `LiveSource`, `HandlerOptions.live`/`maxIdsPerEntity`.
- `foldkit-remote` 0.11.0 `index.d.mts`: `LiveRequirement`, `LiveChange`, `Live` (the `FoldkitRemoteLive` RPC), `REMOTE_PROTOCOL_VERSION = 4`, `liveEventOf`, `classifyLive`.
- `effect` 4.0.0: `Stream.fromQueue = fromChannel(Channel.fromQueueArray(queue))`, which pulls with `Queue.takeAll` (wait for one element, then take every queued one). `Stream.mergeAll(streams, opts) = flatten(fromIterable(streams), opts)`.
- `foldkit-remote-drizzle` 0.9.1 has no live support and runs mutations without a transaction.

## What the reference does

**The hub.** `RemoteServer.liveHub(entities)` returns `{ subscribe, changed, deleted, size }` over the given entity sources. Nothing pushes to it on its own: the application calls `hub.changed(ref, fields)` or `hub.deleted(ref)` "from wherever the data changes (a mutation source, a database trigger)". The memory backend "does not push live changes".

- **`subscribe({ requirements, after, principal, maxIdsPerEntity })`** is a `Stream.unwrap`:
  1. Limits. More than `max(1, maxIdsPerEntity ?? 1000)` distinct ids of one entity fails with `RemoteServerError("Too many \"<entity>\" ids in one live subscription")`. More than the page limit of aliases of one relation field fails with `"Too many pages of \"<entity>.<field>\" in one live subscription"`. These are the Read checks with live wording.
  2. `selected`: a map keyed `entity:id`, in first-requirement order. Each entry holds the union of requested fields (a set) and the windows per field (last requirement wins).
  3. A subscriber `{ selected, principal, queue: unbounded, cursor: after }` is added to a `Set` (insertion order).
  4. The stream is `Stream.fromQueue(queue)` with `Stream.ensuring` deleting the subscriber, so a disconnect unsubscribes.
- **`changed(ref, fields)`.** No entity source for `ref.entity` means nothing happens. Otherwise, for each subscriber selecting `entity:id`, in subscription order:
  - grouped by principal (a `Map`, first-seen order), then by `stableStringify(windows) \0 stableStringify(renames)`;
  - plain wanted fields are `fields` filtered by the selection, in the order of `fields`, joined with their windows and no renames;
  - each selected alias whose underlying field changed and which has a window joins its own group, `{ [field]: window }` renamed `{ [field]: alias }`.

  Then, per principal and group:
  - `allowedFields(source, principal, requested)`, where `requested` is the deduplicated union of the group's fields;
  - one `source.read({ ids: [id], fields: allowed, principal, ...windowsOf(windows, allowed) })`. A missing record emits nothing.
  - For each entry, the values of its wanted, allowed and present fields (renamed) form `EntityPatched { entity, id, values, changed: keys(values) }`. Entries with no values emit nothing.

- **`deleted(ref)`** emits `EntityDeleted { entity, id }` to every subscriber selecting `entity:id`. It does no authorization or re-read.
- **Emission** increments the subscriber's own cursor and offers `{ ...change, cursor }`. Cursors are per stream and start at the client's `after`; there is no replay buffer, so resuming only renumbers.

**The handler.** `FoldkitRemoteLive(payload)`:

1. A protocol mismatch fails with `RemoteProtocolError`. It is not mapped to `RemoteLiveError`.
2. The handler merges with unbounded concurrency:
   - one stream per distinct requested entity that has a per-entity `RemoteServer.live(Entity, { subscribe })` source (given that entity's requirements, `after` and `principal`);
   - `options.live.subscribe(...)` (with all requirements and `options.maxIdsPerEntity`) when a hub is passed.
3. Errors map to `RemoteLiveError(message)`.

With neither a per-entity source nor a hub, the merge is empty and the stream completes immediately.

**The wire.** `LiveChange` is a union of `EntityPatched`, `EntityDeleted`, `ConnectionInsert`, `ConnectionRemove` and `ConnectionInvalidate`, each with `cursor`. The hub produces only the first two; connection changes come from custom live sources. Over HTTP the stream is an ordinary streaming procedure (STREAM-001): NDJSON `Chunk` messages, ended by the client disconnecting. A live stream never ends, so a JSON-serialized server never answers it, officially or natively.

## Options

| Option                                                                              | Assessment                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: signals as R effect nodes mirroring `LiveHub.changed/deleted`; a native hub port | Mirrors upstream's API and decoupling. The reference uses upstream's own `liveHub`, so grouping, authorization and cursor semantics come from the published package. Needs two effect nodes and a runtime-served streaming procedure                     |
| B: the store signals automatically from `write`/`remove`                            | Convenient, but invents behaviour upstream does not have: a write's keys are not always the fields that changed for subscribers (derived fields, relations), and it cannot express "a database trigger changed this". Possible later as an opt-in helper |
| C: per-entity `RemoteServer.live` sources compiled from R streams                   | General, but needs R streams over a server-lifetime queue and connection-change builders. No workload needs it before the hub                                                                                                                            |
| D: keep live in a JS host                                                           | Milestone 9 hybrid hosting; contradicts milestone 7's "native subscriptions"                                                                                                                                                                             |

## Decisions

- **LIVE-001: signalling mirrors `LiveHub`.**
  - `R.LiveHub.changed(ref, fields)` and `R.LiveHub.deleted(ref)` are effect nodes returning `Computation<void, never>`. `ref` is the `RemoteRef` struct; `fields` is `Array<String>`.
  - They are a service implementation with a reachable `LiveHub` requirement, following `RemoteStore` (RS-001..003).
  - The reference provides the requirement from a `LiveHubHost` service whose implementation is upstream's `RemoteServer.liveHub(entities)` hub itself. The oracle server passes that same hub to `RemoteServer.handlers(..., { live: hub })`.
  - Option B is rejected for now; C and D are deferred.
- **LIVE-002: the native hub is a port of `liveHub` in the Remote engine.**
  - Subscribers live in insertion order behind a mutex, each with:
    - `selected` (`JsObject` keyed `entity:id`, holding an ordered field set and windows);
    - `principal: Option<u64>`;
    - an unbounded `mpsc` sender;
    - an `f64` cursor, incremented as a JS number.
  - `changed` groups by principal (first-seen order), then by the existing `stable_windows`/`stable_renames` text. It reuses `allowed_fields` with that principal's `authorize`, `windows_of`, aliasing and `Source::read`. `deleted` follows upstream.
  - Emission order across subscribers and groups follows upstream's loops.
- **LIVE-003: when a signal takes effect.**
  - **Memory backend:** the signal applies when the node runs, as upstream's memory mutations do. Store writes persist even if the mutation later fails, as they do upstream.
  - **SQL backend:** native mutations run in a transaction (SQLX). `changed` re-reads outside that transaction, so signals are queued during the mutation, applied after commit, and dropped on rollback.

  Upstream has no transactional SQL mutation to compare with, so this is a consistency choice, not a divergence. It is delivered after the memory path.

- **LIVE-004: serving `FoldkitRemoteLive`.** It is a runtime-served streaming procedure:
  1. protocol check (failure exit with `RemoteProtocolError`);
  2. limits (failure exit with `RemoteLiveError` and the live wording);
  3. register the subscriber;
  4. forward its queue as `Chunk` messages, each holding one wait plus everything already queued (`takeAll`);
  5. deregister through a drop guard when the client disconnects or the server stops.

  `NativeRemote.compile(..., { live: true })` serves a hub. Without it, the procedure answers as upstream does without `options.live`: the protocol check, then an empty stream that completes. A reachable `R.LiveHub` node without `live: true` is a compile error. Per-entity live sources are not supported (option C).

- **LIVE-005: limits.** `maxIdsPerEntity` keeps the engine's 1000 (the default). A configurable limit follows if Read gains one, since upstream shares the option.
- **LIVE-006: principal and re-authorization.**
  - A subscriber keeps the principal its request authenticated with (the bearer adapter's `u64`, or none on a public server).
  - Each `changed` authorizes again under that principal, as upstream does.
  - When Read/Query carry auth (RM-004), Live must carry it too, because it calls `authorize`.

## Order of work and acceptance

1. **Memory hub and Live procedure (LIVE-001..006).** The differential test serves both servers over NDJSON:
   - **Official server:** `RemoteServer.handlers(memory.server, principal, { live: hub })`, with mutations run through `Reference` and the same hub.
   - **Native server:** `live: true`.

   It opens identical live subscriptions on both servers, runs the same mutation sequence, and compares raw `Chunk` lines (key order included), read incrementally with timeouts. Cases:
   - changed selected, unselected and partially selected fields;
   - `deleted`;
   - aliases with windows;
   - two subscribers, in order;
   - `after` cursors;
   - protocol mismatch and too many ids;
   - disconnect removes the subscriber, and later mutations still answer;
   - with `authorize`, two principals see different fields.

   **Delivered 2026-10-03.**
   - **Signals.** `R.LiveHub.changed/deleted` are `RemoteStore` nodes with the `Changed`/`Deleted` ops and the `reffect/effect/live-hub@1` effect identity. They travel through the store session (`RemoteStore::live`); NativeRpc refuses them without a hub.
   - **Native hub.** `remote_engine::Hub` ports `liveHub`.
   - **Live procedure.** NativeRpc serves runtime-defined streaming procedures (`stream: true`), forwarding queued events with `takeAll` chunking until `out` closes or the request is cancelled. `NativeRemote` adds the `live` and `serialization` options. Without a hub, Live is an empty stream after the protocol check, matching `handlers` without `live`.
   - **Tests.**
     - [remote-live.test.ts](../../packages/reffect/tests/remote-live.test.ts) compares raw NDJSON `Chunk` lines and mutation answers with `RemoteServer.handlers(..., { live: liveHub })`. It covers the cases above except `authorize`. Upstream's three events from one `changed` arrive in one chunk on both servers, which settles the `mergeAll` question.
     - [remote-mutate.test.ts](../../packages/reffect/tests/remote-mutate.test.ts) now serves Live without a hub under JSON.
   - **Test harness note.** The official web handler resolves a streaming Response only at its first chunk, so the test starts subscriptions without awaiting them, and disconnects by cancelling the body.
   - **Authorization (LIVE-006).** A second scenario serves `RemoteRpc.middleware(Authentication)` with an R `authorize`. The official side binds `handlers` to each request's principal. Two admin subscriptions and two member subscriptions see different fields of one change, a member watching only `email` receives nothing, and an unauthenticated Live fails with `Unauthorized`; the outcomes are equal on both servers.
   - **Harness note.** A subscription that never receives a chunk has no official Response to cancel, so closing waits a bounded time.

2. **SQL backend (LIVE-003).** Signals apply after commit and are dropped on rollback, checked against SQLite and Postgres.

   **Delivered 2026-10-03.**
   - **Native.** `remote_sql::Session` queues signals. The generated `finish` commits, then applies them to the hub, which re-reads through `REMOTE_SQL`'s pool. A rolled-back session drops its signals. If a post-commit re-read fails, the mutation fails with that store failure, just as a failing `hub.changed` fails an upstream mutation whose memory writes are already kept.
   - **Oracle.** [remote-sql-live.test.ts](../../packages/reffect/tests/remote-sql-live.test.ts) runs the same R sources in a transaction on the official database. It holds the `LiveHubHost` signals and calls upstream's `liveHub` (over the Drizzle sources) after commit, which is how an application would call upstream's hub around its own transaction.
   - **Cases**, with equal Chunk lines and answers on SQLite and Postgres:
     - a committed rename re-read with an unchanged selected field;
     - a mutation that signals, then fails and rolls back, so nothing reaches subscribers;
     - a delete;
     - a second rename at the next cursor.

3. **Stock client.** A Foldkit `Data.live` subscription receives native changes (the milestone's "stock subscriptions" acceptance), then `examples/todo-remote` gains live updates.

   **Delivered 2026-10-03.**
   - **Stock client.** `remote-live.test.ts` runs `RemoteClient.live` from `Remote.clientLayer` over a stock `RpcClient` (NDJSON) against the native server. Remote's live subscription entries make this same call. The decoded `LiveEvent`s equal those from the same client layer over upstream's in-process handlers.
   - **Example.** `examples/todo-remote` compiles with `live: true` and NDJSON. Toggle and delete signal the hub, and its session watches two todos live; the screens equal upstream's memory backend with `liveHub`.
   - **Open.** Upstream's client marks requirements live only for `Data.live(selection, id)` projections, not for query items, so the browser app needs per-item live projections before it renders changes.

## Review (2026-10-03)

This reviews commits `900322b`..`9ecd4ad` against this record and the code. Nothing below is fixed yet. Fixes land as `review(live):` commits and are recorded here when done.

### Defects to fix

- **LR-1: SQL signals after commit can misreport the mutation and drop later signals.** The generated SQL `finish` in `native-remote.ts` applies each queued signal with `changed(...).await?`. When one post-commit re-read fails:
  - the mutation is answered as `RemoteMutationError("Database query failed")` although its transaction committed, so the stock client rolls back an optimistic update for a write that was kept;
  - the signals after the failed one are never applied, so subscribers see part of the mutation.

  LIVE-003 justified this by analogy with upstream's memory backend, but that analogy is weak. **Fix:** once the commit succeeds, the mutation's answer must not change. Apply every queued signal, log a re-read failure, and record the remaining gap in [native divergences](../native-divergences.md). That gap is that a missed event is invisible to the client.

- **LR-2: native unsubscription on disconnect is not evidenced.** The official side asserts `hub.size == 0`. The native "disconnect" case shows only that the closed subscriber received nothing afterwards, which proves nothing, and that the remaining subscriber still works.

  By reading [rpc-runtime.ts](../../packages/reffect/src/rpc-runtime.ts), the mechanism looks right. Dropping `PendingResponse` sends cancellation, which ends the forwarder, and dropping the `Unsubscribe` guard removes the subscriber, in JSON mode too. But no test observes it, so the milestone's "finalize on cancellation" acceptance is only half evidenced. **Fix:** emit a record when a subscriber is removed (or expose a count) and assert it from stderr, as [stream-interrupt.test.ts](../../packages/reffect/tests/stream-interrupt.test.ts) asserts the finalizer.

- **LR-3: the status claims overstate delivery.** PLAN.md says milestone 7 "is implemented", but:
  - LR-2 is open;
  - Foldkit's `Data.live` subscription entries and runtime were not run end to end. Only `RemoteClient.live`, which they call, was tested;
  - `examples/todo-remote/web/entry.ts` moved to NDJSON without the browser app being run.

  **Fix:** state exactly what is delivered (this record and PLAN.md were corrected alongside this review), then close the gaps.

- **LR-4: `live: true` with JSON serialization cannot work.** A Live stream never ends, so a JSON response buffers events in memory without bound and never answers. It also holds up any request batched with it. Upstream behaves the same, but the native compiler knows this statically. **Fix:** refuse `live: true` unless serialization is NDJSON. This is a compile-time refusal, not a runtime divergence.

### Design debts to record

- **LR-5: signals share the `RemoteStore` node.**
  - `Changed`/`Deleted` are ops of the store node with their own effect identity (`reffect/effect/live-hub@1`). That avoided touching every pass.
  - In exchange, diagnostics for misused signals mention "RemoteStore", the explanation shows no separate `LiveHub` requirement, and signals depend on a store session although the hub is a different service.
  - This is acceptable while signals occur only inside NativeRemote mutations. Split the node, or at least the requirement, when signals are used elsewhere.
- **LR-6: signal names are not checked against the domain.** `R.LiveHub.changed({ entity: "Projct", id }, ["nmae"])` compiles and does nothing, as upstream does at run time. NativeRemote has the domain, so it could refuse undeclared entities and statically known undeclared fields. The same check would help the `RemoteStore` ops.
- **LR-7: backend asymmetry on failed mutations.** On memory, a mutation that signals and then fails still emits, because its write persists, as upstream's does. On SQL, the rollback drops the signal (LIVE-003). This is deliberate, but an application switching backends sees it. Keep it in the user-facing notes.
- **LR-8: no subscription hardening.** There is no subscriber cap per connection or server, and each subscriber's queue is unbounded, as upstream's are. Every other native request path has hardening limits, so a configurable cap belongs with them.

### Minor

- **LR-9: cursor number text.** `js_number` writes non-integer or out-of-range cursors with serde's float formatting (`1e21`), where JS writes `1e+21`. Use `ryu-js`, which the engine already depends on.
- **LR-10: timing-sensitive tests.** The differential tests compare exact chunk boundaries after fixed 150–300 ms pauses. They were stable here, but heavy CI load could chunk events differently on one side.
- **LR-11: field lists are allocated twice.** A literal field list becomes a native array, and lowering then collects it into `Vec<String>` again. This is negligible next to the re-read, but a literal could lower straight to the vector.
- **LR-12: the tests were not mutation-checked.** No implementation fault was injected to confirm the tests fail. Exact line equality and content assertions make a vacuous pass unlikely. The rollback case would fail if signals applied before commit, because the cursors and events would differ.

### What held up

- **LIVE-001.** Explicit signals mirroring `hub.changed`/`deleted`, not automatic signals from store writes, keep upstream's decoupling. They also let the oracle run upstream's own hub, so grouping, re-authorization and cursors are compared with the published package.
- **Exact comparison.** Raw NDJSON bytes, including key order and chunk boundaries, are compared across windowed aliases, two principals, rollback, and Postgres.
- **Cursor order.** The cursor increment and the queue send happen under one lock, so queue order equals cursor order even when two mutations re-read concurrently on SQL.
- **Shared checks.** Limits and authorization reuse the Read engine's `check_ids_per_entity`, `check_pages_per_relation` and `allowed_fields`, so there is no second implementation to drift.

## Improvement plan (2026-10-03)

Status: **proposed**, from the [review](#review-2026-10-03). Checked first:

- R's only `Ref` is lexical and sequential ([ref-module](ref-module.md)).
- Queue and PubSub are not admitted; [coordination-modules](coordination-modules.md) is a proposal.
- The compiler has no registry of ported runtimes; the plan explanation lists only crates.

### Assessment

- **Correct:** within the tested envelope. The exceptions are LR-1 and LR-2. The SQL oracle, which is upstream's hub called after a test-harness commit, checks self-consistency with LIVE-003; it does not check equivalence with any upstream behaviour.
- **Elegant:** the surface is. `R.LiveHub` mirrors `hub.changed`/`deleted`, and the reference runs upstream's own hub. Several internals are expedient instead:
  - two stream forwarders with different disconnect detection;
  - signals carried by the `RemoteStore` node and session;
  - long Rust snippets in TypeScript template strings.
- **Coherent:** with the Remote milestones (NR-001, a semantic port checked differentially), yes. With the project's core principle, that the compiler knows what each operation means and why an implementation was chosen, less so. The hub, Read engine and SQL session are opaque to planning and explanation, and each milestone adds another such runtime with no stated path back into the compiler.

### Review fixes delivered (2026-10-03)

- **LR-4.** `NativeRemote.compile` refuses `live: true` unless `serialization: "ndjson"`. Tested in `remote-live.test.ts`.
- **LR-2 with LIVE-009.**
  - R stream procedures and runtime-served streams share `forward_chunks` in `rpc-runtime`. It stops on a closed response or cancellation, and its chunk sources are the R sink and the hub queue (`takeAll`).
  - With `REFFECT_LIVE_TRACE` set, the hub writes `reffect.live@1` records with its subscriber count on subscribe and unsubscribe.
  - `remote-live.test.ts` asserts the counts 1, 2, 1, 0 natively, as `hub.size` shows officially.
- **LR-1 with LIVE-007.**
  - `Hub::changed` no longer fails. A failed re-read writes a `reread-failed` record and skips the cursor of each subscriber in that group, and the remaining groups and signals continue.
  - SQL `finish` reports only commit failures.
  - `remote-sql-live.test.ts` renames a selected column under the native SQLite server. The mutation still succeeds, and the subscriber receives its second signal at cursor 2 (a gap).
  - This is registered in [native divergences](../native-divergences.md).
- **Limit of LIVE-007.** Foldkit's `classifyLive` is `cursor <= state.cursor ? duplicate : state.cursor === 0 || cursor === state.cursor + 1 ? applied : gap`. A skip is therefore noticed only when a later event arrives, and never before the client has applied one.
- **LR-3: Foldkit's `Data.live` path (2026-10-03).**
  - In `examples/todo-remote`, a second screen reads t2 with `Data.live`.
  - Remote's live entry from `Data.subscriptions` derives its dependencies from that read, subscribes through `RemoteClient`, and emits `LiveReceived`, which `Data.reduce` folds.
  - The screen shows the toggle without refetching, equally over the native server and upstream's memory backend with `liveHub`. This is Foldkit's real client path, run without a DOM runtime.
  - **Harness note.** In-process, nothing yields after the mutation, so an un-joined consumer fiber never ran. The example joins the entry's stream (`take(1)`).
  - **Still open:** the browser app renders the list, and Foldkit subscribes live only for `Data.live` reads, so it needs one live read per visible todo. A Chrome run is pending.
- **Found on the way: SQLX-019.** SQLite read the renamed column as the literal `"name"`, because an unknown double-quoted identifier is a string in SQLite. SQLite identifiers are now backtick-quoted ([sqlx-remote](sqlx-remote.md#decisions)).

### Proposed decisions

- **LIVE-007: a failed re-read becomes a cursor gap.**
  - A post-commit (or inline) re-read failure in `changed` increments the affected subscribers' cursors without emitting. Foldkit's `classifyLive` then reports a `gap`, so the stock client resyncs or refetches.
  - The mutation's answer is unchanged and the remaining signals still apply.
  - Upstream's `changed` would instead fail the mutation, so this is a [native divergence](../native-divergences.md) to record when implemented. It supersedes the LR-1 fix "log and drop".
- **LIVE-008: a general after-commit hook and a separate LiveHub service.**
  - The store session's `live()` gives way to `after_commit(action)`, which runs immediately on memory and is queued on SQL (run after `COMMIT`, dropped on `ROLLBACK`).
  - Live signals get their own IR node and `LiveHub` requirement (LR-5). NativeRemote provides the service and schedules signals through the hook.
  - LIVE-003 then reads "effects visible outside the transaction happen after commit". The same rule will serve outbox writes, cache invalidation and PubSub publishing.
- **LIVE-009: one stream forwarder.** One `rpc-runtime` function owns chunking (`takeAll`), the 16-message buffer and disconnect detection (`out.closed()` plus cancellation). Both R stream procedures (the `StreamEmit` sink) and runtime-served streams feed it. The Live dispatch arm becomes one call, and the forwarder emits the "unsubscribed" record that LR-2's test asserts.
- **LIVE-010: register ported runtimes as semantic runtime implementations.**
  - Each port is an entry with its `id` (e.g. `foldkit-remote-server/liveHub`), the pinned upstream version, the effects/procedures it serves, its conformance tests and its crates.
  - Plan explanations name it ("Live served by the ported liveHub runtime of foldkit-remote-server 0.11.0").
  - Compilation checks the installed upstream version against the pin and refuses or warns on mismatch. The 0.14.0 upgrade changed behaviour that tests had pinned, with no such guard.
  - This applies to the Remote engine, Query paging, the hub, the SQL session and the RPC runtime.
- **LIVE-011: typed, domain-checked signals.**
  - `R.LiveHub.changed({ entity: Project, id }, ["name"])` accepts the entity descriptor and constrains field names to its fields, which gives editor completion and build-time typos (LR-6).
  - Upstream's string form remains, checked against the domain by NativeRemote.
  - Literal field lists lower to a static slice (LR-11).
- **LIVE-012: runtime Rust as Rust files.**
  - Static runtime code (about 1,900 lines across `remote-engine.ts`, `sql-runtime.ts`, `rpc-runtime.ts` and `async-runtime.ts`) moves to `packages/reffect/runtime/*.rs`, loaded as raw text.
  - Generated tables and dispatch arms stay in typed emission ([rust-emission](../rust-emission.md)).
  - `rustfmt`, `clippy` and Rust unit tests (hub grouping, aliases, cursors) can then run on it.
- **LIVE-013: randomized hub conformance.**
  - A small stdin/stdout JSON driver exposes the native hub: subscribe, changed, deleted, drain events.
  - fast-check scenarios compare it with upstream's in-process `liveHub` over the same rows and `authorize` rules.
  - The HTTP tests then cover only transport (framing, disconnect, authentication, NDJSON) and wait for expected line counts instead of fixed pauses (LR-10, LR-12).
- **LIVE-014: the boundary between R and ported runtimes.**
  - R authors policy: mutation sources, `authorize`, signals, and later SSR views.
  - Semantic runtimes provide protocol engines, ported from pinned upstream versions and checked differentially.
  - The compiler plans, explains and verifies both (LIVE-010).
  - Long term, once server-lifetime Ref, Queue and `Stream.fromQueue` are admitted (behind the deferred cross-fiber ownership gate), the hub is re-expressed in R. The port then stays as a specialization the planner may select because conformance tests show it matches.

### LIVE-010 design (2026-10-03)

- **Existing model.** The plan explanation already names semantic runtimes as adapters (`SemanticRef.runtime("rust/tokio-result@1")` with a strategy and a rationale), but only for generated Result runtimes. The RPC artifact lists crates and its server id, and nothing about the ported engines.
- **Entry.** A `PortedRuntime` has:
  - a `SemanticRef.runtime` id (e.g. `foldkit/remote-live-hub@1`);
  - strategy `"port"`;
  - its upstream pins (package and exact version);
  - what it serves (RPC procedures or effect ids);
  - its conformance evidence (test files);
  - a rationale.
- **Registry.** It lives in `src/ported-runtime.ts`, and `RpcArtifact.runtime.ported` lists the entries a build selected:
  - the Effect RPC HTTP protocol (every NativeRpc server);
  - the Remote Read engine;
  - Mutate shaping;
  - memory or SQL Query paging, with the foldkit-entity evaluator or the Drizzle lowering;
  - the live hub.
- **Version guard.** When a `FileSystem` service is present (tests, CLI, any Node program), compilation reads each pinned package's `package.json` and refuses a mismatch with `UPSTREAM_VERSION`. It finds the package as Node does, through the `node_modules` directories above the compiler's own module.
  - Without a `FileSystem` service, the artifact records `upstream: "unchecked"`, so `NativeRpc.compile` keeps its pure signature.
  - **Rejected:**
    - reading versions with `node:fs` in the compiler, which goes against the project's scoped-filesystem rule;
    - `import.meta.resolve`, which the Vite module runner may not provide;
    - a warn-only guard, which would let silent drift through again (the 0.14.0 upgrade changed pinned behaviour unnoticed).
- **Acceptance.**
  - Artifacts list the selected ports.
  - A test runs the guard against the installed packages.
  - A test with a mismatched pin fails with `UPSTREAM_VERSION`.
- **Delivered 2026-10-03.**
  - [ported-runtime.ts](../../packages/reffect/src/ported-runtime.ts) defines `PortedRuntimes`:
    - `effect/rpc-http@1`;
    - `foldkit/remote-read@1`;
    - `foldkit/remote-mutate@1`;
    - `foldkit/remote-query-memory@1`;
    - `foldkit/remote-query-sql@1`;
    - `foldkit/remote-live-hub@1`.
  - Pins: effect 4.0.0, foldkit-remote and foldkit-remote-server 0.11.0, foldkit-entity 0.7.0, foldkit-remote-drizzle 0.9.1.
  - `RpcArtifact.runtime` has `ported` and `upstream` (`"verified"` or `"unchecked"`). NativeRemote selects ports by procedure, backend and `live`.
  - [ported-runtime.test.ts](../../packages/reffect/tests/ported-runtime.test.ts) covers a verified install, the unchecked case without a FileSystem, a drifted pin, a missing package, and the selected port lists.
  - **Consequence.** Upgrading a pinned package now fails every compile that provides a FileSystem until the pin is updated, which should only happen after the port's conformance tests pass.

### Order

1. **Defects.** LR-1 via LIVE-007, LR-2 via LIVE-009's "unsubscribed" record (or an interim record), LR-3 and LR-4.
2. **Structure.** LIVE-009 (one forwarder), then LIVE-008 (after-commit hook, LiveHub node).
3. **Explanation and API.** LIVE-010 (registry and version guard), LIVE-011 (typed signals) and LIVE-014 (written boundary).
4. **Evidence and code layout.** LIVE-013 (randomized hub conformance), then LIVE-012 (Rust files), before milestone 8 adds another runtime.

## Open questions

- Whether the native hub needs `size` (upstream exposes it for tests). The test observes unsubscription through later mutations instead.
