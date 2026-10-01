# Scoped logging preparation — 2026-10-01

## Evidence and prior decisions

- PLAN's observability track requires Unit (done), scoped logging/annotations,
  then bounded failure frames (done) before request/OTLP adapters. Read the
  current Effect IR, lowering, provenance, NativeRunner protocol, artifact
  policy and the observability/source-map/metadata contracts.
- Installed **Effect 4.0.0-rc.118** verified as oracle (`effect/Effect.ts`,
  `effect/Logger.ts`, `effect/References.ts`):
  - Six severities Trace/Debug/Info/Warn/Error/Fatal; `MinimumLogLevel`
    reference defaults to Info and is read at log time (`provideService`
    sets it; a misplaced multi-arg `provide` does not).
  - `log*/logWithLevel` take message arrays, need no services, return
    `Effect<void>`. `Logger.make` observes `{message, logLevel, cause,
fiber, date}`; annotations/spans are read from the fiber via
    `CurrentLogAnnotations`/`CurrentLogSpans` at log time. `Logger.layer`
    replaces the set unless merged.
  - `annotateLogs` is FiberRef-scoped: innermost wins on key conflict,
    restores after the scope on success and on failure (a post-recovery log
    observes `{}`). `withLogSpan(label)` prepends `[label, timestamp]`,
    innermost-first, restored after. Log order equals execution order; failure
    stops the chain unless caught.
- [Rust std](https://doc.rust-lang.org/std/) supplies `eprintln!`,
  thread-locals, `BTreeMap`-free small vecs and `Instant`; no new dependency
  is needed for a stderr JSON sink.
- [Node TextEncoder](https://nodejs.org/api/util.html#class-utiltextencoder)
  remains UTF-8; JSON escaping for messages/keys is done at codegen with an
  explicit escaper, mirroring frame literals.

## Chosen API and boundaries

New `ComputationNode` variants (no new types, so `joinType` is untouched):

- `Log { level, message, attributes }` returns Unit, error Never. Level is a
  static six-literal witness; message a static string; attributes a frozen
  tuple array of ASCII keys to Bool/u64 Exprs. Pure value Exprs only — logging
  is an effect node precisely so the compiler never hoists, memoizes or drops
  it as pure.
- `Annotate { key, value: Expr, body: Computation }` and
  `Span { label, body: Computation }` propagate the body's channels. Keys and
  labels are static ASCII without quotes/backslashes/controls, validated at
  authoring and rechecked (forged nodes are refused, not coerced).

`R.Log.info/warn/...` level factories plus `R.Log.log(level, message,
attrs?)`; pipeable dual `R.Log.annotate(key, value)` and `R.Log.span(label)`
wrapping computations. No casts in call sites or tests; forged channels still
fail `checkEffectFunction`.

Reference execution delegates filtering, shadowing, restoration and span
stacking to the official combinators (`logWithLevel`, `annotateLogs`,
`withLogSpan`) evaluated around the existing evaluator — the oracle owns the
semantics; tests capture via `Logger.layer` plus fiber-ref reads. Values are
evaluated first (boolean/bigint), then handed to Effect; test comparison
normalizes bigint to decimal strings.

Native lowering wraps bodies with save/set/restore (annotations) and
push/pop (spans) on both Ok and Err paths, pushing an annotate/span frame on
error propagation like Map. Log records print one versioned
`reffect.log@1` JSON object per line to stderr: level, message, annotations
(bool JSON, u64 decimal strings per the metadata-cost rule), span labels with
elapsed millis. Default minimum Info enforced before formatting; configurable
minima, strings/records, OTLP and exporters are explicit follow-ups.

Stdout stays the evaluator protocol: log functions still print their Unit
payload there; log records never touch stdout. `runWithFrames` already
tolerates non-envelope stderr lines. Success paths perform no frame, map or
allocation work for logging scopes beyond the bounded save/restore their
semantics require.

## Alternatives

- A second JS formatting implementation instead of delegating to Effect:
  rejected, the oracle must own shadowing/restoration.
- Global `tracing`/OTel crates now: rejected, premature dependencies; stderr
  JSON plus the deterministic test sink precede exporters per the delivery
  gates.
- Dynamic messages/objects/custom Logger adapters: refused in v1 with
  structured diagnostics; strings/records need their native representations
  first.

## Acceptance

- Cast-free level/message/attribute/annotate/span authoring; forged keys,
  non-Bool/u64 attributes and mixed channels refused.
- Debug/release agreement on ordering, emission counts, innermost-wins
  shadowing, restore-after-success/failure, span nesting/labels, default Info
  filtering of Trace/Debug, selected-branch-only emission and shared-node
  single emission; payloads and frames unchanged.
- Success emits no stderr records; failures restore scopes before frames are
  captured (annotation state never leaks across the failure boundary).
- stdout protocol byte-identical; no new Cargo dependencies; failure-only
  frame allocation preserved.
- Scoped vp check, strict TypeScript, full tests, workspace builds and probe;
  record results, review, commit and push before RPC work.

## Implementation evidence

- `Log`/`Annotate`/`Span` computation nodes with `R.Log` factories, dual
  annotate/span combinators and six-severity witness; static keys/labels and
  unique attribute keys validated at authoring, witnesses/channels rechecked
  (forged wrappers refused without casts or spreads in tests).
- Reference delegates to `logWithLevel`/`annotateLogs`/`withLogSpan`; capture
  tests read fiber refs. Native emits versioned stderr JSON with nested
  annotations, innermost-first spans, static-wins shadowing and Info-minimum
  filtering; save/restore and push/pop run on both Ok and Err paths, and
  annotate/span push failure frames like Map.
- Three conformance tests pass: debug/release ordering/levels/attributes/
  filtering, shadowing/restoration/span/branch/shared/escaping agreement,
  and authoring refusals. Full suite and post-commit results follow in
  PROGRESS.md. Two test-side mistakes (not implementation): channel-prefixed
  stdout expectations and first-applied-innermost span order, both corrected
  to the oracle. One real emission bug found by tests (unconditional comma in
  scope annotations) plus one stale size assertion updated for frame-literal
  bytes; the memory probe now asserts normalized value-level identity across
  Full/None with per-policy byte equality.
