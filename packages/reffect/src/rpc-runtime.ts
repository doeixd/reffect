import type { RsStmt } from "./rust-emit.ts";

/**
 * The scalar JSON argument decoders with the official messages: the server's request decoding
 * and the library's `reffect_json` decoders (RS-007) share this text.
 */
export const decodeArgs = (ranges: boolean): string => String.raw`
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
fn string_arg(value: &Value, name: Option<&str>) -> Result<String, String> {
    // serde_json strings are always well-formed, so StringJson's check cannot fail here.
    value.as_str().map(str::to_owned).ok_or_else(|| path_error("Expected string", name))
}
fn bool_arg(value: &Value, name: Option<&str>) -> Result<bool, String> {
    value.as_bool().ok_or_else(|| path_error("Expected boolean", name))
}
fn unit_arg(value: &Value, name: Option<&str>) -> Result<(), String> {
    if value.is_null() { Ok(()) } else { Err(path_error("Expected null", name)) }
}
`;

/** Audited HTTP substrate; dynamic tags/fields/calls are emitted separately through Rs. */
export const rpcRuntime = (
  frameCleanup?: RsStmt,
  asynchronous = false,
  ranges = false,
  layered = false,
  ndjson = false,
): string => String.raw`
use axum::{body::Bytes, extract::{DefaultBodyLimit, State}, http::{StatusCode, HeaderMap}, routing::post, Json, Router};
use axum::response::{Response, IntoResponse};
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
/// The configured RpcSerialization (STREAM-001): \`layerJson\` reads one value, an array being a
/// batch; \`layerNdjson\` reads one message per complete line.
const NDJSON: bool = ${ndjson};
/// The request body's messages, or the answer to a body that has none.
fn read_body(body: &[u8]) -> Result<(Vec<Value>, bool), Response> {
    if !NDJSON {
        return match serde_json::from_slice::<Value>(body) {
            Ok(Value::Array(batch)) => Ok((batch, true)),
            Ok(value) => Ok((vec![value], false)),
            Err(_) => Err(write_body(StatusCode::OK, vec![json!({"_tag":"Defect", "defect":{"name":"SyntaxError", "message":"Invalid JSON"}})])),
        };
    }
    // As RpcSerialization.ndjson: a line that does not parse is skipped, and text after the last
    // newline waits for more input that never comes.
    let text = String::from_utf8_lossy(body);
    let mut messages = Vec::new();
    let mut rest: &str = &text;
    while let Some(end) = rest.find('\n') {
        if let Ok(message) = serde_json::from_str::<Value>(&rest[..end]) { messages.push(message); }
        rest = &rest[end + 1..];
    }
    // The official server answers a body without messages with an empty 500.
    if messages.is_empty() { return Err(StatusCode::INTERNAL_SERVER_ERROR.into_response()); }
    Ok((messages, true))
}
const CONTENT_TYPE: &str = if NDJSON { "application/ndjson" } else { "application/json" };
/// Responses as the configured serialization writes them: a JSON array, or one line each.
fn encode_body(responses: Vec<Value>) -> String {
    if NDJSON { responses.iter().map(|response| format!("{}\n", response)).collect() } else { Value::Array(responses).to_string() }
}
fn write_body(status: StatusCode, responses: Vec<Value>) -> Response {
    let mut response = (status, encode_body(responses)).into_response();
    response.headers_mut().insert(axum::http::header::CONTENT_TYPE, axum::http::HeaderValue::from_static(CONTENT_TYPE));
    response
}
/// NDJSON hands a line that is not a request object to the server as an unknown request.
fn unframed(message: &Value) -> Option<Value> {
    (NDJSON && !message.is_object()).then(|| json!({"_tag":"Defect", "defect":"Unknown request tag: undefined"}))
}
fn field<'a>(payload: &'a Value, name: &str) -> Result<&'a Value, String> {
    payload.as_object().and_then(|o| o.get(name)).ok_or_else(|| path_error("Missing key", Some(name)))
}
${decodeArgs(ranges)}${
  asynchronous
    ? String.raw`/// What a body's worker sends: each message as it is ready, then Done (STREAM-002).
enum Outgoing { Message(Value), Done }
type Out = tokio::sync::mpsc::Sender<Outgoing>;
struct RequestContext<'a> { id: &'a Value, tag: &'a str, principal: Option<u64>, out: &'a Out }`
    : "struct RequestContext<'a> { id: &'a Value, tag: &'a str, principal: Option<u64> }"
}
${asynchronous ? "async " : ""}fn request(message: &Value, headers: &HeaderMap, state: &RuntimeState${asynchronous ? ", cancellation: &tokio::sync::watch::Receiver<bool>, out: &Out" : ""}) -> Value {
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
    let mut context = RequestContext { id, tag, principal: None${asynchronous ? ", out" : ""} };
    let result = dispatch(tag, payload, headers, message, state, &mut context${asynchronous ? ", cancellation).await" : ")"};
    ${frameCleanup?.text ?? ""}
    match result { Ok(value) => exit(id, value), Err(error) => die(id, error) }
}
fn same_id(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) { (Some(a), Some(b)) => a == b, _ => a == b }
}
${
  asynchronous
    ? layered
      ? asyncHttpRuntime
          .replace(
            "cancellation: Option<tokio::sync::watch::Sender<bool>>,",
            "cancellation: Option<std::sync::Arc<tokio::sync::watch::Sender<bool>>>,",
          )
          .replace(
            "    // The official server buffers 16 messages between its handlers and the body (STREAM-002).",
            shutdownForwarder +
              "    // The official server buffers 16 messages between its handlers and the body (STREAM-002).",
          )
      : asyncHttpRuntime
    : String.raw`async fn rpc(State(state): State<RuntimeState>, headers: HeaderMap, body: Bytes) -> Response {
    let (batch, batched) = match read_body(&body) { Ok(messages) => messages, Err(response) => return response };
    if batched {
        if batch.len() > MAX_BATCH { return write_body(StatusCode::PAYLOAD_TOO_LARGE, vec![invalid("Batch limit exceeded")]); }
        let mut ids: Vec<&Value> = Vec::with_capacity(batch.len());
        for message in &batch {
            if let Some(id) = message.get("id") {
                if ids.iter().any(|prior| same_id(prior, id)) {
                    return write_body(StatusCode::OK, vec![invalid("Duplicate request id")]);
                }
                ids.push(id);
            }
        }
    }
    let responses = batch.iter().map(|message| unframed(message).unwrap_or_else(|| request(message, &headers, &state))).collect::<Vec<_>>();
    write_body(StatusCode::OK, responses)
}
`
}
${layered ? layeredMain : plainMain}`;

const plainMain = String.raw`#[tokio::main(flavor = "current_thread")]
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
    // Like Node's HTTP server, disable Nagle: delayed ACKs otherwise stall multi-segment responses.
    let listener = axum::serve::ListenerExt::tap_io(listener, |stream: &mut tokio::net::TcpStream| { let _ = stream.set_nodelay(true); });
    axum::serve(listener, app).await?;
    Ok(())
}
`;

/** Server shutdown also cancels each in-flight request; the forwarder ends with the request. */
const shutdownForwarder = String.raw`    let cancellation = std::sync::Arc::new(cancellation);
    {
        let forward = cancellation.clone();
        let mut shutdown = SHUTDOWN.get().expect("shutdown is installed before serving").clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = shutdown.wait_for(|stop| *stop) => { let _ = forward.send(true); }
                _ = forward.closed() => {}
            }
        });
    }
`;

/**
 * Server-lifetime services: the launch future acquires once and publishes scalar values before
 * the listener binds. Shutdown interrupts and awaits in-flight requests (axum graceful shutdown
 * waits for their responses), then cancels the launch so its Scope releases in LIFO order.
 */
const layeredMain = String.raw`static SERVICES: std::sync::OnceLock<reffect_generated::LaunchValues> = std::sync::OnceLock::new();
static SHUTDOWN: std::sync::OnceLock<tokio::sync::watch::Receiver<bool>> = std::sync::OnceLock::new();
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mut address = "127.0.0.1".to_string();
    let mut port: u16 = 3000;
    let mut stdin_shutdown = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => port = args.next().ok_or("missing port")?.parse()?,
            "--host" => address = args.next().ok_or("missing host")?,
            "--shutdown-on-stdin-eof" => stdin_shutdown = true,
            _ => return Err("unknown server argument".into()),
        }
    }
    let state = load_state()?;
    let (stop_launch, launch_cancellation) = tokio::sync::watch::channel(false);
    let (publish, published) = tokio::sync::oneshot::channel();
    let launch = tokio::spawn(async move {
        let mut ctx = reffect_generated::AsyncContext::new(launch_cancellation);
        ctx.set_launch(publish);
        let _ = reffect_generated::r_launch(&mut ctx).await;
    });
    let Ok(services) = published.await else {
        // Acquisition failed; the launch task has already awaited its LIFO cleanup.
        let _ = launch.await;
        eprintln!("{}", json!({"schema":"reffect.rpc.startup@1", "outcome":"failure"}));
        std::process::exit(1);
    };
    let _ = SERVICES.set(services);
    let (shutdown, shutdown_receiver) = tokio::sync::watch::channel(false);
    let _ = SHUTDOWN.set(shutdown_receiver);
    let listener = tokio::net::TcpListener::bind((address.as_str(), port)).await?;
    let address = listener.local_addr()?;
    let mut app = Router::new().route(RPC_PATH, post(rpc));
    if RPC_PATH != "/" { app = app.route(&format!("{}/", RPC_PATH), post(rpc)); }
    let app = app.layer(DefaultBodyLimit::max(MAX_BODY)).with_state(state);
    println!("{}", json!({"schema":"reffect.rpc.ready@1", "address":address.to_string()}));
    let signal = async move {
        let stdin_eof = async {
            if !stdin_shutdown { return std::future::pending::<()>().await; }
            let (eof, closed) = tokio::sync::oneshot::channel();
            std::thread::spawn(move || {
                let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
                let _ = eof.send(());
            });
            let _ = closed.await;
        };
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = stdin_eof => {} }
        let _ = shutdown.send(true);
    };
    let listener = axum::serve::ListenerExt::tap_io(listener, |stream: &mut tokio::net::TcpStream| { let _ = stream.set_nodelay(true); });
    axum::serve(listener, app).with_graceful_shutdown(signal).await?;
    let _ = stop_launch.send(true);
    let _ = launch.await;
    Ok(())
}
`;

/** A pending response owns cancellation; its worker is never aborted on body drop. */
const asyncHttpRuntime = String.raw`
use std::{pin::Pin, task::{Context, Poll}};
/// The response body: NDJSON forwards each message as it arrives; JSON writes the array once the
/// worker is done. Dropping it cancels the worker's requests (STREAM-003).
struct PendingResponse {
    lines: tokio::sync::mpsc::Receiver<Outgoing>,
    buffered: Vec<Value>,
    cancellation: Option<tokio::sync::watch::Sender<bool>>,
}
impl http_body::Body for PendingResponse {
    type Data = Bytes;
    type Error = std::convert::Infallible;
    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<http_body::Frame<Bytes>, Self::Error>>> {
        if self.cancellation.is_none() { return Poll::Ready(None); }
        loop {
            match self.lines.poll_recv(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Some(Outgoing::Message(value))) => {
                    if NDJSON { return Poll::Ready(Some(Ok(http_body::Frame::data(Bytes::from(format!("{}\n", value)))))); }
                    self.buffered.push(value);
                }
                Poll::Ready(done) => {
                    self.cancellation.take();
                    // A worker that stops before Done failed.
                    let finished = matches!(done, Some(Outgoing::Done));
                    if NDJSON {
                        return if finished { Poll::Ready(None) } else { Poll::Ready(Some(Ok(http_body::Frame::data(Bytes::from(encode_body(vec![invalid("Handler worker failed")])))))) };
                    }
                    let values = if finished { std::mem::take(&mut self.buffered) } else { vec![invalid("Handler worker failed")] };
                    return Poll::Ready(Some(Ok(http_body::Frame::data(Bytes::from(encode_body(values))))));
                }
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
    let (batch, batched) = match read_body(&body) { Ok(messages) => messages, Err(response) => return response };
    if batched {
        if batch.len() > MAX_BATCH { return write_body(StatusCode::PAYLOAD_TOO_LARGE, vec![invalid("Batch limit exceeded")]); }
        let mut ids: Vec<&Value> = Vec::with_capacity(batch.len());
        for message in &batch {
            if let Some(id) = message.get("id") {
                if ids.iter().any(|prior| same_id(prior, id)) {
                    return write_body(StatusCode::OK, vec![invalid("Duplicate request id")]);
                }
                ids.push(id);
            }
        }
    }
    let (cancellation, receiver) = tokio::sync::watch::channel(false);
    // The official server buffers 16 messages between its handlers and the body (STREAM-002).
    let (out, lines) = tokio::sync::mpsc::channel::<Outgoing>(16);
    tokio::spawn(async move {
        for message in &batch {
            if *receiver.borrow() || receiver.has_changed().is_err() { break; }
            let response = match unframed(message) {
                Some(defect) => defect,
                None => request(message, &headers, &state, &receiver, &out).await,
            };
            if out.send(Outgoing::Message(response)).await.is_err() { return; }
        }
        let _ = out.send(Outgoing::Done).await;
    });
    let mut response = Response::new(axum::body::Body::new(PendingResponse { lines, buffered: Vec::new(), cancellation: Some(cancellation) }));
    response.headers_mut().insert(axum::http::header::CONTENT_TYPE, axum::http::HeaderValue::from_static(CONTENT_TYPE));
    response
}
`;
