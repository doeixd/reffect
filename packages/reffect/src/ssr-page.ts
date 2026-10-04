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
    String.raw`
mod ssr_host {
    /// JS ` +
    "`\\s`" +
    String.raw` and String.prototype.trim's set.
    fn js_space(c: char) -> bool {
        matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
    }
    fn js_trim(s: &str) -> &str { s.trim_matches(js_space) }
    /// JS Number(string): whitespace-trimmed, empty is 0, Infinity, 0x/0o/0b, else a decimal literal.
    fn js_number(text: &str) -> f64 {
        let t = js_trim(text);
        if t.is_empty() { return 0.0; }
        match t { "Infinity" | "+Infinity" => return f64::INFINITY, "-Infinity" => return f64::NEG_INFINITY, _ => {} }
        for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
            if let Some(digits) = t.strip_prefix(prefix) {
                if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) { return f64::NAN; }
                return digits.chars().fold(0.0, |n, c| n * radix as f64 + c.to_digit(radix).unwrap() as f64);
            }
        }
        let body = t.strip_prefix(['+', '-']).unwrap_or(t);
        let (mantissa, exponent) = match body.find(['e', 'E']) { Some(at) => (&body[..at], Some(&body[at + 1..])), None => (body, None) };
        let (whole, fraction) = match mantissa.find('.') { Some(at) => (&mantissa[..at], Some(&mantissa[at + 1..])), None => (mantissa, None) };
        let digits = |s: &str| s.chars().all(|c| c.is_ascii_digit());
        let mantissa_ok = digits(whole) && fraction.map(digits).unwrap_or(true) && !(whole.is_empty() && fraction.map(str::is_empty).unwrap_or(true));
        let exponent_ok = exponent.map(|e| { let e = e.strip_prefix(['+', '-']).unwrap_or(e); !e.is_empty() && digits(e) }).unwrap_or(true);
        if !mantissa_ok || !exponent_ok { return f64::NAN; }
        t.parse::<f64>().unwrap_or(f64::NAN)
    }
    fn split_outside_quotes(value: &str, delimiter: char) -> Vec<String> {
        let (mut parts, mut current, mut quoted, mut escaped) = (Vec::new(), String::new(), false, false);
        for c in value.chars() {
            if escaped { current.push(c); escaped = false; }
            else if quoted && c == '\\' { current.push(c); escaped = true; }
            else if c == '"' { quoted = !quoted; current.push(c); }
            else if c == delimiter && !quoted { parts.push(std::mem::take(&mut current)); }
            else { current.push(c); }
        }
        parts.push(current);
        parts
    }
    fn quality_of(parameters: &[String]) -> f64 {
        for parameter in parameters {
            let Some(separator) = parameter.find('=') else { continue };
            if js_trim(&parameter[..separator]).to_lowercase() != "q" { continue; }
            let value = js_number(js_trim(&parameter[separator + 1..]));
            return if value.is_nan() { 1.0 } else { value };
        }
        1.0
    }
    /// ` +
    "`acceptsHtml`" +
    String.raw`: the most specific of text/html, text/* and */* decides, with q above 0.
    pub fn accepts_html(accept: Option<&str>) -> bool {
        let Some(accept) = accept else { return true };
        if js_trim(accept).is_empty() { return true; }
        let (mut best_specificity, mut best_quality) = (0, 0.0);
        for range in split_outside_quotes(accept, ',') {
            let parts = split_outside_quotes(&range, ';');
            let specificity = match js_trim(&parts[0]).to_lowercase().as_str() { "text/html" => 3, "text/*" => 2, "*/*" => 1, _ => continue };
            if specificity > best_specificity { best_specificity = specificity; best_quality = quality_of(&parts[1..]); }
        }
        best_specificity > 0 && best_quality > 0.0
    }
    pub fn vary_with(existing: Option<&str>, field: &str) -> String {
        let tokens: Vec<&str> = existing.map(|e| e.split(',').map(js_trim).filter(|t| !t.is_empty()).collect()).unwrap_or_default();
        let lowered: Vec<String> = tokens.iter().map(|t| t.to_lowercase()).collect();
        if lowered.iter().any(|t| t == "*") { return "*".to_string(); }
        if lowered.contains(&field.to_lowercase()) { return tokens.join(", "); }
        let mut all: Vec<&str> = tokens;
        all.push(field);
        all.join(", ")
    }
    /// The WHATWG pathname of a request target, as ` +
    "`new URL(target, 'http://localhost')`" +
    String.raw` gives it.
    fn pathname(target: &str) -> Option<String> {
        let base = url::Url::parse("http://localhost").ok()?;
        Some(base.join(target).ok()?.path().to_string())
    }
    /// decodeURIComponent: every % starts a valid escape, and the bytes are UTF-8.
    fn decode_uri_component(text: &str) -> Option<String> {
        let bytes = text.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' {
                let hex = text.get(i + 1..i + 3)?;
                out.push(u8::from_str_radix(hex, 16).ok().filter(|_| hex.bytes().all(|b| b.is_ascii_hexdigit()))?);
                i += 3;
            } else { out.push(bytes[i]); i += 1; }
        }
        String::from_utf8(out).ok()
    }
    fn normalize_path(path: &str) -> String {
        let mut segments: Vec<&str> = Vec::new();
        for segment in path.split('/') {
            match segment { "" | "." => {}, ".." => { segments.pop(); }, other => segments.push(other) }
        }
        segments.join("/")
    }
    pub fn resolves_to_index_html(target: &str) -> bool {
        let Some(path) = pathname(target) else { return false };
        let Some(decoded) = decode_uri_component(&path) else { return false };
        if decoded.contains('\0') { return false; }
        let normalized = normalize_path(&decoded.replace('\\', "/"));
        normalized.is_empty() || normalized.to_lowercase() == "index.html"
    }
    const SUBRESOURCES: [&str; 16] = ["audio", "audioworklet", "embed", "font", "image", "manifest", "object", "paintworklet", "script", "serviceworker", "sharedworker", "style", "track", "video", "worker", "xslt"];
    const ASSETS: [&str; 33] = ["avif", "bmp", "cjs", "css", "csv", "eot", "gif", "gz", "ico", "jpeg", "jpg", "js", "json", "map", "mjs", "mp3", "mp4", "ogg", "otf", "pdf", "png", "svg", "ttf", "txt", "wasm", "wav", "webm", "webmanifest", "webp", "woff", "woff2", "xml", "zip"];
    #[derive(PartialEq)]
    pub enum Class { PathAsset, DestinationAsset, Page }
    pub fn classify(target: &str, destination: Option<&str>) -> Class {
        let path = pathname(target).unwrap_or_default();
        let path = decode_uri_component(&path).unwrap_or(path);
        let last = &path[path.rfind('/').map(|at| at + 1).unwrap_or(0)..];
        if let Some(separator) = last.rfind('.').filter(|at| *at > 0) {
            if ASSETS.contains(&last[separator + 1..].to_lowercase().as_str()) { return Class::PathAsset; }
        }
        if let Some(destination) = destination {
            if SUBRESOURCES.contains(&js_trim(destination).to_lowercase().as_str()) { return Class::DestinationAsset; }
        }
        Class::Page
    }
}

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
    let method = method.as_str().to_uppercase();
    if method == "CONNECT" || method == "TRACE" || method == "TRACK" {
        return empty(StatusCode::METHOD_NOT_ALLOWED, &[("allow", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS".to_string())]);
    }
    let target = uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
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
    // The request URL as upstream's Request has it: the target resolved against the origin.
    #[allow(unused_variables)]
    let href: String = url::Url::parse(${JSON.stringify(origin)}).and_then(|base| base.join(target)).map(|url| url.to_string()).unwrap_or_default();
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
    let mut extra = vec![("content-type", "text/html; charset=utf-8".to_string())];
    if negotiated { extra.push(("vary", ssr_host::vary_with(Some(&ssr_host::vary_with(None, "Accept")), "Sec-Fetch-Dest"))); }
    let mut response = empty(StatusCode::OK, &extra);
    if method != "HEAD" { *response.body_mut() = axum::body::Body::from(body); }
    response
}
`
  );
};
