# Internal Deferred authoring and reference integration

Recorded 2026-10-04, after reviewing the roadmap, progress, DEFCORE, DOWN, TURN and DBUD records. Published [Effect 4.0.0 Deferred source](https://unpkg.com/effect@4.0.0/src/Deferred.ts) was fetched before edits; make, await, isDone, succeed/fail and synchronous doneUnsafe callbacks agree with installed sources.

**DIC-001:** Add internal builders and dedicated immutable nodes, consuming make directly through flatMap into one lexical owner. Success channels are Bool/U64/Unit; errors additionally allow Never. Channel witnesses remain build-owned. Native admission and public exports stay gated until ownership, callback budgets and generated conformance are established.

**DIC-002:** Canonical witnesses use a private WeakMap keyed by native identity. Recursive detection also rejects the reserved native type name, including forged witnesses. The checker validates every handle operation against the live owner's channels; a handle cannot become a public value, Ref payload, Schema/service value or serialized layout.

**DIC-003:** Interpret through official Deferred, retaining plain payloads. Framed await constructs its own failure occurrence; completion must never store a producer's framed failure. Await and completion are classified async because completion may drive a resumable callback cohort. IsDone and allocation are synchronous; owner classification follows its body.

**DIC-004:** Existing task-group ownership removes Ref/file captures but permits checked lexical Deferred borrows. This changes no nested-group admission; the initial integration keeps nested topology separately gated. Generic pure expression use of handles is refused, except the direct lexical binder passed to dedicated builders.

Validation: internal admission and reference tests cover first completion, losing completion, late observation, typed failure, invalid channels, forged/recursive escapes and malformed binders. Root integrates exhaustive visitors and explicit native refusal; generated support remains a separate gate.

Implementation evidence: the five internal reference/admission tests match official first/lost/late completion and synchronous broadcast prefixes in both plain and framed interpreters, verify isDone transitions, await failure occurrences, malformed binders/channels, recursive forged native witnesses and opaque operation handle consumption. Compile-only fixtures verify data-first/data-last channel inference with NoInfer. Expression scans include map bodies, Ref.modify expressions and stream payload/encoder expressions. Effect's automatic stack annotations are excluded from scalar failure comparisons; retained typed payload and explicit logical frames are the observations asserted.
