import type { RsStmt } from "./rust-emit.ts";

/** Audited HTTP substrate; dynamic tags/fields/calls are emitted separately through Rs. */
export const rpcRuntime = (
  frameCleanup?: RsStmt,
  asynchronous = false,
  ranges = false,
): string => String.raw`
use axum::{body::Bytes, extract::{DefaultBodyLimit, State}, http::{StatusCode, HeaderMap}, routing::post, Json, Router};
use serde_json::{json, Value};

fn success(value: Value) -> Value { json!({"_tag":"Success", "value":value}) }
fn failure(error: Value) -> Value { json!({"_tag":"Failure", "cause":[{"_tag":"Fail", "error":error}]}) }
fn exit(id: &Value, value: Value) -> Value {
    json!({"_tag":"Exit", "requestId":id, "exit":value})
}
fn die(id: &Value, message: String) -> Value {
    exit(id, json!({"_tag":"Failure", "cause":[{"_tag":"Die", "defect":message}]}))
}
fn invalid(message: &str) -> Value {
    json!({"_tag":"Defect", "defect":{"name":"ProtocolError", "message":message}})
}
fn field<'a>(payload: &'a Value, name: &str) -> Result<&'a Value, String> {
    payload.as_object().and_then(|o| o.get(name)).ok_or_else(|| path_error("Missing key", Some(name)))
}
fn path_error(message: &str, name: Option<&str>) -> String {
    match name { None => message.to_string(), Some(name) => format!("{}\n  at [{}]", message, serde_json::to_string(name).unwrap()) }
}
fn u64_arg(value: &Value, name: Option<&str>) -> Result<u64, String> {
    let text = value.as_str().ok_or_else(|| path_error("Expected string", name))?;
    let digits = text.strip_prefix('-').unwrap_or(text);
    if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
        return Err(path_error("Expected a string representing a bigint", name));
    }
    let significant = digits.trim_start_matches('0');
    if text.starts_with('-') && !significant.is_empty() {
        return Err(path_error("Expected a value greater than or equal to 0n", name));
    }
    if significant.len() > 20 || (significant.len() == 20 && significant > "18446744073709551615") {
        return Err(path_error("Expected a value less than or equal to 18446744073709551615n", name));
    }
    if significant.is_empty() { Ok(0) } else { significant.parse().map_err(|_| path_error("Invalid u64", name)) }
}
${
  ranges
    ? String.raw`fn u64_range_arg(value: &Value, name: Option<&str>, minimum: u64, maximum: u64) -> Result<u64, String> {
    let decoded = u64_arg(value, name)?;
    if decoded < minimum {
        return Err(path_error(&format!("Expected a value greater than or equal to {}n", minimum), name));
    }
    if decoded > maximum {
        return Err(path_error(&format!("Expected a value less than or equal to {}n", maximum), name));
    }
    Ok(decoded)
}`
    : ""
}
fn bool_arg(value: &Value, name: Option<&str>) -> Result<bool, String> {
    value.as_bool().ok_or_else(|| path_error("Expected boolean", name))
}
fn unit_arg(value: &Value, name: Option<&str>) -> Result<(), String> {
    if value.is_null() { Ok(()) } else { Err(path_error("Expected null", name)) }
}
struct RequestContext<'a> { id: &'a Value, tag: &'a str, principal: Option<u64> }
${asynchronous ? "async " : ""}fn request(message: &Value, headers: &HeaderMap, state: &RuntimeState${asynchronous ? ", cancellation: &tokio::sync::watch::Receiver<bool>" : ""}) -> Value {
    let Some(object) = message.as_object() else { return invalid("Expected Request object") };
    let Some(id) = object.get("id").filter(|v| v.is_string() || v.is_number()) else { return invalid("Invalid request id") };
    let Some(tag) = object.get("tag").and_then(Value::as_str) else { return invalid("Invalid request tag") };
    let Some(payload) = object.get("payload") else { return invalid("Missing payload") };
    let valid_headers = object.get("headers").and_then(Value::as_array).map(|headers| headers.iter().all(|h|
        h.as_array().map(|pair| pair.len() == 2 && pair.iter().all(Value::is_string)).unwrap_or(false)
    )).unwrap_or(false);
    if object.get("_tag").and_then(Value::as_str) != Some("Request") || !valid_headers {
        return invalid("Invalid Request envelope");
    }
    if object.contains_key("isNotification") { return invalid("Notifications are unsupported") }
    for name in ["traceId", "spanId"] {
        if object.get(name).map(|v| !v.is_string()).unwrap_or(false) { return invalid("Invalid trace context") }
    }
    if object.get("sampled").map(|v| !v.is_boolean()).unwrap_or(false) { return invalid("Invalid trace context") }
    // TLS cleanup applies to synchronous calls; suspended handlers own their diagnostic state.
    ${frameCleanup?.text ?? ""}
    let mut context = RequestContext { id, tag, principal: None };
    let result = dispatch(tag, payload, headers, message, state, &mut context${asynchronous ? ", cancellation).await" : ")"};
    ${frameCleanup?.text ?? ""}
    match result { Ok(value) => exit(id, value), Err(error) => die(id, error) }
}
fn same_id(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) { (Some(a), Some(b)) => a == b, _ => a == b }
}
${
  asynchronous
    ? asyncHttpRuntime
    : String.raw`async fn rpc(State(state): State<RuntimeState>, headers: HeaderMap, body: Bytes) -> (StatusCode, Json<Value>) {
    let messages: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return (StatusCode::OK, Json(json!([{"_tag":"Defect", "defect":{"name":"SyntaxError", "message":"Invalid JSON"}}]))),
    };
    let responses = if let Some(batch) = messages.as_array() {
        if batch.len() > MAX_BATCH { return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!([invalid("Batch limit exceeded")]))); }
        let mut ids: Vec<&Value> = Vec::with_capacity(batch.len());
        for message in batch {
            if let Some(id) = message.get("id") {
                if ids.iter().any(|prior| same_id(prior, id)) {
                    return (StatusCode::OK, Json(json!([invalid("Duplicate request id")])));
                }
                ids.push(id);
            }
        }
        batch.iter().map(|message| request(message, &headers, &state)).collect::<Vec<_>>()
    } else { vec![request(&messages, &headers, &state)] };
    (StatusCode::OK, Json(Value::Array(responses)))
}
`
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mut address = "127.0.0.1".to_string();
    let mut port: u16 = 3000;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => port = args.next().ok_or("missing port")?.parse()?,
            "--host" => address = args.next().ok_or("missing host")?,
            _ => return Err("unknown server argument".into()),
        }
    }
    let state = load_state()?;
    let listener = tokio::net::TcpListener::bind((address.as_str(), port)).await?;
    let address = listener.local_addr()?;
    let mut app = Router::new().route(RPC_PATH, post(rpc));
    if RPC_PATH != "/" { app = app.route(&format!("{}/", RPC_PATH), post(rpc)); }
    let app = app.layer(DefaultBodyLimit::max(MAX_BODY)).with_state(state);
    println!("{}", json!({"schema":"reffect.rpc.ready@1", "address":address.to_string()}));
    axum::serve(listener, app).await?;
    Ok(())
}
`;

/** A pending response owns cancellation; its worker is never aborted on body drop. */
const asyncHttpRuntime = String.raw`
use axum::response::{Response, IntoResponse};
use std::{pin::Pin, task::{Context, Poll}, future::Future};
struct PendingResponse {
    response: tokio::sync::oneshot::Receiver<Value>,
    cancellation: Option<tokio::sync::watch::Sender<bool>>,
}
impl http_body::Body for PendingResponse {
    type Data = Bytes;
    type Error = std::convert::Infallible;
    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<http_body::Frame<Bytes>, Self::Error>>> {
        if self.cancellation.is_none() { return Poll::Ready(None); }
        match Pin::new(&mut self.response).poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(result) => {
                self.cancellation.take();
                let value = result.unwrap_or_else(|_| json!([invalid("Handler worker failed")]));
                Poll::Ready(Some(Ok(http_body::Frame::data(Bytes::from(value.to_string())))))
            }
        }
    }
}
impl Drop for PendingResponse {
    fn drop(&mut self) {
        if let Some(cancellation) = self.cancellation.take() { let _ = cancellation.send(true); }
    }
}
async fn rpc(State(state): State<RuntimeState>, headers: HeaderMap, body: Bytes) -> Response {
    let messages: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return (StatusCode::OK, Json(json!([{"_tag":"Defect", "defect":{"name":"SyntaxError", "message":"Invalid JSON"}}]))).into_response(),
    };
    if let Some(batch) = messages.as_array() {
        if batch.len() > MAX_BATCH { return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!([invalid("Batch limit exceeded")]))).into_response(); }
        let mut ids: Vec<&Value> = Vec::with_capacity(batch.len());
        for message in batch {
            if let Some(id) = message.get("id") {
                if ids.iter().any(|prior| same_id(prior, id)) {
                    return (StatusCode::OK, Json(json!([invalid("Duplicate request id")]))).into_response();
                }
                ids.push(id);
            }
        }
    }
    let (cancellation, receiver) = tokio::sync::watch::channel(false);
    let (sender, response) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let mut responses = Vec::new();
        if let Some(batch) = messages.as_array() {
            for message in batch {
                if *receiver.borrow() || receiver.has_changed().is_err() { break; }
                responses.push(request(message, &headers, &state, &receiver).await);
            }
        } else {
            responses.push(request(&messages, &headers, &state, &receiver).await);
        }
        let _ = sender.send(Value::Array(responses));
    });
    let mut response = Response::new(axum::body::Body::new(PendingResponse { response, cancellation: Some(cancellation) }));
    response.headers_mut().insert(axum::http::header::CONTENT_TYPE, axum::http::HeaderValue::from_static("application/json"));
    response
}
`;
