/// What JSON.parse(JSON.stringify(value)) gives: numbers are written shortest and parsed
/// back exactly, so only -0 changes, into 0.
pub fn round_trip(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Number(number) if number.as_f64() == Some(0.0) => {
            serde_json::Value::from(0u64)
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(round_trip).collect())
        }
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), round_trip(item)))
                .collect(),
        ),
        other => other.clone(),
    }
}
pub fn json_text(value: &serde_json::Value) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}
fn write(value: &serde_json::Value, out: &mut String) {
    match value {
        serde_json::Value::Null => out.push_str("null"),
        serde_json::Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        serde_json::Value::Number(number) => {
            match (number.as_i64(), number.as_u64(), number.as_f64()) {
                (Some(i), _, _) => out.push_str(&i.to_string()),
                (_, Some(u), _) => out.push_str(&u.to_string()),
                (_, _, Some(x)) => out.push_str(ryu_js::Buffer::new().format(x)),
                _ => out.push_str("null"),
            }
        }
        serde_json::Value::String(text) => out.push_str(&serde_json::to_string(text).unwrap()),
        serde_json::Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        serde_json::Value::Object(map) => {
            out.push('{');
            for (i, (key, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap());
                out.push(':');
                write(item, out);
            }
            out.push('}');
        }
    }
}
