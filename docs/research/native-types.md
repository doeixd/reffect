# Native types: JS-type crates, sized numbers, tuples and fixed arrays

Status: **proposed (2026-10-02)**, not implemented. It answers a design question about JS-type Rust crates and native sized/tuple types. It extends [architecture §9–10](../architecture.md#9-native-representation-does-not-mean-fixed-payload-size), which already lists `U8`/`I64`/`F32`, `Array<T,N>`, `Tuple`, `Option`, `Result` and maps as target representations. Checked against installed Effect **4.0.0-rc.118** (`Schema.d.ts`) and crates.io on 2026-10-02.

## Prior work

- Architecture §9: a compiled value needs a **statically known representation**, not a fixed byte size. §10: keep Struct, Tuple, fixed Array, Vector and maps distinct, rather than collapsing them into JS object/Array.
- Implemented witnesses so far:
  - `U64`: bigint, modular arithmetic, decimal-string wire.
  - `Bool`, `Unit` and `Never`.
  - `String`: well-formed only (STR-001).
  - `Number`: f64 (NUM-001).
  - `Struct`, `TaggedUnion`, `Array` (`Vec<T>`), and `UndefinedOr` / optional fields (OPT-001–003).
- Known gaps that a JS-type crate could close:
  - **STR-007:** `serde_json` rejects lone-surrogate escapes in the whole request body.
  - The Query adapter's private `Vec<u16>` strings ([foldkit-query](foldkit-query.md)).
  - **NUM-004:** number encoding is parse-equal to `JSON.stringify` but not byte-equal; for example, `1e21` prints as `1e21`, where JS prints `1e+21`.

## Rust crates implementing JS types

| Crate (version, updated)                                       | What it gives                                                                                                                                                                                                                                       | Fit                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`ryu-js`](https://crates.io/crates/ryu-js) 1.0.3 (2026-07-10) | Boa's fork of `ryu`, following the ECMAScript Number::toString algorithm; `no_std`, no dependencies                                                                                                                                                 | **Good candidate.** Byte-exact `JSON.stringify`/`String(n)` for `R.Number`. It would replace the hand-written integer branch plus `serde_json` formatting in `js_number`. Gate it on reachability (only when a number is encoded or stringified), and verify it differentially against V8 on a corpus |
| [`boa_string`](https://docs.rs/boa_string) 0.22.0 (2026-08-28) | `JsString`: Latin1/UTF-16, reference-counted, immutable. It keeps lone surrogates, compares by UTF-16 code units, has `len()` in code units, `slice`, `concat`, `code_points`, `code_unit_at`, and lossy, escaped or checked conversion to `String` | **Semantically right but runtime-limited.** It is `!Send`/`!Sync`, so it cannot cross Tokio work-stealing tasks or live in server-lifetime services. It has no serde support. Usable only inside single-task helpers (for example, a Query evaluator), not as the general `R.String` representation   |
| [`js_int`](https://crates.io/crates/js_int) 0.2.2 (2022)       | JS-safe integers (±2^53 − 1)                                                                                                                                                                                                                        | Stale; a newtype over `i64` plus range checks is simpler to generate                                                                                                                                                                                                                                  |
| Whole engines (Boa, Nova, QuickJS bindings)                    | Full JS value model                                                                                                                                                                                                                                 | Out of scope: reffect compiles abstractions away and keeps official Effect as the oracle; embedding an engine is a "second JS runtime" the guidance rejects                                                                                                                                           |

Conclusion:

- **No crate should define reffect's value model.** Witnesses stay compiler-owned, and each operation states its JS meaning; crates are selected implementations behind it.
- `ryu-js` is worth adopting for number encoding.
- A **UTF-16 string profile** (`R.JsString`, which admits lone surrogates) would be a separate witness. It would be represented as a `Send` type such as `Arc<[u16]>`, or `boa_string` only where `!Send` is provably fine. It needs a raw-JSON envelope parser so the server can decode lone-surrogate escapes (STR-007). Defer it until a workload needs lone surrogates.

## How native sized types should work (proposal)

A witness is **semantic type + Effect Schema + native representation + operation semantics**. The user writes the Effect schema they would write anyway; reffect picks the tightest native representation that the **checks** prove, and operations keep JS meaning unless the operation says otherwise.

| R witness                                                  | Effect schema (unchanged contracts)                                                    | Native                           | Notes                                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `R.Int32`, `R.Uint32`                                      | `Schema.Number.check(Schema.isInt32())` / `isUint32()`                                 | `i32` / `u32`                    | Values are JS numbers. **Operations must name their overflow semantics**, because JS `a + b` on int32 values yields a double. Proposed ops: `addChecked` (fails on out-of-range), `addWrapping` (`(a + b) \| 0`), and widening to `R.Number` |
| `R.SafeInt`                                                | `Schema.Int` (`isInt`: safe integers)                                                  | `i64` (range-checked)            | Exact while results stay in ±2^53 − 1; arithmetic is checked                                                                                                                                                                                 |
| `R.U8`…`R.U64`, `R.I8`…`R.I64`                             | `Schema.BigInt` (or `BigIntFromString` on the wire) with `isBetweenBigInt(min, max)`   | `u8`…`u64`, `i8`…`i64`           | Generalizes the existing `U64` (modular) and `u64Range`. Each width needs explicit modular, checked or saturating operations                                                                                                                 |
| `R.F32`                                                    | none in Effect (JS has no f32 number)                                                  | `f32`                            | Only with `Math.fround` semantics in the reference; low priority                                                                                                                                                                             |
| `R.Tuple(A, B, …)`                                         | `Schema.Tuple([A, B])`                                                                 | `(A, B)`                         | JSON array of fixed length; `Tuple.get(i)` with literal indexes. Error texts need probing (index paths, length messages)                                                                                                                     |
| `R.Array(T, { length: N })`                                | `Schema.Array(T).check(Schema.isBetweenLength(N, N))`, or a homogeneous `Schema.Tuple` | `[T; N]`                         | Fixed-size inline storage; also covers Remote's array length checks (NR-002)                                                                                                                                                                 |
| `R.Bytes`                                                  | `Schema.Uint8Array` / `Uint8ArrayFromBase64`                                           | `Vec<u8>` (or `bytes::Bytes`)    | Wire encoding follows the chosen Schema transform                                                                                                                                                                                            |
| `R.Record(K, V)`                                           | `Schema.Record(Schema.String, V)`                                                      | ordered map with JS key order    | Next NR-002 slice; integer-like keys first, as recorded in the gap analysis                                                                                                                                                                  |
| `R.Struct`, `R.TaggedUnion`, `R.UndefinedOr`, `R.Array(T)` | done                                                                                   | struct / enum / `Option` / `Vec` | —                                                                                                                                                                                                                                            |

Principles:

1. **The Effect schema stays the contract.** The stock TS client and server must keep working, so sized types are refinements of ordinary JS types (`isInt32`, `isBetweenBigInt`), never new wire formats. A witness without an Effect schema cannot be authored.
2. **Representation selection is proved, not assumed.** As with NUM-002, NativeRpc recognizes checks by representation id and verifies them by running Effect's filters on probes at compile time.
3. **Overflow and rounding are operation semantics.** The reference implementation is the JS expression (for example `(a + b) | 0` or `Math.fround`), and native lowering must match bit for bit. Laws (commutativity and so on) are claimed per operation, with evidence.
4. **Ownership follows traits.** Sized integers, `f32`/`f64` and Copy-only tuples get `Copyable`, so they move and copy without `.clone()`. Tuples and fixed arrays of non-Copy items are Cloneable (REC-004).
5. **Opaque Rust-native types** (for example a user crate's `chrono::DateTime`) are a separate, later feature: a declared service or extension witness with an explicit Effect Schema codec and Rust implementation. They come with conformance evidence, not reflection (see [facet](facet.md)).

## Proposed order

1. Continue the Remote wire slices: `Record` (JS key order), then array length checks. Implement fixed arrays as `[T; N]` there, since Remote needs the checks anyway.
2. Adopt `ryu-js` for number encoding (byte-exact `JSON.stringify`) once a differential corpus shows parity.
3. Add `R.Tuple` when a workload uses `Schema.Tuple`.
4. Add `R.Int32`/`R.Uint32` and the BigInt widths when a workload needs them (SQLx column types in milestone 5 are the likely first one), each with explicit overflow operations.
5. Defer the UTF-16 `JsString` profile and opaque Rust types until there is a workload.

## Open questions

- Should `R.Int32` arithmetic default to checked (fail) or wrapping? Proposal: no default; the authored operation chooses, and plain JS `+` widens to `R.Number`.
- Is `ryu-js` output identical to V8 for all doubles, including subnormals and the exponent boundaries 1e21 and 1e-7? This needs a differential corpus before adoption.
- Will Remote or SQL workloads need lone surrogates at all? If not, the UTF-16 profile stays deferred.
