# Progress

## 2026-09-30 — Operation/expression design revision

- Read all 5,875 lines of docs/op-expr-revision-convo.md and split its four prior-art discussions and final revised plan into seven focused documents with scripts/Split-DesignConversation.ps1. Exact source reconstruction is checked before repository formatting.
- Replaced the original conversation path with a linked revision overview. Updated docs/README.md, AGENTS.md, PLAN.md, and all six earlier reference docs with relevant cross-links and precedence notes.
- Updated the roadmap to the detailed revised milestones 0–15: kernel/law evidence, Foldkit Query conformance before general Effect IR, early RPC middleware, Remote/SQL/streaming/live/SSR/resume, then codecs, broader concurrency, and optional distributed targets. The final condensed sequence uses different later numbering; the overview records how to interpret it.
- Added explicit knowledge of checked traits, evidence policies, separate capabilities/effects/requirements, explainable planning, conservative initial ownership, deferred shared-kernel extraction, and optional Cruster isolation.
- Compiler implementation remains unstarted. Upstream APIs and licensing observations in the preserved conversation have not been re-verified.
- Validation: `vp install` and `vp check` pass; `vp run -r build` passes using cached workspace results. `vp test` and `vp run -r test` reproduce the unchanged starter's “Vitest failed to find the current suite” failure. `vp env doctor` passes with the previously observed Volta PATH notices.

## 2026-09-30 — Design documentation

- Read the original PLAN.md in full and extracted its six design discussions into docs/ using scripts/Split-Plan.ps1. The script verifies exact body preservation before repository formatting; the final documents match a freshly extracted, formatted copy.
- Replaced PLAN.md with a concise entry point: constraints, document map, consolidated implementation sequence, acceptance evidence, validation strategy, and open decisions.
- Added docs/README.md and linked all design documents from AGENTS.md.
- Compiler implementation has not started; the repository currently contains the Vite+ starter. The design documents describe proposed capabilities and APIs.
- Validation: `vp install`, `vp check`, and `vp run -r build` pass. Both `vp test` and `vp run -r test` fail in the unchanged starter test (`packages/utils/tests/index.test.ts`) with “Vitest failed to find the current suite.” `vp env doctor` passes its checks and reports that several PATH entries use Volta rather than Vite+ shims.
- Subagent review verified all six formatted extractions, local document links, contents anchors, and script refusal behavior. Corrected the preservation note to distinguish exact extraction from subsequent formatting.
