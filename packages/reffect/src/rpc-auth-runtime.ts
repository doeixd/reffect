import { Rs } from "./rust-emit.ts";

/** The session cookie settings the runtime needs (#4); see `SessionCookie` in rpc-auth.ts. */
export interface SessionRuntime {
  /** The serialized page origin a cookie-authenticated request's `Origin` must equal. */
  readonly origin: string;
  /** The media type cookie-authenticated RPC bodies must declare. */
  readonly contentType: "application/json" | "application/ndjson";
}
/**
 * Static bounded verifier; only selected by a checked bearer adapter. With a session it also
 * reads the token from the session cookie: on pages as given, and on RPC only from the page's own
 * origin with the RPC content type (docs/research/cookie-sessions.md).
 */
export const rpcAuthRuntime = (session: SessionRuntime | undefined): string =>
  String.raw`
use subtle::ConstantTimeEq;
use std::sync::Arc;
/// A token zero-padded to the longest valid one, with its length: comparing these in constant
/// time reveals neither the token nor its length (#20).
struct Credential { token: [u8; 256], length: u16, principal: u64 }
fn padded(token: &str) -> [u8; 256] {
    let mut out = [0u8; 256];
    out[..token.len()].copy_from_slice(token.as_bytes());
    out
}
#[derive(Clone)]
struct RuntimeState(Arc<Vec<Credential>>);
fn valid_token(token: &str) -> bool {
    if token.is_empty() || token.len() > 256 { return false }
    let token = token.trim_end_matches('=');
    !token.is_empty() && token.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~+/".contains(&b))
}
fn load_state() -> Result<RuntimeState, &'static str> {
    let invalid = "Invalid RPC credential configuration";
    let text = std::env::var(CREDENTIALS_ENV).map_err(|_| invalid)?;
    // The tokens stay in this process only: child processes and /proc readers no longer see them.
    std::env::remove_var(CREDENTIALS_ENV);
    if text.len() > 16384 { return Err(invalid) }
    let value: Value = serde_json::from_str(&text).map_err(|_| invalid)?;
    let entries = value.as_array().filter(|a| !a.is_empty() && a.len() <= 32).ok_or(invalid)?;
    let mut credentials: Vec<Credential> = Vec::with_capacity(entries.len());
    for entry in entries {
        let object = entry.as_object().filter(|o| o.len() == 2).ok_or(invalid)?;
        let token = object.get("token").and_then(Value::as_str).filter(|t| valid_token(t)).ok_or(invalid)?;
        let principal = u64_arg(object.get("principal").ok_or(invalid)?, None).map_err(|_| invalid)?;
        let token_bytes = padded(token);
        let length = token.len() as u16;
        if credentials.iter().any(|c| c.token == token_bytes && c.length == length) { return Err(invalid) }
        credentials.push(Credential { token: token_bytes, length, principal });
    }
    Ok(RuntimeState(Arc::new(credentials)))
}
fn authenticate(headers: &HeaderMap, message: &Value, state: &RuntimeState) -> Option<u64> {
    // Effect prepends transport headers, then normalizes envelope pairs with last-value wins.
    let mut transport = headers.get_all("authorization").iter();
    // A presented credential is checked as presented, never replaced by the session cookie.
    let mut presented = headers.contains_key("authorization");
    let mut authorization = transport.next().and_then(|h| h.to_str().ok());
    // Effect's normalized HTTP headers join repetitions with commas, which cannot form a bearer token.
    if transport.next().is_some() { authorization = None; }
    for pair in message["headers"].as_array()? {
        let pair = pair.as_array()?;
        if pair[0].as_str()?.eq_ignore_ascii_case("authorization") {
            presented = true;
            authorization = pair[1].as_str();
        }
    }
    if !presented {
        // No credential presented: the session cookie, if the request may use it.
        return session_principal(headers, state);
    }
    let (scheme, token) = authorization?.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("Bearer") { return None }
    verify(token, state)
}
/// The principal a configured token names, compared in constant time.
fn verify(token: &str, state: &RuntimeState) -> Option<u64> {
    if !valid_token(token) { return None }
    let presented = padded(token);
    let length = token.len() as u16;
    let mut principal = None;
    for credential in state.0.iter() {
        if bool::from(credential.token.as_slice().ct_eq(presented.as_slice()) & credential.length.ct_eq(&length)) {
            principal = Some(credential.principal);
        }
    }
    principal
}
/// A page request's principal: its own Authorization header, as a page has no envelope, or else
/// its session cookie. Pages only read, so a page needs no cross-site check.
#[allow(dead_code)]
fn page_principal(headers: &HeaderMap, state: &RuntimeState) -> Option<u64> {
    if headers.get("authorization").is_some() {
        return authenticate(headers, &json!({ "headers": [] }), state);
    }
    cookie_principal(headers, state)
}
` + (session === undefined ? noSession : sessionRuntime(session));

const noSession = String.raw`
fn session_principal(_: &HeaderMap, _: &RuntimeState) -> Option<u64> { None }
#[allow(dead_code)]
fn cookie_principal(_: &HeaderMap, _: &RuntimeState) -> Option<u64> { None }
`;

const sessionRuntime = ({ origin, contentType }: SessionRuntime): string =>
  String.raw`
const SESSION_ORIGIN: &str = ${Rs.stringLiteral(origin).text};
const RPC_CONTENT_TYPE: &str = ${Rs.stringLiteral(contentType).text};
/// The one value of a header sent exactly once, as text.
fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    values.next().is_none().then_some(value)
}
/// The session cookie's token: the one cookie of its name across every Cookie header. A name sent
/// twice is ambiguous, so it authenticates nothing.
fn session_token(headers: &HeaderMap) -> Option<&str> {
    let mut found = None;
    for header in headers.get_all("cookie") {
        for pair in header.to_str().ok()?.split(';') {
            let Some((name, value)) = pair.split_once('=') else { continue };
            if name.trim() == SESSION_COOKIE {
                if found.is_some() { return None }
                found = Some(value.trim());
            }
        }
    }
    found
}
fn cookie_principal(headers: &HeaderMap, state: &RuntimeState) -> Option<u64> {
    verify(session_token(headers)?, state)
}
/// Whether the request comes from the page's own origin: Fetch Metadata when the browser sends it,
/// else an Origin equal to the page origin (OWASP's fallback). Neither means not.
fn same_origin(headers: &HeaderMap) -> bool {
    if headers.get("sec-fetch-site").is_some() {
        return single_header(headers, "sec-fetch-site") == Some("same-origin");
    }
    single_header(headers, "origin") == Some(SESSION_ORIGIN)
}
/// Whether the body declares the RPC media type, which a cross-origin page cannot send unpreflighted.
fn rpc_body(headers: &HeaderMap) -> bool {
    single_header(headers, "content-type")
        .and_then(|value| value.split(';').next())
        .is_some_and(|media| media.trim().eq_ignore_ascii_case(RPC_CONTENT_TYPE))
}
/// An RPC request's cookie principal: only from the page's own origin, with the RPC body (#4).
fn session_principal(headers: &HeaderMap, state: &RuntimeState) -> Option<u64> {
    if !same_origin(headers) || !rpc_body(headers) { return None }
    cookie_principal(headers, state)
}
fn session_answer(status: StatusCode, cookie: Option<String>) -> Response {
    let mut response = Response::new(axum::body::Body::empty());
    *response.status_mut() = status;
    response.headers_mut().insert("cache-control", axum::http::HeaderValue::from_static("no-store"));
    if let Some(cookie) = cookie {
        if let Ok(value) = axum::http::HeaderValue::from_str(&cookie) {
            response.headers_mut().insert("set-cookie", value);
        }
    }
    response
}
/// POST: exchange a configured bearer token for the session cookie. From another origin it is
/// refused (login CSRF), and an unknown token is 401.
async fn session_login(State(state): State<RuntimeState>, headers: HeaderMap) -> Response {
    if !same_origin(&headers) { return session_answer(StatusCode::FORBIDDEN, None) }
    let token = single_header(&headers, "authorization")
        .and_then(|value| value.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("Bearer"))
        .map(|(_, token)| token)
        .filter(|token| verify(token, &state).is_some());
    match token {
        Some(token) => session_answer(StatusCode::NO_CONTENT, Some(format!("{}={}{}", SESSION_COOKIE, token, SESSION_ATTRIBUTES))),
        None => session_answer(StatusCode::UNAUTHORIZED, None),
    }
}
/// DELETE: clear the session cookie; from another origin it is refused.
async fn session_logout(headers: HeaderMap) -> Response {
    if !same_origin(&headers) { return session_answer(StatusCode::FORBIDDEN, None) }
    session_answer(StatusCode::NO_CONTENT, Some(format!("{}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0", SESSION_COOKIE)))
}
`;
