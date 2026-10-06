# reffect

**Write your Effect server in TypeScript. Ship it as a native Rust binary.**

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
);
```

**2. Write the handlers with `R`.** `R.fn` takes the input types, the output type, an optional error type, and a body over symbolic values. Success, typed failure and matching work as they do in Effect.

```ts
// server.ts
import { NativeRpc, R } from "reffect";

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
};
```

**3. Compile, build and run it.** `NativeRpc.compile` returns a Cargo crate. `CargoApi` writes it, fetches its pinned dependencies and builds it.

```ts
const artifact = yield * NativeRpc.compile(Arithmetic, bindings);
const directory = yield * CargoApi.write(artifact, "./server");
yield * CargoApi.fetch(directory);
yield * CargoApi.build(directory, "release");
```

```sh
./server/target/release/reffect_generated --port 3000
# {"schema":"reffect.rpc.ready@1","address":"127.0.0.1:3000"}
```

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
```

The whole program is in [examples/rpc](examples/rpc). Run it with:

```sh
vp exec node --experimental-transform-types examples/rpc/main.ts
# stock client → native Rust: sum=0, typed failure=false
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

## The showcase: one binary, a whole app

[examples/todo-fullstack](examples/todo-fullstack) is a todo app whose entire backend is one native executable. It serves server-rendered pages, Effect RPC, Remote mutations and Live updates over SQLite or Postgres. The browser side is an ordinary Foldkit and Effect app.

```sh
vp exec node --experimental-transform-types examples/todo-fullstack/main.ts --port 8787
TODO_REMOTE_PORT=8787 vp dev examples/todo-remote/web
```

Add `--auth` for cookie sign-in, `--binary` for SchemaBinary, `--websocket` for one WebSocket session per browser, or `--postgres <url>` for Postgres. The server prints the matching browser command.

## Getting started

You need:

- [Vite+](https://viteplus.dev/guide/) (`vp`), which also manages Node;
- Rust and Cargo, with your platform's linker. On Windows, run native builds from a Visual Studio developer shell so MSVC's `link.exe` is used.

```sh
vp install
vp exec node --experimental-transform-types examples/rpc/main.ts
```

reffect is not published to npm yet. Use it from this workspace (`packages/reffect`).

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
