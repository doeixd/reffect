# Native unary RPC example

Run from the repository root with Node 22.18+ and Rust/Cargo installed:

```sh
vp exec node --experimental-transform-types examples/rpc/main.ts
```

The example constructs scalar handler IR, generates a Rust server, explicitly fetches its pinned Cargo dependencies, builds offline, starts on an ephemeral loopback port and calls it with the stock Effect RpcClient and FetchHttpClient. Expected output:

```text
stock client → native Rust: sum=0, typed failure=false
```

The server process and temporary crate close when the Effect scope exits. [contract.ts](contract.ts) contains ordinary shared RpcGroup/Schema definitions; clients can import the contract without importing handler IR. The schema-only `reffect/rpc-codecs` import loads the contract codec without importing reffect compiler modules.

For a persistent executable, build [server.ts](server.ts), whose default export is the compile effect, with the CLI:

```sh
vp exec node packages/reffect/bin/reffect.js build examples/rpc/server.ts --release
./server --port 3000
```

Default binding is 127.0.0.1; `--host` selects another bind address and `--port 0` selects an ephemeral port. The current profile supports scalar synchronous handlers, required flat payload records, unary JSON/HTTP and the default defect codec. See [the native profile](../../docs/research/unary-rpc.md#native-http-slice-preparation-2026-10-01) for limits and following work.
