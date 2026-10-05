import type { RsStmt } from "./rust-emit.ts";
import { RuntimeSources } from "./runtime-sources.generated.ts";

/**
 * The scalar JSON argument decoders with the official messages: the server's request decoding
 * and the library's `reffect_json` decoders (RS-007) share this text.
 */
export const decodeArgs = (): string => RuntimeSources.rpc_args;

/**
 * The HTTP server around the generated dispatch. Its static items live in `runtime/src/rpc_*.rs`
 * (#37); what stays here varies by server: the request context and handler for synchronous or
 * asynchronous procedures, the layered shutdown forwarder, and the routes and main.
 */
export const rpcRuntime = (
  frameCleanup?: RsStmt,
  asynchronous = false,
  layered = false,
  ndjson = false,
  pages = false,
  boot?: string,
  session = false,
): string => String.raw`
use axum::{body::Bytes, extract::{DefaultBodyLimit, State}, http::{StatusCode, HeaderMap}, routing::post, Json, Router};
use axum::response::{Response, IntoResponse};
use serde_json::{json, Value};

/// The configured RpcSerialization (STREAM-001): \`layerJson\` reads one value, an array being a
/// batch; \`layerNdjson\` reads one message per complete line.
const NDJSON: bool = ${ndjson};
${RuntimeSources.rpc_wire}${RuntimeSources.rpc_json}
${decodeArgs()}${
  asynchronous
    ? String.raw`${RuntimeSources.rpc_stream}
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
${
  asynchronous
    ? asyncHttpRuntime(layered)
    : String.raw`async fn rpc(State(state): State<RuntimeState>, headers: HeaderMap, incoming: axum::extract::Request) -> Response {
    // The body is read by axum's own extractor (so an oversized body keeps its 413) within a
    // time limit: a stalled body is answered 408 rather than held forever (#16).
    let body = match tokio::time::timeout(std::time::Duration::from_millis(BODY_TIMEOUT_MS), <Bytes as axum::extract::FromRequest<()>>::from_request(incoming, &())).await {
        Ok(Ok(body)) => body,
        Ok(Err(rejection)) => return rejection.into_response(),
        Err(_) => return StatusCode::REQUEST_TIMEOUT.into_response(),
    };
    let (batch, batched) = match read_body(&body) { Ok(messages) => messages, Err(response) => return response };
    if batched { if let Some(refused) = validate_batch(&batch) { return refused; } }
    let responses = batch.iter().map(|message| unframed(message).unwrap_or_else(|| request(message, &headers, &state))).collect::<Vec<_>>();
    write_body(StatusCode::OK, responses)
}
`
}
${serveRuntime}
${layered ? layeredMain(pages, boot, session) : plainMain(pages, boot, session)}`;

/** The RPC routes, and pages for every path and method they do not take (SSR-007). */
const routes = (pages: boolean, session: boolean): string =>
  `let mut app = Router::new().route(RPC_PATH, post(rpc));
    if RPC_PATH != "/" { app = app.route(&format!("{}/", RPC_PATH), post(rpc)); }${
      // Session login and logout (#4) beside the page host.
      session
        ? "\n    let app = app.route(SESSION_PATH, post(session_login).delete(session_logout));"
        : ""
    }${pages ? "\n    let app = app.fallback(ssr_page);" : ""}`;

/**
 * The accept loop both mains use (#16, docs/research/rpc-serving.md): axum::serve sets no hyper
 * timer, so headers were never timed out and connections were unbounded. Graceful shutdown
 * stops accepting, then lets each connection finish its in-flight responses.
 */
const serveRuntime = RuntimeSources.rpc_serve;

const plainMain = (
  pages: boolean,
  boot?: string,
  session = false,
): string => String.raw`#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = server_args(false)?;
    let state = load_state()?;
    ${boot === undefined ? "" : `${boot}?;`}
    ${routes(pages, session)}
    let app = app.layer(DefaultBodyLimit::max(MAX_BODY)).with_state(state);
    let listener = bind(&args).await?;
    serve(listener, app, std::future::pending()).await?;
    Ok(())
}
`;

/** Server shutdown also cancels each in-flight request; the forwarder ends with the request. */
const shutdownForwarder = String.raw`    {
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
const layeredMain = (
  pages: boolean,
  boot?: string,
  session = false,
): string => String.raw`static SERVICES: std::sync::OnceLock<reffect_generated::LaunchValues> = std::sync::OnceLock::new();
static SHUTDOWN: std::sync::OnceLock<tokio::sync::watch::Receiver<bool>> = std::sync::OnceLock::new();
#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = server_args(true)?;
    let stdin_shutdown = args.stdin_shutdown;
    let state = load_state()?;
    ${boot === undefined ? "" : `${boot}?;`}
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
    ${routes(pages, session)}
    let app = app.layer(DefaultBodyLimit::max(MAX_BODY)).with_state(state);
    let listener = bind(&args).await?;
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
    serve(listener, app, signal).await?;
    let _ = stop_launch.send(true);
    let _ = launch.await;
    Ok(())
}
`;

/** A pending response owns cancellation; its worker is never aborted on body drop. */
const asyncHttpRuntime = (layered: boolean): string => String.raw`
use std::{pin::Pin, task::{Context, Poll}};
async fn rpc(State(state): State<RuntimeState>, headers: HeaderMap, incoming: axum::extract::Request) -> Response {
    // The body is read by axum's own extractor (so an oversized body keeps its 413) within a
    // time limit: a stalled body is answered 408 rather than held forever (#16).
    let body = match tokio::time::timeout(std::time::Duration::from_millis(BODY_TIMEOUT_MS), <Bytes as axum::extract::FromRequest<()>>::from_request(incoming, &())).await {
        Ok(Ok(body)) => body,
        Ok(Err(rejection)) => return rejection.into_response(),
        Err(_) => return StatusCode::REQUEST_TIMEOUT.into_response(),
    };
    let (batch, batched) = match read_body(&body) { Ok(messages) => messages, Err(response) => return response };
    if batched { if let Some(refused) = validate_batch(&batch) { return refused; } }
    let (cancellation, receiver) = tokio::sync::watch::channel(false);
    let cancellation = std::sync::Arc::new(cancellation);
${layered ? shutdownForwarder : ""}    // The official server buffers 16 messages between its handlers and the body (STREAM-002).
    let (out, lines) = tokio::sync::mpsc::channel::<Outgoing>(16);
    tokio::spawn(async move {
        // The requests run concurrently and each answers when it finishes, as the official
        // server's fibers do (#25). They share this task, first polled in request order, so each
        // runs until it suspends before the next starts, as forked fibers do on one thread; a
        // stream no longer holds back the requests after it.
        let mut running = futures_util::stream::FuturesUnordered::new();
        for message in &batch {
            if *receiver.borrow() || receiver.has_changed().is_err() { break; }
            let (headers, state, receiver, out) = (&headers, &state, &receiver, &out);
            running.push(async move {
                let response = match unframed(message) {
                    Some(defect) => defect,
                    None => request(message, headers, state, receiver, out).await,
                };
                let _ = out.send(Outgoing::Message(response)).await;
            });
        }
        while futures_util::StreamExt::next(&mut running).await.is_some() {}
        let _ = out.send(Outgoing::Done).await;
    });
    let mut response = Response::new(axum::body::Body::new(PendingResponse { lines, buffered: Vec::new(), cancellation: Some(cancellation) }));
    response.headers_mut().insert(axum::http::header::CONTENT_TYPE, axum::http::HeaderValue::from_static(CONTENT_TYPE));
    response
}
`;
