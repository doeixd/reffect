/** Static bounded verifier; only selected by a checked bearer adapter. */
export const rpcAuthRuntime = String.raw`
use subtle::ConstantTimeEq;
use std::sync::Arc;
struct Credential { token: Vec<u8>, principal: u64 }
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
    if text.len() > 16384 { return Err(invalid) }
    let value: Value = serde_json::from_str(&text).map_err(|_| invalid)?;
    let entries = value.as_array().filter(|a| !a.is_empty() && a.len() <= 32).ok_or(invalid)?;
    let mut credentials: Vec<Credential> = Vec::with_capacity(entries.len());
    for entry in entries {
        let object = entry.as_object().filter(|o| o.len() == 2).ok_or(invalid)?;
        let token = object.get("token").and_then(Value::as_str).filter(|t| valid_token(t)).ok_or(invalid)?;
        let principal = u64_arg(object.get("principal").ok_or(invalid)?, None).map_err(|_| invalid)?;
        if credentials.iter().any(|c| c.token == token.as_bytes()) { return Err(invalid) }
        credentials.push(Credential { token: token.as_bytes().to_vec(), principal });
    }
    Ok(RuntimeState(Arc::new(credentials)))
}
fn authenticate(headers: &HeaderMap, message: &Value, state: &RuntimeState) -> Option<u64> {
    // Effect prepends transport headers, then normalizes envelope pairs with last-value wins.
    let mut transport = headers.get_all("authorization").iter();
    let mut authorization = transport.next().and_then(|h| h.to_str().ok());
    // Effect's normalized HTTP headers join repetitions with commas, which cannot form a bearer token.
    if transport.next().is_some() { authorization = None; }
    for pair in message["headers"].as_array()? {
        let pair = pair.as_array()?;
        if pair[0].as_str()?.eq_ignore_ascii_case("authorization") {
            authorization = pair[1].as_str();
        }
    }
    let (scheme, token) = authorization?.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("Bearer") || !valid_token(token) { return None }
    let mut principal = None;
    for credential in state.0.iter() {
        if bool::from(credential.token.as_slice().ct_eq(token.as_bytes())) {
            principal = Some(credential.principal);
        }
    }
    principal
}
`;
