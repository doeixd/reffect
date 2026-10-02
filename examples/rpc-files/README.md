# Native scoped-file RPC

```sh
vp exec node --experimental-transform-types examples/rpc-files/main.ts
```

The example creates a temporary input file, compiles a handler with a build-time path, builds a native server, and calls it through the unchanged stock Effect RPC client. The Rust handler owns a real read-only File across suspension, returns its exact u64 size, and closes it before its after-close log. The executable needs no Node runtime. The example process scopes the server and temporary files.

Open/metadata failures project to typed Boolean `false`. Paths are static compiler inputs; this is not an arbitrary file-serving endpoint. Read-only close errors are ignored consistently with Rust File Drop. [The design and conformance record](../../docs/research/scoped-files.md) covers acquisition/use/cleanup cancellation, escaping-reference refusals and real socket disconnects. General resource Scope registration and resource Layers follow separately.
