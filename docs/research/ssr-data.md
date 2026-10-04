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

   **Delivered 2026-10-03.**
   - **Server.** [page.ts](../../examples/todo-remote/page.ts) plans the list with `planPage` and mirrors the app's Ready view in R. The example's server serves it beside RPC, mutations and Live.
   - **Client.**
     - The app's Flags are the resume. `init` replays it, falling back to an empty start, and `entry.ts` hydrates.
     - The session id moved from Flags to a `MakeSession` Command, because the server has no randomness to give.
     - Vite proxies page navigations and `/rpc`.
   - **Acceptance.** [todo-remote-page.test.ts](../../packages/reffect/tests/todo-remote-page.test.ts) builds the example's own server, in happy-dom:
     - The page equals upstream `handleRequest` around `renderToString` with the app's own `init` and `view`.
     - `Runtime.hydrate` keeps the server's list items and asks a counting `RemoteClient` for no read or query. This was mutation-checked: without the exchanges the client queries `Todos`.
   - **Real browser.** Headless Chrome over CDP:
     - adoption, with only `FoldkitRemoteLive` on load;
     - a working toggle (`ToggleTodo`).
     - This closes LR-3's pending browser verification.
   - **Debt.** The view is written twice (Foldkit and R). Single-sourcing it through `toFoldkitView` needs a browser-safe `R.Html` entry.

5. **Showcase (M9-5).** SQL, Live, SSR with data and resume in one binary.

## M9-3 plan (agreed 2026-10-03)

**Order of work**

1. LIVE-012: move the runtime Rust into `.rs` files. Then LIVE-008: the after-commit hook.
2. Pages fetch and record.
3. Build the view's data from the answers.
4. R function calls, then M9-4.
5. M9-5, after the render-to-live gap is decided.

**Decisions**

- **Request templates at build time, not a ported planner.**
  - A static `Data.query(Q, input, { select, first })` or `Data.get(select, id)` has a constant request shape; only `input` or `id` comes from the request.
  - The compiler runs upstream's planner while compiling, against a symbolic input, and derives templates with holes.
  - At run time the page fills the holes, calls the in-process engine and records the answers.
  - **Acceptance:** the client's replayed `satisfy` issues byte-identical requests and plans nothing afterwards.
- **First profile.**
  - Admitted: top-level `query`/`get` with flat selections, and inputs that are R expressions (for example from the URL).
  - Refused at compile time: relations in a selection, and Surfaces whose reads depend on another read's result.
  - Relations need a port of upstream's `assemble` and follow todo-remote.
- **Authorization.**
  - Pages run through the same bearer middleware as RPC procedures, and their reads through the same source authorization with the request's principal.
  - A page whose sources need a principal it cannot have is refused rather than read as anonymous.
- **Consistency.** On SQL a page's reads share one read transaction, so the first screen is one snapshot. This is stronger than upstream and recorded as a consistency choice, like LIVE-003.
- **The view's data (option B).**
  - R views read only `Ready` data, built from the answers: a query's edges in order, each mapped to the selected fields; a get's entity, or `NotFound`.
  - **Acceptance:** equal to upstream `projection.read(model)` on the replayed Model.
- **Flags shape.**
  - A page with Remote data carries `{ app, remote: RemoteResume }`.
  - `RemoteResume` needs R witnesses for the domain's answers, derived from the select schemas as the engine's codecs already are.
- **Page contracts.** Export the page and render-error schemas so contracts stop restating the error union (`FlagsEncodeError` broke two).

## M9-3 step 2 design (2026-10-03)

**Upstream facts** (foldkit-remote 0.11.0 `index.mjs`, checked 2026-10-03):

- **Query requests.** `prefetch` plans with `planAsked(store, askedOf(projection), cacheFirst)`. A query becomes `queryRequestOf(connection)`: `{ query, input, window, select? }`. `input` is parsed from the connection identity, which is `stableStringify` of the encoded input, so its keys are sorted.
- **Follow-up reads.** After the page is merged, `itemsOf` asks for each edge's selected fields. A flat selection is already answered by the page, so no Read follows; this matches the probe's single exchange.
- **Gets.** `Data.get(select, id)` plans one Read requirement `{ entity, id, fields }` for the fields the store lacks.

**Increments**

- **2a: declared reads, recorded and resumed.**
  - **Declaration.** `pages.remote` lists the page's reads as ordinary upstream projections built at compile time (`Data.query(Q, input, { select, first })`, `Data.get(select, id)`).
  - **Planning.** The compiler runs upstream's planner on `Remote.initial` to get each read's wire request.
  - **First cut: constant requests.** Inputs and ids are compile-time values, which todo-remote's `Todos` query (input `{}`) needs. Holes filled from the URL come next, with typed sentinels located in the planned request.
  - **Refused:** relations in a selection, and requests a second pass would add.
  - **Run time.** The host runs each request against the in-process engine (the same `remote_engine::query`/`read` the RPC handlers call), under the request's principal through the same bearer middleware. It records `{ _tag, request, answer }` exchanges.
  - **Hand-off.** The exchanges reach the R page as an `Unknown` value it places in its Flags. `Schema.toCodecJson(Schema.Unknown)` passes JSON through, as a probe showed, and the browser decodes that field with `RemoteResume`.
- **2b: typed view data (option B).**
  - Each read also reaches the R page as a typed value: a query's items as `R.Array(Struct(selected fields))` in edge order; a get's entity, or none.
  - Natively, a small assembler builds them from the answers. The reference takes upstream `projection.read(model)` after `replay`.

**Acceptance**

- The native page's HTML equals upstream `handleRequest` around `renderToString`, whose `init` replays the same exchanges through `Data.satisfy` and whose view reads the projections.
- The exchanges match the requests the client's `satisfy` issues; a miss would fail the replay.
- An unauthenticated request cannot read what an RPC read would refuse.

**2a delivered 2026-10-03.**

- **Planning.** `planReads(Data.satisfy(initial, active))` in `reffect/remote-resume` runs upstream's satisfy against a client that records each request and answers it empty, so it captures the first pass.
- **Declaration and checks.** `NativeRemote` takes `pages: { template, render, origin?, reads }`. It refuses unknown queries or entities and selections with relations.
- **Run time.** The page's data step:
  - runs each request through `remote_engine::query`/`read` with `remote_authorize(principal)`;
  - records `{ _tag, request, answer }`;
  - logs a failed read as `reffect.ssr.page@1 read-failure` and answers 500;
  - passes `{ now, exchanges }` to the R render's second, `Unknown` input.
- **Principal.** Pages take the principal from their own `Authorization` header (`page_principal`, which shares `authenticate`'s constant-time check). On a server with bearer auth, a page request without a valid one gets 401, so a page never reads more openly than RPC.
- **Tests.**
  - [remote-page.test.ts](../../packages/reffect/tests/remote-page.test.ts): the native page, with the recorded exchanges in its Flags, equals upstream `handleRequest` around `renderToString` byte for byte, using the native page's own `now`. The browser's replay is `Ready` and plans no fetch. An unknown query is refused.
  - [remote-auth.test.ts](../../packages/reffect/tests/remote-auth.test.ts):
    - a page with no token or an invalid one gets 401;
    - with a token, the recorded answer equals that principal's own `FoldkitRemoteRead` RPC answer;
    - the admin's page shows the budget and the member's does not.
- **Limits.** Only constant requests are planned, and only the first pass. A Surface waiting on another's data is not planned, and its replay then fails with `RemoteReadError`.

**2b delivered 2026-10-03.**

- **Planning.** `planPage({ name: Data.prefetch(initial, projection) })` plans each named view as exactly one query; anything else is refused.
- **Page value.** NativeRemote builds each view as upstream's `Page` of a Ready read:
  - `items` are the edges' entity values in edge order;
  - `hasNext`/`hasPrevious` are true when the answer's `end`/`start` is not `Terminal`, which is upstream's rule for one segment cut to its own window.
- **Typed input.** The render's third input is decoded by its witness's generated decoder. A missing entity or a value that does not decode fails the page (`reffect.ssr.page@1 view-failure`, 500), because native views are Ready-only.
- **Compile-time checks.** `R.Remote.Page(item)` is the witness. The render's views must be exactly the planned ones, and each item Struct must hold exactly the query's selected fields (names only; field types are checked by the decoder at run time).
- **Test.** [remote-page.test.ts](../../packages/reffect/tests/remote-page.test.ts) renders the todo list from the engine's answer. The page equals upstream `renderToString` whose `init` is the browser's own: replay the exchanges, then `list.read(model)`.
- **Authoring finding.** A nested `R.Struct.get(R.Struct.get(read, "todos"), "items")` inside the page's `R.fn` infers `never` for the outer key: the inner call is inferred against the outer call's unresolved parameter. The data-last pipe `read.pipe(R.Struct.get("todos"), R.Struct.get("items"))` and two separate statements both type-check, so the test uses the pipe. Recorded in open work.

**Not yet:** SQL read transactions spanning a page's reads (consistency choice, recorded above), relation assembly, and second-pass reads.

## Risks and open questions

- **Gap between the first render and Live.** The hub keeps no history ("resuming only renumbers"), so a change committed between the server render and the browser's Live subscription is lost.
  - Upstream's own SSR has the same gap, so it is not a divergence.
  - Fixes: a bounded replay buffer in the hub, or a re-read when subscribing. Decide before M9-5.

- **RemoteData states after satisfy.** Partial selections or windowed connections may leave non-`Ready` states. Replay reproduces whatever upstream computes, but the M9-2 suite should cover a windowed connection before M9-3.
- **Upstream churn.** The Model and snapshot shape is versioned and still moving. Every port adds a differential suite to re-run at upgrades; the version guard catches the drift.
- **Streaming HTML.** Milestone 9 renders after the data arrives. The fragment-based native `Html` should stay emittable incrementally.
- **Debts on this path:**
  - Rust in TypeScript strings (LIVE-012) grows with each port;
  - R calls between functions are needed once views split into components with their own projections;
  - NativeRunner takes only scalars, so structured tests go through an RPC server;
  - an editor TypeScript rejects `R.Result` value-type inference.
