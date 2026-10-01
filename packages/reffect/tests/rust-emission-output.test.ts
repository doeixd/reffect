import { expect, test } from "vite-plus/test";
import { Compile, Foldkit, R } from "../src/index.ts";
import { Effect, Schema } from "effect";
import { Entity, Expr, Order, Query } from "foldkit-entity";

/**
 * Pins the typed logging prelude/CLI shell and bounded-frame scaffold interface.
 * Native conformance and allocation probes verify propagation and storage behavior.
 */
test("runtime scaffolds and Rs-built logging/CLI retain their generated contracts", async () => {
  const pure = R.fn([R.Bool, R.Bool], R.Bool, (c, v) => R.Match.bool(c, v, v));
  const logged = R.fn([R.U64], R.U64, R.U64, (v) =>
    R.Log.info("first", [["count", R.U64.literal(1n)]]).pipe(
      R.Effect.flatMap(() => R.Effect.succeed(v)),
    ),
  );
  const artifact = await Effect.runPromise(Compile.run(R.program({ pure, logged })));
  const lib = artifact.files["src/lib.rs"];
  const main = artifact.files["src/main.rs"];

  expect(lib.startsWith("const MAX_LOGICAL_FRAMES: usize = 32;\nstruct FrameTrail {")).toBe(true);
  expect(lib).toContain("frames: [&'static str; MAX_LOGICAL_FRAMES]");
  expect(lib).toContain("pub fn take_last_frames() -> (Vec<&'static str>, usize)");
  expect(lib).toContain("pub fn clear_last_frames()");

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

test("Foldkit's Rs-built query bodies keep their exact generated shape", async () => {
  const Item = Entity.define(
    "Item",
    Schema.Struct({
      id: Schema.String,
      text: Schema.String,
      rank: Schema.Number,
      active: Schema.Boolean,
    }),
  );
  const from = Query.from(Item);
  const artifact = await Effect.runPromise(
    Foldkit.compile({
      absent: from.pipe(Query.where(Expr.isNull(Item.fields.text))),
      ordered: from.pipe(Query.orderBy(Order.desc(Item.fields.rank))),
    }),
  );
  const lib = artifact.files["src/lib.rs"];
  expect(lib).toContain(
    [
      "fn matches_absent(input: &[Value], row: &[Value]) -> Result<bool, &'static str> {",
      "    let v0 = &row[0];",
      "    let l1 = null(v0, false); let v1 = &l1;",
      "    if !matches!(v1, Value::Bool(true)) { return Ok(false); }",
      "    Ok(true)",
      "}",
    ].join("\n"),
  );
  expect(lib).toContain(
    [
      "    let compare_rows = |a: &usize, b: &usize| -> Result<Ordering, &'static str> {",
      "        let order = compare(&rows[*a][0], &rows[*b][0])?;",
      "        if order != Ordering::Equal { return Ok(order.reverse()); }",
      "        Ok(Ordering::Equal)",
      "    };",
    ].join("\n"),
  );
  // Empty statement lists are empty blocks, not blank-line padding.
  expect(lib).not.toMatch(/{\n\n/);
  expect(lib).not.toMatch(/\n\n {4}}/);
  expect(artifact.files["src/main.rs"]).toContain(
    '        "absent" => (1, 0, reffect_generated::r_absent),',
  );
  expect(artifact.files["src/main.rs"]).toContain(
    '        "ordered" => (1, 0, reffect_generated::r_ordered),',
  );
}, 60000);
