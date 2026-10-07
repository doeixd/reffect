# Private Queue Done carrier and local recovery

Prepared 2026-10-07 before feature code against PLAN/PROGRESS, QTERM, QIR, QPUB, Queue protocol/bridge, compiler marker audits and existing CatchAll lowering. This verifies a typed native substrate for local recovery; it does not admit generated completion programs.

## Primary evidence

Fresh Effect 4.0.0 [Queue.ts](https://unpkg.com/effect@4.0.0/src/Queue.ts) and [internal/effect.ts](https://unpkg.com/effect@4.0.0/src/internal/effect.ts) retain SHA-256 `6781fd0ac6fad03057ebeaa838d0f9723913027a4f6845d57dc3c17da70d1953` and `68c43e18e167d17b39f224d3793f11c7732cd857b7908ecd3ff1d1edf0affac2`. Fresh [Cause.ts](https://unpkg.com/effect@4.0.0/src/Cause.ts) (`1291ff90df538c8d52d171a36a2ce90a52c8ab7505b9318e18236114673279db`) defines typed Done with an optional leftover value. [Pull.ts](https://unpkg.com/effect@4.0.0/src/Pull.ts) (`5e3168eb4cf18fa9cafa4afebd18ffd20c5e563f2ea77667700f1a91b053f77c`) distinguishes Done recovery and mixed-Cause filtering. Effect v4's public typed recovery is `Effect.catch`; reffect retains a CatchAll IR node and compatibility alias. Interruption bypasses the typed handler. This slice supports only unit Done and single local failures, not Pull's general leftover/combined-Cause semantics.

## Decisions before implementation

- **QDONE-001 — Distinct zero-sized Done value.** Emit a private `QueueDone` struct, never an alias for Unit, Bool, Option or a payload. A private QueueTakeFailure enum holds Done(QueueDone), owner interruption and requesting-child control interruption separately. Add take_done_exit translating existing take_exit, preserving scalar success directly. No owner/bridge fields, heap envelope, per-value metadata or new crates. This raw-driver carrier does not replace QueueDoneType's deliberately unadmitted IR native marker or promise JavaScript object identity.
- **QDONE-002 — Static local recovery.** A generic private queue_catch_done future awaits its source, returns scalar success unchanged, invokes its FnOnce handler only for Done, and propagates both interruption categories unchanged. The handler receives the typed QueueDone and returns a statically stored recovery future. Borrowed Queue operations may occur in that recovery; no boxes, dynamic dispatch or new scheduler. Recovery failure remains failure. This models Effect.catch when Done is the sole domain error, not general mixed-Cause Pull.catchDone.
- **QDONE-003 — Preserve driver lifetime and cancellation boundaries.** Take retirement returns the bridge slot to Idle before a recovery may post another operation; synchronous terminal peer recovery must finish before the initiating End returns. Actual driver interruption must bypass the handler and unregister before completion. Explicit masked cleanup remains separate. Source/recovery futures are ordinary owned Rust fields; whole-driver Drop still retires registrations without implementing semantic finalization. Foreign pending, host abandonment, Send/RPC and retained failures across groups are not proved here.
- **QDONE-004 — Keep compiler gates explicit.** Public constructors remain Never/end-free. Neither generic nor public lowering selects this raw helper. Checked generated local Done needs new Queue CatchAll/End/shutdown operation receipts, full-edge growth traversal, marker-aware narrow selection, a proven native type mapping, frame reset/recovery rules and returned-root costs. Current Queue profiles and marker/host refusals stay unchanged; do not broaden them based on this fixture.
- **QDONE-005 — Acceptance.** Compare official Effect.catch traces for success bypass, completed Done recovery, recovery with another Queue operation, failure from the handler, Open-shutdown interruption bypass, and actual child cancellation. Cover Bool/U64/Unit success, repeated failure, unopened handler paths and settled children. Rust compile-fail proves Done is not Unit. Negative mutations recover interruption, discard handler failure or erase Done's category. Measure zero-sized Done, error-carrier size, zero quiet allocations and actual child/recovery future layouts in debug/release; retain Queue public/generated/terminal regressions serially.

## Alternatives and next gate

Using QueueTerminal::Done without a typed value loses the handler payload type contract. Treating typed Done as AsyncError::Interrupted prevents recovery. A heap-backed JS-shaped Cause envelope adds unnecessary storage for a unit-only local channel. A separate generated scheduler would duplicate the proved bridge. Reuse the inline enum and borrowed protocol first.

Next integrate an explicitly checked local Done profile into private generated lowering, with default2048 receipts, growth, both failure-frame policies and actual emitted/root costs. Retained/fail-fast Done across All, generated finalizers/timers and public completion admission remain subsequent gates. The pinned reentrant shutdown defect is already fixed upstream; no issue or baseline upgrade. PLAN.md belongs to the core instance and is unchanged.

## Delivered private extension

`take_done_exit` preserves scalar success and returns the distinct inline failure carrier. `queue_catch_done` stores generic source/handler futures directly and invokes its FnOnce handler only for typed Done. Owner and child control interruptions bypass it; recovery failure propagates unchanged. Recovery can post another Queue operation after the original request retires. No compiler/profile/public admission changes.

The differential fixture covers seven U64 trace families plus Bool and Unit success/recovery against official Effect.catch. Debug and release agree. Four deliberate mutations fail the interruption, Done-category and recovery-failure contracts; a Rust compile-fail rejects a Unit-typed Done handler. Nine families over 1,000 quiet rounds allocate zero times. QueueDone occupies zero bytes and QueueTakeFailure one byte. Actual child future pairs are `360/120` bytes for each U64 family and `96/208` for Bool and Unit, below the fixture's 512-byte per-child gate. These are borrowed-driver fixture costs, excluding host setup/output and compiler memory; they do not establish generated root/frame costs. Independent read-only review found no material blocker.

Exact validation commands (source Cargo first and run native builds serially):

```bash
vp test packages/reffect/tests/queue-done-recovery.test.ts packages/reffect/tests/queue-terminal-control.test.ts packages/reffect/tests/queue-continuation-runtime.test.ts packages/reffect/tests/queue-bounded-runtime.test.ts packages/reffect/tests/queue-host-runtime.test.ts packages/reffect/tests/queue-generated.test.ts packages/reffect/tests/queue-generated-frames.test.ts packages/reffect/tests/queue-public.test.ts packages/reffect/tests/queue-ir.test.ts --maxWorkers=1
tsc --noEmit --strict --project packages/reffect/tsconfig.json
vp check
vp run -r build
```

Results are recorded in PROGRESS.md after verification. Run these checks again after the focused commit before pushing.

## Generated recovery safeguards — preparation 2026-10-07

Fresh online Queue/internal-effect sources again match the hashes above. Reviewed current generated profile, compiler marker audit, plain/framed evaluators, QBUD and shared growth visitor before feature edits. This delivery prepares analysis only; selector, native mapping/lowering, owned execution and public constructors remain unchanged.

- **QDONE-006 — Terminal-aware conditional budget.** Count each End/shutdown occurrence in a new `terminals` field, with saturating edge addition and independent branch maxima. Both reference terminal functions are Sync followed by Success (inside the evaluator Suspend); charge16 in both modes, including spare interruption paths. Finalize resumes each removed taker once; Closing End can schedule a readiness pass without an appended offer. Extend global retry charge to `16 * (offers + terminals) * takes`; false repeated terminal calls are conservatively counted too. Offers after completion return false and cannot create unbounded wakes. The original no-terminal receipts remain identical except for `terminals: 0`. This bounds reference operation expansion under QBUD's conditional default context, not termination, runtime steps or safe reentrant shutdown topology.
- **QDONE-007 — Recovery charges both edges.** CatchAll uses DBUD's existing3/5 plain/framed local overhead and sums source plus handler occurrence summaries. Handler may run after source failure, so taking a maximum is unsound. Failure filtering is synchronous; rejected interruption adds a Failure primitive covered by this receipt. Framed handler failure adds the existing outward decoration. Keep unknown Fail, finalizers/timers, host options and non-All2 groups refused. No scalar error representation is inferred by this analysis.
- **QDONE-008 — Full-edge recovery growth.** Queue-mode growth traverses both CatchAll edges regardless of success or handler reachability. Count shared incoming edges fully, including handler text/expression/depth costs, and detect cycles in either edge. Leave other coordinator modes' CatchAll refusals unchanged; a native Done expression remains unaccounted. A finite receipt is never sufficient for generated admission.

Acceptance: official plain/framed scheduler probes cover empty End, buffered drain, recovery that posts another terminal/take/offer, Closing shutdown, Open interruption bypass and actual parent cancellation. Check exact terminal/retry arithmetic, shared handler edges, branch counters, saturation, dormant oversized handler rejection, cycles and recovery text. Mutate away terminal retry and handler accounting to demonstrate meaningful guards. Existing profile/lowering must still refuse completion programs even when both analysis receipts pass. Retain existing Queue/source/compiler/growth regressions and all native Queue costs. Next implement narrowly checked private lowering with frame reset and native marker proof.

### Delivered analysis safeguards

Queue receipts now retain `terminals`, charge terminal wakes alongside offer retries and sum both CatchAll paths. Queue-mode growth accounts for both recovery edges including dormant/shared handler text and detects handler cycles. No runtime code, native payload layout, public API, selector or compiler marker guard changes. The simple empty-End/local recovery fixture is126 plain/176 framed, including its two asVoid Maps. Existing offer/take totals are unchanged with zero terminals.

Twelve focused tests pass across budget and new safeguards. Official plain/framed probes cover controlled terminal and recovery workloads plus shutdown/cancellation with no automatic yielding. A dormant oversized handler passes budget but fails source growth; terminal pressure passes growth but saturates/rejects budget. Finite receipts still fail generated selection/lowering. Three temporary negative source mutations (terminal retry, handler budget, handler growth) fail their contracts; original sources were restored before regression. These probes corroborate the primary-source argument; they do not admit the pinned defective reentrant topology or enforce ambient context by themselves.

Additional validation commands:

```bash
vp test packages/reffect/tests/queue-budget.test.ts packages/reffect/tests/queue-recovery-safeguards.test.ts packages/reffect/tests/queue-generated-profile.test.ts packages/reffect/tests/queue-execution.test.ts packages/reffect/tests/queue-lowering.test.ts packages/reffect/tests/latch-budget.test.ts packages/reffect/tests/semaphore-budget.test.ts --maxWorkers=1
# Add this suite to the serial native Queue command above to verify the shared growth visitor:
vp test packages/reffect/tests/deferred-generated-growth.test.ts --maxWorkers=1
```

Independent read-only review found no material blocker in the conditional operation proof, shared/dormant growth accounting or unchanged admission gates. Strict TypeScript and full check/build pass. Source regression passes39 tests across seven suites; serial native/IR regression passes39 across ten, with existing allocation/layout evidence unchanged. Re-run source checks, strict/check/build and the following shared-growth/generated/frame/public native regression after the commit before pushing:

```bash
vp test packages/reffect/tests/deferred-generated-growth.test.ts packages/reffect/tests/queue-generated.test.ts packages/reffect/tests/queue-generated-frames.test.ts packages/reffect/tests/queue-public.test.ts --maxWorkers=1
```

Results are recorded in PROGRESS.md.

## Private generated End/local recovery — preparation 2026-10-07

Fresh online pinned Queue/internal-effect sources match the primary hashes above. Reviewed QDONE/QBUD/QFRAME, current profile/lowering/marker gates, CatchAll's source-error helper specialization and infallible All driver before edits. Reuse the borrowed Queue driver and standard AsyncError::Fail, with a distinct QueueDone payload. Do not add a scheduler, runtime metadata, crate or heap-backed error envelope.

- **QDONE-009 — Explicit private selection.** Add a private source-module `analyzeGeneratedQueueDoneProfile` and `lowerQueueDoneFunctions` path; compiler and public execution keep the existing end-free selector. The new path may also lower existing Never Queue exports. A Done owner uses the exact canonical unit witness, one root lexical capacity1..3 scalar Queue, zero inputs/scalarNever function, one unconditional All2 UnitNever group. End, Offer, Take, scalar composition, plain logs and local CatchAll are supported. Done may propagate only inside a CatchAll source within a child; the handler must return Never. Handler expressions cannot consume/store/export the Done value. Unknown marker aliases, hidden pure signatures, escaping channels, fallible/nested groups and recovery outside children stay refused.
- **QDONE-010 — End-only completion.** No generated Shutdown in this slice, even inside recovery. This excludes the pinned reentrant shutdown defect without silently changing the oracle. End may drain buffered/registered producers or complete a waiting consumer; false repeated End/Offer after completion retain their observable bool result. Parent operations, external timers/finalizers and wider owner/task/channel topologies remain refused. Budget/growth/default-context gates apply unchanged.
- **QDONE-011 — Local native mapping and recovery frames.** Keep QueueDoneType's private marker unchanged. Only the checked private profile enables canonical Done computation error channels; all Queue/Done expressions and operation-signature markers remain audited. Emit QueueDone for those helper error types, take_done_exit as AsyncError::Fail(QueueDone), and both interruption categories as AsyncError::Interrupted. Reference diagnostic planning now mirrors lexical scope plus specialized error-channel helper identity and traverses source/handler separately. Source Done frames are dropped when recovered; handler interruption frames follow standard CatchAll wrapping. Mixed modules' Combined carrier is an explicit impossible arm for this checked local channel, never coerced into Unit/RuntimeFailure or used to retain Done across All.
- **QDONE-012 — Native acceptance.** Compare official plain/framed outcomes and logs for immediate/buffered drain, waiting End callback order, nested local re-take recovery, success-handler bypass, repeat End/closed Offer, Bool/U64/Unit and parent interruption while the caught source Take waits, including unopened handler paths. In this End-only/same-owner/no-timer profile, recovery cannot semantically suspend: owner Done makes Offer/End immediately false and Take immediately Done. Suspended recovery remains a wider-owner/timer gate. Exercise Full/None source artifacts and None/Bounded failure frames in emitted Rust, plus mixed ordinary fallible/coordinator exports; retain prior QPUB service-composition regression (the new fixture has no service export). Assert bounded returned-root layouts, emitted bytes, quiet construction/execution and handled-error allocation counts. Mutations erase Done into interruption or retain handled frames and must fail. Keep public/native generic refusals and unrelated coordinator admission stable. This does not promise full Cause identity, Send/RPC, host abandonment, generated finalizers or public End admission.

Next gate after this delivery: retained Done/fail-fast across All, explicit generated cleanup/masking and safe shutdown/topology reconciliation, then public completion admission.

### Delivered private generated extension

`lowerQueueDoneFunctions` recomputes a checked private profile and uses the existing borrowed All2 driver. Canonical unit Done is mapped only in that profile's internal error channels. End and Take helper lowering preserve domain/control distinction; local recovery drops handled frame storage and never projects Done into RuntimeFailure::Unit. Unknown/hidden type markers still refuse, and ordinary/public Queue selectors and owned execution remain end-free. Recovery is non-suspending once this single owner is Done; waiting-source cancellation is tested separately.

The fixture compares official logs/outcomes across eight Queue exports (waiting End, buffered drain/success bypass, nested re-take recovery, closed Offer/repeated End, Bool, waiting cancellation, quiet recovery and Never transfer), and builds mixed ordinary fallible/Deferred exports. Full/None artifacts × None/Bounded frames × debug/release all execute. Quiet construction allocates zero; 100 recovered Done invocations allocate zero with frames disabled or100 temporary trail boxes with Bounded frames, with zero retained tracked allocations. Successful/root interruption observations contain no handled Done trail; parent cancellation retains only All/QueueScope/function. Mutating Done into interruption and forgetting handled trail boxes fails the semantic/release assertions.

Linux returned-root future bytes (export order empty, drain, nested, closed, boolean, blocked, quiet, plain): None frames `1440,1632,1344,1400,1456,1080,1440,1168`; Bounded `1456,1864,1432,1560,1616,1096,1456,1184`. Debug/release and artifact policy agree. Each root passes the existing finite Queue layout gate; emitted Rust is checked below 2MiB. These are fixture-specific scalar/end-only costs, excluding host setup/output, compiler heap and ordinary mixed exports. Existing runtime metadata and dependency selection are unchanged.

Validation commands:

```bash
vp test packages/reffect/tests/queue-generated-profile.test.ts packages/reffect/tests/queue-budget.test.ts packages/reffect/tests/queue-recovery-safeguards.test.ts packages/reffect/tests/queue-execution.test.ts packages/reffect/tests/queue-lowering.test.ts packages/reffect/tests/queue-ir.test.ts packages/reffect/tests/latch-generated-profile.test.ts --maxWorkers=1
# Source Cargo, then run native builds serially:
vp test packages/reffect/tests/queue-generated-done.test.ts packages/reffect/tests/queue-generated.test.ts packages/reffect/tests/queue-generated-frames.test.ts packages/reffect/tests/queue-public.test.ts packages/reffect/tests/deferred-interruption-frames.test.ts --maxWorkers=1
tsc --noEmit --strict --project packages/reffect/tsconfig.json
vp check
vp run -r build
```

Independent read-only review found no source blocker in selection/markers, helper/frame identity, mixed-carrier exhaustiveness or costs. It caught the unreachable suspended-recovery acceptance phrase and absent service-export claim; both are corrected. Source regression passes 50 tests across seven suites; serial native/diagnostic regression passes 18 across five, with existing Queue costs unchanged. Strict TypeScript and workspace build pass (one rebuilt package, three cache hits). Full check found one unused test import, removed before lint verification. Post-commit strict/check/build and the same source/native regressions precede pushing. Public completion, Shutdown, suspended recovery and retained/fail-fast Done remain open.

## Private retained source through cleanup — preparation 2026-10-07

Fresh [Effect4.0.0 internal/effect.ts](https://unpkg.com/effect@4.0.0/src/internal/effect.ts) matches the recorded SHA256. Reviewed OnExit's masked finalizer and original-exit restoration, concurrent All's terminal/observer aggregation, QASYNC host cancellation and existing Done carrier. An official probe interrupts cleanup after a source Done, scalar success, owner interruption or waiting-source interruption: cleanup completes in all four; Done remains typed failure, while an earlier success becomes interruption.

- **QDONE-013 — Retain before cleanup.** Add a private borrowed QueueTask `ensuring_done` combinator for scalar success/unit Done/control errors and an infallible cleanup factory. Await source first, construct/run cleanup exactly once, retain its Result inline across suspension, and return only after cleanup settles. After cleanup, sticky child interruption replaces success only; typed Done and existing owner/control interruption remain failures. No erased Unit error, boxed future, dynamic Cause or new driver/bridge field.
- **QDONE-014 — Masking is explicit.** Cleanup may use only existing masked `cleanup_sleep`/`cleanup_shutdown` primitives and synchronous work; the combinator does not make arbitrary supplied futures safe or mask ordinary Queue requests. Infallible cleanup excludes defects/typed finalizer failures, and dropping the future does not run cleanup. Host lifecycle stays run-once/current-thread; preabort opens neither source nor cleanup. No compiler/public API widening. This is a prerequisite for retained All outcomes, not an All fail-fast implementation. All still needs safe interruption of an active End initiator plus Cause aggregation/frame policy before admission.
- **QDONE-015 — Evidence.** Compare official child Exit categories and cleanup trace for normal Done/success, cancellation during their cleanup, owner shutdown and blocked-source cancellation, plus success payloads Bool/Unit. Hosted native debug/release must await cleanup, preserve Done, convert canceled success, retire waiters and restore masks. Assert zero warmed quiet allocations and bounded actual child layouts. Mutations erase retained Done and forget late success interruption; both must fail. Existing Queue host/local/generated/public regressions retain their gates.

Alternatives: defer all work until a general fallible scheduler (unnecessarily bundles error retention with reentrant cancellation); add generic stored Cause to QueueBridge (adds cost to public offer/take); reuse infallible child bool (loses Done). Chosen static combinator isolates source retention with no ordinary runtime layout change. Full Cause multiplicity, fail-fast, generated finalizers and public completion remain open.

### All startup constraint for the next gate

Independent public-API probes against pinned Effect distinguish eager startup from registered children. Direct `All([take, end→log], unbounded)` logs `end:true` before the group returns a single Done failure: the eagerly starting End child is not yet a member of the concurrent iterator's fiber Set. Park End on a Deferred first, start All, then release it: the waiting Take fails inline, its observer interrupts the registered End child, and the post-End log is absent. A blanket rule interrupting every active End initiator would fail the first case. The existing generated profile excludes external Deferred suspension; this evidence guides later routing/membership design without admitting it.

Queue End's `exitZipRight` keeps the first Failure, and shared unit Done reasons are deduplicated by Cause equality; do not invent two Done reasons from End's implementation. Retention here compares typed Exit categories and cleanup order, not complete Cause reasons/annotations/interrupt identities or logical frames.

### Delivered raw retained cleanup

The private borrowed task now stores its Result directly across cleanup and checks late sticky interruption only on success. Six official/native hosted traces cover normal Done/success, canceled Done/success cleanup, owner interruption and waiting-source cancellation. Additional probes cover Bool/Unit success, source-before-factory order, exactly-once cleanup, restored masks, waiter retirement and unopened preabort. Debug/release agree. Erasing domain failure or forgetting late success interruption fails the corresponding mutation.

Linux fixture child futures are576 bytes in each of the six cases; the quiet mixed scalar/Done future is456 bytes (all below the1024-byte fixture gate).100 warmed executions with masked1ms Sleep allocate0 times, including source retention, borrowed host driver and context/watch cloning; original runtime/watch construction and output are excluded. No bridge/driver field, metadata envelope or dependency changes. Existing generated Done artifact/frame/build layouts and allocation counts remain unchanged. This demonstrates source retention through infallible masked cleanup, not a generated/fallible All or full Cause implementation. Independent read-only review found no blocker in this scope.

Validation:

```bash
# Source Cargo, use CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1:
vp test packages/reffect/tests/queue-retained-cleanup.test.ts packages/reffect/tests/queue-host-runtime.test.ts packages/reffect/tests/queue-done-recovery.test.ts packages/reffect/tests/queue-generated-done.test.ts packages/reffect/tests/queue-public.test.ts --maxWorkers=1
tsc --noEmit --strict --project packages/reffect/tsconfig.json
vp check
vp run -r build
```

Repeat relevant tests and checks after commit before pushing; final results belong in PROGRESS.md.

## Private fallible All driver — preparation 2026-10-07

Fresh [pinned internal/effect.ts](https://unpkg.com/effect@4.0.0/src/internal/effect.ts) matches SHA256 `68c43e18e167d17b39f224d3793f11c7732cd857b7908ecd3ff1d1edf0affac2`. Reviewed concurrent iterator startup membership, completion observers, interrupt filtering, QDONE source retention, callback receipt phases and host cancellation. Reuse the same borrowed driver/protocol; introduce an explicitly selected private emitted specialization rather than changing ordinary offer/take layout.

- **QALL-001 — Private specialization.** `queueContinuationRuntime(true)` and matching `queueHostRuntime(true)` accept two pinned child futures returning `Result<(), QueueTakeFailure>`. Store their outcomes and a terminal category inline, plus membership bits. Default emission stays infallible and has no new fields/branches. No public/compiler selector, error witness, crate or scalar payload layout changes. Raw callers must use `start`/`run_hosted` for ordered startup, not manually poll an unopened sibling after failure.
- **QALL-002 — Membership follows real suspension.** Register a child only when its initial driver pump reaches Waiting/CleanupWaiting; completed eager children never join the membership set. A reported failure skips an unopened later child. On a peer failure, a registered active/Processing initiator receives sticky interruption without recursive future polling; its ordinary ready Queue response then becomes control interruption. An eager active initiator stays un-interrupted and may complete its post-End continuation. Masked request responses bypass that control check.
- **QALL-003 — Settlement before result.** At outer driver boundaries, interrupt registered inactive peers through existing waiter retirement and cleanup polling. Never call boundary-only interruption from inside an active callback. Await explicit masked cleanup even after failure/parent cancellation. Completed peers remain completed. If an entered child later reports Done after interruption/cleanup, retain Done over interruption; canonical unit Done categories collapse to one. Expose an all-exit accessor only after both children settle; reject closed drivers and abandoned entered children, while allowing unopened skipped children. This proves a bounded typed category, not arbitrary Cause annotations, identities, frame trails, typed finalizer failure or a general scheduler.
- **QALL-004 — Managed suspension only.** The selected host requires an interruptible root; general uninterruptible children/root regions are excluded, since fail-fast cannot assume those Queue waits can be interrupted. Native fixtures use Queue Waiting and the existing masked Sleep primitive. A masked Sleep before End models a registered child; its official oracle is `uninterruptible(sleep)` followed by End. It does not admit ordinary timers, foreign Pending, direct owner mutations during child execution, wider owners/tasks, cross-coordinator sharing, Send/RPC or abandonment. Shutdown stays outside generated completion admission.
- **QALL-005 — Acceptance.** Official/native debug/release traces cover eager/reversed End, initially failed source/unopened sibling, registered End with suppressed continuation, registered/eager Take while a blocked producer resumes and fails (buffered Offer side effects survive), failure interrupting a waiting sibling, completed peers, sleeping cleanup, parent cancellation while a Done source is retained, duplicate unit Done and all-success/interruption. Check waiter retirement, cleanup ordering, independent repeated runs, finite layouts and warmed quiet allocations. Mutations collapse Done, blanket-register eager children, ignore interruption of a ready active request or omit the Processing guard and must fail. Re-run default host/raw/generated/public Queue regressions to prove unchanged layouts and admission.

Alternatives rejected: an outer Tokio select (cannot observe inline completion ordering), a second scheduler/duplicated queue core, or outcome/membership fields on every ordinary driver. Explicit private emission shares the audited protocol while keeping ordinary cost unchanged. Full Cause/frame representation and checked generated fallible All remain the next gates.

### Delivered private raw All specialization

The selected driver records inline Unit/Done/control results after short pinned borrows end. Membership starts at managed suspension; eager completions never join it. Registered active or Processing initiators receive sticky interruption, consumed by an ordinary Ready request without re-polling a borrowed future. Inactive Queue-waiting peers retire their registrations before cleanup starts; sleeping cleanup remains awaited. Closed/abandoned entered children cannot report a settled result, and the selected host refuses inherited root masking before opening work. All ordinary generated/public paths still emit the default infallible driver.

Thirteen official/native debug/release traces match typed outcome categories and event order, including both End and Take startup distinctions. The Take cases also verify the second buffered Offer survives consumer interruption. Done retained through parent cancellation and later masked cleanup wins over interruption; duplicate unit Done is one typed category. Tests also cover synchronous initial failure/unopened sibling, preabort, completed peers, mask refusal and abandonment/closed-result refusal. Four temporary mutations fail: terminal erasure, eager registration, missing Ready interception and missing Processing detection.

Independent review proposed the Take fixtures, which exposed a Retry gap: `route_with_waker` executes Take before marking its pinned future active. A producer failure in release-capacity therefore encounters Processing plus inactive, rather than a safe Waiting slot. The initial regression run reproduced `Interrupt only a Queue-waiting child`; recognizing Processing fixes it, and the focused mutation reproduces that failure. Review found no further phase/lifecycle blocker within the managed-operation limits. Full Cause reasons/annotations and logical frames remain unproved; in particular parent cancellation plus retained Done can include both Interrupt and Fail reasons in the oracle, while this carrier exposes the typed category only.

Linux fixture layouts: child futures `560/384` bytes, selected driver `80` bytes, hosted future `232` bytes. Quiet fixtures use `120/384` byte children with the same driver/host sizes. These are fixture-specific measurements, not total process memory. Both quiet modes (with/without warmed masked 1 ms Sleep) allocate zero across 100 repeated runs, including borrowed driver and context/watch cloning; initial runtime/watch creation and output are excluded. The extra driver state costs 8 bytes versus the ordinary 72-byte driver; default public/generated artifacts retain their previous layouts and allocation counts. No native scalar metadata, boxed future, runtime dependency or public admission change.

Validation:

```bash
# Source Cargo, use CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1:
vp test packages/reffect/tests/queue-fallible-all.test.ts packages/reffect/tests/queue-retained-cleanup.test.ts packages/reffect/tests/queue-host-runtime.test.ts packages/reffect/tests/queue-done-recovery.test.ts packages/reffect/tests/queue-generated-done.test.ts packages/reffect/tests/queue-public.test.ts --maxWorkers=1
tsc --noEmit --strict --project packages/reffect/tsconfig.json
vp check
vp run -r build
```

Repeat the coherent final source set after commit before pushing. Next: choose the bounded observable Cause/frame contract and checked generated fallible-All error mapping; do not silently classify composite Done as a generic scalar. Generated finalizers and safe Shutdown/public completion remain subsequent gates.
