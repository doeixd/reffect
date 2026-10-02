# Parallel Effect module implementation

The 2026-10-02 implementation batch follows the user's request to develop important Effect modules in parallel and retain decisions for later review. The shared oracle is Effect 4.0.0-rc.118. Each track admits a bounded semantic profile; an implemented subset never establishes complete support for an upstream module.

## Priorities and integration

| Track                                | Immediate workload                                                             | Ownership during implementation                                                      | Decision record                                 |
| ------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Resource lifetime / Scope foundation | Acquisition, use, release and cooperative interruption                         | Shared computation IR, checking, reference interpretation and native lowering        | [Resource lifetime](research/resource-scope.md) |
| Context / Layer                      | Lexical service wiring and shared/fresh acquisition                            | Independent authoring modules that specialize into existing checked IR               | [Context and Layer](research/context-layer.md)  |
| Effect error recovery                | Handle typed domain failures without catching interruption or compiler defects | Independent authoring helpers and tests; shared-core changes integrated by its owner | [Error recovery](research/error-recovery.md)    |
| Schema boundaries                    | Constrained scalar input validation before middleware/handlers                 | Shared schemas and native RPC boundary codec/validation                              | [Schema profile](research/schema-profile.md)    |

These tracks address the current RPC foundation. General fibers, queues, streams and dynamic service/resource registries require additional representation and lifetime work. Broad concurrency remains a later roadmap gate.

Review prior work and current primary sources before choosing an implementation. The batch checked [Effect acquisition](https://unpkg.com/effect@4.0.0-rc.118/src/Effect.ts) and [Layer build/memoization APIs](https://unpkg.com/effect@4.0.0-rc.118/src/Layer.ts) online; each linked record supplies its detailed evidence, alternatives and acceptance criteria. Shared compiler mutations are integrated sequentially, while research, isolated modules and focused tests proceed in parallel. The parent owns exports, roadmap alignment, integrated checks, commits and publication.

## Decision review contract

Each track records stable decision IDs, a status (provisional or accepted for the bounded subset), the chosen behavior, alternatives, rationale, consequences and a concrete reason to revisit it. Evidence distinguishes official-reference conformance, native validation and remaining assumptions. Decisions are reviewable records, not permanent commitments or pending approval requests.

Keep runtime scalars plain and provenance build-owned. Record any new allocation, future/context storage or dependency requirement. Context inheritance, finalizer ordering, failure recovery and schema validation must compose across tracks; native success alone does not establish semantic agreement. The integration review checks combinations as well as isolated modules.

## Batch status

Implemented bounded APIs are `R.Effect.acquireUseRelease`, `catchAll`, `mapError`, `orElse`, `R.Context`, `R.Layer` and `RpcCodecs.u64Range`. All use the existing checked compiler/reference/native path. General Scope registration, opaque native handles, dynamic services, resource Layers, broad Schema and fibers remain outside these subsets.

| Decisions      | Accepted behavior / review focus                                                                                         | Revisit before                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| SCOPE-001–004  | Structured scalar brackets; masked acquisition/release; non-failing release; cooperative completion                      | A native handle adapter, resource Scope registration, Exit-aware/fallible release or escaping ownership |
| CTX-001–005    | Lexical services; ID/witness compatibility; per-provide sharing and fresh boundaries; explicit sequence; pure-only merge | Dynamic service methods/registry, resource or fallible Layers, general concurrent acquisition           |
| ERR-001–006    | Typed-only recovery; nominal channel joins; error-specific helper specialization; handled frame disposal                 | Rich error unions, full Cause recovery or retained handled-error ancestry                               |
| SCHEMA-001–004 | Registered input ranges; safe frozen parser accessors; exact checked diagnostics; reachable native range helper          | Portable Schema registry, constrained output encoding or an Effect parser lifecycle change              |

The resource, Context/Layer and Schema focused tests pass; error recovery's original native matrix passes, with its final shared-helper regression scheduled for integrated validation. [The composition test](../packages/reffect/tests/module-composition.test.ts) passes in debug/release under both frame policies: shared service acquisition executes once, release completes before recovery, high-precision values agree, recovered exits have no residual failure frames, and the handler compiles behind the constrained RPC profile. Focused test setup mistakes and build-contention timeouts were corrected without relaxing semantic assertions. Full-suite/publication evidence belongs in [PROGRESS.md](../PROGRESS.md).
