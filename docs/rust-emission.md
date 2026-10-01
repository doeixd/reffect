# Typed, composable Rust emission

[Research](research/metadata-and-editor-tooling.md) · [Compiler design](compiler-design-revision.md) · [Source ranges](source-maps.md#emission-and-artifact-layout)

Grow small typed Rust emission helpers as supported lowering needs them. They are build-time TypeScript tools; they do not wrap native values or add runtime dependencies. Preserve verified semantic/Rust IR as the authority and route all final fragments through one UTF-8-counting source writer. No general Rust syntax library or new helper API is introduced by this document.

**Implementation update:** The internal [`Rs` source-builder](research/rust-emit.md) now includes typed paths/visibility, nested imports/re-exports, inline and external modules, module-file assembly, and declarative macro token trees. It remains a deliberately partial syntax builder: rustc checks macro follow sets, name resolution, expansion/hygiene, and generated Rust semantics.

## Current foundation

`lower.ts` already produces tagged `RustExpr`/blocks/helpers/functions and dispatches exhaustively over them. `SourceWriter` composes writes and scoped mappings, recording final byte ranges while leaving gaps unmapped. Some methods/signatures/CLI fragments still use local string templates. That is sufficient for the current small Boolean/u64 profile, but source writer strings alone cannot distinguish a type, expression, identifier or item.

Avoid accumulating whole-file templates or independent formatting/mapping passes as Unit, logging, runtime modules and richer representations are added. Extract the repeated constructs encountered in those slices into internal helpers rather than designing an exhaustive Rust AST upfront.

## Proposed helper boundaries

| Helper domain       | Responsibility                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Identifiers / paths | Compiler-controlled or validated names, namespaces/raw keyword handling, no interpolation of arbitrary user text as code                    |
| Target types        | Verified native representations, Unit/Never/Result/reference/generic forms; separate a Rust type from its semantic/wire type witness        |
| Literals            | Checked numeric suffix/range, bool, Rust-specific string/character escapes; JavaScript JSON quoting is not a universal Rust literal encoder |
| Expressions         | Calls/methods/unary/binary/match/blocks, explicit precedence/parenthesization and pure versus effectful evaluation order                    |
| Statements / blocks | Let/binding, result expression, control flow and lexical scope; prevent confusing an item or statement with an expression                   |
| Items               | Functions, attributes, structs/enums, static tables/modules/imports as required by verified lowering                                        |
| Origin scopes       | Definition/use/related provenance and intentional generated gaps, written around a composable fragment rather than guessed from final text  |

Use immutable tagged structures or opaque factories that constrain the syntactic role. A helper can render directly through a writer callback instead of materializing and joining many intermediate strings. For existing expressions, extend the current IR/renderer rather than introduce a parallel Expr hierarchy. Typed IDs for helper/site references prevent name/identity mixups. Accept known target type objects from verified representations, not arbitrary code strings advertised as safe types.

Type parameters may preserve a target expression/result relationship where it is meaningful; they do not prove Rust borrow rules, lifetimes, trait coherence or foreign ABI layout. Compiler lowering/ownership checks and rustc remain necessary. Keep capability/representation selection in planning; an emitter must not choose a different operation just because it is easier to print.

Allow a narrowly named internal raw fragment only for audited static scaffolding when a typed node would add no value. Raw output is unmapped by default; it cannot be the escape hatch for unsupported user operations or unvalidated identifiers/literals. Maintain deterministic whitespace and final UTF-8 bytes. No post-emission rustfmt without a verified mapping stage.

## First extractions and acceptance

During the upcoming Unit/frame/logging slice, extract result/type/signature, literal, call and static-site-table helpers only where those constructs repeat. Keep APIs internal until real callers establish an ergonomic public extension contract. Preserve one canonical renderer and origin writer; source fragments must remain composable without carrying source text/maps on every fragment or runtime scalar.

Verify generated modules with fresh rustc debug/release builds and reference/native conformance. Test precedence/evaluation order, malformed identifier/literal refusal and exact nested definition/use byte ranges when these helpers are introduced. Type-level tests should reject crossing syntactic roles without ceremony for normal compiler callers. Compare unchanged code generation when refactoring, especially shared helpers and native stdout; snapshot text alone is insufficient evidence of semantics. Avoid both unstructured string sprawl and a second Rust compiler inside TypeScript.
