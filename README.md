# reffect

A semantic compiler for a statically representable subset of Effect v4 programs, authored in TypeScript and compiled to Rust.

TypeScript builders construct typed IR. A reference interpreter runs that IR through official Effect, while the compiler selects native representations, verifies supported semantics, infers ownership, and emits Rust. The compiled authoring namespace is `R`; the initial kernel implements `R.fn` and `R.U64`, with `R.Effect` and `R.Match` planned for later milestones.

## Status

The milestone 0 kernel is implemented in [packages/reffect](packages/reffect/README.md): immutable symbolic function/expression IR, exact unsigned 64-bit arithmetic, Effect v4 reference execution, structured compiler diagnostics/stages, explainable Rust planning, and scoped Cargo build/validation. Generated dependency-free Rust agrees with the reference on boundary cases in debug and release builds.

The milestone 1 Foldkit adapter consumes published Entity Expr/Query IR, generates a dependency-free Rust evaluator, and preserves ordered structured rows. All 27 published conformance cases agree across evaluate, upstream Drizzle/SQLite, and fresh Rust debug/release executables. The encoded primitive profile and explicit refusal boundaries are documented in the package README.

The initial milestone 2 profile adds Boolean predicates/Match and synchronous succeed/fail/map/flatMap computations. Official Effect success/error values agree with dependency-free Rust Result in debug and release. Owned/union representations, async runtime adapters, RPC and migration tooling remain roadmap targets. The workspace also contains the original starter website and utilities.

The first meaningful target is Foldkit Entity Expr/Query conformance through generated Rust. The first major public demo is a stock Effect RPC client talking to a native server. The fullstack showcase aims to combine Foldkit SSR, Remote data/live updates, Effect RPC, and SQLx/Postgres in one Rust executable.

## Design

- [Roadmap](PLAN.md): constraints, milestones, and acceptance criteria.
- [Documentation index](docs/README.md): detailed design discussions and revisions.
- [Runtime lowering](docs/runtime-lowering.md): Rust substrate candidates and semantic adapters.
- [Migration tooling](docs/migration-tooling.md): compiler-guided codemods and target-scoped migration.
- [Progress](PROGRESS.md): actual implementation and validation status.
- [Agent guidance](AGENTS.md): naming, preparation, tooling, and review workflow.

Earlier references use Effect Native/effect-native and `C` as historical design vocabulary. New work uses **reffect** and **R**.

## Development

Use [Vite+](https://viteplus.dev/guide/) for the workspace toolchain:

```bash
vp install
vp check
vp run -r test
vp run -r build
```

`vp run ready` runs the combined validation script. `vp run dev` starts the existing starter website, which is not a compiler UI.

Tests include fresh Cargo compilation and native/reference conformance. Install Rust and the platform linker/SDK; on Windows run native checks from a Visual Studio developer shell so MSVC takes precedence over other `link.exe` programs. The previous starter suite-detection failure is fixed by aligning Vite+ versions.

Run the examples with `vp exec node --experimental-transform-types examples/expr/main.ts` or `vp exec node --experimental-transform-types examples/query/main.ts`; the synchronous Effect example is `vp exec node --experimental-transform-types examples/effect/main.ts`. See [PROGRESS.md](PROGRESS.md) for exact validation results and implementation boundaries, and [the Foldkit-Plus issue record](docs/research/foldkit-plus-issues.md) for upstream findings.
