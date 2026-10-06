// Effect RPC over WebSocket (docs/research/websocket-rpc.md, WS-003): one session per socket, as
// `RpcServer.layerProtocolWebsocket` serves it. Frames are parsed by the serialization's
// `SocketParser` into the same JSON-shaped envelopes the HTTP server serves; each request runs as
// its own future with its own cancellation and Ack gate, and each answer is its own frame. The
// upgrade's headers stand where an HTTP request's would, before each message's own (WS-006).

/// The upgrade at the RPC path.
async fn rpc_socket(
    State(state): State<RuntimeState>,
    headers: HeaderMap,
    upgrade: axum::extract::ws::WebSocketUpgrade,
) -> Response {
    upgrade.on_upgrade(move |socket| session(socket, state, headers))
}
/// A request id as a session key: numbers by value, as `same_id` compares them, and strings apart
/// from numbers.
fn id_key(id: &Value) -> Option<String> {
    match id {
        Value::String(text) => Some(format!("s{text}")),
        Value::Number(number) => number.as_f64().map(|x| format!("n{x}")),
        _ => None,
    }
}
/// A request in flight on a session: what interrupts it, and what its stream's Ack releases.
struct Running {
    cancel: tokio::sync::watch::Sender<bool>,
    acks: std::sync::Arc<tokio::sync::Notify>,
}
fn socket_message(response: &Value) -> axum::extract::ws::Message {
    let bytes = socket_frame(response);
    if BINARY_FRAMES {
        axum::extract::ws::Message::Binary(bytes.into())
    } else {
        axum::extract::ws::Message::Text(String::from_utf8_lossy(&bytes).into_owned().into())
    }
}
async fn session(
    mut socket: axum::extract::ws::WebSocket,
    state: RuntimeState,
    headers: HeaderMap,
) {
    use axum::extract::ws::Message as Frame;
    use futures_util::StreamExt;
    let (state, headers) = (&state, &headers);
    // Requests answer through this channel; the loop below writes each answer as a frame.
    let (messages, mut outgoing) = tokio::sync::mpsc::channel::<Outgoing>(16);
    let mut parser = SocketParser::default();
    let mut running: std::collections::HashMap<String, Running> = std::collections::HashMap::new();
    let mut tasks = futures_util::stream::FuturesUnordered::new();
    let mut close: Option<u16> = None;
    'session: loop {
        tokio::select! {
            frame = socket.recv() => {
                let bytes: Vec<u8> = match frame {
                    Some(Ok(Frame::Text(text))) => text.as_bytes().to_vec(),
                    Some(Ok(Frame::Binary(bytes))) => bytes.to_vec(),
                    // WebSocket pings are answered by the socket itself; a close ends the session.
                    Some(Ok(Frame::Ping(_) | Frame::Pong(_))) => continue,
                    // The socket answers the close itself, flushed by the next read, which then ends.
                    Some(Ok(Frame::Close(_))) => continue,
                    _ => break 'session,
                };
                let incoming = match parser.feed(&bytes) {
                    Feed::Messages(incoming) => incoming,
                    Feed::Defect(defect) => {
                        if socket.send(socket_message(&defect)).await.is_err() { break 'session; }
                        continue;
                    }
                    Feed::Close(code) => { close = Some(code); break 'session; }
                };
                for message in incoming {
                    let request_id = message.get("requestId").and_then(id_key);
                    match message.get("_tag").and_then(Value::as_str) {
                        Some("Ping") => {
                            if socket.send(socket_message(&json!({"_tag":"Pong"}))).await.is_err() {
                                break 'session;
                            }
                        }
                        Some("Ack") => {
                            if let Some(entry) = request_id.and_then(|key| running.get(&key)) {
                                entry.acks.notify_one();
                            }
                        }
                        // An unknown id is ignored; a running request answers its interruption.
                        Some("Interrupt") => {
                            if let Some(entry) = request_id.and_then(|key| running.get(&key)) {
                                let _ = entry.cancel.send(true);
                            }
                        }
                        Some("Eof") => {}
                        _ => {
                            let key = message.get("id").and_then(id_key);
                            // A request reusing an in-flight id ends the session, as officially.
                            if key.as_ref().is_some_and(|key| running.contains_key(key)) {
                                close = Some(1001);
                                break 'session;
                            }
                            let (cancel, cancellation) = tokio::sync::watch::channel(false);
                            let acks = std::sync::Arc::new(tokio::sync::Notify::new());
                            let out = Out { messages: messages.clone(), acks: Some(acks.clone()) };
                            if let Some(key) = &key {
                                running.insert(key.clone(), Running { cancel, acks });
                            }
                            tasks.push(async move {
                                let response = request(&message, headers, state, &cancellation, &out).await;
                                let _ = out.send(Outgoing::Message(response)).await;
                                key
                            });
                        }
                    }
                }
            }
            Some(answer) = outgoing.recv() => {
                if let Outgoing::Message(response) = answer {
                    if socket.send(socket_message(&response)).await.is_err() { break 'session; }
                }
            }
            Some(finished) = tasks.next(), if !tasks.is_empty() => {
                if let Some(key) = finished { running.remove(&key); }
            }
        }
    }
    // The session ends: every request in flight is interrupted, its finalizers run, and nothing
    // more is sent for it.
    for entry in running.values() {
        let _ = entry.cancel.send(true);
    }
    while !tasks.is_empty() {
        tokio::select! {
            _ = tasks.next() => {}
            _ = outgoing.recv() => {}
        }
    }
    if let Some(code) = close {
        let _ = socket
            .send(Frame::Close(Some(axum::extract::ws::CloseFrame {
                code,
                reason: "".into(),
            })))
            .await;
    }
}
