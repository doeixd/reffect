# Fallible task-group checked IR and reference preparation

Recorded 2026-10-03 against installed Effect 4.0.0 and published stable [internal Effect](https://unpkg.com/effect@4.0.0/src/internal/effect.ts), checked online before implementation. This supplements [structured concurrency](structured-concurrency.md), [Exit/Cause](exit-cause.md) and the shared fallible-runtime design. PLAN.md remains owned by the other instance.

## Prior behavior and bounded admission

TaskGroup currently carries two/three Unit/Never children and delegates its plain reference to official Effect.all/race. The checker prevents child capture of outer Ref/file regions and analysis refuses nesting, cleanup task creation and mutable provider/host capture. Preserve those ownership rules. The current upstream stream nodes include StreamRunCollect and StreamEmit; analysis must retain their cleanup traversal.

Proposed extension: Unit/Never success children, scalar Bool/U64/Unit error witnesses with Never ignored, and one common non-Never error witness across all children. The group returns Unit with that inferred error channel. Fixed arity, exact options and child-local Scope remain unchanged. Joining different non-Never witnesses is refused, as existing joinType requires an explicit union representation.

The fixed-capacity runtime proof depends on no nested groups, no authored failCause and infallible finalizers: each child can expose at most one Fail or interruption, and there is at most one parent interruption. Three children therefore need at most four retained reasons. This proof is a runtime boundary, not a reason to replace explicit pure Cause arrays with bounded storage.

## Reference obligations

**FC-001 — Frame attachment preserves reasons.** Effect 4.0.0 mapError is implemented as typed catch followed by a singleton failure. Using it to attach diagnostic frames changes multiple/mixed Causes. Replace the framed interpreter's internal mapping with catchCause/failCause and Cause.map; keep public typed recovery semantics unchanged. Independent public-API probes confirmed mapError reduces [Interrupt(42),Fail(1),Fail(2)] to [Fail(2)], while Cause.map preserves [Interrupt(42),Fail(2),Fail(3)].

**FC-002 — Diagnostic wrappers do not change error equality.** All combines failure causes with upstream reason equality and deduplication; Race retains failures in completion order without deduplication. FramedFailure objects must implement Effect Equal/Hash by their domain error, ignoring frame fields, so wrapping Bool/U64/Unit failures preserves All's deduplication. Upstream FailReason still compares its annotation map separately; Cause.map retains annotations. Plain reference continues using unwrapped domain errors.

**FC-003 — Exit and frames are separate observations.** The framed reference's final observer must preserve every reason and order in Exit, while choosing the first typed failure's trail for the existing single sidecar. Internal CompileError reasons remain compiler failures. The sidecar is not a per-reason distributed stack or an authored Cause field. Interruption-only observation yields no typed failure trail.

## Resolved representation gate

Pending parent interruption can bypass typed recovery while retaining the original Fail in a mixed Cause, even when a handler changes its declared E. A generic native carrier parameterized by the resulting E cannot retain that old error. **FC-004 — Preserve old scalar errors across channel changes.** Root/design review selected a nongeneric finite RuntimeFailure tagged payload (Bool/U64/Unit) inside the reached-only Combined carrier. This retains the old error even when interruption bypasses a CatchAll that declares another E or Never. Do not restrict destination E merely to solve representation; typed extraction checks the expected witness when a handler actually runs. Changing the result silently to interruption alone is invalid. The fixed bound and this representation were agreed before feature edits.

**FC-005 — Composite recovery retention is refused.** A CatchAll that changes E after a source reaching a fallible group is refused when that source already exposes a non-scalar error witness. Pending interruption can retain that composite singleton failure across the channel change; the finite scalar carrier cannot store it. Destination composite E remains allowed when the source E is scalar. Legacy recovery without reachable fallible groups is unchanged. Reverse computation edges establish reachability even through shared nodes, without recursively rerunning checker analysis.

**FC-006 — Concurrent stream host emission is refused.** StreamEmit inside a child is a TASK_GROUP_HOST refusal until sink identity, interleaving and disconnect behavior have independent task/stream conformance. Its finalizers remain traversed for cleanup admission. Local Stream.runCollect is unaffected.

## Validation

Require type inference without user casts for Never/fallible tuples and both Race forms; checker refusal for mixed witnesses, non-Unit values and malformed raw nodes; independent official/reference/native comparisons for All failure admission, same-error dedup, different-error ordering, Race duplicate retention, masking/cancellation and awaited cleanup. Existing Unit/Never costs must remain unchanged. Framed parity must check Cause reasons as well as first trail.
