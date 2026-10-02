# Raw `Schema.Unknown` as JSON data

Status: **accepted for implementation (2026-10-02)**. This is the last generic wire feature in the [native RemoteServer design](native-remote.md#order-of-work) (NR-002). Checked against installed Effect **4.0.0** (`Schema.Unknown`, its `toCodecJson` link, `RpcServer`) and the published `foldkit-remote` 0.9.0 wire module.

## Prior work

- Remote uses `Schema.Unknown` for entity `values: Record(String, Unknown)` (reads, live changes), mutation `input`/`output`, and query `input`. NR-002 says these are "produced and decoded by the engine, never by IR". R only needs to carry them.
- [Records](records-js-order.md) (RECJS-003) established JS key order natively, with `preserve_order` and an index-key partition.
- [Numbers](number-profile.md) (NUM-004/005) established JS number encoding and the `1e400` whole-body divergence. [Strings](string-profile.md) (STR-007) established the lone-surrogate whole-body divergence.

## Pinned behavior

An official server echoing `Schema.Unknown` returns the value **as `JSON.parse` saw it**:

- Objects at every depth are in JS own-property order (`{"b":1,"2":0}` → `{"2":0,"b":1}`). A duplicate key keeps its first position and its last value. `__proto__` is an ordinary key.
- Numbers are doubles, re-serialized by `JSON.stringify`: `1.0` → `1`, `1e2` → `100`, `-0` → `0`, `12345678901234567890` → `12345678901234567000`.
- `1e400` (`Infinity`) fails the request with `Expected JSON value` (at the field path). Natively this is a whole-body parse failure (NUM-005b).
- A missing required `Unknown` key is `Missing key`, and `null` is an ordinary value.

## Decisions

- **UNK-001 — `R.Unknown` witness.** It represents `Schema.Unknown`, restricted in this profile to JSON data that arrived by decoding, and is natively `serde_json::Value`. It is Cloneable (REC-004). There are no R operations or literals: values are only carried through structs, records and arrays to handlers, engines and encoders. A literal of `R.Unknown` is refused while checking.
- **UNK-002 — normalized at decode.** The native decoder rebuilds the value as `JSON.parse` would. Numbers become doubles encoded with JS rules (`js_number`), and objects are rebuilt recursively in JS key order. Encoding then writes the stored value unchanged.
- **UNK-003 — a JSON capability and dependency.** A reachable `R.Unknown` (including inside layouts) derives `reffect/capability/json@1`. The plan then lists `serde_json`, and the generated crate depends on it with `float_roundtrip` and `preserve_order`. Programs without Unknown are unchanged. The native runner refuses Unknown arguments and results, as it refuses other composites.
- **UNK-004 — refused:** `Schema.optional(Unknown)` (in Effect, `null` matches `Unknown` before `Undefined`, so presence semantics differ from OPT-003; no workload needs it), Unknown with checks or annotations, and `Schema.Any`.

## Open question for the Remote contract (recorded 2026-10-02)

Remote's request schemas decode **plain `Schema.String`** everywhere: entity names, ids, `requestId`, `mutation` and the `Fields` arrays. reffect refuses that (STR-006), because the official server accepts lone-surrogate strings and native `String` cannot represent them. Compiling `RemoteRpc` unchanged needs one of these:

1. Admit plain `Schema.String` for decoding, accepting that lone-surrogate escapes become a whole-body `Invalid JSON` defect natively, where the official server accepts them. This extends STR-007 from a refusal mismatch to an acceptance mismatch.
2. A UTF-16 text profile, which keeps lone surrogates (see [native types](native-types.md)).
3. Changing Remote's wire to `StringJson`, a foldkit-plus contract change.

Remote's responses also contain a non-tagged literal union (`position: "prepend" | "append"`), which needs its own small codec slice.

## Acceptance

- Raw requests carrying Unknown at the top level, in struct fields, in `Record(String, Unknown)` and in arrays (key reordering, duplicate keys, `__proto__`, number normalization including `-0` and large integers, nesting, `null`, a missing key) must give responses strictly equal to the official server's, with key order compared.
- A plain program reaching `R.Unknown` plans `serde_json`; one without it does not.

## Delivered (2026-10-02)

UNK-001–004 are implemented as recorded. Evidence: [unknown-rpc.test.ts](../../packages/reffect/tests/unknown-rpc.test.ts) 2/2.

- Responses are compared as values and by **raw key order**. An order-preserving reader was needed because `JSON.parse` itself moves index keys first. With it, a mutation that drops the JS key partition fails the test; a comparison after parsing missed that mutation.
- Number leaves are compared by value. Their text differs only in form (`1.2345678901234567e+19` versus `12345678901234567000`, NUM-004); `ryu-js` would make it byte-exact ([native types](native-types.md)).
- The records test checks index-key order through `Record.keys`, not raw bytes. A raw check like this one would strengthen it.
