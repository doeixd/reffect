# Records and tagged unions

Status: **accepted for implementation (2026-10-02)** with the defaults below; part 1 (IR, reference, native) then part 2 (RPC codecs). Prepared 2026-10-02 for the "Before milestone 4" gate (owned strings/records, explicit unions, portable Schema subset). Checked against installed Effect **4.0.0-rc.118** (`Schema.Struct`, `Schema.TaggedStruct`, `Schema.TaggedUnion`, `Schema.Union`, `Schema.Literals`, `Struct.get`, `Match.valueTags`) and the Remote wire schemas in the `doeixd/foldkit-plus` checkout at `67cf3735` (`packages/remote/src/wire.ts`).

## Prior work (searched first)

- [Architecture §7–§10, §12–§13](../architecture.md#8-effect-schema-is-the-semantic-type-system): Effect Schema is the semantic type system; `Struct` lowers to a Rust `struct` and `Enum` to a Rust `enum`; traits (Eq, Hash, Ord, Copy, Clone) derive structurally; Struct is distinct from dynamic `HashMap`/`OrderedMap`; immutable updates may compile to mutation when ownership proves it unobservable. Some of this is preserved conversation; the schema-as-type-system and Struct/Map distinction are treated as decisions, the rest as context.
- [Compiler design revision §5](../compiler-design-revision.md#5-core-semantic-model): keep semantic, native, wire and storage representations separate.
- [Basic Effect IR](basic-effect-ir.md): `R.Match.bool` is Boolean-only; "owned String/record/union representations, full tagged Match, automatic error unions" were deferred to this gate.
- [Schema profile](schema-profile.md) and [unary RPC](unary-rpc.md): flat Struct payloads are currently boundary projections into scalar arguments, not domain records; native invalid-input diagnostics must match the pinned server.
- [String profile](string-profile.md): owned values move or borrow per §17; strings are non-Copy, so records containing them are too.
- [Foldkit Remote](../foldkit-remote.md#and-the-normalized-data-format-maps-cleanly-to-rust): sketches `enum Boundary { Terminal, Cursor(String), Unknown }`.

## Workload evidence

Core `foldkit/foldkit` does not contain Remote. `remote`, `remote-server`, `remote-drizzle`, `entity`, `ssr` and other ecosystem packages live in `doeixd/foldkit-plus`, a collection of Foldkit ecosystem packages (not a fork). The Remote sources use roughly 96 `Schema.Struct`, 41 `Array`, 23 `Literal`, 17 `Record`, 11 `Union`, 7 `TaggedError` and 4 `NullOr` occurrences. `WireBoundary` is `Union([Struct({_tag: Literal("Terminal")}), Struct({_tag: Literal("Cursor"), cursor: String}), Struct({_tag: Literal("Unknown")})])`, and `position` fields are `Union([Literal("prepend"), Literal("append")])`. Numeric fields use `Schema.Number` with integer checks, not bigint.

## Proposed decisions

- **REC-001 — Struct witness from Effect Schema.** `R.Struct({ field: witness, … })` builds an IRType whose Schema is `Schema.Struct` of the field witnesses' schemas; identity is structural (field names and witness identities), matching Effect Schema. Native: a generated Rust `struct` named from a canonical structural digest, with traits derived from fields (Copy only if every field is Copy).
- **REC-002 — Tagged unions as Rust enums.** `R.TaggedStruct(tag, fields)` and `R.TaggedUnion({ Tag: fields })` mirror v4. Lowering emits a Rust `enum` with one variant per tag; `R.Literals([...])` of strings becomes a field-less enum. Untagged unions and non-literal discriminants are refused.
- **REC-003 — Construction, access and matching.** Construction `R.Struct.make`/tagged constructors; field access mirrors `Struct.get("field")`; exhaustive matching mirrors `Match.valueTags(value, { Tag: (case) => … })`, generalizing `R.Match.bool`. Branches receive symbolic cases; missing tags are type and checker errors.
- **REC-004 — Ownership.** Field access borrows; moving a whole record follows the move/borrow/clone order from §17. Records with only Copy fields stay Copy.
- **REC-005 — Wire codecs.** The RPC boundary recognizes `Schema.Struct`, `Schema.TaggedStruct`/`TaggedUnion` and equivalent `Union` of `_tag`-literal Structs whose fields are admitted codecs, structurally from SchemaAST rather than by registered identity (identity registration stays for refined scalars such as `U64Json`). Native decode/encode errors must match the pinned server for admitted shapes, including `_tag` failures.

## Pinned upstream behavior (probed 2026-10-02)

Probed with the official RC.118 `RpcServer`, raw JSON bodies and `RpcSerialization.layerJson`:

- `Schema.TaggedUnion` builds `Union` of `TaggedStruct`s; each `_tag` is a `Literal` whose AST carries `context` (a constructor default), unlike a hand-written `Literal`. Both shapes decode identically. The union exposes `cases`, `guards`, `isAnyOf` and a dual `match(value, cases)`; `Match.valueTags` is the generic form; `Struct.get` is dual.
- Decoding selects a union case by its `_tag` sentinel. A missing, unknown or non-string `_tag`, or a non-object value, fails with one message: the union's `expected` annotation, or the de-duplicated members joined by `|`, where a member with literal properties prints as `{ readonly "_tag": "Cursor", ... }` (`SchemaAST.Union.getExpected`). Inside a selected case, errors carry paths: `Missing key\n  at ["cursor"]`, `Expected string\n  at ["cursor"]`, and nested `at ["boundary"]["cursor"]`.
- A non-object Struct fails with `Expected <identifier>` when annotated, otherwise `Expected object`. Field errors follow schema order; only the first error is reported. Excess properties are ignored and dropped.
- Encoded output lists `_tag` first, then fields in schema order. `Schema.Literals(["a","b"])` and a `Union` of literals both fail with `Expected "a" | "b"`.

## Implementation decisions

- **REC-001 (refined):** witnesses are interned by structure (field names in order and field witness identity), so identical structures share one witness and `IRType.same` stays reference equality. `.annotate({ identifier })` mirrors Effect and yields a distinct witness because diagnostics differ. Rust names use the identifier when present (validated, unique), otherwise a readable prefix plus a stable digest of the structure.
- **REC-002 (refined):** `R.TaggedUnion({ Tag: fields })` holds case witnesses (`cases.Tag`); case constructors `cases.Tag.make({...})` return a **union-typed** value, narrower than Effect's case-typed value. Native: one Rust struct per case (without `_tag`) and an enum whose variants wrap them.
- **REC-003 (refined):** new Expr nodes `Make`, `Get` and `MatchTags`, plus a Computation `MatchTags`, instead of synthetic operations: construction, projection and branching are language primitives like `Match`. `Union.match(value, cases)` and `R.Match.valueTags` share the node. Cases receive the case-struct value; exhaustiveness is checked in types and by the checker.
- **REC-004 (refined):** non-Copy values follow one uniform rule. Parameter and bound names are borrows (`&T`, or `&str` for strings; top-level owned parameters are shadowed to borrows), computed locals are owned, field access is a place expression (borrowed as an operand, cloned only in value positions), and a block's final owned local moves. Strings move onto this rule. Composite witnesses are not Copy in this slice.
- **REC-005 (refined):** contract `Struct`/`TaggedUnion`/`_tag`-literal `Union` schemas whose leaves are admitted codecs are recognized structurally and mapped to the interned witness. Generated decoders/encoders reproduce the messages above, including identifier/`object`, union expected text, schema-ordered first error and nested paths. Divergence recorded: native JSON key order follows serde_json, so bytes differ while decoded values are identical.
- **REC-006: runner boundary.** The dependency-free native runner keeps scalar arguments and results; functions with composite signatures get a refusing runner arm, and composite I/O is verified through `NativeRpc`.

## Open questions

- Resolved: Rust names use Effect's `identifier` annotation when present, otherwise a digest (REC-001).
- Deferred to the next slice: whether typed error unions (`Data.TaggedError`/`Schema.TaggedError` in error channels) belong in this slice or the next; Remote uses them for `RemoteReadError | RemoteProtocolError`.
- `Schema.Number` with integer checks needs its own numeric decision (JS double versus a native integer), separate from this gate.

## Deferred

`Array`/`Vector`, `Record`/maps (JS key-order semantics are a hazard), `NullOr`/`Option`, struct update/spread, nested recursive types and SQL storage mappings.

## Acceptance (proposed)

A first slice ports `WireBoundary` and a small string/u64 Struct. Reference results equal official Effect Schema decode/encode and `Match.valueTags`; native debug/release agree; a stock RPC client round-trips both through `NativeRpc` with exact invalid-input parity (wrong `_tag`, missing field, wrong field type). Type contracts reject missing match cases and unknown fields.
