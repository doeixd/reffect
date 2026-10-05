fn success(value: Value) -> Value {
    json!({"_tag":"Success", "value":value})
}
fn failure(error: Value) -> Value {
    json!({"_tag":"Failure", "cause":[{"_tag":"Fail", "error":error}]})
}
fn exit(id: &Value, value: Value) -> Value {
    json!({"_tag":"Exit", "requestId":id, "exit":value})
}
fn die(id: &Value, message: String) -> Value {
    exit(
        id,
        json!({"_tag":"Failure", "cause":[{"_tag":"Die", "defect":message}]}),
    )
}
fn invalid(message: &str) -> Value {
    json!({"_tag":"Defect", "defect":{"name":"ProtocolError", "message":message}})
}
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
/// Responses as the configured serialization writes them: a JSON array, or one line each.
fn encode_body(responses: Vec<Value>) -> String {
    if NDJSON {
        responses
            .iter()
            .map(|response| format!("{}\n", response))
            .collect()
    } else {
        Value::Array(responses).to_string()
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
fn field<'a>(payload: &'a Value, name: &str) -> Result<&'a Value, String> {
    payload
        .as_object()
        .and_then(|o| o.get(name))
        .ok_or_else(|| path_error("Missing key", Some(name)))
}

fn same_id(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(a), Some(b)) => a == b,
        _ => a == b,
    }
}
/// A batch over the limit, or one that repeats a request id, is refused whole.
fn validate_batch(batch: &[Value]) -> Option<Response> {
    if batch.len() > MAX_BATCH {
        return Some(write_body(
            StatusCode::PAYLOAD_TOO_LARGE,
            vec![invalid("Batch limit exceeded")],
        ));
    }
    let mut ids: Vec<&Value> = Vec::with_capacity(batch.len());
    for message in batch {
        if let Some(id) = message.get("id") {
            if ids.iter().any(|prior| same_id(prior, id)) {
                return Some(write_body(
                    StatusCode::OK,
                    vec![invalid("Duplicate request id")],
                ));
            }
            ids.push(id);
        }
    }
    None
}
