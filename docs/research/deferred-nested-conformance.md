# Nested Deferred Race conformance

Prepared 2026-10-05 before test edits. Reviewed AGENTS, PLAN, PROGRESS, TURN-001–008 and existing generated conformance. The installed Effect v4 `raceAll` implementation cancels other children after the first successful result and waits for interrupted children before resuming its parent. This is distinct from selecting a winner and dropping loser futures.

**DNC-001 — Independent cancellation witness.** An initial inner Race is one child of outer All3. Its losing main-cell waiter has an awaited cleanup that completes a second lexical signal. A producer waits for that signal before completing the main cell; an unrelated main-cell waiter must still resume. The signal proves loser cancellation/finalization happened without guessing that a timer gave registration enough time. Its trace also proves cleanup finishes before Race returns and a canceled registration cannot resume later.

**DNC-002 — Exact prefixes and ownership reuse.** Compare separately authored official Effect, plain/framed reference and actual emitted Rust. Preserve trace order, including synchronous prefixes during Deferred completion; do not sort logs. Exercise a separately selected producer-first outer child order in both independently authored Effect and the actual generated graph, so routing must revisit the earlier producer while an inner losing finalizer drives its completion signal. Repeat initial nested timer groups sequentially to exercise drained slot reuse, retaining separate winning/losing completion and retained scalar observations in the isolation workload.

**DNC-003 — Parent cancellation drains nested scopes.** Establish initial pending children with a zero controlled-clock adjustment / one root poll, then interrupt the real parent. Both nested Race children and unrelated waiter have awaited finalizers; root return requires all completion messages. Never forcibly drop an armed completion future.

**DNC-004 — Costs remain attributed.** Measure actual nested invocation future, bank capacity and complete harnessed allocation calls in debug/release and None/Bounded. Counts include logging, timers, cancellation/watch and executor work. Keep the existing quiet invocation zero-allocation test separate. Public Compile.plan refusal remains required; this is a private topology extension only.

Deadlock risks: a cancellation signal emitted only after cleanup must remain pollable through the parent coordinator route; a selected canceled waiter can suspend in cleanup without falsely acknowledging its ancestor; an inner coordinator cannot mark semantic pending solely because a child is blocked by turn routing. Finalizer ordering and eager Race child startup must be checked against the independent oracle before accepting native traces.

## Independent oracle observations

The installed Effect v4 controlled-clock probes pass. Isolation logs are exactly: loser start, winner start, unrelated survivor start, producer start, winner done, loser cleanup start/done, survivor synchronous prefix, first completion true, second completion false, retained first U64 value true, Race return. Completing the cleanup signal synchronously resumes the producer, which completes the main owner and resumes the surviving waiter before the inner Race's return continuation. A coordinator that merely wakes peers or drops the losing waiter cannot match this ordering.

A separate sequential reuse workload runs two initial timer Race groups under one lexical owner and completes that owner only after both groups drain. Each Race logs loser/winner start, the outer peer/marker prefixes, winner done, awaited loser cleanup start/done and Race return. Repeating a whole isolation graph would start the second group after Deferred callback resumption, so it remains refused by DEFERRED_CALLBACK_GROUP; the reuse fixture deliberately preserves that admission barrier. Parent interruption first observes inner1/inner2/outer start, then their three cleanup-start events in that order, then their three cleanup-done events in that order. All clocks are controlled; no wall-clock delay is used to establish registrations. Ordinary reference execution rejects the nested group before logging. The suite uses the checked internal GeneratedDeferredReference entry alongside the private lowerer, and explicitly verifies ordinary Reference.run remains refused. Public native refusal may occur at the existing nested checker or the Deferred plan gate; neither is bypassed.

Independent official/private plain/framed and ordinary/public refusal checks pass 3/3 (62ms assertions; 1.58s suite) with `vp test packages/reffect/tests/deferred-nested-conformance.test.ts -t 'fixtures|ordinary reference|public native' --maxWorkers=1 --reporter=verbose`. Native validation uses the root-coordinated exclusive Cargo lane. The existing [quiet capture-cost suite](helper-capture-costs.md) retains its separate first-execution zero-allocation guarantee; nested whole-drive allocation measurements will not be relabeled as owner-only costs.

## Native validation and costs

The table below records initial delivery costs. [Borrowed child storage](nested-future-storage.md#implementation-and-measurements) subsequently reduces these futures to 10520–15248 bytes without changing the observed traces or allocation counts; the same actual generated fixtures now enforce a pointer-scaled storage regression budget.

The complete suite passes 4/4 (60.59s assertions / 62.75s total): all four actual generated functions agree with the independent official/private plain/framed observations in debug/release and None/Bounded. Both ordinary reference and public native entry points remain refused. Contiguous context reservations measure six contexts for isolation and sequential reuse, five for nested parent cancellation. The emitted primitives and helpers, rather than replacement handwritten owners, perform the observed work.

Command: `CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 vp test packages/reffect/tests/deferred-nested-conformance.test.ts --maxWorkers=1 --silent=false --reporter=verbose`.

Rust 1.98.1 / Tokio 1.53.1 on the current x86-64 profile reports identical debug/release layouts and allocation-call counts:

| Workload                                          | Future bytes None | Future bytes Bounded | Whole-drive allocation calls None | Whole-drive allocation calls Bounded |
| ------------------------------------------------- | ----------------: | -------------------: | --------------------------------: | -----------------------------------: |
| Independent waiter cancellation and retained U64  |             42856 |                43624 |                                30 |                                   31 |
| Sequential nested group slot reuse                |             32832 |                33344 |                                43 |                                   45 |
| Parent cancellation with three awaited finalizers |             36872 |                37536 |                                23 |                                   28 |

The fixture module reaches logging, so context sizes remain 96 bytes None / 104 bytes Bounded. These whole-drive allocation counts include logging, timer/executor, cancellation and diagnostic processing after watch/context creation; they do not measure isolated Deferred owner allocations. Inline nested futures reaching approximately 43KB are an explicit optimization concern before broader nesting/public admission. Exact future layouts are observations rather than a portable ABI or a claimed completed growth gate. The earlier quiet generated invocation allocation guarantee remains independently tested.

## Exact interruption diagnostics — 2026-10-05

[Private interruption-frame recording](deferred-interruption-frames.md) extends the existing conditional reference experiment with per-invocation masked observers, excluding task children and finalizers. The nested suite now compares the literal all/deferredScope/function trail and zero omitted count for parent cancellation in reference and native bounded mode; successful workloads assert empty trails. Debug/release and None/Bounded remain required, as do exact unsorted cleanup traces and the existing future-storage/allocation checks. The initial combined root/nested matrix passes20/20 (169.62s), including16 nested native cases. Public exposure, scope-indexed shared root paths and broader graph growth remain gated.
