# Authenticated native unary RPC

The shared [contract](contract.ts) uses ordinary Effect RpcGroup/Schema/RpcMiddleware and a bigint principal service. The [handlers](handlers.ts) project that service into a plain native u64 argument; no context is carried on domain values. [main.ts](main.ts) generates the Rust server and calls it with the stock Effect client.

From the repository root, with Rust/Cargo installed:

```sh
REFFECT_RPC_CREDENTIALS='[{"token":"demo-token","principal":"9007199254740993"}]' \
REFFECT_RPC_CLIENT_TOKEN='demo-token' \
vp exec node --experimental-transform-types examples/rpc-auth/main.ts
```

First execution fetches the selected Cargo dependencies; build/run then use offline mode. The temporary crate and server are scoped. Expected output:

```text
authenticated stock client → native Rust: principal=9007199254740993, denial=Unauthorized, typed failure=false
```

Credentials are read by the native executable at startup. The client token is used only to call the endpoint. Neither value is embedded in generated code or logged. Invalid/missing configuration refuses startup with a generic error. The verifier accepts at most 32 credentials, 256 bytes per token and 16 KiB of configuration; each entry must contain exactly token and principal. A principal is a bounded decimal u64 string. This is a configured opaque bearer verifier; identity providers, JWT validation, token issuance and revocation remain future adapters.

`NativeRpc.bearer(Authentication, CurrentPrincipal, { credentialsEnv })` creates the checked adapter. Pass it as `NativeRpc.compile(group, bindings, { auth })`. Protected procedures use `NativeRpc.bindPrincipal(fn, fields)` with a u64 first argument followed by payload arguments. Public procedures use `NativeRpc.bind`. Domain failures remain separate from the middleware's string-literal denial.

Payload validation runs before authentication; denied requests never execute the handler. Header normalization follows Effect: HTTP headers first, then envelope pairs, lowercased with the last value winning. Envelope authorization overrides transport authorization. Headers never enter diagnostic context.

Handler logs retain their existing annotations/spans and receive a separate structured request field containing id, tag and principal (null on public calls). Synchronous dispatch owns a stack context borrowing from the HTTP-owned body; a lexical log-context guard restores prior context on both exits and unwinding. Overlapping socket calls are tested with different principals. This establishes synchronous isolation; async compiled effects, task migration, cancellation, general Services/Layers, tracing propagation/export and server draining still need separate semantics and tests. See [the design and evidence](../../docs/research/rpc-auth.md).
