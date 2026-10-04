/**
 * Native page serving for 8A (SSR-007): foldkit 0.165.0's `handleRequest` and `toResponse` with a
 * template split once at build time. Ported from `experimental/server/{fetch,entry,host}.js`:
 * host-settled methods, WHATWG path resolution, asset classification, `Accept` negotiation with
 * JS `Number`/`trim` semantics, and `Vary` merging. The template itself is spliced by upstream's
 * own `injectIntoTemplate`, run on sentinel values, so no HTML parser runs per request.
 */
import { Effect, Schema } from "effect";
import { injectIntoTemplate, renderToString } from "foldkit/experimental/server";
import { fail } from "./kernel.ts";
import { runtimeModule } from "./runtime-module.ts";

/** A page's outcome as the server encodes it: `RenderedApplication`'s fields or a render error. */
export const PageSchema = Schema.Union([
  Schema.TaggedStruct("Success", {
    success: Schema.Struct({ html: Schema.String, title: Schema.String }),
  }),
  Schema.TaggedStruct("Failure", {
    failure: Schema.Union([
      Schema.TaggedStruct("InvalidHydrationRoot", { rootKind: Schema.String }),
      Schema.TaggedStruct("SerializationError", { message: Schema.String }),
      Schema.TaggedStruct("FlagsEncodeError", { message: Schema.String }),
    ]),
  }),
]);

/** A template cut around the rendered root and the title text, in document order. */
export type TemplatePart =
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Html" }
  | { readonly _tag: "Title" };

const TITLE = "reffecttitlesentinel7f3a";
const BODY = "reffectbodysentinel7f3a";
/**
 * Where `injectIntoTemplate` puts the root and the title, found by running it on a sentinel
 * render. lang, dir, canonical and og:url stay as the template has them: the 8A profile sets none.
 */
export const splitTemplate = (
  template: string,
  containerId?: string,
): ReadonlyArray<TemplatePart> => {
  const rendered = Effect.runSync(
    renderToString(
      {
        init: () => ({ model: {} }),
        view: (_model: object, h) => ({ title: TITLE, body: h.div([], [BODY]) }),
      },
      { buildId: "reffect-template-probe" },
    ),
  );
  let page: string;
  try {
    page = injectIntoTemplate(
      template,
      rendered,
      containerId === undefined ? undefined : { containerId },
    );
  } catch (cause) {
    throw fail(
      "INVALID_TEMPLATE",
      "ssr",
      "pages.template",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  const once = (needle: string, what: string): number => {
    const at = page.indexOf(needle);
    if (at < 0 || page.indexOf(needle, at + 1) >= 0)
      throw fail("INVALID_TEMPLATE", "ssr", "pages.template", `The template must hold one ${what}`);
    return at;
  };
  const slots = [
    {
      _tag: "Html" as const,
      at: once(rendered.html, "root placeholder"),
      length: rendered.html.length,
    },
    { _tag: "Title" as const, at: once(TITLE, "<title>"), length: TITLE.length },
  ].sort((a, b) => a.at - b.at);
  const parts: TemplatePart[] = [];
  let from = 0;
  for (const slot of slots) {
    parts.push({ _tag: "Text", text: page.slice(from, slot.at) });
    parts.push({ _tag: slot._tag });
    from = slot.at + slot.length;
  }
  parts.push({ _tag: "Text", text: page.slice(from) });
  return Object.freeze(parts);
};

/**
 * The Rust host: `handleRequest` around `render`, an expression evaluating to the encoded page.
 * `data`, when given, is an async expression over the request's `principal` yielding the page's
 * data, `Result<Value, StatusCode>`; `render` reads it as `data`.
 */
export const pageRuntime = (
  parts: ReadonlyArray<TemplatePart>,
  origin: string,
  render: string,
  data?: string,
  views?: string,
): string => {
  const splice = parts
    .map((part) =>
      part._tag === "Text"
        ? `body.push_str(${JSON.stringify(part.text)});`
        : part._tag === "Html"
          ? "body.push_str(html);"
          : "body.push_str(&title);",
    )
    .join(" ");
  return (
    runtimeModule("ssr_host", "crate-private") +
    String.raw`
/// ` +
    "`handleRequest`" +
    String.raw` with ` +
    "`toResponse`" +
    String.raw`: the page, an asset 404, a negotiated 404 or a refusal.
async fn ssr_page(State(state): State<RuntimeState>, method: axum::http::Method, uri: axum::http::Uri, headers: HeaderMap) -> Response {
    use axum::http::header;
    let empty = |status: StatusCode, extra: &[(&'static str, String)]| {
        let mut response = Response::new(axum::body::Body::empty());
        *response.status_mut() = status;
        for (name, value) in extra { response.headers_mut().insert(*name, axum::http::HeaderValue::from_str(value).unwrap()); }
        response
    };
    // The request URL as upstream's Node adapter builds it (resolveRequestUrl): the target
    // against the configured origin, refused before anything else when it names another origin
    // or carries credentials (#21). Hyper keeps an absolute-form target's authority outside its path.
    let raw_target = if uri.scheme().is_some() { uri.to_string() } else { uri.path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".to_string()) };
    let Some(resolved) = ssr_host::resolve_request_url(&raw_target, ${JSON.stringify(origin)}) else {
        return empty(StatusCode::BAD_REQUEST, &[]);
    };
    #[allow(unused_variables)]
    let href: String = resolved.to_string();
    let method = method.as_str().to_uppercase();
    if method == "CONNECT" || method == "TRACE" || method == "TRACK" {
        return empty(StatusCode::METHOD_NOT_ALLOWED, &[("allow", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS".to_string())]);
    }
    let routed = if uri.scheme().is_some() { format!("{}{}", resolved.path(), resolved.query().map(|query| format!("?{}", query)).unwrap_or_default()) } else { raw_target.clone() };
    let target = routed.as_str();
    let get_or_head = method == "GET" || method == "HEAD";
    let mut negotiated = false;
    if get_or_head && !ssr_host::resolves_to_index_html(target) {
        let destination = headers.get("sec-fetch-dest").and_then(|v| v.to_str().ok());
        match ssr_host::classify(target, destination) {
            ssr_host::Class::PathAsset => return empty(StatusCode::NOT_FOUND, &[]),
            ssr_host::Class::DestinationAsset => return empty(StatusCode::NOT_FOUND, &[("vary", ssr_host::vary_with(None, "Sec-Fetch-Dest"))]),
            ssr_host::Class::Page => {}
        }
        negotiated = true;
        if !ssr_host::accepts_html(headers.get(header::ACCEPT).and_then(|v| v.to_str().ok())) {
            return empty(StatusCode::NOT_FOUND, &[("vary", ssr_host::vary_with(Some(&ssr_host::vary_with(None, "Accept")), "Sec-Fetch-Dest"))]);
        }
    }
    ${
      data === undefined
        ? "let _ = &state;"
        : `// The page's data, read as the request's principal may read it (M9-3 step 2a).
    let principal = page_principal(&headers, &state);
    #[allow(unused_variables)]
    let (resume, views): (Value, Value) = match ${data} { Ok(data) => data, Err(status) => return empty(status, &[]) };${
      views === undefined
        ? ""
        : `
    // A view that is not a Ready page of its witness cannot render natively (M9-3 step 2b).
    let views = match ${views} {
        Ok(views) => views,
        Err(message) => {
            eprintln!("{}", json!({"schema":"reffect.ssr.page@1", "outcome":"view-failure", "message":message}));
            return empty(StatusCode::INTERNAL_SERVER_ERROR, &[]);
        }
    };`
    }`
    }
    // The page's own render failure, or a title the template cannot hold, is a server error.
    let page: Value = ${render};
    let (Some(html), Some(raw_title)) = (page["success"]["html"].as_str(), page["success"]["title"].as_str()) else {
        eprintln!("{}", json!({"schema":"reffect.ssr.page@1", "outcome":"render-failure", "page":page}));
        return empty(StatusCode::INTERNAL_SERVER_ERROR, &[]);
    };
    let title = match reffect_generated::foldkit_html::escape_text(raw_title) {
        Ok(title) => title,
        Err(message) => {
            eprintln!("{}", json!({"schema":"reffect.ssr.page@1", "outcome":"title-failure", "message":message}));
            return empty(StatusCode::INTERNAL_SERVER_ERROR, &[]);
        }
    };
    let mut body = String::new();
    ${splice}
    let mut extra = vec![("content-type", "text/html; charset=utf-8".to_string())];${
      data === undefined
        ? ""
        : `
    // The page carries data read for this request, its principal's when it has one: shared
    // caches must not store it (#3; upstream's host sets no cache headers).
    extra.push(("cache-control", "private, no-store".to_string()));`
    }
    if negotiated { extra.push(("vary", ssr_host::vary_with(Some(&ssr_host::vary_with(None, "Accept")), "Sec-Fetch-Dest"))); }
    let mut response = empty(StatusCode::OK, &extra);
    if method != "HEAD" { *response.body_mut() = axum::body::Body::from(body); }
    response
}
`
  );
};
