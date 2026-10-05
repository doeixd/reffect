# Optional struct fields (`Schema.optional` / `Schema.optionalKey`)

Status: **accepted for implementation (2026-10-02)**. This is the second wire feature in the [native RemoteServer design](native-remote.md#order-of-work) (NR-002), after [numbers](number-profile.md). Checked against installed Effect **4.0.0-rc.118** (`Schema.optional`, `Schema.optionalKey`, `SchemaAST.replaceContext`, `effect/UndefinedOr`). Probed with `Schema.toCodecJson` and `SchemaIssue.makeFormatterDefault()`, which formats the official server's errors.

## Prior work

- The [gap analysis](remote-gap-analysis.md) counts 14 `optional` and 1 `optionalKey` fields in Remote's wire (28/1 including nested uses). They cover window bounds, `windows`, `relations` and optional result arrays. One case is `optionalKey(Never)`, which refuses `relations` on the last relation level.
- The [records design](records-unions.md) (REC-001–005) lowers `R.Struct` to a Rust struct whose fields are in declaration order. It explicitly refused optional fields.
- Effect v4 ships an `UndefinedOr` module (`map`, `match`, `getOrThrow`, …) for plain `A | undefined` values. R mirrors it rather than inventing an Option-like API.

## Pinned behavior

| Input for field `f`              | `optional(T)` (AST: `Union[T, Undefined]`, `isOptional`)             | `optionalKey(T)` (AST: `T` copy, `isOptional`) |
| -------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------- |
| key absent                       | absent                                                               | absent                                         |
| `null`                           | **present** with `undefined` (`"f" in value`)                        | T's own failure for `null`                     |
| value of a JSON kind T accepts   | T's decoding, with T's own messages (checks, nested paths, bad tags) | same                                           |
| value of a JSON kind T rejects   | `Expected <T's kind mismatch> \| null`                               | T's kind mismatch                              |
| encode: absent / `undefined` / v | omitted / `null` / T's encoding                                      | omitted / — / T's encoding                     |

- Decoded and encoded keys follow the **schema's** declaration order, not the input's.
- "Kinds T accepts" follow Effect's union candidate filtering: boolean → boolean; string → string; u64 (`BigIntFromString`) → string; plain number → number or string; finite/integer number → number; non-empty Struct → object (not array); Array → array; tagged union → object (an object with a bad tag reports the union text **without** `| null`); Never → none.
- `optional(Struct({}))` accepts **any** non-null value (`1`, `"s"`, …), because the empty struct's candidate check is lax. `optionalKey(Struct({}))` rejects `null` with `Expected object | array`.
- `optionalKey(T)` copies T's AST and adds a context. Identity-based recognition (the `StringJson`/`U64Json` codecs) must therefore compare the shared `checks` array, not the AST object.

## Decisions

- **OPT-001 — `R.UndefinedOr(T)` witness.** It represents a plain `T | undefined` (`Schema.UndefinedOr`), natively `Option<T>`; it is Cloneable but not Copy (REC-004). It is refused for `T` that already admits `undefined` (Unit, another UndefinedOr). Operations mirror `effect/UndefinedOr`: `match(self, { onUndefined, onDefined })` and `map(self, f)`. Both are pure, and their handlers return `Expr`. Effectful matching waits for a workload.
- **OPT-002 — field markers mirror Schema.** `R.Struct({ a: R.optional(T), b: R.optionalKey(T) })` builds `Schema.optional`/`Schema.optionalKey` fields. `Struct.get` on either returns `UndefinedOr<T>` (absent reads as `undefined`, as in JS). `make` may omit an optional key (absent). An `optionalKey` field takes a `T`; an `optional` field takes a `T` or an `UndefinedOr<T>`, and an UndefinedOr value is always **present**. This is the JS meaning of `{ a: x }`.
- **OPT-003 — presence is native data.** An `optionalKey(T)` field is `Option<T>` (None = absent). An `optional(T)` field is `Option<Option<T>>` (None = absent, `Some(None)` = present `undefined`), because the official encoder writes `null` for a present `undefined` and omits an absent key. Echo handlers therefore round-trip `{}` and `{"f":null}` exactly.
- **OPT-004 — generated codecs with verified mismatch text.** Struct codecs decode optional fields by presence. `optional` fields map `null` to present `undefined`, and other values whose JSON kind T rejects to `<T's mismatch> | null`. Values of an accepted kind delegate to T's decoder. The kind table is **verified while compiling**: for one probe of each JSON kind, Effect's own decoding of `Struct({ f: optional(T) })` must produce exactly the predicted text when the kind is rejected. `optional(Struct({}))` is refused (OPT-005).
- **OPT-005 — refused for now:** `optional(Struct({}))` (Effect's lax candidate); optional fields in **projected** payload bindings (bind the whole Struct instead; Remote's payloads are whole Structs); `Schema.optional` over unions other than `[T, Undefined]`; nested `UndefinedOr` fields; default values and `exactOptional`-style transformations (encodings on the property).

## Acceptance

- Reference: `make` produces present and absent keys in declaration order, `get` reads `undefined` for both, and `UndefinedOr.match`/`map` equal Effect's `UndefinedOr` functions.
- Native RPC: raw requests with optional and optionalKey fields over Boolean, `StringJson`, `U64Json`, plain/checked numbers, Structs, Arrays, tagged unions and Never (absent, `null`, valid values, every wrong JSON kind, nested failures). Responses must be strictly equal to the official server's, including echoes that preserve absent versus present-`undefined`. A stock client must round-trip optional fields.
- Refusals for each OPT-005 case.

## Delivered (2026-10-02)

All decisions are implemented as recorded. Two details surfaced during implementation:

- Required keys can also carry a key context: `Schema.tag` has a constructor default. Recognition therefore treats only `isOptional` contexts as optional, and refuses mutable, defaulted or annotated keys.
- A `Never` field reached struct codecs for the first time (`optionalKey(Never)`); the generated decoder now has `never_in` (`Expected never`).

Evidence: [optional-fields.test.ts](../../packages/reffect/tests/optional-fields.test.ts) 3/3 and [optional-rpc.test.ts](../../packages/reffect/tests/optional-rpc.test.ts) 2/2. About 170 raw requests cover every optional field kind with absent, `null`, valid and wrong-kind values, plus nested failures. Native responses are strictly equal to the official server's, and a mutation that decodes `null` as absent fails the test. Lone-surrogate escapes stay excluded as the known whole-body divergence (STR-007).

## `NullOr` values (2026-10-05)

**Need.** Upstream selection schemas use `Schema.NullOr` for nullable columns (`email: Schema.NullOr(Schema.String)`) and optional relations (`nullable(...)`). A native page view selecting either is refused, because R has no `NullOr` witness and the contract codec refuses non-tagged unions. See [relations in page views](ssr-data.md#relations-in-page-views-2026-10-05).

**Facts** (effect 4 installed here, probed 2026-10-05 with `Schema.toCodecJson`):

- Effect v4 has `Schema.NullOr`, `Option.fromNullOr`, `Option.getOrNull` and `Predicate.isNull`, but no `NullOr` data module like `UndefinedOr`.
- A decode whose JSON kind is wrong reads `Expected <item> | null`, for example `Expected string | null` or `Expected object | null`. A matching kind that fails inside reports the item's own error at the inner path. `null` decodes to `null` and encodes as `null`.
- On the wire this is exactly what an `optional(T)` field's present-but-`undefined` value already is (OPT-003), and natively both are `Option<T>`.

**Decisions.**

- **OPT-006 — `R.NullOr(T)` witness.** It represents `T | null` (`Schema.NullOr`), natively `Option<T>`, with its own identity (`reffect/null-or@1`). It shares the `UndefinedOr` layout and its kernel nodes (`Defined`, `Undefined`, `MatchUndefined`), with an `absent` of `null`. The reference evaluates the absent value as the witness says. This follows the guidance to expose a shared node rather than duplicate behaviour under two names. It is refused for `T` that already admits `null` (another `NullOr`, `Unknown`).
- **OPT-007 — Effect's surface only.** `R.Option.fromNullOr` and `R.Option.getOrNull` convert, so a value is matched with `R.Option.match`. `R.UndefinedOr.match`/`map`, `Option.fromUndefinedOr` and other `undefined`-only operations refuse a `NullOr` witness. `undefinedOrItem` keeps meaning `undefined` only, and a separate `optionalItem` serves the shared nodes.
- **OPT-008 — contract codec.** `Schema.NullOr(X)` (`Union[X, Null]`) derives `R.NullOr(witness(X))`. Its generated Rust decoder maps `null` to `None`. A wrong JSON kind fails with the mismatch text, which is verified against Effect's own decoder by the optional-field probe (`verifyOptional` on a `NullOr` property). Otherwise it decodes the item into `Some`. Encoding writes `null` for `None`.

**Alternatives.** _A new `NullOr` layout and kernel nodes_ was rejected: it duplicates every match, lowering and check of `UndefinedOr` for a difference that exists only in the JS reference. _Mapping `NullOr` onto `UndefinedOr`_ was rejected: the reference value would be `undefined` where Effect's is `null`.

**Acceptance.**

- Reference and native agree on `fromNullOr`/`getOrNull` round trips.
- The contract codec decodes and encodes `NullOr` fields with Effect's exact texts across JSON kinds, natively against Effect.
- A native page selecting a nullable column and an optional relation renders byte-equal to upstream, including a `null` owner.

**Implemented (2026-10-05).**

- **Kernel.** `absent` is on the `UndefinedOr` layout, with the helpers `optionalItem`, `absentOf` and `nullOrItem`. The shared nodes evaluate the witness's absent value.
- **Authoring.** `R.NullOr`/`NullOrType` are in `records.ts`, and `R.Option.fromNullOr`/`getOrNull` in `option.ts`.
- **Contract codec.** The `nullable` composite verifies its texts with `verifyOptional`, and its Rust decoder and encoder are in `native-rpc.ts`.
- **Lowering.** The native-name collision check now skips the structural `Option<T>`, which an `UndefinedOr` and a `NullOr` of one item share.
- **Validation:**
  - `tests/optional-rpc.test.ts` passes 2/2. The new `Nulls` procedure, with nullable string, struct, number and array fields, matches the official server on every JSON kind of each field, and round-trips `null` through a stock client.
  - `tests/optional-fields.test.ts` passes 4/4, covering the reference round trip and the nesting and `undefined`-only refusals.
  - `tests/remote-page-relations.test.ts` passes 1/1 with a nullable `email` and a `null` optional `author`.
