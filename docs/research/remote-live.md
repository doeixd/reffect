# Native Remote Live (milestone 7)

Status: **step 1 delivered (2026-10-03)** except authorization coverage; steps 2–3 open. It begins [milestone 7](../implementation-milestones.md#25-milestone-7--native-foldkit-remote-live) and absorbs milestone 6 step 5 (the `FoldkitRemoteLive` skeleton, [streaming-rpc](streaming-rpc.md#order-of-work-and-acceptance)). It closes NR-006 ([native-remote](native-remote.md#decisions-proposed)) once delivered.

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
   - **Open:** a differential test of `authorize` with two principals on an authenticated Live (LIVE-006).

2. **SQL backend (LIVE-003).** Signals apply after commit and are dropped on rollback, checked against SQLite and Postgres.
3. **Stock client.** A Foldkit `Data.live` subscription receives native changes (the milestone's "stock subscriptions" acceptance), then `examples/todo-remote` gains live updates.

## Open questions

- Whether the native hub needs `size` (upstream exposes it for tests). The test observes unsubscription through later mutations instead.
