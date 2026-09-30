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
    (p0).wrapping_add(p1)
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

Foldkit Query adaptation, additional native representations, general Effect computations, RPC, concurrency, and native runtime adapters follow the roadmap.
