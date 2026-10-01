# Source-artifact opt-out preparation — 2026-10-01

## Evidence and prior decisions

- Reviewed [metadata ownership/costs](../metadata-cost.md), [source-map contracts](../source-maps.md), the current compiler/lower/provenance/source-writer/SourceMaps implementations, and NativeRunner's function-identity contract. The current pipeline collects provenance, UTF-8 ranges, hashes and JSON on every build, even without explicit annotations.
- Installed Effect RC.118 Pipeable.Class and public compiler Effect stages support immutable per-request specifications. Reuse these instead of a mutable global metadata toggle or a second compile entry point.
- [Node TextEncoder](https://nodejs.org/api/util.html#class-utiltextencoder) / [Encoding standard](https://encoding.spec.whatwg.org/#dom-textencoder-encode) define encode as producing UTF-8 Uint8Array data. The existing writer invokes it for every chunk; an unmapped writer must avoid that work, not collect then discard ranges. No new dependency is needed.
- [Node memoryUsage](https://nodejs.org/api/process.html#processmemoryusage) and the existing isolated-process GC probe measure retained heap, not native layout or a guarantee about transient peak allocation. Preserve that distinction in evidence.

## Chosen API and boundaries

Introduce typed singleton Full/None artifact policies and a complete, immutable, pipeable CompileSpec with program, target and policy. `Compile.make(program).pipe(Compile.withSourceArtifacts(SourceArtifacts.None), Compile.run)` selects the opt-out; existing `Compile.run(program, target)` keeps its mapped default and inferred mapped artifact type. Focused combinators rebuild specs without object spreading. No casts are required by callers or tests.

Full artifacts retain today's SourceMap/auxiliary-file contract. None artifacts honestly omit source maps and auxiliary files and carry their typed policy; do not substitute an empty high-precision map. NativeRunner accepts either artifact because the verified semantic Plan and function identities remain unchanged. The explanation still retains the authored program: callers must release their program/artifact to release explicit annotation text. Artifact-off does not pretend to undo manually allocated authoring capture.

Lowering in None mode skips Provenance construction, origin/use indexing and metadata copies. Emission retains identical Rust chunks and helper boundaries but skips byte-range tracking/TextEncoder work. Compiler emission bypasses SourceMaps.create entirely, including source/generated hashing and JSON serialization. No runtime fields, descriptor arrays, frame operations, ABI changes or dependency changes result. Full mapping remains the default.

None-mode compile errors retain semantic codes, stages and IR paths but skip source-location enrichment/provenance construction. Native errors use existing missing-map fallback, preserving raw rustc diagnostics. Capture, packaging and future runtime instrumentation remain separate policies; this feature introduces only artifact collection/retention policy. A policy-specific spec/explanation prevents cache consumers from treating Full and None artifact requests as interchangeable; no compiler cache is implemented yet.

Alternatives: deleting JSON after emission fails the work/retention requirement; a global switch breaks concurrent requests; WeakMap/WeakRef storage redesign is premature and would complicate current semantic identity/NativeRunner checks. Keep direct references, measure the reduced artifact footprint, and leave names-only projection/capture suppression/runtime frames for their consumers.

## Acceptance

- Default calls keep current static types and source-map behavior; None policy/spec pipelines infer absent maps without casts. Specs and policies are immutable and unsupported policy objects are refused.
- Assert identical generated Cargo/Rust for Full/None on annotated pure and Effect IR, including shared helpers/branches, and native/reference parity in debug/release.
- Use meaningful spies/fault injection to prove None never calls Provenance, SourceMaps.create/hashing/serialization or range-byte encoding; omitting files alone is insufficient.
- None lower results contain no provenance/ranges and None artifact has no map/auxiliary files. Native mapped failure tests retain Full behavior; None failure diagnostics preserve raw information and explicitly missing mappings.
- Verify concurrent differing policies do not contaminate each other, error diagnostics preserve their semantic obligation, and callback counts/semantic node identity remain unchanged.
- Extend the existing isolated-process probe with Full/None variants and report retained compiler heap/artifact bytes and unchanged generated identity. Do not claim native performance or peak-memory improvements from that probe.
- Run task-scoped vp check, strict TypeScript, tests, native builds and workspace builds; record exact results and remaining limits in PROGRESS.md.

## Implementation and measured evidence

Implemented Full/None singletons, pipeable CompileSpec factories/combinators, typed mapped/unmapped artifacts and lower results. Default calls keep mapped inference; None skips source error enrichment, Provenance construction, origin/use metadata, range encoding and SourceMaps.create. The semantic Plan still owns the original program, as explicitly specified above.

Six policy tests pass: Full/None generated-source equality and concurrent isolation; fault injection into provenance, SHA-256, JSON and TextEncoder paths; unmapped writer text/range behavior; policy-lookalike refusal; reduced semantic diagnostics; and fresh native debug/release scalar/Result parity plus real rustc missing-map fallback. Full suite passes 44 tests; strict TypeScript includes pipeline/default build artifact inference and invalid string-policy contracts. Scoped checking/builds pass.

The extended five-sample, four-variant probe on Node 24.21.0 win32/x64 reports identical 115,086 generated bytes/SHA-256 for all twenty processes. Retained program+artifact medians drop from 6,130,320 to 973,896 bytes (unannotated) and 6,529,112 to 1,096,200 (annotated), with zero auxiliary bytes/origins/occurrences in None. Median compile times were 341/360 ms Full versus 78/83 ms None; concurrent native testing and runtime noise mean these are observations, not a universal speedup or peak-memory claim. Raw methodology/limitations remain in [metadata costs](../metadata-cost.md#fullnone-implementation-measurement).
