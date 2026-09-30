# Progress

## 2026-09-30 — Milestone 1 Foldkit encoded-primitive Query profile

- Added direct consumption of published `foldkit-entity@0.4.0` Expr/Query through `Foldkit.compile/build/run` and `Compile.fromFoldkitQuery`. Checked snapshots preserve Entity owner tokens and field/input witnesses, reject unsupported representations, derive memoized support reports, and lower each shared expression node once. Artifacts explain selected generated operation implementations and have no Cargo dependencies.
- Generated Rust accepts dynamic encoded input/row vectors through a versioned stdin bridge, borrows UTF-16/f64/boolean/null scalar values and returns ordered row indices. It preserves complete original row objects, SQL unknown under nested comparisons, where short-circuiting, stable ordered ties, exact string equality and nonfinite numeric equality. Cargo now shares a GeneratedFiles contract and scoped stdin execution across compiler consumers.
- Added a runnable Query search example, public API docs and strict type contracts. Every one of the 27 published conformance cases agrees across official evaluate, upstream Drizzle compileWhere/compileOrderBy over real Node SQLite, and fresh native debug/release crates. Additional cases cover nullable/missing values, escaped/lone-surrogate strings, stable/boolean ordering, malformed input, decoded timestamps, source mutation snapshots and depth-128 shared graphs.
- Recorded user-requested Foldkit-Plus findings and reproductions in [the issue document](docs/research/foldkit-plus-issues.md): Unicode/NUL containment disagreement, exponential ownership/dependency walks, mutable clauses, identity loss in dependency reports, and Remote/Drizzle's incompatible `effect/unstable/rpc` import under RC.118. Both upstream repositories are cloned outside this checkout; no upstream code was changed or issues posted.
- Drizzle's incompatible Remote dependency chain requires a test-only MIT-licensed snapshot of its unchanged query compiler at upstream `f98f4d5cbaebb7aecf2ec636dd198fae01db5b1c`. Pinned Drizzle RC.4's declarations fail TypeScript 7, so skipLibCheck excludes dependency declarations while authored sources, tests and type contracts remain strict. The initial apparent missing build output was disproven by registry tarball inspection and reinstall; it is not recorded as a confirmed packaging defect.
- Validation: `vp check` passes without warnings; `vp exec tsc -p packages/reffect/tsconfig.json --noEmit` passes; `vp test` passes all 21 tests (four files), including fresh native debug/release conformance; `vp run -r build` passes with reffect rebuilt freshly and starter builds cached; both `vp exec node --experimental-transform-types examples/expr/main.ts` and `examples/query/main.ts` pass fresh native/reference validation.
- Self-review traced support/type/identity boundaries, cycle/DAG handling, stdin arity and scalar encoding, index output validation, immutable artifact snapshots, sort stability and scoped cleanup. Sort keys are validated before Rust sorting so nullable/nonfinite keys cannot create an inconsistent comparator. No law-driven rewrite or general native Effect runtime was added.
- Committed implementation as `3be927c`; re-read the committed compiler/runtime/Cargo diff and repeated root checking, strict TypeScript, all 21 tests with fresh native crates, and workspace builds (cached). No review corrections were required. `GIT_TERMINAL_PROMPT=0 git push origin master` failed because this environment has no GitHub username/credentials; the implementation is committed locally and not published.
- Publication resolved after user-authorized GitHub CLI device sign-in as `doeixd`: pushed `3be927c` and `2698c03` to origin/master. The preconfigured GH_TOKEN worked for API reads but returned HTTP 401 for Git pushes; this checkout's GitHub credential helper uses the newly stored CLI sign-in without the environment token overriding it.
- Supported limits: evaluated containment operands must be non-NUL ASCII; when two or more rows survive, every order key must be present and numeric keys finite. Text ordering follows JS UTF-16, with no universal SQL collation claim. Reachable objects/arrays/bigint/opaque scalar schemas, decoded Date values, non-field ordering and implicit domain encoding remain unsupported. Structured result rows are preserved rather than interpreted field-by-field.
- Next: milestone 2 general compiled functions, Match/Predicate and basic Effect IR, following its required research/design preparation. Native SQLx, Remote, RPC, concurrency and later workloads remain unimplemented.

## 2026-09-30 — Foldkit Query preparation

- Reviewed milestone 1 and the current arithmetic compiler; inspected Foldkit-Plus at `f98f4d5cbaebb7aecf2ec636dd198fae01db5b1c`, published Entity/Drizzle packages, Effect RC.118 Schema/process APIs, Rust stable sorting and ECMAScript string comparison.
- Recorded the selected direct-IR adapter, encoded primitive profile, upstream Unicode containment discrepancy, dependency-free evaluator bridge and acceptance checks in [Foldkit Query research](docs/research/foldkit-query.md). Implementation and conformance results follow below when validated.

## 2026-09-30 — Milestone 0 arithmetic compiler path

- Implemented `packages/reffect` with immutable, pipeable IRType/Expr/Fn/Program factories, typed semantic references, operation signatures/metadata, subject-indexed laws and evidence policy. `R.U64` is exact bigint/u64 with modular add/sub/mul; data-first and data-last arithmetic preserve tuple inference without user casts.
- Added the official Effect v4 reference evaluator, structured diagnostics, public check/derive/normalize/plan/verify/optimize/ownership/lower/emit/build API, Compiler/Cargo services, explainable implementation selection, Rust library/evaluator emission, and scoped offline Cargo validation. Pure Expr rejects effects/requirements; the backend refuses unregistered operations/representations and invalid plans. Law registrations remain claims; normalization/optimization are identity stages and ownership is primitive copy.
- Added `examples/expr/main.ts`, package usage docs and strict type-contract fixtures. User examples/tests have no casts or semantic-object spreading. IR consumers use exhaustive Effect Match handlers and built-in Exit predicates.
- Pinned Effect/platform-node to 4.0.0-rc.118, installed language-service editor support, and aligned utils Vite+ to 0.3.2. The prior starter suite-detection failure is resolved. Native conformance covers 23 cases in both debug/release, plus public build/evaluator failure and overwrite-refusal behavior.
- Native setup initially found Coreutils `link.exe`; installed minimal Visual Studio Build Tools 18.10.2 C++ compiler/Windows SDK components and validated under `VsDevCmd.bat -arch=x64 -host_arch=x64`. No global PATH change or alternate semantic backend was added. See [research/evidence](docs/research/semantic-kernel.md) for exact dependencies, decisions and installer outcomes.
- Added the requested commit/push cadence, current-branch/workspace constraint, and deliberate post-work/post-commit review checklist to AGENTS.md.
- Published `962bb9d` (compiler path) and `cb99634` (review corrections) to origin/master after post-commit validation. Task-scoped `vp check` passes without warnings; `vp exec tsc -p packages/reffect/tsconfig.json --noEmit` passes; `vp test` passes 12 tests, including fresh Cargo debug/release builds and shared-DAG native parity; `vp run -r build` passes (the review change rebuilt reffect freshly; the post-commit repeat was cached). `vp exec node --experimental-transform-types examples/expr/main.ts` passes native/reference overflow parity.
- Full-root `vp check` is blocked by formatting in four concurrently added, untracked documents: docs/effect-adjacent-projects.md, docs/effect-ecosystem.md, docs/effect-schema.md and docs/effect-v4-api-scope.md. These files are preserved and excluded from task commits; all task files pass scoped checking.
- Review checked binder/type/arity boundaries, semantic identity collisions, evidence policy, target capabilities, output exclusivity, native failure reporting and call-site inference. Windows cleanup of a failed child process takes about 60 seconds through the official Node process adapter; successful native parity runs take about 9 seconds. This is an upstream/platform integration limitation to investigate before broader process-heavy workloads, not a skipped failure test.
- Independent review identified mutable builtin Schema internals and exponential expansion of shared expression graphs. The follow-up freezes the local checked Schema/AST/checks and lowers shared applications into dependency-ordered Rust locals. Regression tests cover both failures, and independent follow-up review plus strict/non-native checks found no corrections; main-agent fresh native validation also passes.
- Remaining roadmap: milestone 1 Foldkit Entity Expr/Query adaptation and existing evaluator/Drizzle/Rust conformance. General Effect IR, RPC, runtime adapters, migration and later milestones remain unimplemented.

## 2026-09-30 — Semantic kernel preparation

- Reviewed the revised kernel and milestone acceptance alongside the starter workspace; checked primary Gen2, Effect v4 migration, package registry, and Rust arithmetic sources.
- Recorded the milestone 0 design and validation obligations in [docs/research/semantic-kernel.md](docs/research/semantic-kernel.md). Implementation follows that record: bigint/u64 modular arithmetic, explicit symbolic IR, public Effect stages and scoped platform dependencies.
- Incorporating user-directed authoring refinements: IRType naming, pipeable typed factories/combinators, typed semantic references, and cast/spread-free examples/tests; rationale and API source checks are recorded in the same research document.

## 2026-09-30 — Commit hooks and discretionary delegation

- Removed the tracked pre-commit hook, staged-file configuration, and package prepare script that installed the Vite+ dispatcher. Disabled the local dispatcher, removing its generated pre/post-commit shims and hooksPath; installs no longer recreate it.
- Updated AGENTS.md to use subagents only when needed, with direct self-review for routine work, and to keep commit hooks disabled unless requested. Aligned PLAN.md with the discretionary review guidance.
- Self-reviewed this routine configuration/documentation change. `vp install` and `vp check` pass; hook status after installation confirms disabled preference, unset hooksPath, missing dispatcher, and no project hooks. `vp test` reproduces the known starter suite-detection failure.

## 2026-09-30 — Section-local design update links

- Added 48 **Later update** notes beside affected sections in PLAN.md and 13 earlier design references. Notes link directly to revised kernel/passes, Query-first milestones, early RPC middleware, conservative ownership, optional Cruster, runtime registry/adapter guidance, migration diagnostics/validation, and the reffect/R naming decision.
- Distinguished superseded sequencing from additive detail while preserving the historical discussion bodies and examples. The docs index explains how to read these notes; existing top-level precedence guidance remains in place.
- Validation: all 62 breadcrumb file/heading links resolve; `vp check` and workspace builds pass (website cached, utils rebuilt). `vp test` reproduces the previously documented starter Vitest suite-detection failure. No feature code or dependencies changed.
- Subagent review found no actionable issues and independently verified the update/index links, design precedence, milestone scope, and preserved historical bodies.

## 2026-09-30 — Migration design preparation

- Reviewed prior compiler/API/milestone/conformance/runtime references and researched current Codemod, Effect-tsgo, upstream Effect migration material, and Grit/GritQL pages before integrating the supplied migration proposal.
- Recorded sources, date/version limits, alternatives, design constraints, acceptance, and open questions in [docs/research/migration-tooling.md](docs/research/migration-tooling.md). Codemod remains a candidate; no tool dependencies or migration implementation are added. A passing native check establishes representability, not source-rewrite semantic equivalence.
- Integrated the supplied conversation into docs/migration-tooling.md and linked design/research from PLAN.md, AGENTS.md, the index, and relevant API/compiler/conformance/milestone/reuse references. All migration commands, packages, and agent-skill layouts remain proposals; target scope and existing core milestone order are preserved.
- Research/preparation review found no corrections to design or source claims; its request to index the research record is addressed by the migration integration.
- Validation: `vp check` passes; workspace builds pass using cached results. Root/workspace tests reproduce the documented starter Vitest suite-detection failure; no feature code was changed.

## 2026-09-30 — Project naming and GitHub publication

- Recorded the user's canonical project name `reffect` and compiled DSL namespace `R` in AGENTS.md. Earlier Effect Native/effect-native and C examples remain historical context; naming does not imply existing exports.
- Published the reviewed project and existing starter workspace to [doeixd/reffect](https://github.com/doeixd/reffect) as a public GitHub repository using gh. Added a project README, design-stage About description, and topics: effect, effect-ts, typescript, rust, compiler, semantic-compiler, intermediate-representation, ahead-of-time, codemod, and vite-plus. Verified public visibility, metadata, and the master default branch; origin tracks the GitHub repository.
- Subagent review confirmed migration design coverage, target/profile boundaries, semantic verification limits, naming guidance, links, and accurate publication status. Removed starter package author/repository/homepage/bugs placeholders identified during review before publication.

## 2026-09-30 — Preparation before features and plans

- Added an explicit AGENTS.md requirement to review prior docs/code, research current primary sources online, assess the design and alternatives, and record evidence/decisions before creating an implementation plan or changing feature code.
- Research/design records belong in the relevant docs/ reference, with source links, checked versions/dates, rationale, uncertainties, and validation criteria; PROGRESS.md links the record and the docs index tracks new documents.

## 2026-09-30 — Rust substrate and semantic adapter guidance

- Added docs/runtime-lowering.md from the supplied conversation, integrating one copy of the duplicated passage and cleaning formatting. It retains the mapping catalogue, specialization/wiring examples, caching/pools, batching, Schedule/Stream, runtime boundaries, and implementation-research leads as proposals.
- Integrated direct/generated lowering, substrate adapters, dedicated semantic runtime, and separate operation/service/semantic implementation registries into PLAN.md and AGENTS.md; cross-linked the docs index and relevant design, reuse, architecture, API, milestone, and conformance references.
- Made semantic parity and reachable Cargo dependency selection explicit acceptance obligations. Clarified that timer/semaphore mappings may need interruption handling, similarly named Sink/collection primitives require semantic comparison, percentages are unmeasured, and ordinary Effect.gen authoring belongs to later syntax support.
- No crate dependencies or compiler features were added; the revised milestone order remains unchanged. External API/crate claims and original unresolved citation placeholders are not newly verified.
- Validation: `vp install` and `vp check` pass; `vp run -r build` passes using cached workspace results. `vp test` and `vp run -r test` reproduce the existing starter's “Vitest failed to find the current suite” failure. `vp env doctor` passes with the existing Volta PATH notices.
- Subagent review found no blocking issues: major conversation topics are retained, registry families and semantic obligations are clear, candidate mappings remain provisional, builder-only scope/milestones are unchanged, and local Markdown links resolve.

## 2026-09-30 — Operation/expression design revision

- Read all 5,875 lines of docs/op-expr-revision-convo.md and split its four prior-art discussions and final revised plan into seven focused documents with scripts/Split-DesignConversation.ps1. Exact source reconstruction is checked before repository formatting.
- Replaced the original conversation path with a linked revision overview. Updated docs/README.md, AGENTS.md, PLAN.md, and all six earlier reference docs with relevant cross-links and precedence notes.
- Updated the roadmap to the detailed revised milestones 0–15: kernel/law evidence, Foldkit Query conformance before general Effect IR, early RPC middleware, Remote/SQL/streaming/live/SSR/resume, then codecs, broader concurrency, and optional distributed targets. The final condensed sequence uses different later numbering; the overview records how to interpret it.
- Added explicit knowledge of checked traits, evidence policies, separate capabilities/effects/requirements, explainable planning, conservative initial ownership, deferred shared-kernel extraction, and optional Cruster isolation.
- Compiler implementation remains unstarted. Upstream APIs and licensing observations in the preserved conversation have not been re-verified.
- Validation: `vp install` and `vp check` pass; `vp run -r build` passes using cached workspace results. `vp test` and `vp run -r test` reproduce the unchanged starter's “Vitest failed to find the current suite” failure. `vp env doctor` passes with the previously observed Volta PATH notices.
- Subagent review verified formatted extraction parity for all seven bodies, local file links, extraction refusal behavior, and revised milestone sequencing. Fixed repeated Acceptance contents links and added duplicate-heading counters to the extraction script.
- Expanded AGENTS.md at the user's request with the semantic compiler goal, concrete workload/showcase targets, design precedence, Effect v4 guidance, IR/evidence rules, compiler planning, scope/conformance guidance, and commit/review workflow.
- Follow-up review confirmed the anchor fix and formatted extraction parity; clarified AGENTS.md to allow early claim-level law registration while gating tested evidence and rewrites appropriately.

## 2026-09-30 — Design documentation

- Read the original PLAN.md in full and extracted its six design discussions into docs/ using scripts/Split-Plan.ps1. The script verifies exact body preservation before repository formatting; the final documents match a freshly extracted, formatted copy.
- Replaced PLAN.md with a concise entry point: constraints, document map, consolidated implementation sequence, acceptance evidence, validation strategy, and open decisions.
- Added docs/README.md and linked all design documents from AGENTS.md.
- Compiler implementation has not started; the repository currently contains the Vite+ starter. The design documents describe proposed capabilities and APIs.
- Validation: `vp install`, `vp check`, and `vp run -r build` pass. Both `vp test` and `vp run -r test` fail in the unchanged starter test (`packages/utils/tests/index.test.ts`) with “Vitest failed to find the current suite.” `vp env doctor` passes its checks and reports that several PATH entries use Volta rather than Vite+ shims.
- Subagent review verified all six formatted extractions, local document links, contents anchors, and script refusal behavior. Corrected the preservation note to distinguish exact extraction from subsequent formatting.
