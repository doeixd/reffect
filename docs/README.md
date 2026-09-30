# Effect Native design documents

Start with [PLAN.md](../PLAN.md) for constraints and the consolidated roadmap. Use [PROGRESS.md](../PROGRESS.md) for implementation status.

Read the [later design revision overview](op-expr-revision-convo.md) first for current direction. Its revised design and numbered milestones update the earlier kernel, pipeline, reuse, and sequencing proposals.

## Revised design and implementation references

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
