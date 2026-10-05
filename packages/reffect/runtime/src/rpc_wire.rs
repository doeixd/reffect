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
