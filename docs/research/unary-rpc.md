# Unary RPC conformance foundation

Checked 2026-10-01 against installed Effect and platform-node **4.0.0-rc.118**. Preparation was recorded before implementation of the harness; checked results below now describe its tests. The [RPC MVP](../rpc-mvp.md) and [milestone 3](../implementation-milestones.md#18-milestone-3--unary-effect-rpc) require an unmodified Effect client calling a generated native backend. Boolean/u64/Unit computations, typed failures, local logging and logical frames already exist; native HTTP serving and general Schema lowering do not.

## Sources and observed contracts

Primary versioned sources: [RpcMessage](https://unpkg.com/effect@4.0.0-rc.118/src/rpc/RpcMessage.ts), [RpcClient](https://unpkg.com/effect@4.0.0-rc.118/src/rpc/RpcClient.ts), [RpcServer](https://unpkg.com/effect@4.0.0-rc.118/src/rpc/RpcServer.ts), [RpcSerialization](https://unpkg.com/effect@4.0.0-rc.118/src/rpc/RpcSerialization.ts), [HttpEffect](https://unpkg.com/effect@4.0.0-rc.118/src/http/HttpEffect.ts), and [FetchHttpClient](https://unpkg.com/effect@4.0.0-rc.118/src/http/FetchHttpClient.ts). Downloaded RpcMessage agrees byte-for-byte with the installed source. Current upstream was also checked; pinned executable behavior takes precedence over main.

- RC.118 exports these APIs from `effect/rpc` and `effect/http`; preserved examples and current upstream use `effect/unstable/...`. Installed exports take precedence.
- `RpcSerialization.layerJson` is Effect's tagged protocol with application/json, not JSON-RPC 2.0. Its codec is `Schema.toCodecJson`; raw Schema types alone do not define JSON representation.
- HTTP POST carries a Request with id, tag, payload and a list of header pairs. Optional trace fields are protocol metadata, distinct from payload fields and HTTP headers.
- The unframed server buffers response messages into a JSON array. An Exit correlates by requestId and contains Success/value or Failure/cause entries (Fail/error, Die/defect, Interrupt/fiberId). Schema-invalid payloads and unknown tags are protocol defects, not domain failures or automatically HTTP 400.
- The HTTP client rejects empty responses and bodies without a terminal response. HTTP supports no acknowledgement; server request scope cleanup sends interruption internally on disconnect. This does not establish end-to-end native cancellation support.
- Server HTTP headers are prepended to envelope headers before dispatch. Scoped request context, trace propagation, and transport headers must be verified separately.

## Selected approach

Build a test-only reusable harness around the stock RpcClient HTTP protocol, FetchHttpClient and RpcServer Web HTTP handler. Capture actual request and response bytes without replacing Schema serialization or RPC dispatch. Use an injectable Fetch transport: deterministic Web Request/Response dispatch for the reference oracle now; real fetch to the native server later. This exercises HTTP application semantics without claiming socket, CORS, disconnect or streaming coverage. Keep infrastructure out of the package barrel.

Use a shared RpcGroup for modular u64 addition, Boolean typed failure, and exact Unit. Decimal-string bigint codecs and bounded u64 validation protect the JSON boundary from number precision loss; records here are wire payloads, not a promise of general native record support. Golden portable JSON cases cover the wire representation independently of the stock decoder; they must never be silently regenerated when dependencies change. Unit encodes as JSON null in both payload and success, then decodes back to undefined. The stock HTTP client appends a trailing slash to the configured URL. RPC tracing disabled in golden cases does not disable the independent HTTP client tracing headers. Keep generated request IDs dynamic in client assertions; raw fixtures use explicit IDs. Disable RPC tracing in golden cases, then check RPC trace field presence separately.

Alternatives: custom REST would miss the actual protocol; testing serialization alone would miss dispatch, headers and completion; socket tests alone would make capturing/fault injection less focused. Add real network checks when the native HTTP adapter exists. Do not introduce a full Schema compiler, Rust reflection dependency or exporter to construct this oracle.

## Acceptance and following work

The harness must verify stock-client success/typed failure/Unit, exact request and response framing, bigint edge values, direct malformed input/unknown tag refusals without handler execution, concurrent request correlation/header isolation, and client rejection of broken responses. Portable fixtures can be replayed against an injected backend. Request scopes and timeouts must close on every test path.

After this passes, add the small generated Rust HTTP server and replay these same cases through real fetch. Then expand codecs and early auth/context middleware. Before asynchronous handler lowering, replace or isolate current native thread-local diagnostic context. Failure-frame storage truncates at 32, but intermediate frame vectors still grow: bounded accumulation and independent runtime instrumentation policy remain explicit follow-ups, not properties established by this harness.

## Running and reusing the harness

Run `vp test packages/reffect/tests/rpc.test.ts`. The shared contract, reference handler IR, capture harness, portable cases and replay helper live under [tests/fixtures/rpc](../../packages/reffect/tests/fixtures/rpc/harness.ts). `makeHarness(globalThis.fetch, nativeUrl)` selects a real backend; run `replayUnaryCorpus(harness)` inside an Effect scope and reuse `harness.client` for decoded stock-client checks. Only the reference oracle factory depends on the stock server. Raw request IDs include both strings and numbers; client-generated IDs are asserted dynamically. Malformed JSON diagnostic text is matched structurally because JavaScript engine wording varies; pinned Schema and unknown-tag vectors are exact.

This establishes an executable reference contract, not a native server or general RPC support in the compiler. Socket lifecycle, cancellation, auth, resource limits, payload schema compilation and native request context remain following work.
