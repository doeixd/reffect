# reffect

**Write your Effect server in TypeScript. Ship it as a native Rust binary.**

> Pre-release: APIs and supported features are still changing.

reffect compiles a subset of [Effect v4](https://effect.website) programs to Rust. You write handlers with `R`, a typed builder API that reads like Effect, against an ordinary Effect `RpcGroup`. reffect then generates a small Rust server (Tokio and Axum). Your clients don't change: the stock Effect `RpcClient` talks to the native server as it would talk to a Node one.

Every supported feature is checked against official Effect, often down to the bytes on the wire. When something can't be compiled faithfully, reffect refuses it with a located diagnostic instead of guessing.

## A first server

**1. Share an ordinary Effect contract.** Clients import this file. They never import reffect.

```ts
// contract.ts
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { RpcCodecs } from "reffect/rpc-codecs";

export const Arithmetic = RpcGroup.make(
  Rpc.make("Add", {
    payload: { left: RpcCodecs.U64Json, right: RpcCodecs.U64Json },
    success: RpcCodecs.U64Json,
  }),
  Rpc.make("Guard", {
    payload: { allowed: Schema.Boolean },
    success: Schema.Boolean,
    error: Schema.Boolean,
  }),
  // No match is `null` on the wire.
  Rpc.make("FirstBelow", {
    payload: { values: Schema.Array(RpcCodecs.U64Json), limit: RpcCodecs.U64Json },
    success: Schema.NullOr(RpcCodecs.U64Json),
  }),
  Rpc.make("Withdraw", {
    payload: { balance: RpcCodecs.U64Json, amount: RpcCodecs.U64Json },
    success: RpcCodecs.U64Json,
    error: Schema.String,
  }),
);
```

**2. Write the handlers with `R`.** `R.fn` takes the input types, the output type, an optional error type, and a body over symbolic values. Success, typed failure, matching, `Option` and `Result` work as they do in Effect.

```ts
// server.ts
import { NativeRpc, R } from "reffect";
import { Arithmetic } from "./contract.ts";

const bindings = {
  // u64 arithmetic wraps exactly as the reference does.
  Add: NativeRpc.bind(
    R.fn([R.U64, R.U64], R.U64, (a, b) => a.pipe(R.U64.add(b))),
    ["left", "right"],
  ),
  // A typed failure, as Effect.fail.
  Guard: NativeRpc.bind(
    R.fn([R.Bool], R.Bool, R.Bool, (allowed) =>
      R.Match.bool(allowed, R.Effect.succeed(allowed), R.Effect.fail(allowed)),
    ),
    ["allowed"],
  ),
  // Option: the first value below the limit, if any, as a nullable result.
  FirstBelow: NativeRpc.bind(
    R.fn([R.Array(R.U64), R.U64], R.NullOr(R.U64), (values, limit) =>
      values.pipe(
        R.Array.findFirst((value) => R.U64.lt(value, limit)),
        R.Option.getOrNull,
      ),
    ),
    ["values", "limit"],
  ),
  // Result: decide the outcome as data, then match it into success or a typed failure.
  Withdraw: NativeRpc.bind(
    R.fn([R.U64, R.U64], R.U64, R.String, (balance, amount) =>
      R.Match.bool(
        R.U64.lt(balance, amount),
        R.Result.fail(R.String.literal("insufficient funds"), R.U64),
        R.Result.succeed(R.U64.sub(balance, amount), R.String),
      ).pipe(R.Result.match({ onSuccess: R.Effect.succeed, onFailure: R.Effect.fail })),
    ),
    ["balance", "amount"],
  ),
};

// The entry's default export is its compile effect.
export default NativeRpc.compile(Arithmetic, bindings);
```

**3. Build it into a binary and run it.** `reffect build` compiles the entry to a Rust crate, builds it with Cargo and copies the binary next to you. Rebuilds are incremental.

```sh
reffect build server.ts --release
./server --port 3000
# {"schema":"reffect.rpc.ready@1","address":"127.0.0.1:3000"}
```

`reffect check server.ts` reports diagnostics without building, and `reffect run server.ts -- --port 3000` builds and runs in one step. Every command is a thin wrapper over the library: `NativeRpc.compile` returns the crate, and `CargoApi` writes, fetches and builds it, if you'd rather drive the build from your own Effect program.

**4. Call it with the stock Effect client.**

```ts
const client =
  yield *
  RpcClient.make(Arithmetic).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url: "http://127.0.0.1:3000/rpc" }).pipe(
        Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
      ),
    ),
  );
const sum = yield * client.Add({ left: 18446744073709551615n, right: 1n }); // 0n
const rejected = yield * client.Guard({ allowed: false }).pipe(Effect.flip); // false
const found = yield * client.FirstBelow({ values: [9n, 7n, 3n, 1n], limit: 5n }); // 3n
const missing = yield * client.FirstBelow({ values: [9n], limit: 5n }); // null
const left = yield * client.Withdraw({ balance: 10n, amount: 4n }); // 6n
const refused = yield * client.Withdraw({ balance: 3n, amount: 4n }).pipe(Effect.flip); // "insufficient funds"
```

**What it compiles to.** Each handler becomes plain Rust: `u64` arithmetic, Rust enums for `Option` and `Result` data, and `Result<_, E>` for the typed error channel. There is no interpreter and no boxed effect at run time. An abridged excerpt of the generated `src/lib.rs` (the crate is in `.reffect/server` after a build):

```rust
// Add
pub fn r_handler_0(p0: u64, p1: u64) -> u64 {
    let v0: u64 = (p0).wrapping_add(p1);
    v0
}

// Withdraw: the R.Result value is an enum...
pub enum Union_b5716499d12e348d { Success(Success_a5783af8ccacd78f), Failure(Failure_3399a754572c0211), }

fn h_handler_3_2(p0: u64, p1: u64) -> Union_b5716499d12e348d {
    let v0: u64 = (p0).wrapping_sub(p1);
    let v1: Union_b5716499d12e348d = Union_b5716499d12e348d::Success(Success_a5783af8ccacd78f { success: v0, });
    v1
}

// ...and the handler's typed failure is Rust's Err.
pub fn r_handler_3(p0: u64, p1: u64) -> Result<u64, String> { /* match on the enum */ }
```

Besides the handlers, the crate holds the Axum server, the JSON codecs for your contract and a short trail of failure locations for diagnostics.

The whole program is in [examples/rpc](examples/rpc). From this repository, the CLI is `node packages/reffect/bin/reffect.js`:

```sh
vp exec node packages/reffect/bin/reffect.js build examples/rpc/server.ts
vp exec node --experimental-transform-types examples/rpc/main.ts  # builds, starts and calls it
# stock client → native Rust: sum=0, typed failure=false, firstBelow=3/null, withdraw=6/insufficient funds
```

## Choosing serialization and transport

These mirror Effect's own options: pick the same ones on the client and the server.

```ts
NativeRpc.compile(Group, bindings, {
  serialization: "schema-binary", // "json" (default) | "ndjson" | "schema-binary"
  transport: "websocket", // "http" (default) | "websocket"
});
```

| Client side                                         | Server option                                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `RpcSerialization.layerJson` / `layerNdjson`        | `serialization: "json"` / `"ndjson"`                                                      |
| `RpcSerialization.layerSchemaBinary({ ... })`       | `serialization: "schema-binary"`, `schemaBinary: { ... }`                                 |
| `RpcClient.layerProtocolHttp`                       | `transport: "http"`                                                                       |
| `RpcClient.layerProtocolSocket` + a WebSocket layer | `transport: "websocket"`: one session per connection, streams acknowledged chunk by chunk |

## What you can build today

- **Effect RPC servers:**
  - unary and streaming procedures (`R.Stream.fn`);
  - typed errors, interruption and finalizers (`R.Effect.ensuring`);
  - bearer authentication through RPC middleware (`NativeRpc.bearer`), or a signed-in session cookie;
  - request logging and spans.
- **Contracts with real data:** structs, optional and nullable fields, string literals, tagged unions, arrays, records, `Unknown`, u64 and checked numbers.
- **Foldkit Remote backends** (`NativeRemote`):
  - reads, queries, mutations written in R, and Live updates;
  - an in-memory store, SQLite or Postgres (SQLx).
- **Server-side rendering:** pages written with `R.Html`, rendered byte-identically to Foldkit's `renderToString` and hydrated by the unchanged Foldkit client. They can read Remote data, so the browser resumes without refetching.
- **Migration:** a translator turns supported upstream Foldkit SSR source into `R` builders ([example](examples/ssr-8b)).

## Data in SQL, compiled to SQLx

A Foldkit Remote backend keeps its data in SQLite or Postgres. You declare entities, queries and mutations as an ordinary [Foldkit](https://foldkit.dev) app does, and the browser imports the same declarations. The table binding is the one `foldkit-remote-drizzle` uses; for Postgres, bind a `pgTable` and say `dialect: "postgres"`.

```ts
// domain.ts: shared with the browser
export const Todo = Entity.define(
  "Todo",
  Schema.Struct({ id: Schema.String, title: Schema.String, done: Schema.Boolean }),
);
export const Todos = Query.define("Todos", {}, () =>
  Query.from(Todo).pipe(Query.orderBy(Order.asc(Todo.fields.title))),
);

// db.ts: the table behind the entity
export const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  done: integer("done", { mode: "boolean" }).notNull(),
});
export const bindings = bind({ Todo }, { Todo: { table: todos } });
```

Mutations are written in `R`. `R.RemoteStore` reads and writes rows, and `R.LiveHub` tells subscribed browsers what changed. This one is from [the example](examples/todo-remote/sources.ts):

```ts
// Read the stored todo, flip `done`, write it back. (`text` makes an R string literal.)
export const toggleTodo = NativeRemote.mutation(ToggleTodo, ({ input }) => {
  const id = R.Struct.get(input, "id");
  return R.Effect.flatMap(R.RemoteStore.get("Todo", id), (row) =>
    R.Option(Done).match(
      R.Option.flatMap(row, R.Schema.decodeUnknownOption(R.Schema.toCodecJson(Done))),
      {
        None: () => R.Effect.fail(NativeRemote.ServerError.make({ message: text("No such todo") })),
        Some: (found) => {
          const stored = R.Struct.get(found, "value");
          const values = Done.make({ done: R.Boolean.not(R.Struct.get(stored, "done")) });
          return R.RemoteStore.write("Todo", id, values).pipe(
            // Other clients watching this todo receive the new `done`.
            R.Effect.andThen(R.LiveHub.changed({ entity: "Todo", id }, ["done"])),
            R.Effect.andThen(
              R.Effect.succeed(
                NativeRemote.outcome(ToggleTodo).make({
                  output: R.Struct({}).make({}),
                  entities: R.Array.make(NativeRemote.patch(Todo, id, values)),
                }),
              ),
            ),
          );
        },
      },
    ),
  );
});

export default NativeRemote.compile(RemoteRpc, {
  domain: Data,
  sql: { dialect: "sqlite", bindings, databaseUrlEnv: "DATABASE_URL" },
  mutations: [addTodo, toggleTodo, deleteTodo],
  live: true,
});
```

**What it compiles to.**

- **Dependencies:** SQLx is the only database dependency, with only the driver you chose:
  ```toml
  sqlx = { version = "=0.9.0", default-features = false, features = ["runtime-tokio", "sqlite-bundled"] }
  ```
- **Queries:** each one becomes fixed SQL at build time, with keyset paging in both directions. The database URL is read at run time and never compiled in. Excerpt, reformatted:
  ```rust
  static REMOTE_SQL: remote_sql::Sql = remote_sql::Sql {
      queries: &[remote_sql::Query { name: "Todos", entity: "Todo",
          forward: remote_sql::Statement {
              sql: "SELECT `id` FROM `todos` ORDER BY `title` ASC, `id` ASC LIMIT ?1", .. },
          forward_after: remote_sql::Statement {
              sql: "SELECT `id` FROM `todos` WHERE ((`title` > ?1) OR (`title` = ?2 AND `id` > ?3))                     ORDER BY `title` ASC, `id` ASC LIMIT ?4", .. },
          .. }],
      url_env: "DATABASE_URL", .. };
  ```
- **Mutations:** each one runs in its own SQLx transaction (`BEGIN IMMEDIATE` on SQLite). It commits when the R program succeeds and rolls back when it fails or is interrupted. Live updates are sent only after the commit. Excerpt, abridged:
  ```rust
  // One store session per run: committed on success, rolled back on failure or interruption.
  let store = match REMOTE_SQL.begin().await /* ... */;
  let outcome = reffect_generated::r_runtime_mutation_0(&mut execution, arg).await;
  match outcome {
      Ok(value) => match store.finish(true).await { /* commit, then Live signals */ },
      Err(AsyncError::Fail(error)) => { let _ = store.finish(false).await; /* typed failure */ }
      // ...
  }
  ```

Reads, queries and mutations answer the stock `foldkit-remote` client exactly as `foldkit-remote-server` does over Drizzle. [examples/todo-fullstack](examples/todo-fullstack) runs this on SQLite or Postgres. An `R` handler for a plain RPC procedure that runs its own SQL is [not built yet](docs/open-work.md).

## The showcase: one binary, a whole app

[examples/todo-fullstack](examples/todo-fullstack) is a todo app whose entire backend is one native executable. It serves server-rendered pages, Effect RPC, Remote mutations and Live updates over SQLite or Postgres. The browser side is an ordinary Foldkit and Effect app.

```sh
vp exec node --experimental-transform-types examples/todo-fullstack/main.ts --port 8787
TODO_REMOTE_PORT=8787 vp dev examples/todo-remote/web
```

Add `--auth` for cookie sign-in, `--binary` for SchemaBinary, `--websocket` for one WebSocket session per browser, or `--postgres <url>` for Postgres. The server prints the matching browser command.

## Getting started

> **reffect is pre-release and not published yet.** Try it from this repository.

You need:

- [Vite+](https://viteplus.dev/guide/) (`vp`), which also manages Node;
- Rust and Cargo, with your platform's linker. On Windows, run native builds from a Visual Studio developer shell so MSVC's `link.exe` is used.

```sh
git clone https://github.com/doeixd/reffect.git
cd reffect
vp install
vp exec node --experimental-transform-types examples/rpc/main.ts
```

The library itself is `packages/reffect`; the examples import it from there.

## Good to know

- **reffect compiles a subset of Effect.** The `R` builders cover what can be compiled faithfully. Ordinary TypeScript still runs at build time, so you can generate handlers, loop over configuration, and so on. Unsupported code is refused with a diagnostic that points at it.
- **Behaviour matches official Effect** unless it is listed in [native divergences](docs/native-divergences.md). Every accepted difference is listed there, with its reason.
- **Not yet supported:**
  - general concurrency (`fork`, queues, semaphores), which is in progress;
  - server-to-client notifications and reverse RPC, which Effect 4.0's stock client can't receive yet;
  - raw TCP.

  See [open work](docs/open-work.md).

## Learn more

- [packages/reffect](packages/reffect/README.md): the library API in detail.
- [examples](examples): the examples, from a single expression to the full stack.
- [Roadmap](PLAN.md), [progress](PROGRESS.md) and [design documents](docs/README.md).
- [Contributor guidance](AGENTS.md).

## Development

```sh
vp check            # format, lint and type check
vp test             # tests, including fresh native builds compared against official Effect
vp run -r build
```

Native test suites build Rust crates, so run focused suites, for example `vp test tests/rpc.test.ts`, from `packages/reffect`.
