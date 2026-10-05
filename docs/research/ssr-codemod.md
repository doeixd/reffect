# Milestone 8B: the upstream SSR source to R builders

Status: **research (2026-10-05)**, not implemented. 8B mechanically transforms the pinned, unmodified upstream Foldkit SSR source into R builders that meet the hand-authored 8A acceptance: native HTML byte-equal to upstream `renderToString`, hydrated by the stock client ([milestones §26](../implementation-milestones.md#26-milestone-8--native-foldkit-ssr), [migration delivery](../migration-tooling.md#delivery-and-acceptance)). It is not syntax widening (milestone 15). The R language design asks the frontend to analyse source rather than grow R ([RT-D12](../r-language.md)).

## The pinned source

- **Example.** `foldkit/foldkit` `examples/ssr` at tag `foldkit@0.165.0` (commit `0b2a4fd04171afa8c8911d22aa9bec2f22faae52`). This is the foldkit version installed here, and its `package.json` pins effect 4.0.0.
- **Server-reachable files** (checked 2026-10-05):
  - `src/main.ts`: `Model`, `Flags`, `init` and `view`. The `update` and `PersistCount` command are browser-only and stay out of the native graph.
  - `src/entry.server.ts`: `renderPage(request)` answers `OPTIONS` with a 204 `allow` response. Otherwise it runs `Server.renderToString({ Flags, init, view }, { flags })` with headers `cache-control: private, no-store`, `vary: cookie`, `x-content-type-options: nosniff`.
  - `src/cookie.ts`: `readCountCookie` (`Cookies.parseHeader` → `Record.get` → `Number.parse` → `Option.filter(Number.isSafeInteger)` → 0).
- **A pinned dependency.** The view calls `@foldkit/ui` `Button.view` (`packages/ui/src/button/index.ts` at the same tag). It uses default parameters, conditional attribute arrays and spreads, and a `toView` callback.

## What the source uses that R lacks

| Area                   | Source                                                                                                                       | R today                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Elements               | `select`, `option`, `pre`, `textarea` (the example's parse-equivalence block)                                                | missing from the 8A element set                                                   |
| Attributes             | `Value` on `select`/`textarea`, `Selected`, `InnerHTML`; Button's `Type`, `Tabindex`, `AriaDisabled`, `Autofocus`, `OnClick` | partial; `InnerHTML` (raw HTML) has serialization and safety semantics of its own |
| Values                 | `model.count.toString()`, template literals, `+` string concatenation                                                        | available (`NumberText`, `R.String.concat`)                                       |
| Component              | `Button.view`: defaults, conditional arrays, spreads, a callback                                                             | needs translation (or a registered R equivalent)                                  |
| Flags from the request | `Cookies.parseHeader`, `Number.parse`, `isSafeInteger`, `new Date().toISOString()`                                           | no cookie parsing, number parsing or ISO time formatting in R                     |
| Entry                  | `OPTIONS` preflight, response headers                                                                                        | the page host sets its own headers; no authored entry                             |

## The transform: platform question

- **Types are needed.** `.toString()` on a number, a template literal's parts, and which `h` builder an element belongs to are only clear with types. A syntax-only rewrite cannot choose the R operation.
- **Candidates** (npm, checked 2026-10-05):
  - [Codemod](https://github.com/codemod/codemod) `codemod` 1.18.3 (Apache-2.0): CLI and workflows over ast-grep (`@ast-grep/napi` 0.45.3, MIT) and the JSSG API. It is the project's preferred workflow candidate ([migration research](migration-tooling.md)), but it is syntactic.
  - `ts-morph` 28.0.0 (MIT): the TypeScript compiler API with types, bundling its own TypeScript rather than this workspace's.
  - `jscodeshift` 17.4.0 (MIT): syntactic.
- **The workspace compiler.** TypeScript is 7.0.2 (native). Its package exposes only `typescript/unstable/sync` and `typescript/unstable/async` APIs (no classic `createProgram` export), so a type-aware frontend on the workspace's own compiler would depend on an unstable API.

## Open decisions

1. **Frontend.** A type-aware translator (ts-morph, or the unstable TypeScript 7 API) that emits R builder source, with Codemod as an optional workflow wrapper. Or a Codemod/ast-grep rewrite with compiler checks afterwards.
2. **`@foldkit/ui`.** Translate the pinned `Button` source as well, or register a hand-written R equivalent for `Button.view`.
3. **`InnerHTML`.** Admit raw HTML in R views (its serializer and hydration rules), or refuse it and record the example's parse-equivalence block as unsupported.

## Decisions (user, 2026-10-05)

- **Frontend: the workspace's TypeScript 7 unstable API** (`typescript/unstable/sync`). The translator reads the same compiler the project builds with, and is pinned to `typescript` 7.0.2. Changes to that API are absorbed in one adapter module, so the rest of the translator stays independent of it.
- **`@foldkit/ui` is translated too.** The pinned `Button` source is part of the input, with nothing hand-written.
- **`InnerHTML` is supported**, along with `select`, `option`, `pre` and `textarea`, matching upstream serialization and hydration exactly, so the unmodified example translates whole.

## Order of work

1. **R surface gaps** the source needs, each differential against upstream: the elements and attributes above; `Cookies.parseHeader`; `Number.parse`; ISO time from `Clock`.
2. **The translator** for the server-reachable subset: Schema `Struct`/`Literals` to witnesses, `init` and `view` to `R.fn`, `h.*` to `R.Html`, template literals and conditionals to R expressions, helper functions and constants inlined or shared.
3. **Acceptance:**
   - The translated example served natively is byte-equal to upstream `handleRequest` with `renderPage` for the same request (cookie and clock pinned), and hydrates with the stock client.
   - Re-running the transform is stable, and unsupported constructs are refused with structured diagnostics.

## Progress

- **Step 1a (2026-10-05):**
  - `pre` and `textarea`, plus `Selected`, `Autofocus`, `AriaDisabled` and `Tabindex`, were probed against upstream for every admitted element.
  - `AriaDisabled` is a raw attribute (`"true"`/`"false"`). `Tabindex` is a literal integer in the browser's `long` range; upstream refuses others at render. `Autofocus` is global.
  - A `textarea`'s `Value` is its content. Upstream's leading-newline rule for `pre` and `textarea` is ported (`leadingTextOf`).
  - Refused while authoring, as upstream's builder refuses them: a `textarea` with both a `Value` and children, an element inside a `textarea`, and a non-integer `Tabindex`.
  - Evidence: `tests/html-native.test.ts` passes 2/2. Its corpus covers the new elements and attributes, and seven texts through the newline rules, including NUL. `tests/html.test.ts` passes 10/10 with the refusals.
- **Step 1b (2026-10-05):**
  - `select` and `option`, with a `select`'s controlled `Value`. The first option carrying it gets `selected=""`, every other option's `selected` is cleared, and an authored one keeps its position.
  - An option's value is its `Value`, or its ASCII-whitespace-collapsed text (serialize.js `optionValue`).
  - A single-line `select` with options and none matching fails with upstream's exact message, after its options' own failures.
  - The profile admits only `option` children in a `select`, and only text in an `option`.
  - Evidence: `tests/html-native.test.ts` passes 2/2 with a `Selects` view over seven values (a first duplicate, a match by text, no match, NUL, escapes), byte-equal to the official server. `tests/html.test.ts` passes 11/11 with the nesting refusals.
- **Step 1c (2026-10-05):**
  - `InnerHTML` is admitted as a literal without markup (no `<`). It owns its element's content: no children, and not on void elements, `textarea`, `option` or `select`, where upstream's builder refuses it or selection would read hidden values.
  - Upstream writes it verbatim, including CR and NUL. A `pre`'s raw content always gets the leading newline.
  - Fragments with markup would need an HTML parser to check that they parse the same in place (server.js), and stay refused.
  - Evidence: `tests/html-native.test.ts` passes 2/2 with a `Raw` view, including the example's `pre` (`InnerHTML('
leading')`), byte-equal to the official server. `tests/html.test.ts` passes 12/12 with the refusals.

## Step 1d design: Flags from the request (2026-10-05)

**What the entry computes.** `flagsForRequest(cookieHeader)`:

- `initialCount`: `readCountCookie`, which is `Cookies.parseHeader` → `Record.get("foldkit-ssr-count")` → `Option.flatMap(Number.parse)` → `Option.filter(globalThis.Number.isSafeInteger)` → `getOrElse(0)`;
- `renderedAt`: `new Date().toISOString()`;
- `renderedOn`: `"Server"`.

**Upstream semantics** (effect 4.0.0 source, checked 2026-10-05):

- **`Cookies.parseHeader`** (`effect/http/Cookies.ts`, from fastify-cookie):
  - It splits on `;` and skips a pair without `=` before its terminator.
  - Keys are `trim`med, and the first occurrence wins.
  - A value starting with `"` drops its first and last characters, then trims.
  - The value is `decodeURIComponent`d only when it holds a `%`, and kept as is when that throws.
  - Properties are assigned safely (`__proto__` is an ordinary key).
- **`Number.parse`:**
  - `"NaN"`, `"Infinity"` and `"-Infinity"` parse literally.
  - A string that `trim`s to empty is `None`.
  - Otherwise it is JS `Number(s)`, `None` when NaN. That covers Unicode white space trimming, `0x`/`0o`/`0b`, exponents, and leading `+`/`-` on decimals only.
- **`isSafeInteger`** is the JS global (Effect's `Number` module has none). **`toISOString`** is `DateTime.formatIso(DateTime.makeUnsafe(ms))` in Effect terms.

**Decisions.**

- **Operations**, each a total pure function, differential against the JS reference on a corpus:
  - `R.Cookies.parseHeader(header): Record<String, String>`;
  - `R.Number.parse(s): Option<Number>`;
  - `R.Number.isSafeInteger(n): Bool` (named for the JS global, recorded as such);
  - `R.DateTime.formatIso(R.DateTime.makeUnsafe(ms))`, mirroring Effect's names, over epoch milliseconds the request supplies.
- **Request inputs.** A page request may read:
  - `cookie`: the request's `Cookie` header, empty when absent. The reffect session cookie's pairs are removed first, so no view can write the HttpOnly token into HTML.
  - `now`: the epoch milliseconds the page reads its data at (already its Remote clock).

  A page reading `cookie` answers `Vary: Cookie`, as session pages already do.

- **Effects stay explicit.** The clock is the host's, given as data like the Remote `now`. The translator maps `new Date()` in the Flags function to it.

**Acceptance.**

- Each operation agrees with the JS reference natively, on corpora covering `%` decoding failures, quotes, duplicates, `__proto__`, every numeric literal form, Unicode white space, and safe-integer edges.
- A page's `cookie` never holds the session cookie.
