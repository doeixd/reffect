/** Dependency-free evaluator bridge. Text is UTF-16, not a Rust UTF-8 string. */
export const foldkitRuntime = `use std::cmp::Ordering;

#[derive(Debug, PartialEq)]
pub enum Value { Null, Bool(bool), Number(f64), Text(Vec<u16>) }

pub fn eq(a: &Value, b: &Value) -> Value {
    if matches!(a, Value::Null) || matches!(b, Value::Null) { Value::Null }
    else { Value::Bool(a == b) }
}
pub fn null(a: &Value, present: bool) -> Value {
    Value::Bool(matches!(a, Value::Null) != present)
}
pub fn contains(a: &Value, b: &Value) -> Result<Value, &'static str> {
    if matches!(a, Value::Null) || matches!(b, Value::Null) { return Ok(Value::Null); }
    match (a, b) {
        (Value::Text(a), Value::Text(b)) => {
            if a.iter().chain(b).any(|v| *v == 0 || *v > 127) {
                return Err("UNSUPPORTED_CONTAINMENT: only non-NUL ASCII operands have verified three-interpreter semantics");
            }
            let fold = |s: &[u16]| -> Vec<u16> { s.iter().map(|v| if (65..=90).contains(v) { v + 32 } else { *v }).collect() };
            let a = fold(a); let b = fold(b);
            Ok(Value::Bool(b.is_empty() || a.windows(b.len()).any(|w| w == b)))
        }
        _ => Err("INVALID_CONTAINMENT: operands must be text or null"),
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
        "n" => Ok(Value::Null), "t" => Ok(Value::Bool(true)), "f" => Ok(Value::Bool(false)),
        _ if token.starts_with('d') && token.len() == 17 => {
            let bits = u64::from_str_radix(&token[1..], 16).map_err(|_| "invalid number token")?;
            Ok(Value::Number(f64::from_bits(bits)))
        }
        _ if token.starts_with('s') && (token.len() - 1) % 4 == 0 && token.is_ascii() => {
            let mut text = Vec::new();
            for i in (1..token.len()).step_by(4) {
                text.push(u16::from_str_radix(&token[i..i + 4], 16).map_err(|_| "invalid text token")?);
            }
            Ok(Value::Text(text))
        }
        _ => Err("invalid scalar token"),
    }
}
`;

export const foldkitMain = (arms: string) => `use std::io::{self, Read};
use reffect_generated::{Value, parse_value};
fn next<'a>(lines: &mut std::str::Lines<'a>) -> Result<&'a str, &'static str> {
    lines.next().ok_or("truncated input")
}
fn values(lines: &mut std::str::Lines<'_>, count: usize) -> Result<Vec<Value>, &'static str> {
    (0..count).map(|_| parse_value(next(lines)?)).collect()
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let name = std::env::args().nth(1).ok_or("missing query")?;
    let (fields, inputs, run): (usize, usize, fn(&[Value], &[Vec<Value>]) -> Result<Vec<usize>, &'static str>) = match name.as_str() {
${arms}
        _ => return Err("unknown query".into()),
    };
    let mut text = String::new(); io::stdin().read_to_string(&mut text)?;
    let mut lines = text.lines();
    if next(&mut lines)? != "reffect-query-v1" { return Err("unknown evaluator protocol".into()); }
    let count: usize = next(&mut lines)?.parse()?;
    let input = values(&mut lines, inputs)?;
    let rows: Vec<Vec<Value>> = (0..count).map(|_| values(&mut lines, fields)).collect::<Result<_, _>>()?;
    if lines.next().is_some() { return Err("extra input".into()); }
    for index in run(&input, &rows)? { println!("{}", index); }
    Ok(())
}
`;
