# Migration tooling research and design record

Checked 2026-09-30 before integrating the supplied migration proposal. This is documentation/design research; no migration engine, codemod platform, or language tooling is installed or implemented here.

## Prior project decisions reviewed

- [PLAN.md](../../PLAN.md): symbolic builders first, native target reachability, typed IR, library-first compiler, explicit compatibility checks, conformance, and later syntax widening.
- [Compiler design revision](../compiler-design-revision.md): derive/plan/verify stages, structured diagnostics, and inspectable implementation selection.
- [Compiler API](../compiler-api.md): stages and diagnostics shared across CLI, editor, tests, and CI.
- [Implementation milestones](../implementation-milestones.md): native profiles arrive incrementally; arbitrary source transformation is deferred.
- [Conformance and diagnostics](../conformance-and-diagnostics.md): target representability and reference semantic parity are separate obligations.
- [Runtime lowering](../runtime-lowering.md): no semantic substitution merely because a native implementation exists.

## Primary-source findings

| Source checked                                                                                             | Finding and limit                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [codemod/codemod README](https://github.com/codemod/codemod)                                               | Describes CLI/CI use, YAML multi-step workflows, JSSG/ast-grep transformation tooling, registry, and MCP capabilities. Supports investigating it as the mechanical engine; does not establish native migration correctness or the exact adapter API. |
| [Effect-TS/tsgo README](https://github.com/Effect-TS/tsgo)                                                 | Documents Effect diagnostics, refactors, and completions, including v3/v4 status. Supports an editor-integration research path; does not provide an Effect Native plugin contract or native portability checks.                                      |
| [Effect v3-to-v4 migration reference](https://github.com/Effect-TS/effect/blob/main/migration/v3-to-v4.md) | Provides upstream API migration material. It concerns Effect version migration, not migration to native IR. Use as prior art and version-specific evidence, not as proof of native portability.                                                      |
| [getgrit organization](https://github.com/getgrit)                                                         | GitHub reports the organization archived on May 19, 2025. This alone does not establish the status of every successor project.                                                                                                                       |
| [GritQL repository](https://github.com/biomejs/gritql)                                                     | The former getgrit/gritql URL redirects here. Check the current owner/project separately before judging reuse; the supplied organizational archive claim is not grounds for assuming all GritQL development ended.                                   |

Sources were checked as live upstream pages, not pinned releases or commits. The repository does not yet select a Codemod or Effect-tsgo version. Pin supported releases and test their integration before implementing an adapter; recheck maintenance, contracts, and licensing then.

## Alternatives and decision

Considered building an AST/workflow framework, using an existing platform, and making agents perform all rewrites. Adopt the supplied direction: the Effect Native compiler owns compatibility analysis and diagnostics; an existing platform performs constrained AST transformations; agents/humans handle choices that require semantic or architectural reasoning.

Codemod is the preferred candidate from the sources above. Keep a replaceable integration boundary and defer actual dependency selection. Reuse established editor tooling where its supported APIs permit; do not invent a separate language server or assume an undocumented extension hook.

## Design constraints and rationale

- Classify the selected native target's reachable graph. Do not demand rewriting browser-only code or already portable code.
- Distinguish deterministic mechanical fixes, compiler-guided choices, architectural migration, and unsupported semantics. Mechanical eligibility requires explicit preconditions and equivalence fixtures; a matching AST pattern is insufficient.
- `check` establishes validity/representability for a supported profile. A passing check alone does not prove that a source rewrite preserved behavior. Reference/conformance tests, types, lifecycle traces, and build results supply additional evidence.
- Rewrites involving locale comparison, numeric representation, mutation, concurrency, or service identity can change behavior. Expose alternatives and retain unresolved diagnostics when no equivalent choice is known.
- Migration converts source into the existing builder/IR authoring profile. It does not enable arbitrary TypeScript parsing or generators in the initial compiler and does not replace later source syntax widening.
- The migration registry associates diagnostics with fix IDs, supported target/version profiles, preconditions, and validation obligations. CLI/editor/agent/CI consumers use the same structured data and library API.
- Record migration scope, choices, unresolved issues, and validation. Workflows may expose human decision points when a design choice is unresolved; avoid inserting approval gates for ordinary authorized mechanical fixes.

## Acceptance and open questions

Require eligible transformations to preserve behavior on representative and adversarial fixtures, refuse unmet preconditions, leave already supported and out-of-scope code unchanged, and behave predictably on repeat runs. Check the rewritten graph against the requested target, run semantic/conformance tests and the native build, and report remaining uncertainty accurately.

Open questions: source-to-IR diagnostic locations, target/profile naming, machine-readable report schema, versioned fix IDs, source graph analysis before portable builders exist, adapter/tool release pinning, evidence thresholds, failure/recovery behavior, and available Effect-tsgo integration hooks. These must be settled before implementation of the migration package.
