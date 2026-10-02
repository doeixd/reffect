# JS numbers (`Schema.Number`)

Status: **accepted for implementation (2026-10-02)**, the first wire feature in the [native RemoteServer design](native-remote.md#order-of-work) (NR-002). Checked against installed Effect **4.0.0-rc.118** (`SchemaAST.Number.toCodecJson`, `isInt`, `isFinite`, `isGreaterThanOrEqualTo` and related filters) and probed with `Schema.toCodecJson`.

## Prior work

- The [Query adapter](foldkit-query.md) already treats JS numbers as `f64`, preserving equality, NaN, infinities and negative zero, and refuses non-finite ordering. The existing `u64` profile is unsigned bigint with a decimal-string wire codec: a different semantic type.
- [Architecture §9](../architecture.md#9-native-representation-does-not-mean-fixed-payload-size) lists `F32`/`I64` as future representations; AGENTS.md asks for float semantics to be tested before any law claims.
- Remote uses `Schema.Number` for its protocol version and cursors, and `Number.check(isInt(), isGreaterThanOrEqualTo(0))` for page sizes ([gap analysis](remote-gap-analysis.md)).

## Pinned behavior

- A **plain** `Schema.Number` encodes over JSON as a JSON number, or the strings `"Infinity"`, `"-Infinity"` and `"NaN"` for non-finite values. Decoding failures say `Expected "Infinity" | "-Infinity" | "NaN"` for other strings and `Expected number | "Infinity" | "-Infinity" | "NaN"` for other values.
- If the checks include `effect/schema/isInt` or `effect/schema/isFinite`, the JSON codec is the plain number (`toCodecJson` returns the node unchanged): strings fail with `Expected number`.
- Checks run in declaration order, and the first failure is reported as `Expected <check's expected annotation>` (`an integer` — a safe integer, so 2^53 fails; `a value greater than or equal to 0`; `a finite number`). Range checks also see decoded non-finite strings: `"NaN"` fails `isGreaterThanOrEqualTo(0)`.
- Filters carry `annotations.representation = { id, payload }` (for example `effect/schema/isGreaterThanOrEqualTo` with `{ minimum }`).
- `JSON.stringify(-0)` is `"0"`, and integral doubles print without a fraction.

## Decisions

- **NUM-001 — `R.Number` witness.** JS doubles (`reffect/number@1`, `Schema.Number`, native `f64`), Copyable but **not** Eq or totally ordered (NaN). Admitted operations are `literal`, `add`, `eq` and `lt`. These are IEEE 754 binary64 operations with identical results in JS and Rust (round-to-nearest-even; NaN comparisons false; `-0 == 0`). No law claims.
- **NUM-002 — checks recognized structurally and verified.** The checks `isInt`, `isFinite`, `isGreaterThanOrEqualTo`, `isGreaterThan`, `isLessThanOrEqualTo` and `isLessThan` are recognized by representation id and payload, then each recognized filter is **run on probe values** at compile time and must agree with the native predicate; anything else is refused. Native messages use each check's own `expected` annotation. As with `u64Range`, checked numbers are admitted for decoding only, not for encoding outputs.
- **NUM-003 — codec naming by structure.** Number variants share one witness but decode differently, so generated codec functions are named from the full codec structure (checks included), not the witness alone. This also applies to structs and arrays containing them.
- **NUM-004 — JS-compatible encoding.** Non-finite values become the three strings (plain codec only), `-0` becomes `0`, and integral values with magnitude below 2^53 print as integers. Other finite values use `serde_json`'s shortest round-trip form, which parses to the same double.
- **NUM-005 — known divergences.** (a) `serde_json` parses a JSON `-0` as `+0`; this is unobservable through the admitted operations and encoding. (b) A JSON number outside the double range (`1e400`) is a whole-body parse failure natively, whereas JavaScript reads it as `Infinity`. (c) The runner passes doubles as `f64:` plus 16 hex digits of their bits.

## Acceptance

Reference results equal JS for `add`/`eq`/`lt` over a corpus that includes NaN, infinities, ±0, 2^53 + 1 and subnormals; native debug/release agree bit for bit. Raw RPC requests with plain and checked numbers (top level, in struct fields, in arrays) match the official server's responses exactly, including the non-finite strings and every check message. Unrecognized or mismatching checks are refused while compiling.
