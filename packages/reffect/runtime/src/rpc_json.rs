// The JSON and NDJSON bodies (`RpcSerialization.layerJson`/`layerNdjson`, STREAM-001).
/// The request body's messages, or the answer to a body that has none.
// The Err is the early HTTP answer itself, built once on a cold path.
#[allow(clippy::result_large_err)]
fn read_body(body: &[u8]) -> Result<(Vec<Value>, bool), Response> {
    read_body_as(body, NDJSON)
}
/// The body as the official server's `request.text` reads it: UTF-8 with each invalid sequence
/// replaced by U+FFFD and a leading byte order mark removed (#27).
fn body_text(body: &[u8]) -> std::borrow::Cow<'_, str> {
    String::from_utf8_lossy(body.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(body))
}
#[allow(clippy::result_large_err)]
fn read_body_as(body: &[u8], ndjson: bool) -> Result<(Vec<Value>, bool), Response> {
    let text = body_text(body);
    if !ndjson {
        return match serde_json::from_str::<Value>(&text) {
            Ok(Value::Array(batch)) => Ok((batch, true)),
            Ok(value) => Ok((vec![value], false)),
            Err(_) => Err(write_body(
                StatusCode::OK,
                vec![
                    json!({"_tag":"Defect", "defect":{"name":"SyntaxError", "message":"Invalid JSON"}}),
                ],
            )),
        };
    }
    // As RpcSerialization.ndjson: a line that does not parse is skipped, and text after the last
    // newline waits for more input that never comes.
    let mut messages = Vec::new();
    let mut rest: &str = &text;
    while let Some(end) = rest.find('\n') {
        if let Ok(message) = serde_json::from_str::<Value>(&rest[..end]) {
            messages.push(message);
        }
        rest = &rest[end + 1..];
    }
    // The official server answers a body without messages with an empty 500.
    if messages.is_empty() {
        return Err(StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    Ok((messages, true))
}
const CONTENT_TYPE: &str = if NDJSON {
    "application/ndjson"
} else {
    "application/json"
};
/// A streamed chunk's message.
fn chunk_message(id: &Value, _tag: &str, values: Vec<Value>) -> Value {
    json!({"_tag":"Chunk", "requestId":id, "values":values})
}
/// Whether each message is written as it is ready (NDJSON), or the body once at the end.
const FRAMED: bool = NDJSON;
/// One message as a framed serialization writes it.
fn encode_one(response: &Value) -> Vec<u8> {
    format!("{}\n", response).into_bytes()
}
/// Responses as the configured serialization writes them: a JSON array, or one line each.
fn encode_body(responses: Vec<Value>) -> Vec<u8> {
    if NDJSON {
        responses.iter().flat_map(encode_one).collect()
    } else {
        Value::Array(responses).to_string().into_bytes()
    }
}
fn write_body(status: StatusCode, responses: Vec<Value>) -> Response {
    let mut response = (status, encode_body(responses)).into_response();
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static(CONTENT_TYPE),
    );
    response
}
/// NDJSON hands a line that is not a request object to the server as an unknown request.
fn unframed(message: &Value) -> Option<Value> {
    (NDJSON && !message.is_object())
        .then(|| json!({"_tag":"Defect", "defect":"Unknown request tag: undefined"}))
}

/// What one WebSocket frame holds: its messages, the defect answering it, or a close code.
#[allow(dead_code)]
enum Feed {
    Messages(Vec<Value>),
    Defect(Value),
    Close(u16),
}
/// The official socket server's NDJSON line limit (`MaxBufferSizeExceeded`, close 1009).
#[allow(dead_code)]
const SOCKET_LINE_LIMIT: usize = 16 * 1024 * 1024;
/// A WebSocket session's parser: JSON reads each frame whole (an object or an array of
/// messages); NDJSON keeps an unfinished line across frames, as `RpcSerialization` does.
#[derive(Default)]
#[allow(dead_code)]
struct SocketParser {
    pending: Vec<u8>,
}
#[allow(dead_code)]
impl SocketParser {
    fn feed(&mut self, frame: &[u8]) -> Feed {
        if !NDJSON {
            return match serde_json::from_str::<Value>(&body_text(frame)) {
                Ok(Value::Array(messages)) => Feed::Messages(messages),
                Ok(message) => Feed::Messages(vec![message]),
                Err(_) => Feed::Defect(
                    json!({"_tag":"Defect", "defect":{"name":"SyntaxError", "message":"Invalid JSON"}}),
                ),
            };
        }
        self.pending.extend_from_slice(frame);
        let mut messages = Vec::new();
        while let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            // As RpcSerialization.ndjson: a line that does not parse is skipped.
            if let Ok(message) = serde_json::from_slice::<Value>(&line[..line.len() - 1]) {
                messages.push(message);
            }
        }
        if self.pending.len() > SOCKET_LINE_LIMIT {
            return Feed::Close(1009);
        }
        Feed::Messages(messages)
    }
}
/// JSON and NDJSON answer in text frames.
#[allow(dead_code)]
const BINARY_FRAMES: bool = false;
/// One answer as its own frame: JSON text, or one NDJSON line.
#[allow(dead_code)]
fn socket_frame(response: &Value) -> Vec<u8> {
    if NDJSON {
        encode_one(response)
    } else {
        response.to_string().into_bytes()
    }
}
