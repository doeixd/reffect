# Foldkit Query native bootstrap

Checked 2026-09-30, before implementation. Scope: milestone 1, consuming the existing Query IR rather than introducing another authoring DSL.

## Sources and prior decisions

- [Detailed milestone 1](../implementation-milestones.md#15-milestone-1--foldkit-entity-exprquery-as-the-first-real-compiler-target), [IR design](../foldkit-ir-design.md), and [reuse strategy](../reuse-strategy.md) require existing evaluator/Drizzle/Rust conformance before general Effect IR. The arithmetic compiler's representation registry is deliberately u64-only; do not make it silently accept Query values.
- Inspected [Foldkit-Plus](https://github.com/doeixd/Foldkit-Plus/tree/f98f4d5cbaebb7aecf2ec636dd198fae01db5b1c/packages/entity) at `f98f4d5cbaebb7aecf2ec636dd198fae01db5b1c`. Published `foldkit-entity@0.4.0` exports Expr/Query/evaluate and `foldkit-entity/conformance`; it accepts Effect `^4.0.0-rc.116`, including the project's RC.118. Pin the published package rather than copying its IR or fixtures.
- Inspected [Drizzle compiler](https://github.com/doeixd/Foldkit-Plus/blob/f98f4d5cbaebb7aecf2ec636dd198fae01db5b1c/packages/remote-drizzle/src/compile.ts) and its conformance test. Published `foldkit-remote-drizzle@0.8.0` uses `drizzle-orm@1.0.0-rc.4`. Its declared Effect peer range includes RC.118, but the actual Remote dependency import fails; use the unchanged upstream query compiler over Node SQLite in tests as described below. Native SQL execution belongs to milestone 5.
- Also cloned [foldkit/foldkit](https://github.com/foldkit/foldkit/tree/c14bbea505466a500cfe3f23d8637c910ae616d1) at `c14bbea505466a500cfe3f23d8637c910ae616d1` and inspected the workspace/package layout. This milestone consumes Foldkit-Plus Entity contracts; base Foldkit UI/SSR remains a later integration.
- Installed Effect RC.118 `Schema.toEncoded`/SchemaAST guards expose the encoded primitive representation, including Date-to-string transformations. ChildProcess stdin accepts a scoped Stream of bytes; reuse the Cargo service for execution and cleanup.
- [Rust slice sorting](https://doc.rust-lang.org/std/primitive.slice.html#method.sort_by) is stable. [ECMAScript comparison](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-islessthan) orders strings as UTF-16 code units. Preserve that JS ordering explicitly; SQL collation parity beyond the upstream portable fixtures is not established.

## Semantics and boundaries

The upstream evaluator compares already encoded rows, inputs, and literals. It does not automatically encode Date literals. Reject decoded objects rather than returning a misleading empty result. Support encoded string/number/boolean schemas, their primitive literals and nullable unions, while refusing objects, arrays, bigint, opaque/unknown schema representations, foreign Entity identities, missing field declarations, incompatible input witnesses, and non-field ordering. The native result is an ordered vector of input-row indices, so complete structured rows are returned unchanged without flattening or serializing unrelated fields.

Equality and containment produce SQL unknown on absent operands; nested comparisons preserve unknown. All where clauses conjoin and only true retains a row. Order terms retain priority and sorting is stable. When two or more rows survive, all ordering keys must be present and finite; refuse nullable keys before sorting, even secondary keys a particular reference comparison might never reach. This supported profile avoids feeding an inconsistent fallible comparator to Rust sort. Numbers use f64, preserving JS numeric equality, NaN behavior, infinities, and negative zero. Refuse nonfinite numeric ordering: JS's NaN-as-tie comparator is not a total order and its sorting algorithm need not agree with Rust's.

There is an upstream discrepancy: Expr docs specify ASCII folding, but evaluate uses JS Unicode toLowerCase; SQLite lower is ASCII-only. Initially refuse non-ASCII containment operands (including ASCII NUL, whose SQLite LIKE behavior diverges) instead of claiming universal parity. Ordinary equality and JS-reference text ordering retain UTF-16 semantics. Unicode collation, general structured-value equality and automatic domain encoding remain open work, not silently substituted semantics.

## Chosen approach and alternatives

Expose a focused Foldkit compiler consumer and Compile.fromFoldkitQuery using the existing IR. Derive reachable fields, inputs and operations, check representation/support, emit specialized Rust functions and an explanation. Keep the arithmetic pipeline intact; generalizing its entire operation/representation ABI prematurely would obscure Query-specific semantics.

Use a dependency-free Rust std evaluator and a small versioned stdin protocol: primitive scalar tokens (UTF-16 text, f64 bits, booleans, null), rows as a vector of reachable fields, output as row indices. This avoids new Cargo dependencies, network-dependent tests, JSON's nonfinite-number restrictions and Rust UTF-8's inability to represent lone JS surrogates. Prefer stdin over process arguments to avoid command-line size limits. This is an internal evaluator bridge, not a public RPC or storage codec. Generate code from checked nodes, never from display strings or unchecked user keys.

Reuse Cargo exclusive output, scoped child processes and offline builds through a generic generated-files contract and a raw evaluator entry point. Keep rows/inputs supplied at execution time; fixtures must not be compiled into the native artifact. Do not introduce a general native Effect runtime.

## Acceptance and validation

The published Drizzle 0.8.0 entry point transitively imports Remote's obsolete `effect/unstable/rpc`, absent in RC.118. Remove that incompatible development dependency. Preserve a test-only snapshot of upstream `src/compile.ts` at the inspected commit, with its MIT license, a lint annotation preserving redundant upstream declaration unions, and the cursor type import replaced by its identical two-field definition. Runtime/compiler logic stays unchanged apart from repository formatting. The tests exercise the actual upstream implementation with pinned Drizzle rather than a newly written SQL oracle. Revisit the snapshot when a compatible release is available. The complete registry tarball contains build output; an early incomplete local install is not evidence of a packaging defect.

The native checker cannot rely directly on Query.dependencies: its field report drops owner identity and its traversal expands shared DAGs. Reuse the published node/operation vocabulary but derive support and dependencies through a memoized traversal of actual owner tokens. All representation checks describe encoded primitive kinds; they are not a replacement for domain schema validation, encoding services or refinements at application boundaries.

[Recorded upstream issues](foldkit-plus-issues.md) include reproduced containment, traversal, mutability, identity-reporting and RC compatibility findings. No upstream source changes are made by this integration.

Drizzle RC.4's published declarations fail TypeScript 7 checking across dialects (missing private builder configuration and variance errors), even when using only SQLite. Set skipLibCheck in the compiler package to exclude dependency declaration checking; keep strict checking of all authored sources/tests and public call sites. This is an upstream declaration limitation, not proof that Drizzle's declarations are valid.

Run every published shared conformance case through official evaluate, the actual Drizzle compiler/SQLite, and fresh Rust debug/release executables. Add focused cases for stable ties, boolean/numeric/UTF-16 ordering, unknown propagation, empty input, primitive representation validation, mutable source IR snapshots, foreign same-name Entity ownership, unsupported representations, decoded timestamps and containment refusal. Strict type fixtures must not require user casts.

Run root check, strict compiler TypeScript, tests, workspace builds and the existing arithmetic example. Record fresh results and remaining scope in PROGRESS.md. No general Effect IR, SQLx, Remote, RPC or native runtime support is implied.
