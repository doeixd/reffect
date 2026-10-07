# Private generated Queue interruption frames

Current status: the bounded standalone offer/take profile is now public through [QPUB](queue-public-admission.md). Earlier private/public-gate wording below records the original research stage; broader APIs remain gated.

Prepared 2026-10-07 against AGENTS, PLAN/PROGRESS, QGEN/QBUD/QEXEC, DINT's scope-indexed reference planner and the shared bounded native trail. This closes the diagnostic gap in the existing private offer/take All2 profile; public exports and broader operations remain refused.

## Primary evidence

Freshly fetched published [Effect 4.0.0 Queue.ts](https://unpkg.com/effect@4.0.0/src/Queue.ts) and [internal/effect.ts](https://unpkg.com/effect@4.0.0/src/internal/effect.ts). SHA256 values `6781fd0ac6fad03057ebeaa838d0f9723913027a4f6845d57dc3c17da70d1953` and `68c43e18e167d17b39f224d3793f11c7732cd857b7908ecd3ff1d1edf0affac2` match installed sources. Queue wait cancellation retires registration through masked callback finalizers; All waits for child interruption. Logical IR paths are reffect's diagnostic contract, separate from Effect's semantic Cause. QEXEC/DINT already establish the parent-only interrupted All trail. The current generated Queue driver settles children before returning interruption, but its lowerer assumes unframed errors in QueueScope, QueueOperation and All wrappers.

## Decisions before implementation

- **QFRAME-001 — Reuse bounded failure representation.** Permit explicit FailureFrames.Bounded through the internal lowerQueueFunctions entry, retaining its None default. Use existing boxed 32-frame trails, AsyncContext observation and helper frame propagation. QueueScope appends its boundary; interrupted Queue operations construct their leaf trail; All discards child trails and constructs its own interrupted parent trail after driver settlement. No new runtime fields, crates, scalar metadata, public exports or semantic profile changes.
- **QFRAME-002 — Preserve actual outcomes and lifetimes.** Successful child receipts remain required for successful All. Never channels remain uninhabited; no typed failure or combined Cause is invented. Child trail boxes are discarded when observing each child result, before parent outcome construction; borrowed continuations/registration retirement remain unchanged. Public native Result stays unchanged. Successful roots clear prior diagnostic state; take_frames consumes a trail once. None strips all diagnostic storage and emission.
- **QFRAME-003 — Canonical paths and entry contracts.** Keep the existing scope-indexed helper path convention, root-only reference observers and first interrupted root spine. Test parent Map/FlatMap and shared children, and 32-frame truncation with explicit omitted counts. Conditional All is refused by the existing profile, so parent Match interruption remains outside this slice. Started cancellation compares exactly with the owned official interpreter. Owned preabort remains unopened/no frames; direct invocation of a generated function with an already canceled context records only its function boundary, the existing DINT entry distinction.
- **QFRAME-004 — Proof and costs.** Validate blocked offer and take, successful transfer, source logs, preabort, repeated invocation/reset, exact topology-authored paths, reference Cause and native Interrupted in debug/release with None/Bounded. Include a negative mutation corrupting the All frame kind. Keep existing pressure/continuation and public-refusal regressions. Measure returned futures and controlled quiet construction/execution/cancellation allocations per policy, excluding context/watch/runtime setup and frame observation. Bounded interruption may allocate diagnostic capsules; do not claim zero allocation there. None costs must remain unchanged in the existing QGEN fixtures. Native builds stay serial.

## Alternatives and remaining gates

Embedding metadata in Queue payloads or extending QueueDriver to carry frames couples protocol control to diagnostics. Retaining whichever canceled child finishes first would produce scheduler-dependent trails and violate existing infallible-group policy. Keeping frames globally would break invocation isolation. The existing helper/context adapter avoids those changes.

Public standalone Queue admission is a separate review after this evidence. End/shutdown/Done, retained outcomes/fail-fast, generated Ensuring/Sleep cleanup markers and mask restoration, broader owners/timers/tasks, RPC/Send and host-future abandonment remain open. Artifact Full/None remains independent of frame None/Bounded; emitted-byte and actual future-layout gates apply to both.

## Delivered evidence

The private lowerer accepts explicit Bounded while preserving its None default. QueueScope propagates the existing trail; Queue waits produce typed interruption capsules; child wrappers discard each capsule and record actual success, then All allocates a parent trail only after driver settlement. No Queue runtime or scalar representation changes.

Three new tests cover explicit owned-reference topology plus actual generated None/Bounded in debug/release. Blocked offer/take, shared children, Map/FlatMap parents, successful transfer, 35 Map wrappers, consuming observation, unopened/direct-native preabort distinctions and stale-trail clearing pass. The deep interrupted trail has 38 boundaries, retains 32 and reports six omitted. Corrupting the All frame kind fails the native assertion. The first custom harness omitted the actual emitted recursion-limit attribute and hit rustc query depth; copying the emitted entry setting corrected the harness without widening compiler admission.

For Linux x86_64 take/offer/wrapped/deep/success fixtures, returned futures measure 1128/1176/1208/2528/1168 bytes with None and 1144/1200/1232/2544/1184 with Bounded in both debug and release. Quiet construction of 100 futures and execution of 100 successful groups each allocate zero under both policies. One two-taker cancellation allocates zero with None and three diagnostic capsules with Bounded (two children, discarded, then one parent). Runtime/watch/context setup and take_frames observation are excluded; empty inherited metadata is used and logs are outside the measurement. These are fixture measurements, not universal allocation/layout guarantees.

Independent read-only review found no source blocker in error representation, settlement, path policy or cost accounting. Its selected-Match evidence question narrowed the record to the admitted unconditional All profile. Source/refusal regression, existing generated pressure/continuation evidence, strict/full checks and workspace build accompany publication; public admission remains the next separate review.

## Mixed-module carrier review

Self-review found that an independent ordinary fallible group export enables AsyncError.Combined for the entire generated module. Queue's infallible wrappers previously handled only Fail(Never)/Interrupted, causing non-exhaustive Rust matches even though their own checked profile cannot produce a combined outcome. Reuse the existing ordinary infallible-group arm: handle the module-wide variant with an invariant panic, without admitting richer Queue channels. Add an independent ordinary fallible group to the native compilation matrix; first establish that the old Queue wrapper fails exhaustiveness checking, then preserve all Queue outcomes/costs. This is a carrier-composition repair, not Queue fail-fast admission.

The mixed-export reproducer fails rustc exhaustiveness checking under both None and Bounded before the conditional arms. After repair, the complete debug/release matrix passes, including the negative frame-kind mutation. Mixed-module None layouts remain 1128/1176/1208/2528/1168 bytes; mixed-module Bounded layouts are 1144/1264/1296/2544/1184 bytes. The broader module carrier increases the offer/wrapped bounded future layouts by 64 bytes compared with the Queue-only measurements above. Allocation counts remain 0/0/0 (None) and 0/0/3 (Bounded). Independent review found no blocker in the conditional carrier handling. This finite layout observation does not establish a general mixed-module size guarantee.

Publication validation uses strict `tsc --noEmit --strict --project packages/reffect/tsconfig.json`, full `vp check` and `vp run -r build`. The serial native/source regression command is:

```sh
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1 vp test packages/reffect/tests/queue-{ir,generated-profile,lowering,budget,execution,generated,generated-frames}.test.ts packages/reffect/tests/owned-cancellation.test.ts packages/reffect/tests/owned-execution-signal.test.ts --maxWorkers=1
```

Cargo's environment is sourced before this command. Native debug/release builds are fresh temporary crates; cached workspace build results are reported separately in PROGRESS. Exact post-commit validation results accompany publication.
