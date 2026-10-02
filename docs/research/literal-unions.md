# String literal unions (`Schema.Literals`)

Status: **accepted for implementation (2026-10-02)**. This is the last wire gap before the full Remote contract can compile (see [Unknown record](unknown-json.md) and [native RemoteServer design](native-remote.md#order-of-work)). Checked against installed Effect **4.0.0** (`Schema.Literal`, `Schema.Literals`, union JSON codecs).

## Prior work

- Remote's mutation and live results declare `position: Schema.Union([Schema.Literal("prepend"), Schema.Literal("append")])`. This is a plain union of string literals, not a `_tag` discriminant.
- [Records/unions](records-unions.md) handle `_tag` literals only inside tagged structs.

## Pinned behavior

- `Schema.Union([Literal("a"), Literal("b")])` and `Schema.Literals(["a", "b"])` are both a `Union` of `Literal` nodes, with the same codec.
- A wrong value fails with `Expected "a" | "b"`, each literal JSON-quoted and joined by `|`. A single `Schema.Literal("a")` fails with `Expected "a"`.
- Inside `Schema.optional`, a wrong **string** keeps `Expected "a" | "b"`, while other kinds read `Expected "a" | "b" | null` (OPT-004 kinds: string).

## Decisions

- **LIT-001 — `R.Literals(["a", "b"])` witness.** It mirrors `Schema.Literals` for **string** literals: a Rust enum with unit variants (named from the literal when it is a Rust identifier, otherwise positional). It is Copyable, Cloneable and Eq. Values come from `witness.literal("a")`, which lowers to the enum variant. Matching and equality operations wait for a workload.
- **LIT-002 — RPC mapping.** NativeRpc maps a union of plain string `Literal` nodes, or a single top-level string `Literal`, onto the witness. Decoding matches the JSON string exactly, and the mismatch text is `expectedOf` from Effect itself. Encoding writes the literal string.
- **LIT-003 — refused:** number, boolean and bigint literals, mixed unions of literals and other members, and annotated or checked literal unions.

## Acceptance

- Raw requests with the union at the top level, as a struct field and inside `Schema.optional` (each literal, a wrong string, wrong kinds, `null`) must give responses strictly equal to the official server's. Handler-constructed literals encode identically.

## Delivered (2026-10-02)

All decisions are implemented as recorded. Evidence: [literals-rpc.test.ts](../../packages/reffect/tests/literals-rpc.test.ts) 2/2. One routing fix was needed: a top-level single `Schema.Literal` now reaches the composite path.
