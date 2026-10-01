# Bounded logical failure frames — 2026-10-01

**Later update:** The initial vector-based implementation below is historical.
The [construction-bound follow-up](#construction-bounds-and-frame-policy-preparation--2026-10-01)
ships bounded boxed trails and independent frame stripping; [results](#hardening-implementation-and-measured-results)
record the current cost and validation evidence.

## Prior work and primary checks

- PLAN's observability track requires named logical failure frames before scoped
  logging, with deterministic reference/native conformance. Read the current
  Effect IR, lowering, source provenance, artifact policy, NativeRunner
  scalar/Result protocol and existing conformance tests.
- Pinned **Effect 4.0.0-rc.118** verified as oracle: `Effect.fail('leaf')` with
  no spans carries **no** StackTrace annotation; wrapping with
  `withSpan('inner')` then `withSpan('outer')` annotates the Fail reason with
  `{name:"inner",parent:{name:"outer"}}` — innermost first, parents outward.
  Anonymous `flatMap` chains without spans add no frames. Only explicit
  boundaries create observable context.
- Installed `Cause` source (`Cause.ts`) confirms `reasons[]` with per-reason
  `annotations` maps; `StackTrace` is a Context service. Reference behavior is
  the semantic oracle; native text need not match engine stack strings.

## Chosen path

Add **explicit, author-visible computation boundaries** as the only frame
sources. Every `R.Effect.fn` entry and every `Fail` site is a boundary;
`Map`/`FlatMap`/`Match` helpers prepend their IR path when propagating an
error outward. Pure `Expr` nodes never emit frames. Success paths emit
nothing and perform no frame work.

Frames are **logical IR paths** (`functions.branch.body.onTrue`), not helper
indices or native addresses. Each frame carries function name, IR path, helper
kind and optional provenance origin (Full policy only; None omits origins
honestly). Innermost (Fail site) first, outermost (function entry) last.
Bounded at 32 frames; beyond that the oldest (outermost) entries are dropped
and an explicit `omitted` count is reported. No truncation marker is invented
when nothing was dropped.

Domain payloads are unchanged. Internally helpers return
`Result<T,(E,Vec<Frame>)>`; the public `r_*` functions strip to `Result<T,E>`
for library compatibility and stash frames in a thread-local for the binary.
The CLI keeps its existing stdout payload protocol byte-identical and prints a
single versioned JSON object `{"schema":"reffect.frames@1",...}` to stderr on
failure only. Existing `NativeRunner.run` ignores stderr and stays compatible;
new `NativeRunner.runWithFrames` parses and validates the stderr envelope.

Reference execution gains `EffectReference.runWithFrames`, which tracks the
same IR paths during evaluation and returns `{exit, frames, omitted}` without
changing `run`/`runUnknown` behavior. Both sides share the path vocabulary
already used by lowering (`functions.<name>.body...`), so agreement is
checkable without comparing engine stack text.

Alternatives rejected: thread-local push/pop on every helper (success-path
cost); global mutable toggles (break concurrent requests); stuffing frames into
the domain payload or wire Schema (changes semantics); native backtraces as
logical frames (platform text, inlining loss, async migration).

## Acceptance

- Cast-free authoring; no new effect node; existing `run` behavior unchanged.
- Differential debug/release cases: direct Fail, failed-source short-circuit,
  nested Map/FlatMap, selected Match branch only, shared helpers, deep chains
  (omitted count), None-policy origin omission, success emits no frames.
- Malformed/truncated stderr envelopes are refused as distinct errors;
  wrong-channel payloads still fail as before.
- No new Cargo dependencies; failure-only allocation; success path has no
  frame calls/maps/allocations (assert via generated source inspection).
- Full/None generated-source parity for payload files; frames differ only by
  honest origin omission.
- Scoped vp check, strict TypeScript, all tests, workspace builds; commit,
  review, recheck and push before scoped logging.

## Implementation evidence

- Reference `runWithFramesUnknown`/`runWithFrames` added alongside unchanged
  `run`; a memoized pre-order adaptation pass assigns canonical first-seen
  paths mirroring lowering traversal (Match visits onTrue before onFalse).
  Shared nodes therefore report identical frames for identical computations.
  Scope-divergent sharing (same node under different binders) is a documented
  untested boundary, not silently resolved.
- Lowering emits traced `Result<T,(E,Vec<&'static str>)>` helpers with JSON
  frame literals, a failure-only thread-local stash, and public functions that
  keep `Result<T,E>` while stashing frames. The CLI stdout protocol is
  byte-identical; failures additionally print one `reffect.frames@1` object to
  stderr. `runWithFramesUnknown` (unknown args) plus a typed `runWithFrames`
  wrapper; both decode payloads exactly like `run`.
- Three conformance tests pass: debug/release path agreement across branch,
  nested FlatMap/Match, short-circuit, shared-helper and depth-40 truncation
  cases; mapped-vs-None origin attribution with otherwise identical sources;
  seven malformed/missing/duplicated/success-time envelope refusals. Full suite
  and post-commit results follow in PROGRESS.md.
- Known cost: frame literals embed full IR paths, so pathological nesting
  grows bytes roughly quadratically (depth-128 shared Match: ~188KB, 16x the
  depth-16 size for 8x depth). Node sharing itself stays linear in helper
  count, which the suite asserts directly; exponential tree expansion remains
  excluded by a wide margin. Path growth matches the existing provenance-path
  characteristic rather than introducing a new complexity class.

## Construction bounds and frame policy preparation — 2026-10-01

Reviewed the shipped reference/native propagation, CompileSpec and staged Plan
verification, source artifact independence, runner envelope contract, scoped logs
and synchronous RPC cleanup before implementation. The original 32-entry limit
only truncated at storage; native Vec and reference arrays grew while unwinding.

Primary sources checked online: [Rust Box memory layout](https://doc.rust-lang.org/std/boxed/index.html#memory-layout),
[std::mem::size_of](https://doc.rust-lang.org/std/mem/fn.size_of.html) and
[pinned Effect RC.118 Cause source](https://unpkg.com/effect@4.0.0-rc.118/src/Cause.ts).
Box of a sized type has one-pointer representation; Result layout is compiler/target
dependent and must be measured. Effect failure annotations remain separate from
domain payloads. No Effect skill is available in this session; pinned source and
existing official-Effect reference execution supply the compatibility oracle.

Choose a lazily allocated Box<FrameTrail> holding 32 static frame-string references,
a length and omitted count. Append only while length < 32; otherwise increment
omitted with saturation. The array belongs inside the Box, never inside Result
or native scalar values. One allocation per failed invocation, no vector growth
during propagation; conversion to the existing Vec-returning observer API may
allocate at observation. RPC should clear/drop the trail without that conversion.
The synchronous thread-local stash owns at most one trail and is drained/reset
explicitly; it is not an async request recorder. Reference arrays obey the same
construction bound and ordering. Static path strings still have the previously
recorded nesting-related emitted-byte cost.

Alternatives: an inline array avoids allocation but enlarges every Result and
helper stack; an unboxed Vec plus omitted count enlarges the Result; a boxed Vec
needs a second allocation and capacity management. A fixed boxed array spends
more bytes on shallow failures but provides one allocation, predictable maximum
retention and a compact propagated handle. A request arena is unnecessary for
this synchronous profile and would add lifetime/ownership coupling. Revisit from
measured structured/async workloads rather than claiming universal optimality.

Introduce immutable registered FailureFrames.Bounded (default) and None policies,
selected independently through Compile.withFailureFrames and NativeRpc options.
Carry the selection in CompileSpec, verified Plan, lowered modules and artifacts.
None emits ordinary Result<A,E> helpers and no trail, frame literals, stash or
frame envelope. Authored logs/annotations/span timers and source artifacts remain
independent. NativeRunner.runWithFrames refuses None before execution rather than
reporting a missing envelope or pretending stripped diagnostics were captured.

Acceptance: existing debug/release path/shared/deep conformance; exact omitted
counts and repeat-drain isolation; Full/None artifacts crossed with both frame
policies; frame-off native payload/log parity; RPC frame-off compilation and stock
client behavior; rejected unregistered policy; measured scalar/Result sizes,
allocation counts and repeated release success/failure timing. Measurements
exclude CLI serialization and authored logs, report platform/toolchain and have
no wall-clock thresholds. Full required checks and post-commit review follow.

## Hardening implementation and measured results

- Both native/reference trail construction now retains at most 32 frames; the
  native capsule is lazily boxed and its omitted count saturates. Observation
  drains frames and omitted together; RPC cleanup drops without a Vec conversion.
- Registered, immutable FailureFrames.Bounded/None selection flows through
  complete compile/build requests, staged plans, artifacts, runner and RPC.
  Type-level policy branding prevents mixing source/frame policies without
  adding runtime fields. None strips frames while preserving authored logs and
  annotation/span restoration.
- New allocation probe covers debug/release; deep 131-boundary failure captures
  32 frames plus 99 omitted with one 528-byte allocation. Success and stripped
  failure capture allocate zero diagnostic bytes. Source artifacts and existing
  boundary/shared conformance remain independent. Oversized/false-truncation
  envelopes are rejected.
- Raw [release samples](frame-cost-results.json), taken after other validation
  processes finished, record five runs per policy, 100,000 iterations per run.
  Layouts are detailed in [metadata costs](../metadata-cost.md#native-failure-frame-costs).

| Policy  | Success ns/call min / median / max | Deep failure ns/call min / median / max |
| ------- | ---------------------------------- | --------------------------------------- |
| Bounded | 3.34 / 4.29 / 10.21                | 393.35 / 402.44 / 450.75                |
| None    | 2.34 / 2.95 / 4.66                 | 2.34 / 2.34 / 3.11                      |

These synthetic results are not a throughput guarantee: the payload is constant,
metadata-free error chains can simplify under Rust optimization, allocator
counters add overhead, and cloud scheduling is noisy. No benchmark thresholds
are asserted. Fixed capsule storage trades shallow-failure bytes for a predictable
bound and one allocation. Thread-local capture remains synchronous; async task
context, structured error sizes, source descriptor compression, sink policies and
OTLP remain following work. Detailed check/review results are in PROGRESS.md.
