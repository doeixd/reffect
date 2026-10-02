# Bounded owned-string profile

Status: **accepted for implementation**. Checked 2026-10-02 against installed Effect **4.0.0-rc.118** (`src/String.ts`), [ECMAScript `String.prototype.replaceAll`](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.replaceall) and [`GetSubstitution`](https://tc39.es/ecma262/multipage/text-processing.html#sec-getsubstitution), [`String.prototype.isWellFormed`](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.iswellformed), and Rust [`str::replace`](https://doc.rust-lang.org/std/primitive.str.html#method.replace) and [`str::contains`](https://doc.rust-lang.org/std/primitive.str.html#method.contains) (Rust 1.90). The workload comes from the [Foldkit SSR inventory](foldkit-ssr-inventory.md).

## Prior work

Searched after implementation (2026-10-02) and reconciled here:

- [Architecture §11 Strings](../architecture.md#11-strings) already chose canonical UTF-8 storage, with `&'static str`/`&str`/`String`/`Arc<str>` as ownership-driven codegen choices rather than DSL types. It asks for explicit `byteLength`/`scalarCount`/`graphemeCount` instead of an ambiguous `length`, keeps JS `.length` semantics if source transformation ever admits it, and leaves integer indexing out of the first core. This profile follows all of that.
- [Architecture §14](../architecture.md#14-ownership-and-borrowing-are-inferred) and [initial ownership rules](../implementation-milestones.md#17-initial-ownership-implementation) require move → borrow → share → clone. The first implementation copied at every value position; STR-002 now moves owned locals as described below.
- [Foldkit IR design](../foldkit-ir-design.md) and [compiler design revision](../compiler-design-revision.md) sketch `C.String.contains`/`concat` as ordinary operations with interpreter-declared support. This profile keeps Effect v4's `includes` name, per AGENTS.md's rule to mirror v4 spellings, under the semantic reference `reffect/string.includes@1`.
- [Rust emission research](rust-emit.md) already provides a Rust string-literal encoder distinct from the JSON escaper; lowering uses it.
- The PLAN's milestone-4 decision gate lists "owned strings/records and explicit unions", so this profile is part of the existing sequence.
- The Foldkit Query adapter already carries text as UTF-16 `Vec<u16>` in a private evaluator protocol. It must preserve lone surrogates and JS code-unit ordering for arbitrary rows ([Query record](foldkit-query.md)). That remains a separate, checked adapter profile.
- Native RPC decodes JSON with `serde_json`, which refuses lone surrogates in `\u` escapes, and its tags/field names already require valid Unicode.
- Foldkit SSR refuses NUL and lone surrogates before escaping (`assertRepresentable` in `serialize.ts`).

## Semantics compared

- **JS strings** are UTF-16 code-unit sequences and may contain lone surrogates; **Rust `String`** is UTF-8 and cannot.
- For **well-formed** strings, equality, substring containment and non-overlapping left-to-right replacement agree between the two encodings. Both encodings are injective and prefix-free over code points. A well-formed needle therefore cannot match half of a surrogate pair, so every match aligns to code-point boundaries in both.
- **These do not agree** and are not admitted: `length` (UTF-16 units versus bytes), indexing/slicing by position, ordering (JS orders by UTF-16 code units, Rust by code points, which differ above U+FFFF), case mapping (Unicode-version and locale dependent), regular expressions, an empty `replaceAll` search (JS inserts between code units, including inside surrogate pairs), and replacement strings containing `$` (JS applies `GetSubstitution` patterns such as `$&` and `$$`).

## Decisions

- **STR-001 — accepted: well-formed Unicode string witness.** `R.String` is a new IRType (`reffect/string@1`) whose Schema is `Schema.String` refined by `isWellFormed()`. Lone surrogates are refused at every decode boundary, as Foldkit SSR already requires; it is not a lossy replacement. Traits: Cloneable and Eq, not Copyable or ordered.
- **STR-002 — accepted: owned `String` with borrowed helpers.** Function parameters, results and computed locals are owned `String`. Helper parameters are `&str` and operations take borrows. A block's final expression moves an owned computed local, since it runs after every operand borrow. A value-position use of a borrowed helper parameter takes a necessary owned copy. Moving owned top-level parameters into results is a later refinement.
- **STR-003 — accepted: admitted operations.** `R.String.literal`, `eq`, `includes(search)` (dynamic search allowed, by the alignment argument above) and `replaceAll(search, replacement)`, whose search and replacement must be **literals** with a non-empty search and no `$` in the replacement. Effect's v4 data-last forms are mirrored, with data-first forms through `dual`. Literal-argument constraints are a new optional `Operation` property enforced by the checker, so hand-built `Expr.apply` cannot bypass them.
- **STR-004 — accepted: native lowering.** `eq` → `==` on `&str`; `includes` → `str::contains`; `replaceAll` → `str::replace` (all non-overlapping matches, left to right). No crate. The native runner encodes string arguments and results as `str:` plus lowercase hex of the UTF-8 bytes, so NUL and arbitrary text cross the process boundary without quoting.
- **STR-005 — accepted: refused positions in this slice.** Delayed-cleanup captures, log attributes/annotations, `Launch` values and RPC payloads of string type are refused. The RPC JSON string codec is the next slice.

## Workload and acceptance

Port Foldkit `escapeText` and `escapeAttributeValue` as R functions: fail with `false` if the input contains NUL, otherwise apply literal `replaceAll`s in table order (`&` first). Vendor the pinned upstream functions as a licensed test fixture and compare upstream, reference and native debug/release on a generated corpus: ASCII, every escaped character, astral and combining characters, CR/CRLF, NUL (both fail) and lone surrogates (upstream throws; reffect refuses at input decode). Checker tests cover non-literal or `$` replacement arguments, an empty search and string captures in delayed cleanup.

## Delivered implementation

Delivered 2026-10-02 as decided. `StringType`, `EqString`, `IncludesString` and `ReplaceAllString` live in `kernel.ts`, and `Operation.withLiteralArguments` adds the checked literal-operand constraint (`LITERAL_ARGUMENT`). An `isWellFormed` helper is used because the package's TypeScript lib predates ES2024. Lowering flags string-typed values: operands render as `&*x`, and value positions render `(&*x).to_owned()` or `String::from("…")`. Delayed-cleanup captures of string parameters report `RESOURCE_ESCAPE`.

Evidence: [string-profile.test.ts](../../packages/reffect/tests/string-profile.test.ts) passes 3/3. Reference results equal the vendored pinned upstream `escapeText`/`escapeAttributeValue` ([fixture](../../packages/reffect/tests/fixtures/foldkit-escape.ts)) on ten well-formed inputs, including astral, combining, CR/LF and `$` text. NUL inputs fail with `false` where upstream throws; four lone-surrogate inputs are refused with `INVALID_INPUT` where upstream throws. Refusal tests cover empty search, `$` replacement, lone-surrogate literals, hand-built non-literal or `$` applications and delayed string captures. Native debug/release under both frame policies agree with the reference for both escapers, `includes` (including astral and empty needles) and a branch that returns borrowed parameters; lone surrogates are refused before the process starts. Generated code is dependency-free. A follow-up removed the extra copy when returning a freshly computed local.

## Deferred

`length`/slicing with explicit UTF-16 semantics, ordering, concatenation and template building, case mapping, regular expressions, string RPC/JSON codecs, string service values and log attributes.
