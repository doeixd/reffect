# Operation and expression design revision

The original conversation has been split into the seven documents below. All discussion bodies, examples, and diagrams were extracted by script, then formatted with the repository formatter. This page keeps the original entry path useful.

[Roadmap](../PLAN.md) · [Documentation index](README.md) · [Implementation status](../PROGRESS.md)

## Reading order

| Document                                                                             | Read for                                                                                                                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Foldkit Expr and Operation design](foldkit-ir-design.md)                            | Symbolic inputs, dependency analysis, declared backend support, deterministic transitions, normalization, stable identity, and direct Entity/Query reuse           |
| [Gen2 semantic kernel and typed laws](gen2-semantic-kernel.md)                       | Typed law witnesses, evidence/trust policy, checked traits, distinct effects/requirements/capabilities, representations, compiler passes, and explainable planning |
| [Reuse and adaptation strategy](reuse-strategy.md)                                   | What to adapt from Gen2, consume from Foldkit-Plus/Effect, port semantically, or defer; historical licensing observations                                          |
| [Optional Cruster distributed backend](cruster-backend.md)                           | Cluster entities, persisted delivery, workflows, durable activities/timers, internal RPC, and isolation from the base runtime                                      |
| [Revised compiler design](compiler-design-revision.md)                               | Revised plan sections 1–13: architecture, reuse, repository shape, CType/Operation/Law/Trait, passes, explain API, and CLI                                         |
| [Revised implementation milestones](implementation-milestones.md)                    | Revised plan sections 14–40: milestones 0–15, conservative ownership, RPC/Remote/SQL/streaming/SSR, later concurrency and distributed targets                      |
| [Conformance, diagnostics, and the fullstack target](conformance-and-diagnostics.md) | Revised plan sections 41–46 and final principle: test obligations, diagnostics, postponed scope, condensed sequence, and todo-fullstack showcase                   |

## What changes relative to the earlier plan

- Operations carry semantic definitions and typed law evidence, alongside target implementations. Law metadata enters the kernel early; optimizations using it wait for mature conformance and evidence infrastructure.
- Separate backend capabilities, program effects, service/resource requirements, checked traits, and laws. Keep semantic type, native, wire, and storage representation boundaries explicit.
- Use `check → derive → normalize → plan → verify → optimize → ownership → lower → emit → build`. Make implementation choices, rejected options, and permitted fallbacks inspectable through the public compiler API.
- Bootstrap a small kernel by adapting Gen2 primitives. Consume Foldkit Entity Expr/Query and existing conformance fixtures; defer extracting a shared cross-project kernel until the common subset is demonstrated.
- Make Foldkit Query → Rust conformance the first meaningful workload after the kernel smoke test. General compiled functions/Effect IR follow; unary RPC remains the first major public demo.
- Sequence RemoteServer, SQLx, streaming/Scope/interruption, Remote live, SSR, and resume toward `examples/todo-fullstack`. Start ownership conservatively and expand cross-fiber analysis with broader concurrency later.
- Keep Cruster an optional later distributed/durable implementation. Stock browser Effect RPC stays a separate boundary from internal cluster RPC.

## How to resolve differences

[PLAN.md](../PLAN.md) summarizes the current roadmap from the numbered revised milestones. The revised design and milestone documents take precedence over earlier proposals on the changes listed above; earlier docs retain useful detailed semantics and examples.

The conversation itself contains evolving proposals: it discusses a shared kernel before deferring extraction, and its final condensed sequence numbers some later steps differently from the detailed milestones. Use the detailed milestone numbering (0–15) for planning, with hybrid hosting after native semantics are solid; the condensed sequence remains preserved for context.

Exact APIs, package names, upstream compatibility, and licensing statements remain proposals or historical observations. Check installed dependencies, upstream specifications, and implementation status before treating them as facts. Semantic fallbacks must preserve the requested behavior and compatibility; unsupported operations must be refused when no valid implementation is available.

## Extraction

[scripts/Split-DesignConversation.ps1](../scripts/Split-DesignConversation.ps1) is a one-time migration tool. It validates all seven boundaries and exact source reconstruction before writing titles, navigation, and contents links; it refuses existing destinations.

```powershell
./scripts/Split-DesignConversation.ps1 -SourcePath <original-conversation.md> -OutputDirectory <destination>
```

Use a copy of the original, unsplit conversation as input. Maintain the extracted documents directly; this overview is no longer an extraction source.
