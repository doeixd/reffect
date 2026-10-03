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
native screens equal upstream's memory backend
```

## In a browser

[`web/`](web) is the same list as an ordinary Foldkit application:

- Remote lives in the Model, and the list read is active through `Data.active`.
- `foldData.mutate` starts the three mutations from `update`.
- A stock `RpcClient` reaches `/rpc` on its own origin.

Start the native server, then the Vite dev server, which proxies `/rpc` to it:

```sh
vp exec node --experimental-transform-types examples/todo-remote/main.ts --serve 8787
vp dev examples/todo-remote/web
```

Open the printed address. New todos get IDs from a per-tab session prefix passed as Flags, so `update` stays pure.

## The files

- **[domain.ts](domain.ts)** holds ordinary Foldkit declarations: the `Todo` entity, the `Todos` query (`Query.define`, ordered by title) and three mutations. Browser code imports only this file.
- **[sources.ts](sources.ts)** holds the mutation sources, authored in R. These are what `RemoteServer.memory`'s `mutations` would be in JavaScript:
  - Adding writes a row, returns its patch, and appends it to the `Todos` connection.
  - Toggling writes `done` and signals `R.LiveHub.changed` for it.
  - Deleting removes the row and its edge, and signals `R.LiveHub.deleted`. An empty title fails with `RemoteServerError`.
- **[main.ts](main.ts)** compiles the native server and starts it on a loopback port. It then runs one screen session through `Remote.clientLayer` over a stock `RpcClient`:
  1. prefetch the list;
  2. `Remote.mutateInto` add, toggle and delete;
  3. a refused add;
  4. a fresh reload;
  5. meanwhile, a second screen watches t1 and t2 through `RemoteClient.live`, the call Remote's live entries make, and shows the events it received.

  The same session runs against upstream's `RemoteServer.memory` with `RemoteServer.liveHub`. Its sources are the same R functions, run by the reference interpreter over its own `MemoryStore` and hub. The example fails unless every screen is equal.

## What it shows

- The added todo lands at the end of the list, even though `Todos` orders by title. That is what `append` reports and what upstream does too. The reload re-sorts it from the server.
- For a persistent server, write the artifact with `CargoApi.write` and run `cargo run -- --port 3000` there.

## Limits

- The memory backend holds rows in the server's memory, as upstream's does. The SQL backend serves the same sources (milestone 5) and applies live signals after commit.
- The browser app does not render live changes yet. Upstream's client subscribes only to `Data.live(selection, id)` projections, not to query items, so it would need one live projection per visible todo.
- Authorization (RM-004) and `Live` (milestones 6–7) are not served yet.
- Mutation schemas use the portable subset: finite numbers, no `Schema.optional`, and no numbers in outputs.
- The full profile and divergences are in [the native RemoteServer design](../../docs/research/native-remote.md) and [native divergences](../../docs/native-divergences.md).
