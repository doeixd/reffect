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

<GOAL>
This is an IR / COMPILER for Effect-ts-like code to rust. 
</GOAL>

<PROJECT IMPORTANT INFORMATION>
This is an Effect v4 project. reference the best practices skill and the api docs reference (there is lots of stuff there that is helpful / good) use it to its fullest potential.

Commit early and often, use conventional commits.

After every bout of work or commit. have a subagent review your code, and fix it. Do not forget.

Prefix review commits with review(....
</PROJECT IMPORTANT INFORMATION>

<Important files>
- [PLAN.md](PLAN.md) - start here for the vision, design constraints, consolidated roadmap, and acceptance criteria.
- [PROGRESS.md](PROGRESS.md) - completed work, validation, current status, and remaining questions.
- [docs/README.md](docs/README.md) - index of the detailed design discussions. Read the relevant documents before implementing a feature:
  - [docs/op-expr-revision-convo.md](docs/op-expr-revision-convo.md) - overview of the later design revision, reading order, and changes that supersede earlier proposals.
  - [docs/compiler-design-revision.md](docs/compiler-design-revision.md) - revised semantic kernel, typed laws, checked traits, representation boundaries, compiler passes, and explainable planning.
  - [docs/implementation-milestones.md](docs/implementation-milestones.md) - current detailed milestones 0–15, starting with kernel bootstrap and Foldkit Query conformance.
  - [docs/conformance-and-diagnostics.md](docs/conformance-and-diagnostics.md) - conformance obligations, diagnostics, postponed scope, and todo-fullstack showcase.
  - [docs/foldkit-ir-design.md](docs/foldkit-ir-design.md) - existing Expr/Query reuse, symbolic inputs, dependencies, deterministic transitions, normalization, and semantic identity.
  - [docs/gen2-semantic-kernel.md](docs/gen2-semantic-kernel.md) - Gen2-inspired law witnesses/evidence policy, checked traits, representations, capabilities/effects, and planning.
  - [docs/reuse-strategy.md](docs/reuse-strategy.md) - adaptation, dependencies/contracts, semantic ports, and deferred shared-kernel extraction.
  - [docs/cruster-backend.md](docs/cruster-backend.md) - optional later cluster/durable backend; keep it separate from the base runtime and browser RPC.
  - [docs/architecture.md](docs/architecture.md) - typed DSL/IR, CType/Schema, ownership, Services/Layers, fibers/Scope, platform lowering, validation, and operation registry.
  - [docs/rpc-mvp.md](docs/rpc-mvp.md) - shared RPC contracts, unary JSON/HTTP, and the stock-client MVP.
  - [docs/rpc-protocol.md](docs/rpc-protocol.md) - middleware, streaming/backpressure, cancellation, sessions, serializers, and transports.
  - [docs/compiler-api.md](docs/compiler-api.md) - Effect-based compiler library, build specs, services/stages, diagnostics, watch/dev, and thin CLI.
  - [docs/foldkit-ssr.md](docs/foldkit-ssr.md) - server rendering, routing/init/view, hydration, SSG, and HTML streaming.
  - [docs/foldkit-remote.md](docs/foldkit-remote.md) - native RemoteServer, Query IR/conformance, Sources, SQLx, live data, and SSR resume.

The docs preserve evolving proposals, including provisional APIs, historical upstream/licensing claims, and unresolved citation placeholders. Check PROGRESS.md and code for actual support; verify Effect v4 API details against installed dependencies before implementation. Start with the revision overview and revised design/milestones for current direction, then consult the earlier topic docs for details. PLAN.md follows the detailed revised milestones where discussions suggest different orderings or numbering.

Current design priorities: typed law/evidence and checked traits enter the kernel early; Foldkit Entity/Query conformance is the first meaningful workload; the compiler exposes check/derive/normalize/plan/verify/optimize/ownership/lower/emit/build and explains valid implementation choices. Defer shared-kernel extraction, complex cross-fiber ownership, broad concurrency, law-driven optimization, and Cruster integration until their workloads and conformance foundations are ready.
</Important files>
