# Metadata ownership, performance and opt-out design

[Research and measurements](research/metadata-and-editor-tooling.md) · [Source maps](source-maps.md) · [Observability](observability.md)

Source annotations cost TypeScript authoring/compiler memory and build work. They do not add fields, pointers, allocations, map lookups or instrumentation to generated Rust numbers. Keep that separation as logging and logical failure frames arrive. Full/None compiler artifact policy is now implemented; the broader capture/instrumentation/storage controls below remain design guidance.

## What the current implementation carries

| Place                            | Implemented storage and lifetime                                                                                   | Cost                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| TS type witnesses and operations | Shared immutable semantic objects; source sites belong to expression/function wrappers                             | Semantic descriptions already exist at authoring; no per-runtime-number source descriptor                                 |
| TS Expr/Fn/Computation/EffectFn  | One `source` reference; unannotated wrappers share frozen `emptySource`                                            | JS object slot on every wrapper; annotated copies allocate a wrapper and metadata objects                                 |
| SourceFile/SourceSite            | File text and cached line starts shared by sites; sites store offsets/name/file reference                          | Text lives while reachable through a program, artifact explanation or editor snapshot; it is not copied per number        |
| Compile/lower/emit               | Build-local node/occurrence indexes, origin/site tables, paths, Rust source chunks/ranges, digest buffers and JSON | Traversal, allocations, hashing and serialization even for unannotated programs                                           |
| Returned Artifact                | Rust strings, decoded map, serialized auxiliary files and explanation retaining the program                        | Several representations coexist; omitting source text from JSON does not remove the in-memory program's source references |
| Native library                   | Ordinary `u64`, `bool`, `Result` and helper functions                                                              | No source metadata in runtime values; no native provenance resolver or frames are emitted today                           |
| Map files on disk                | External `reffect.sources.json` and build manifest                                                                 | Build/package bytes; these JSON files are not linked into the executable                                                  |

An IR `Expr<u64>` describes code to compile; it is not the native `u64` produced by that code. Generated values can live in registers, stack slots or enclosing objects as Rust optimizes them. Existing CLI `String`/`Vec` allocations are separate from metadata. The reference interpreter runs JS/Effect and has its own allocation costs; native conclusions do not describe its throughput.

Unannotated wrappers share the empty metadata object. An annotation retains the existing semantic node/binder/body and replaces the wrapper; it does not clone the expression DAG or execute callbacks again. Currently the combinator and `withSource` both snapshot metadata, creating a redundant short-lived snapshot. That is a small candidate cleanup, not evidence for replacing the entire architecture.

The Boolean/u64 builder compiler supports `Compile.make(program).pipe(Compile.withSourceArtifacts(SourceArtifacts.None), Compile.run)`. None skips provenance/origin/use collection, UTF-8 range encoding, hashing and JSON; it honestly omits maps/auxiliary files rather than fabricating an empty map. Users can separately omit `Source.at/use/named`, avoiding their allocations and source capture. Returned semantic explanations still retain input graphs and their explicit annotations; callers must release artifacts/programs to make those graphs collectible. Default direct `Compile.run(program)` remains mapped.

## Measured current costs

Run `vp exec node --experimental-transform-types --expose-gc scripts/measure-source-metadata.mjs`. The probe alternates five isolated processes per variant, warms a tiny compilation, creates 128 functions with 16 additions each, then times construction and compilation. It now compares annotated/unannotated × Full/None policies. Annotated functions label their boundary and annotate every addition with one of 16 shared sites in one Unicode/CRLF snapshot. Literal values themselves are unannotated. Each child forces GC for retained-heap readings; the parent checks generated-source SHA-256 equality across all variants. This is a synthetic compiler probe, not a native execution benchmark or peak-memory measurement.

Historical mapped baseline on Node 24.19.0, linux/x64, before artifact-off implementation:

| Median                                        |   Unannotated |     Annotated |
| --------------------------------------------- | ------------: | ------------: |
| Builder time                                  |        8.7 ms |       10.8 ms |
| Full compiler time                            |        442 ms |        436 ms |
| Retained program heap above warmed baseline   |       622 KiB |       755 KiB |
| Retained program plus artifact above baseline |      5.84 MiB |      6.22 MiB |
| Generated Cargo/Rust bytes                    |       115,086 |       115,086 |
| Auxiliary JSON bytes                          |     2,462,421 |     2,569,876 |
| Origins / occurrences                         | 4,352 / 4,352 | 4,352 / 4,352 |

The generated sources were identical. Compiler timing differences are within this small noisy sample; they do not prove annotations improve compilation. Heap readings include runtime caches and exclude transient peak buffers, and this workload shares source sites heavily. No universal overhead percentage follows. The clearest finding is that baseline provenance serialization/retention is substantial relative to the small generated program, including when there are no authored sites. Prioritize skipping unrequested artifacts and compact build-local indexes before micro-optimizing the source reference.

### Full/None implementation measurement

Observed on Node 24.21.0, win32/x64, five isolated samples per variant (same workload; native checks were running concurrently, so timing remains noisy):

| Median                            | Full, unannotated | Full, annotated | None, unannotated | None, annotated |
| --------------------------------- | ----------------: | --------------: | ----------------: | --------------: |
| Compiler time                     |            341 ms |          360 ms |             78 ms |           83 ms |
| Retained program + artifact bytes |         6,130,320 |       6,529,112 |           973,896 |       1,096,200 |
| Auxiliary JSON bytes              |         2,462,421 |       2,569,876 |                 0 |               0 |
| Origins / occurrences             |     4,352 / 4,352 |   4,352 / 4,352 |             0 / 0 |           0 / 0 |
| Generated Cargo/Rust bytes        |           115,086 |         115,086 |           115,086 |         115,086 |

All twenty snapshots share identical origin-stripped SHA-256, and both Full snapshots (likewise both None snapshots per variant) are byte-identical. Failure-frame literals honestly embed origins under Full and omit them under None; value-level code is unchanged. The clear observed reduction is retained compiler/artifact storage and omitted serialization. This does not measure peak heap, native allocations/layout/throughput, or a universal latency ratio. Source-bearing programs remain retained through the semantic explanation in either policy; the current improvement removes artifact bookkeeping, not authoring ownership.

## Separate four ownership domains

Keep semantic values, static descriptions, execution context and exported records separate:

1. **Compiler provenance:** rich origin/use/definition/transform graphs and file revisions belong to compilation or an editor project. Their owner releases them at build/project disposal. Source maps live outside the native binary unless a packaging policy explicitly embeds a subset.
2. **Static native descriptors:** only when runtime diagnostics need them, generate dense `SiteId` constants and immutable static arrays/string literals. An external-map profile can emit build identity plus IDs without embedding paths/names/source text. No runtime hash table is needed to find a dense index.
3. **Dynamic execution context:** current scoped annotations, spans, logical calls and later fiber state belong to a lexical computation/request/task. They are not properties of a numeric value or its semantic type.
4. **Owned records:** only an emitted failure/log/export record acquires the bounded owned data it needs. Formatting and copying belong at the sink/queue boundary, with explicit budgets.

These boundaries permit ordinary native arithmetic to remain plain arithmetic. Source provenance does not require emitting an event or pushing a frame for every Expr.

## TypeScript side tables and WeakMap

A private `WeakMap<object, SourceMetadata>` keyed by immutable **authoring wrappers** is a viable implementation alternative. A `source` getter could return its entry or shared `emptySource`, preserving the public API and leaving unannotated wrappers without an own source slot. Annotation still creates a distinct wrapper to preserve use occurrences. Entries and metadata still allocate, and getters/hash lookups add work. WeakMap makes keys collectible; it does not make data free or release snapshots while the program/artifact still refers to those keys.

Do not key all metadata solely by the semantic node. Two immutable wrappers may share that node but supply different definition/use/name annotations. A mutable shared-node entry would contaminate other programs and overwrite occurrence information. Intern semantic origins by node during a build, then associate each occurrence separately. Snapshot associations into an enumerable, versioned build-owned table; WeakMap cannot be the serialization source of truth.

Prefer a module-private weak association or explicit project owner, never a process-wide strong Map keyed by IDs with no disposal. Keep deterministic serialized IDs build-local, rather than assigning process-global counters that depend on unrelated authoring. Multiple package instances/editor projects must not silently share mutable state. A future capture-suppression service must be synchronous/lexically scoped or otherwise concurrency-safe; a global mutable capture toggle is unsuitable for concurrent builders.

**Decision:** keep current direct references until a controlled comparison shows a worthwhile heap/latency tradeoff. First remove duplicate snapshots, introduce optional provenance/artifact work, and reduce redundant indexes/retention. Then benchmark direct references against wrapper-keyed weak associations and compact handles. The choice is an internal storage detail, not a TypeScript user requirement.

## Rust representation and failure context

Keep `u64` and `bool` unwrapped. A domain newtype such as a checked identifier can legitimately be `#[repr(transparent)] struct UserId(u64)`; its type distinction need not add a field. `PhantomData` supplies compile-time tagging, not a changing runtime call site. A wrapper containing both `u64` and `SiteId(u32)` carries real data and may add alignment padding. On a typical 64-bit target that shape can occupy 16 bytes rather than 8; verify target layout rather than promise an ABI universally. Arrays/cache traffic and copying would pay too.

Rust's `Weak` is a weak reference to an Rc/Arc allocation, not a GC association for integers. Adding identity/Arc/Box and a global map to every number would create the allocation, synchronization and lookup problem we want to avoid. A moving/copyable scalar also has no stable unique address; keying by numeric value merges unrelated occurrences. A runtime `static HashMap` still requires storage/initialization, unlike an immutable static slice.

Prefer compile-time constant site IDs at failure/log/span boundaries. For the first synchronous profile, statically known call edges can attach frames during error propagation without maintaining a success-path global stack. Shared helpers may need a compact hidden call-site argument or caller-side attachment to distinguish the executed occurrence; that is an instrumentation-profile decision and potential calling-convention cost, not a number field. Recursive/dynamic calls and async tasks need a separately verified context design.

Keep `Result<A,E>` and existing public payload/wire schemas compatible. An internal annotated failure may carry `E` plus a trail/handle, with adapters at public boundaries. **Failure-only allocation does not mean success-only cost is zero:** Rust Result reserves layout for its variants; putting a large inline frame array into the Err variant can enlarge every Result, including successful ones. Evaluate a compact handle or lazily allocated error capsule, bounds/truncation and ABI sizes against a request-owned diagnostic recorder. Do not attach metadata by error payload value; identical errors can be separate failures with different frames. Handles require a live owner until serialization and cannot refer to a dropped request arena.

Start bounded and explicit. Inline arrays or a small-vector candidate can avoid common-path heap allocation when useful, but large stack buffers enlarge frames, async futures and error values. Do not select a capacity without measuring the actual generated shapes. Error capsules may allocate only on failure; exporters and multiple sinks may still need ownership/copies. Logical-frame observations must match the supported Effect contract even when native backtraces/OTel sampling are absent.

[Facet](research/facet.md) provides a useful example of shared static type descriptions: SHAPE belongs to a Rust type, and a borrowed reflection view is separate from the value. It can serve later optional record/codec consumers, but its reflective builders can allocate and it does not replace executed SiteIds or dynamic context. The current compiler does not need Facet to emit plain numbers or external provenance.

## Logging annotations are different

Static source names/messages/attribute keys can be interned or emitted as string literals and static schemas. Dynamic request IDs and scoped annotation values are execution data. For synchronous lexical scopes, prefer borrowed context plus small typed deltas or save/restore fields; shadowing restores previous values. Static annotations can often become generated arguments/fields rather than repeated HashMap clones. For escaping/async/forked work, use owned task context or a persistent shared structure only where the selected Effect sharing semantics require it. Arc is useful there, but its heap and atomic costs must be justified. Thread-local state alone cannot model tasks migrating between threads or interleaving on one thread.

Filter before expensive formatting, optional backtrace capture and ownership conversion where semantics permit. A disabled sink cannot justify dropping effectful payload computations or custom-logger observations. `format_args!` can borrow values for immediate formatting; an async queue needs a safe owned/redacted record before those values go out of scope. Bounded queues, record/attribute limits and declared overflow/flush behavior are part of the design. Telemetry-off, unsampled traces and stripped source names are distinct policies.

The [authenticated RPC slice](research/rpc-auth.md) now follows this ownership model for synchronous calls: HTTP tasks own decoded bodies, dispatch borrows ID/tag through a stack context view, and the authenticated principal remains a plain u64. Immutable credentials allocate once in shared server state. Selected local logging prepares one context JSON string per invoked handler in a group with reachable logs; a lexical RAII guard restores it through nesting/unwinding. Groups without reachable logs skip that formatting and storage. There is still a per-log context lookup in logging builds, and JSON boundary/context allocations are not zero-overhead claims. Async poll/fork ownership remains unimplemented.

## Opt-out controls and defaults

Keep independent policy axes. The implemented CompileSpec exposes Full/None artifact collection; the broader names below remain descriptive design choices:

| Policy                             | Proposed choices                                                 | What turning it off means                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic authoring capture        | none / names / explicit-or-AST ranges / best-effort dev stacks   | Plugin/capture does no work; manually created annotations already allocated unless author omits them                                   |
| Compiler artifact retention        | none / names / external full ranges                              | Skip unrequested collection/ranges/hashing/JSON, not merely omit files after emission; none retains semantic diagnostic codes/IR paths |
| Original source packaging          | omit / private snapshots                                         | Runtime does not load source text; program/editor memory is governed separately                                                        |
| Runtime diagnostic instrumentation | none / bounded failures / selected detailed frames               | None emits no site arguments/frame operations/descriptors; failures preserve selected failure observations                             |
| Runtime signals and sinks          | selected local/tracing/log/metric/OTLP capabilities and policies | No providers/crates/queues for unreachable signals; observed application logging cannot be silently erased                             |

Keep the current default experience: explicit annotations, external ranges, source contents omitted and no native runtime instrumentation. Add opt-outs without changing outcomes, wire schemas or plugin-free authoring. Artifact types must honestly represent absence/precision instead of fabricating an empty full-quality map. Diagnose incompatibilities if a requested observer requires stripped information. Include policy/schema/version and selected runtime representation in cache keys/manifest/explain output.

Before the next frame/logging implementation, preserve these policy contracts and verify that no-instrumentation native sources stay identical with annotations on/off. The artifact-off path now has fault-injection tests for omitted work, reduced diagnostics, native parity and missing-map fallback. Names-only projection, source-bundle formats and metadata-storage replacement can follow consumers and measurements rather than blocking basic logging.

## Performance acceptance

Measure authoring, check/lower/emit/hash/serialization, retained and peak heap, map/binary bytes, native allocations, throughput and latency separately. Compare ordinary success, frequent failure, local logs, disabled sinks and enabled exporters in release builds; use debug for diagnosis. Test deep/shared graphs and repeated editor rebuild/disposal, not only small leaf nodes. Add complexity limits independent of performance goals.

For no-instrumentation native code, require identical emitted value layouts and no metadata-derived calls/maps/allocations; the current probe checks generated-source identity. For failure instrumentation, measure Result/future/frame sizes and common success-path changes. For enabled context/export, report costs and chosen bounds rather than advertise zero overhead. Source-map generation never justifies disabling optimizations globally; existing helper sharing and future instrumentation boundaries need separate evidence.
