# Serving native RPC: connections, timeouts and threading

Status: **step 1 (timeouts and connection cap) delivered 2026-10-04** (`dbfdde1`; test `rpc-serving.test.ts`). The threading and concurrent-batch design (step 2) is open below. The issues are [#16](https://github.com/doeixd/reffect/issues/16) and [#25](https://github.com/doeixd/reffect/issues/25).

## Findings (checked 2026-10-04)

**axum 0.8.9 sets no timer.** Its `serve` builds `hyper_util::server::conn::auto::Builder::new(TokioExecutor::new())` (`serve/mod.rs:391`) and never sets a timer. hyper 1.11.1's `header_read_timeout` defaults to 30 s, but "requires a Timer… to take effect" (`server/conn/http1.rs:352`), so headers were never timed out.

**Nothing else bounds the server.**

- Body reads (`Bytes` extractor) have no time limit.
- The number of connections is not bounded.
- Each generated server runs `#[tokio::main(flavor = "current_thread")]`.

**The memory backend's consistency rests on the single thread.**

- RS-004 memory semantics hold because the runtime is single-threaded; the review checked this. A memory mutation's writes and reads never interleave with another request's.
- One request's body runs its messages one at a time (`rpc-runtime.ts`). Official `RpcServer` forks a fiber per request with unbounded concurrency.

**Official reference points.** Node's HTTP server defaults to `headersTimeout` 60 s and `requestTimeout` 300 s, with no connection cap. The official server therefore has time limits; reffect had none.

## Step 1: timeouts and a connection cap (no semantic change)

- **One `serve` function.** Both generated mains (`plainMain` and `layeredMain`) call one `serve(listener, app, shutdown)` instead of `axum::serve`. It runs an accept loop over:
  - `hyper::server::conn::http1::Builder`, with `TokioTimer` and `header_read_timeout`;
  - `hyper_util::server::graceful::GracefulShutdown`, which keeps the layered server's drain-then-release order;
  - an `Arc<Semaphore>` of connection permits, taken before `accept`.
- **When the cap is reached,** accepting waits and further clients queue in the OS backlog. Nothing is refused.
- **`TCP_NODELAY`** is set as before.
- **Accept errors** (for example `EMFILE`) back off briefly instead of spinning.
- **Body reads** run axum's own `Bytes` extractor under `tokio::time::timeout`. An oversized body keeps its current rejection (413 through `DefaultBodyLimit`), and a body that stalls past the limit is answered 408.
- **Defaults.** 30 s for headers and 30 s for the body, which is tighter than Node and sized for RPC payloads; 1024 connections. All three are configurable through `limits` (`headerTimeoutMs`, `bodyTimeoutMs`, `connections`).
- **New direct dependencies,** pinned to the versions axum already resolves:
  - `hyper = "=1.11.1"` (features `server`, `http1`);
  - `hyper-util = "=0.1.21"` (`tokio`, `server-graceful`);
  - `tower = "=0.5.3"` (`util`).
- **Unchanged.** Streaming responses (NDJSON Live) are unaffected: only reading the request is timed, never the response.

**Acceptance**

- A connection that sends partial headers is closed after the header timeout.
- A request whose body stalls is answered 408.
- With a cap of N, an (N+1)th connection is served only after one closes.
- The existing RPC, Remote and page suites pass unchanged.

## Step 2: threading and concurrent batches (open)

Moving to a multi-thread runtime, or running a body's requests concurrently, would let memory-backend mutations interleave. Before that change:

- decide the memory store's locking unit (per mutation session, or per table);
- show RS-004 still holds under concurrency;
- settle response ordering in JSON mode against official `RpcServer`.

Until then, the single-threaded profile and the sequential batch are recorded in `native-divergences.md`.
