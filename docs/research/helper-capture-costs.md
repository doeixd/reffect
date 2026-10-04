# Generated helper capture costs

Prepared 2026-10-04 before test edits. Reviewed AGENTS, PLAN, PROGRESS, DGEN/DHELP/DGC records and current emitted Deferred conformance tests. Public Deferred admission remains refused.

## Primary sources and consequences

Checked the [Rust Reference async-block representation](https://doc.rust-lang.org/reference/expressions/block-expr.html#async-blocks), [async function parameter capture](https://doc.rust-lang.org/reference/items/functions.html#r-items.fn.async.param-capture), [closure capture precision](https://doc.rust-lang.org/reference/types/closure.html#capture-precision), and [`size_of_val`](https://doc.rust-lang.org/std/mem/fn.size_of_val.html) documentation on 2026-10-04 against the installed Rust 1.98.1 toolchain. Async blocks produce anonymous future types whose layout is unspecified; the reference describes an approximate enum of suspension states. The async-function contract captures all arguments, including unused arguments, into the returned future; this preserves drop ordering. Closure capture precision cannot replace pruning generated async function signatures. Measurements must therefore exercise emitted futures rather than infer their layouts from source argument counts.

## Decisions before implementation

**HCOST-001 — Keep semantic evidence separate from capture evidence.** Existing independently authored official/plain/framed/native ordering and cancellation fixtures remain authoritative. New capture workloads assert actual returned values and allocation behavior; helper-signature checks separately prove that unused lexical bindings do not cross helper boundaries. No replacement handwritten Deferred workflow counts as generated conformance.

**HCOST-002 — Measure growth, not an ABI.** Measure the same emitted workload at several bounded lexical depths under None/Bounded and debug/release. Require a generous incremental growth budget relative to shallow fixtures, expressed using native pointer size. Exact byte values are recorded observations, not portable contracts. Inline owner storage remains legitimate and is not charged as an unnecessary helper capture.

**HCOST-003 — Distinguish used and unused bindings.** Include unused scalar bindings and unused outer owners around a genuinely used inner owner, plus a workload retaining several scalars in its terminal result. Preserve real captures, binder identity and owner channel types. The pruned helper boundary must not discard scalar values needed transitively by a descendant.

**HCOST-004 — Preserve the quiet allocation guarantee.** Meter the first and repeated actual generated invocations after executor/watch/context construction. Avoid timers, logs, runtime clock advance and groups in this interval. Require zero allocation calls in all four frame/build matrix cells. Native tests run sequentially to avoid memory contention.

## Validation planned

A focused generated workload suite will test unused capture removal, retained capture results, lexical-depth future growth and quiet zero-allocation behavior. Existing native ordering/cancellation conformance remains required after lowerer changes. Initial growth thresholds will be calibrated on both pre-change and optimized emitted code and retained only if they reject excessive capture growth with useful slack. Future representation and compiler-version drift may require adjusting the growth threshold; a failed gate requires investigation rather than suppressing measurements.

## Delivered validation and measurements

`vp test packages/reffect/tests/helper-capture-costs.test.ts --maxWorkers=1 --silent=false --reporter=verbose` passes 2/2 in 52.20s. Seven actual generated workloads execute 100 times each per matrix cell, including each workload's first execution. All 2,800 metered invocations allocate nothing. Returned values match the reference: unused bindings/owners yield 7, eight retained scalar bindings sum to 36, and an immediate masked Ensuring finalizer captures both an outer scalar and owner and completes it with 7 before the subsequent await. Executor/watch/context construction is outside the meter; there are no logs, timers, clock advancement or groups in these workloads.

Measured x86-64 Rust 1.98.1 layouts below are identical in debug/release. `None` contexts remain 24 bytes and `Bounded` contexts 32 bytes in this quiet module. Inline owner storage remains in each invocation; removing its unnecessary propagation does not remove the lexical owner itself.

| Workload                        | Before, None | After, None | Before, Bounded | After, Bounded |
| ------------------------------- | -----------: | ----------: | --------------: | -------------: |
| Unused scalar depth 1           |          920 |         888 |             960 |            928 |
| Unused scalar depth 4           |         1160 |         984 |            1248 |           1072 |
| Unused scalar depth 8           |         1592 |        1112 |            1744 |           1264 |
| Unused scalar depth 16          |         2840 |        1368 |            3120 |           1648 |
| Eight retained scalars          |         1592 |        1464 |            1744 |           1616 |
| Eight unused outer owners       |         2232 |        1752 |            2256 |           1776 |
| Captured scalar/owner finalizer |            — |         904 |               — |            936 |

**HCOST-005 — The growth gate has a failing witness.** Let `growth(d) = future_size(d) - future_size(1)` for unused scalar bindings. Require `growth(16) <= 2 * growth(8) + 32 * sizeof(usize)`. Necessary composition states remain linear; the pointer-scaled allowance tolerates the extra depth step and alignment. Optimized None passes with 480 <= 704; optimized Bounded passes with 720 <= 928. The prior lowerer fails with 1920 > 1600 for None and 2160 > 1824 for Bounded. A temporary baseline copy actually fails the tightened native None/debug assertion (12.29s), independently of the helper-signature refusal; temporary modules were removed. The complete pre-change measurement matrix ran separately in 32.24s, with the initially more permissive threshold, and all quiet allocations were already zero. This change reduces inline capture growth, rather than repairing an owner heap allocation.

The baseline also fails the signature test because unused scalar helpers retain two or more parameters. Optimized helpers retain no unused scalar parameters, at most the one used owner despite eight unused outer owners, and all eight scalars required by the terminal sum. Measurements and relative budgets complement these structural and semantic checks; no exact byte value in this table is a portable ABI assertion. The tighter budget's observed margin is 224 bytes under None and 208 bytes under Bounded; future compiler changes that alter state layout require investigating the growth rather than automatically updating expected sizes.
