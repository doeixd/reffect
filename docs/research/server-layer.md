# Server-lifetime Layers for native RPC

Status: **accepted for implementation** (milestone 3B, PLAN frontier). Checked 2026-10-02 against installed Effect **4.0.0-rc.118** (`src/rpc/RpcGroup.ts`, `src/rpc/RpcServer.ts`, `src/Layer.ts`) and the current generated Axum/Tokio server. Builds on [per-invocation resource Layers](resource-layer.md), [bounded Scope registration](resource-scope-registration.md), [suspended RPC](async-rpc.md) and [checked bearer auth](rpc-auth.md).

## Pinned upstream semantics

- `RpcGroup.toLayer(build: Handlers | Effect<Handlers, EX, RX>)` returns `Layer<ToHandler<R>, EX, Exclude<RX, Scope> | ...>` through `Layer.effectContext`. The build effect runs **once** when the server's layer graph is built; handlers close over services it acquired, and its Scope registrations live as long as that layer.
- `RpcServer.layer(group)` is `Layer.effectDiscard(Effect.forkScoped(make(group)))`; `layerHttp` provides the protocol. The application runs through `Layer.launch`, which builds the graph and waits forever until interrupted.
- Shutdown: `make` registers a server-scope finalizer that sets `isShutdown` (new requests are interrupted), interrupts every in-flight request fiber and awaits them through a latch. The server layer depends on the handler layer, so it is released **first**; handler-layer registrations are released afterwards in reverse order. Handler finalizers therefore complete before services they use are released.

## Current native state

- Generated servers build an immutable `RuntimeState` once at startup (credentials for auth) and dispatch each request with an owned `AsyncContext` whose cancellation fires on client disconnect.
- `axum::serve` runs until the process dies. There is no graceful shutdown, so no server-lifetime cleanup can run. [Async RPC](async-rpc.md) explicitly excludes draining.

## Options

| Option                                                     | Assessment                                                                                                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SL-A: per-request provide (status quo)                     | Wrong acquisition count versus `toLayer`; cannot model a pool or startup config                                                                                                     |
| SL-B: startup function returning values, no open scope     | Scope closes when the function returns, so registered resources would be released before serving; multiple services need records/tuples we do not have                              |
| **SL-C: launch computation held open by an internal node** | `provide(layer, ctx => Launch(values))` acquires once, publishes scalar values to the host, then suspends like `Effect.never` until shutdown cancels it; existing Scope closes LIFO |
| SL-D: native global singletons / lazy statics              | Breaks ordering, cancellation and cleanup awaiting; rejected                                                                                                                        |

## Decisions

- **SL-001 — accepted: launch computation (SL-C).** `NativeRpc.compile(group, bindings, { layer })` stages one internal function `provide(layer, ctx => Launch([...service values]))`. `Launch` is an internal ComputationNode (not exported on `R`): it hands its scalar values to the host once, then waits like `Effect.never` until interrupted. The checker refuses it in cleanup or masked positions. Reference interpretation publishes through an injected host service and then `Effect.never`.
- **SL-002 — accepted: scalar services are copied into handlers.** `NativeRpc.bindServices(fn, [ServiceA, ...], fields)` passes server services as leading handler arguments, like `bindPrincipal`. Values are plain `u64`/`bool`/`()` held in `RuntimeState`; sharing is copying, so no cross-request borrow or `Arc` is needed. Resources (for example a registered file) remain owned by the launch future's scope, never by handlers.
- **SL-003 — accepted: startup ordering.** Main runs the launch future on its own task with its own `AsyncContext`; it serves only after values arrive. An acquisition failure exits nonzero before binding the listener, after releasing anything already registered; the ready record is never printed.
- **SL-004 — accepted: graceful shutdown mirrors `RpcServer`.** On Ctrl-C, or EOF on stdin when started with `--shutdown-on-stdin-eof` (for deterministic tests), the server stops accepting, refuses new requests with an interruption, signals cancellation to every in-flight request and awaits them. Only then does it cancel the launch future, whose Scope releases server-lifetime registrations in LIFO order, and the process exits 0. A server-wide shutdown watch is combined with each request's disconnect cancellation.
- **SL-005 — accepted: reachability.** `AsyncContext` gains a launch-publication field only when `Launch` is reachable; servers without a layer keep their current shape and dependencies. No new crate. Tokio `signal` and `io-std` features are added only for layered servers.

## Delivered implementation

Delivered 2026-10-02 as decided, with these concrete boundaries:

- `Launch` is an internal ComputationNode with semantic reference `reffect/effect/launch@1` and frame kind `launch`, constructed by `launch(values)` in `effect-ir.ts`. Reference interpretation publishes through `LaunchHost` (`launch-host.ts`) and dies without one. The checker requires Never channels and scalar values; scope analysis refuses it in cleanup. Native code emits `ctx.launch((…)).await` and the generated `pub type LaunchValues` tuple; `AsyncContext` gains `launch` and `set_launch` only when the node is reachable, and a module may publish only one tuple shape.
- `NativeRpc.bindServices(services, fn, fields?)` and `NativeRpc.compile(group, bindings, { layer })`. The compiler stages a function named `launch` as `provide(layer, ctx => Launch(services))`, deduplicating services by ID in first-binding order; `RpcArtifact.runtime.services` reports that order. Handlers read their values from a set-once `OnceLock` in the executable's `main.rs`, never the library. Protected procedures cannot also bind services yet.
- Layered servers use a separate main and add Tokio `signal`; a per-request forwarder turns the server-wide shutdown watch into that request's cancellation, including requests arriving on kept-alive connections after shutdown starts. Stdin EOF is read on a plain thread, so no `io-std` feature is needed.

Evidence: [server-layer.test.ts](../../packages/reffect/tests/server-layer.test.ts) passes 3/3. The official `RpcTest` client with `Group.toLayer` and our reference launch produce identical results and acquire/release traces. Refusals and unchanged no-layer output are covered. Debug and release native servers serve eight concurrent stock-client calls on one acquisition; on stdin EOF, an in-flight sleeping request is interrupted and its `ensuring` cleanup logs before `release flag`, `release base`, and the process exits 0. A failing acquisition exits 1 with `acquire base, acquire flag, release base`, the startup record and no ready record. Disabling the shutdown forwarder fails the test.

## Deferred

Service objects/methods, non-scalar services, per-request layers combined with server layers, concurrent merge, `Layer.launch` for non-RPC executables, shutdown deadlines/forced abort, and draining in-flight requests instead of interrupting them (Effect interrupts).

## Acceptance

- Reference: official `RpcServer` + `group.toLayer(Effect.gen(...))` versus our reference launch shows one acquisition across many requests and the same results.
- Native debug/release with real sockets and the stock client: acquisition logged once across concurrent requests; handler results use the shared value; on stdin EOF, an in-flight sleeping request is interrupted and its finalizer completes **before** server-lifetime releases, which run LIFO; exit code 0.
- Startup failure: nonzero exit, LIFO release of earlier registrations, no ready record.
- Servers without a layer keep their generated `AsyncContext` fields and crate features unchanged.
