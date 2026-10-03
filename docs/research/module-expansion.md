# Effect module expansion preparation

Checked 2026-10-02 before implementation planning. The user requested parallel work on missing Effect v4 modules while another instance continues the core plan. This track leaves PLAN.md unchanged and maintains a separate coverage inventory.

## Evidence and priorities

The installed `effect` and `@effect/platform-node` dependencies remain **4.0.0-rc.118**. The [published package manifest](https://unpkg.com/effect@4.0.0-rc.118/package.json) was fetched online and confirms that version. The older API-scope reference is historical; stable-version migration belongs to coordinated dependency work, not these helpers. Each module record verifies its own pinned upstream source and behavior.

Existing code already represents scalars, structs/tagged unions, arrays, records and undefined-or values, with official reference execution and generated Rust. It also supports checked computation composition, typed recovery, bounded sequential resource scopes and resource-bearing Layers. Those foundations permit useful missing modules to specialize into existing IR without a new runtime or changes to native scalar layout.

The first priority is Option and Result: explicit optional/result values unblock ordinary program composition, collection searches and error handling. The next independent work covers missing Effect control-flow helpers, pure collection/predicate combinators and Duration configuration for existing timers/schedules. A separate inventory records all public module families, separates native support from authoring/host tooling, and orders remaining stateful/concurrent modules by prerequisites and observable acceptance gates.

## Decisions

- **EXP-001 — accepted for this batch:** specialize helpers into existing checked IR whenever it preserves semantics. Alternative: add generic interpreter/runtime objects for every upstream module. Specialization reuses conformance, provenance, ownership and native representations; it adds authored IR/code proportional to reachable helpers. It does not establish upstream prototype/branding or unrestricted callback compatibility. Revisit when a required operation cannot be represented or measured generated growth makes specialization unsuitable.
- **EXP-002 — accepted coordination boundary:** agents own new module/test/research files. The parent integrates shared exports and any reviewed minimal shared changes sequentially. The other instance owns the core plan. Alternative: simultaneous edits to shared compiler files would make integration and evidence ambiguous. Revisit for stateful modules that require a coordinated representation/runtime change.
- **EXP-003 — accepted admission rule:** a missing-module inventory is a work queue, not a promise of complete Effect compatibility. Admit each bounded profile only after checked types, pinned reference agreement, native execution where applicable, explicit refusals and cost/dependency review. Authoring-only modules must say so. Revisit coverage and priorities as workloads expose dependencies.

## Validation obligations

Use meaningful differential tests for constructors, branches, callback behavior and edge cases; include native debug/release execution for generated operations. Preserve typed failure versus interruption, scope lifetime and source/frame policies. Do not add author casts, unconditional crates or per-value metadata. Coordinate Cargo builds to avoid resource contention. Integrate cross-module tests, formatting/lint, strict TypeScript and builds; reread committed changes and repeat required checks before publication.
