# Native Foldkit SSR (milestone 8A)

Status: **design proposed (2026-10-03)**, not implemented. This is [milestone 8](../implementation-milestones.md#26-milestone-8--native-foldkit-ssr), part 8A: native SSR authored by hand in R, agreeing with upstream `renderToString` and hydrating with the stock client. 8B, the mechanical transformation of upstream source, follows later. Prior context:

- [Foldkit SSR](../foldkit-ssr.md): the server-reachable graph, the view profile, and the hydration rule.
- [The SSR inventory](foldkit-ssr-inventory.md): an owned-string profile and escaping as the first workloads.
- [LIVE-010](remote-live.md#live-010-design-2026-10-03): ported runtimes registered with upstream pins.

Sources, read 2026-10-03 from installed **foldkit 0.165.0** (`node_modules/foldkit/dist`):

- `experimental/server/{server,serialize,template,host,fetch,entry}.js`;
- `hydrationMarker.js`, `hydrationMarkers.js`, `buildToken.js`, `domReflection.js`, `hydrate.js`;
- `html/index.{js,d.ts}`, `runtime/hydrationHandoff.js`.

Line references are to those files.

## What upstream does

**`renderToString`** returns `Effect<RenderedApplication, RenderError>` and has four overloads: plain, Flags, routing, and routing with Flags. The options are `runtimeId` (default `'app'`), `isHydratable` (default `true`) and `buildId` (explicit, or the one the Vite plugin injects).

- **Errors, in check order** (`server.js:836-913`):
  - `InvalidRuntimeId` for an empty id;
  - `MissingBuildId` for a hydratable render without a build id;
  - `InvalidUrl`, for routing only;
  - `FlagsEncodeError`, for hydratable renders with Flags;
  - `InvalidHydrationRoot` when the body is null, text or a comment;
  - `SerializationError`, which wraps every serializer and post-check throw.
- **Flags.** Only hydratable renders with Flags do this: `Schema.toCodecJson(Flags)` encodes, then `JSON.stringify`, then a re-parse and decode. `init` receives the round-tripped value, so `-0` becomes `0` exactly as the client sees it.
- **init's commands are dropped.** Only `init(...).model` is used.
- **view** runs with the client's own `h` builder and a no-op dispatch. Event handlers and hooks end up in `data.on`/`data.hook`, which the serializer ignores.
- **`RenderedApplication`** is `{ html, title, lang?, dir?, canonical?, ogUrl? }`, where `ogUrl` defaults to `canonical`, and `html` is `rootHtml + flagsScript`.
- **Flags payload:** `<script type="application/json" data-foldkit-flags="${escapeAttributeValue(runtimeId)}">${json.replace(/</g, "\\u003c")}</script>`.

**Hydration markers.** The root element gains `data-foldkit-app="${runtimeId}"` and `data-foldkit-build="${buildId}"` after its own attributes. Keyed or identity-bearing elements gain `data-foldkit-key` or `data-foldkit-identity`, but only in hydratable output.

- **Fingerprint.** FNV-1a over **UTF-16 code units** in two 32-bit lanes (offsets 2166136261 and 1099511628, prime 16777619, `Math.imul`). The low byte is fed first in one lane and the high byte first in the other, and the result is two zero-padded hex words.
- **Hashed input.** It covers a type-tagged key: `s:${key}`, or `n:${JS number text}` (`hydrationMarkers.js`).

**The client** (`hydrate.js`, `runtime/hydrationHandoff.js`):

1. `Runtime.hydrate` finds the stamped root and checks the build id ("build skew" stops startup).
2. It decodes the Flags script instead of running the client's Flags effect, and re-runs `init` and `view`.
3. It walks the first render's vnode tree against the server DOM. Matching nodes are adopted. A disagreeing subtree is cleared and rebuilt, and keyed elements are checked by marker.

Hydration is therefore tolerant. **Byte equality with upstream is the right acceptance**, because it guarantees every node is adopted and none is rebuilt.

**Serializer** (`serialize.js`). It walks a snabbdom-style VNode iteratively, with a depth limit of 1000.

- **Validation.** Tag names must match `^[A-Za-z][A-Za-z0-9._-]*$` (HTML tags are lowercased) and attribute names `^[A-Za-z_:][A-Za-z0-9_.:-]*$`.
- **Attribute order.** Attributes go into an insertion-ordered map built from, in order: `attrs` (de-duplicated, `class`/`style` appended), the `class` object, `dataset`, reflecting `props` (per-element tables in `domReflection.js`), `style` (validated against a CSS property list), the controlled-`<select>` fix-up, the root markers, then the key/identity markers. Every attribute is written as ` name="value"`; there are no bare boolean attributes.
- **Escaping.**
  - `escapeText`: `&`, `<`, `>` and CR (`&#13;`).
  - `escapeAttributeValue`: `&`, `"`, `<` and CR. `>` is **not** escaped in attributes.
  - Both refuse NUL and lone surrogates (`assertRepresentable`).
- **Element kinds.**
  - Void elements: there are 14, written without a close tag or slash.
  - Raw-text elements: script, style and five others, with their own refusals.
  - RCDATA elements: textarea and title.
  - Special cases: `textarea`/`output` value text, and the `pre`/`listing`/`textarea` leading-newline rule.
  - Comments.
  - Trusted `InnerHTML`.
- **parse5 post-checks.** Around 550 lines of `server.js`, running in both scripting modes: no declarative shadow root, no live `<base>`, no document-structure escape, a single stamped root that closes cleanly, and reserved marker names never authored. They accept or reject but never change bytes.

**Page serving.**

- `injectIntoTemplate` splices `rendered.html`, the title, lang/dir, canonical and og:url into an HTML template, using parse5 source offsets with extensive structural checks.
- `handleRequest`:
  - answers CONNECT/TRACE/TRACK with 405;
  - answers asset-looking paths with a 404, plus `Vary: Sec-Fetch-Dest` when classified by `Sec-Fetch-Dest`;
  - negotiates `Accept` for pages (404 when HTML is not acceptable, `Vary: Accept, Sec-Fetch-Dest`);
  - serves HEAD without a body;
  - sends `content-type: text/html; charset=utf-8`.

**Nondeterminism.** None: no time, randomness or ids. The only process-global state is the synchronous runtime frame stack.

## Options

| Option                                                                                                                                                                                               | Assessment                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: R view builders mirroring Foldkit's `h`; the reference builds real Foldkit VNodes, so the same R view serves the browser and the oracle; natively a ported serializer subset writes HTML directly | One definition for client, oracle and server, so hydration agreement is by construction. Upstream `renderToString` is the differential oracle. Fits LIVE-014: R authors the view, a pinned port serializes it |
| B: a native-only HTML IR with its own view functions; the client keeps an ordinary TS view                                                                                                           | Two views must agree by hand. Hydration mismatches are silent, because rebuilt subtrees are not errors                                                                                                        |
| C: embed a JS engine for `view`                                                                                                                                                                      | Contradicts "fully native" for 8A                                                                                                                                                                             |
| D: port the whole serializer and the parse5 checks                                                                                                                                                   | The parse5 checks would need html5ever with source locations, which is weak in Rust. They change no bytes, and a bounded profile can rule out their inputs at compile time                                    |

## Proposed decisions

- **SSR-001: R view authoring mirrors Foldkit's builder (option A).**
  - `R.Html` offers element builders over static tag names, attribute constructors named as Foldkit's (`Class`, `Id`, `Href`, `Value`, `Checked`, `Key`, `OnClick`, …), text from `Expr<string>`, children from `R.Array.map`, and branches through `R.Match`. A view is an R function `(model) => Document`.
  - **Reference.** It builds a real Foldkit `view(model, h)` that calls upstream's `h` with evaluated values, so the browser app uses it directly and upstream `renderToString` is the oracle.
  - **Event attributes** carry Message values: R-constructed tagged data, witnessed by the app's `Message` schema. Native rendering drops them, as upstream's serializer does.
- **SSR-002: a bounded 8A profile.**
  - **Admitted:** HTML-namespace elements with static tags; void elements; text; attributes with direct HTML reflection (`Class`, `Id`, `Href`, `Title`, `Lang`, `Dir`, `Type`, `Name`, `Placeholder`, `For`, `Value` on input, `Checked`, `Disabled`, `data-*`); `Key` (with markers); and event attributes (dropped).
  - **Refused while compiling** (each a [native divergence](../native-divergences.md) refusal line): raw-text and RCDATA elements other than title; `InnerHTML`; `style`; `select`/`option` controlled state; `textarea`/`pre`/`listing`; SVG/MathML; custom elements; comments; `Identity`; and authoring a reserved marker attribute or an `html`/`head`/`body`/`base`/`template` element.
  - Every refused construct is one whose upstream handling either needs parse5 or changes bytes in ways the profile does not need yet.
- **SSR-003: a ported serializer subset as a semantic runtime.**
  - `foldkit/ssr-serialize@1` is pinned to foldkit 0.165.0 (LIVE-010). It covers `escapeText`, `escapeAttributeValue`, NUL refusal (Rust strings cannot hold lone surrogates), the attribute ordering for admitted sources (the `class` append, boolean `""`), the void-element set and the fingerprint over `encode_utf16`.
  - Lowering writes straight into one `String`, static fragments folded, with no VNode tree.
  - A NUL in rendered text fails the render with `SerializationError`, as upstream does.
- **SSR-004: init and Flags in R.**
  - `init` is an R function `(flags) => Model`; commands are not representable, and upstream drops them anyway.
  - Flags come from a request-to-Flags R function. That function is reffect's own entry point; upstream takes Flags as a render option.
  - The Flags payload JSON uses the generated JSON encoders (RM-006), with `<` turned into `\u003c`.
  - `init` receives the decoded round trip of the encoded Flags, as upstream does. For the admitted witnesses the round trip is the identity, except for `-0` and non-finite numbers, which the JSON codec already normalizes.
- **SSR-005: no ported parse5 checks.** The 8A profile cannot produce a declarative shadow root, a `<base>`, a document-structure escape or authored markers, so the checks hold by construction. This is recorded as refusal-by-profile, not as an unchecked render.
- **SSR-006: build and runtime ids are compile options.** A build id is required for hydratable output (`MissingBuildId` becomes a compile error). `runtimeId` defaults to `'app'` and is validated as non-empty.
- **SSR-007: page serving comes after rendering.**
  - First milestone step: produce `RenderedApplication` natively and compare it with upstream.
  - Next: a fixed-template splice. The template is split once at build time, using upstream `injectIntoTemplate` on sentinel values to locate the splice points, so no HTML parser runs at request time. Native `GET`/`HEAD` page routes are served beside `/rpc`, implementing `handleRequest`'s method, asset and `Accept` rules.
  - Routing (`InvalidUrl`, the routing overloads) comes after both.
- **SSR-008: numbers in text need JS formatting.** `R.Number` needs a `toString` matching `Number#toString` (`ryu-js` natively, as NUM-004) before views can render numbers. Until then the profile admits text from strings only.

## Order of work and acceptance

1. **Escaping and markers.**
   - Port `escapeText`, `escapeAttributeValue` and the fingerprint.
   - Run a differential corpus against the pinned upstream functions: ASCII, astral, combining, CR, NUL refusal, numeric and string keys.
     **Delivered 2026-10-03.**
   - [ssr-serialize.ts](../../packages/reffect/src/ssr-serialize.ts) ports `escapeText`, `escapeAttributeValue` (with upstream's NUL message) and the fingerprint. It is registered as `foldkit/ssr-serialize@1` with the pin foldkit 0.165.0.
   - [ssr-serialize.test.ts](../../packages/reffect/tests/ssr-serialize.test.ts) compares a Rust harness with `renderToString`, rendering each value as a span's text, `title` and key. The corpus covers all escapes, CR, astral and combining text, a long value and NUL refusal.
   - Injecting `>` escaping into attributes makes the test fail.
   - Number keys wait for SSR-008.
2. **`R.Html` and the reference view.**
   - Add element and attribute builders and `R.Html.document`.
   - The reference produces a Foldkit `view`, whose `renderToString` output is the oracle.
3. **Native rendering.**
   - Lower R views to a Rust writer with folded static fragments.
   - A corpus of views and models must produce byte-equal `RenderedApplication` values, natively and through upstream `renderToString`, hydratable and static, with and without Flags and keys.
   - Refusals are tested.
4. **Hydration with the stock client.**
   - A browser (or a DOM library) loads native HTML, and the stock `Runtime.hydrate`, using the same R view through the reference, adopts it.
   - Evidence that no subtree was rebuilt: element identity preserved across hydrate.
   - **Open decision:** add `happy-dom` (or jsdom) as a dev dependency for a headless test, or keep this check as a recorded browser run.
5. **Page serving.** The template splice and `handleRequest` rules, as a native route beside `/rpc`.
6. **Example.** `examples/todo-remote` renders its first screen natively. This also needs Remote data in SSR, which is milestone 9 (`Data.satisfy`). Until then the example's SSR shows the initial Model only.

## Open questions

- **Builder shape.** Should `R.Html` be data-first (`R.Html.div([attrs], [children])`, as Foldkit's `h.div`) or curried? It should mirror `h` exactly.
- **Typing event Messages.** Message unions use `defineMessageUnion`; the R witness for an app's Message schema needs checking against the current `TaggedUnion` support.
- **The headless hydration dependency** (step 4).
- **Whether `Key` values of number type** should be admitted before SSR-008 delivers JS number text. The `n:` fingerprint input uses that text.
