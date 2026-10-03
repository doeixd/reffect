# SSR with Remote data and resume (milestone 9)

Status: **plan recorded (2026-10-03)**, not implemented. This is [milestone 9](../implementation-milestones.md#28-milestone-9--ssr--remote-datasatisfy--resume): native SSR whose first screen already holds its Remote data, and a browser that resumes without a duplicate initial fetch. It builds on [native SSR](native-ssr.md) (8A) and [native Remote](native-remote.md) / [Remote Live](remote-live.md).

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

## Plan

1. **Pages that read the request (M9-1).**
   - `pages.render` takes the request URL.
   - Flags are encoded into the hydratable render as upstream does: a `<script type="application/json" data-foldkit-flags>` payload with `<` escaped. The Flags round trip runs before `init`.
   - Differential against `renderToString` with Flags and `handleRequest`.
2. **Native snapshot (M9-2).**
   - A ported `snapshotOf` + `dehydrate` over the engine's store.
   - Byte-compared with upstream on stores the engine produces, and pinned to foldkit-remote (LIVE-010).
3. **Projections in R views, with async pages (M9-3).**
   - `R.Remote` projection reads inside `R.Html` views.
   - The reference is upstream `Data.query(...).read(model)`, so the browser view stays Foldkit's own. Natively the read comes from a per-request store the engine fills.
   - A page's projections are operations, so its data requirements are planned at compile time.
   - Pages become async R functions with the store service, sharing the mutation session machinery (and LIVE-008's after-commit hook when it lands).
4. **`todo-remote`'s first screen natively (M9-4).** The 8A step 6 example, now with data.
5. **Showcase (M9-5).** SQL, Live, SSR with data and resume in one binary.

## Risks and open questions

- **RemoteData states after satisfy.** Partial selections or windowed connections may leave non-`Ready` states that the snapshot cannot represent. Probe this before scoping M9-3.
- **Upstream churn.** The Model and snapshot shape is versioned and still moving. Every port adds a differential suite to re-run at upgrades; the version guard catches the drift.
- **Streaming HTML.** Milestone 9 renders after the data arrives. The fragment-based native `Html` should stay emittable incrementally.
- **Debts on this path:**
  - Rust in TypeScript strings (LIVE-012) grows with each port;
  - R calls between functions are needed once views split into components with their own projections;
  - NativeRunner takes only scalars, so structured tests go through an RPC server;
  - an editor TypeScript rejects `R.Result` value-type inference.
