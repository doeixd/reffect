# Generated Deferred All coordinator

Prepared 2026-10-04 before feature edits. Reviewed DGEN-001–005, current structured All runtime, inline owner/turn bank and real AsyncContext adapter. Checked published [Effect 4.0.0 Deferred](https://unpkg.com/effect@4.0.0/src/Deferred.ts) online against the installed source. Existing Tokio 1.53.1 watch cancellation and safe pinned polling supply execution machinery.

**DGR-001 — Preserve All cleanup semantics.** Generate fixed All2/3 coordinators returning the existing child-wrapper Boolean outcome. A false child cancels every sibling; parent cancellation cancels every child. Never return until all child futures finish their cleanup. Race and nested groups remain refused.

**DGR-002 — Observe cancellation independently of turn priority.** Pin a cancellation receiver future alongside children and poll it before any child. Turn gating affects child polls only, so a masked broadcast cannot hide parent cancellation. Pending completion still drains its cohort; cancellation signals never forcibly drop children.

**DGR-003 — Retry only protocol progress.** Borrow the bank and distinct checked task slots. Poll eligible child futures in stable input order and restart only when the bank reports request/acknowledgement progress. A bounded retry burst yields to the executor without marking semantic suspension. Primitive timers/watch futures retain the parent task's real waker. The lowerer wraps each child in the existing task acknowledgement adapter.

**DGR-004 — Separate substrate from semantics.** Reuse state, turn and context adapter emitters; no allocation, unsafe projection, spawned task, new context field, scalar wrapper or crate is introduced by the coordinator. Existing child watch channels are execution-context machinery and are outside isolated owner-allocation claims. Trusted host forced Drop/panic remains unsupported.

Validation: compile real Rust debug/release, check parent cancellation drains masked asynchronous cleanup, child interruption cancels siblings, registration-order broadcast prefixes survive and completed groups leave no active bank turn. Independent generated-workload conformance is owned by the integration agent. Public/default-scheduler gates are unchanged.

Implementation review: the pinned parent watcher loops on false updates, preserving the existing cancellation predicate rather than treating every watch notification as cancellation. Parent cancellation and sibling interruption do not bypass bank routing or drop an armed completion. The focused harness passes debug/release across ten fresh-owner repetitions of masked-broadcast cancellation, child interruption and cancellation during final masked cleanup (1/1 Vitest test, 20.79s). Its first draft incorrectly assumed a zero-delay sibling timer completed synchronously; an interrupted timer exposed that fixture assumption, which was corrected to an immediately completed sibling. The final focused rerun also passes false-update and masked-parent witnesses, in debug/release across ten repetitions (1/1 test, 16.29s). Independently generated reference/native conformance passes 2/2 in debug/release × None/Bounded (37.80s).

Command: `CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 vp test packages/reffect/tests/deferred-generated-runtime.test.ts --maxWorkers=1`. Scoped formatting/lint/types pass for the two new TypeScript files.
