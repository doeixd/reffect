<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# Project goal

Build reffect: an ahead-of-time semantic compiler and small native runtime toolkit for a statically representable subset of Effect v4 programs. TypeScript authoring APIs construct typed, immutable IR; a reference interpreter executes it through official Effect, and the compiler derives a semantics-preserving Rust implementation.

The canonical project name is **reffect**. Use **R** as the compiled authoring/DSL namespace in new designs and code, for example `R.fn`, `R.Effect`, and `R.Match`. Historical docs use Effect Native/effect-native and C/Compiled/Native; interpret them in light of this naming decision. The naming choice does not establish implemented package exports, and historical examples need not be mechanically rewritten.

The compiler must know what each operation means, which types and representations it uses, what effects and dependencies it has, which laws justify transformations, and why a target implementation was chosen. Compile abstractions away while preserving observable behavior: success/failure, interruption, resource finalization, Layer sharing, and protocol compatibility.

The current [Effect module decision index](docs/effect-modules.md) records the bounded bracket, typed recovery, lexical Context/Layer and scalar Schema subsets. Use its per-module decisions when extending these APIs; bracket lifetimes are narrower than resource Scope, and static providers are narrower than dynamic services/resource Layers.

Compile Effect semantics onto Rust std/Tokio and suitable crates. Prefer generated code when an abstraction can disappear; otherwise reuse execution machinery with a verified semantic adapter. Keep dedicated runtime code focused on the observable Effect behavior that those strategies cannot supply.

The first meaningful workload is existing Foldkit Entity Expr/Query conformance running through a generated Rust evaluator. Unary Effect RPC is the first major public demo. Milestone 3A establishes owned async execution, cancellation/finalization and a minimal resource Scope before milestone 3B Services/Layers; streaming later extends those lifetimes. Milestone 8A is fully native SSR authored in R; 8B mechanically transforms pinned upstream SSR source into R builders that meet the same acceptance. The implemented Sleep/Ensuring slice is narrower than general resource Scope. The combined showcase is `examples/todo-fullstack`: one native executable serving Foldkit SSR, Effect RPC, Remote data/live updates, and SQLx/Postgres, with an ordinary Foldkit/Effect browser client. Foldkit Query conformance and scalar unary RPC demonstrations, including checked bearer authentication and synchronous request/log context, are implemented. The combined showcase is delivered on SQLite (milestone 9, 2026-10-04); it signs in with an HttpOnly session cookie under `--auth` (#4, 2026-10-05); a Postgres variant remains.

# Read before working

Start with [PLAN.md](PLAN.md) for the current vision, constraints, milestone order, and acceptance criteria. Check [PROGRESS.md](PROGRESS.md) and the actual code for implemented support and known validation failures. Use [docs/README.md](docs/README.md) to select the references relevant to the task.

The [revision overview](docs/op-expr-revision-convo.md), [revised compiler design](docs/compiler-design-revision.md), and [detailed implementation milestones](docs/implementation-milestones.md) provide the latest design direction. They update earlier kernel, reuse, pipeline, and sequencing proposals. Follow the detailed milestones 0–15 when the conversation's final condensed sequence uses different numbering.

| Reference                                                          | Use for                                                                                                                     |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| [Revision overview](docs/op-expr-revision-convo.md)                | Design changes, precedence, and reading order                                                                               |
| [Revised compiler design](docs/compiler-design-revision.md)        | Kernel, repository shape, representations, Operation/Law/Trait, passes, API, and CLI                                        |
| [Implementation milestones](docs/implementation-milestones.md)     | Current scope, acceptance, ownership, and workload-driven sequence                                                          |
| [Conformance and diagnostics](docs/conformance-and-diagnostics.md) | Test obligations, diagnostics, postponed scope, and fullstack target                                                        |
| [Foldkit IR design](docs/foldkit-ir-design.md)                     | Expr/Query reuse, symbolic inputs, dependency/support analysis, normalization, and stable identity                          |
| [Gen2 semantic kernel](docs/gen2-semantic-kernel.md)               | Typed law witnesses, evidence policy, checked traits, and explainable planning                                              |
| [Reuse strategy](docs/reuse-strategy.md)                           | Adaptation, public contracts, semantic ports, and deferred shared extraction                                                |
| [Cruster backend](docs/cruster-backend.md)                         | Optional later distributed/durable profile and cluster RPC separation                                                       |
| [Original architecture](docs/architecture.md)                      | Foundational typed DSL/IR, ownership, Services/Layers, fibers/Scope, and native lowering details                            |
| [Compiler API](docs/compiler-api.md)                               | Build specs, results, diagnostics, watch/dev, and thin CLI                                                                  |
| [Observability](docs/observability.md)                             | Source provenance/logical stacks, logging/OTel/metrics, context semantics, optional native dependencies and delivery gates  |
| [Source maps](docs/source-maps.md)                                 | Authored coordinates, JS composition/MagicString, IR-to-Rust ranges, native symbols, mapped diagnostics and artifact policy |
| [RPC MVP](docs/rpc-mvp.md)                                         | Shared contracts and unary JSON/HTTP stock-client demo                                                                      |
| [RPC protocol](docs/rpc-protocol.md)                               | Middleware, streaming/backpressure, sessions, serialization, and transports                                                 |
| [Foldkit Remote and SQL](docs/foldkit-remote.md)                   | Sources, authorization, normalized data, SQLx/storage, liveHub, and resume                                                  |
| [Foldkit SSR](docs/foldkit-ssr.md)                                 | Server-reachable rendering, routing/init/view, hydration, SSG, and HTML streaming                                           |

Preserved discussions contain provisional API spellings, unresolved citation placeholders, and historical upstream/licensing observations. They are design context. Verify external facts against the installed dependency version and authoritative upstream material before implementation; do not infer shipped support from an example.

Read [runtime lowering](docs/runtime-lowering.md) when choosing Rust substrates or designing implementation registries, services/Layers, Ref specialization, caching/pools, batching, schedules, or streams. Its crate catalogue is a candidate list, not dependency approval or proven semantic equivalence. It supplements the revised design without changing milestones or admitting ordinary generators into the initial compiled subset.

Read [migration tooling](docs/migration-tooling.md) and its [research record](docs/research/migration-tooling.md) when designing analyze/check/fix reports, source compatibility diagnostics, codemods, migration workflows, or agent/editor integration. Migration is a first-class compiler consumer; external tooling handles mechanical transformations while the compiler owns native representability.

# Implementation guidance

## Research and design before planning or implementation

Before creating an implementation plan or starting a new feature, complete and record the preparation below. Do this before drafting the plan or changing feature code.

1. Review prior work: read the relevant project docs, PLAN.md, PROGRESS.md, and existing code. Identify applicable decisions, constraints, milestone acceptance criteria, reusable components, and unresolved questions.
2. Research online: consult current primary sources such as official API documentation, upstream source, specifications, and relevant research. Verify dependency versions and semantic compatibility; do not rely on remembered APIs, old conversation claims, or similarly named primitives.
3. Assess the design: compare feasible approaches and their tradeoffs. Define supported behavior, IR/representation boundaries, effects and resource lifetimes, compatibility obligations, failure cases, and meaningful validation. Resolve what can be reused, generated, adapted, or deferred.
4. Record the findings before proceeding: update an appropriate design/research document under docs/ (or the existing feature document) with source links, versions/date checked, relevant prior decisions, alternatives considered, chosen approach and rationale, assumptions, open questions, and acceptance/validation criteria. Link that record from PROGRESS.md and update the docs index when adding a document.

Keep the record proportional to the work: concise evidence and design decisions are sufficient for a small feature. Mark uncertain claims explicitly. Use the recorded findings to write the plan and guide implementation; revisit them when new evidence changes the design.

## Effect v4 and reference semantics

- Match the Effect v4 API as closely as possible. Mirror upstream module, function and option names, argument order and data-first/data-last conventions, and pipeability so authored `R` code reads like the equivalent Effect v4 program. Where the admitted subset cannot represent a v4 signature, keep the name and shape aligned and document the narrower boundary rather than inventing a divergent API. Prefer exposing a shared underlying node over duplicating behavior under two names.
- Use the Effect best-practices skill and the available Effect API reference when writing or reviewing Effect code. Check every applicable pattern against v4; examples from other versions may differ. Prefer installed types/source and public APIs, then authoritative upstream docs when needed.
- Build the compiler itself with Effect Services/Layers, typed errors, and scoped filesystem/process dependencies. Keep CLI functionality available through the same library API.
- Interpret compiled Effect IR through official Effect. Preserve Schema and shared RPC/HTTP contracts; avoid a second JS runtime or wholesale scheduler port.
- Port subtle native algorithms selectively and compare their observable behavior with Effect. Treat cancellation, asynchronous cleanup, and Layer identity as semantics to verify.

## IR and semantic kernel

- Use **IRType** for the public semantic type witness in new code (earlier documents call it CType). Prefer pipeable typed factories and focused immutable combinators over object spreading. Use typed semantic objects/references for types, operations, capabilities, effects, requirements, targets and law subjects; serialize IDs only at boundaries. End-user code, examples and tests must not require casts.
- Use Effect Match with exhaustive tagged handlers for IR unions and built-in predicates for Effect data types; avoid manual `_tag` comparisons.

- Every compiled value needs an IRType witness and known native representation. Keep semantic type, native memory, wire encoding, and storage mapping separate.
- Builder callbacks receive symbolic inputs. Initially represent branching and iteration through Match, predicates, and structured combinators; ordinary build-time TypeScript remains unrestricted.
- Keep pure expressions, effectful computations, and deterministic state-transition data distinct. Make nondeterministic inputs such as time, randomness, and generated IDs explicit effects/data.
- Operations describe input/output types, effects, requirements, capabilities, law evidence, and implementations. Derive dependency/support information from reachable IR, using semantic identities rather than display names.
- Introduce subject-indexed law witnesses and checked traits early. A claim, tested evidence, proven evidence, and trusted builtins are different assurance levels. Test numeric overflow, floating-point, null, Unicode, and ordering semantics before promoting law claims to tested evidence. Use laws for rewrites only when their assurance meets the configured evidence policy.
- Reject unsupported operations when no valid implementation exists. Normalize composition without changing meaning; a backend must implement the IR's semantics rather than substitute its own defaults.

## Compiler planning and native execution

- Follow `check → derive → normalize → plan → verify → optimize → ownership → lower → emit → build`. Expose stages through the public Effect API and keep diagnostics as structured values.
- Record every accepted observable difference from official Effect/Foldkit in [native divergences](docs/native-divergences.md), as well as in its decision record.
- Record selected implementations, rejected candidates, and fallback reasons. Verify capabilities, traits, laws, and compatibility before accepting a plan. Fallback must preserve behavior, bounds, security, and the requested protocol; expose later JS-host requirements explicitly.
- Start ownership conservatively: copy primitives, move single-use values, borrow read-only inputs, use obvious exclusive mutation, and clone only for necessary duplicated ownership. Add complex scope/fiber lifetime inference when real concurrency workloads exist.
- Use Tokio, Axum/Hyper/Tower, Serde, and SQLx for execution facilities. Keep native runtime code focused on Effect-specific semantics that cannot be erased.
- Distinguish operation implementations, service implementations, and semantic runtime implementations in registration and support reports. Derive reachable requirements, then explain the selected substrate, generated specialization, semantic adapter, and Cargo crates/features. Avoid unconditional dependencies for unused capabilities.
- Verify each supported mapping rather than aliasing similarly named primitives. Queue/PubSub strategies and shutdown, shared Deferred completion, Scope/finalization, Layer identity, cache/pool lifecycle, and Stream/Sink/Schedule semantics need explicit conformance. Direct timer or semaphore lowering still needs the required interruption/resource contract.
- Consider compile-time batching, Schedule state machines, Ref specialization, and stream fusion before adding general runtime machinery. Apply these rewrites only when their supported semantics and evidence justify them; do not infer equivalence from crate availability or reuse-percentage estimates.
- Adapt small Gen2 primitives; consume existing Foldkit Entity/Query IR, protocol schemas, and conformance fixtures where possible. Preserve source semantics in Rust ports. Defer extracting a shared cross-project kernel.
- Follow [observability](docs/observability.md) for provenance, logging, tracing and metrics work. Preserve semantic identities separately from source/use-site metadata, keep logical/native/distributed traces distinct, and verify event ordering/context/export policy against official Effect. Select optional crates/features by reachable capability; preserve machine stdout and do not install globals from libraries.
- Follow [source-map contracts](docs/source-maps.md) for authored locations and generated diagnostics. Preserve explicit coordinate units, shared use/definition origins, transform ancestry and exact emitted-byte digests; use MagicString only for AST-located source edits. A standard point map or native backtrace cannot replace logical occurrence provenance.
- Follow [metadata ownership and costs](docs/metadata-cost.md): native values stay plain, provenance is build-owned/external, and dynamic annotations belong to execution context. Keep capture/artifact/instrumentation opt-outs independent; measure retained/peak compiler heap and disabled native allocation/layout costs before replacing direct references or adding frame storage.
- Grow [typed Rust emission helpers](docs/rust-emission.md) around verified IR and one source writer as lowering needs them; validate identifiers/literals and distinguish type/expression/item roles. Editor integration follows [the Volar/tooling design](docs/editor-tooling.md), with revision/lifecycle/checker compatibility and safe feature projections.
- Keep Cruster optional and later. Ordinary programs should not acquire distributed dependencies. Browser Effect RPC compatibility and internal cluster RPC remain separate boundaries.

## Scope and validation

- Follow the current milestone and its acceptance criteria. Prove a small complete path through IR, reference execution, validation, and native lowering before expanding the surface.
- Use Query → Rust parity as the first meaningful workload, then general functions/basic Effect IR, unary RPC with early middleware, RemoteServer, SQLx, streaming/Scope/interruption, Remote live, SSR, and resume.
- Defer broad concurrency, advanced cross-fiber ownership, law-driven optimization, distributed execution, syntax widening, and hybrid hosting until their workloads and conformance foundations are ready.
- Use meaningful differential/conformance tests: operations and law properties; Query evaluator/Drizzle/Rust; JS/native RemoteServer; official RPC client/native server; Effect↔Rust codecs; stock Foldkit hydration/resume; observable Exit/Cause and finalizer/interruption traces.
- Record exact validation commands and results, including existing failures. Distinguish cached builds from fresh validation and proposed capabilities from implemented support.

## Migration tooling

- Analyze the requested native target's reachable graph. Preserve already supported code, browser-only code, and unrelated logic; never rewrite working code merely to make it look more native.
- Reuse an established AST/workflow platform such as the Codemod candidate instead of implementing a custom codemod framework. Keep the adapter replaceable and validate/pin its supported version before use.
- Separate mechanical fixes with established preconditions from compiler-guided choices and architectural migration. Register diagnostic/fix IDs, applicability, supported targets/versions, and semantic evidence centrally for CLI/editor/agent/CI consumers.
- Use structured diagnostics and the public compiler API for analyze/check/repair. A passing check establishes representability for a supported profile; verify rewrite equivalence with semantic/conformance tests and builds.
- Record meaningful choices and unresolved cases. Do not silently replace locale/numeric/concurrency semantics, change target/host requirements, or claim success by suppressing diagnostics. Migration into supported R builders remains separate from later source syntax widening.

# Work, commits, and review

- Commit early and often in focused conventional commits. Stage only files belonging to the task; preserve unrelated user work.
- Use subagents only when needed. Apply common sense: handle routine edits and self-review directly; delegate when complexity, uncertainty, or an independent review materially helps. Do not automatically spawn a subagent after every bout of work or commit.
- Git commit hooks are intentionally disabled. Keep checks explicit; do not add pre/post-commit hooks or reinstall a hook dispatcher without a user request.
- Prefix commits addressing review findings with `review(<scope>):`, for example `review(docs): fix milestone navigation`.
- Update PROGRESS.md with completed work, validation, remaining questions, and review outcomes. Keep PLAN.md, AGENTS.md, and the docs index aligned when design direction changes.
- Keep [docs/open-work.md](docs/open-work.md) current: add a linked line whenever work is deferred, refused for later or left open, and delete it when the work is done.
- Preserve original discussion content during document migrations. Extraction scripts are one-time tools; maintain split documents directly and verify links, contents anchors, and precedence notes.

## Commit cadence

- **Commit often.** Prefer small, coherent commits over one large one. Commit as
  soon as a unit of work stands on its own (a module, a config, a test file).
- **Push often.** Push reviewed, validated commits regularly to the current
  branch's configured remote rather than accumulating unpublished work.
- Stay in the current workspace and branch. Do not create worktrees or branches
  unless the user explicitly requests them.
- **After every commit, double check the code.** Re-read the diff that was just
  committed, re-run the relevant checks (`pnpm typecheck`, `pnpm test`,
  `pnpm build`), and fix what the check surfaces in a follow-up commit rather
  than letting it accumulate.

For this Vite+ workspace, use the corresponding checks: `vp check`, the relevant
strict TypeScript check, `vp test`, and `vp run -r build`.

## Reviewing a commit

When re-reading a commit, check each of these deliberately:

- **Logic and correctness.** Does it do what the message claims? Trace the real
  control flow, not the intended one.
- **Edge cases.** Empty, missing, duplicate, already-aborted, out-of-order,
  called-twice, called-after-dispose.
- **Synergy with existing features.** Does it compose with what is already here,
  or does it bolt on a second way to do the same thing?
- **Types and TypeScript DX.** No accidental `any` (especially from
  `Parameters<>` on intersections or circular conditionals). Errors should land
  at the mistake and read clearly. Inference should work at the call site
  without annotation ceremony.
- **Comments.** Explain why, not what. Delete any comment that restates the code.
  Doc comments on public API, none on the obvious.
- **Tests.** See below -- they must be able to fail.
- **Security hardening.** Untrusted input crosses a validation boundary before
  anything else; capability and authorization checks cannot be skipped; failures
  do not leak internals.
- **Performance.** Work done once at definition time rather than per call;
  no accidental O(n) lookups or repeated derivation in a hot path.

Fix what the review finds in a follow-up commit rather than letting it sit.

Tests must assert observable behavior, meaningful failure cases, or type-level
contracts, and fail when those obligations are violated. Prefer differential and
conformance evidence over tests that merely repeat the implementation.

**After every bout of work or commit, double check and review.**
