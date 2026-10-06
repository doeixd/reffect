// The SchemaBinary body (`RpcSerialization.layerSchemaBinary`, docs/research/schema-binary.md):
// frames of `RpcMessage.EncodedSchema` in fingerprint mode. Messages become the JSON-shaped
// envelopes the server already serves, each payload transcoded by the generated `sb_payload`;
// answers go back through the generated `sb_exit`. The host supplies `ENVELOPE_FINGERPRINT`,
// read from the installed Effect at build time, and `MAX_FRAME_SIZE`.

const CONTENT_TYPE: &str = "application/vnd.effect.rpc+schema-binary";
/// SchemaBinary frames every message, so each is written as it is ready.
const FRAMED: bool = true;

/// The request body's messages, or the answer to a body that has none.
#[allow(clippy::result_large_err)]
fn read_body(body: &[u8]) -> Result<(Vec<Value>, bool), Response> {
    let mut frames = schema_binary::Frames::new(body, Some(ENVELOPE_FINGERPRINT), MAX_FRAME_SIZE);
    let mut messages = Vec::new();
    for frame in frames.by_ref() {
        match frame
            .map_err(schema_binary::Failure::from)
            .and_then(schema_binary::read_message)
        {
            Ok(message) => messages.push(message_value(message)),
            // The official HTTP server reads a body with one feed: a failure surfaces only when
            // no message came before it, as a `SchemaError` defect.
            Err(failure) => {
                if messages.is_empty() {
                    return Err(write_body(
                        StatusCode::OK,
                        vec![
                            json!({"_tag":"Defect", "defect":{"name":"SchemaError", "message":failure.message()}}),
                        ],
                    ));
                }
                break;
            }
        }
    }
    // A body without a complete message is the official server's empty 500.
    if messages.is_empty() {
        return Err(StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    Ok((messages, true))
}
fn request_id_value(id: &schema_binary::RequestId) -> Value {
    match id {
        schema_binary::RequestId::Number(n) => number_value(*n),
        schema_binary::RequestId::String(s) => Value::String(s.clone()),
    }
}
fn request_id_of(value: &Value) -> schema_binary::RequestId {
    match value {
        Value::String(s) => schema_binary::RequestId::String(s.clone()),
        other => schema_binary::RequestId::Number(value_number(other).unwrap_or(f64::NAN)),
    }
}
/// A message as the JSON envelope the server reads; a payload that does not transcode is kept
/// as `~payloadError`, which `request` answers as that request's defect (SB-REQUEST-DEFECT).
fn message_value(message: schema_binary::Message) -> Value {
    use schema_binary::Message;
    match message {
        Message::Request(request) => {
            let mut object = serde_json::Map::new();
            object.insert("_tag".into(), Value::String("Request".into()));
            object.insert("id".into(), request_id_value(&request.id));
            match sb_payload(&request.tag, &request.payload) {
                Ok(payload) => {
                    object.insert("payload".into(), payload);
                }
                Err(message) => {
                    object.insert("payload".into(), Value::Null);
                    object.insert("~payloadError".into(), Value::String(message));
                }
            }
            object.insert("tag".into(), Value::String(request.tag));
            let headers = request
                .headers
                .into_iter()
                .map(|(name, value)| json!([name, value]))
                .collect();
            object.insert("headers".into(), Value::Array(headers));
            // A field present as `undefined` reads as an absent one, as JSON carries it.
            if let Some(Some(trace_id)) = request.trace_id {
                object.insert("traceId".into(), Value::String(trace_id));
            }
            if let Some(Some(span_id)) = request.span_id {
                object.insert("spanId".into(), Value::String(span_id));
            }
            if let Some(Some(sampled)) = request.sampled {
                object.insert("sampled".into(), Value::Bool(sampled));
            }
            if let Some(Some(notification)) = request.is_notification {
                object.insert("isNotification".into(), Value::Bool(notification));
            }
            Value::Object(object)
        }
        Message::Ack { request_id } => {
            json!({"_tag":"Ack", "requestId":request_id_value(&request_id)})
        }
        Message::Interrupt { request_id } => {
            json!({"_tag":"Interrupt", "requestId":request_id_value(&request_id)})
        }
        Message::Ping => json!({"_tag":"Ping"}),
        Message::Eof => json!({"_tag":"Eof"}),
        Message::Pong => json!({"_tag":"Pong"}),
        Message::Chunk { request_id, .. } => {
            json!({"_tag":"Chunk", "requestId":request_id_value(&request_id)})
        }
        Message::Exit { request_id, .. } => {
            json!({"_tag":"Exit", "requestId":request_id_value(&request_id)})
        }
        Message::Defect { .. } => json!({"_tag":"Defect"}),
    }
}
/// The request's answer, carrying the tag whose codecs encode its exit.
fn tagged(mut response: Value, tag: &str) -> Value {
    if let Some(object) = response.as_object_mut() {
        object.insert("~tag".into(), Value::String(tag.into()));
    }
    response
}
/// A streamed chunk's message, tagged so its procedure's element codec writes it.
fn chunk_message(id: &Value, tag: &str, values: Vec<Value>) -> Value {
    tagged(
        json!({"_tag":"Chunk", "requestId":id, "values":values}),
        tag,
    )
}
/// A defect frame: `Schema.Defect()` is JSON text.
fn defect_frame(defect: &Value) -> Vec<u8> {
    let mut frame = Vec::new();
    schema_binary::put_frame(&mut frame, None, json_text(defect).as_bytes());
    frame
}
/// One answer as its frame. An exit the contract's codecs cannot write is answered with a
/// protocol defect instead (the official server falls back to a defect as well).
fn encode_one(response: &Value) -> Vec<u8> {
    use schema_binary::Message;
    let message = match response.get("_tag").and_then(Value::as_str) {
        Some("Exit") => {
            let tag = response.get("~tag").and_then(Value::as_str).unwrap_or("");
            let exit = response.get("exit").unwrap_or(&Value::Null);
            match sb_exit(tag, exit) {
                Ok(exit) => Message::Exit {
                    request_id: request_id_of(response.get("requestId").unwrap_or(&Value::Null)),
                    exit,
                },
                Err(message) => Message::Defect {
                    defect: defect_frame(&json!({"name":"ProtocolError", "message":message})),
                },
            }
        }
        Some("Chunk") => {
            let tag = response.get("~tag").and_then(Value::as_str).unwrap_or("");
            let values = response
                .get("values")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice);
            match sb_chunk(tag, values) {
                Ok(values) => Message::Chunk {
                    request_id: request_id_of(response.get("requestId").unwrap_or(&Value::Null)),
                    values,
                },
                Err(message) => Message::Defect {
                    defect: defect_frame(&json!({"name":"ProtocolError", "message":message})),
                },
            }
        }
        Some("Defect") => Message::Defect {
            defect: defect_frame(response.get("defect").unwrap_or(&Value::Null)),
        },
        Some("Pong") => Message::Pong,
        _ => Message::Defect {
            defect: defect_frame(
                &json!({"name":"ProtocolError", "message":"Unsupported response message"}),
            ),
        },
    };
    let mut out = Vec::new();
    schema_binary::put_message(&mut out, &ENVELOPE_FINGERPRINT, &message);
    out
}
/// Responses as concatenated frames.
fn encode_body(responses: Vec<Value>) -> Vec<u8> {
    responses.iter().flat_map(encode_one).collect()
}
fn write_body(status: StatusCode, responses: Vec<Value>) -> Response {
    let mut response = (status, encode_body(responses)).into_response();
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static(CONTENT_TYPE),
    );
    response
}
/// Every frame decodes to an object, so no message is unframed.
fn unframed(_: &Value) -> Option<Value> {
    None
}
/// A JS number as the JSON-shaped envelope holds it: non-finite values as the strings
/// `Schema.Number`'s JSON codec uses, and `-0` kept (SchemaBinary carries it).
fn number_value(x: f64) -> Value {
    if x.is_nan() {
        return Value::String("NaN".into());
    }
    if x.is_infinite() {
        return Value::String(if x > 0.0 { "Infinity" } else { "-Infinity" }.into());
    }
    serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
}
/// The number a JSON-shaped value holds, non-finite strings included.
fn value_number(value: &Value) -> Result<f64, String> {
    match value {
        Value::Number(number) => number.as_f64().ok_or_else(|| "a number".to_string()),
        Value::String(text) => match text.as_str() {
            "NaN" => Ok(f64::NAN),
            "Infinity" => Ok(f64::INFINITY),
            "-Infinity" => Ok(f64::NEG_INFINITY),
            _ => Err("a number".to_string()),
        },
        _ => Err("a number".to_string()),
    }
}
/// `JSON.stringify` of a defect. Strings, booleans, null and safe integers are written as JS
/// writes them; other numbers use Rust's shortest form (defects reffect emits hold none).
fn json_text(value: &Value) -> String {
    let mut out = String::new();
    write_json(value, &mut out);
    out
}
fn write_json(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(number) => match number.as_f64() {
            // -0 included, as JSON.stringify writes it.
            Some(0.0) => out.push('0'),
            Some(x) if x.fract() == 0.0 && x.abs() <= 9_007_199_254_740_991.0 => {
                out.push_str(&(x as i64).to_string())
            }
            _ => out.push_str(&number.to_string()),
        },
        Value::String(s) => schema_binary::js_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(item, out);
            }
            out.push(']');
        }
        Value::Object(object) => {
            out.push('{');
            for (i, (key, item)) in object.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                schema_binary::js_string(key, out);
                out.push(':');
                write_json(item, out);
            }
            out.push('}');
        }
    }
}

/// What one WebSocket frame holds: its messages, the defect answering it, or a close code.
#[allow(dead_code)]
enum Feed {
    Messages(Vec<Value>),
    Defect(Value),
    Close(u16),
}
/// A WebSocket session's parser: SchemaBinary frames may span WebSocket frames, so an unfinished
/// frame waits for the next one. As `SchemaBinary.parser`, a failure after some messages is
/// reported on the next feed, and the parser is spent from then on.
#[derive(Default)]
#[allow(dead_code)]
struct SocketParser {
    pending: Vec<u8>,
    stashed: Option<String>,
    spent: bool,
}
#[allow(dead_code)]
impl SocketParser {
    fn feed(&mut self, frame: &[u8]) -> Feed {
        let defect = |message: String| {
            Feed::Defect(
                json!({"_tag":"Defect", "defect":{"name":"SchemaError", "message":message}}),
            )
        };
        if let Some(message) = self.stashed.take() {
            return defect(message);
        }
        if self.spent {
            return defect("Expected parser is spent".to_string());
        }
        self.pending.extend_from_slice(frame);
        let mut messages = Vec::new();
        let mut frames =
            schema_binary::Frames::new(&self.pending, Some(ENVELOPE_FINGERPRINT), MAX_FRAME_SIZE);
        let mut failure = None;
        for decoded in frames.by_ref() {
            match decoded
                .map_err(schema_binary::Failure::from)
                .and_then(schema_binary::read_message)
            {
                Ok(message) => messages.push(message_value(message)),
                Err(error) => {
                    failure = Some(error.message());
                    break;
                }
            }
        }
        let consumed = frames.consumed();
        self.pending.drain(..consumed);
        if let Some(message) = failure {
            self.spent = true;
            self.pending.clear();
            if messages.is_empty() {
                return defect(message);
            }
            self.stashed = Some(message);
        }
        Feed::Messages(messages)
    }
}
/// SchemaBinary answers in binary frames.
#[allow(dead_code)]
const BINARY_FRAMES: bool = true;
/// One answer as its own frame.
#[allow(dead_code)]
fn socket_frame(response: &Value) -> Vec<u8> {
    encode_one(response)
}
