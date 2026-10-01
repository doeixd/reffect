# reffect semantic compiler

Implemented profiles cover unsigned arithmetic, Foldkit Query conformance, and synchronous Boolean/u64 Effect computations with official Effect reference execution, explainable Rust planning, and Cargo integration.

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

## Supported semantics

- `R.U64` is an exact bigint in `0..2^64-1`, with native Rust `u64`. `literal`, `add`, `sub`, `mul`, `eq`, and `lt` construct immutable expressions. Arithmetic is modulo `2^64` in every build profile.
- `R.fn` invokes a build-time callback with symbolic parameters, and `R.program` declares named entry functions. Symbols belong to their function or lexical continuation. Use exhaustive `R.Match.bool` for runtime branching; ordinary runtime TypeScript operators/generators are outside this subset.
- `Reference.run` validates arguments, checks the graph, and returns an official Effect. Pure expressions and supported synchronous computations share this entry point.
- `IRType.make` constructs semantic witnesses; `Operation.make` declares complete typed signatures and reference evaluators. Values support Effect-style `.pipe` composition through focused combinators, including `IRType.withTraits`, `Operation.withCapabilities/withEffects/withRequirements/withLaws`, and `Target.withCapabilities`. Arithmetic supports data-first and data-last forms.
- `SemanticRef` factories create typed type, operation, target, capability, effect, requirement and trait references. Semantic lookups use these objects; strings are their serialized/display identities. `Native.U64`, `Capabilities.U64`, `Targets.RustStd` and `Traits` expose the builtin objects. The initial Rust target accepts only verified built-in operations and representations.
- `Law.associative/commutative` name typed operation references and receive evidence from `Evidence.claim/tested/proven/builtin`. Evidence policies are named constants. Built-in algebraic registrations are **claims**; no optimization uses them. Traits for the builtin u64 representation are checked from its registered witness, not arbitrary declarations.

## Compiler API

`Compile.check`, `derive`, `normalize`, `plan`, `verify`, `optimize`, `analyzeOwnership`, `lower`, `emit`, `run`, `explain`, and `build` are public Effects. `Compiler.layer` exposes the same API as a service. Diagnostics include a stable code, stage, IR path and message in a typed `CompileError`.

`Reference.run` preserves tuple types. `Reference.runUnknown` is the explicit boundary for runtime inputs requiring schema/arity validation. Examples and tests require no casts or semantic-object spreading. IR traversal uses Effect's exhaustive Match handlers.

Normalization and optimization are identity stages for this subset. Ownership uses primitive copies. Lowering produces structured Rust expressions; emission produces files as data. Planning records chosen implementations, rejected candidates, rationales and reachable crates. `Compile.run` completes through emission, while `Compile.build(program, output)` continues through Cargo with `Cargo.layer` and platform services supplied.

`CargoApi`/`Cargo.layer` expose exclusive-output `write`, offline `build`, evaluator `run`, and scoped `validate`. Validation creates a fresh temporary crate and compares supplied expected results in debug and release. Filesystem/process failures use official platform errors; unsuccessful Cargo commands return `CargoError` with command, status, stdout and stderr. Child processes and temporary validation directories are scoped.

## Run

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

The `foldkit/encoded-primitives@1` profile supports string/number/boolean encoded schemas, primitive literals and nullable unions; equality, null tests, containment, conjunction and stable field ordering. Encoded timestamps compare as strings. SQL unknown propagates through nested predicate comparisons. Complete structured rows are preserved, while only reachable scalar fields cross the internal stdin bridge. UTF-16 strings and f64 bit patterns retain lone surrogates, negative zero and nonfinite equality behavior. No Cargo dependencies or native Effect runtime are needed.

Containment accepts evaluated non-NUL ASCII operands until upstream Unicode/NUL discrepancies are resolved. With two or more retained rows, every ordering key must be present and numbers finite. UTF-16 string ordering matches the JS evaluator; arbitrary SQL collation equivalence is not claimed. Objects/arrays/bigint/opaque representations in reachable scalar computations, decoded Date values, non-field ordering, foreign Entity fields and conflicting input witnesses are refused. Primitive representation checks do not replace full application Schema validation or perform automatic domain encoding.

All 27 upstream fixtures run against evaluate, the unchanged licensed upstream Drizzle compiler/SQLite, and fresh native debug/release crates. See [integration research](../../docs/research/foldkit-query.md) for the Drizzle RC.118 import limitation and [upstream issue reproductions](../../docs/research/foldkit-plus-issues.md). Normalization and optimization remain identity steps; the canonical predicate/order lists are retained, borrowed scalar inputs and copied row indices have conservative ownership, and shared expression nodes lower once.

Run `vp exec node --experimental-transform-types examples/query/main.ts` for a native/reference search example. Additional general representations, RPC, concurrency, and asynchronous runtime adapters follow the roadmap.

## Synchronous Effect profile

```ts
const Difference = R.fn([R.U64, R.U64], R.U64, R.U64, (a, b) =>
  R.Match.bool(R.U64.lt(a, b), R.Effect.succeed(R.U64.sub(b, a)), R.Effect.fail(a)).pipe(
    R.Effect.map((value) => R.U64.mul(value, R.U64.literal(2n))),
  ),
);
const artifact = await Effect.runPromise(Compile.run(R.program({ Difference })));
```

The fourth-argument `R.fn` form declares success and error witnesses. `R.Effect.fn` is the explicit equivalent. `R.Effect.succeed/fail/map/flatMap` construct immutable computation nodes; builders run once with symbolic inputs. `R.Bool` offers literal/not/eq and `R.Predicate` exposes eqU64/ltU64/eqBool/not aliases. Match accepts either two pure expressions or two computations and runs only the selected arm. Failed sources skip their continuations.

`R.Never` represents an uninhabited channel. Branches and sequencing may join Never with an existing witness; distinct non-Never witnesses require a future explicit union representation. Success and error payloads currently support canonical Boolean/u64 witnesses only. Services, defects, interruption, finalizers, async effects, strings, records, tagged unions and advanced ownership remain unsupported in this profile.

Reference interpretation uses official Effect. Generated Rust uses bool/u64 and Result, with Infallible for Never. Planning records the generated synchronous adapter in `artifact.explanation.runtime`, and ownership explains primitive copying. Shared branch nodes emit shared helper functions, keeping generated size linear for repeated binary Match graphs. Helpers preserve lexical scopes and branch-local work.

After writing/building the artifact, `NativeRunner.run(artifact, directory, "Difference", Difference, [2n, 7n], profile)` returns an official `Exit` (success 10n). Supply NodeServices for filesystem/process operations. The function argument preserves tuple/result types and must belong to the artifact. Domain failures return Exit failure with process status zero; invalid arguments, malformed output and process failures remain separate compiler/Cargo errors. Compare typed failure payloads, since reference failures also carry Effect debug stack annotations.

The legacy pure-u64 decimal CLI stays compatible. Pure Boolean output is `bool:true/false`; Result output is `ok:u64:10`, `err:u64:7`, or the analogous Boolean token. The runner validates those tokens against the declared channel Schema.

Run `vp exec node --experimental-transform-types examples/effect/main.ts` for fresh reference/native success and failure checks in debug and release. See [the design record](../../docs/research/basic-effect-ir.md) for boundaries and remaining milestone 2 work.

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

Run `vp exec node --experimental-transform-types examples/source/main.ts` for source lookup and fresh native/reference arithmetic validation. Automatic stack capture, AST/MagicString annotation, v3 maps, imported Foldkit sites, runtime failure frames and native symbols remain separate follow-ups. Foldkit Query still uses its existing unmapped emitter and compatible GeneratedFiles contract.

Source annotations are compiler-side data; generated Boolean/u64 values remain plain native values and current annotations emit no runtime instrumentation. Omitting annotations avoids their authoring allocations, but compilation still emits provenance artifacts. A true artifact-off mode is planned. See [metadata ownership, measurements and opt-outs](../../docs/metadata-cost.md) for the current costs and future logging/frame design.
