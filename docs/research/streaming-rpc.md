# Milestone 6: streaming RPC and real interruption

Status: **research and design (2026-10-03)**, not implemented. Scope: [implementation milestones §23–24](../implementation-milestones.md#23-milestone-6--streaming-rpc--real-interruption) and [RPC protocol: streams](../rpc-protocol.md#streams). It builds on the stream-module decisions CHAN-001/002/006/007/008 ([channel/stream modules](channel-stream-modules.md#decisions-and-alternatives)), the bounded async runtime and cooperative cancellation ([async RPC](async-rpc.md)), the structured task kernel ([structured concurrency](structured-concurrency.md)) and the lexical Scope profile ([resource Scope](resource-scope.md)).

## Sources (checked 2026-10-03, Effect 4.0.0 as installed)

- `effect/rpc` sources: `RpcMessage.ts`, `RpcSerialization.ts`, `RpcClient.ts` (`makeProtocolHttp`), `RpcServer.ts` (`makeProtocolWithHttpEffect`, `streamEffect`).
- A probe served a streaming RPC from the official `RpcServer.toHttpEffect` with `RpcSerialization.layerNdjson` and recorded the exact response bytes. A second probe measured `Stream.chunks` for the constructors below.

## Findings

**HTTP client (`RpcClient.makeProtocolHttp`).**

- One POST per request. Over HTTP only `Request` messages are sent; `Ack`, `Interrupt` and `Eof` are dropped (`if (request._tag !== "Request") return`), and the protocol declares `supportsAck: false`.
- Interrupting the calling fiber interrupts the HTTP request, so a client "interrupt" is the connection closing.
- **Framing decides streaming.** With `RpcSerialization.json` (`includesFraming: false`) the client reads the whole body and decodes one array, so a stream arrives only when it has ended. With `layerNdjson` (`application/ndjson`, framed) it decodes `response.stream` incrementally, one message per line.

**HTTP server (`RpcServer.makeProtocolWithHttpEffect`).**

- Unframed: every message for the body, stream chunks included, is collected and answered as one JSON array.
- Framed: responses stream through a queue bounded at `streamBufferSize` messages (default 16). Backpressure is that buffer plus the HTTP body being pulled; there are no acks over HTTP (`disableClientAcks`).
- On the request scope's finalizer, if the queue has not ended (the client went away), the server shuts it and writes `Interrupt` for every request ID of that body, interrupting the handler fibers.
- NDJSON decoding skips malformed lines silently; each message is `JSON.stringify(message) + "\n"`.

**Wire format, captured** (framed, request `{"_tag":"Request","id":"1","tag":"Ticks","payload":…,"headers":[]}\n`):

| Handler stream                                    | Response lines                                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `Stream.make(1, 2, 3)`                            | `{"_tag":"Chunk","requestId":"1","values":[1,2,3]}` then `{"_tag":"Exit","requestId":"1","exit":{"_tag":"Success","value":null}}` |
| `Stream.empty`                                    | only the `Exit` (no empty `Chunk`; chunks are non-empty)                                                                          |
| `concat(make(1, 2), fail("boom"))`                | `Chunk [1,2]` then `Exit` `{"_tag":"Failure","cause":[{"_tag":"Fail","error":"boom"}]}`                                           |
| `range(1, 5).pipe(rechunk(2))`                    | `Chunk [1,2]`, `Chunk [3,4]`, `Chunk [5]`, `Exit`                                                                                 |
| `fromSchedule(spaced("20 millis")).pipe(take(3))` | one `Chunk` per element, `[0]`, `[1]`, `[2]`, then `Exit`                                                                         |
| two requests in one body                          | each request's chunks and exit, in request order                                                                                  |

A stream's successful `Exit` carries `"value":null`.

**Chunk boundaries are observable**, because one `Chunk` message is written per array the stream emits (`Stream.runForEachArray`). Measured with `Stream.chunks`:

- `make` and `fromIterable` emit the whole input as one chunk;
- `range` emits chunks of 4,096 (`range(1, 10000)` → 4096, 4096, 1808);
- `concat` keeps each side's chunks;
- `filter` filters within a chunk;
- `take` slices (`range(1, 10000).take(5000)` → 4096, 904).

**Disconnect.** Cancelling the response reader after the first `Chunk` ran the handler stream's `Stream.ensuring` finalizer on the server.

## Decisions

- **STREAM-001 — streaming is NDJSON over HTTP, chosen like `RpcSerialization`.**
  - `NativeRpc.compile` takes `serialization: "json" | "ndjson"`, mirroring `RpcSerialization.layerJson`/`layerNdjson`. JSON stays the default and keeps today's buffered array, with stream chunks included as the official server includes them.
  - NDJSON frames requests and responses one message per line, for unary and streaming procedures alike, and streams responses as they are produced.
  - Not negotiated per request: the official server is configured with one serialization, and a client is too.
- **STREAM-002 — no acks; bounded buffering.** Over HTTP neither side sends acks, so the native server reproduces the official policy: a channel of at most 16 messages between the handler and the response body. A full buffer suspends the handler, so a slow reader slows the producer. Acked backpressure waits for WebSocket transports (milestone 11).
- **STREAM-003 — interruption is disconnect.**
  - When the response body is dropped before the stream ends, the native server cancels the handler's task through the existing cooperative cancellation. The handler unwinds through the interruption path, so its finalizers (`Stream.ensuring`, Scope registrations) run and are awaited once (CHAN-007).
  - Dropping the future alone is not enough; this is the same masked, awaited cleanup the async runtime already gives unary handlers.
  - The interrupted request writes nothing, since nobody is reading.
- **STREAM-004 — chunks follow Effect's chunk structure.** Native streams carry `Vec<T>` chunks, and each admitted constructor and operator reproduces Effect's boundaries as measured above. A `Chunk` message is written per non-empty emitted array. The streaming RPC tests compare responses byte for byte with the official server, so a boundary change fails them.
- **STREAM-005 — the first Stream subset.**
  - Finite sources: `make`, `fromIterable` (an Array expression), `range`, `empty`, `fail`.
  - Pure operators: `map`, `filter`, `take`, `rechunk`, `concat`.
  - Effectful: `mapEffect` (sequential), `fromSchedule` for timed sources, and `ensuring`.
  - Consumers inside programs: `runCollect` and `runForEach`.

  Lowering is the specialized pull state of CHAN-002: one generated struct per stream pipeline with a `pull` that yields the next chunk, done, a typed failure or an interruption (CHAN-001's termination variants). Concurrency (`merge`, buffered producers), Queue/PubSub sources and general `Channel`/`Sink` stay out (CHAN-003..006).

- **STREAM-006 — streaming procedures.** An `Rpc.make(…, { stream: true })` binds an R function returning a Stream of the success witness, failing with the error witness. Chunks are encoded with the success encoder; the final `Exit` uses the error encoder and `Success` with `value: null`.

## Alternatives considered

- **Per-request content negotiation.** Rejected: neither official side negotiates, and accepting both on one endpoint would hide misconfiguration that the official server would expose.
- **Acks over HTTP.** Not possible with the stock client, which never sends them.
- **Tokio broadcast or unbounded channels for the response buffer.** Rejected: they would change backpressure, whereas the official buffer is bounded and suspends the producer.
- **Server-Sent Events.** Not the Effect RPC wire format.

## Order of work and acceptance

1. **Done for the pure subset (2026-10-03).** `R.Stream` provides `make`, `fromIterable`, `range`, `empty`, `fail`, `map`, `filter`, `take`, `rechunk`, `concat`, `chunks` and `runCollect` ([stream.ts](../../packages/reffect/src/stream.ts), [stream-ir.ts](../../packages/reffect/src/stream-ir.ts)).
   - **Push fusion, not a pull struct.** Natively the pipeline is one fused chunk loop. Each stage hands its non-empty chunks to the next.
     - `map` and `filter` run the verified Array loops over a borrowed chunk.
     - `take` and `rechunk` keep local state and leave through labelled blocks.
     - A failure breaks out past `rechunk`'s flush, as Effect drops the buffer.
     - `range` reproduces `Arr.range`'s chunks, including fractional and `NaN` bounds.

     This replaces the pull-struct sketch of CHAN-002 with the same fusion it asked for. The async consumers in steps 3–4 continue it, with a continuation that awaits.

   - **Validation:** [stream.test.ts](../../packages/reffect/tests/stream.test.ts) compares 24 cases with the official server as `runCollect(chunks(…))`, so every boundary is checked.
   - **Costs noted:**
     - `make`/`fromIterable` clone their array once (`to_vec`);
     - `concat` duplicates its downstream code per branch.
   - **Remaining in STREAM-005:** `mapEffect`, `fromSchedule`, `ensuring` and `runForEach`, which need the async consumer and come with steps 3–4.

   Original step: **Stream IR and native pull lowering** for the STREAM-005 subset. Done when it agrees with official `Stream.runCollect` and with `Stream.chunks` boundaries for every constructor and operator, including failures part-way.

2. **NDJSON serialization** for NativeRpc (STREAM-001), unary first. Done when native answers equal an official `layerNdjson` server's, byte for byte, across the existing unary corpora.
3. **Streaming procedures** (STREAM-006). Done when native responses equal the official server's byte for byte for the probe's table, under NDJSON and JSON, and a stock `RpcClient` over `layerNdjson` consumes a native stream incrementally (the first chunk arrives before the stream ends).
4. **Interruption** (STREAM-003). Done when a client that aborts mid-stream makes the native handler run its finalizers exactly once, observed as the official probe observed `Stream.ensuring`, and the server keeps serving. A full buffer must suspend the producer (STREAM-002).
5. **Live skeleton.** `FoldkitRemoteLive` served as a stream, lifting NR-006's refusal, as the bridge to milestone 7.

## Open questions

- Which observation channel to use for finalizer evidence in step 4 (a store write, a log line, or a launch value), and how the official side records the same.
- Whether `Stream.fromIterable` over a dynamically sized Array needs a `Chunk` representation, or one owned `Vec` per chunk suffices (measure in step 1).
- How a batch with a streaming request and a unary request interleaves in the native response. The official server answers in completion order per request; this needs a probe with a slow stream beside a fast unary call.
