# Deferred checked IR and reference preparation

Recorded 2026-10-03 against Effect 4.0.0. Read PLAN, PROGRESS, lexical-coordination.md (LCOORD-001..008), deferred-native.md and deferred-conformance.md before feature edits. Verified [published Deferred source](https://unpkg.com/effect@4.0.0/src/Deferred.ts) against installed `node_modules/effect/src/Deferred.ts`; await registers a callback and removes only that callback on interruption, while completion retains the effect and clears its cohort.

## Decisions

- **DEFCORE-001:** Direct make/flatMap elaboration yields DeferredScope with an opaque binder. Make alone and recursive handle escape are refused. Only scalar Bool/U64/Unit success and Bool/U64/Unit/Never error channels are admitted. Witness identity is compiler-owned, not metadata attached to runtime scalar values.
- **DEFCORE-002:** Dedicated Await, Complete and IsDone nodes validate their live owner binder and channel witnesses. Capturing a lexical coordinator into task children is permitted; captured Ref/file access remains forbidden. Complete validates its payload against the selected success/error channel and preserves Bool/Never operation channels.
- **DEFCORE-003:** Both reference interpreters use official Deferred. Framed completion stores plain payload E, and each failed await creates its own diagnostic failure at its execution occurrence. Sharing a stored framed wrapper would wrongly share waiter provenance.
- **DEFCORE-004:** Await and completion use async lowering; lexical owner traversal contributes body effects. Completion's proposed cohort adapter can suspend without exposing handles, but its poll-turn/scheduling agreement is an unresolved implementation gate; no Deferred source is admitted until that evidence exists. Substitution preserves coordinator binder identity and rewrites completion payload expressions; ordinary runtime expression substitution does not convert handles into serializable data.
- **DEFCORE-005:** Admit only one nested Never Race2 in an outer Never All2/3. Context-sensitive checking retains error/mode ancestry and cleanup state; any fallible nested group, deeper nesting, nested All, or two potentially concurrent inner groups remains refused. Mutually exclusive alternatives take maxima, sequential reuse takes maxima, parallel child summaries sum. Conservative capacities are at most four leaf waiters and five descendant contexts. No runtime overflow fallback is permitted.

## Implementation status

Research only. Root sync validation passed; the scheduling gate remains open. No feature source edits were saved: drafts are held outside the repository while completion cohort poll-turn semantics remain unresolved. DEFCORE-004 is a proposal, not proven scheduling compatibility.

## Alternatives and acceptance

General Fiber handles would add new join/interrupt ownership contracts, and Arc-backed ordinary values would broaden escape and cost guarantees. Reuse existing borrowed structured groups instead. Independent cancellation is proven by the three-owner isolation workload in LCOORD-008, not parent cancellation alone. Admission fixtures cover malformed witnesses/binders, recursive escape, invalid topology and existing shared Ref/file refusals. Reference fixtures cover first completion, broadcast and late observation, per-await framed failure, and the native agent/conformance agent own complete differential evidence. General effect-valued completion, full Cause payloads, detached sharing and resource payloads remain deferred.
