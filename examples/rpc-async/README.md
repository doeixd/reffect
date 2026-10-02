# Suspended authenticated RPC

This example reuses the shared stock Effect contract from [rpc-auth](../rpc-auth/contract.ts).
Its compiled WhoAmI handler logs under a principal annotation/span, suspends for
250 ms, returns the principal or a typed Boolean failure, then awaits two delayed
finalizers. Public remains synchronous in the same group.

From the workspace, with Rust installed:

```bash
REFFECT_RPC_CREDENTIALS='[{"token":"local-example-token","principal":"9007199254740993"}]' \
REFFECT_RPC_CLIENT_TOKEN='local-example-token' \
vp exec node --experimental-transform-types examples/rpc-async/main.ts
```

The runner compiles an ephemeral server and calls it with the unchanged stock
RpcClient. Credentials are runtime configuration, not generated code. Existing
bearer bounds and scalar schema limits apply. Production token management is an
application concern.

[Native tests](../../packages/reffect/tests/async-rpc.test.ts) also disconnect a real
socket after the handler starts. The HTTP body signals cooperative cancellation;
the worker finishes masked async cleanup exactly once and skips the next batched
handler. Concurrent principals retain independent request IDs, annotations and
spans across suspension. Both debug/release and failure-capture policies are tested.

This is the first bounded async execution profile. General Scope/acquireRelease,
fallible cleanup, fibers, arbitrary services and graceful server draining remain
planned. Direct native callers must cancel cooperatively and await their future;
dropping it cannot run async cleanup.
