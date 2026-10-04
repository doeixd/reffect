import { RuntimeSources } from "./runtime-sources.generated.ts";

/** Dependency-free evaluator bridge. Text is UTF-16, not a Rust UTF-8 string. */
export const foldkitRuntime = RuntimeSources.foldkit_eval;

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
