# Compiler library API and CLI

[Roadmap](../PLAN.md) · [Documentation index](README.md)

This document preserves a design discussion from the original PLAN.md. APIs and package names are proposals, not implemented guarantees. Original citation placeholders are retained; verify external API and protocol claims against the installed dependencies before implementation.

## Contents

- [`Compile.make` should create a declarative build specification](#compilemake-should-create-a-declarative-build-specification)
- [`program.native.ts` is itself just data](#programnativets-is-itself-just-data)
- [The compiler itself should be Services + Layers](#the-compiler-itself-should-be-services--layers)
- [Compiler extension becomes normal Effect DI](#compiler-extension-becomes-normal-effect-di)
- [Targets should be data too](#targets-should-be-data-too)
- [Compile options should be composable](#compile-options-should-be-composable)
- [The output should be rich, not just “success”](#the-output-should-be-rich-not-just-success)
- [I'd expose individual compiler stages too](#id-expose-individual-compiler-stages-too)
- [This also gives us a first-class `Compile.check`](#this-also-gives-us-a-first-class-compilecheck)
- [The CLI is then almost trivial](#the-cli-is-then-almost-trivial)
- [`dev` can also just be an Effect program](#dev-can-also-just-be-an-effect-program)
- [Watch/build events should probably be Streams](#watchbuild-events-should-probably-be-streams)
- [Diagnostics should be values too](#diagnostics-should-be-values-too)
- [Even the native support registry should be queryable](#even-the-native-support-registry-should-be-queryable)
- [Program metadata can participate too](#program-metadata-can-participate-too)
- [I might even make `Compile` an Effect service itself](#i-might-even-make-compile-an-effect-service-itself)
- [So I'd make the public architecture look approximately like this](#so-id-make-the-public-architecture-look-approximately-like-this)

---

Yes. I think that should be **one of the core design laws**:

> **`effect-native` is primarily an Effect library. The CLI is just one consumer of that library.**

The compiler should itself be modeled as an Effect application: services, Layers, typed errors, tracing, caching, filesystem/process dependencies, etc. That fits Effect v4 unusually well because v4 already has `Context`/`Layer`, filesystem/process abstractions, and a first-party CLI module under `effect/unstable/cli`. :chatgpt-content-reference{index="0"} :chatgpt-content-reference{index="1"}

I would make the API slightly more explicit than your example, though.

## `Compile.make` should create a declarative build specification

Something like:

```ts
import { Compile, Rust } from "effect-native";
import program from "./program.native.ts";

const build = Compile.make("my-app").pipe(
  Compile.withProgram(program),

  Compile.withTarget(
    Rust.binary({
      release: true,
    }),
  ),

  Compile.withOutput("./dist"),
);
```

At this point `build` is **data/configuration**, not yet running anything.

Then:

```ts
import { NodeRuntime } from "@effect/platform-node";

NodeRuntime.runMain(Compile.run(build));
```

or compactly:

```ts
NodeRuntime.runMain(
  Compile.make("my-app").pipe(
    Compile.withProgram(program),
    Compile.withTarget(Rust.binary()),
    Compile.run,
  ),
);
```

That matches Effect's general separation between descriptions and execution better than having `Compile.make()` immediately start compilation. Your v4 reference similarly points to `NodeRuntime.runMain` / `ManagedRuntime` as the integration points for actually running Effects. :chatgpt-content-reference{index="2"}

Conceptually:

```text
Compile.make(...)
      ↓
Compile.Spec

Compile.run(spec)
      ↓
Effect<Compile.Result, CompileError, CompilerRequirements>
```

---

# `program.native.ts` is itself just data

I'd want:

```ts
import program from "./program.native.ts";
```

to give you:

```ts
Native.Program;
```

not some secret compiler object.

For example:

```ts
export default Native.program({
  name: "todos",

  rpc: TodosRpc,

  handlers: TodoHandlers,

  layer: AppLive,
});
```

The important part is that this object contains the reachable compiled graph.

Then:

```ts
Compile.withProgram(program);
```

just attaches it to the compilation request.

You could have multiple programs:

```ts
const server = Native.program(...)
const worker = Native.program(...)
```

and compile them differently:

```ts
Compile.make("server").pipe(
  Compile.withProgram(server),
  ...
)

Compile.make("worker").pipe(
  Compile.withProgram(worker),
  ...
)
```

---

# The compiler itself should be Services + Layers

This feels very Effect-native.

Internally:

```text
Compile
  │
  ├── ProgramLoader
  ├── Validator
  ├── SchemaCompiler
  ├── LayerPlanner
  ├── Optimizer
  ├── OwnershipAnalyzer
  ├── RustLowering
  ├── RustEmitter
  ├── Cargo
  ├── BuildCache
  └── Diagnostics
```

Each can be a service.

Conceptually:

```ts
class Optimizer extends Context.Service<Optimizer>()(...)
class RustEmitter extends Context.Service<RustEmitter>()(...)
class BuildCache extends Context.Service<BuildCache>()(...)
```

Then the stock compiler ships:

```ts
Compile.layer;
```

which assembles:

```text
ProgramLoaderLive
ValidatorLive
OptimizerLive
RustBackendLive
CargoLive
FilesystemLive
CacheLive
...
```

That buys us a lot.

You could test the compiler with:

```ts
Compile.run(build).pipe(Effect.provide(TestCompilerLayer));
```

or replace a specific component.

---

# Compiler extension becomes normal Effect DI

Suppose somebody creates a better optimization pass.

Instead of designing a completely separate plugin framework:

```ts
const MyOptimizerLive = Layer.succeed(Optimizer, myOptimizer);

Compile.run(build).pipe(Effect.provide(Compile.layer.pipe(Layer.provide(MyOptimizerLive))));
```

Maybe the public API wraps that more elegantly:

```ts
Compile.make("server").pipe(
  Compile.withProgram(program),
  Compile.withOptimizer(MyOptimizer),
  Compile.run,
);
```

but underneath, it's just Effect services.

Same idea for:

```text
new Rust target
new serializer backend
new SQL backend
new code generator
new cache
new native intrinsic library
new build executor
```

This makes `effect-native` extensible without inventing another dependency/plugin architecture.

---

# Targets should be data too

Something like:

```ts
Compile.withTarget(
  Rust.binary({
    profile: "release",
    target: "x86_64-unknown-linux-musl",
    strip: true,
  }),
);
```

Or:

```ts
Compile.withTarget(Rust.library());
```

Later:

```ts
Compile.withTarget(Node.hybrid());
```

Or potentially:

```ts
Compile.withTarget(Wasm.module());
```

The compile graph itself doesn't care.

```text
Effect Native IR
       ↓
Target
       ↓
Lowering backend
```

So the same program can potentially support:

```text
Rust executable
Rust library
Node/native addon
WASM
```

provided its capabilities are compatible.

---

# Compile options should be composable

Instead of one enormous config object:

```ts
Compile.make("api").pipe(
  Compile.withProgram(program),

  Compile.withTarget(Rust.binary()),

  Compile.withOptimization("release"),

  Compile.withOutput("./dist"),

  Compile.withDiagnostics("pretty"),

  Compile.withSourceMaps(true),

  Compile.withIncremental(true),

  Compile.run,
);
```

Or presets:

```ts
Compile.make("api").pipe(Compile.withProgram(program), Compile.release, Compile.run);
```

with:

```ts
Compile.dev;
Compile.release;
Compile.debug;
```

being normal transformations.

That gives you the Effect/pipeline feel throughout.

---

# The output should be rich, not just “success”

Something like:

```ts
interface CompileResult {
  readonly name: string;

  readonly program: ProgramInfo;

  readonly artifact?: Artifact;

  readonly manifest: NativeManifest;

  readonly diagnostics: ReadonlyArray<Diagnostic>;

  readonly timings: CompileTimings;

  readonly cache: CacheResult;
}
```

And optionally emitted intermediate artifacts:

```ts
const result =
  yield *
  Compile.run(
    Compile.make("api").pipe(
      Compile.withProgram(program),
      Compile.emit({
        ir: true,
        rust: true,
        layerGraph: true,
        ownershipGraph: true,
      }),
    ),
  );
```

Then tooling can inspect:

```ts
result.ir;
result.rust;
result.layerGraph;
result.artifact;
```

That will be extremely valuable while developing the compiler.

---

# I'd expose individual compiler stages too

Not only:

```ts
Compile.run(...)
```

but perhaps:

```ts
Compile.load(...)
Compile.validate(...)
Compile.optimize(...)
Compile.analyzeOwnership(...)
Compile.lower(...)
Compile.emit(...)
Compile.build(...)
```

Each returns an Effect.

For example:

```ts
const program = yield * Compile.load(spec);

const validated = yield * Compile.validate(program);

const optimized = yield * Compile.optimize(validated);

const ownership = yield * Compile.analyzeOwnership(optimized);

const rust = yield * Compile.lowerRust(ownership);
```

Normally nobody writes that.

But it's **fantastic for tests, tools, visualization and research**.

The convenience `Compile.run` is simply:

```text
load
 ↓
validate
 ↓
plan Layers
 ↓
optimize
 ↓
ownership
 ↓
lower
 ↓
emit
 ↓
cargo build
```

---

# This also gives us a first-class `Compile.check`

Very useful:

```ts
Compile.make("api").pipe(Compile.withProgram(program), Compile.check);
```

does:

```text
validate CType
validate portable schemas
validate Effects
validate service graph
validate Layer graph
validate target compatibility
validate native implementations
ownership analysis
```

without emitting Rust or invoking Cargo.

That should be fast enough for editor/dev workflows.

---

# The CLI is then almost trivial

And yes, I would absolutely ship a built-in CLI.

Probably built with Effect's own CLI facilities. Effect v4 includes `Command`, `Argument`, `Flag`, `Prompt`, help generation and completions under `effect/unstable/cli`. :chatgpt-content-reference{index="3"}

Commands could be:

```bash
effect-native build ./program.native.ts

effect-native run ./program.native.ts

effect-native dev ./program.native.ts

effect-native check ./program.native.ts

effect-native emit ir ./program.native.ts

effect-native emit rust ./program.native.ts

effect-native inspect layers ./program.native.ts

effect-native inspect ownership ./program.native.ts
```

Maybe aliases:

```bash
en build
en dev
```

But crucially the CLI implementation is basically:

```ts
const Build = Command.make(..., options =>
  loadProgram(options.entry).pipe(
    Effect.flatMap(program =>
      Compile.make(options.name).pipe(
        Compile.withProgram(program),
        Compile.withOptions(...),
        Compile.run
      )
    )
  )
)
```

There is **no hidden compiler functionality in the CLI**.

---

# `dev` can also just be an Effect program

For example:

```ts
Compile.devServer({
  program,
  watch: true,
});
```

could:

```text
watch source
   ↓
reconstruct program IR
   ↓
Compile.check
   ↓
incremental Rust compile
   ↓
restart server
```

using Effect resources/scopes.

Then the CLI command:

```bash
effect-native dev
```

is just a wrapper around that Effect.

And frameworks can embed it:

```ts
const Dev = Effect.gen(function* () {
  const native =
    yield* Compile.devServer(...)

  const frontend =
    yield* ViteDevServer.make(...)

  yield* Effect.never
})
```

That's much better than shelling out to another process manager.

---

# Watch/build events should probably be Streams

For programmatic tooling:

```ts
const builds = Compile.watch(spec)

yield* Stream.runForEach(
  builds,
  event => ...
)
```

Events could include:

```text
SourceChanged
ProgramLoaded
ValidationStarted
ValidationFailed
OptimizationComplete
RustGenerated
CargoStarted
BuildSucceeded
BuildFailed
ServerRestarted
```

Then the CLI can render these.

An IDE can render them.

A web dev dashboard can render them.

Same API.

---

# Diagnostics should be values too

Something like:

```ts
Diagnostic {
  severity
  code
  message
  sourceLocation?
  programPath?
  help?
  notes?
}
```

Example:

```text
EN1021

C.Effect.race is not available for target `rust-v0`.

  src/user.native.ts:42:7

42 │ C.Effect.race(a, b)
     ^^^^^^^^^^^^^^^^^^^

Available since native runtime profile:
  concurrency-v2
```

The CLI pretty-prints it.

The LSP consumes the same object.

CI can turn it into JSON.

Again, **one compiler API**.

---

# Even the native support registry should be queryable

Something like:

```ts
yield *
  Compile.support({
    target: Rust.binary(),
  });
```

could tell tooling:

```text
Effect.map          native
Effect.flatMap      native
Effect.all          native
Effect.race         unsupported

Ref                 native
SubscriptionRef     native
Stream              partial

Rpc.unary           native
Rpc.stream          native
Rpc.reverse         experimental

SchemaBinary        native
```

Then:

```bash
effect-native support
```

is just another view over that API.

---

# Program metadata can participate too

A program itself might declare:

```ts
export default Native.program({
  name: "todos",

  requires: [Native.capability.rpc, Native.capability.sql],

  layer: AppLive,
  rpc: TodoRpcLive,
});
```

Then compilation can resolve:

```text
program capability requirements
             +
target capabilities
             ↓
compatibility
```

before codegen.

---

# I might even make `Compile` an Effect service itself

For embedding in larger systems:

```ts
const compiler = yield * Compile;

const result = yield * compiler.build(spec);
```

And convenience static functions:

```ts
Compile.run(spec);
Compile.check(spec);
```

simply access that service.

Why do this?

Because you can have:

```text
CompileLive
CompileCached
CompileRemote
CompileTest
```

Maybe one day:

```text
local compiler
remote build service
distributed compilation
```

without changing client code.

This is exactly the kind of thing Effect's DI model is good at.

---

## So I'd make the public architecture look approximately like this

```text
effect-native
│
├── Native
│    ├── program
│    ├── fn
│    ├── CType
│    ├── Match
│    ├── Effect
│    ├── Service
│    └── Layer
│
├── Compile
│    ├── make
│    ├── withProgram
│    ├── withTarget
│    ├── withOutput
│    ├── withOptimization
│    │
│    ├── check
│    ├── run
│    ├── watch
│    │
│    ├── validate
│    ├── optimize
│    ├── analyzeOwnership
│    ├── lower
│    └── emit
│
├── Target
│    ├── Rust
│    ├── NodeHybrid       later
│    └── Wasm             maybe
│
├── Compiler services
│    ├── Validator
│    ├── Optimizer
│    ├── Ownership
│    ├── RustBackend
│    ├── Cargo
│    ├── Cache
│    └── Diagnostics
│
└── CLI
     thin Effect CLI over Compile
```

And the canonical programmable usage would probably be:

```ts
import { NodeRuntime } from "@effect/platform-node";
import { Compile, Rust } from "effect-native";
import program from "./program.native.ts";

const main = Compile.make("my-app").pipe(
  Compile.withProgram(program),
  Compile.withTarget(
    Rust.binary({
      profile: "release",
    }),
  ),
  Compile.withOutput("./dist"),
  Compile.run,
);

NodeRuntime.runMain(main);
```

while:

```bash
effect-native build ./program.native.ts --release
```

does essentially the same thing.

That should be a **non-negotiable property of the project**: no compiler capability exists only behind the CLI. The CLI, editor integration, CI integration, dev server, tests, and third-party build systems all consume the same Effect-based compiler API.
