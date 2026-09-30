# reffect

A semantic compiler for a statically representable subset of Effect v4 programs, authored in TypeScript and compiled to Rust.

TypeScript builders construct typed IR. A reference interpreter runs that IR through official Effect, while the compiler selects native representations, verifies supported semantics, infers ownership, and emits Rust. The proposed compiled authoring namespace is `R`, with APIs such as `R.fn`, `R.Effect`, and `R.Match`.

## Status

This repository currently contains the design documentation and a Vite+ starter workspace. The compiler, Rust runtime, migration tools, and `R` exports are not implemented yet.

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

The starter currently has a Vitest suite-detection failure; see [PROGRESS.md](PROGRESS.md) for the exact validation results.
