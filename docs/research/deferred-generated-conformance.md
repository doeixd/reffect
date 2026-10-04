# Generated Deferred conformance

Prepared 2026-10-04 before test edits. Reviewed AGENTS, PLAN, PROGRESS, DGEN-001–005, existing retained-outcome conformance and the real-context coordinator fixture. Checked published [Effect 4.0.0 Deferred](https://unpkg.com/effect@4.0.0/src/Deferred.ts) against installed semantics; make/isDone are synchronous, succeed resumes registrations, and a losing completion retains the first result.

**DGC-001 — Exercise generated helpers.** Call the private checked lowerDeferredFunctions entry and normal emitFunctions; write their actual emitted files into a temporary Cargo package. The Rust harness controls only polling/cancellation and observes generated functions. It must not construct a replacement owner or handwritten waiter workflow.

**DGC-002 — Independent semantic oracles.** Author official Effect programs separately from R graphs. Compare official, plain/framed reference and generated traces. Registration follows deterministic All input polling, never a timer delay chosen to hope registration happened. A real waiter timer distinguishes its synchronous prefix from its continuation.

**DGC-003 — Cancellation has a completion witness.** Poll the complete generated root once to establish pending waiters, send its real AsyncContext watch cancellation and await the root. Every child has an awaited timer finalizer; return before cleanup completion must fail the trace assertion. Match official controlled-clock interruption with the same root boundary.

**DGC-004 — Separate costs from semantic evidence.** Report generated invocation future and AsyncContext layouts. Allocations attributable to Tokio logging/timers/watch channels are not isolated Deferred allocations; this suite does not turn the earlier isolated owner zero-allocation result into a whole-invocation claim. Debug/release and None/Bounded policies are required. Public Compile.plan remains refused; no scheduler-default assertion becomes public admission.

Validation planned: retained first/losing/late completion, Bool/Unit owner channels, registration order, true timer suspension, parent cancellation and awaited child finalizers. Nested groups, Race, independent waiter cancellation and richer causes remain outside this profile.

## Validation

The independent fixture comparison passes 1/1 before native execution. The complete suite then passes 2/2 in 37.80s: five actual generated functions compiled in debug/release for both None/Bounded frame policies. All semantic observations match official and plain/framed reference, including registration-ordered prefixes, a genuine waiter timer, retained scalar outcomes, losing completion and parent interruption that awaits both timer finalizers. Bounded interruption has recorded frames; None has none.

The harness meters allocation calls only while polling the invocation, after watch/context creation. Its counts include generated logging, timer/executor activity and cancellation processing; they are observations of the whole harnessed invocation, not allocations attributed exclusively to Deferred. It also reports concrete invocation-future/context sizes for every matrix cell. A separate quiet sequential regression meters 100 actual generated Bool-owner invocations, including their first execution, after Tokio/watch/context construction. It performs no logging, clock advance, timers or task groups during the measured interval and requires zero allocation calls in both frame/build profiles. The pre-existing isolated owner zero-allocation evidence remains separate; exact future layouts below are observations, not portable layout assertions.

## Concrete native costs

On the measured x86-64 Rust 1.98.1 / Tokio 1.53.1 profile, debug and release report identical sizes and allocation-call counts. These are actual generated invocation futures, rather than isolated owner structs.

This table records the initial integration baseline before [helper capture minimization](helper-captures.md). Current depth-growth budgets and measurements are recorded in [helper capture costs](helper-capture-costs.md); neither table defines a portable future ABI.

| Workload                         | Future bytes, None | Future bytes, Bounded | Harnessed allocation calls, None | Harnessed allocation calls, Bounded |
| -------------------------------- | -----------------: | --------------------: | -------------------------------: | ----------------------------------: |
| Retained first/losing/late U64   |                856 |                   872 |                                5 |                                   5 |
| Sequential Bool                  |                848 |                   872 |                                1 |                                   1 |
| Sequential Unit                  |                848 |                   872 |                                1 |                                   1 |
| All3 registration and timer      |               9136 |                  9200 |                               12 |                                  12 |
| All2 cancellation and finalizers |               8456 |                  8608 |                               15 |                                  18 |

The full fixture module selects logging, so AsyncContext is 96 bytes under None and 104 bytes under Bounded; this is not the primitive coordinator-only 24-byte context profile. Full drive observations include clock advance and runtime work, explaining why the Bool/Unit harness observations are one allocation while the separate quiet 100-invocation regression records zero. Bounded cancellation records failure frames and allocates three additional times in this workload; successful quiet invocations record no frames and remain allocation-free. Approximately 9KB inline group futures are a concrete optimization concern before wider task arities/nesting, although they do not allocate a task registry or owner heap.

The strengthened suite, including the first-execution quiet allocation regression, passes 2/2 in 43.38s with `vp test packages/reffect/tests/deferred-generated-conformance.test.ts --maxWorkers=1 --silent=false --reporter=verbose`; scoped formatting/lint/types also pass.

Root merged validation, after pruning unused driver families, passes 24/24 across eight suites (167.22s), including retained-outcome native conformance and public/host refusals. Post-commit generated/profile/runtime, prior coordinator, public refusal and emission validation passes 18/18 across six suites (73.30s). Synced serving/source integration passes 3/3. Exact interrupted frame-trail equivalence and executable default-context enforcement remain public admission gates.
