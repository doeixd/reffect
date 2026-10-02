# Bounded scalar Schema payloads

[Roadmap](../../PLAN.md) · [Documentation index](../README.md)

Checked 2026-10-02 against Effect `4.0.0-rc.118`, installed source and [the pinned upstream Schema implementation](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.118/packages/effect/src/Schema.ts). Relevant primary sources: [SchemaTransformation.bigintFromString](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.118/packages/effect/src/SchemaTransformation.ts), [SchemaGetter.BigInt](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.118/packages/effect/src/SchemaGetter.ts), and [RpcServer payload decode](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.118/packages/effect/src/rpc/RpcServer.ts). The upstream Schema source was fetched and compared with the installed checks before implementation.

## Prior constraints

The implemented boundary accepts plain Boolean/Undefined/Never and the exact frozen `RpcCodecs.U64Json` schema identity. Required flat Struct payloads project into scalar handler arguments. Validation precedes bearer authentication. Native numeric values are plain `u64`; wire bigint values use decimal strings. General Schema AST interpretation, arbitrary predicates, owned strings, records and union representations remain unsupported.

## Decision: registered inclusive u64 payload ranges

Add `RpcCodecs.u64Range({ minimum, maximum })` as an ordinary Effect checked BigIntFromString schema. Bounds must be bigint values satisfying `0 <= minimum <= maximum <= 18446744073709551615`. The factory freezes its schema/check surface and privately registers the exact AST identity with immutable bounds in a compiler-owned WeakMap. The native compiler recognizes only factory-created identities; checks or annotations subsequently composed onto the schema produce a different, unsupported identity.

The native decoder first performs the existing full u64 conversion/validation, then the inclusive lower and upper range checks in their authored order, before authentication or handler execution. Effect uses the same initial u64 checks followed by range checks, so out-of-u64 inputs retain existing diagnostic precedence. Bounds emit as typed Rust expressions and constants; handler arguments remain plain `u64` without per-value metadata, runtime maps, or extra allocation.

Alternatives: interpreting all filter AST metadata would trust arbitrary user predicates or mutable annotations; allocating tagged numeric wrappers would add runtime cost without improving boundary validation; adding full Schema representations would exceed the current scalar ownership profile. Explicit registration keeps the semantic adapter bounded and fails closed.

## Limits and revisit triggers

Range schemas are supported for scalar or flat-field **payloads only**. Constrained success/error schemas are refused explicitly: output Schema encoding failures require a separately verified defect contract, rather than silently dropping checks. No generic check, brand, annotation, Struct check, optional/default, refinement callback, or transformation is admitted. Revisit registration when the compiler has a portable Schema profile and representation registry; revisit output checks when differential RPC defect tests establish encoding-failure semantics. The WeakMap exists only in the TypeScript compiler process and does not affect native scalar layout or heap use.

## Acceptance

Differentially compare native HTTP responses with the pinned stock Effect RPC server for inclusive endpoints, interior values, out-of-range values, values above JS safe integer precision, invalid decimal strings, missing fields and scalar versus flat payloads. Verify rejected inputs never invoke a handler and range validation precedes authorization. Exercise factory validation, mutation/derived-schema refusal, and constrained-output refusal. Build/run generated native Rust rather than merely asserting emitted text. Record exact commands/results below after implementation.

## Decision ledger

- **SCHEMA-001 — implemented, bounded:** use frozen factory-created ordinary schemas with private compiler AST registration. Alternatives were generic refinement introspection and tagged native numbers. This keeps scalar memory unchanged and rejects unverified filters; revisit when portable Schema/representation registries ship. Only payload ranges are admitted; constrained success/error encoding is explicitly refused pending defect conformance.
- **SCHEMA-002 — correction implemented:** Effect RC.118 [schema construction internals](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.118/packages/effect/src/internal/schema/make.ts) lazily memoize `make`, `makeEffect`, and `makeOption` by defining own schema properties. Freezing before first use broke scalar stock `RpcClient` payloads with `Cannot define property make, object is not extensible`. Materialize all three accessors before freezing both canonical U64Json and range schemas. Leaving schemas mutable would undermine identity-based trust; revisiting this strategy is required when Effect changes its accessor lifecycle. Tests call the public accessors and stock scalar clients.
- **SCHEMA-003 — correction implemented:** the native decoder's nonstring u64 and missing Struct-key messages diverged from the pinned official RPC server. Align them to `Expected string` and `Missing key` with the same field path rather than loosening the oracle. Consequence: invalid-input diagnostics become compatible in these cases. General schema error trees remain outside this bounded profile; compare new cases to the pinned oracle before admitting them.
- **SCHEMA-004 — implemented:** emit the range-decoder scaffold only when an RPC payload reaches a registered range. Generate constants through typed Rust literals. Native arguments remain plain u64; no new crate or heap metadata is needed. Revisit if range-check inlining/code growth measurements justify a different emission strategy.

## Observed validation

- `vp test packages/reffect/tests/schema-rpc.test.ts`: **2/2 pass**, final run 93.32s under parallel module work (native workload 88.80s); earlier smaller corpus passed in 52.57s. One fresh native debug HTTP crate serves both raw differential requests and ordinary stock clients. The final corpus contains 22 requests covering inclusive high-precision and u64::MAX endpoints, interior/leading-zero values, unsigned zero including `-000`, bounds failures, invalid/nonstring decimal inputs, missing fields and validation-before-auth. Exact native response JSON equals the pinned official RPC server; rejected inputs never log a handler invocation.
- `vp check --fix packages/reffect/src/rpc-codecs.ts packages/reffect/src/native-rpc.ts packages/reffect/src/rpc-runtime.ts packages/reffect/tests/schema-rpc.test.ts docs/research/schema-profile.md`: passes formatting, lint and scoped type checks for the four code files.
- `vp exec tsc -p packages/reffect/tsconfig.json --noEmit`: no Schema-lane errors; the final concurrent snapshot still reports other agents' in-progress error-recovery/resource-scope test errors. Integrated checks belong to the parent batch before publication.
- Pinned upstream Schema and lazy-constructor source were fetched online; the lazy-constructor file matches installed RC.118 byte-for-byte. Final code review confirms numeric constraints precede authentication, borrowed payloads are decoded before invocation, constraints emit only when reachable, no crate changes occur, and plain native u64 layout is retained. Release-mode and integrated-suite results are not claimed by this focused record.
