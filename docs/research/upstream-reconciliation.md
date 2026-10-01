# Upstream reconciliation — 2026-10-01

## Reviewed state

Fetched origin/master through `e91efa1`, twelve commits after local `eded0b9`. The incoming work includes dynamic Foldkit Query compilation, synchronous Boolean/u64 Effect IR, provenance/source writing and mapped Cargo diagnostics, plus observability/metadata/editor/Facet research. Read the updated AGENTS, progress and Query issue/design records and traced the dynamic Query and Cargo implementations before reconciliation.

Saved the unfinished local closed-fixture prototype, dependency experiments and research in Git stash `0ca3899ac5100c02f3c8f2f29cbc88a766fc4eea` (`reconcile: preserve in-progress Foldkit preparation`). Four untracked effect-reference documents remain untouched. Fast-forwarded master to the fetched upstream; no new branch/worktree or rewritten commits.

## Decisions

- Keep upstream's general dynamic encoded-primitive Query path and its UTF-16/f64-bit stdin bridge, row identity preservation, short-circuiting, selected-row sort validation and memoized snapshots. These subsume the unfinished captured-ASCII prototype; do not publish a second Query backend or regress its broader equality/ordering support.
- Retain the upstream Effect RC.118 family and licensed, unchanged test-only Drizzle compiler snapshot. The local RC.116 alignment experiment proved the full published Remote chain can install, but it also needs root-family overrides, changes process import paths and does not improve the current supported compiler. `vp install` after fast-forward restores one RC.118 family; `npm ls` and strict TypeScript pass. Broader Remote/RPC compatibility still needs a release-specific decision when that workload arrives.
- Both paths independently found the Unicode containment mismatch. Upstream also demonstrates NUL disagreement. Preserve its evaluated non-NUL ASCII containment bounds and UTF-16 support elsewhere, rather than globally restricting all Query text to ASCII.
- Carry forward the local prototype's reachable-data-property check: the reference evaluator uses ordinary property lookup, whereas the dynamic encoder currently maps inherited cells to null and invokes getters once. Inherited values/getter effects can therefore silently change results. Refuse inherited/accessor **reachable** cells before native execution; continue preserving unrelated row fields and original row objects. Add rejection regressions that do not require casts.
- Keep official scoped process cleanup. On this Windows host, `taskkill /PID 2147483647 /T /F` itself times out after **61.87 seconds**; Node's spawner invokes it after nonzero exits. The imported suite passes 35/37 tests but its multi-failure Query/source tests exceed Linux's 120-second budget. Adjust only those tests' Windows budgets by their expected process-failure counts. Do not skip failure assertions, swallow failures, or bypass scope cleanup.
- The Windows checkout has `core.autocrlf=true`; fresh upstream TypeScript/JSON/example files are checked out with CRLF and fail the LF formatter check despite upstream validation. Record LF in repository `.gitattributes` and normalize tracked task source files with the existing formatter. This changes no Git user configuration and keeps authored source-coordinate fixture strings/bytes intact.

## Evidence and validation

The fresh merged baseline passes all 27 published Query cases in evaluate/real SQLite/native debug/release, all synchronous Effect tests and the arithmetic path. Only two multi-failure tests time out; no semantic assertion fails before timeout. `vp exec tsc -p packages/reffect/tsconfig.json --noEmit` and `npm ls effect @effect/platform-node @effect/platform-node-shared --all` pass.

Installed `@effect/platform-node-shared` RC.118 source (`NodeChildProcessSpawner.ts`, killProcessGroup and completed nonzero-exit finalizer) confirms the taskkill path. This is host/platform integration evidence, not a new native runtime implementation. The new budgets remain bounded and retain all actual error/diagnostic assertions.

Acceptance: merged core/Effect/Query/source tests pass including fresh Cargo builds and mapped failure diagnostics; native examples preserve stdout/protocol behavior; strict authored TypeScript and task-scoped check/build pass. Record full-root formatting failures separately while preserving the four untracked user documents. Review and push focused reconciliation commits on master, preserving the saved local prototype until the integrated result is validated.

## Result

Published reconciliation commit `2a52cb4` after re-reading its diff and repeating strict checking, workspace builds and all **38 tests** with fresh native debug/release crates. The 27 shared Query fixtures and mapped Cargo error/fallback assertions all pass. Expr, Query, Effect and Source examples also pass. Own-data rejection regressions cover both input and row getters without invoking them, inherited Object.prototype cells, and preservation of unrelated getter-bearing fields.

The Windows cleanup stall is intermittent: the first completed integrated suite took about 329 seconds; its post-commit repeat took about 42 seconds without changing cleanup or error semantics. Budgets accommodate the measured worst case and retain the Linux/default bound. All tracked task files are formatted and root lint/types pass; only the four untracked user documents block the full formatting check. The saved prototype remains available rather than being silently discarded.
