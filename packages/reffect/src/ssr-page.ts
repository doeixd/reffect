/**
 * Native page serving for 8A (SSR-007): foldkit 0.165.0's `handleRequest` and `toResponse` with a
 * template split once at build time. Ported from `experimental/server/{fetch,entry,host}.js`:
 * host-settled methods, WHATWG path resolution, asset classification, `Accept` negotiation with
 * JS `Number`/`trim` semantics, and `Vary` merging. The template itself is spliced by upstream's
 * own `injectIntoTemplate`, run on sentinel values, so no HTML parser runs per request.
 */
import { Effect, Schema } from "effect";
import { injectIntoTemplate, renderToString } from "foldkit/experimental/server";
import { flow } from "./flow.ts";
import { Expr, Fn, IRType, StringType, UnknownType, fail, structLayout } from "./kernel.ts";
import { runtimeModule } from "./runtime-module.ts";
import { Rs } from "./rust-emit.ts";

/**
 * A page render (#13): nothing, or one `PageRequest` Struct holding any of `url` (String),
 * `remote` (Unknown: the exchanges a NativeRemote page carries in its Flags) and `views` (a
 * Struct of each planned view's `R.Remote.Page`). A page declares only what it reads.
 */
export type PageRender = Fn<readonly [], unknown> | Fn<readonly [IRType<unknown>], unknown>;
/** The fields a page's request declares, checked against what a host can supply. */
export interface PageRequestFields {
  readonly url: boolean;
  readonly remote: boolean;
  readonly views: IRType<unknown> | undefined;
}
const refusePage = (message: string) => fail("INVALID_PAGE", "authoring", "pages.render", message);
/** What `render`'s request reads, refusing a request outside the PageRequest shape. */
export const pageRequest = (render: Fn): PageRequestFields => {
  if (render.input.length === 0) return { url: false, remote: false, views: undefined };
  const layout = render.input.length === 1 ? structLayout(render.input[0]!) : undefined;
  if (layout === undefined || layout.tag !== undefined)
    throw refusePage("A page takes nothing or one PageRequest Struct of url, remote and views");
  const fields = new Map(layout.fields.map((field) => [field.name, field] as const));
  for (const field of layout.fields) {
    if (field.optional)
      throw refusePage(`The page request's ${field.name} is required, not optional`);
    if (!["url", "remote", "views"].includes(field.name))
      throw refusePage(`A page request holds url, remote and views, not ${field.name}`);
  }
  const url = fields.get("url");
  if (url && !IRType.same(url.type, StringType))
    throw refusePage("The page request's url is a String");
  const remote = fields.get("remote");
  if (remote && !IRType.same(remote.type, UnknownType))
    throw refusePage("The page request's remote is an Unknown");
  return { url: url !== undefined, remote: remote !== undefined, views: fields.get("views")?.type };
};
/**
 * The positional function a page host calls: `(url)`, or with data `(url, remote)` and, when
 * the request reads views, `(url, remote, views)`. It builds the request and applies `render`
 * through `R.flow`, so the generated host keeps one page call whatever the request holds.
 */
export const positionalPage = (render: Fn, data: boolean): Fn => {
  const request = pageRequest(render);
  if (!data && (request.remote || request.views !== undefined))
    throw refusePage("Only a NativeRemote page with a remote plan reads remote and views");
  const inputs: IRType<unknown>[] = [
    StringType,
    ...(data ? [UnknownType] : []),
    ...(data && request.views !== undefined ? [request.views] : []),
  ];
  const witness = render.input[0];
  if (witness === undefined) return Fn.make(inputs, render.output, () => render.body);
  const layout = structLayout(witness)!;
  const adapter = Fn.make(inputs, witness, (...args) => {
    const by: { readonly [name: string]: Expr<unknown> | undefined } = {
      url: args[0],
      remote: args[1],
      views: args[2],
    };
    return Expr.make(
      witness,
      undefined,
      layout.fields.map((field) => by[field.name]),
    );
  });
  const page = flow(adapter, render);
  if (!(page instanceof Fn)) throw refusePage("A page is a pure R function");
  return page;
};

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
  // injectIntoTemplate refuses a template already holding a Flags payload for the page's runtime
  // id, but the probe runs with its own id; any payload in the template is refused instead (#28).
  if (/data-foldkit-flags/i.test(template))
    throw fail(
      "INVALID_TEMPLATE",
      "authoring",
      "pages.template",
      "The template already holds a Flags payload; the page writes its own",
    );
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
        ? `body.push_str(${Rs.stringLiteral(part.text).text});`
        : part._tag === "Html"
          ? "body.push_str(html);"
          : "body.push_str(&title);",
    )
    .join(" ");
  const templateBytes = parts.reduce(
    (total, part) =>
      total + (part._tag === "Text" ? new TextEncoder().encode(part.text).length : 0),
    0,
  );
  return (
    runtimeModule("ssr_host", "crate-private") +
    String.raw`
/// ` +
    "`handleRequest`" +
    String.raw` with ` +
    "`toResponse`" +
    String.raw`: the page, an asset 404, a negotiated 404 or a refusal.
async fn ssr_page(State(state): State<RuntimeState>, method: axum::http::Method, uri: axum::http::Uri, headers: HeaderMap) -> Response {
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
    // The origin and the Vary values are fixed for the server's life: computed once (#38).
    static ORIGIN: std::sync::OnceLock<Option<url::Url>> = std::sync::OnceLock::new();
    static VARY: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();
    let (destination_vary, negotiated_vary) = VARY.get_or_init(|| {
        let destination = ssr_host::vary_with(None, "Sec-Fetch-Dest");
        let negotiated = ssr_host::vary_with(Some(&ssr_host::vary_with(None, "Accept")), "Sec-Fetch-Dest");
        (destination, negotiated)
    });
    let base = ORIGIN.get_or_init(|| url::Url::parse(${Rs.stringLiteral(origin).text}).ok());
    let Some(resolved) = base.as_ref().and_then(|base| ssr_host::resolve_against(&raw_target, base)) else {
        return empty(StatusCode::BAD_REQUEST, &[]);
    };
    #[allow(unused_variables)]
    let href: String = resolved.to_string();
    let method = method.as_str().to_uppercase();
    if method == "CONNECT" || method == "TRACE" || method == "TRACK" {
        return empty(StatusCode::METHOD_NOT_ALLOWED, &[("allow", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS".to_string())]);
    }
    // Once negotiated, every answer says it varies by Accept and Sec-Fetch-Dest (#28).
    let negotiated_vary = || negotiated_vary.clone();
    let routed = if uri.scheme().is_some() { format!("{}{}", resolved.path(), resolved.query().map(|query| format!("?{}", query)).unwrap_or_default()) } else { raw_target.clone() };
    let target = routed.as_str();
    let get_or_head = method == "GET" || method == "HEAD";
    let mut negotiated = false;
    if get_or_head && !ssr_host::resolves_to_index_html(target) {
        let destination = ssr_host::header_value(&headers, "sec-fetch-dest");
        match ssr_host::classify(target, destination.as_deref()) {
            ssr_host::Class::PathAsset => return empty(StatusCode::NOT_FOUND, &[]),
            ssr_host::Class::DestinationAsset => return empty(StatusCode::NOT_FOUND, &[("vary", destination_vary.clone())]),
            ssr_host::Class::Page => {}
        }
        negotiated = true;
        if !ssr_host::accepts_html(ssr_host::header_value(&headers, "accept").as_deref()) {
            return empty(StatusCode::NOT_FOUND, &[("vary", negotiated_vary())]);
        }
    }
    let refuse = |status: StatusCode| if negotiated { empty(status, &[("vary", negotiated_vary())]) } else { empty(status, &[]) };
    ${
      data === undefined
        ? "let _ = &state;"
        : `// The page's data, read as the request's principal may read it (M9-3 step 2a).
    let principal = page_principal(&headers, &state);
    #[allow(unused_variables)]
    let (resume, views): (Value, Value) = match ${data} { Ok(data) => data, Err(status) => return refuse(status) };${
      views === undefined
        ? ""
        : `
    // A view that is not a Ready page of its witness cannot render natively (M9-3 step 2b).
    let views = match ${views} {
        Ok(views) => views,
        Err(message) => {
            eprintln!("{}", json!({"schema":"reffect.ssr.page@1", "outcome":"view-failure", "message":message}));
            return refuse(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };`
    }`
    }
    // The page's own render failure, or a title the template cannot hold, is a server error.
    let page: Value = ${render};
    let (Some(html), Some(raw_title)) = (page["success"]["html"].as_str(), page["success"]["title"].as_str()) else {
        eprintln!("{}", json!({"schema":"reffect.ssr.page@1", "outcome":"render-failure", "page":page}));
        return refuse(StatusCode::INTERNAL_SERVER_ERROR);
    };
    let title = match reffect_generated::foldkit_html::escape_text(raw_title) {
        Ok(title) => title,
        Err(message) => {
            eprintln!("{}", json!({"schema":"reffect.ssr.page@1", "outcome":"title-failure", "message":message}));
            return refuse(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };
    // Sized once: the template's own text is known at build time (#34).
    let mut body = String::with_capacity(${templateBytes} + html.len() + title.len());
    ${splice}
    let mut extra = vec![("content-type", "text/html; charset=utf-8".to_string())];${
      data === undefined
        ? ""
        : `
    // The page carries data read for this request, its principal's when it has one: shared
    // caches must not store it (#3; upstream's host sets no cache headers).
    extra.push(("cache-control", "private, no-store".to_string()));`
    }
    if negotiated { extra.push(("vary", negotiated_vary())); }
    let mut response = empty(StatusCode::OK, &extra);
    if method != "HEAD" { *response.body_mut() = axum::body::Body::from(body); }
    response
}
`
  );
};
