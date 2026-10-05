# Metadata ownership, performance and opt-out design

[Research and measurements](research/metadata-and-editor-tooling.md) · [Source maps](source-maps.md) · [Observability](observability.md)

Source annotations cost TypeScript authoring/compiler memory and build work. They do not add fields, pointers, allocations, map lookups or instrumentation to generated Rust numbers. Full/None source artifact policy and independent Bounded/None failure frame capture are implemented. Authored logging remains independent; automatic capture and broader signal/export controls below remain design guidance.

## What the current implementation carries

| Place                            | Implemented storage and lifetime                                                                                   | Cost                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| TS type witnesses and operations | Shared immutable semantic objects; source sites belong to expression/function wrappers                             | Semantic descriptions already exist at authoring; no per-runtime-number source descriptor                                                 |
| TS Expr/Fn/Computation/EffectFn  | One `source` reference; unannotated wrappers share frozen `emptySource`                                            | JS object slot on every wrapper; annotated copies allocate a wrapper and metadata objects                                                 |
| SourceFile/SourceSite            | File text and cached line starts shared by sites; sites store offsets/name/file reference                          | Text lives while reachable through a program, artifact explanation or editor snapshot; it is not copied per number                        |
| Compile/lower/emit               | Build-local node/occurrence indexes, origin/site tables, paths, Rust source chunks/ranges, digest buffers and JSON | Full collects provenance/ranges/hashes/JSON even for unannotated programs; None skips that bookkeeping                                    |
| Returned Artifact                | Rust strings, optional map/auxiliary files, selected frame policy and explanation retaining the program            | Several representations coexist; omitting source text from JSON does not remove the in-memory program's source references                 |
| Native library                   | Ordinary `u64`, `bool`, `Result` and helper functions                                                              | Scalars remain plain; optional boxed bounded failure trails, static frame descriptors and scoped log context are separate runtime storage |
| Map files on disk                | External `reffect.sources.json` and build manifest                                                                 | Build/package bytes; these JSON files are not linked into the executable                                                                  |

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

### Native failure-frame costs

The scalar compiler now offers `Compile.withFailureFrames(FailureFrames.None)`
and `NativeRpc.compile(..., { failureFrames: FailureFrames.None })` independently
of Full/None source artifacts. Default Bounded capture uses a Box<FrameTrail>
with 32 static string references, length and omitted count. Error propagation
never grows an intermediate vector. Reference capture obeys the same bound;
innermost-first ordering and payloads stay unchanged. Frame-off native code
contains no frame descriptors, stash, propagation or envelope. Authored logging,
annotations and span timers remain enabled whenever authored/reachable.

The [reproducible native probe](../packages/reffect/scripts/frame-cost.ts) measures
actual generated u64/u64 helper Result layout, representative Boolean/Unit/Never
layouts, allocations/bytes and five release timing samples. Run from the root:

```sh
. "$HOME/.cargo/env"
vp exec node --experimental-transform-types packages/reffect/scripts/frame-cost.ts
```

Observed on **rustc 1.98.1, LLVM 22.1.8, x86_64-unknown-linux-gnu**:

| Shape                                   | Frames stripped |         Bounded capture |
| --------------------------------------- | --------------: | ----------------------: |
| Native u64                              |         8 bytes |                 8 bytes |
| Generated Result<u64,u64> helper        |        16 bytes |                16 bytes |
| Representative Result<bool,bool> helper |         2 bytes |                16 bytes |
| Representative Result<Unit,Unit> helper |          1 byte |                 8 bytes |
| Representative Result<u64,Never> helper |         8 bytes |                16 bytes |
| Diagnostic allocations on success       |               0 |                       0 |
| Diagnostic allocations per failure      |               0 | 1 allocation, 528 bytes |

The former Result<u64,(u64,Vec<&str>)> layout measures 32 bytes; putting the
bounded array inline in that Err representation measures 536 bytes. The boxed
capsule therefore improves this generated helper's layout while avoiding an
array inside each Result. These sizes are target/compiler observations, not ABI
promises. Infallibility alone did not erase the annotated representation in the
representative layout probe; future specialization should be driven by evidence.

The deep workload chooses either immediate success or failure through 128 Map
boundaries. Its failure retains exactly 32 frames and reports 99 omitted
boundaries (131 total including Fail, Match and function). No diagnostic
allocation occurs on success in either debug or release; failure uses one
capsule without reallocations, independent of depth. Observation through
`take_last_frames` converts to Vec and may allocate separately; RPC uses
`clear_last_frames` to drop without conversion. A second take returns empty/zero,
including the omitted count. The stash retains at most one prior failure; when
a new failure is constructed before replacing it, two capsules can briefly
coexist (1,056 bytes of capsule storage on this target). Releasing/draining the
stash releases its owner; public successful calls do not access or clear it.

Timing samples are recorded in the [research](research/failure-frames.md#construction-bounds-and-frame-policy-preparation--2026-10-01).
They exclude CLI parsing, JSON/envelope serialization, observation and authored
logs; allocator counters and black_box are included. Constant payloads and
metadata stripping allow Rust to simplify this workload, and a shared cloud
executor adds scheduling noise. The observations establish bounds and show
nonzero diagnostic overhead; they are not a general throughput claim.

Source path literals still contribute static executable bytes and can grow
roughly quadratically with deep nesting. This slice bounds trail entries and
allocations, not emitted descriptor bytes or execution call-stack depth. Source
artifacts and Plan explanations still retain their authored graphs as described
above. The frame selection is recorded in immutable requests/plans/artifacts;
existing source manifests bind emitted byte digests, and there is no persisted
compile-cache policy API yet. Async task/future layout, retained dynamic context,
export queues and sink policy remain separately costed follow-ups.

## Full/None implementation measurement

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

Keep independent policy axes. CompileSpec implements Full/None source artifacts and FailureFrames.Bounded/None. The remaining choices below are design guidance:

| Policy                             | Choices                                                          | What turning it off means                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic authoring capture        | none / names / explicit-or-AST ranges / best-effort dev stacks   | Plugin/capture does no work; manually created annotations already allocated unless author omits them                                   |
| Compiler artifact retention        | none / names / external full ranges                              | Skip unrequested collection/ranges/hashing/JSON, not merely omit files after emission; none retains semantic diagnostic codes/IR paths |
| Original source packaging          | omit / private snapshots                                         | Runtime does not load source text; program/editor memory is governed separately                                                        |
| Runtime diagnostic instrumentation | Bounded / None (implemented); detailed frames (planned)          | None emits no site arguments/frame operations/descriptors; failures preserve selected failure observations                             |
| Runtime signals and sinks          | selected local/tracing/log/metric/OTLP capabilities and policies | No providers/crates/queues for unreachable signals; observed application logging cannot be silently erased                             |

The current default uses explicit annotations, external ranges, omitted source contents and bounded failure capture. Frame capture can be stripped at compilation; authored local logging and annotation/span behavior stay enabled. Add opt-outs without changing outcomes, wire schemas or plugin-free authoring. Artifact types must honestly represent absence/precision instead of fabricating an empty full-quality map. Diagnose incompatibilities if a requested observer requires stripped information. Include policy/schema/version and selected runtime representation in cache keys/manifest/explain output.

Frame-off code uses plain Result helpers and emits no frame descriptors, propagation, stash or envelope; Full/None source artifact selection produces identical frame-off Rust files. The artifact-off path now has fault-injection tests for omitted work, reduced diagnostics, native parity and missing-map fallback. Names-only projection, source-bundle formats and metadata-storage replacement can follow consumers and measurements rather than blocking basic logging.

## Performance acceptance

Measure authoring, check/lower/emit/hash/serialization, retained and peak heap, map/binary bytes, native allocations, throughput and latency separately. Compare ordinary success, frequent failure, local logs, disabled sinks and enabled exporters in release builds; use debug for diagnosis. Test deep/shared graphs and repeated editor rebuild/disposal, not only small leaf nodes. Add complexity limits independent of performance goals.

For no-instrumentation native code, require identical emitted value layouts and no metadata-derived calls/maps/allocations; the current probe checks generated-source identity. For failure instrumentation, measure Result/future/frame sizes and common success-path changes. For enabled context/export, report costs and chosen bounds rather than advertise zero overhead. Source-map generation never justifies disabling optimizations globally; existing helper sharing and future instrumentation boundaries need separate evidence.

## Async context and future costs

The bounded Tokio profile keeps execution state in an explicit AsyncContext,
not in native numbers or a global value registry. Scalars remain bool/u64/Unit.
Without log scopes the context owns a watch receiver, mask flag and optional
failure handle. Reachable log scopes add two Vec handles and optional request
String. Frame None removes the handle, FrameTrail and propagation. Async-only
modules omit the synchronous failure TLS stash; mixed groups retain it for
synchronous handlers. No TLS guard is held across an await.

[Reproducible release probe](../packages/reffect/scripts/async-cost.ts) and
[raw results](research/async-cost-results.json), Rust 1.98.1/x86-64, Tokio 1.53.1:

| Profile                    | Context bytes | Delay future bytes | Shared depth 4 / 8 future bytes | Scoped future bytes |
| -------------------------- | ------------: | -----------------: | ------------------------------: | ------------------: |
| Bare, bounded frames       |            32 |                304 |                       368 / 432 |                   — |
| Bare, frame None           |            24 |                296 |                       360 / 424 |                   — |
| Log scopes, bounded frames |           104 |                304 |                       368 / 432 |                 400 |
| Log scopes, frame None     |            96 |                296 |                       360 / 424 |                 392 |

Creating the cancellation watch channel allocated once. Constructing each
context and these unpolled concrete futures allocated zero additional times.
The shared branch probes emit one helper per shared node (15 across three
functions); future size grew 16 bytes per tested Match boundary, without
exponential expansion in this corpus. This is a compiler/workload observation,
not a stable Rust ABI or a universal future-size bound. Log scope fields are
selected per generated module; a non-logging function in a module with scoped
logging uses that module's larger context. There is no per-helper future boxing.

Polling a timer, logging, annotation Vec growth/cloning, request JSON, Tokio
worker/channel state and HTTP/Serde inputs have separate costs. The construction
probe deliberately excludes those allocations and does not establish throughput,
RSS or complete request allocation counts. Nested annotation snapshots can own
heap storage across suspension; they belong to explicitly authored execution
scopes, never every scalar. Each HTTP batch owns a worker and cancellation
channel; each invocation owns its request/log state and failure storage. Existing
failure-trail bounds still apply. Future HTTP measurements should include detached
cleanup workers and concurrency rather than treating the library future as the
whole request.

Run `vp exec node --experimental-transform-types packages/reffect/scripts/async-cost.ts`
with Rust on PATH to reproduce. General performance evidence/gates are described
in [performance requirements](performance.md).

The private generated Deferred profile now [prunes helper captures](research/helper-captures.md) before emission. [Its depth-growth probe](research/helper-capture-costs.md) preserves required scalar/owner/finalizer borrows while rejecting quadratic propagation of unused scalar arguments. On the measured Rust 1.98.1/x86-64 profile, depth-16 futures shrink from 2840 to 1368 bytes with frames disabled and from 3120 to 1648 with bounded frames. All 2800 quiet generated invocations allocate zero times after executor/watch/context construction, including each workload's first execution. These observations do not measure timers, logging, groups or complete requests. Context layout is unchanged; compiler-side subtree capture analysis has a separately recorded quadratic worst case within the private graph bound.

## Resource, recovery and static service costs

[Private nested Deferred Race](research/deferred-nested-conformance.md) now has generated ordering/cancellation evidence under both frame/build policies. Its logging/timer workloads select the existing 96/104-byte context and initially measured roughly 33–44KB inline invocation futures; whole-drive allocation observations include channels, logs, timers and executor work. The owner/bank remain inline and scalars stay plain. These results do not widen the quiet zero-allocation claim and [caller-pinned child borrows](research/nested-future-storage.md) now reduce those futures to roughly 10–15KB with unchanged allocation counts and a fixture regression budget. Broader graph growth remains a public admission gate.

The [parallel module decisions](effect-modules.md) preserve the same native scalar/context representation. Structured brackets use generated control flow and a scalar binder rather than a heap finalizer registry. Static Context/Layer maps and Schema range registration exist during TypeScript authoring/boundary compilation; native programs contain ordinary scalar bindings and range comparisons. Pure providers add no crate or async context.

Shared TypeScript client contracts also construct range schemas and their weak registration entries. Effect's lazy parser accessors are initialized before freezing the schemas, so their parser/cache construction cost occurs at schema definition time. These costs are per schema, not per decoded number; they are outside the native context/future allocation probes and have not been measured separately.

The [resource conformance probe](../packages/reffect/tests/resource-scope.test.ts), Rust 1.98.1 release/x86-64, observes logging context/bracket/nested-future sizes of 104/448/96 bytes with bounded frames and 96/408/72 with frames disabled. After creating the watch channel, constructing those contexts and unpolled futures adds zero allocations. These are layouts of specified test programs, not a universal nesting budget or a claim about polling, logging, failure or HTTP allocations.

Typed recovery explicitly drops a handled failure capsule before running a possibly suspended handler. A subsequently failed handler constructs a new bounded trail. Compiler helper memoization now includes the instantiated error witness as well as node and lexical scope; this adds a build-owned index and can produce distinct typed helpers when a shared node is used under different error representations. No native type erasure or per-value metadata is added. Compiler heap and generated growth should be remeasured for workloads exercising many distinct error representations before broad union/error support.

## Value helpers and lexical Ref costs

[Option/Result and collection helpers](effect-modules.md#prioritized-module-expansion) use existing native representations. Structural payloads retain existing ownership/cloning costs; findFirst skips later predicates but traverses the suffix, potentially cloning a retained String. Duration is authoring-time configuration. No runtime scalar acquires metadata.

[Lexical Ref probes](../packages/reffect/tests/ref.test.ts) store Bool/u64/Unit in local slots and pass exclusive borrows, without a native registry, Ref heap object or synchronization crate. Whole-workload release sizes with bounded frames are context104/counter536/cancellation408 bytes; None gives96/520/392. Unpolled future construction and 1,000 specified sequential workloads add zero allocations after setup. These are workload/compiler observations, not Ref-only size deltas or general array/runtime allocation claims. Timer polling, logging, watch setup and HTTP remain separate costs. Three canonical scalar Ref witnesses and their native-representation WeakMap exist only in the TypeScript compiler; retained compiler heap is unmeasured.

## Clock/Random owned driver costs

[Driver probes](../packages/reffect/tests/clock-random.test.ts), Rust 1.98.1/x86-64 Linux, retain scalar f64/bool results without tags or registry lookups. Direct live millis uses std without a synchronous context or new crate. Driver selection and explanation are compiler-owned; injected services use ordinary owned fields and Vec script buffers.

The tested injected SyncContext is 64 bytes. Enabled AsyncContext is 160 bytes with frames None and 168 with bounded frames, versus disabled 96/104: selected service fields add 64 bytes. Enabled interleaved futures measure 464/504 versus a different baseline Sleep workload's 312/320; the full future delta cannot be attributed solely to services. Context construction, moving prepared scripts, unpolled future construction and the specified synchronous scripted invocation each add zero counted allocations. Script buffers, cancellation setup, runtime polling, timers, logging and host faults are excluded. Module-wide SyncContext/AsyncContext layouts follow their respective union of reachable driver fields; contexts can therefore include fields unused by an individual function within a mixed artifact; per-function context specialization remains measurement-driven.

Injected computation millis do not replace observer timestamps or virtualize Sleep. Invalid/exhausted scripts are fatal host configuration faults; these probes do not establish native cleanup after general Effect defects. See [conformance limits](research/runtime-services-conformance.md).
