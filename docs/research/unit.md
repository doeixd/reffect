# Unit representation and composition — 2026-10-01

## Prior work and primary checks

- PLAN's current milestone 2/observability track requires Unit before scoped logging and bounded failure context. Read existing canonical witnesses, immutable factories, succeed/fail/map/flatMap/Match, reference execution, lowering, scalar/Result protocol, source artifact policy and conformance tests.
- Pinned **Effect 4.0.0-rc.118** source (`Schema.ts` lines 2968–2976 and 3127–3147; `Effect.ts` void/asVoid exports) distinguishes exact Undefined from discarding Void. Runtime probe confirms Schema.Void admits undefined/null/numbers, while Effect.void succeeds with undefined. [Current official Effect source](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Effect.ts) documents void/asVoid semantics; installed RC source remains the version authority.
- [Rust unit](https://doc.rust-lang.org/std/primitive.unit.html) has exactly one value `()`, supports ordinary primitive copying/comparison and requires no allocation/dependency. It has no Display/FromStr contract suitable for the current CLI bridge, so provide an explicit unit token rather than rely on debug formatting or coercion. Local Rust/Cargo is 1.90.0; validate against fresh debug/release crates.

## Chosen path

Expose `R.Unit` as a canonical immutable **IRType<void>**, validated by an owned, frozen **Schema.Undefined** AST. `R.Unit.literal()` creates the single value; generic literal/unknown-input boundaries reject null, numbers and objects rather than silently discard them. TypeScript void is convenient for ordinary Effect return channels, but exact runtime admission is still enforced. Reusing Schema.Void was rejected because its value-discarding behavior would weaken native representability.

Add typed Unit capability/native representation/checked primitive traits through existing factories. The compiler admits Unit in pure function parameters/results and Effect success/error channels, with Rust `()`/Result. Unit remains distinct from Never/Infallible. Preserve existing helper/binder sharing, lazy branches, source mapping and Full/None behavior; no new scheduler or runtime crate.

Add `R.Effect.void` as succeed(Unit literal) and pipeable `R.Effect.asVoid` through existing map IR. Discarding evaluates its source, preserves its error channel and short-circuiting, and produces undefined through official Effect reference execution. No new effect node or law-driven rewrite is needed.

The internal scalar bridge uses exact `unit` for an input/pure result and `ok:unit` / `err:unit` for typed Result channels. A logical Unit parameter still occupies one argument slot, preserving tuple arity. Keep existing decimal-u64 and bool/result tokens unchanged. NativeRunner validates witnesses/args, maps only the exact Unit token to undefined, rejects wrong channels/payloads and treats a Unit domain failure as failure despite its undefined payload. This is an internal runner protocol, not a public Schema/HTTP/RPC codec.

## Acceptance

- Cast-free inferred Unit factories/functions, map/flatMap/Match/asVoid and optional source annotations; no accidental widening of Bool/u64/Never.
- Differential official Effect/native debug/release cases: pure Unit/identity/input, Unit successes/failures, Never branches joining Unit, Unit→value and value→Unit continuations, failed-source discard, nested binders and shared branch helpers.
- Reject invalid Unit literals/inputs, spoofed type/capability identities and malformed/wrong-channel native tokens; preserve exact arity and typed failure payload.
- Canonical Schema/AST immutability and zero-sized representation checks; no dependencies, per-value metadata or global state. Full/None generated-source parity still holds.
- Run scoped vp check, strict TypeScript, all tests and workspace builds; commit/review/recheck/push the complete path before broadening runtime semantics.

Next preparation: named, bounded logical failure context with unchanged domain payloads and independent instrumentation policy, then minimal deterministic scoped logging. Those are distinct slices requiring their own Effect semantic research and allocation/lifetime gates.

## Initial implementation evidence

- Four Unit conformance tests pass, including exact Undefined versus discarding Void, immutable canonical Schema, capability/witness refusal, Full/None generated-source equality, malformed native channels, and fresh debug/release execution across pure/Effect composition. A compiled const assertion verifies `size_of::<()>() == 0`.
- Reference/runner cases distinguish success(undefined) from failure(undefined), preserve Boolean failure payloads after asVoid/flatMap short-circuiting, retain nested Unit binders and mixed Unit/Bool/u64 input arity. Strict TypeScript contracts require no casts and reject payload-bearing Unit construction and non-Unit channels.
- The scoped library checks and workspace builds pass; full-suite/post-commit results follow in PROGRESS.md. No failure-context or logging runtime support is implied by this Unit slice.
