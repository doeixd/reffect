# Internal Rust emission helpers — 2026-10-01

## Evidence and scope

- Checked the Rust Reference use-declaration grammar and `macro_rules!` grammar
  on 2026-10-01: [use declarations](https://doc.rust-lang.org/reference/items/use-declarations.html)
  and [macros by example](https://doc.rust-lang.org/reference/macros-by-example.html).
  The generated crate is edition 2021; local validation toolchain is rustc/cargo
  1.90.0. `use` supports visibility and nested trees/renames/globs; declarative
  macros consist of delimited matcher/transcriber rules, metavariables and
  repetition. The Reference documents additional edition-sensitive fragment
  specifiers and macro scope/hygiene details.

- Read [rust-emission.md](../rust-emission.md) (helper boundaries table), `source-writer.ts`
  (byte counting, surrogate-pair chunk guard, mapped/unmapped writes),
  `lower.ts` `emitFunctions` (all core `src/lib.rs`/`src/main.rs` emission),
  `foldkit-runtime.ts` (static template) and `foldkit.ts` (own evaluator
  bridge). All core-compiler Rust text flows through `emitFunctions`; the
  Foldkit bridge has a separate emitter and stays out of scope for this slice.
- Failure history: hand-counted `{`/`}` across `write()` calls produced an
  unclosed-delimiter crate, and a hand-built `eprintln!` format string silently
  relied on manual `{{`/`}}` doubling. Both classes are addressed structurally.
- Installed dependency versions unchanged; no new dependency (build-time TS only).

## Decisions

- Internal module `packages/reffect/src/rust-emit.ts`, consumed by `lower.ts`
  and imported directly by tests; it is intentionally not exported from the
  package barrel. The module stays an internal compiler construction API.
- Role-branded opaque fragments (`Rs.Expr`, `Rs.Stmt`, `Rs.Item`,
  `Rs.Type`, `Rs.Pat`) carrying rendered text. Builders validate at
  construction; combinators concatenate. No validation of borrowck/traits —
  rustc remains the authority (per the design doc).
- `RustIdent`: ASCII pattern validation, empty rejection, keyword set with
  `r#` raw form via a separate `raw` factory (`make` rejects keywords).
  `make` is for compiler-generated names; `raw` is audited-static only and
  never touches user text (user names are always prefixed today).
- Types built from parts (`named`, `unit`, `path`, `result`, `vec`, `str`,
  `u8`, `usize`, `bool`, `infallible`), never interpolated from unchecked
  strings. `verbatimType` exists for audited scaffolding only.
- Literals: range-checked `u64` (bigint, 0..2^64-1), `bool`, `unit`, and a
  real Rust string encoder (`\"`, `\\`, `\n\r\t`, `\u{...}` with braces,
  lone surrogates escaped — deliberately NOT the JSON escaper, which uses
  braceless `\uXXXX`).
- `formatString(parts)` escapes literal `{`/`}` automatically and inserts
  `{}` holes, removing the manual-doubling hazard from `println!`/`eprintln!`.
- Structural `block`, `match_`, `if_`, `let_`, `fnItem` builders own their
  delimiters; unit tests lock exact whitespace so migration stays byte-identical.
- Existing escapers (`escapeRustString`, JSON helpers, `frameLiteral`
  construction) are reimplemented on top of the module — one escaping
  authority. `frameLiteral` keeps its shape (JSON-in-Rust-string) but uses it.
- `verbatimExpr/verbatimItem` narrowly-named escape hatches for audited static
  scaffolding (preludes); unmapped by default at the call site.
- Expanded the built-in inventory during implementation for common compiler
  constructs: Option/Result constructors and combinators, iterator adapters and
  composable method chains, `format!`/`write!`/printing with automatic brace
  escaping, assertions, String/Box/Vec conveniences, patterns, arrays/ranges/
  struct expressions, casts, await/try, unwrap helpers and unreachable matches.
  These remain syntax-only helpers; no runtime abstraction or semantic claim is
  introduced. `Rs` remains module-internal (tests import the module directly
  rather than publishing it from the package barrel).
- Extension mechanics: tagged expression/type/pattern/item templates accept
  only holes of the fragment role they produce. `defineFn` gives a TypeScript
  helper author symbolic references to declared parameters and returns both a
  generated item and a call builder whose argument tuple is inferred from the
  parameter tuple; runtime arity checks remain for JS callers. This guarantees
  fragment-role and helper-call shape at TypeScript construction sites, not
  Rust type/trait/borrow validity. No arbitrary macro/plugin or public package
  extension contract is implied.
- Module-level additions are deliberately grammar-shaped: validated paths and
  visibility values, recursive `use` trees, named inline/external module items,
  and declarative macro rules made from typed token trees/groups/metavariables/
  repetitions. This supports ordinary import/re-export and common `macro_rules!`
  definitions without pretending to parse arbitrary Rust. Macro lexical
  follow-set validity, name resolution and hygiene remain rustc obligations;
  no procedural-macro support is claimed.
- `RsModuleFile` is a distinct branded final source role. Inline/external
  modules and nested imports are assembled from `RsItem`/`RsUseTree`; visibility
  is a closed value set (`private`, `pub`, `pub(crate)`, `pub(super)`,
  `pub(in crate/self/super path)`). `#[macro_export]` is modeled on declarative
  macro definitions; macro re-exports use ordinary structured `use` items.
- Core emitter migration: `lower.ts` now builds both preludes, every
  result/signature type, frame/log JSON string literals, `print` output
  expressions, the CLI match arms and `src/main.rs` through `Rs`. The
  interleaved helper/function bodies are composed with `MappedFragment`
  (`joinFragments`/`mapFragment`/`textFragment` in `source-writer.ts`), which
  carries authored ranges as UTF-8 byte offsets relative to the fragment;
  `SourceWriter.writeFragment` turns them into file coordinates. This removes
  the hand-assembled raw Rust templates without collapsing nested definition/
  use attribution.
- `joinFragments` measures UTF-8 offsets lazily, so artifact-off compilation
  never touches `TextEncoder` (preserving the None-policy fault-injection
  contract).
- Byte **and** range identity were verified by diffing generated
  `src/lib.rs`/`src/main.rs` plus the full `sources.ranges` array from the
  pre-migration emitter against the migrated one across a matrix covering pure
  Boolean/Unit functions, effect U64/Boolean/Unit/Never channels and scoped
  logging: all three matched character-for-character.
- Foldkit's separate emitter (`foldkit.ts` `emitQuery`/`literalRust` and the
  CLI arms) now builds through `Rs` too. Its `foldkitRuntime`/`foldkitMain`
  shells remain a static audited template, which is exactly the documented role
  of the `verbatim*` boundary. Foldkit output is unmapped (no authored ranges).
  Generated `src/main.rs` is byte-identical and `src/lib.rs` is identical apart
  from one deliberate normalization: the old template emitted a blank line when
  a statement list was empty (`lines.join("\n")` on `[]`, or an empty
  `if selected.len() > 1` block). Those artifacts are gone; the remaining lines
  match one-for-one. Foldkit three-interpreter conformance (evaluate, upstream
  Drizzle/SQLite, fresh debug/release native) passes unchanged.
- Re-ran `scripts/measure-source-metadata.mjs` (5 samples × 4 profiles, 128
  functions × 16 operations) after the fragment refactor: `generatedSourcesIdentical`
  is true, every profile emits 115,086 generated bytes with the same SHA-256,
  and None still records zero auxiliary JSON against 2.4–2.5 MB for Full.
  Retained program+artifact medians remain roughly 6.2–6.6 MB (Full) versus
  1.06–1.19 MB (None), matching the [metadata-cost](../metadata-cost.md)
  baseline; the composable fragments did not regress compiler retention.

## Alternatives

- Full Rust AST with pretty-printing: rejected, oversized for the profile and
  risks reformatting bytes (source-map ranges pin exact bytes).
- Arbitrary `use` and macro-definition strings: rejected as the default API;
  they bypass identifier/tree-role construction. Keep explicitly named
  verbatim hatches for audited static content.
- rustfmt post-pass: rejected by the design doc (no verified mapping stage).
- Migrating `foldkit-runtime.ts`/`foldkit.ts` now: deferred; separate emitter,
  separate conformance, separate commit.

## Acceptance

- Byte-identical `src/lib.rs`/`src/main.rs` across the suite: existing
  `source.test.ts` exact-range assertions and determinism tests pass
  unmodified, plus native debug/release conformance.
- Builder unit tests assert exact text (including braces/escapes), refusals
  (bad idents, out-of-range u64, keyword handling, role misuse via types.ts),
  and `formatString` doubling.
- `rust-emission-modules.rs` is accepted by local `rustc 1.90.0` in edition
  2021 with `--deny=warnings`, exercising nested/re-exported imports, inline
  modules, `macro_rules!`, repetition and exported macros.
- Scoped `vp check`, strict `tsc`, full `vp test`, workspace build, probe;
  record, self-review, commit, push. Root formatting also reports the four
  preserved untracked Effect reference docs; do not auto-format those here.
