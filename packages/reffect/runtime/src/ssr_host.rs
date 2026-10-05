/// JS `\s` and String.prototype.trim's set.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}
/// JS Number(string): whitespace-trimmed, empty is 0, Infinity, 0x/0o/0b, else a decimal literal.
fn js_number(text: &str) -> f64 {
    let t = js_trim(text);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |n, c| {
                n * radix as f64 + c.to_digit(radix).unwrap() as f64
            });
        }
    }
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(at) => (&body[..at], Some(&body[at + 1..])),
        None => (body, None),
    };
    let (whole, fraction) = match mantissa.find('.') {
        Some(at) => (&mantissa[..at], Some(&mantissa[at + 1..])),
        None => (mantissa, None),
    };
    let digits = |s: &str| s.chars().all(|c| c.is_ascii_digit());
    let mantissa_ok = digits(whole)
        && fraction.map(digits).unwrap_or(true)
        && !(whole.is_empty() && fraction.map(str::is_empty).unwrap_or(true));
    let exponent_ok = exponent
        .map(|e| {
            let e = e.strip_prefix(['+', '-']).unwrap_or(e);
            !e.is_empty() && digits(e)
        })
        .unwrap_or(true);
    if !mantissa_ok || !exponent_ok {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}
fn split_outside_quotes(value: &str, delimiter: char) -> Vec<String> {
    let (mut parts, mut current, mut quoted, mut escaped) =
        (Vec::new(), String::new(), false, false);
    for c in value.chars() {
        if escaped {
            current.push(c);
            escaped = false;
        } else if quoted && c == '\\' {
            current.push(c);
            escaped = true;
        } else if c == '"' {
            quoted = !quoted;
            current.push(c);
        } else if c == delimiter && !quoted {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(c);
        }
    }
    parts.push(current);
    parts
}
fn quality_of(parameters: &[String]) -> f64 {
    for parameter in parameters {
        let Some(separator) = parameter.find('=') else {
            continue;
        };
        if js_trim(&parameter[..separator]).to_lowercase() != "q" {
            continue;
        }
        let value = js_number(js_trim(&parameter[separator + 1..]));
        return if value.is_nan() { 1.0 } else { value };
    }
    1.0
}
/// `acceptsHtml`: the most specific of text/html, text/* and */* decides, with q above 0.
pub fn accepts_html(accept: Option<&str>) -> bool {
    let Some(accept) = accept else { return true };
    if js_trim(accept).is_empty() {
        return true;
    }
    let (mut best_specificity, mut best_quality) = (0, 0.0);
    for range in split_outside_quotes(accept, ',') {
        let parts = split_outside_quotes(&range, ';');
        let specificity = match js_trim(&parts[0]).to_lowercase().as_str() {
            "text/html" => 3,
            "text/*" => 2,
            "*/*" => 1,
            _ => continue,
        };
        if specificity > best_specificity {
            best_specificity = specificity;
            best_quality = quality_of(&parts[1..]);
        }
    }
    best_specificity > 0 && best_quality > 0.0
}
pub fn vary_with(existing: Option<&str>, field: &str) -> String {
    let tokens: Vec<&str> = existing
        .map(|e| {
            e.split(',')
                .map(js_trim)
                .filter(|t| !t.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let lowered: Vec<String> = tokens.iter().map(|t| t.to_lowercase()).collect();
    if lowered.iter().any(|t| t == "*") {
        return "*".to_string();
    }
    if lowered.contains(&field.to_lowercase()) {
        return tokens.join(", ");
    }
    let mut all: Vec<&str> = tokens;
    all.push(field);
    all.join(", ")
}
/// The WHATWG pathname of a request target, as `new URL(target, 'http://localhost')` gives it.
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
            out.push(
                u8::from_str_radix(hex, 16)
                    .ok()
                    .filter(|_| hex.bytes().all(|b| b.is_ascii_hexdigit()))?,
            );
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}
fn normalize_path(path: &str) -> String {
    let mut segments: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    segments.join("/")
}
/// resolveRequestUrl: the target resolved against the origin, or nothing when it names
/// another origin or carries credentials.
pub fn resolve_request_url(target: &str, origin: &str) -> Option<url::Url> {
    resolve_against(target, &url::Url::parse(origin).ok()?)
}
/// `resolveRequestUrl` against an origin parsed once, as a page host holds it.
pub fn resolve_against(target: &str, base: &url::Url) -> Option<url::Url> {
    let resolved = base.join(target).ok()?;
    if !resolved.username().is_empty() || resolved.password().is_some() {
        return None;
    }
    (resolved.origin() == base.origin()).then_some(resolved)
}
pub fn resolves_to_index_html(target: &str) -> bool {
    let Some(path) = pathname(target) else {
        return false;
    };
    let Some(decoded) = decode_uri_component(&path) else {
        return false;
    };
    if decoded.contains('\0') {
        return false;
    }
    let normalized = normalize_path(&decoded.replace('\\', "/"));
    normalized.is_empty() || normalized.to_lowercase() == "index.html"
}
const SUBRESOURCES: [&str; 16] = [
    "audio",
    "audioworklet",
    "embed",
    "font",
    "image",
    "manifest",
    "object",
    "paintworklet",
    "script",
    "serviceworker",
    "sharedworker",
    "style",
    "track",
    "video",
    "worker",
    "xslt",
];
const ASSETS: [&str; 33] = [
    "avif",
    "bmp",
    "cjs",
    "css",
    "csv",
    "eot",
    "gif",
    "gz",
    "ico",
    "jpeg",
    "jpg",
    "js",
    "json",
    "map",
    "mjs",
    "mp3",
    "mp4",
    "ogg",
    "otf",
    "pdf",
    "png",
    "svg",
    "ttf",
    "txt",
    "wasm",
    "wav",
    "webm",
    "webmanifest",
    "webp",
    "woff",
    "woff2",
    "xml",
    "zip",
];
#[derive(PartialEq)]
pub enum Class {
    PathAsset,
    DestinationAsset,
    Page,
}
pub fn classify(target: &str, destination: Option<&str>) -> Class {
    let path = pathname(target).unwrap_or_default();
    let path = decode_uri_component(&path).unwrap_or(path);
    let last = &path[path.rfind('/').map(|at| at + 1).unwrap_or(0)..];
    if let Some(separator) = last.rfind('.').filter(|at| *at > 0) {
        if ASSETS.contains(&last[separator + 1..].to_lowercase().as_str()) {
            return Class::PathAsset;
        }
    }
    if let Some(destination) = destination {
        if SUBRESOURCES.contains(&js_trim(destination).to_lowercase().as_str()) {
            return Class::DestinationAsset;
        }
    }
    Class::Page
}
/// A request header as Fetch's `headers.get` reads it: repeated values joined with ", ", and
/// bytes taken as Latin-1, so a non-ASCII value is not mistaken for an absent one (#28).
pub fn header_value(headers: &axum::http::HeaderMap, name: &str) -> Option<String> {
    let mut values = headers.get_all(name).iter().peekable();
    values.peek()?;
    Some(
        values
            .map(|value| {
                value
                    .as_bytes()
                    .iter()
                    .map(|byte| *byte as char)
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join(", "),
    )
}
/// The `Cookie` text a page reads (8B): every `Cookie` header as latin1 text, joined with `"; "`
/// as a Web `Request` joins a repeated cookie header, without the session cookie's pairs, so no
/// view can write the HttpOnly token into a page. Each kept pair's text is unchanged, so
/// `Cookies.parseHeader` reads the rest exactly as it would have.
pub fn page_cookie(headers: &axum::http::HeaderMap, session: Option<&str>) -> String {
    let text = headers
        .get_all("cookie")
        .iter()
        .map(|value| {
            value
                .as_bytes()
                .iter()
                .map(|byte| *byte as char)
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("; ");
    let Some(session) = session else {
        return text;
    };
    text.split(';')
        .filter(|pair| {
            let key = pair.split('=').next().unwrap_or("");
            key.trim_matches(js_space) != session
        })
        .collect::<Vec<_>>()
        .join(";")
}
/// A page's server entry (foldkit 0.165.0 `entry.js`), decoded from its encoded `R.Html.Entry`.
pub enum EntryParts {
    Rendered {
        page: serde_json::Value,
        status: u16,
        headers: Vec<(String, String)>,
    },
    Responded {
        status: u16,
        headers: Vec<(String, String)>,
        body: Option<String>,
    },
}
/// HTTP whitespace, which `Headers` strips from both ends of a value.
fn http_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r')
}
/// `new Headers(init)` over name/value pairs: names lowercased, values trimmed of HTTP
/// whitespace, a repeated name combined with `", "` in first-seen order, and the TypeError an
/// invalid name or value raises.
fn entry_headers(pairs: &serde_json::Value) -> Result<Vec<(String, String)>, String> {
    let mut headers: Vec<(String, String)> = Vec::new();
    for pair in pairs.as_array().map(Vec::as_slice).unwrap_or_default() {
        let name = pair["name"].as_str().unwrap_or_default();
        let value = pair["value"]
            .as_str()
            .unwrap_or_default()
            .trim_matches(http_space);
        let token = |c: char| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c);
        if name.is_empty() || !name.chars().all(token) {
            return Err(format!("Headers: invalid header name {:?}", name));
        }
        if value.contains(['\0', '\r', '\n']) {
            return Err(format!("Headers: invalid header value for {:?}", name));
        }
        let name = name.to_ascii_lowercase();
        match headers.iter_mut().find(|(known, _)| *known == name) {
            Some((_, known)) => {
                known.push_str(", ");
                known.push_str(value);
            }
            None => headers.push((name, value.to_string())),
        }
    }
    Ok(headers)
}
/// A `Response` status as its constructor converts and checks it: 200 to 599, truncated, and
/// none of the null-body statuses when the response has a body.
fn entry_status(status: &serde_json::Value, has_body: bool) -> Result<u16, String> {
    let status = status
        .as_f64()
        .filter(|s| s.is_finite())
        .map(f64::trunc)
        .unwrap_or(0.0);
    if !(200.0..=599.0).contains(&status) {
        return Err(format!("Response: status {} is outside 200 to 599", status));
    }
    let status = status as u16;
    if has_body && matches!(status, 204 | 205 | 304) {
        return Err(format!("Response: status {} cannot have a body", status));
    }
    Ok(status)
}
/// Splits an encoded entry into what the host answers, or why upstream's `toResponse` throws.
pub fn entry_parts(entry: &serde_json::Value) -> Result<EntryParts, String> {
    let headers = entry_headers(&entry["headers"])?;
    if entry["_tag"] == "Responded" {
        let body = entry["body"].as_str().map(str::to_string);
        return Ok(EntryParts::Responded {
            status: entry_status(&entry["status"], body.is_some())?,
            headers,
            body,
        });
    }
    Ok(EntryParts::Rendered {
        page: entry["page"].clone(),
        status: entry_status(&entry["status"], true)?,
        headers,
    })
}
/// Sets `name` in `headers`, replacing an earlier value, as `Headers.set` does.
pub fn set_header(headers: &mut Vec<(String, String)>, name: &str, value: String) {
    match headers.iter_mut().find(|(known, _)| known == name) {
        Some((_, known)) => *known = value,
        None => headers.push((name.to_string(), value)),
    }
}
