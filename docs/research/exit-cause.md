# Checked Exit/Cause preparation

Recorded **2026-10-03**, before feature implementation, against installed **Effect 4.0.0 stable**. The chosen boundary is a bounded pure-value profile plus synchronous `Effect.exit`. This prepares representations and observable data before general child handles or fallible task groups; it does **not** claim those runtime capabilities are implemented. Core PLAN.md remains owned by the other instance.

Implementation status: the checked value builders and synchronous capture are implemented. [Conformance and allocation probes](../../packages/reffect/tests/exit-cause.test.ts) cover official/plain/framed reference and native debug/release; [type contracts](../../packages/reffect/tests/exit-cause-types.ts) cover dual APIs and channel inference. Runtime mixed Cause and child handles remain future gates.

## Primary sources and prior work

Checked online: published [Cause](https://unpkg.com/effect@4.0.0/src/Cause.ts), [Exit](https://unpkg.com/effect@4.0.0/src/Exit.ts), [Effect](https://unpkg.com/effect@4.0.0/src/Effect.ts), [internal Effect](https://unpkg.com/effect@4.0.0/src/internal/effect.ts) and [internal core](https://unpkg.com/effect@4.0.0/src/internal/core.ts). Relevant implementation symbols: `causeFromReasons`, `causeMap`, `causeCombine`, `findError`, `catch_`, `exit`, `exitPrimitive`, `exitMapError`, `exitMapBoth` and reason equality/hash implementations. The current project Result/Option/TaggedUnion/Array builders, synchronous typed recovery, frame sidecars, `isAsyncComputation`, [structured concurrency](structured-concurrency.md) and [native divergences](../native-divergences.md) were reviewed.

Effect v4 Cause is a **flat ordered reasons array**, not the Effect v3 Sequential/Parallel tree. Reason variants are Fail(error), Die(defect) and Interrupt(optional fiberId), with Context annotations and upstream equality/inspection behavior. Exit is Success(value) or Failure(cause), and official Exit values are also Effect values. Native plain data must not claim upstream branding, prototypes, iterator/effect identity, reason annotations or equality merely by matching fields.

`Cause.fromReasons` stores its array without deduplication. `Cause.map` maps every Fail reason and preserves order/duplicates. `Cause.combine` instead deduplicates using Effect reason equality/hash, including annotation identity. These operations require different native obligations.

`Exit.mapError` and `Exit.mapBoth` select the **first typed failure** through `findError` and rebuild a singleton Fail Cause. They do not map every reason. If there is no Fail reason, they preserve the original failure. On the admitted Fail-only profile that means a Failure with an empty Cause remains a Failure with an empty Cause. Do not implement Exit.mapError as Cause.map.

## Independent semantic probes

Public-API probes ran from `packages/reffect` with `node --input-type=module` and the installed stable dependency. Canonical recipe:

```js
import { Cause, Effect, Exit } from "effect";
const mixed = Cause.combine(Cause.interrupt(42), Cause.fail("bad"));
await Effect.runPromiseExit(Effect.failCause(mixed));
await Effect.runPromiseExit(
  Effect.failCause(mixed).pipe(Effect.catch((e) => Effect.succeed(`caught:${e}`))),
);
await Effect.runPromiseExit(Effect.result(Effect.failCause(mixed)));
await Effect.runPromiseExit(Effect.exit(Effect.failCause(mixed)));
```

Observed:

| Operation                                        | Observation                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| Raw explicit mixed Cause                         | Failure with Interrupt(42), then Fail("bad").                    |
| Typed catch on explicit mixed Cause              | Success("caught:bad").                                           |
| Effect.result on explicit mixed Cause            | Success containing Result.Failure("bad").                        |
| Effect.exit on explicit mixed Cause              | Success containing Exit.Failure with **both reasons preserved**. |
| Cause.map([Fail(1), Fail(2)], constant 0)        | Two reasons: Fail(0), Fail(0); no deduplication.                 |
| Cause.fromReasons([sameReason, sameReason])      | Two reasons retained.                                            |
| Cause.combine(Fail(3), Fail(3))                  | One reason after equality-based deduplication.                   |
| Exit.mapError on Interrupt(11), Fail(3), Fail(4) | Singleton mapped Fail from 3; other reasons removed.             |
| Exit.failCause(Cause.empty)                      | Failure, despite no reasons.                                     |

The last three observations were independently checked by the conformance agent. Online implementation inspection agrees. Array order and the empty failure are meaningful test cases.

**Interruption data is not ambient cancellation state.** An explicit Interrupt reason in a failed Cause does not by itself make typed catch ignore typed failures. The claim "mixed interruption always bypasses typed recovery" is false for these values. A canceled running fiber can separately retain an interruption request, alter continuation evaluation and combine causes while closing children. Existing structured-concurrency cancellation observations apply to its admitted Unit/Never workload, not to arbitrary mixed Cause values.

Exploratory ambient probe: synchronously fail("bad"), ensuring cleanup starts and schedules AbortController.abort after 1 ms, then sleeps 15 ms and logs cleanup end. Raw, typed-catch, result and exit wrappers all ended with outer Failure and sole Fail("bad") in that probe, with cleanup completed and no catch-handler execution. Earlier task-group probes yielded mixed Interrupt plus Fail. These timing-dependent observations are evidence that source/context-sensitive pending interruption rules need their own controlled fixtures; they do not establish a generalized cancellation projection.

## Chosen initial profile

Pure represented values use the existing immutable Struct, TaggedUnion and Array machinery:

- `CauseValue<E>` has `reasons`, an ordered array of plain `{ _tag: "Fail", error: E }` reasons. A witness accepts arbitrary finite Fail-only arrays, including duplicate and empty arrays. Constructors `Cause.empty(errorWitness)` and `Cause.fail(error)` create zero and one reason respectively. Exact witness argument placement should follow the existing Result/Option conventions where Effect itself needs no runtime type witness.
- `ExitValue<A,E>` is `{ _tag: "Success", value: A } | { _tag: "Failure", cause: CauseValue<E> }`. Keep public `_tag`/field spellings aligned with official values. Failure with empty Cause is valid and distinct from Success.
- Admit focused pure constructors, predicates, map and match observers: Cause type/empty/fail/hasFails/findError and map; Exit type/succeed/failCause/fail/isSuccess/isFailure/match/map/mapError, with mapBoth optional if its tested first-failure behavior uses the same helper. `Cause.findError` returns Result.Success(first error) or Result.Failure(original empty Cause), preserving the official result orientation.
- `makeFailReason` and `fromReasons` construct checked Fail-only arrays without raw IR builders; source inspection and duplicate probes establish that no deduplication adapter is needed. Predicates for absent Die/Interrupt reason kinds return false after witness validation. No combine, annotation APIs, hashing/equality, squash/pretty/error conversion, Die, Interrupt, arbitrary defects, fiber identifiers or Effect-yieldable Exit branding in this first slice.
- Inputs/outputs need known witnesses; no user casts. Pure callbacks receive Expr values and must produce represented pure expressions. Existing data-first/data-last conventions and pipeability apply.

A structural witness alone permits more than constructor-produced singleton Causes: conformance must cover multi-Fail arrays and empty Causes. Consequently predicates and map cannot assume exactly one reason. Generated data/reference comparison uses admitted fields; extra official prototype/annotation fields are outside the plain-value profile, just as existing Result data has a narrower contract.

## Synchronous Effect.exit

Admit `R.Effect.exit(self)` only when the **entire captured computation graph is synchronous** and contains no Clock/Random reads. The operation returns `Computation<ExitValue<A,E>, never>`, captures supported success or typed failure, and creates Fail-only Cause data. It must not be a spelling alias for a claimed full asynchronous Exit/Cause adapter.

Validation walks the captured graph, including branches and cleanup, not just its root node. Reuse `isAsyncComputation` for async detection, with exhaustive traversal maintained when new nodes are added. Reject Sleep, task groups, registered Scope/async resources, launch, RemoteStore, schedules and any other currently classified async node inside capture. Reject ClockReadMillis/RandomDraw anywhere inside capture: custom reference drivers can defect and native trusted-driver faults panic; this patch cannot represent that outcome faithfully as an Exit. An otherwise synchronous function can use those services **outside** capture, and an async function can sequence admitted synchronous capture before/after an async operation.

Ordinary synchronous pure/typed computation, lexical Ref and synchronous log/context composition are candidates. Ensuring, file/resource brackets and Scope are currently classified async and refused inside capture even when their bodies do not suspend. Existing trusted host/observer/internal compiler-fault assumptions still apply; this profile does not convert a Rust panic or arbitrary thrown host callback into a Die reason. No authored Effect `die`/`failCause` input primitive is admitted. The already documented host-defect limitations do not disappear because `Effect.exit` exists.

Reference capture uses official Effect.exit and converts only the representable success/Fail-only outcome to plain data; it must detect/refuse a non-Fail result rather than erase an unexpected reason. Framed reference unwraps its own typed failure envelope correctly: the user Cause contains E, not an internal `{ error, frames }` wrapper. Captured logical frames remain policy-selected sidecars and are discarded when failure is successfully converted to Exit; error scalars and Cause reasons receive no provenance fields. Disabled-frame capture must not allocate a failure trail.

## Representation and performance

Chosen first implementation: generated `Vec<FailReason<E>>` plus ordinary generated Exit enum. Cause.empty uses an empty Vec and should not allocate; Cause.fail allocates for a singleton reason array; map/clone may allocate as existing Array ownership requires. This is explicit requested **Cause value cost**, not a change to ordinary numeric/error values, Result, AsyncError or every computation. Existing scalar functions and modules without Cause/Exit keep their representations and dependency graph.

Alternative: specialized semantic Cause witness with inline `Option<E>` or a small fixed reason buffer, preserving `reasons` as a virtual view. This could remove singleton allocation but requires new native layout/field projection/codec rules across the kernel and backend; Option also cannot represent admitted arbitrary arrays. Defer until measurements justify that machinery. Do not bolt an untracked special witness into string emission or silently restrict a generally shaped array witness to one element.

Alternative: replace AsyncError immediately with heap-backed Cause. Rejected for this slice: it broadens every async failure and cleanup path, requires interruption identity/annotations and Cause combination semantics, and imposes costs before a complete fallible task workload exists. Pure Cause values do **not** change runtime AsyncError Fail/Interrupted semantics.

Measure Cause.empty/singleton/map construction and cloning, generated enum/struct layout, Effect.exit success/failure under both frame policies, and an ordinary scalar baseline. Report allocations honestly, separating value construction, optional logical failure capture and host/harness setup. No additional Cargo crate or global registry should be needed.

## Next runtime gate

Before child handles, Deferred.fail/done, fallible task groups or asynchronous Effect.exit, specify an owned execution outcome with ordered bounded/admitted reasons; multi-failure combination; pending parent interruption; defect capture; masked cleanup; typed catch/result selection; interrupting-fiber identity/annotations or explicit API exclusions; and logical trail retention separate from ordinary payloads. Empty, singleton and multi-Fail **data** support is preparatory and does not prove any of those runtime semantics.

## Decisions and revisit triggers

| ID       | Decision                                                                                                                             | Revisit trigger                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| EXIT-001 | Flat Fail-only reasons array; arbitrary finite arrays admitted, constructors empty/singleton; official field names, plain data only. | Interrupt/Die reasons, annotation or equality support.                         |
| EXIT-002 | Reuse Struct/Array/TaggedUnion and accept explicit Cause Vec allocation; ordinary values/runtime errors unchanged.                   | Measured value cost warrants verified small-buffer/specialized representation. |
| EXIT-003 | Cause.map preserves every Fail and duplicates; Exit.mapError selects first Fail and rebuilds singleton.                              | Broader reason variants require preserve/no-Fail branches and annotations.     |
| EXIT-004 | Effect.exit captures only checked synchronous graphs without Clock/Random; async outside capture remains possible.                   | Complete runtime Cause/interruption/defect representation and cleanup parity.  |
| EXIT-005 | Upstream brand/prototype/Effect identity, equality and annotations remain outside the value profile; frames remain sidecars.         | Wire/host exposure, equality operations or public reason metadata.             |
| EXIT-006 | Explicit Interrupt data and ambient cancellation are distinct; no blanket catch projection.                                          | General Cause propagation and fallible child lifecycle workload.               |

## Acceptance before claiming support

- Independent official Cause/Exit fixtures: empty failure, success/failure constructors, first-error selection, duplicate preservation, multiple Fail reasons, map/mapError distinction and inactive callback branches.
- Native debug/release: scalar and non-Copy payloads, represented input arrays with multiple reasons, empty arrays, pure maps/matches, nested data and no extra dependency.
- Effect.exit official/plain/framed/native: synchronous success/typed failure, caught data payload without internal frame envelope, and composition with async operations outside capture. Cleanup inside capture is refused in this first profile.
- Structured refusal: async capture even through wrappers/cleanup/branches; Clock/Random capture; resource escape; unknown witnesses and unsupported Die/Interrupt/annotation/equality APIs. Refusal is deliberate scope, not silent data loss.
- Costs: empty versus singleton allocation behavior, enabled/disabled trail capture, ordinary scalar baseline, generated Rust growth and module reachability. A dedicated inline representation remains an optimization decision backed by those measurements.

## Native measurements

The native allocation test compiles a separate std-only library and counts allocations and net live allocation changes around 100 completed invocations, dropping each result. Host stdout is warmed before measurement. No Tokio, logging, Scope or request context is reached. Payloads are u64; owned strings and maps have their own existing costs. Linux x86_64, Rust 1.98.1; debug/release and None/Bounded failure-frame policies are checked separately.

| Workload                            | Debug allocations per invocation | Release allocations per invocation |
| ----------------------------------- | -------------------------------- | ---------------------------------- |
| Scalar identity                     | 0                                | 0                                  |
| Empty Cause                         | 0                                | 0                                  |
| Exit success                        | 0                                | 0                                  |
| Effect.exit success                 | 0                                | 0                                  |
| Singleton Cause.fail                | 2                                | 1                                  |
| Exit.fail                           | 3                                | 1                                  |
| Effect.exit failure, None frames    | 3                                | 1                                  |
| Effect.exit failure, Bounded frames | 4                                | 2                                  |

Every workload has zero net retained allocations after its 100 invocations. These are allocation counts, not byte/RSS or general leak guarantees. Conservative existing composite ownership creates intermediate Vec clones in debug; release removes them in this fixture. The extra allocation for bounded failure capture is existing boxed diagnostic trail storage; it is discarded when recovery materializes the Exit. A u64 scalar is 8 bytes, the Cause value is 24 bytes and Exit value is 24 bytes in both builds/policies. These concrete generated layouts are not stable ABI promises.

The failure-data path therefore costs an explicit reasons allocation in optimized code; it is not a zero-allocation Cause representation. Empty/success paths remain allocation-free in the fixture. No semantic runtime or Cargo dependency was added, no metadata field was attached to a scalar, and AsyncError/AsyncContext were unchanged. Revisit EXIT-002 if a real outcome-heavy workload warrants an inline bounded/small-buffer representation and a proved reason-capacity bound.
