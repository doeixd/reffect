# Semantic kernel bootstrap

Checked 2026-09-30. Scope: detailed milestone 0, followed by the existing Foldkit Query workload in milestone 1.

## Prior decisions and sources

- PLAN.md, compiler-design-revision.md and implementation-milestones.md require typed immutable IR, semantic identities, distinct representations, subject-indexed law evidence, checked traits, explainable planning, and the public Effect pipeline.
- [Gen2 Operation source](https://github.com/doeixd/gen2/blob/main/src/types/operation.ts) was inspected: operation signatures, effects, capabilities, implementation records and assurance metadata are useful architectural prior art. Adapt those concepts into a smaller expression kernel; no graph compiler or shared kernel dependency is needed.
- Registry checked with `vp exec npm view effect dist-tags --json`: stable is v3.22.2; current v4 is **4.0.0-rc.118**. Pin Effect and platform-node to that exact matching version.
- [Official service migration](https://github.com/Effect-TS/effect-smol/blob/main/migration/services.md): v4 uses Context.Service and explicit Layer.effect, superseding the v3 Effect.Service examples in the available skill.
- [Official Schema migration](https://github.com/Effect-TS/effect-smol/blob/main/migration/schema.md): use TaggedErrorClass, BigInt, check/makeFilter, and decodeUnknownEffect. Installed source remains the API authority for the pinned RC.
- Installed RC.118 source supersedes that migration page: schema errors use `Schema.TaggedError`, and process APIs are at `effect/process` (not `effect/unstable/process`). Verified against `node_modules/effect/src/Schema.ts`, `process/ChildProcess.ts`, `process/ChildProcessSpawner.ts`, and `@effect/platform-node/src/NodeServices.ts` before writing the adapters.
- [Rust u64](https://doc.rust-lang.org/std/primitive.u64.html#method.wrapping_add): explicit wrapping arithmetic is profile-independent. Local Cargo is 1.90.0. Use stable wrapping_add/sub/mul, not ordinary operators with debug/release-dependent overflow.

## Chosen boundary and alternatives

The initial semantic type is an unsigned 64-bit integer represented by JS bigint and Rust u64. Inputs/literals must lie in 0..2^64-1. Addition/subtraction/multiplication are explicitly modular. JS number was rejected because it cannot represent all u64 values. Checked arithmetic would require failure IR; defer it rather than silently changing behavior. No wire/storage codec is inferred from the native type.

Use a coarse public `reffect` workspace package for kernel, compiler and Rust backend, splitting when workload pressure warrants it. Functions build symbolic parameter/literal/application nodes. Parameter binders are scoped to their function; escaped symbols are refused. Operations have semantic IDs, signatures and pure reference implementations; the Rust target has its own implementation registry. Planning refuses absent implementations and reports selected/rejected candidates, dependencies, capabilities and evidence. Pure Expr cannot admit declared effects or service requirements. General effectful IR remains milestone 2.

Register algebraic laws as claims with provenance; no law-driven optimization runs yet. Only the built-in u64 representation gets checked Copyable/Cloneable/Eq/TotallyOrdered traits. Do not infer native support from a type's display name or arbitrary trait strings. Normalization/optimization are explicitly identity stages for this subset. Ownership is primitive copy only.

Compiler stages return official Effects and typed schema errors. Compiler and Cargo services use Context.Service/Layers; filesystem and process work use platform-node's scoped adapters. Emission returns files as data; writing requires an explicit new output directory to avoid overwriting user files. Cargo runs offline with no dependencies, records stdout/stderr and exit status, and is interruptible through the official process service.

## Acceptance and open questions

- Typed `R.fn([R.U64, R.U64], R.U64, (a,b) => R.U64.add(a,b))` emits a compilable dependency-free Rust library and runnable smoke binary.
- Meaningful differential cases include zero/max, overflow, underflow, values beyond JS safe integers, nested composition, constants, repeated symbolic uses, debug and release builds.
- Reject wrong arity/types, foreign binders, invalid literals, duplicate identities/names, unsupported operations/representations and malformed selected plans with structured diagnostics. Verify law subject indexing and evidence policy, including refusal to treat claims as tested.
- Run `vp check`, `vp test`, workspace builds, and fresh Cargo validation. Align the utils Vite+ version if the known duplicate test runtime is confirmed.
- Foldkit package/version and actual Query fixtures still need upstream investigation before milestone 1. This record establishes only the arithmetic kernel; RPC, concurrency, general Effect IR and Query support remain future work.

## Implementation evidence

Independent post-commit review reproduced two kernel issues: the exposed builtin Schema/AST could be mutated to weaken range validation, and shared expression DAGs expanded exponentially during lowering/rendering. Freeze the locally constructed builtin Schema/AST/checks (without freezing the upstream shared BigInt AST), and lower applications once into dependency-ordered Rust locals. This preserves the reference evaluator's DAG sharing structurally; it is not a law-driven optimization. Regressions must show mutation cannot admit invalid literals and source size is linear for repeated-squaring DAGs, alongside native parity.

### Authoring API refinement (user direction)

The public semantic witness is named **IRType**, superseding the earlier CType spelling for new code. User-authored values should be built through typed factories and immutable, data-last combinators composed with `pipe`; examples and tests must not need casts or object spreading. Preserve literal tuple inference for function/operation signatures and law subject types.

Checked installed RC.118 `Pipeable.ts` and [current upstream Pipeable](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Pipeable.ts): `Pipeable.Class` supplies the standard typed `.pipe` overloads. Reuse it for kernel/configuration values rather than implementing a custom chaining protocol. Use typed reference objects for types, operations, targets, capabilities, effects and requirements; IDs are serialized/displayed at boundaries, while semantic lookup uses the reference object. A different object with the same serialized ID is a collision, not implicit equivalence. Law witnesses name operation references, and named evidence/law factories replace user-written discriminator strings.

Prefer complete typed factory arguments plus focused `with*` combinators over permissive object patches or an incomplete builder that can reach compilation without a reference evaluator. Generic erasure, where necessary for heterogeneous IR traversal, remains confined to implementation internals. Runtime-invalid input tests use an explicit unknown-input reference boundary; malformed plans use typed plan constructors. Compile-time fixtures test misuse without coercing it into a valid type. No compatibility alias is needed for the unshipped CType API.

Use official Effect `Match.value`/`Match.tags` with exhaustiveness for IR variants, and existing module predicates for values such as Exit. Discriminant tags remain an internal data representation; consumers should not manually inspect `_tag` or maintain unchecked switches.

- Package `packages/reffect` implements the scoped builder/operation model and public pipeline through emission, with `Compile.build` continuing through the Cargo service. A development source export and generated bundle/declarations are available; package publication is deferred.
- Native differential validation compiles fresh dependency-free crates, then runs 22 cases in each of debug/release. Arithmetic claims remain claims despite this bounded conformance evidence; no optimization consumes them.
- The local Windows machine initially had Rust but no discoverable C++ linker; Coreutils `link.exe` was selected. An attempted recommended Build Tools workload failed with installer code 2147942512 (insufficient space). Installing only `Microsoft.VisualStudio.Component.VC.Tools.x86.x64` and `Microsoft.VisualStudio.Component.Windows11SDK.26100` completed successfully with Build Tools 18.10.2. Validation uses its developer environment; no machine-wide PATH edits or compiler fallback were added.
- Root test suite-detection was caused by the utils workspace using a different Vite+ release. Pinning it to 0.3.2 deduplicates the runtime and the starter test passes.
