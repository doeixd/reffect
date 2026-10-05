# Fullstack todos: one native executable

The milestone 9 showcase. One native Rust executable, compiled by reffect, serves todo-remote's Foldkit app over SQLite:

- **Server rendering:** the first screen, read through the server's own engine. The reads it made go into the page, so the browser resumes from them instead of fetching again.
- **Effect RPC:** the published Foldkit Remote contract (Read, Query, Mutate, Live) over NDJSON.
- **Mutations:** the R sources of `examples/todo-remote/sources.ts`, one SQLite transaction each.
- **Live:** changes are delivered after commit. The opt-in snapshot (LIVE-015) means a change made between a page render and the browser's subscription still arrives.

The browser is an ordinary Foldkit and Effect app (`examples/todo-remote/web`). It hydrates the page with `Runtime.hydrate` and uses a stock Effect RPC client.

## Run it

```sh
vp exec node --experimental-transform-types examples/todo-fullstack/main.ts --port 8787
TODO_REMOTE_PORT=8787 vp dev examples/todo-remote/web
```

Open the address Vite prints. Vite serves the client modules and forwards page navigations and `/rpc` to the native server. Pass `--database todos.db` to keep the data between runs; otherwise a seeded database is made in a temporary directory. The server reads its database URL from `REFFECT_DATABASE_URL` at run time, never from the compiled code.

## The files

- **[db.ts](db.ts):** the `todos` table, its foldkit-remote-drizzle binding to the `Todo` entity, and the seed.
- **[server.ts](server.ts):** the one `NativeRemote.compile` call. It combines the SQL backend, the R mutation sources, Live with the snapshot, NDJSON, and the page from `examples/todo-remote/page.ts`.
- **[main.ts](main.ts):** seeds or opens the database, builds the server and runs it.

Everything else is todo-remote's: the domain, the R sources, the R page and the browser app.

## What is checked

[todo-fullstack.test.ts](../../packages/reffect/tests/todo-fullstack.test.ts) builds this server and checks five things:

1. **The first page matches upstream byte for byte.** The reference is upstream's `handleRequest` around `renderToString`, using the app's own `init` and `view`. Its data comes from upstream's own SQL server (`RemoteServer` over foldkit-remote-drizzle's sources) reading the same SQLite file.
2. **Hydration fetches nothing.** The stock runtime adopts the page and asks its Remote client for no read or query.
3. **A toggle commits through SQL.**
4. **The toggle reaches a fresh Live subscription** through the snapshot.
5. **The next page render shows the toggle.**

On 2026-10-04 headless Chrome, driven through the DevTools protocol, did the same in a real browser:

- the page was adopted, and the only RPC on load was the Live subscription;
- a toggle sent `ToggleTodo` and updated the list;
- after a reload the list still showed the toggle from SQLite, again with only Live requested.

## Limits

- **SQLite only here.** The SQL backend also supports Postgres (milestone 5), but this showcase does not offer it.
- **The view is written twice.** The R page mirrors the app's Foldkit view, and the test catches drift ([#14](https://github.com/doeixd/reffect/issues/14)).
- **Pages are unauthenticated.** Pages on an authenticated server need a cookie session adapter ([#4](https://github.com/doeixd/reffect/issues/4)).
- **Adds don't stream live.** A todo added in another tab appears only on reload, because the Live hub delivers entity changes, not list (connection) changes, as upstream's hub does.
