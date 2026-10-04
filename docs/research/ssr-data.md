# SSR with Remote data and resume (milestone 9)

Status: **plan recorded (2026-10-03)**; M9-1 delivered, M9-2 redesigned. This is [milestone 9](../implementation-milestones.md#28-milestone-9--ssr--remote-datasatisfy--resume): native SSR whose first screen already holds its Remote data, and a browser that resumes without a duplicate initial fetch. It builds on [native SSR](native-ssr.md) (8A) and [native Remote](native-remote.md) / [Remote Live](remote-live.md).

## Sequencing decision (2026-10-03)

The user agreed to take milestone 9 before 8B.

8B, the mechanical transformation of upstream SSR source, is close to compiling general TypeScript: the [inventory](foldkit-ssr-inventory.md) measured about 16k lines, about 700 branches and about 1,000 closures. Milestone 9 is on the path to the showcase (`examples/todo-fullstack`). PLAN previously said 8B "can follow 8A directly"; it now follows milestone 9.

## What upstream provides (foldkit-remote 0.11.0, checked 2026-10-03)

- **`Data.prefetch(model, projection)`.** An Effect needing `RemoteClient`, "for SSR route prefetch, hover prefetch, and tests". It fills the store for a projection.
- **`RemotePersistence`.** It holds a versioned snapshot (`REMOTE_CACHE_VERSION = 5`) of the entity store and of the declared connections' edge segments, without cursors or boundaries:
  - `snapshotOf(model, { connections })`;
  - `dehydrate(snapshot, options)` → text;
  - `hydrate(text)` → `Snapshot`;
  - `mergeStores(current, snapshot, policy)`.
- **Upstream's SSR composition.** The server prefetches through a `RemoteClient` and renders. The snapshot travels to the client, for example as Flags, and the client's `init` hydrates and merges it, so the first render reads `Ready` and hydration matches.
- **`Data.satisfy(model, active, { passes = 8, now })`.** Its documentation reads: "The Model with everything the active Surfaces read, for a render that fetches nothing (SSR, a prerender)". It repeats `Data.prefetch` over the active Surfaces until none plans a read, and fails with `RemoteUnsatisfied` when the passes run out. `now` is injectable; its default is the wall clock.

## Design change: resume from protocol answers, not the snapshot (2026-10-03)

**Finding.** The planned M9-2 snapshot cannot give an identical first render without a refetch.

- Upstream's `Hydrated` reducer restores every connection with `start`/`end` unknown and `stale: true`.
- A client resuming from a `RemotePersistence` snapshot therefore plans the connection's query again, and its paging state differs from the server's.
- The snapshot exists to warm a cache across visits, not to resume a server render.

**Probe** (upstream only, `packages/reffect/scratch-resume.ts`, not committed). The todo-remote domain with `RemoteServer.memory(...)`:

1. The server runs `Data.satisfy(initial, { todos }, { now })` with a `RemoteClient` that answers through `RemoteServer.handlers` and records each request and answer. The run needed one `Query` exchange (519 bytes of JSON for two todos).
2. The client runs the same `Data.satisfy` in `Effect.runSync`, with the same `now` and a `RemoteClient` that answers only from the recorded exchanges and dies on anything else.

Results:

- The client Model is JSON-equal to the server's.
- `list.read(model)` is `Ready` with the same items.
- The Surface's read entry plans no query after `satisfy` (it planned one from `initial`), so the browser makes no initial fetch.
- `runSync` must not see `Remote.clientLayer`: its coalescing `RequestResolver` makes the effect asynchronous (`AsyncFiberError`). The replay client is provided directly as a `RemoteClient` layer.

**Chosen approach (replaces "native snapshot").**

- **Server.** The page satisfies its active Surfaces against the native engine. Each exchange (a Query or Read request and its wire answer) is recorded, and the exchanges plus `now` travel in the Flags.
- **Client.** `init` replays them through upstream `Data.satisfy` and a replay `RemoteClient`. The browser keeps upstream's own reducer, planning and Model; reffect ports no Model or snapshot format.
- **What is ported.** Nothing new: the answers are the native engine's existing Query/Read responses, already differential-tested against `RemoteServer`. The native view (M9-3) needs projection-read semantics over the per-request store; the client never sees a native Model.

**Alternatives rejected.**

- _Snapshot (`snapshotOf`/`dehydrate`)._ Restores stale connections with unknown boundaries, so the client refetches. It would also port the cache-version-5 format and its churn.
- _Serializing the server Model._ Couples the payload to upstream's internal Model shape and version; replaying answers depends only on the versioned wire protocol (`REMOTE_PROTOCOL_VERSION`) that the native engine already speaks.

**Assumptions and open questions.**

- _Numbers in Flags._ `now` and entity values are Numbers, which M9-1 refuses because the JSON round trip turns `-0` into `0`. The rule to adopt: the native page renders from the round-tripped answers, the same values the client decodes. Upstream's browser already only ever sees JSON-decoded answers. Whether `ryu-js` writes `-0.0` as `0`, as `JSON.stringify` does, needs a test.
- _Read requirements._ The probe exercised only a Query; entity Reads follow the same replay path but are untested.
- _Where the replay client lives._ It is ordinary browser code of about 20 lines. Ship it from a browser-safe reffect entry for now; foldkit-plus is a candidate home.
- _Request identity._ The replay matches requests by their JSON text; the client issues them in the same order with the same encoding, as the probe shows. A miss dies loudly rather than fetching.

**Acceptance for M9-2.**

- An upstream-only differential suite: satisfy-and-record on the server, replay in `runSync` on the client. Assert equal Models, `Ready` reads and no planned read, for a Query, an entity Read and a windowed connection.
- The recorded exchanges come from the native engine (NativeRemote) and are byte-equal to the `RemoteServer` answers.
- The Flags schema for the exchanges decodes them without loss.

## Plan

1. **Pages that read the request (M9-1).**
   - `pages.render` takes the request URL.
   - Flags are encoded into the hydratable render as upstream does: a `<script type="application/json" data-foldkit-flags>` payload with `<` escaped. The Flags round trip runs before `init`.
   - Differential against `renderToString` with Flags and `handleRequest`.

   **Delivered 2026-10-03.**
   - `pages.render` may take the request URL: its target resolved against `pages.origin` (default `http://localhost`, never the Host header) as WHATWG does.
   - `R.Html.renderToString(document, { flags })` appends upstream's payload. It is `JSON.stringify` of `Schema.encodeSync(toCodecJson(F))`, written by a JS-exact JSON writer (serde string escaping, `ryu-js` numbers), with `<` turned into `\u003c`.
   - Flags witnesses holding Numbers are refused while compiling: upstream hands `init` the decoded round trip, which turns `-0` into `0`. Without Numbers the round trip is the identity.
   - [html-flags.test.ts](../../packages/reffect/tests/html-flags.test.ts) compares five targets with `handleRequest` around upstream `renderToString`, using the same Flags schema, `init` and R view. Bodies and statuses are equal, including dot segments, encoded queries and non-ASCII paths.
   - **Divergence.** A raw non-ASCII byte in the request target is refused by Hyper (400) before the page; browsers percent-encode.

2. **Resume from protocol answers (M9-2).** Redesigned 2026-10-03, see [the design change](#design-change-resume-from-protocol-answers-not-the-snapshot-2026-10-03); it replaces the planned native snapshot.
   - The server records its Query/Read exchanges into the Flags.
   - The client `init` replays them through upstream `Data.satisfy` and a replay `RemoteClient`.

   **Delivered (upstream half) 2026-10-03.**
   - [`reffect/remote-resume`](../../packages/reffect/src/remote-resume.ts) is browser-safe (effect and foldkit-remote only; foldkit-remote is an optional peer). It provides:
     - the `RemoteResume` schema (`now`, ordered `RemoteExchange`s over upstream's `QueryRequest`/`QueryResult`/`ReadBatch`/`ReadBatchResult`);
     - `record(effect)`;
     - `replay(exchanges)`, a synchronous `RemoteClient` keyed by `stableStringify` of the encoded request, whose misses fail with `RemoteQueryError`/`RemoteReadError`.
   - [remote-resume.test.ts](../../packages/reffect/tests/remote-resume.test.ts) runs the server satisfy against `RemoteServer.memory(...).layer` and sends the resume through the JSON codec, as Flags would. The client satisfy in `runSyncExit` gives a Model `toStrictEqual` to the server's.
     - It covers an entity read with a relation, a windowed query, a paged to-many relation, and a Surface that reads only on the second pass.
     - Every read is `Ready` and every read entry plans nothing; a dropped exchange fails with `RemoteQueryError`.
   - **Moved to M9-3.** The exchanges recorded natively: the page satisfies against the native engine, whose answers are already differential-tested against `RemoteServer`. M9-3 also needs Numbers admitted in these Flags (step 1, delivered).

3. **Projections in R views, with async pages (M9-3).**

   **Step 1 delivered 2026-10-03: Numbers in Flags.**
   - **API.** `R.Html.renderToString({ init, view }, { flags, buildId })` mirrors upstream's program form: `init` reads `decode(roundTrip(encode(flags)))`, as `server.js` hands it the `hydrationFlags`.
   - **New operation.** `JsonRoundTrip` (`reffect/json.round-trip@1`) has reference `JSON.parse(JSON.stringify(v))`. Natively, `foldkit_json::round_trip` rewrites `-0` to `0`.
   - **Why only `-0` changes.** A probe of `Schema.toCodecJson` output found that `undefined` encodes as `null`, non-finite Numbers as strings, and finite Numbers are written shortest and parsed exactly.
   - **Decode failure.** It yields upstream's `FlagsEncodeError` tag, a new `RenderError` case carrying a message where upstream carries the cause. Every page contract that restates the error union gains the case.
   - **Document form.** It still refuses Numbers in its Flags, because its view was built from the original value.
   - **Test.** [html-flags.test.ts](../../packages/reffect/tests/html-flags.test.ts) now renders a program whose Flags hold `-0`, `1e21`, `5e-324`, `0.1`, `NaN` and `-Infinity`. Payload and body equal upstream for five targets, so the native JSON writer prints `-0` as `0`, as `JSON.stringify` does.
   - **Limits.**
     - No R Number operation today distinguishes `-0` from `0` (`add`, `eq`, `lt`, `fromNumber`), so `init` reading the round trip is not yet observable; it guards later operations.
     - `FlagsEncodeError` is unreachable for R witnesses, which carry no sign-sensitive checks; it exists for faithfulness.

   - `R.Remote` projection reads inside `R.Html` views.
   - The reference is upstream `Data.query(...).read(model)`, so the browser view stays Foldkit's own. Natively the read comes from a per-request store the engine fills.
   - A page's projections are operations, so its data requirements are planned at compile time.
   - Pages become async R functions with the store service, sharing the mutation session machinery (and LIVE-008's after-commit hook when it lands).

4. **`todo-remote`'s first screen natively (M9-4).** The 8A step 6 example, now with data.
5. **Showcase (M9-5).** SQL, Live, SSR with data and resume in one binary.

## Risks and open questions

- **RemoteData states after satisfy.** Partial selections or windowed connections may leave non-`Ready` states. Replay reproduces whatever upstream computes, but the M9-2 suite should cover a windowed connection before M9-3.
- **Upstream churn.** The Model and snapshot shape is versioned and still moving. Every port adds a differential suite to re-run at upgrades; the version guard catches the drift.
- **Streaming HTML.** Milestone 9 renders after the data arrives. The fragment-based native `Html` should stay emittable incrementally.
- **Debts on this path:**
  - Rust in TypeScript strings (LIVE-012) grows with each port;
  - R calls between functions are needed once views split into components with their own projections;
  - NativeRunner takes only scalars, so structured tests go through an RPC server;
  - an editor TypeScript rejects `R.Result` value-type inference.
