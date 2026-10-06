# reffect semantic compiler

Implemented profiles cover unsigned arithmetic, Foldkit Query conformance, and Boolean/u64/Unit Effect computations (synchronous plus a bounded Tokio async profile) with official Effect reference execution, explainable Rust planning, and Cargo integration.

```ts
import { Effect } from "effect";
import { Compile, R, Reference } from "reffect";

const Add = R.fn([R.U64, R.U64], R.U64, (a, b) => a.pipe(R.U64.add(b)));
const program = R.program({ Add });

const artifact = await Effect.runPromise(program.pipe(Compile.run));
const value = await Effect.runPromise(Reference.run(Add, [R.U64.max, 1n])); // 0n
```

`artifact.files` contains a dependency-free Cargo crate with a library and a small command-line evaluator. Its Rust function is:

```rust
pub fn r_Add(p0: u64, p1: u64) -> u64 {
    let v0 = (p0).wrapping_add(p1);
    v0
}
```

`R.flow` composes `Fn`/`EffectFn` values left-to-right, mirroring Effect v4 `flow`: the first function may take any number of inputs and every later function must be unary. Composition is build-time inlining through capture-free binder substitution, so the reference interpreter and native lowering are unchanged. The result is a `Fn` when all components are pure, otherwise an `EffectFn` whose error channel follows `joinType` (`never`, or an identical witness):

```ts
import { R } from "reffect";

const addOne = R.fn([R.U64], R.U64, (x) => R.U64.add(x, R.U64.literal(1n)));
const double = R.fn([R.U64], R.U64, (x) => R.U64.mul(x, R.U64.literal(2n)));
const addOneThenDouble = R.flow(addOne, double); // Fn<[u64], bigint>
```

Plain (non-IR) function composition is Effect's own `flow`; import it from `effect` when composing builder callbacks. Composed components are inlined and are not separate logical-frame or naming boundaries; read the [design record](../../docs/research/flow-composition.md) for the boundary and refusals.

## Option, Result and compositional helpers

`R.Option(T)` and `R.Result(A, E)` create checked tagged-data witnesses using the existing native enum representation. `R.Option.some(value)` infers its item witness; `none(T)` supplies it explicitly. Result constructors are `succeed(value, errorWitness)` and `fail(error, successWitness)`. These are plain structural values; upstream instance branding and methods are outside this profile.

```ts
const Find = R.fn([R.Array(R.U64)], R.Option(R.U64), (values) =>
  values.pipe(R.Array.findFirst((value) => R.U64.lt(value, R.U64.literal(5n)))),
);
const Read = R.fn([R.Option(R.U64)], R.U64, (value) =>
  value.pipe(
    R.Option.map((n) => R.U64.add(n, R.U64.literal(1n))),
    R.Option.getOrElse(() => R.U64.literal(0n)),
  ),
);
```

Option supplies checked matching, mapping/chaining, filtering, fallbacks, presence conversions and composition. Result supplies matching (pure or effectful branches), mapping/error mapping, `mapBoth`, chaining, fallbacks and variant predicates. Result chaining requires the same error witness; broader implicit unions are refused. `R.Effect.result` captures typed failures as Result data; interruption and compiler defects bypass it. `R.Effect.matchEffect` invokes handlers outside source recovery, so a handler failure cannot trigger the opposite handler.

Additional helpers include `R.Effect.catch`, `tap`, `as`, `asVoid`, `catchIf`; `R.Array.some/every/findFirst` and empty predicates; `R.Record.isEmptyRecord`; and `R.Boolean.and/or/not` plus symbolic `R.Predicate.and/or/not`. `R.Bool` remains the original type witness. Array searches skip predicates once decided but still traverse remaining items; retained String search results may clone during that traversal.

`R.Duration` exposes pinned official constructors, conversions and arithmetic for **authoring configuration**. For example, `R.Effect.sleep(R.Duration.millis(10))` erases to a checked millisecond literal. Sleep admits integral 0–60000 milliseconds and refuses lossy fractional, negative, infinite or oversized delays; raw numeric NaN remains refused. There is no runtime Duration witness. Schedule retains its existing timing rules.

[Coverage and priorities](../../docs/effect-module-coverage.md) distinguish shipped bounded profiles from remaining module work; [the decision index](../../docs/effect-modules.md#prioritized-module-expansion) links their conformance evidence and limitations.

## Lexical Ref

`R.Ref.make/get/set/update/modify` support sequential nonescaping Bool, U64 and Unit cells. Consume make directly through ordinary flatMap:

```ts
const Counter = R.fn([], R.U64, R.Never, () =>
  R.Effect.flatMap(R.Ref.make(R.U64.literal(0n)), (cell) =>
    R.Ref.update(cell, (n) => R.U64.add(n, R.U64.literal(1n))).pipe(
      R.Effect.andThen(R.Ref.get(cell)),
    ),
  ),
);
```

Each execution owns a native local cell; helpers borrow it across sequential awaits. No per-cell heap allocation, metadata registry or synchronization primitive is generated. Public/composite handle escape, cross-task sharing and registered cleanup captures are refused. Compiler-erased lexical Layer sharing inside the region is supported. See [Ref decisions and measured cost limits](../../docs/research/ref-module.md).

## Clock and Random drivers

`R.Clock.currentTimeMillis` reads signed safe-integer wall milliseconds at execution time. Its default live driver uses Rust std. `R.Random.next` returns a finite double in `[0,1)`; `nextBoolean` consumes one draw and tests `>0.5`. These remain synchronous effects.

```ts
import { Compile, R } from "reffect";

const Draw = R.fn([], R.Bool, R.Never, () => R.Random.nextBoolean);
const request = Compile.make(R.program({ Draw })).pipe(
  Compile.withRuntimeServices({ random: "ScriptedRandom" }),
);
```

Random requires explicit driver selection. A trusted native host installs prepared scripts through generated context setters; the ordinary command-line/RPC hosts supply no scripts. `clock: "InjectedMillis"` enables stable/scripted millis setters and initially reads live time. Contexts own their buffers and cursors; no service metadata accompanies values. Unsafe observer clocks and Sleep remain live. Exhausted/invalid scripts are host configuration faults, with general defect-finalization behavior outside the supported profile. Nanos, seeds, range helpers and a live Random backend remain deferred. See [design and evidence](../../docs/research/clock-random-modules.md).

## Supported semantics

- `R.U64` is an exact bigint in `0..2^64-1`, with native Rust `u64`. `literal`, `add`, `sub`, `mul`, `eq`, and `lt` construct immutable expressions. Arithmetic is modulo `2^64` in every build profile.
- `R.fn` invokes a build-time callback with symbolic parameters, and `R.program` declares named entry functions. Symbols belong to their function or lexical continuation. Use exhaustive `R.Match.bool` for runtime branching; ordinary runtime TypeScript operators/generators are outside this subset.
- `Reference.run` validates arguments, checks the graph, and returns an official Effect. Pure expressions and supported synchronous and async computations share this entry point.
- `IRType.make` constructs semantic witnesses; `Operation.make` declares complete typed signatures and reference evaluators. Values support Effect-style `.pipe` composition through focused combinators, including `IRType.withTraits`, `Operation.withCapabilities/withEffects/withRequirements/withLaws`, and `Target.withCapabilities`. Arithmetic supports data-first and data-last forms.
- `SemanticRef` factories create typed type, operation, target, capability, effect, requirement and trait references. Semantic lookups use these objects; strings are their serialized/display identities. `Native.U64`, `Capabilities.U64`, `Targets.RustStd` and `Traits` expose the builtin objects. The initial Rust target accepts only verified built-in operations and representations.
- `Law.associative/commutative` name typed operation references and receive evidence from `Evidence.claim/tested/proven/builtin`. Evidence policies are named constants. Built-in algebraic registrations are **claims**; no optimization uses them. Traits for the builtin u64 representation are checked from its registered witness, not arbitrary declarations.

## Command line

`reffect check|build|run <entry>` takes a module whose default export is its compile effect, for example `export default NativeRpc.compile(Group, bindings)`. `check` reports diagnostics without Cargo and exits 1 on refusal. `build` writes the crate to `.reffect/<entry>` beside the entry (`--crate`), builds it (`--release` for the release profile) and copies the binary to `./<entry>` (`--out`). `run` builds, then runs the server with the arguments after `--`. The commands use only the public API; run them with `node packages/reffect/bin/reffect.js` ([design](../../docs/research/cli.md)).

## Compiler API

`Compile.check`, `derive`, `normalize`, `plan`, `verify`, `optimize`, `analyzeOwnership`, `lower`, `emit`, `run`, `explain`, and `build` are public Effects. `Compiler.layer` exposes the same API as a service. Diagnostics include a stable code, stage, IR path and message in a typed `CompileError`.

### Source-artifact policy

Mapped source artifacts remain the default. Select a typed per-request policy through the immutable compile specification:

```ts
import { Compile, SourceArtifacts } from "reffect";

const request = Compile.make(program).pipe(Compile.withSourceArtifacts(SourceArtifacts.None));
const artifact = await Effect.runPromise(request.pipe(Compile.run));
```

`SourceArtifacts.None` omits `sources` and `auxiliaryFiles` and skips provenance collection, mapped UTF-8 byte tracking, source/generated hashing and map JSON serialization. Native payloads and Cargo files remain unchanged. Enabled failure-frame literals carry origins only under Full; frame-off Rust files are identical across source policies. Full/None specifications compose with `Compile.withTarget`; `Compile.build(request, output)` respects the same policy. Public `Compile.lower(ownership, policy)` and `Compile.emit(plan, policy)` also expose the choice.

Default calls infer `MappedArtifact`; None requests infer `UnmappedArtifact` without casts. None compile diagnostics retain semantic codes/stages/IR paths without authored enrichment, and Cargo preserves raw errors with missing-map fallback. Manually constructed Source annotations and the semantic Plan remain retained by the authored program/explanation; artifact-off is independent of capture, failure-frame instrumentation and authored logging. Releasing programs/artifacts remains the caller's ownership responsibility.

`Reference.run` preserves tuple types. `Reference.runUnknown` is the explicit boundary for runtime inputs requiring schema/arity validation. Examples and tests require no casts or semantic-object spreading. IR traversal uses Effect's exhaustive Match handlers.

Normalization and optimization are identity stages for this subset. Ownership uses primitive copies. Lowering produces structured Rust expressions; emission produces files as data. Planning records chosen implementations, rejected candidates, rationales and reachable crates. `Compile.run` completes through emission, while `Compile.build(program, output)` continues through Cargo with `Cargo.layer` and platform services supplied.

`CargoApi`/`Cargo.layer` expose exclusive-output `write`, owned incremental `sync` (it records the files it wrote in `reffect-files.json`, rewrites only changed ones, deletes stale ones and refuses a non-empty directory it did not write), offline `build`, evaluator `run`, and scoped `validate`. Validation creates a fresh temporary crate and compares supplied expected results in debug and release. Filesystem/process failures use official platform errors; unsuccessful Cargo commands return `CargoError` with command, status, stdout and stderr. Child processes and temporary validation directories are scoped.

## Run

### Exit and typed failure causes

```ts
const outcome = R.Effect.exit(R.Effect.fail(R.String.literal("unavailable")));
const cause = R.Cause.fromReasons(
  R.Array.make(
    R.Cause.makeFailReason(R.String.literal("first")),
    R.Cause.makeFailReason(R.String.literal("second")),
  ),
);
const mapped = cause.pipe(R.Cause.map((error) => R.String.concat(error, R.String.literal("!"))));
```

`R.Cause(E)` and `R.Exit(A, E)` are checked plain-value witnesses. Causes contain an ordered `reasons` array of typed `Fail` reasons, including empty arrays and duplicates. Exit uses `Success.value` or `Failure.cause`. Constructors require witnesses for absent channels, as with Result: `Exit.succeed(value, errorWitness)`, `Exit.fail(error, successWitness)` and `Exit.failCause(cause, successWitness)`.

Cause supports `empty`, `fail`, `makeFailReason`, `fromReasons`, `map`, first-error Result/Option observers and reason predicates. Exit supports constructors, pure `match`, `map`, `mapError`, `mapBoth`, `asVoid`, predicates and Option observers. `Cause.map` preserves all reasons; `Exit.mapError` and `mapBoth` rebuild a singleton from the first error, matching Effect v4. An empty failure remains a failure.

`Effect.exit` captures checked synchronous success/typed failure. Async operations, cleanup/Scope and Clock/Random reads inside capture are refused; an async parent can sequence synchronous capture. Defects, Interrupt reasons, annotations, equality and upstream instance/effect branding remain outside this profile. These values do not change runtime task failure propagation. Explicit nonempty Cause arrays allocate; scalar, empty-cause and success paths retain their existing layouts and costs. See [decisions and measurements](../../docs/research/exit-cause.md).

### Bounded structured tasks

```ts
const work = R.Effect.all([R.Effect.sleep(1), R.Effect.sleep(2)], {
  concurrency: "unbounded",
  discard: true,
});
const first = R.Effect.sleep(1).pipe(R.Effect.race(R.Effect.sleep(2)));
```

`all` accepts a static tuple of two or three Unit/Never computations; `race` accepts two, in either argument style. Use `asVoid` to discard infallible values before admission. Race interrupts its loser and awaits cleanup. Parent interruption signals every child and awaits cleanup before the enclosing parent finalizes. Children have separate invocation contexts, inherit log/request snapshots and must open their own explicit resource Scope for registrations.

Children cannot capture parent Ref/file handles, read injected Clock/Random drivers, access RemoteStore/Launch, create nested groups or create groups during cleanup. Child-local Ref/file regions remain supported. Common Bool/U64/Unit child errors have a separate [bounded fallible profile](../../docs/research/fallible-concurrency.md); compound outcomes are not yet admitted by NativeRpc. Scalar typed recovery around an asynchronous source preserves the original failure when cancellation skips its handler, including a child whose final error channel is Never. Changed-error composite recovery remains refused (`TASK_GROUP_RETAINED_FAILURE`); its retained payload has no admitted runtime carrier. RPC refuses the richer outcome profile until compound Cause wire handling is verified. General Fiber handles and collected results await their own ownership and Exit/Cause contracts. Native hosts must signal cancellation and await the parent future; dropping a future does not perform async finalization. See [task decisions](../../docs/research/structured-concurrency.md).

### Scoped heartbeat vertical slice

[examples/heartbeat](../../examples/heartbeat/README.md) builds a standalone Rust
heartbeat with Ctrl-C shutdown and awaited cleanup, using the pinned Effect v4
`addFinalizer → andThen → repeat({ schedule }) → scoped` shape:

```ts
const Application = R.fn([], R.Unit, R.Never, () =>
  R.Effect.addFinalizer(() => R.Effect.logInfo("Application is about to exit!")).pipe(
    R.Effect.andThen(R.Effect.logInfo("Application started!")),
    R.Effect.andThen(
      R.Effect.repeat(R.Effect.logInfo("still alive..."), {
        schedule: R.Schedule.spaced("1 second"),
      }),
    ),
    R.Effect.scoped,
  ),
);
```

Compile with `Rust.tokio`. Spaced schedules admit positive integral 1–60000 ms
durations; repetition admits Unit bodies and optional `times` (additional runs).
`addFinalizer` now constructs an ordinary computation, so conditional and finite
repeated registrations compose inside `scoped`. The checker proves at most 16
registrations per live lexical scope; delayed Unit/Never cleanup is awaited in
LIFO order with registration-time log context. General Scope services and
arbitrary schedules remain outside this profile.
`R.Effect.logInfo` (mirroring Effect v4) uses structured logging rather than
Console/stdout.

From the repository root:

```sh
vp exec node --experimental-transform-types examples/expr/main.ts
vp test
vp run -r build
```

Native tests require Cargo, rustc and the platform's linker/SDK (MSVC C++ tools and Windows SDK on Windows). On Windows use a Visual Studio developer shell; Coreutils also ships a `link.exe` and must not take precedence over the MSVC linker. The test suite deliberately fails if native compilation is unavailable. This workspace package currently exports TypeScript source for development; the package build emits a bundle/declarations, but publishing is deferred.

## Foldkit Query compilation

`Foldkit.compile({ Search: body })` (also `Compile.fromFoldkitQuery`) consumes published `foldkit-entity@0.4.0` Query values directly. Its immutable artifact includes generated Cargo files and per-query explanations of reachable fields, inputs, operation identities and selected implementations. `Foldkit.build(queries, output, profile)` writes to an exclusive new directory and builds offline. `Foldkit.run(artifact, directory, name, input, rows, profile)` executes a built evaluator and returns the original row objects in native result order. Supply NodeServices for filesystem/process operations; scope temporary directories with FileSystem as in [the Query example](../../examples/query/main.ts).

```ts
import { Entity, Expr, Order, Query } from "foldkit-entity";
import { Schema } from "effect";
import { Foldkit } from "reffect";

const Post = Entity.define("Post", Schema.Struct({ id: Schema.String, title: Schema.String }));
const body = Query.from(Post).pipe(
  Query.where(Expr.contains(Post.fields.title, Expr.input("search", Schema.String))),
  Query.orderBy(Order.asc(Post.fields.id)),
);
const artifact = await Effect.runPromise(Foldkit.compile({ Search: body }));
```

The `foldkit/encoded-primitives@1` profile supports string/number/boolean encoded schemas, primitive literals and nullable unions; equality, null tests, containment, conjunction and stable field ordering. Encoded timestamps compare as strings. SQL unknown propagates through nested predicate comparisons. Complete structured rows are preserved, while only reachable scalar fields cross the internal stdin bridge. Reachable cells must be own data properties: inherited values and getters are refused before execution, while unrelated row fields remain untouched. UTF-16 strings and f64 bit patterns retain lone surrogates, negative zero and nonfinite equality behavior. No Cargo dependencies or native Effect runtime are needed.

Containment accepts evaluated non-NUL ASCII operands until upstream Unicode/NUL discrepancies are resolved. With two or more retained rows, every ordering key must be present and numbers finite. UTF-16 string ordering matches the JS evaluator; arbitrary SQL collation equivalence is not claimed. Objects/arrays/bigint/opaque representations in reachable scalar computations, decoded Date values, non-field ordering, foreign Entity fields and conflicting input witnesses are refused. Primitive representation checks do not replace full application Schema validation or perform automatic domain encoding.

All 27 upstream fixtures run against evaluate, the unchanged licensed upstream Drizzle compiler/SQLite, and fresh native debug/release crates. See [integration research](../../docs/research/foldkit-query.md) for the Drizzle RC.118 import limitation and [upstream issue reproductions](../../docs/research/foldkit-plus-issues.md). Normalization and optimization remain identity steps; the canonical predicate/order lists are retained, borrowed scalar inputs and copied row indices have conservative ownership, and shared expression nodes lower once.

Run `vp exec node --experimental-transform-types examples/query/main.ts` for a native/reference search example. Additional representations, general resource Scope and concurrency follow the roadmap; scalar RPC and the bounded async profile below are implemented.

## Well-formed strings

`R.String` is well-formed Unicode text: lone surrogates are refused when an input is decoded, so JS and native agree on the admitted operations. `R.String.literal`, `eq`, `includes(search)` and `replaceAll(search, replacement)` mirror Effect's v4 data-last `String` functions, with data-first forms through `dual`:

```ts
const escapeText = R.fn([R.String], R.String, R.Bool, (value) =>
  R.Match.bool(
    R.String.includes(value, R.String.literal("\u0000")),
    R.Effect.fail(R.Bool.literal(false)),
    R.Effect.succeed(
      value.pipe(R.String.replaceAll("&", "&amp;"), R.String.replaceAll("<", "&lt;")),
    ),
  ),
);
```

`replaceAll` patterns must be literals: a non-empty search and a replacement without `$`. Hand-built `Expr.apply` calls are checked too. Native code uses owned `String` at function boundaries and `&str` inside helpers (`==`, `str::contains`, `str::replace`), with no crate. The native runner passes strings as `str:` plus hex of their UTF-8 bytes. Native RPC accepts `NativeRpc.StringJson` (an ordinary Effect schema that refuses lone surrogates) for payloads, fields, results and typed errors; plain `Schema.String` is refused because it admits lone surrogates. A lone-surrogate escape in a request body is refused for the whole body natively, while the stock server refuses that request only. Length, slicing, ordering, case mapping, regular expressions and string captures in delayed cleanup are not admitted yet. See [string decisions](../../docs/research/string-profile.md).

## Records and tagged unions

`R.Struct(fields)` and `R.TaggedUnion({ Tag: fields })` mirror Effect v4's `Schema.Struct` and `Schema.TaggedUnion`. Identical structures share one witness; `.annotate({ identifier })` names the native type. Values are built with `make`, read with `R.Struct.get` (dual) and branched on exhaustively with `Union.match` or `R.Match.valueTags`:

```ts
const Boundary = R.TaggedUnion({ Terminal: {}, Cursor: { cursor: R.String }, Unknown: {} });
const label = R.fn([R.String], R.String, (cursor) =>
  Boundary.match(Boundary.cases.Cursor.make({ cursor }), {
    Terminal: () => R.String.literal("terminal"),
    Cursor: (c) => R.Struct.get(c, "cursor"),
    Unknown: () => R.String.literal("unknown"),
  }),
);
```

Handlers may instead all return computations, which branches effectfully (typed failures, logging, suspension). Case constructors return the union type, which is narrower than Effect's case type. Native code uses generated Rust structs and an enum of case structs; composite values are borrowed by helpers and copied only where they escape. `NativeRpc` accepts contract `Schema.Struct`/`Schema.TaggedUnion` payloads, results and typed errors built from admitted codecs, with invalid-input messages matching the stock server. Native JSON keys are ordered alphabetically rather than in schema order. Arrays, records/maps, literal unions, optional fields and `NullOr` are not yet admitted. See [record decisions](../../docs/research/records-unions.md).

## Arrays

`R.Array(item)` mirrors `Schema.Array`; `R.Array.make`, `empty`, `length` and dual `map`, `filter` and `reduce` mirror `effect/Array`, with callbacks receiving the element and a u64 index. There are no user-written loops: each operation compiles to one generated Rust loop over borrowed elements.

```ts
const total = R.fn([R.U64, R.U64], R.U64, (a, b) =>
  R.Array.make(a, b).pipe(R.Array.reduce(R.U64.literal(0n), (acc, x) => R.U64.add(acc, x))),
);
```

`R.Effect.forEach(self, (a, i) => effect, { discard? })` iterates effectfully, sequential and fail-fast as in Effect; concurrency is refused. `NativeRpc` accepts `Schema.Array(item)` payloads, fields and results with invalid-input messages matching the stock server. Index access, `findFirst`, sorting, `append`/`concat`, tuples and checked arrays are not admitted yet. See [array decisions](../../docs/research/arrays.md).

## Synchronous Effect profile

### Unit and result discarding

`R.Unit` is the canonical `IRType<void>` witness with exact `undefined` runtime validation and Rust `()` representation. It is distinct from `R.Never` and from Effect's permissive `Schema.Void`, which discards values during parsing.

```ts
const Done = R.Effect.fn([], R.Unit, R.Never, () => R.Effect.void);
const Discard = R.Effect.fn([R.U64], R.Unit, R.Never, (value) =>
  R.Effect.succeed(value).pipe(R.Effect.asVoid),
);
```

Use `R.Unit.literal()` for the one pure value. Unit supports function inputs/results, Match and map/flatMap success/error channels. `R.Effect.asVoid` evaluates its source and preserves failures before discarding a successful result. Unit input slots retain tuple arity; NativeRunner's internal bridge uses `unit`, `ok:unit` and `err:unit` tokens and rejects malformed/wrong-channel values. No native allocation, metadata wrapper or Cargo dependency is introduced.

### Bounded logical failure frames

Failures carry executed-boundary context separately from domain payloads. `Reference.runWithFrames(fn, args, "functions.name.body")` returns the official `Exit` plus innermost-first `LogicalFrame` records (`path`, `kind`) and an `omitted` count; `NativeRunner.runWithFrames(artifact, directory, name, fn, args, profile)` relays the same chains from generated Rust. Frame sources are explicit boundaries only: the failing `Fail` site, enclosing `Map`/`FlatMap`/`Match` helpers and the function entry. Successes carry no frames. Chains are bounded at 32 entries with honest truncation counts; shared nodes report their canonical first-seen path on both sides.

The native binary keeps its stdout payload protocol byte-identical and prints one versioned `reffect.frames@1` JSON object to stderr per failure. The existing payload-only `NativeRunner.run` ignores stderr and is unchanged. Mapped artifacts embed provenance origins in frame literals; `SourceArtifacts.None` omits them while keeping paths identical. Malformed, missing or duplicated envelopes and success-time envelopes are refused as `INVALID_NATIVE_FRAMES`. No new Cargo dependencies; frames allocate only on the failure path.

### Scoped logging

`R.Effect.log`, `logTrace`, `logDebug`, `logInfo`, `logWarning`, `logError` and
`logFatal` mirror the Effect v4 names and emit typed log records as effect nodes
returning `Unit`; `R.Effect.annotateLogs(key, value)` and
`R.Effect.withLogSpan(label)` wrap computations with lexical scopes. `R.Log`
exposes the same records over the six-severity witness plus `R.Log.log(level, …)`.
Reference execution delegates filtering, shadowing, restoration and span
stacking to the official Effect combinators. Native code prints one versioned
`reffect.log@1` JSON object per record to stderr — level, static message,
`annotations` object (Booleans as JSON, u64 as decimal strings), innermost-first
`spans` with elapsed millis — under a default Info minimum checked before
formatting. Static call-site attributes shadow scope annotations per key.
Messages are static strings and annotation values are typed Boolean/u64
expressions, so structured v4 message arguments are not yet admitted.
Machine stdout carries only evaluator payloads. No new Cargo dependencies;
scopes save/restore bounded thread-local context on both success and failure
paths.

### Scheduled repetition and retry

`R.Schedule` mirrors the bounded Effect v4 constructors: `recurs(times)` (zero
delay), `spaced(duration)`, `exponential(base, factor?)` and `forever`.
`R.Effect.repeat(self, scheduleOrOptions)` repeats a Unit computation and
`R.Effect.retry(self, scheduleOrOptions)` retries typed failures, where options
are `{ schedule, times }` and `times` counts additional runs. Both accept a bare
schedule for the v4 dual form:

```ts
const Retry = R.Effect.fn([], R.Unit, R.Bool, () =>
  R.Effect.retry(
    R.Effect.logInfo("try").pipe(
      R.Effect.andThen(R.Effect.fail(R.Bool.literal(false))),
      R.Effect.asVoid,
    ),
    { schedule: R.Schedule.exponential(50, 2), times: 4 },
  ),
);
```

Reference execution delegates to the official `Effect.repeat`/`Effect.retry`;
generated Rust emits one concrete loop with a `completed` counter, a
continuation test and a computed delay, reusing `AsyncContext::sleep` for
cancellation. `retry` never retries interruption and reports the last failure on
exhaustion; retried attempts drop their logical frames and the final failure
keeps one retry boundary frame. Spaced/exponential bases are integral 0–60000 ms,
`recurs`/`times` are 0–1000000, and exponential factors are finite `> 0` and
`<= 1000`. Fixed cadence, jitter, `while`/`until` predicates, `upTo`-by-duration
and schedule combinators remain outside this profile, and `repeat` discards the
schedule output.

```ts
const Difference = R.fn([R.U64, R.U64], R.U64, R.U64, (a, b) =>
  R.Match.bool(R.U64.lt(a, b), R.Effect.succeed(R.U64.sub(b, a)), R.Effect.fail(a)).pipe(
    R.Effect.map((value) => R.U64.mul(value, R.U64.literal(2n))),
  ),
);
const artifact = await Effect.runPromise(Compile.run(R.program({ Difference })));
```

The fourth-argument `R.fn` form declares success and error witnesses. `R.Effect.fn` is the explicit equivalent. `R.Effect.succeed/fail/map/flatMap` construct immutable computation nodes; builders run once with symbolic inputs. `R.Bool` offers literal/not/eq and `R.Predicate` exposes eqU64/ltU64/eqBool/not aliases. Match accepts either two pure expressions or two computations and runs only the selected arm. Failed sources skip their continuations.

`R.Never` represents an uninhabited channel. Branches and sequencing may join Never with an existing witness; distinct non-Never witnesses require a future explicit union representation. Success and error payloads currently support canonical Boolean/u64/Unit witnesses. Services, defects, interruption, finalizers, async effects, strings, records, tagged unions and advanced ownership remain unsupported in this profile.

Reference interpretation uses official Effect. Generated Rust uses bool/u64 and Result, with Infallible for Never. Planning records the generated synchronous adapter in `artifact.explanation.runtime`, and ownership explains primitive copying. Shared branch nodes emit shared helper functions, keeping generated size linear for repeated binary Match graphs. Helpers preserve lexical scopes and branch-local work.

After writing/building the artifact, `NativeRunner.run(artifact, directory, "Difference", Difference, [2n, 7n], profile)` returns an official `Exit` (success 10n). Supply NodeServices for filesystem/process operations. The function argument preserves tuple/result types and must belong to the artifact. Domain failures return Exit failure with process status zero; invalid arguments, malformed output and process failures remain separate compiler/Cargo errors. Compare typed failure payloads, since reference failures also carry Effect debug stack annotations.

The legacy pure-u64 decimal CLI stays compatible. Pure Boolean output is `bool:true/false`; Result output is `ok:u64:10`, `err:u64:7`, or the analogous Boolean token. The runner validates those tokens against the declared channel Schema.

Run `vp exec node --experimental-transform-types examples/effect/main.ts` for fresh reference/native success and failure checks in debug and release. See [the design record](../../docs/research/basic-effect-ir.md) for boundaries and remaining milestone 2 work.

## Scoped read-only native files

`R.File.scoped(path, use, afterClose?)` owns one real read-only file for its callback's computation. The callback receives a symbolic resource reference with `file.size: Computation<bigint, boolean>`; it is not an Expr or an exportable descriptor. Paths are build-time Unicode scalar strings without NUL, bounded to 4096 UTF-16 code units. Open/metadata failures deliberately project to Boolean `false`.

```ts
const Size = R.fn([], R.U64, R.Bool, () =>
  R.File.scoped(
    "input.txt",
    (file) => R.Effect.sleep(10).pipe(R.Effect.flatMap(() => file.size)),
    R.Log.info("closed"),
  ),
);
const artifact = await Effect.runPromise(Compile.run(R.program({ Size }), Rust.tokio));
```

Acquisition is masked and awaited through Tokio's blocking executor. Generated helpers borrow a plain `std::fs::File`; the owning lexical scope drops it before running optional non-failing Unit/Never after-close cleanup, with cleanup masked and awaited. Nested scopes close inside-out and can borrow outer handles. Captured file operations used outside their owning scope are refused. Read-only close errors are ignored on both adapters; writable/durable files need a separate error contract. Metadata is a synchronous syscall, not a general asynchronous filesystem profile.

The official Effect reference uses `Effect.scoped`/`acquireRelease` and a Node FileHandle adapter. `ReferenceFiles` is an injectable reference service, and `FileLease` lets conformance adapters supply size/close Effects. Native plans explain the distinct `Rust.scopedFiles` service implementation and lexical ownership; unused programs acquire no file dependency or resource storage. Cancellation requires signaling and awaiting the generated future, including acquisition; dropping/aborting a future is outside the finalization guarantee.

Run [the scoped-file stock RPC example](../../examples/rpc-files/README.md). This establishes lexical bracket ownership; the registered-file extension below retains ownership through the surrounding Scope. Manual/child scopes, resource Layers, fallible cleanup and cross-fiber handle transfer remain outside the profile.

## Bounded sequential resource Scope

`R.Effect.addFinalizer(() => cleanup)`, `R.Effect.acquireRelease(acquire,
resource => cleanup)` and `R.Effect.scoped` mirror the admitted Effect v4
signatures. Registrations are ordinary computations and can occur conditionally
or repeatedly at runtime. Scalar acquisition returns its acquired value;
acquisition and successful registration are masked together. Bare finalizer
registration follows ordinary interruptibility. Release is delayed until the
nearest enclosing `scoped` exits, then awaited once in reverse registration order.

```ts
const Session = R.fn([], R.U64, R.Bool, () =>
  R.Effect.addFinalizer(() => R.Effect.logInfo("session released")).pipe(
    R.Effect.andThen(
      R.File.acquireReadOnly("input.txt", (file) => file.size, R.Effect.logInfo("file closed")),
    ),
    R.Effect.scoped,
  ),
);
```

`R.File.acquireReadOnly` is a specialized borrowed-use adapter: the callback
returns a scalar computation, while the actual file remains owned until outer
scope closure. This differs from `R.File.scoped`, which closes at the end of its
use callback. File references cannot escape or be captured by delayed cleanup.
Cleanup drops the owned file before awaiting its optional after-close effect.

The checker requires an enclosing scope, proves execution multiplicity before
IO (including branch maxima and finite repeat/retry bounds), and refuses unknown
or greater-than-16 retained registration counts. This is an admission budget,
not a new runtime error in the Never channel. Each accepted program emits a
generated finalizer enum with pruned scalar captures, a fixed-capacity scope
stack selected by reachable nesting, and concrete cleanup dispatch. Nonempty
log annotation/span snapshots allocate independently of the plain scalar values.

Finalizers retain registration-time annotations and original span starts, with
close-time context restored after each invocation. Closure is masked; successful
body completion becomes interruption if cancellation is pending, while a settled
typed failure is preserved. Callers signal cancellation and await the future.
Exit-aware/fallible cleanup, interruptible acquisition options, manual Scope
values/close, children, parallel release, registration within cleanup and resource
Layers remain outside this profile. Scope requirements are checked on IR
reachability rather than a third Computation type parameter.

Run [the registered-file example](../../examples/scope-registration/README.md).
[The design and validation record](../../docs/research/resource-scope-registration.md)
distinguishes the implemented profile from the superseded preparation.

## Source provenance and build diagnostics

Explicit annotations are supported on pure/effectful expressions and functions:

```ts
import { Source, SourceMaps } from "reffect";

const file = Source.file("src/math.ts", "R.U64.add(a, b)");
const definition = Source.site(file, 0, 15, "sum");
const Sum = R.fn([R.U64, R.U64], R.U64, (a, b) => R.U64.add(a, b).pipe(Source.at(definition))).pipe(
  Source.named("Sum"),
);
const artifact = await Effect.runPromise(Compile.run(R.program({ Sum })));
const locate = await Effect.runPromise(SourceMaps.resolver(artifact.sources, artifact.files));
// Generated spans use UTF-8 bytes, never JavaScript string offsets.
const diagnostic = locate("src/lib.rs", 0, 1); // generated scaffolding: unmapped
```

`Source.file` snapshots caller-provided text; it does not read the path. `Source.site` validates half-open UTF-16 ranges and supplies one-based UTF-16 display positions. Paths are portable workspace-relative names, snapshots require well-formed Unicode, and ranges cannot split surrogate pairs or CRLF. `Source.at`, `Source.use` and `Source.named` are immutable pipeable metadata copies. `use` preserves the definition while recording a distinct occurrence; all annotations preserve node/binder identity, generics and callback counts. `R.Source` exposes the same API.

Artifacts keep the three Cargo sources in `files`; `auxiliaryFiles` contains schema-version-1 `reffect.sources.json` and `reffect.build.json`. `sources` is the immutable decoded provenance/range table. Source paths/digests, definition/use/ancestor records and generated byte ranges are retained; source contents are omitted. Wire occurrences use compact edges/parent IDs. Maps and IDs reproduce for unchanged inputs; identity is not promised through arbitrary edits. Hashing requires platform Web Crypto. No runtime Rust dependency is added.

`SourceMaps.decode` validates a serialized table and its build fingerprint. `SourceMaps.resolver` checks generated digests once and returns whole explicit authored ranges, reduced-precision contextual/named locations, or mapped/unmapped/stale/missing/invalid status. A point at a range's exclusive end does not inherit that range. `verifyManifest` checks a map against its build manifest; lookup never fetches URLs. See [the detailed contract and limits](../../docs/source-maps.md#implemented-foundation).

Compiler `CompileError.diagnostics` retain code/stage/IR path and add optional `primary`/`related` authored locations. Cargo build uses JSON messages and adds `diagnostics` to a successful result or `CargoError`. Each native diagnostic has code/level/message, full `raw` rustc data and spans with native file/byte ranges, mapping status and optional `authored`/`related` locations. Stale/missing/malformed artifacts preserve native errors. Rust suggestions remain Rust suggestions. Cargo run/stdin and NativeRunner output formats remain unchanged; metadata copies of the same function definition can be supplied to NativeRunner.

Run `vp exec node --experimental-transform-types examples/source/main.ts` for source lookup and fresh native/reference arithmetic validation. Automatic stack capture, AST/MagicString annotation, v3 maps, imported Foldkit sites and native symbols remain separate follow-ups; logical runtime failure frames are implemented as described above. Foldkit Query still uses its existing unmapped emitter and compatible GeneratedFiles contract.

Source annotations are compiler-side data; generated Boolean/u64 values remain plain native values and current annotations emit no runtime instrumentation. Omitting annotations avoids their authoring allocations, and SourceArtifacts.None skips provenance artifact generation. See [metadata ownership, measurements and opt-outs](../../docs/metadata-cost.md) for the current costs and request-context design.

## RPC conformance foundation

`vp test packages/reffect/tests/rpc.test.ts` exercises the pinned stock Effect HTTP client and reference server against the shared scalar-handler contract and portable JSON fixtures. [Research and reuse instructions](../../docs/research/unary-rpc.md) define the next native server acceptance gates. The harness is test infrastructure; the native scalar JSON/HTTP profile now passes it over real sockets in debug/release.

### Native unary HTTP profile

`NativeRpc.compile(group, bindings, { path: "/rpc" })` emits a Rust server that calls compiled Fn/EffectFn handlers directly. Bind arguments with `NativeRpc.bind(fn, ["left", "right"])`; use ordinary `Schema.Boolean`, exact `Schema.Undefined`, `Schema.Never`, and `RpcCodecs.U64Json` in the shared contract. Client contracts can import RpcCodecs from `reffect/rpc-codecs` to avoid compiler-module imports. Only plain required flat Struct payloads and those scalar channels are supported. Unsupported codecs, unadapted middleware, layouts and native witness mismatches produce RPC_UNSUPPORTED diagnostics. Unit IR void maps to the shared undefined schema and JSON null without casts.

The artifact includes core handler explanation/stages and an Axum/Tokio/serde_json runtime profile. Write with CargoApi.write, explicitly prepare dependencies with CargoApi.fetch, then build offline with CargoApi.build. Server arguments are `--host` and `--port`; loopback/3000 is the default, and port 0 prints a versioned ready record. Both configured route spellings with/without a trailing slash accept POST. Requests are limited to 64 KiB and 64 entries per batch.

Run [examples/rpc](../../examples/rpc/README.md) for the unchanged stock client calling native Rust. Synchronous groups use scalar execution on a current-thread HTTP substrate and drain failure frames around dispatch. Groups with supported async handlers use the owned worker profile below. RPC artifacts have SourceArtifacts.None; general middleware/Schema/Services support, trace propagation, CORS and graceful draining remain following work. The checked bearer slice below adds one explicit service projection.

### Authenticated request profile

`NativeRpc.bearer(Middleware, PrincipalService, { credentialsEnv })` adapts one stock middleware with an exact string-literal denial and one bigint principal service. Pass `{ auth }` to NativeRpc.compile. Bind protected handlers with `NativeRpc.bindPrincipal(fn, fields)`; their first input is a canonical u64 principal, followed by payload arguments. Handler error witnesses describe domain failures; middleware failures remain in the shared stock client's error union. Public handlers retain NativeRpc.bind.

Credentials are a bounded runtime environment JSON array of token/principal pairs, never compiler inputs. Invalid configuration fails before listening; denied calls return a typed middleware failure without executing handlers. Payload decoding precedes middleware; normalized envelope authorization overrides HTTP authorization, matching Effect. See [the runnable authenticated example](../../examples/rpc-auth/README.md) for configuration and limits.

Each synchronous dispatch owns a stack context view borrowing request ID/tag from the HTTP-owned body, with a plain optional u64 principal. Local handler logs carry a separate request field; a lexical RAII guard restores previous context through typed errors and unwinding. JSON context is prepared only for the reachable logging profile; values and Result channels gain no metadata fields. Credentials allocate once at startup in immutable shared server state. This adapter does not compile arbitrary middleware/Context/Layer operations, JWT verification, graceful draining or OTel export. Its suspended-handler extension is described below.

## Failure-frame selection and native costs

Bounded logical failure capture is the default. To strip it independently of
source artifacts and authored logs:

```ts
import { Compile, FailureFrames } from "reffect";

const artifact = await Effect.runPromise(
  Compile.make(program).pipe(Compile.withFailureFrames(FailureFrames.None), Compile.run),
);
```

None generates plain Result helpers and no frame descriptors, stash, propagation
or CLI frame envelope. NativeRunner.run preserves payload behavior;
NativeRunner.runWithFrames refuses this policy before execution. The selection
is retained in the artifact and verified explanation. Staged plans use
Plan.withFailureFrames; NativeRpc.compile accepts `{ failureFrames: FailureFrames.None }`.
Source maps and authored log/annotation/span behavior remain independent.

Bounded capture allocates one fixed-capacity, heap-owned trail on failure, retaining
32 innermost frames and an omitted count during propagation. It leaves Rust
scalars plain and success paths allocation-free, but can enlarge internal Result
layouts. Observation through take_last_frames may allocate a Vec; RPC cleanup
uses clear_last_frames without converting. This synchronous thread-local owner
is not an async task context. See [measured costs](../../docs/metadata-cost.md#native-failure-frame-costs)
and [design research](../../docs/research/failure-frames.md#construction-bounds-and-frame-policy-preparation--2026-10-01).

## Bounded async execution and RPC

```ts
import { Compile, R, Rust } from "reffect";

const delayed = R.fn([R.U64], R.U64, R.Never, (value) =>
  R.Effect.sleep(10).pipe(
    R.Effect.flatMap(() => R.Effect.succeed(value)),
    R.Effect.ensuring(R.Log.info("cleanup")),
  ),
);
const artifact = Compile.make(R.program({ delayed })).pipe(
  Compile.withTarget(Rust.tokio),
  Compile.run,
);
```

`R.Effect.sleep` admits integer build-time literals from 0 to 60000 milliseconds.
`R.Effect.ensuring` accepts a Unit/Never finalizer, may suspend, and preserves the
body's channels. Finalizers run inside first, exactly once on each entered body
exit, with cooperative cancellation masked while cleanup is awaited. A pending
interruption after successful cleanup interrupts success; a typed failed body
retains its failure if interruption arrives during masked cleanup, matching the
pinned Effect oracle. The sequential Scope/acquireRelease profile above adds
delayed registration; Exit-aware/fallible cleanup, manual/child/parallel Scope
services and resource Layers remain open.

Default Rust.std refuses async nodes. Rust.tokio selects the same scalar backend
with an explicit async capability and reachable Tokio 1.53.1 time/sync features;
its synchronous programs still emit dependency-free code. Planning reports the
async runtime adapter. Helpers have concrete future types and receive an explicit
mutable AsyncContext, with separate AsyncError.Fail/Interrupted outcomes.

NativeRpc.compile selects this profile automatically for groups with async
handlers, preserving stock clients, scalar schemas and bearer projection. A worker
owns parsed requests, headers and auth state. Each invocation owns cancellation,
request/log scopes and optional bounded failure storage. Dropping a pending HTTP
response signals cancellation; the worker awaits cleanup before leaving. Batches
remain sequential and stop starting handlers after cancellation. No thread-local
context guard survives suspension. Scalars remain plain; failure capture None
removes the trail field and propagation independently of logging/source artifacts.

Native Rust consumers must **signal cancellation and await completion**. Dropping
or aborting a future cannot execute async cleanup. NativeRunner process interruption
shuts down its child; cooperative cleanup is exercised through HTTP or a direct
Rust context, rather than process termination. Panics, process termination
and graceful server draining are outside this slice's guarantee. The frame
reference observer compares typed failures; native interruption frames are
bounded diagnostics, without a claimed official interruption-frame oracle.
See [the runnable example](../../examples/rpc-async/README.md),
[design/evidence](../../docs/research/async-rpc.md) and
[measured costs](../../docs/metadata-cost.md#async-context-and-future-costs).

## Typed recovery and structured resource lifetimes

`R.Effect.catchAll` builds a symbolic typed-error handler; `mapError` transforms that channel and `orElse` runs a fallback after a typed failure. They preserve successful values and bypass interruption/compiler failures. Success channels follow the existing same-witness-or-Never rule. Recovery discards handled failure frames before executing its handler; a failed handler starts its own trail. These operations work in synchronous and async profiles. See [decisions and conformance](../../docs/research/error-recovery.md).

```ts
const released = R.Effect.acquireUseRelease(
  R.Effect.succeed(R.U64.literal(7n)),
  (token) => R.Effect.succeed(token),
  (token) => R.Log.info("release", [["token", token]]),
);
```

Structured acquisition and release mask cooperative cancellation; use restores the inherited policy. Failed acquisition skips release. Successful acquisition releases once, including cancellation during acquisition/use/release. Release must return Unit/Never; callbacks receive a lexical symbolic scalar. This profile requires `Rust.tokio`, including a bracket without timers. It establishes bracket lifetimes, rather than general Scope registration, opaque OS handles or Exit-aware/fallible release. Direct native callers still signal cancellation and await completion. See [resource decisions](../../docs/research/resource-scope.md).

## Static Context and Layer wiring

```ts
const Count = R.Context.service("app/Count@1", R.U64);
const base = R.Layer.succeed(Count, R.U64.literal(10n));
const computation = R.Layer.provide(base, (context) => R.Effect.succeed(context.get(Count)));
```

Contexts are immutable build-time environments containing symbolic values. Compatible IDs share a slot; witnesses must agree. `R.Layer.effect` admits scalar acquisition, `sequence` builds providers sequentially with per-provide sharing and right override, and `fresh` gives each occurrence an independent memo boundary. `merge` admits only pure providers; effectful concurrent merge is refused. Expansion produces existing checked IR, with no native service map or scalar metadata. Pure providers retain the dependency-free profile; suspending acquisition selects Tokio through reachability.

### Resource-bearing Layers

As in Effect v4 (which has no `Layer.scoped`), `R.Layer.effect` acquisition may register finalizers with `addFinalizer`, `acquireRelease` or `R.File.acquireReadOnly`. `R.Layer.provide` then owns a scope around acquisition and body, like `Effect.provide`: releases run after the body in reverse acquisition order, a shared provider acquires once, and a failed acquisition releases what earlier providers registered. Acquisition errors join the body's error channel. A provide staged inside another provide's body reuses the outer memoized providers, mirroring `CurrentMemoMap`; `fresh` and `provide(layer, build, { local: true })` reacquire.

```ts
const Size = R.Context.service("app/Size@1", R.U64);
const file = R.Layer.effect(
  Size,
  R.File.acquireReadOnly("input.txt", (f) => f.size),
);
// The file stays open until the provide exits.
const size = R.Layer.provide(file, (ctx) => R.Effect.succeed(ctx.get(Size)));
```

Layer registrations share the provide scope's proved 16-slot budget. Providers without retained registrations are not wrapped in a scope.

This is lexical, per-invocation service wiring. Dynamic Effect requirements, arbitrary service objects/methods, concurrent resource merge and service objects remain pending; native RPC servers can build layers once for the server lifetime (below). See [Context/Layer decisions](../../docs/research/context-layer.md), [resource Layer decisions](../../docs/research/resource-layer.md) and [the module decision index](../../docs/effect-modules.md).

### Server-lifetime RPC services

Like `RpcGroup.toLayer`, a native server can build services once at startup and pass them to handlers:

```ts
const Base = R.Context.service("app/Base@1", R.U64);
const add = R.fn([R.U64, R.U64], R.U64, R.Never, (base, step) =>
  R.Effect.succeed(R.U64.add(base, step)),
);
const artifact = NativeRpc.compile(
  Group,
  { Add: NativeRpc.bindServices([Base], add, ["step"]) },
  { layer: R.Layer.effect(Base, acquireBase) },
);
```

The generated server runs the layer before binding its listener; scalar service values are copied into each handler call, and resources registered during acquisition stay owned by the startup task. A failed acquisition releases what it registered, prints a `reffect.rpc.startup@1` failure record and exits 1 without a ready record. On Ctrl-C, or stdin EOF when started with `--shutdown-on-stdin-eof`, the server stops accepting, interrupts and awaits in-flight requests (as `RpcServer` does), then releases server-lifetime registrations in reverse order and exits 0. Services must be Boolean, u64 or Unit; protected procedures cannot yet also bind services. Servers without a layer are unchanged. See [server-lifetime decisions](../../docs/research/server-layer.md).

## Constrained scalar RPC payloads

`RpcCodecs.u64Range({ minimum: 1n, maximum: 100n })` returns an ordinary shared Effect Schema with inclusive bounds on the canonical decimal-string u64 codec. Native RPC supports it as a scalar or required flat-field payload, validating before authentication/handler execution. Bounds must satisfy `0 <= minimum <= maximum <= u64::MAX`. Handler values stay plain u64. Exact factory-created schema identities are admitted; derived checks/annotations and constrained success/error schemas are refused.

Schema registration belongs to the TypeScript boundary/compiler, with no native runtime map or additional crate. Stock clients can use the frozen scalar schemas' parser accessors. See [Schema decisions and native/reference corpus](../../docs/research/schema-profile.md).
