# Native Foldkit Remote todo list

A todo list served by a native Rust Foldkit Remote server. The stock Foldkit `Remote` client reads, mutates and watches it live over Effect RPC (NDJSON). Run from the repository root with Node 22.18+ and Rust/Cargo installed:

```sh
vp exec node --experimental-transform-types examples/todo-remote/main.ts
```

Expected output:

```text
start                [ ] Compile it natively   [x] Write the domain
add t3               [ ] Compile it natively   [x] Write the domain   [ ] Ship it
toggle t2            [x] Compile it natively   [x] Write the domain   [ ] Ship it
delete t1            [x] Compile it natively   [ ] Ship it
add without a title  A todo needs a title
reload               [x] Compile it natively   [ ] Ship it
watched live         #1 t2 {"done":true}   #2 t1 deleted
second screen        [x] Compile it natively
native screens equal upstream's memory backend
```

## In a browser

[`web/`](web) is the same list as an ordinary Foldkit application:

- Remote lives in the Model, and the list read is active through `Data.active`.
- `foldData.mutate` starts the three mutations from `update`.
- A stock `RpcClient` reaches `/rpc` on its own origin.

The native server renders the first screen (milestone 9, M9-4), as [page.ts](page.ts) describes. The page reads the list through the server's own engine and renders the app's Ready view in R. It hands over the exchanges it read as the app's Flags. The app's `init` replays them through `Data.satisfy` and `entry.ts` calls `Runtime.hydrate`, so the browser adopts the HTML and starts without fetching the list.

Start the native server, then the Vite dev server. Vite proxies `/rpc` and page navigations to the native server and serves the client modules itself:

```sh
vp exec node --experimental-transform-types examples/todo-remote/main.ts --serve 8787
vp dev examples/todo-remote/web
```

Open the printed address. New todos get IDs from a per-tab session prefix that a `MakeSession` Command generates after start, so `update` stays pure and the server needs no randomness.

In headless Chrome, driven through the DevTools protocol on 2026-10-03:

- the runtime adopted the native page and kept its list;
- the only RPC after load was `FoldkitRemoteLive`, the per-todo live subscription, with no Query or Read;
- toggling a todo sent `ToggleTodo` and updated the list.

## The files

- **[domain.ts](domain.ts)** holds ordinary Foldkit declarations: the `Todo` entity, the `Todos` query (`Query.define`, ordered by title) and three mutations. Browser code imports only this file.
- **[sources.ts](sources.ts)** holds the mutation sources, authored in R. These are what `RemoteServer.memory`'s `mutations` would be in JavaScript:
  - Adding writes a row, returns its patch, and appends it to the `Todos` connection.
  - Toggling writes `done` and signals `R.LiveHub.changed` for it.
  - Deleting removes the row and its edge, and signals `R.LiveHub.deleted`. An empty title fails with `RemoteServerError`.
- **[page.ts](page.ts)** is the first screen: the reads `planPage` derives from the app's list projection, and the app's Ready view mirrored in R. [todo-remote-page.test.ts](../../packages/reffect/tests/todo-remote-page.test.ts) checks that the native page equals upstream `renderToString` with the app's own `init` and `view`, and that the stock runtime hydrates it without a read or query.
- **[main.ts](main.ts)** compiles the native server, with that page, and starts it on a loopback port. It then runs one screen session through `Remote.clientLayer` over a stock `RpcClient`:
  1. prefetch the list;
  2. `Remote.mutateInto` add, toggle and delete;
  3. a refused add;
  4. a fresh reload;
  5. meanwhile, the raw events of a `RemoteClient.live` call watching t1 and t2;
  6. a second screen that reads t2 through `Data.live` and never refetches. Remote's own live Subscription entry (`Data.subscriptions`) subscribes, and the Messages it emits are folded with `Data.reduce`, so the screen shows the toggle.

  The same session runs against upstream's `RemoteServer.memory` with `RemoteServer.liveHub`. Its sources are the same R functions, run by the reference interpreter over its own `MemoryStore` and hub. The example fails unless every screen is equal.

## What it shows

- The added todo lands at the end of the list, even though `Todos` orders by title. That is what `append` reports and what upstream does too. The reload re-sorts it from the server.
- For a persistent server, write the artifact with `CargoApi.write` and run `cargo run -- --port 3000` there.

## Limits

- The memory backend holds rows in the server's memory, as upstream's does. The SQL backend serves the same sources (milestone 5) and applies live signals after commit.
- The browser app follows every visible todo with one `Data.live` read, composed with `Projection.struct` into one active entry. Live patches update the entity store the list reads.
- **The R view mirrors the app's view.** Its Ready branch is written twice: in Foldkit for the browser and in R for the server. The acceptance test catches drift. Using the R view in the browser through `toFoldkitView` needs a browser-safe `R.Html` entry.
- **A change committed between the server render and the browser's live subscription is not delivered.** The hub keeps no history; this is an open question for M9-5.
- Authorization (RM-004) and `Live` (milestones 6–7) are not served yet.
- Mutation schemas use the portable subset: finite numbers, no `Schema.optional`, and no numbers in outputs.
- The full profile and divergences are in [the native RemoteServer design](../../docs/research/native-remote.md) and [native divergences](../../docs/native-divergences.md).
