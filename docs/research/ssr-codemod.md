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

### Step 1d progress

- **1d-i (2026-10-05):**
  - `R.Number.parse` (Effect `Number.parse`, read as an Option) and `R.Number.isSafeInteger`.
  - Natively they are the std-only `js_std` runtime module, reached through a generic `Std` lowering that borrows String arguments. It holds a port of ECMAScript `StringToNumber`, with exact round-to-even radix literals.
  - Evidence: `tests/js-std.test.ts` passes 2/2. Native and reference agree on 60 strings (white space sets, `Infinity`/`NaN` spellings including Rust-only ones, signs, dots, exponents, radix prefixes, ties at 2^53, overflow, separators, non-ASCII digits). A runtime test pins `-0` and the ties.
- **1d-ii (2026-10-05):**
  - `R.Cookies.parseHeader` (Effect `Cookies.parseHeader`, reference Effect's own) is ported in `js_std` over UTF-16 code units as JS indexes them, with `decodeURIComponent` as percent-decoding plus UTF-8 validation, and the Record in JS own-property order.
  - Evidence: `tests/js-std.test.ts` passes 3/3. A NativeRpc server answers 29 headers byte-equal to the official server, key order included. The headers cover duplicates, Unicode trimming, quotes, missing `=`, every `%` failure (bad hex, truncated, overlong, surrogate, past U+10FFFF), `__proto__`, integer keys and non-ASCII.
  - One divergence, a lone surrogate from a malformed quoted value, is recorded (COOKIE-SURROGATE).
- **1d-iii (2026-10-05):**
  - `R.DateTime.Utc` (natively epoch milliseconds as `f64`), `R.DateTime.make` (Effect `DateTime.make`, so JS `TimeClip` as an Option), `formatIso` (`toISOString`, with six-digit signed years outside 0–9999) and `toEpochMillis`.
  - Evidence: `tests/js-std.test.ts` passes 3/3. Native agrees with Effect on 20 instants: ±0, fractions, ±8.64e15 and past them, NaN, Infinity, the year 9999/10000 and 0/−1 boundaries, a leap day.
- **1d-iv (2026-10-05):**
  - A page request may read `cookie` (the request's `Cookie` text as latin1, repeated headers joined with `"; "`, every session-cookie pair removed) and `now` (an `R.DateTime.Utc` from one clock reading, which the page's Remote data step shares). A page reading `cookie` answers `Vary: Cookie`.
  - `R.Record.get` (Effect `Record.get`, as an Option) is a `Get` record query.
  - The positional page is now `(url, cookie, now, [remote, [views]])`.
  - Evidence: `tests/page-request.test.ts` passes 1/1. A page reading the count cookie exactly as the pinned `cookie.ts` does (`parseHeader` → `Record.get` → `Number.parse` → `isSafeInteger` → 0), plus its instant as ISO, answers byte-equal to upstream `handleRequest` on ten cookie headers, latin1 included. The runtime test `a_page_never_reads_the_session_cookie` passes. Every page suite passes, as does `todo-fullstack` 2/2.
- **1e (2026-10-05):**
  - A page may answer `R.Html.Entry`, upstream's server entry: `R.Html.rendered(page, { status?, headers? })` or `R.Html.responded({ status, headers?, body? })`, with headers as `HeadersInit` pairs and a `NullOr` body.
  - A page request may read `method`, normalized as Fetch normalizes it.
  - The host follows `toResponse` and `handleRequest`:
    - `Headers` semantics (lowercased names, trimmed values, repeated names combined);
    - the `Response` status checks (200–599, no body on 204/205/304), or 500 with `entry-failure`;
    - a default HTML content type;
    - HEAD without a body;
    - the negotiated fields merged into the authored `Vary`.
  - On a data page the host's `private, no-store` still wins.
  - Evidence: `tests/page-request.test.ts` passes 1/1. A page shaped as the pinned `renderPage` (an `OPTIONS` preflight answering 204 with `allow`, otherwise `Rendered` with the example's three headers) equals upstream `handleRequest` in status, body and headers on ten cookies, `OPTIONS` and `HEAD`. All page suites and `todo-fullstack` pass.
- **Step 1 is complete:** every surface the pinned example reaches has an R form, differential against upstream. Next is step 2, the translator.

## Step 2 design: the translator (2026-10-05)

**Facts** (typescript 7.0.2, probed 2026-10-05 on the vendored fixture):

- **Opening.** `new API({ cwd })` from `typescript/unstable/sync` spawns the bundled `tsgo`. `updateSnapshot({ openProjects: [tsconfig] })` gives a `Project` with `program` and `checker`.
- **The AST.** `program.getSourceFile(path)` returns it with `getText()`, using `SyntaxKind` from `typescript/unstable/ast`.
- **Types.** `checker.getTypeAtLocation`, `getSymbolAtLocation` and `typeToString` answer them. `Model` reads as `Struct<{ readonly count: Number; … }>`.

**Decisions.**

- **Output is R builder source.** The translator writes a TypeScript module of `R` builders, so the transformation's result can be reviewed, committed and diffed for stability. The module is compiled like a hand-written 8A page. It imports the upstream `Message` union, since events construct the browser's own Messages.
- **The frontend is one adapter module.** It is the only code touching `typescript/unstable/*`; the translator works on its plain view of declarations, expressions and types, so an API change is absorbed there.
- **The graph is server-reachable only.**
  - It starts from `entry.server.ts` `renderPage` and reaches `Flags`, `init`, `view`, `cookie.ts` and the `@foldkit/ui` `Button`.
  - `update`, `Command`s and browser-only code are not translated, and stay as they are for the stock client.
- **Build-time evaluation.**
  - Values known while translating are evaluated rather than translated: string and number constants, `Button.view`'s defaulted config (`isDisabled = false`), conditional arrays over them, spreads of known arrays, `toView` callbacks and helper functions like `parseEquivalenceView`. This is "ordinary build-time TypeScript remains unrestricted".
  - Only values depending on the request or Model become R expressions.
- **Mapping:**

  | Source                                                                        | R                                                |
  | ----------------------------------------------------------------------------- | ------------------------------------------------ |
  | `Schema.Struct`/`Literals`/`Number`/`String`                                  | witnesses                                        |
  | `h.<element>`/`h.<Attribute>`                                                 | `R.Html`                                         |
  | template literals and `+`                                                     | `R.String.concat`                                |
  | `number.toString()`                                                           | `R.String.fromNumber`                            |
  | `request.method === 'OPTIONS'`                                                | `R.Match.bool` on the request's `method`         |
  | `request.headers.get('cookie') ?? ''`                                         | the request's `cookie`                           |
  | `new Date().toISOString()`                                                    | `R.DateTime.formatIso(now)`                      |
  | `Server.renderToString({ Flags, init, view }, { flags })`                     | `R.Html.renderToString` with the Flags           |
  | `Server.Rendered(app, { headers })` and `Server.Responded(new Response(...))` | `R.Html.rendered`/`responded`                    |
  | `cookie.ts`'s pipe                                                            | `R.Cookies`/`R.Record.get`/`R.Option`/`R.Number` |

- **Refusals.** Anything else is a structured diagnostic naming the node, its file and position, and why it is outside the profile. The translator never guesses.
- **Configuration the source cannot state.** The `buildId` the Vite plugin injects, the page `template`, and the origin come from the translation's options, as the 8A host takes them.

**Acceptance (step 3):**

- Translating the fixture twice gives identical output.
- The output type-checks with no casts.
- Served natively, it answers byte-equal to upstream `handleRequest` with the pinned `renderPage`, for the same requests (cookie and clock pinned).
- The stock client built from the pinned `entry.ts` hydrates it.
- A construct outside the profile, in a mutated copy of the source, is refused with its location.

### Step 2 progress

- **2a (2026-10-05):** the translator (`src/ssr-translate.ts`) over the TypeScript 7 frontend adapter (`src/ts-frontend.ts`). It translates the vendored source into `examples/ssr-8b/page.ts`:
  - the `Model` and `Flags` witnesses, the `Message` union, and the `init` and `view` callbacks;
  - `@foldkit/ui` `Button` and `parseEquivalenceView`, evaluated while translating;
  - the cookie pipe, the clock and the preflight, as the page's `R.Html.Entry`.
- `HOST_METHOD_ANSWERS.allow` is read from the package at translation.
- `Literals.text` widens the interpolated `renderedOn`.
- Evidence: `tests/ssr-translate.test.ts` passes 2/2. Two translations are identical and equal the committed, formatted module, which needs no casts and type-checks under `vp check`. A copy with `model.count.toFixed(2)` is refused at `src/main.ts:103`.
- **Next: step 3**, the generated page served natively against the pinned `renderPage` run through Vite with the plugin's build id, then hydration.

## Step 3: acceptance (2026-10-05)

- **Answers.** `tests/ssr-8b.test.ts` passes 1/1. The generated `page`, served by a NativeRpc host, answers each request as the pinned `entry.server.ts` `renderPage` does, compared in status, body and headers.
  - The reference is the unmodified entry loaded with Vite `ssrLoadModule` (`tests/fixtures/upstream-ssr-vite.ts`). It maps `@foldkit/ui` to the vendored source and compiles the build id into Foldkit as `@foldkit/vite-plugin` does. The fake clock is set to the instant the native page reports.
  - Requests: eight cookie headers (plain, invalid, encoded, quoted, unsafe, duplicated, latin1, exponent), `OPTIONS` (204 with `allow`) and `HEAD`.
  - The bodies carry the stamped build, the cookie's count, the parse-equivalence block and the Flags handoff.
- **Hydration.** `tests/ssr-8b-hydrate.test.ts` passes 1/1. In happy-dom, the pinned, unmodified client `entry.ts` (vendored, hash recorded) hydrates the native page:
  - the server's root and `#count` nodes survive adoption;
  - a click on the server-rendered `+` reaches the pinned `update`, and the same node shows the incremented count.
- **Stability and refusal.** As step 2: the translation is identical twice, matches the committed module and needs no casts; a mutated construct is refused with its location.

**Milestone 8B is delivered for the pinned example.** Still open:

- `InnerHTML` with markup (it needs an HTML parser to check parse equivalence natively);
- non-literal `Tabindex`;
- widening the translator beyond what the pinned source reaches, workload by workload.
