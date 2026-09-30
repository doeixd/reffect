# Progress

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
