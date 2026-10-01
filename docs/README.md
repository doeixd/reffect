# reffect design documents

Start with [PLAN.md](../PLAN.md) for constraints and the consolidated roadmap. Use [PROGRESS.md](../PROGRESS.md) for implementation status.

Read the [later design revision overview](op-expr-revision-convo.md) first for current direction. Its revised design and numbered milestones update the earlier kernel, pipeline, reuse, and sequencing proposals.

## Revised design and implementation references

The later [runtime lowering reference](runtime-lowering.md) integrates the supplied Rust-substrate conversation once. It extends implementation selection and registry guidance while retaining the revised milestone sequence.

| Document                                                          | Focus                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Revision overview](op-expr-revision-convo.md)                    | Changes, reading order, and precedence over earlier proposals                               |
| [Revised compiler design](compiler-design-revision.md)            | Semantic kernel, representations, Operation/Law/Trait, compiler stages, API, and CLI        |
| [Revised implementation milestones](implementation-milestones.md) | Detailed milestones 0–15, ownership, RPC/Remote/SQL/streaming/SSR, and later targets        |
| [Conformance and diagnostics](conformance-and-diagnostics.md)     | Test obligations, diagnostics, postponed scope, condensed sequence, and todo-fullstack      |
| [Foldkit IR design](foldkit-ir-design.md)                         | Expr/Query reuse, symbolic inputs, dependency/support analysis, normalization, and identity |
| [Gen2 semantic kernel](gen2-semantic-kernel.md)                   | Typed law witnesses, evidence policy, checked traits, representations, and planning         |
| [Reuse strategy](reuse-strategy.md)                               | Adaptation, public contracts, semantic ports, and deferred common-kernel extraction         |
| [Cruster backend](cruster-backend.md)                             | Optional distributed/durable capabilities and isolation from local execution/browser RPC    |

## Observability design and research

[Observability, logging and source diagnostics](observability.md) defines typed semantic records, provenance/source maps, logical versus native stacks, scoped log/span context, OTel policy/propagation/metrics, selected Rust tools, optional dependency profiles and acceptance/delivery gates. It is the current observability design direction; native capabilities remain planned.

[Observability research](research/observability.md) records pinned Effect RC.118 behavior, primary Rust/OTel/W3C sources and observed releases, alternatives and compatibility gaps checked before integration.

[Source maps and authored diagnostics](source-maps.md) records the implemented explicit builder/range/build-diagnostic foundation and defines planned standard JS maps, authoritative IR-to-Rust provenance/ranges, optional native symbols, MagicString/AST boundaries, coordinate conversions, artifact/privacy policy and delivery gates. It extends the observability design without widening the supported source syntax.

[Source-map research](research/source-maps.md) records standards, coordinate units, MagicString/map-tool versions, compiler and native symbol boundaries, alternatives and acceptance evidence.

[Metadata ownership and costs](metadata-cost.md) explains current compiler/native storage, measured annotation/build overhead, WeakMap tradeoffs, plain native values, independent opt-out policies and failure/context allocation gates. [The research](research/metadata-and-editor-tooling.md) records checked Rust/Volar interfaces and the reproducible probe.

[Editor tooling and Volar](editor-tooling.md) selects a compiler-diagnostic/preview-first path and optional virtual-document integration, with explicit mapping/feature/checker boundaries.

[Typed Rust emission](rust-emission.md) guides composable internal identifier/type/expression/item helpers around the existing IR/source writer as new lowering needs them.

[Facet evaluation](research/facet.md) checks static Rust type reflection against metadata ownership and future Schema/codec consumers. Facet remains an optional candidate; source occurrences/Effect semantics and protocol conformance stay compiler-owned.

## Original detailed references

| Document                                        | Focus                                                                                                                       |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [Compiler architecture](architecture.md)        | Full compiler thesis, typed DSL/IR, Schema, ownership, Effect runtime semantics, platform backends, and original milestones |
| [RPC MVP](rpc-mvp.md)                           | Shared Effect contracts and the first native unary RPC demonstration                                                        |
| [RPC protocol and transports](rpc-protocol.md)  | Streaming, middleware, cancellation, bidirectional sessions, serialization, and transport profiles                          |
| [Compiler library API and CLI](compiler-api.md) | Effect-based compiler services, build specifications, stages, diagnostics, watch/dev, and CLI                               |
| [Foldkit SSR and SSG](foldkit-ssr.md)           | Native server rendering and compatibility with the existing browser hydration protocol                                      |
| [Foldkit Remote and SQL](foldkit-remote.md)     | Native RemoteServer, Entity/Query semantics, Sources/storage, SQLx, live data, and SSR resume                               |

These six documents preserve the original PLAN.md discussions. The seven extracted revision documents preserve the later conversation, including its final revised plan. All retain code samples, diagrams, and provisional APIs; some include unresolved citation placeholders or historical repository/licensing observations. They describe intended behavior, not implemented support or verified upstream facts. Use the roadmap for current sequencing and verify dependency-specific claims before implementation.

Edit the individual documents directly as the design evolves. Keep the roadmap and this index aligned with document names and scope.

Section-local **Later update** notes link earlier proposals to the specific revised decisions or extensions that affect them. Notes identify superseded sequencing where relevant; preserved examples still describe proposals, and a link does not establish implemented support. Use [AGENTS.md](../AGENTS.md#project-goal) for the current reffect/R naming decision.

## Runtime lowering reference

[Lowering Effect onto the Rust ecosystem](runtime-lowering.md) covers the candidate crate/primitive catalogue, direct lowering versus adapters versus dedicated runtime, operation/service/semantic registry families, Layer wiring, Ref specialization, caches/pools, batching, schedules, streams, and support reporting. The duplicated pasted conversation is integrated as one edited reference. Candidate mappings and research leads require verification; coverage percentages are not measured support.

## Kernel research

[Unit semantics and representation](research/unit.md) records exact undefined admission versus Effect's discarding Void schema, Rust unit lowering, internal bridge tokens and composition conformance.

[Bounded logical failure frames](research/failure-frames.md) records explicit-boundary frame semantics, the Effect span-chain oracle, the stderr companion envelope and reference/native path agreement.

[Upstream reconciliation](research/upstream-reconciliation.md) records the retained dynamic Query/Effect/source paths, local prototype preservation, dependency choices, reachable-data validation and Windows failure-test budgets.

[Source-artifact policy preparation](research/source-artifact-policy.md) records the independent Full/None request policy, honest artifact types, skipped provenance/writer/hash work and validation before implementation.

[Basic Effect IR research](research/basic-effect-ir.md) records the synchronous Boolean/u64 success/failure profile, lexical continuation scopes, Result lowering and milestone 2 conformance obligations.

[Semantic kernel bootstrap research](research/semantic-kernel.md) records the milestone 0 numeric semantics, pinned Effect v4 API checks, kernel/registry boundaries, and differential/native acceptance criteria.

[Foldkit Query native bootstrap](research/foldkit-query.md) records pinned upstream IR/fixtures, encoded-value semantics, representation limits, the native evaluator bridge, and three-interpreter validation for milestone 1.

[Foldkit-Plus issue record](research/foldkit-plus-issues.md) documents confirmed upstream discrepancies, traversal/mutability/reporting limitations, and package compatibility findings with reproductions.

## Migration tooling and research

[Compiler-guided migration tooling](migration-tooling.md) integrates the migration conversation: an external codemod engine, compiler-owned compatibility reports, target reachability, mechanical/guided/architectural transformations, diagnostic-linked fixes, JSON/editor/agent workflows, and semantic validation. Commands, packages, and the future migration skill are proposals.

[Migration tooling research](research/migration-tooling.md) records prior-design review, primary-source checks, versions/date limits, alternatives, rationale, acceptance, and open questions before design integration. It distinguishes native representability from rewrite equivalence and corrects the Grit organization versus successor-project maintenance assumption.

## One-time extraction scripts

[scripts/Split-Plan.ps1](../scripts/Split-Plan.ps1) requires a copy of the original, unsplit plan and a destination directory without its six files:

```powershell
./scripts/Split-Plan.ps1 -SourcePath <original-plan.md> -OutputDirectory <destination>
```

The script validates all six boundaries, refuses to overwrite existing documents, and checks that the extracted bodies reconstruct the source exactly before adding titles, navigation, and contents links. Do not run it on the new roadmap or use it to regenerate maintained docs.

[scripts/Split-DesignConversation.ps1](../scripts/Split-DesignConversation.ps1) applies the same preservation/refusal checks to the seven conversation sections:

```powershell
./scripts/Split-DesignConversation.ps1 -SourcePath <original-conversation.md> -OutputDirectory <destination>
```

Use an original, unsplit conversation copy as input. The current op-expr-revision-convo.md is an overview, not an extraction source. Extraction preserves bodies exactly before repository formatting; maintain the formatted documents directly afterward.
