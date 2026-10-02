# Array length checks

Status: **accepted for implementation (2026-10-02)**. This is the fourth wire feature in the [native RemoteServer design](native-remote.md#order-of-work) (NR-002). Checked against installed Effect **4.0.0** (`Schema.isMaxLength`, `isMinLength`, `isBetweenLength`, `isNonEmpty`) and the published `foldkit-remote` 0.9.0 wire module.

## Prior work

- Remote declares one length check: `Fields = Schema.Array(Schema.String).check(Schema.isMaxLength(256))`. It is used only in **request** structs (`ReadRequest.fields` and each relation level's `fields`).
- [Numbers](number-profile.md) (NUM-002) established the pattern of recognizing checks by representation id and verifying them by running Effect's filter. Checked values are admitted for decoding only.
- The [native types proposal](native-types.md) suggested lowering fixed lengths to `[T; N]`. No workload declares a fixed length, so that stays deferred.

## Pinned behavior

- Checks run **after** the elements decode: `["a",1,"c","d"]` against `isMaxLength(3)` reports `Expected string at [1]`, not the length.
- Checks run in declaration order, and **only the first failure** is reported (`isMinLength(3)` then `isMaxLength(1)` on two items reports the minimum).
- Messages are `Expected ` plus the filter's `expected` annotation: `a value with a length of at most N`, `of at least N`, or `between A and B`. `isNonEmpty()` is `isMinLength(1)`.
- Representation ids and payloads:
  - `effect/schema/isMaxLength` with `{ maxLength }`.
  - `effect/schema/isMinLength` with `{ minLength }`.
  - `effect/schema/isBetweenLength` with `{ minimum, maximum }`.
- Inside `Schema.optional`, a wrong kind reads `Expected array | null`; length failures keep their own text.
- `Schema.NonEmptyArray` is a tuple with a rest element (`Missing key at [0]` for `[]`), not a length check. It stays refused with the other tuples.

## Decisions

- **LEN-001 — verified length checks on decoded arrays.** The three ids are recognized with non-negative safe-integer bounds. Each filter is run on probe lengths (0, 1, 2 and every bound ±1) and must agree with the native predicate. The generated decoder checks `out.len()` after the elements, in declaration order, returning the first failure. The witness stays `R.Array(T)` (`Vec<T>`).
- **LEN-002 — decoding only.** As with checked numbers, length-checked arrays are refused in success and error schemas until a workload needs verified encoding.
- **LEN-003 — refused:** other array checks (`isUnique`, groups), tuples (including `NonEmptyArray`) and fixed-size `[T; N]` lowering.

## Acceptance

- Raw requests with top-level, nested and optional checked arrays (under, at and over every bound; element failures before length failures; wrong kinds) must be strictly equal to the official server's responses.
- Checked outputs and unrecognized checks are refused while compiling.

## Delivered (2026-10-02)

All decisions are implemented as recorded. Evidence: [array-length-rpc.test.ts](../../packages/reffect/tests/array-length-rpc.test.ts) 2/2 — 26 raw requests are strictly equal to the official server, and an off-by-one mutation in the native `isMaxLength` predicate fails the test. Compile-time verification checks Effect's filter against the JavaScript predicate twin. The emitted Rust is covered by the differential test, as with NUM-002.
