# Foldkit SSR portability inventory

Exploratory measurement for [NS-1](north-star-review.md#adopted), produced 2026-10-02 by [the inventory script](../../packages/reffect/scripts/foldkit-ssr-inventory.ts) over `foldkit/foldkit@0b2a4fd04171afa8c8911d22aa9bec2f22faae52`. Raw counts are in [foldkit-ssr-inventory.json](foldkit-ssr-inventory.json). Rerun with:

```sh
vp exec node --experimental-transform-types packages/reffect/scripts/foldkit-ssr-inventory.ts
```

The script fetches the pinned commit into the gitignored `.cache/upstream/foldkit`, follows runtime imports (type-only imports skipped) from `packages/foldkit/src/experimental/server/index.ts`, and walks the ESTree from Vite's `vite/rolldown/parseAst`. No dependency was added.

## Limits of the measurement

- **Syntax only.** No type information: `.get()`/`.push()` counts include Maps, arrays and other receivers alike.
- **Module-level reachability over-approximates.** The entry imports Foldkit's HTML and VNode modules, which in turn reach client code (`mount`, snabbdom event listeners, `Stream`/`Fiber`/`Queue` usage). A function-level server graph would be smaller; the numbers below are an upper bound.
- **Spelling is not semantics.** `spelledInR` only records that `R` has a member with the same name.

## Results

43 files, 16,186 lines (including comments). External packages: `effect` and `parse5`.

| Area              | Measured occurrences                                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effect            | 73 distinct members; 6 spelled in `R` (`Effect.fail/succeed/void/andThen/mapError`, `Context.empty`). Most used: `Option.isSome` 14, `Schema.String` 12, `Effect.fail` 7, `Data.TaggedError` 6, `Predicate.isString` 5 |
| Control flow      | 1,184 closures, 698 `if`, 105 ternaries, 76 `for-of`, 34 `for`, 9 `for-in`, 8 `while`, 97 `throw`, 17 `try`, 12 `yield*`                                                                                               |
| Data and mutation | 573 object literals, 183 array literals, 343 destructurings, 43 spreads, 127 optional chains, 51 `??`, 144 reassignments, 77 property mutations, 46 `++`/`--`                                                          |
| Globals           | 99 `new Error`, 96 `new Set`, 15 `new Map`, 32 regex literals, 30 `Object.keys`, 30 `Reflect.get/set`, 15 `JSON.stringify`, 5 `new URL`                                                                                |
| Methods           | `.push` 69, `.toLowerCase` 50, `.get`/`.has`/`.set` 48/47/45, `.slice` 21, `.startsWith` 17, `.test` 16, `.replace` 15                                                                                                 |

## Interpretation

- The north star is right that Effect is not the hard part: Effect members are a small fraction, and many (`Option`, `Predicate`, `Array`, `String`) are pure data helpers.
- It understates the ordinary TypeScript. Translating the unmodified tree means a codemod that turns roughly 700 branches, over 1,000 closures, local mutation, Sets/Maps, regular expressions and thrown errors into explicit IR. That is close to compiling general TypeScript. "Unmodified upstream through a codemod" is therefore a long-horizon acceptance test, not a near-term milestone (Q-1).
- Strings dominate the data: case conversion, slicing, prefix tests, regex replacement and escaping. Owned strings with explicit Unicode/UTF-16 semantics are the first representation gate for SSR, and Remote needs them too.
- Foldkit already refuses NUL and lone surrogates before escaping (`assertRepresentable` in `serialize.ts`). That matches Rust's UTF-8 `String`, so `escapeText`/`escapeAttributeValue` make a strong first string workload: total, small, and the upstream function is a direct differential oracle.

## Recommended next workload

Admit a bounded owned-string profile driven by `escapeText` and `escapeAttributeValue`. It needs a string witness and literals; the JSON wire codec; length and code-unit semantics stated explicitly; a refusal path for NUL and lone surrogates; and replacement over a fixed character set. Compare with the pinned upstream functions on a generated corpus that covers ASCII, astral characters, combining marks, CR, and the refused inputs.
