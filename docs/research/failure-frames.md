# Bounded logical failure frames — 2026-10-01

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
