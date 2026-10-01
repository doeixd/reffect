# Editor integration and Volar

[Checked research](research/metadata-and-editor-tooling.md) · [Migration tooling](migration-tooling.md#editor-tooling) · [Source maps](source-maps.md)

Volar is useful as an optional virtual-document/editor infrastructure candidate. It does not need to enter the semantic compiler or native runtime. Current R builders are ordinary typed TypeScript; existing TS/Effect tooling already provides their basic inference/completion. No Volar integration or package dependency is implemented.

## What Volar supplies

Volar's language core owns source snapshots and virtual code, embedded documents, associated scripts and mapping caches. Language-service/server packages adapt editor features, with kit, Monaco and VS Code consumers. Mappings can enable verification, completion, semantic information, navigation, structure and formatting independently. This is valuable for generated previews and a future mixed-language frontend, where generated glue should not offer misleading renames/fixes.

Volar does not supply native representability, Effect semantics, executed source occurrences, Rust lowering or ownership analysis. Its mapping format is offset arrays with feature data, not ECMA-426 v3 or our provenance graph. Its ordinary offset translation must not be treated as exact correspondence between a generated Rust expression and an authored TypeScript expression.

Reviewed upstream commit and observed npm release `2.4.28` are recorded in the research note. No editor/Rust service integration has been tested. `@volar/typescript` uses JS TypeScript language-service hooks; compatibility with this workspace's TypeScript 7.0.2 native checker and Effect-tsgo must be established separately. Do not replace or run a duplicate TypeScript checker merely to display native diagnostics. Pin a compatible editor-side JS service only if an actual virtual-TS consumer requires it. Documentation examples can lag implementation; build against the tested package declarations.

## First useful editor slice

1. Consume the public compiler's structured diagnostics, selected target, explanation and exact source revisions. Publish authored locations with native related information/code/stage and mapping precision. Preserve stale/missing-map explanations. This can start as a small LSP/editor adapter without Volar or a virtual TS transform.
2. Offer an explicit, read-only generated Rust preview for a validated build. Hover or navigation can show the selected native signature/implementation and related definition/use sites. Keep generated names distinct from authored symbol identity. Compiler explanations remain the authority.
3. Add Volar language-core/service infrastructure when bidirectional virtual-document navigation or a frontend with embedded code warrants it. Project immutable source/Rust snapshots and mappings from compiler artifacts; never evaluate arbitrary unsaved TS modules in a language server just to build their IR. A safe AST/static authoring adapter or explicit background build is required.

Keep project state scoped and revision-keyed. Cancel/discard results for superseded documents, bound snapshot/mapping memory, and dispose closed projects/replaced revisions. Volar's weak snapshot caches are useful here, but active script registries still retain snapshots. The adapter must respect authoring capture/artifact policies and avoid globally retaining every compilation.

## Mapping and feature policy

The TS snapshot uses UTF-16 offsets. Convert generated Rust UTF-8 ranges to UTF-16 positions against the exact generated snapshot for an editor adapter; negotiate LSP position encoding rather than assume every client uses the same unit. Do not pass raw rustc bytes into Volar offsets. Cache revision-specific indexes and cover astral Unicode, CRLF and unmapped boundaries.

For a compiler origin association, display the whole authored range and related sites. Use precise token mappings only where the producer proves them. Volar accepts endpoints/unequal-length translations differently from our resolver; explicitly adapt half-open gaps/precision rather than passing origin ranges as if they were character-for-character transformations. Keep origin/use/definition IDs in adapter-side records; generic editor mappings are a projection.

Generated scaffolding gets no authored completion/navigation/verification capabilities. Associated regions initially permit only supported diagnostic display/read-only hover/navigation. A navigation mapping does not automatically authorize rename, formatting, refactoring or code actions. Full-document Rust formatting would invalidate exact maps, and rustc suggestions target Rust. Only compiler-registered source fixes with proven inverse-edit conditions may edit TS. Multi-file rename needs actual symbol linkage and refusal for ambiguous/generated-only names.

Setting `languageId: "rust"` does not install rust-analyzer or prove Volar has a Rust service bridge. Start with our already-mapped Cargo diagnostics. A future native-service bridge needs tested document URIs, snapshots, related diagnostics, cancellation and explicit feature policies. Keep TypeScript/Effect diagnostics intact and avoid duplicate/stale emissions.

## Delivery gate

Attach the first compiler-diagnostic/preview adapter to milestones 2–3 tooling, after explicit source provenance and stable artifact policy. Treat a Volar proof of concept as optional: compare it against the smaller direct adapter before choosing packages. It does not delay the next native logging/frame slice or admit arbitrary TS syntax.

Acceptance: tested/pinned APIs and editor checker compatibility; no arbitrary module execution; Unicode/revision/stale-map fixtures; shared definitions with distinct uses; generated gaps without accidental feature leakage; cancellation/disposal and repeated-rebuild memory bounds; preserved TS/Effect diagnostics; no inverse Rust fixes or renames without compiler evidence. CLI/compiler diagnostics remain useful with no editor dependency installed.
