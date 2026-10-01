import { expect, test } from "vite-plus/test";
import { Compile, R } from "../src/index.ts";
import { Effect } from "effect";

/**
 * Locks the exact Rust scaffolding built by the typed `Rs` helpers: the two
 * runtime preludes and the CLI shell. Function bodies are covered by the
 * native conformance suites; these assertions pin the audited static shapes so
 * a builder change cannot silently rewrite them.
 */
test("Rs-built preludes and CLI keep their exact generated shape", async () => {
  const pure = R.fn([R.Bool, R.Bool], R.Bool, (c, v) => R.Match.bool(c, v, v));
  const logged = R.fn([R.U64], R.U64, R.U64, (v) =>
    R.Log.info("first", [["count", R.U64.literal(1n)]]).pipe(
      R.Effect.flatMap(() => R.Effect.succeed(v)),
    ),
  );
  const artifact = await Effect.runPromise(Compile.run(R.program({ pure, logged })));
  const lib = artifact.files["src/lib.rs"];
  const main = artifact.files["src/main.rs"];

  const framePrelude = [
    "thread_local! {",
    "    static LAST_FRAMES: std::cell::RefCell<Vec<&'static str>> = std::cell::RefCell::new(Vec::new());",
    "    static LAST_OMITTED: std::cell::Cell<usize> = std::cell::Cell::new(0);",
    "}",
    "fn store_frames(frames: Vec<&'static str>) {",
    "    let omitted = frames.len().saturating_sub(32);",
    "    let mut kept = frames;",
    "    kept.truncate(32);",
    "    LAST_OMITTED.set(omitted);",
    "    LAST_FRAMES.with(|cell| *cell.borrow_mut() = kept);",
    "}",
    "pub fn take_last_frames() -> (Vec<&'static str>, usize) {",
    "    (LAST_FRAMES.with(|cell| std::mem::take(&mut *cell.borrow_mut())), LAST_OMITTED.get())",
    "}",
    "",
  ].join("\n");
  expect(lib.startsWith(framePrelude)).toBe(true);

  const logPrelude = [
    "#[derive(Clone, Copy)]",
    "enum LogAttr { Bool(bool), U64(u64) }",
    "const MIN_LOG_LEVEL: u8 = 2;",
    "fn log_attr_json(value: LogAttr, out: &mut String) {",
    "    match value {",
    '        LogAttr::Bool(b) => out.push_str(if b { "true" } else { "false" }),',
    "        LogAttr::U64(n) => { out.push('\"'); out.push_str(&n.to_string()); out.push('\"'); }",
    "    }",
    "}",
    "thread_local! {",
    "    static LOG_ANNOS: std::cell::RefCell<Vec<(&'static str, LogAttr)>> = std::cell::RefCell::new(Vec::new());",
    "    static LOG_SPANS: std::cell::RefCell<Vec<(&'static str, std::time::Instant)>> = std::cell::RefCell::new(Vec::new());",
    "}",
    "",
  ].join("\n");
  expect(lib).toContain(logPrelude);

  const header = [
    "fn main() -> Result<(), &'static str> {",
    "    let args: Vec<String> = std::env::args().skip(1).collect();",
    '    match args.first().map(String::as_str).ok_or("missing function")? {',
    "",
  ].join("\n");
  const footer = [
    '        _ => return Err("unknown function or incorrect arity"),',
    "    }",
    "    Ok(())",
    "}",
    "",
  ].join("\n");
  expect(main.startsWith(header)).toBe(true);
  expect(main.endsWith(footer)).toBe(true);
  expect(main).toContain('"logged" if args.len() == 2 => match reffect_generated::r_logged(');
  expect(main).toContain('"pure" if args.len() == 3 => { let value = reffect_generated::r_pure(');
  expect(main).toContain('println!("bool:{}", value);');
}, 60000);
