# Bounded runtime Clock and Random implementation

Prepared 2026-10-03 against installed **Effect 4.0.0 stable**, before feature changes. This narrows the earlier [Clock/Random preparation](clock-random-modules.md) to an executable sequential service slice, without changing PLAN.md. Ownership: core agent edits checked IR/compiler/reference/authoring; backend agent edits native lowering/runtime contexts; test agent supplies independent conformance fixtures; parent owns public exports/integration.

## Stable primary-source verification

Checked published [Clock](https://unpkg.com/effect@4.0.0/src/Clock.ts), [Random](https://unpkg.com/effect@4.0.0/src/Random.ts), and [internal clock](https://unpkg.com/effect@4.0.0/src/internal/effect.ts). Stable `Clock.currentTimeMillis` is a service effect returning Number; default unsafe millis uses Date.now. Clock also supplies Sleep, unsafe observer reads and nanos, but this patch does not implement virtual time/nanos. Stable `Random.next` delegates to `nextDoubleUnsafe`; `nextBoolean` consumes one double and tests **strictly greater than 0.5**. Both operations are synchronous reads of service state, not pure expressions or intrinsically async operations.

Existing checked computation/reference/lowering infrastructure, [plain-value metadata contracts](../metadata-cost.md) and the [separate implementation registry requirement](../runtime-lowering.md) apply. Native scalar results remain existing Number/f64 and Bool/bool. No seed, ISAAC port, random ranges, Crypto, live Random backend, nanosecond witness or ordinary dynamic Context service enters this profile.

## Agreed API and implementation selection

Authoring constants are `R.Clock.currentTimeMillis: Computation<number, never>`, `R.Random.next: Computation<number, never>` and `R.Random.nextBoolean: Computation<boolean, never>`. Each execution performs a read/draw. Boolean maps the checked RandomDraw through the existing strict Number comparison, preserving one draw and `0.5 -> false`.

A checked compile request chooses service implementations separately from primitive operations:

```ts
Compile.make(program).pipe(
  Compile.withRuntimeServices({
    clock: "InjectedMillis",
    random: "ScriptedRandom",
  }),
  Compile.run,
);
```

`RuntimeServicesSelection` permits optional clock `LiveMillis | InjectedMillis` and optional random `ScriptedRandom`; absence of clock resolves to LiveMillis. Reachable Random without explicit ScriptedRandom refuses planning with a structured unsupported-service diagnostic. Script buffers are runtime-owned injection, never contract fields, generated program scalar metadata or embedded build-time draws. Plans preserve normalized selection through their with-combinators and recompute/verify selected service adapters and capabilities. Unreachable configured services add no native fields/dependencies.

The backend receives the selection in `lowerFunctions` as a fifth optional argument. Generated live millis reads use a direct checked std helper and add no context for otherwise synchronous programs. Injection adds only reachable owned Clock/Random fields: synchronous service functions receive an owned SyncContext borrow, asynchronous service functions receive their existing owned AsyncContext with service fields. Artifacts without reachable injected services retain their signatures and context layout. Within an artifact that shares AsyncContext, enabled service fields can enlarge unrelated async futures; per-function context specialization remains deferred pending measurements. No TLS/global driver or per-read boxed trait is admitted.

Injected Clock offers stable/scripted setters and defaults to LiveMillis until explicitly injected. Scripted Random starts empty and must receive values through an owned setter before useful execution. Setting a script validates its contract; successive reads advance its cursor, and finalization/recovery never reset it. Reusing a context continues consumption; constructing a fresh context establishes another service instance. Seeded Effect identity remains deferred.

## Contracts and acceptance boundaries

- Clock millis admission is a finite signed safe integer: backward/negative wall times are valid; fractional/nonfinite/out-of-range script readings are internal driver faults. Reference delegates to official Clock and validates this bounded contract after the read. Live std epoch conversion checks signed range before f64 conversion and treats unavailable/out-of-range platform time as an internal fault.
- Random draws must be finite doubles in `[0,1)`; reference delegates to official Random, then validates the same contract. No values are pre-drawn, duplicated or reordered. Unused branches consume nothing; repeated IR nodes execute anew.
- Compiler planning recognizes reachable Clock and Random requirement identities with dedicated service implementation adapters. Primitive operation selection remains separate; successful planning cannot silently choose Math.random or another native generator.
- Invalid/exhausted test drivers are **fatal internal harness faults**, bypassing typed catch/recovery. This bounded patch does not claim full Effect Cause/defect-finalization compatibility for corrupt/exhausted harnesses: a native panic cannot await async Scope cleanup. Valid admitted scripts still require cancellation/finalizer ordering conformance. Broader defect propagation/awaited cleanup is an explicit later Cause/runtime gate, not a concealed guarantee.
- Observer logging/tracing clock reads remain outside the authored scripted-read sequence in this slice. Reference test clocks provide complete Clock services, using a separate stable unsafe observer reading and inherited real Sleep. Scripted timestamp reads are not virtual-time timers, and observer timing/export semantics retain their own observability specification.

## Decisions before implementation

| ID      | Chosen behavior and cost consequences                                                                                                                                                                                                                | Revisit trigger                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| RTS-001 | New ClockReadMillis/RandomDraw computation nodes and reachable requirement identities; Boolean uses one existing checked map/comparison. Immutable IR contains no mutable driver/cursor.                                                             | Optimizations reorder/deduplicate reads or broaden random mappings.                                          |
| RTS-002 | Checked CompileSpec selection, separate service adapters, preserved Plan configuration and verification. Live clock default; Random requires explicit scripted backend. No Cargo dependency added by this slice.                                     | Live Random, registry plug-ins, host-provided long-lived instances or stable serialized build configuration. |
| RTS-003 | Direct no-context live clock; injection state exists only in reachable owned SyncContext/AsyncContext. Vec scripts allocate during harness setup; empty context initialization should not allocate. Results carry no service pointer/tag/provenance. | New task/service sharing or unnecessary enabled fields leak into disabled artifacts.                         |
| RTS-004 | Validate millis safe integers and Random `[0,1)`; harness contract violations are internal faults that bypass domain recovery. Full defect cleanup/Cause semantics remain outside this slice and are documented explicitly.                          | General Defect/Exit/Cause profile or a production driver capable of recoverable runtime faults.              |
| RTS-005 | Authored script reads are separate from unsafe observer time; real Sleep remains inherited. Stable observer clocks make logging fixtures meaningful without silently consuming scripted readings.                                                    | Shared instrumentation clock, virtual timers/TestClock, monotonic or wall-nanos adapter.                     |

Acceptance: typed public APIs without casts; unsupported/malformed selections diagnosed; official/reference/native draw bits, threshold boundaries and read order; negative/backward millis; unused branches/retry/cleanup consumption; sync/async invocation ownership; fatal exhaustion/invalid draw bypass recovery; policy/source mapping compatibility; no-service signature/context/dependency baseline; enabled native layout and allocation evidence. Family modules remain proposed until this complete slice passes integrated validation.

## Integration review finding

New framed `Random.nextBoolean` fixtures exposed an existing framed Map evaluator error: it bound the source result in a nested environment but evaluated its pure body against the outer environment. The plain interpreter already used the nested environment. This patch supplies that environment explicitly to the framed expression evaluator; controlled mapped-draw fixtures verify success values under both interpreters. This is a semantic regression fix, not a new Random representation or permission to drop frame checks.
