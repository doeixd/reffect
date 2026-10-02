# Native performance and growth requirements

Semantic equivalence is an admission gate. Measurements also need to show that specialization has not introduced uncontrolled code, allocation or dependency growth. Benchmarks are evidence about a specified workload and machine; they are not a promise to outperform handwritten Rust or every JS workload.

## Evidence to collect

For every meaningful new workload/profile, record compiler/Rust/dependency versions, machine/target, source/frame/logging policy, input scale, command and raw results. Separate fresh compilation from cached builds and debug from release. Reuse the same cases for the reference and native versions when comparing execution.

| Measure                                                              | Purpose and timing                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| IR nodes/edges → helper count and generated Rust bytes               | Detect expanded shared DAGs and duplicated boundary scaffolding; required when changing lowering              |
| Context, Result and suspended future layouts; allocation count/bytes | Detect per-value metadata, enlarged future state and boxing; required when changing ownership/runtime storage |
| Cargo direct/transitive dependencies and selected features           | Verify reachability and report substrate cost; required for a new native capability                           |
| Fresh/cached compile time and peak compiler/build memory             | Detect source/type growth and expensive adapters; collect for representative workloads                        |
| Debug/release executable size and cold startup                       | Describe deployment/runtime cost; collect for public native demos                                             |
| Idle/steady resident memory and retained resources                   | Detect per-request/session leaks and unbounded state; collect when adding concurrent or persistent workloads  |
| Throughput and latency distribution                                  | Observe workload cost at specified concurrency/input sizes; collect once the workload is stable               |

No single fullstack dependency or throughput budget applies to a scalar library. Compare equivalent profiles and report Cargo/runtime/transport overhead separately from diagnostic allocations. Rust future sizes depend on generated control flow and compiler layout; absence of `Box<dyn Future>` does not imply small futures.

## Gates and exploratory measurements

Existing conformance already guards shared-helper emission, 32-frame construction bounds, exact omitted counts and capture-off storage removal. Preserve those gates. Define additional stable structural bounds before admitting a new algorithm or resource lifecycle: source/helper growth, bounded queues/caches, exactly-once cleanup and disabled allocations. Failure to meet a declared bound blocks capability admission.

Startup/RSS/latency/compile-time samples begin as exploratory evidence. Retain raw results, repeat noisy timing samples, and set regression thresholds only after a reproducible baseline exists. Do not invent universal numeric limits or block small changes on unrelated benchmark suites.

[Metadata costs](metadata-cost.md) and [frame probe results](research/frame-cost-results.json) are the first measured examples. [Async RPC research](research/async-rpc.md) defines the next context/future probe and cancellation workload. Extend this practice as Remote/SQL/streaming supplies realistic workloads; do not postpone growth/allocation checks until the combined showcase.
