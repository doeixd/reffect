# Effect Native design documents

Start with [PLAN.md](../PLAN.md) for constraints and the consolidated roadmap. Use [PROGRESS.md](../PROGRESS.md) for implementation status.

| Document                                        | Focus                                                                                                                       |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [Compiler architecture](architecture.md)        | Full compiler thesis, typed DSL/IR, Schema, ownership, Effect runtime semantics, platform backends, and original milestones |
| [RPC MVP](rpc-mvp.md)                           | Shared Effect contracts and the first native unary RPC demonstration                                                        |
| [RPC protocol and transports](rpc-protocol.md)  | Streaming, middleware, cancellation, bidirectional sessions, serialization, and transport profiles                          |
| [Compiler library API and CLI](compiler-api.md) | Effect-based compiler services, build specifications, stages, diagnostics, watch/dev, and CLI                               |
| [Foldkit SSR and SSG](foldkit-ssr.md)           | Native server rendering and compatibility with the existing browser hydration protocol                                      |
| [Foldkit Remote and SQL](foldkit-remote.md)     | Native RemoteServer, Entity/Query semantics, Sources/storage, SQLx, live data, and SSR resume                               |

These six documents preserve the original PLAN.md discussions, including code samples, diagrams, provisional APIs, and citation placeholders. They describe intended behavior; they do not establish implemented support or verified upstream API details. Use the roadmap for current sequencing, and verify dependency-specific claims before implementing them.

Edit the individual documents directly as the design evolves. Keep the roadmap and this index aligned with document names and scope.

The one-time extraction script is [scripts/Split-Plan.ps1](../scripts/Split-Plan.ps1). It requires a copy of the original, unsplit plan and a destination directory without these six files:

```powershell
./scripts/Split-Plan.ps1 -SourcePath <original-plan.md> -OutputDirectory <destination>
```

The script validates all six boundaries, refuses to overwrite existing documents, and checks that the extracted bodies reconstruct the source exactly before adding titles, navigation, and contents links. Do not run it on the new roadmap or use it to regenerate maintained docs.
