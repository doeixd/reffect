# String-keyed records (`Schema.Record(Schema.String, V)`)

Status: **accepted for implementation (2026-10-02)**. This is the third wire feature in the [native RemoteServer design](native-remote.md#order-of-work) (NR-002), after [numbers](number-profile.md) and [optional fields](optional-fields.md). Checked against installed Effect **4.0.0-rc.118** (`Schema.Record`, `SchemaAST.Objects.indexSignatures`, `effect/Record`) and the published `foldkit-remote` 0.9.0 wire module.

## Prior work

- The [gap analysis](remote-gap-analysis.md) counts 17 uses of `Schema.Record(Schema.String, X)` in Remote, all with plain `Schema.String` keys. They cover request `windows` and `relations` keyed by field name, entity `values`, and result maps such as `connections`, `grown`, `live` and refusal `fields`. Values include Structs, recursive relation levels, Number, String and `Unknown` (`Unknown` is a later slice).
- NR-003 requires JS own-property order wherever order reaches a client.
- [STR-007](string-profile.md): `serde_json` rejects lone-surrogate escapes for the whole body. Record keys are Rust `String`s, so this divergence covers keys as well.

## Pinned behavior

- Decoding iterates the input in **JS own-property order**: canonical array-index keys (`"0"` or no leading zero, at most 4294967294) first in ascending numeric order, then the other keys in insertion order. `"-1"`, `"01"` and `"4294967295"` are ordinary keys.
- A JSON text with a duplicate key (`{"a":1,"a":2}`) keeps the **first position and the last value** (`JSON.parse`).
- `__proto__` is an ordinary own key.
- A non-object (including arrays and `null`) fails with `Expected object`. A bad value reports the **first** failing entry in that order, with the key as a path segment (`... at ["b"]`). Inside `Schema.optional`, the mismatch text is `Expected object | null`, as in OPT-004.
- Encoding writes entries in the decoded value's JS order. Clients decoding a Record observe non-index key order, so native output order is observable even after `JSON.parse`.
- `effect/Record` offers `keys` (an `Array<string>` in JS order), `values`, `size` (a number), `has` (own key) and `get` (which returns an `Option`).

## Decisions

- **RECJS-001 — `R.Record(R.String, V)` witness.** Its Schema is `Schema.Record(R.String's schema, V)`; it is natively `Vec<(String, V)>` with distinct keys in JS order; it is Cloneable (REC-004). Only string keys are admitted. Literal, template-literal, symbol and number keys are refused.
- **RECJS-002 — operations mirror `effect/Record`:** `keys`, `values`, `size` and `has(self, key)`. They are pure, with JS meaning: `size` is a JS number, and `has` tests an own key. `get` waits for an `Option` witness (or an UndefinedOr variant decision), and constructors (`set`, `fromEntries`, `map`) wait for a workload. Values reach handlers only by decoding.
- **RECJS-003 — JS ordering natively.** Generated crates that reach a Record codec enable `serde_json`'s `preserve_order` feature, so objects keep insertion order with JSON.parse's duplicate-key rule. Decoders then stable-partition canonical array-index keys to the front in numeric order. Crates without records are unchanged.
- **RECJS-004 — contract keys.** The contract's plain `Schema.String` key (or `StringJson`) maps onto the R witness's well-formed key. Lone-surrogate keys cannot arrive natively (STR-007). In the reference, a decoded lone-surrogate key fails the witness input check; both sides refuse, with different messages, and the case stays outside the corpus.
- **RECJS-005 — refused for now:** keys other than String/StringJson, records with property signatures alongside the index signature (`StructWithRest`), more than one index signature, optional or contextual values, and checks or annotations on the record.

## Acceptance

- Reference: `keys`/`values`/`size`/`has` equal `effect/Record` on objects with index-like, `__proto__` and ordinary keys.
- Native RPC: raw requests strictly equal to the official server **including key order**. The comparison is `JSON.stringify(JSON.parse(body))` on both sides, which keeps insertion order. The requests cover mixed index and string keys, duplicates, wrong values (first failure in JS order), nested Records of Structs, optional Records, non-objects, empty records and handlers that return `keys`.
- Crates without Record codecs do not gain the `preserve_order` feature.

## Delivered (2026-10-02)

All decisions are implemented as recorded. Two details surfaced during implementation:

- Effect itself rejects `optionalKey` record values ("use `Schema.optional`"). `Schema.optional` values are refused by reffect (RECJS-005).
- The generated codec's Rust type helper now renders Record and UndefinedOr witnesses structurally. Previously it would have prefixed them with `reffect_generated::`.

Evidence: [records-js.test.ts](../../packages/reffect/tests/records-js.test.ts) 1/1 and [records-js-rpc.test.ts](../../packages/reffect/tests/records-js-rpc.test.ts) 2/2:

- About 30 raw requests: mixed index and string keys, duplicates, `__proto__`, non-finite values, wrong values in JS order, Remote-shaped optional `windows`, nested records, and `keys`/`values`/`size`/`has` handlers.
- Native and official responses are equal both as values and as key sequences.
- Each of the index-key partition and the `preserve_order` feature is checked by a mutation that fails the test when it is removed.
