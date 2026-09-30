# reffect kernel bootstrap

An implemented milestone 0 slice of the semantic compiler: exact unsigned arithmetic, symbolic function IR, reference execution through official Effect v4, explainable Rust planning, and Cargo integration.

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

- `R.U64` is an exact bigint in `0..2^64-1`, with native Rust `u64`. `literal`, `add`, `sub`, and `mul` construct immutable expressions. Arithmetic is modulo `2^64` in every build profile.
- `R.fn` invokes a build-time callback with symbolic parameters, and `R.program` declares named entry functions. Symbols belong to their function. Runtime branching/operators/generators are outside this subset.
- `Reference.run` validates arguments, checks the graph, and returns an official Effect. This is pure expression evaluation; general compiled Effect IR comes later.
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

Run `vp exec node --experimental-transform-types examples/query/main.ts` for a native/reference search example. Additional general representations, compiled Effect computations, RPC, concurrency, and native runtime adapters follow the roadmap.
