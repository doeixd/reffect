# Cookie sessions for authenticated pages (#4)

Research record, 2026-10-05. Status: **accepted 2026-10-05**: the three decisions below were taken as recommended.

## The gap

Pages authenticate from their own `Authorization` header (`page_principal` in `packages/reffect/src/rpc-auth-runtime.ts`). On a server with `auth`, a page request without a principal answers 401, which fails closed (`54dc329`). Browsers never send `Authorization` on a navigation, though, so every real page load of an authenticated app is a 401. `todo-remote` works only because it has no auth.

## Prior work

- **[RPC authentication](rpc-auth.md).** One checked bearer adapter (`NativeRpc.bearer`) per protected procedure. Credentials are a configured table of `token -> u64 principal`, loaded once from an environment variable, which the process then removes. They are compared in constant time over padded tokens (#20), and never logged or emitted into artifacts. It is explicitly a configured verifier: not JWT verification, session issuance, revocation or an identity provider.
- **[SSR data](ssr-data.md).** Page reads run under the page request's principal, through the same source authorization as RPC. Data pages are `Cache-Control: private, no-store` (#3).
- **[Live](remote-live.md).** A live subscription keeps the principal its request authenticated with. Per-principal subscription caps apply (#19).

## Upstream (checked 2026-10-05, effect 4.0.0)

- **Cookie key scheme.** `HttpApiSecurity.apiKey({ key, in: "cookie" })` is Effect's scheme for a credential carried in a named cookie (`effect/dist/http-api/HttpApiSecurity.d.ts`). The middleware decodes it with `Request.schemaCookies` (`HttpApiBuilder.js`).
- **Setting the cookie.** `HttpApiBuilder.securitySetCookie(security, value, options?)` sets it from a handler, defaulting to `Secure` and `HttpOnly`. Other attributes come from `options`.
- **No CSRF defence.** Effect has no CSRF facility (no match for `csrf` in `effect/dist`).
- **The browser RPC client.** Effect RPC's HTTP client (`RpcClient.layerProtocolHttp`) POSTs with the serialization's content type (`application/json` or ndjson). `FetchHttpClient` keeps fetch's default `credentials: "same-origin"`, so a same-origin `/rpc` call carries the site's cookies with no client change.
- **Foldkit.** Foldkit's `handleRequest` sets no cookies and has no auth. Authentication of a page is the host's concern.

## Primary guidance

- **OWASP CSRF Prevention Cheat Sheet** ([link](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), read 2026-10-05):
  - Fetch Metadata is a primary, low-cost defence: refuse `Sec-Fetch-Site: cross-site` on unsafe methods.
  - Origin verification is the required fallback for browsers without Fetch Metadata.
  - SameSite is defence in depth only. Lax does not protect state changes reachable by GET, nor against sibling subdomains, which are same-site.
  - Custom request headers or non-simple content types protect JSON APIs, because a cross-origin request cannot send them without a CORS preflight.
- **MDN `Set-Cookie`** ([link](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie), read 2026-10-05):
  - **`__Host-` prefix:** the cookie must have `Secure`, `Path=/` and no `Domain`, which pins it to the exact origin.
  - **`SameSite=Lax`:** the cookie is sent on same-site requests and on top-level cross-site navigations, but not on cross-site fetch or iframe requests.
  - **Omitted SameSite:** the browser defaults to Lax. Chrome's default also allows POST within two minutes of setting, so the attribute must be explicit.
  - **`HttpOnly`:** keeps the cookie from script.
  - **`Secure`:** HTTPS only, with localhost treated as secure by current browsers.

## Threats

1. **Forged or guessed cookie.** The same constant-time check as the bearer adapter, against the same credential table, answers 401.
2. **Cross-site request forgery against `/rpc` mutations.** Today the native server parses the body whatever its `Content-Type`. A cross-site `<form enctype="text/plain">` can therefore post a JSON-shaped body, and SameSite=Lax would be the only barrier.
3. **Sibling-subdomain requests.** These are same-site, so SameSite=Lax sends the cookie. Only origin checks distinguish them.
4. **Token exposure to script.** An `HttpOnly` cookie keeps the credential out of the hydrated app. The browser RPC client still authenticates, through the same-origin cookie.
5. **Cached authenticated pages.** Already `private, no-store` (#3). Responses that vary by the cookie must stay so.
6. **Login CSRF and fixation.** These matter only if the server issues sessions. With option A below, the cookie carries a pre-configured credential, so there is nothing to fix ahead of time.

## Options

- **A. The configured credential in a cookie.**
  - **How:** mirror `HttpApiSecurity.apiKey({ key, in: "cookie" })`. A page or RPC request without `Authorization` may present the same configured token in a `__Host-` cookie, checked by the same constant-time verifier. A small native endpoint exchanges a valid bearer token for the cookie (`POST` with `Authorization`, answering `Set-Cookie`), as `securitySetCookie` does from a handler.
  - **Pros:** no server state, no keys, and the same assurance as today's bearer profile.
  - **Cons:** a cookie is as long-lived as its token, and revocation means rotating the configuration.
- **B. Server-issued sessions.**
  - **How:** random session IDs in a store (memory or SQL), with expiry, rotation on login and logout.
  - **Pros:** revocation and expiry.
  - **Cons:** a session service, store lifecycle, and login fixation and CSRF handling. It also widens the "configured verifier" profile into an identity system.
- **C. Signed stateless sessions.**
  - **How:** an HMAC over `principal + expiry` with a server key loaded like the credentials.
  - **Pros:** expiry without a store.
  - **Cons:** key management and rotation, and no revocation before expiry.

## Recommendation

**Option A now.** It closes the 401 gap at the assurance the project already claims, and keeps B and C open as later profiles behind the same `page_principal` seam.

**Cookie.** `__Host-reffect-session` (name configurable within the prefix), set with:

- `Secure; HttpOnly; Path=/; SameSite=Lax`;
- an explicit `Max-Age` (configurable);
- no `Domain`.

Lax rather than Strict, so that following a link into the app arrives authenticated.

**Pages** (GET and HEAD only, which change nothing):

- `Authorization` first, then the cookie;
- a forged or unknown cookie answers 401;
- the response stays `private, no-store`, and `Vary: Cookie` is added.

**RPC, including Live.** A request authenticated by the cookie, rather than by `Authorization` or an envelope header, is accepted only when all of these hold:

1. `Sec-Fetch-Site` is `same-origin`. When the header is absent, as in older browsers, `Origin` must equal the configured page origin.
2. `Content-Type` is the server's serialization (`application/json` or ndjson). A cross-origin request cannot send that without a preflight, and the server answers no CORS.
3. The method is POST, as RPC already requires.

Otherwise the request is treated as unauthenticated: a typed denial on protected procedures, as today. A bearer-authenticated request needs none of these checks, since browsers never attach `Authorization` on their own.

**Login and logout.** These are native endpoints at fixed paths beside the page host:

- **`POST /…/session`** checks `Authorization: Bearer` and answers `204` with `Set-Cookie`. It applies the same Fetch Metadata and `Origin` checks, against login CSRF.
- **`DELETE /…/session`** answers `204`, setting `Max-Age=0`.

Paths and the cookie name are compile options, refused if they clash with page routes or `/rpc`.

## Decisions needed

1. **Session model:** A, B or C. The recommendation is A.
2. **Whether RPC accepts the cookie at all.** The recommendation is yes, with the checks above. Otherwise the browser must hold the token in script.
3. **Whether reffect owns the login exchange.** The alternative is that the application sets the cookie itself, for example from a separate service on the same origin. The recommendation is native endpoints, so the showcase works end to end.

**Decided (user, 2026-10-05):**

1. **Option A:** the configured credential in a cookie.
2. **RPC and Live accept the cookie,** with the Fetch Metadata, Origin and Content-Type checks.
3. **Native login and logout endpoints.**

## Acceptance (from #4, refined)

- **Pages.** An authenticated page renders for a browser navigation that carries the session cookie, byte-equal to the reference host. A request with no cookie, or a forged one, answers 401.
- **Mutations.** No mutation is accepted on the cookie alone:
  - a cross-site request (`Sec-Fetch-Site: cross-site`, or a foreign `Origin` without Fetch Metadata) is denied;
  - a simple content type is denied;
  - a same-origin request is accepted.
- **Hydrated client.** In headless Chrome, `todo-fullstack` with auth logs in through the session endpoint, then navigates, renders and mutates with the cookie only. The token never appears in page script.
- **Hygiene.** Credentials never appear in logs, artifacts or responses, and the cookie is cleared by logout.
- **Oracle.** The reference side is an Effect `RpcMiddleware` reading the same cookie from the request headers, and upstream's `handleRequest` with the cookie-derived principal.

## Open questions

- Whether `Max-Age` should default to a session cookie (no `Max-Age`) for the demo profile.
- Whether a refused cookie-authenticated mutation should be distinguishable from a missing credential in logs. Responses stay the same typed denial.

## Implemented (2026-10-05)

**Configuration.** `NativeRpc.bearer(middleware, principal, { credentialsEnv, session })` takes `session: true` or `{ cookie?, path?, maxAge? }`:

- `cookie` must be a `__Host-` token name, default `__Host-reffect-session`;
- `path` is plain segments, default `/session`;
- `maxAge` is 1 second to 400 days.

A session needs `pages`, whose origin is the one `Origin` is compared with. Its path may not be the RPC path.

**Runtime** (`rpc-auth-runtime.ts`):

- **`authenticate`** checks a presented `Authorization`, from the transport or the envelope, as before. Only when none is presented does it consult `session_principal`. That requires `Sec-Fetch-Site: same-origin` (or, without Fetch Metadata, `Origin` equal to the page origin) and the serialization's media type (`application/json` or `application/ndjson`), then verifies the cookie's token. A presented credential is never replaced by the cookie.
- **`page_principal`** uses `Authorization`, else the cookie, with no cross-site check.
- **The cookie value** is taken only when its name appears exactly once across the `Cookie` headers.
- **Login** (`POST`) returns `204` with `Set-Cookie: <name>=<token>; Path=/; Secure; HttpOnly; SameSite=Lax[; Max-Age=N]` and `Cache-Control: no-store`. A cross-site request gets `403` and an unknown token `401`.
- **Logout** (`DELETE`) returns `204` and clears the cookie with `Max-Age=0`. A cross-site request gets `403`.
- **`Vary`** gains `Cookie` on page responses.

**Validation** (`remote-auth.test.ts`):

- **Configuration:** adapters are refused for a cookie name without `__Host-`, for `maxAge: 0`, and when there are no pages.
- **Login:** answers the exact cookie, and is refused for an unknown token (401) or a cross-site request or foreign origin (403). Without Fetch Metadata it is accepted with the page's own `Origin`.
- **Pages:** with the cookie, a page records the same exchanges as with the bearer and varies by `Cookie`. It answers 401 with no cookie, a forged one, one sent twice, or one under another name.
- **RPC:** a cookie read answers byte-equal to the same token as a bearer, and a cookie mutation runs as that principal. A cookie request is denied in seven cases: `cross-site`, `same-site` (sibling subdomain), a foreign `Origin`, no origin information, `text/plain`, no content type, or a wrong bearer beside it.
- **Logout:** clears the cookie, and a cross-site logout is refused.

**Remaining.** The end-to-end browser check (`todo-fullstack` with auth in headless Chrome) is step 4.
