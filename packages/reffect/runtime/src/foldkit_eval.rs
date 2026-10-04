use std::cmp::Ordering;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    Text(Vec<u16>),
}

pub fn eq(a: &Value, b: &Value) -> Value {
    if matches!(a, Value::Null) || matches!(b, Value::Null) {
        Value::Null
    } else {
        Value::Bool(a == b)
    }
}
pub fn null(a: &Value, present: bool) -> Value {
    Value::Bool(matches!(a, Value::Null) != present)
}
/// foldkit-entity 0.7.0 `contains`: unknown for null, NUL refused, ASCII letters folded and
/// every other UTF-16 unit compared as it is (as SQLite's `lower` without ICU).
pub fn contains(a: &Value, b: &Value) -> Result<Value, &'static str> {
    if matches!(a, Value::Null) || matches!(b, Value::Null) {
        return Ok(Value::Null);
    }
    match (a, b) {
        (Value::Text(a), Value::Text(b)) => {
            if a.iter().chain(b).any(|v| *v == 0) {
                return Err("[foldkit-entity] a containment test was given text holding a NUL character, which SQL text cannot hold portably");
            }
            let fold = |s: &[u16]| -> Vec<u16> {
                s.iter()
                    .map(|v| if (65..=90).contains(v) { v + 32 } else { *v })
                    .collect()
            };
            let a = fold(a);
            let b = fold(b);
            Ok(Value::Bool(
                b.is_empty() || a.windows(b.len()).any(|w| w == b),
            ))
        }
        _ => Err("[foldkit-entity] a containment test was given something that is not text"),
    }
}
pub fn compare(a: &Value, b: &Value) -> Result<Ordering, &'static str> {
    match (a, b) {
        (Value::Text(a), Value::Text(b)) => Ok(a.cmp(b)),
        (Value::Bool(a), Value::Bool(b)) => Ok(a.cmp(b)),
        (Value::Number(a), Value::Number(b)) if a.is_finite() && b.is_finite() => Ok(a.partial_cmp(b).unwrap()),
        _ => Err("UNSUPPORTED_ORDERING: compared values must be present, finite and of the same primitive kind"),
    }
}

pub fn parse_value(token: &str) -> Result<Value, &'static str> {
    match token {
        "n" => Ok(Value::Null),
        "t" => Ok(Value::Bool(true)),
        "f" => Ok(Value::Bool(false)),
        _ if token.starts_with('d') && token.len() == 17 => {
            let bits = u64::from_str_radix(&token[1..], 16).map_err(|_| "invalid number token")?;
            Ok(Value::Number(f64::from_bits(bits)))
        }
        _ if token.starts_with('s') && (token.len() - 1).is_multiple_of(4) && token.is_ascii() => {
            let mut text = Vec::new();
            for i in (1..token.len()).step_by(4) {
                text.push(
                    u16::from_str_radix(&token[i..i + 4], 16).map_err(|_| "invalid text token")?,
                );
            }
            Ok(Value::Text(text))
        }
        _ => Err("invalid scalar token"),
    }
}
