# Native versus official Remote server: first measurements

Status: **measured 2026-10-03** on win32/x64 (Node 24.21 under `vp exec`, rustc 1.90.0, Effect 4.0.0, `foldkit-remote-server` 0.10.0). Scripts:

- [remote-bench.ts](../../packages/reffect/scripts/remote-bench.ts) and [remote-bench-official.ts](../../packages/reffect/scripts/remote-bench-official.ts): two servers, each in its own process, measured over HTTP.
- [remote-bench-engine.ts](../../packages/reffect/scripts/remote-bench-engine.ts): the official engine timed in-process.
- [Raw HTTP results](remote-bench-results.json).

## Setup

- **Data:** 500 users and 5,000 projects (each project has an owner ref).
- **Official server:** `RemoteServer.handlers` with memory sources, served by `RpcServer.layerHttp` on `NodeHttpServer`.
- **Native server:** `NativeRemote.compile`, release build, single-threaded Tokio (`current_thread`), like Node's single event loop.
- **Workloads:**
  - one project with its owner;
  - a screen-sized batch of 50 projects with owners;
  - a `ByStatus` query page of 20 with `select`.
- **Load:** Node `fetch` with keep-alive from 4 worker threads, 32 concurrent requests in total, 300 warm-up and 4,000 measured requests per workload. The two servers' answers are checked equal before timing.

## Results

| Measure                          | Native                                           | Official       |
| -------------------------------- | ------------------------------------------------ | -------------- |
| Peak server memory (working set) | **20 MiB**                                       | 260–286 MiB    |
| HTTP, read-one (req/s, p50)      | 2,713, 10.1 ms                                   | 1,830, 14.4 ms |
| HTTP, read-batch-50 (req/s, p50) | 454, 67.6 ms                                     | 403, 79.2 ms   |
| HTTP, query-page-20 (req/s, p50) | 400, 69.0 ms                                     | 280, 116.2 ms  |
| In-process engine, Read batch-50 | 568 µs (system allocator); **287 µs** (mimalloc) | 334 µs         |
| In-process engine, Query page-20 | 529 µs (system allocator); **405 µs** (mimalloc) | 885 µs         |

**HTTP numbers are client-bound and must not be read as server throughput.** On this machine every Node `fetch` costs at least about 15.6 ms, which is the Windows timer tick. Sequential latency is 15.4 ms for every workload against _both_ servers. In-process engine time is well under 1 ms. The HTTP table shows native is never slower end to end, but how fast each server really is needs a native load generator (for example `oha`) or a Linux host.

## Linux with a native load generator (BENCH-003)

Measured 2026-10-03 on WSL2 Ubuntu (linux/x64, glibc allocator), Node 22.22.2, rustc 1.99.0, the same data and workloads, with [oha](https://github.com/hatoo/oha) 1.16.0 as the client (32 connections, 300 warm-up and 4,000 measured requests) and peak resident memory from `VmHWM`. The native server includes the writable store (one `RwLock`, version-keyed query cells). [Raw results](remote-bench-results-linux.json).

| Measure                       | Native                      | Official                |
| ----------------------------- | --------------------------- | ----------------------- |
| Peak server memory (resident) | **15.4 MiB**                | 334.6 MiB               |
| read-one (req/s; p50, p99)    | **14,175**; 2.3 ms, 2.6 ms  | 2,545; 11.5 ms, 20.2 ms |
| read-batch-50                 | 1,225; 26.9 ms, 29.4 ms     | 1,032; 29.9 ms, 66.7 ms |
| query-page-20                 | **1,438**; 22.8 ms, 25.4 ms | 743; 42.0 ms, 56.6 ms   |

Reading these numbers:

- The client is no longer the bottleneck, so these are server numbers. Both servers use one core (`current_thread` Tokio, one Node event loop).
- Small requests are dominated by protocol overhead, where native is about 5.6× faster with much tighter tails.
- The batch read is dominated by engine work and response building (about 0.8 ms per request natively). Native is only about 1.2× faster here, with a far better p99. This is the allocation cost found in-process, and BENCH-002 still applies to it.
- Query is about 1.9× faster, helped by the cached cells.
- The memory result holds on Linux: about 22× less resident memory.
- Not measured: Linux with mimalloc, so BENCH-001 is unchanged. Multi-core scaling is also unmeasured.

## Findings and changes

1. **Query rebuilt every row's evaluator cells per request** (5,000 rows, UTF-16 re-encoding). Each query definition now caches its cells; query throughput over HTTP went from 103 to 400 req/s. The cache is keyed by the store version, so writes invalidate it (RS-005).
2. **Axum 0.8.9 leaves Nagle's algorithm on**, while Node's HTTP server disables it. The native server now sets `TCP_NODELAY` on accepted connections (`tap_io`). It made no measurable difference here, but it matches the reference deployment.
3. **A literal port is not automatically faster than V8.** The first in-process Read was 660 µs against V8's 334 µs:
   - Grouping rebuilt merged slices and deep-copied relation trees per request; it now merges in place (`merge_into`, same semantics: first-position keys, duplicates, empty windows absent).
   - The read loop cloned each record's values three times; it now moves them once.

   Read went from 660 to 568 µs.

4. **Allocation dominates the rest.** The same build with `mimalloc` as the global allocator halves engine time (Read 287 µs, Query 405 µs), ahead of V8 on both.

## Options and recommendation

| Option                                                 | Trade-off                                                                                                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mimalloc` (or another allocator) in generated servers | About a 2× gain at once. It adds a C-built dependency (`libmimalloc-sys`, needs a C toolchain) to every server; this should be an explicit build option, not silent          |
| Fewer allocations in the engine                        | Borrow request strings, use `Arc<str>` for row values and field names, intern group keys. Portable, but more engine code — which a compiled-in-R engine would replace anyway |
| Multi-threaded Tokio                                   | Scales across cores, which Node cannot do in one process. It changes the execution profile (Send bounds, shared state), so it needs its own decision                         |

## Decision (2026-10-03)

- **BENCH-001 — no allocator change now.** Don't switch generated servers to `mimalloc`, either by default or as an option, yet:
  - The evidence is one Windows workload, and Rust's system allocator on Windows (HeapAlloc) is known to be slower than glibc's.
  - Memory with mimalloc is unmeasured, and memory is this benchmark's solid result.
  - Every fast allocator adds C code (mimalloc, jemalloc, snmalloc, rpmalloc).
  - If adopted later, it is an opt-in for **server binaries only**, never for generated libraries (AGENTS.md: no globals from libraries), with the crate listed in the plan explanation.
  - Revisit when a Linux measurement shows a meaningful gain without a memory regression.
- **BENCH-002 — allocation belongs to the ownership stage.** The general lowering clones non-Copy values in value positions (REC-004), so compiled code, including a future R-authored engine, would allocate as much as the port. The lasting fix is ownership work: borrow read-only values, share immutable strings and composites (`Arc<str>`/`Rc`), and intern repeated names. Start it with the mutation and Store code (RM-001/002), the next workload whose value flow is still being designed. Only trivial allocation fixes go into the hand-ported engine.
- **BENCH-003 — throughput claims need a fair harness.** Measure on Linux with a native load generator (for example `oha`), recording CPU time and resident memory together, before stating server throughput.
