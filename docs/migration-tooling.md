# Compiler-guided migration tooling

[Roadmap](../PLAN.md) · [Documentation index](README.md) · [Research and design record](research/migration-tooling.md)

This document integrates the supplied migration conversation as an edited design reference. Commands, package names, diagnostic codes, APIs, and layout below are proposals, not implemented tooling. Current primary-source findings and their limits are recorded in the linked research note; unresolved citation placeholders from the supplied text are not treated as evidence.

[Source-map diagnostics](source-maps.md#diagnostics-and-runtime-resolution) locate authored IR origins and preserve native related spans. A rustc replacement edits generated Rust; it is not an authored TS fix unless a compiler-owned rule proves the inverse transformation. MagicString may preserve maps for mechanical AST edits, while the codemod engine and semantic fix registry remain separate authorities.

## Goal and boundaries

Make migration a first-class consumer of Effect Native's semantic analysis and compiler diagnostics. Use an existing codemod platform for mechanical source transformations; keep native compatibility and implementation selection in the compiler. Agents continue editing TypeScript; the semantic compiler performs Rust lowering.

Never rewrite supported working code merely to make it look more native. Analyze only the graph reachable from the selected target/profile, leave browser-only and unrelated code alone, and record choices that affect observable semantics.

```text
existing Effect/Foldkit project
    ↓ target-scoped analysis
compatibility report
    ├── already portable
    ├── mechanically transformable
    ├── agent/human decision
    ├── architectural migration
    └── unsupported semantics
    ↓ eligible codemods and explicit choices
native-compatible TypeScript
    ↓ compiler check and structured diagnostics
repair remaining issues
    ↓ semantic/conformance tests and native build
migration result with remaining limits
```

Migration into the existing symbolic-builder DSL is separate from later source syntax widening. A codemod may replace a restricted generator body with supported composition; it does not teach the initial compiler to parse arbitrary generators, loops, callbacks, or business logic.

## Three transformation layers

| Layer           | Role                                                        | Evidence needed                                                               |
| --------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Mechanical      | Deterministic, constrained AST rewrites                     | Explicit applicability conditions and behavior-preserving fixtures            |
| Compiler-guided | Resolve a diagnostic among possible source/target choices   | Recorded choice and semantic justification; check plus conformance            |
| Architectural   | Redesign opaque logic around portable IR/services/contracts | Surrounding-code analysis, authored design, compatibility and lifecycle tests |

Already portable code is not a transformation task. Unsupported cases remain visible if no valid equivalent or authorized target change exists.

### Mechanical transformations

Candidate rewrites include restricted Effect.gen sequencing into explicit compiled composition, supported branches/ternaries into Match, supported operators into typed intrinsics, symbolic collection operations into Vector combinators, and known service declarations into portable descriptions.

Illustrative source:

```ts
Effect.gen(function* () {
  const user = yield* getUser(id);
  return user.name;
});
```

The conversation proposes a composition resembling:

```ts
getUser(id).pipe(C.Effect.map((user) => user.name));
```

This is schematic. The real rewrite must lower the callee, inputs, callback, and field access into supported typed IR; wrapping an ordinary JS function in C.Effect.map does not itself make it native-compatible. Preserve evaluation order, failures, environment, and lifetime.

Other candidate transformations require comparable conditions:

```text
supported Option branch   → exhaustive Match
eligible loop             → Vector/Effect combinator
typed arithmetic          → matching CType intrinsic
compatible Promise.all    → supported Effect concurrency
eligible local mutation   → semantic update operation
known service constructor → portable service definition
```

These are not globally safe rewrites. Loop exits/order, integer overflow, Promise failure/cancellation behavior, mutation aliasing, and service identity can differ. Apply a codemod only to a supported pattern with established semantics; route ambiguous instances to the other layers.

### Compiler-guided transformations

An unsupported locale-dependent sort may have alternatives: a native comparator, a portable Collation service, later JS-host execution, or leaving the code unchanged. They need not be equivalent. A codemod must not silently replace locale comparison with another ordering or change a standalone target into a hybrid host.

An agent/human uses the diagnostic, surrounding behavior, target, and requirements to choose an approach and records the rationale. Check the result against the selected profile and run semantic tests. If no equivalent choice is established, retain the unresolved diagnostic.

### Architectural migration

An arbitrary async Source implementation may need a portable Query body, compiled service, and native Source contract. There may be no safe local AST rewrite. Review existing docs and code, research current APIs, write a proportional design record, then change the architecture and validate it against the original behavior.

The supplied conversation compares this to Effect version migrations. Treat that as migration philosophy: use upstream API evidence for version changes and separate automatic work from decisions. Effect v3→v4 guidance alone does not establish native portability.

## Reuse an existing codemod engine

Codemod's README documents a CLI, multi-step workflows, JSSG/ast-grep transformations, registry and MCP tooling, and CI use. These capabilities support investigating it as the preferred mechanical engine rather than building custom workflow/AST infrastructure. Exact adapter APIs and releases still require pinning and validation. [Codemod upstream](https://github.com/codemod/codemod)

Keep the integration replaceable. Effect Native supplies diagnostic/fix metadata, codemods, workflow definitions, semantic verification, and agent guidance. The external engine supplies transformation/workflow mechanics.

The source conversation notes that the original Grit organization was archived. That is verified, but the former GritQL URL now redirects to biomejs/gritql, so the organization archive alone is not evidence that every successor is unmaintained. This proposal selects Codemod as a candidate based on its documented capabilities, not an assumed need to fork GritQL. [Grit organization](https://github.com/getgrit), [GritQL successor](https://github.com/biomejs/gritql)

Possible package shape:

```text
@effect-native/migrate
    codemods/
        if-to-match
        array-to-vector
        promise-to-effect
        service-portability
        schema-portability
    workflow.yaml
    skills/
        migrate-to-native/
```

The package should orchestrate the shared compiler API and the engine, not duplicate compiler checking or implement a new parser framework.

## Target-scoped analysis and reports

Proposed target examples include `rust:rpc` and `rust:foldkit-ssr`. Derive the reachable server graph and required capabilities before classifying migration work. SSR may require Flags/init/view/routing/server data while browser update/subscriptions/DOM remain ordinary JS.

Unreachable unsupported syntax is outside that native profile's migration report. Unresolved dynamic reachability must be reported as uncertain rather than silently counted as portable.

Reports should distinguish already compatible nodes/files, eligible automatic changes, guided decisions, architectural tasks, unsupported cases, and out-of-scope code. If showing a coverage percentage, identify its denominator, target/version profile, and unresolved assumptions; the sample counts and “91%” in the supplied conversation are illustrative, not project measurements.

## Structured diagnostics and shared fix registry

Machine-readable diagnostics should include stable codes/kinds, source locations, relevant operation/type/requirement, target/version profile, reason, alternatives, dependency path, and optional fix IDs. Human CLI output, JSON, editor quick fixes, agents, CI, and MCP consume the same data.

Example shape:

```json
{
  "code": "EN1204",
  "kind": "UnsupportedJavaScript",
  "file": "src/users.ts",
  "range": { "start": { "line": 83, "column": 1 }, "end": { "line": 85, "column": 2 } },
  "operation": "Array.sort",
  "target": "rust:rpc",
  "reason": "callback_not_portable",
  "alternatives": ["portable-collation-service", "explicit-javascript-host", "leave-unresolved"],
  "automaticFix": null
}
```

Define coordinate conventions and schema versioning before implementation. Alternatives are possible decisions, not automatic evidence of equivalence.

Associate fixes with diagnostics systematically:

| Illustrative diagnostic                                | Candidate fix ID              |
| ------------------------------------------------------ | ----------------------------- |
| EN1001: supported JS branch inside a compiled function | `effect-native/if-to-match`   |
| EN1002: JS array map on a symbolic vector              | `effect-native/array-map`     |
| EN1107: eligible object mutation                       | `effect-native/object-update` |

Each registration states applicability, target/version support, required types/capabilities, preconditions, evidence/fixtures, and validation. A diagnostic may suggest a fix without declaring every instance automatically eligible. Use the same registry for editor actions, CLI, workflows, and agents.

## Library API and CLI

Proposed orchestration:

```text
Compile.analyze(target, project)
    → scoped compatibility report and fixes
existing codemod workflow
    → eligible source edits
Compile.check(requested profile)
    → representability diagnostics
agent/manual architectural tasks
    → explicit design choices and repairs
semantic tests and native build
    → verified migration result
```

Possible commands:

```bash
effect-native analyze . --target rust:rpc
effect-native check --json
effect-native migrate . --target rust --report
effect-native migrate . --target rust --apply safe
effect-native migrate . --target rust:foldkit-ssr --report
effect-native fix EN1001
```

These commands are not available yet. Analysis/reporting should be non-mutating; automatic application is limited to registered eligible fixes and the requested scope. A request to report is not a request to rewrite or install tools.

An agent repair loop uses remaining diagnostics in dependency order, records changes and unresolved decisions, and stops with an accurate report if the remaining work needs an unavailable input or has no supported equivalent. A successful native check establishes supported representability; it does not by itself prove rewrite equivalence. Require semantic/conformance evidence and build validation for the claimed migration result.

## Agent migration skill

The proposal includes a future skill, not a skill implemented or installed by this documentation change:

```text
skills/effect-native-migration/
    SKILL.md
    references/
        supported-effect.md
        ownership.md
        schemas.md
        services.md
        rpc.md
        foldkit.md
        remote.md
        sql.md
        diagnostics.md
```

Its workflow should be:

1. Review prior docs and code, research the supported versions/profile, and record preparation.
2. Analyze the requested target and inspect compatibility/reachability.
3. Run authorized eligible codemods; preserve supported code and unrelated/browser-only logic.
4. Run compiler checks and resolve remaining diagnostics in dependency order.
5. Record semantic/architectural choices; do not substitute behavior merely to remove an error.
6. Run relevant reference/conformance tests and build the native target.
7. Report changed scope, remaining unsupported cases, and actual validation results.

Workflows can represent unresolved agent/human decisions without turning ordinary authorized mechanical work into repeated permission requests.

## Editor tooling

[Editor integration and Volar](editor-tooling.md) refines this track with checked virtual-code/mapping APIs. Start with public compiler diagnostics and read-only generated previews; consider Volar for a concrete virtual-document/navigation consumer. Keep TS/Effect services intact, verify TypeScript-native checker compatibility, adapt UTF-8/UTF-16 and half-open boundaries, and disable generated-code inverse edits without semantic fix rules. No editor dependency is required by compilation.

Investigate integration with Effect-tsgo's diagnostics, completions, refactors, and editor experience. Its README documents Effect-aware tooling and v3/v4 refactor status; it does not establish an Effect Native extension API. [Effect-tsgo upstream](https://github.com/Effect-TS/tsgo)

The desired experience combines TypeScript, Effect, and Effect Native diagnostics; target-compatible hover information might show a generated native signature and selected dependencies. Native compatibility, cancellation claims, and fixes must come from the compiler's supported profile and evidence rather than decorative editor labels.

Reuse available public hooks when verified. Keep native diagnostics library-first even if editor integration initially needs an independent adapter; avoid committing to an undocumented language-server plugin or duplicate checking engine.

## Delivery and acceptance

Migration is a first-class tooling track attached to native profiles, not a prerequisite to the first kernel/query demo. Establish structured diagnostics/source mapping and fix metadata with compiler tooling; add small migrations as native capabilities stabilize. Expand source analysis, agent guidance, editor integration, and architectural workflows in response to actual migrations. Retain the separate later syntax-widening milestone. The first milestone-level migration acceptance is [8B](implementation-milestones.md#26-milestone-8--native-foldkit-ssr): the pinned upstream SSR source is mechanically transformed into R builders that meet the hand-authored 8A acceptance.

Require every supported mechanical fix to demonstrate applicable behavior-preserving fixtures, refusal when preconditions fail, scope discipline, and repeat-run stability. Check the selected profile, compare semantic outcomes and lifecycle traces where relevant, run the native build, and report unresolved cases. Existing codemod infrastructure reduces mechanical work; it does not supply the compiler's semantic evidence.
