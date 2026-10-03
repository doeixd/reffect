# Queue, PubSub, Stream, Channel and Sink admission

Prepared **2026-10-02** against Effect **4.0.0-rc.118**. This is a researched design and admission sequence, not implemented module support.
The [coverage inventory](../effect-module-coverage.md) governs relative priority; this record does not change the core roadmap.
Existing [runtime candidates](../runtime-lowering.md), [async ownership](async-rpc.md), [resource Scope](resource-scope-registration.md) and [resource Layers](resource-layer.md) supply context.
Concurrent ownership and wider Cause/Exit behavior still require independent gates; a sequential Scope is not a structured task supervisor.

## Primary evidence

The pinned published source was fetched and read for:

- [Queue](https://unpkg.com/effect@4.0.0-rc.118/src/Queue.ts): queue state, capacity, strategies, offer/take, termination and cancellation.
- [PubSub](https://unpkg.com/effect@4.0.0-rc.118/src/PubSub.ts): replay, subscriber Scope, backpressure, shutdown and sticky final messages.
- [Stream](https://unpkg.com/effect@4.0.0-rc.118/src/Stream.ts): array chunks, pull construction, queue/subscription sources and collection.
- [Channel](https://unpkg.com/effect@4.0.0-rc.118/src/Channel.ts): input/output element, error and completion channels; transform/bracket boundaries.
- [Sink](https://unpkg.com/effect@4.0.0-rc.118/src/Sink.ts): result plus non-empty-array leftovers and bounded consumption.
- [Pull](https://unpkg.com/effect@4.0.0-rc.118/src/Pull.ts): Effect success/error plus `Cause.Done<Done>` completion.
- [Tokio mpsc 1.53.1](https://docs.rs/tokio/1.53.1/tokio/sync/mpsc/index.html), [Tokio broadcast 1.53.1](https://docs.rs/tokio/1.53.1/tokio/sync/broadcast/index.html), and [futures-core Stream 0.3.32](https://docs.rs/futures-core/0.3.32/futures_core/stream/trait.Stream.html): candidate transport/poll mechanics.

Tokio matches the existing native dependency version; futures-core is only a researched candidate and is not selected as a new dependency.
Links and source inspection establish contracts, not measured adapter equivalence.

## Effect v4 behavior to preserve

`Queue<A,E>` is invariant in payload and terminal error. `make({ capacity?, strategy? })` defaults to unbounded capacity and `"suspend"`.
Named constructors are `bounded`, `dropping`, `sliding` and `unbounded`.
`offer` returns Boolean admission information; `offerAll` returns messages not admitted, rather than a single Boolean.
`take` returns one element; `takeAll` returns a non-empty array and can suspend. `clear` is the separate immediate drain operation.
`poll` returns Option and hides immediate terminal failure; this must not be confused with a nonblocking typed take.
The upstream implementation has `Open`, `Closing` and `Done` states, not only sender-open/receiver-closed.
`end` completes with `Cause.Done`; `fail`/`failCause` and `interrupt` establish other terminal outcomes.
Closing allows draining; immediate `shutdown` discards buffered messages and preserves an already-established terminal cause.
Shutdown returns Boolean idempotence information. Pending offers participate in closing/draining, so buffered length alone does not determine completion.
Capacity zero has rendezvous behavior in the Queue implementation; an adapter admitting only positive capacities must state that restriction.
The source does not perform PubSub's positive-capacity validation in Queue.make; do not infer identical capacity contracts.

PubSub is fan-out, while Queue transfers each item to a single consumer.
`subscribe` requires Scope and registers unsubscription cleanup; closing a subscriber releases capacity held for that subscriber.
A slow active subscriber constrains bounded suspend publishers. Dropping and sliding are distinct policies.
Replay is an explicit optional window, not an automatic retained history for late subscribers.
`shutdown` is uninterruptible, closes the hub Scope and interrupts subscription waiters; its result is Unit.
`end(finalMessage)` is different: buffered values precede a final message which consumes no capacity, survives dropping, and is sticky on repeated takes.
Late subscribers receive applicable replay followed by that final message; `takeUpTo` does not deliver it.
The adapter must distinguish hub termination, subscriber termination and publisher cancellation.

Stream v4 uses **non-empty arrays** as emitted chunks. It is not enough to mechanically port an older Chunk-based Stream design.
`fromArray`, `fromArrays`, `fromEffect`, `map`, `mapArray`, `mapEffect`, `rechunk`, `take`, `runCollect`, `runForEach` and `toPull` are relevant spellings.
`fromPull` accepts an Effect constructing a Pull. `toPull` acquisition requires Scope; pulls can suspend and carry ordinary error plus Done.
`fromQueue` excludes `Cause.Done` from its public ordinary error channel. Interruptions and defects remain distinct.
Pinned `mapEffect` flattens incoming arrays, applies Channel.mapEffect and wraps outputs as singleton arrays; pure map retains array boundaries.
Preserve the global element index versus chunk index of mapArray, and establish consumption/error ordering from the oracle before fusion.
`runCollect` returns a JavaScript Array, not Chunk. It consumes the whole successful stream and can grow without bound on unrestricted sources.
A Channel additionally has separate input/output completion values and errors; a Stream is a narrower chunk-producing use of it.
Sink uses result/input/leftover/error/environment parameters. `End<A,L>` carries a result and optional non-empty-array leftovers.
The collection sink is `Sink.collect()`, not the remembered older `collectAll` spelling. Early sinks may leave unconsumed elements in a pulled array.

## Priority and prerequisites

| Priority | Capability      | First useful profile                                                                | Gate before admission                                                           |
| -------- | --------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1        | Finite Stream   | Owned finite array source, pure map, take, runCollect/runForEach                    | Checked iteration ownership, pull completion, exact consumption/finalization    |
| 2        | Queue           | Positive constant capacity, scalar payload, suspend policy, offer/take/end/shutdown | Structured sibling tasks, cancel-safe waiters, terminal outcome representation  |
| 3        | Queue policies  | Dropping and sliding, followed by typed terminal failure                            | Exact offer results, retention order, closing races and Cause subset            |
| 4        | PubSub          | Bounded scalar fan-out, fixed scoped subscriber topology                            | Queue lifecycle foundation plus independent subscriber ownership/backpressure   |
| 5        | Sink            | collect/drain, then bounded fold and early take                                     | Leftovers and chunk-boundary conformance; bounded collector policy              |
| 6        | Public Channel  | Restricted input/output transforms                                                  | Explicit input/output errors and completion, scope-safe pull ownership          |
| 7        | Wider streaming | Queue/PubSub sources, buffering and HTTP stream consumers                           | End-to-end cancellation, backpressure, task supervision and transport lifetimes |

Finite Stream does not need producer tasks or a Queue internally. Admit that path first without manufacturing concurrency.
Queue can be researched in parallel but must not ship a suspend operation that deadlocks a single sequential execution path.
Pure finite Stream operations may lower to std. Any async source/operator is selected into Tokio only when reachable.
The first finite profile may refuse public escaping `toPull`/`fromPull` even while its compiler uses an internal scoped pull model.
Ordinary closures or arbitrary upstream Channel values do not become representable by naming a wrapper around them.

## Decisions and alternatives

**CHAN-001 — proposed: distinct termination algebra.**
Use concrete internal variants for emitted chunk/value, normal Done, typed failure, interruption and compiler/native defect.
Done is terminal control flow, never an ordinary element or an Option None that erases failure distinctions.
Channel completion payloads and Sink leftovers are separate fields with admitted witnesses.
Alternative: transport every terminal event as a user tagged union. That exposes compiler control flow as payload and risks catching Done as an ordinary error.
Gate: oracle tests establish end, typed failure, interrupt and shutdown observables, including repeated terminal operations.
Revisit before richer Cause composition or non-Unit Channel completion ships.

**CHAN-002 — proposed: specialized finite pull state.**
Generate an owned source/cursor plus operator state and concrete pull functions, scoped to the consumer.
Use an inline cursor and terminal flag; preserve source array lifetime and move/clone each payload according to checked ownership.
Fuse only pure operations with separately established chunk/error/take equivalence; do not eagerly materialize every intermediate array.
Alternative: futures Stream trait objects for every combinator. That brings allocation/type erasure without a demonstrated consumer.
A concrete futures-core Stream adapter remains useful at an actual Rust ecosystem boundary, after completion/error conversion is specified.
Gate: first/middle/last/zero takes, source reuse, owned String payloads, chunk traces and cleanup match Effect.
Revisit when named reusable pull interfaces, heterogeneous operators or ecosystem consumers require an adapter.

**CHAN-003 — proposed: Queue substrate plus lifecycle adapter.**
Tokio bounded mpsc is an excellent candidate for positive-capacity single-consumer scheduling and cancel-safe receiver waits, but is not Effect Queue.
Effect permits shared dequeue handles/multiple waiting takers; mpsc has one Receiver owner. A mutex wrapper changes waiter ownership and fairness.
For fixed one-consumer topology, specialize mpsc with explicit terminal state and retained failure rather than equating receiver close with shutdown.
For general admitted MPMC topology, prefer a bounded ring plus short-held mutex and cancellation-safe wake registration, reusing Tokio execution machinery.
Notify wakeups require register-before-recheck discipline to prevent lost wakeups; waiter tokens must unregister on cancellation.
Reserve transport capacity before transferring an owned payload, so cancellation while waiting does not silently lose or duplicate messages.
Gate: interrupted full-buffer offers, interrupted empty takes, FIFO traces, close/drain, idempotence and waiter release under repeated races.
Revisit topology selection when workload needs general handles; record any fairness guarantee only after pinned evidence.

**CHAN-004 — proposed: policy adapters are separate admission gates.**
Dropping reports rejected new messages; sliding retains the newest capacity-sized suffix. Partial offerAll results preserve unadmitted order.
A sliding operation must atomically evict/admit relative to takers; chaining try_recv and send on mpsc is not a general atomic implementation.
Gate: capacity 1 and 2, bulk offers, blocked producers during end/shutdown, and payload destruction accounting.
Refuse zero, fractional, infinite and dynamic capacities in the first native profile; explain each refusal without claiming upstream rejects them.
Revisit zero-capacity rendezvous only with its own pending-offer/cancellation proof.

**CHAN-005 — proposed: shared bounded PubSub ring, not broadcast alias.**
Tokio broadcast overwrites retained slots and exposes Lagged to slow receivers; that does not supply Effect bounded suspend backpressure.
Use shared ring entries with per-subscriber cursor/refcount and last-subscriber capacity release, plus explicit replay/end state.
Fixed subscriber count can use inline cursor storage. Dynamic subscribers need an admitted arena/lifetime design and measured growth policy.
Clone owned payloads only at each subscriber's ownership boundary; do not attach metadata or universal Arc to every scalar message.
Alternative: one bounded Queue per subscriber multiplies storage and can produce partial fan-out on cancellation; it needs a stronger commit protocol.
Gate: two subscribers at different speeds, unsubscribe while publisher blocks, no subscribers, replay, sticky final message and late subscriptions.
Revisit dynamic topology, replay and error-bearing Take messages as separate capabilities, not hidden defaults.

**CHAN-006 — proposed: Sink leftovers before general composition.**
Admit collect/drain over finite sources first. For early consumers, retain the exact remainder of the last non-empty input array.
Use an owned current array plus offset or a proven borrow whose source outlives the sink result; an escaping borrowed remainder is forbidden.
Do not rewrite a sink to ordinary element reduction if it changes pulling, effect evaluation or downstream leftover reuse.
Gate: take/fold stopping mid-array, exact remaining order, then feed leftovers into another sink without repulling or cloning unnecessarily.
Revisit fallible/effectful sink composition after source failure and partial-consumption ordering are specified.

**CHAN-007 — proposed: resource and task ownership precede concurrency.**
A stream consumer owns source acquisition/finalization; producer tasks are children of the stream scope, cancelled and awaited on every exit.
Client disconnect must stop pulling, cancel children, close waiters and await finalizers once; dropping a Rust future alone is insufficient for async cleanup.
A registered cleanup record cannot capture an arbitrary stream/queue future by heap boxing without a separate ownership and allocation decision.
Gate: slow producer, blocked consumer, consumer failure and disconnect all yield matching ordered finalization traces with no surviving children.
Revisit before buffer/merge/mapEffect concurrency, channel bridges or streaming RPC admission.

**CHAN-008 — proposed: explicit bounded runtime costs.**
Keep payload representation independent of source sites, spans, request context, waiter identity and scheduler state.
Queue storage is capacity times payload plus occupancy state; PubSub adds subscriber cursors/refcounts and optional replay storage.
Waiter memory depends on active suspended operations, not only queue capacity. Track or statically bound producer/taker/subscriber counts.
A native ring/Arc allocation per shared queue is acceptable if reachable and measured; zero per-message allocation applies only to admitted inline payloads.
Concrete suspended futures retain their captures; measure frame sizes and cleanup records for both diagnostic policies rather than assuming zero cost.
No hidden unlimited runCollect/replay/unbounded queues in a bounded profile. Explicit finite input bounds or a configured admission limit are required.
A runtime quota must be disclosed as an extra profile policy with its own outcome, not presented as unchanged Effect behavior.
Gate: buffer/waiter/subscriber high-water marks, allocation counts, generated Rust growth, dependency count and disabled-metadata baselines.
Revisit storage strategy when capacity/topology becomes dynamic or measured code/future growth exceeds an established budget.

## Exact first conformance workloads

Finite Stream: `fromArrays([[1,2],[3],[4,5]])`, log source pulls, pure map, then take 0/1/3/5/8 and runCollect.
Repeat with arrays of well-formed owned strings, empty input, a source failure after a partial chunk, and an ensuring finalizer.
Record both emitted non-empty arrays through scoped toPull and final flattened results, then test rechunk(1/2/4) in a later admitted slice.
Run cancellation during an awaited source only after that async source is admitted; require acquisition/release count one and no subsequent pulls.
Observe effectful mapping before versus after take using the official oracle; do not invent expected overpull behavior from element counts.
Queue: capacity 1, offer A, start blocked offer B, cancel B, take A, offer C, end, take C, then observe Done.
Repeat with blocked take cancellation, immediate shutdown dropping A, typed fail before/after buffering, and simultaneous end/full-buffer offer.
Use barriers/handshakes and trace assertions rather than timer-only scheduling; rerun stress schedules after deterministic correctness.
PubSub: capacity 1, two scoped subscribers, publish A, first takes A, blocked publish B, second closes, publisher resumes, first takes B.
Then end(Terminal), assert buffered-before-terminal order, repeated terminal takes, late subscriber and takeUpTo behavior against the oracle.
Sink: source arrays `[1,2,3]` and `[4,5]`, stop after two values, verify leftovers `[3]` and that the second source array was not yet requested.
Each admitted workload needs official reference/native debug/release agreement, both failure-frame policies and lifetime rejection fixtures.

## Explicitly unsupported until later gates

General Channel input/error/completion polymorphism, arbitrary Pull closures, dynamic subscriptions, PubSub replay, unbounded queues and collectors.
Concurrent stream operators, unordered mapping, merge/broadcast, retrying sources, hub error-bearing Take messages and network stream adapters.
Cross-thread handles, fairness promises, full Cause algebra, fallible finalizers and early sink combinations without exact leftover semantics.
No implementation, crate addition, allocation measurement or complete-module compatibility claim follows from this record alone.
