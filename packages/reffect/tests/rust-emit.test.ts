import { expect, test } from "vite-plus/test";
import {
  Rs,
  RustIdent,
  escapeJsonContent,
  escapeRustChar,
  escapeRustContent,
  formatTemplate,
} from "../src/rust-emit.ts";
import type { RsExpr } from "../src/rust-emit.ts";

test("identifiers validate shape and refuse keywords unless raw", () => {
  expect(Rs.ident("r_branch").text).toBe("r_branch");
  expect(Rs.ident("p0").text).toBe("p0");
  expect(Rs.ident("_hidden").text).toBe("_hidden");
  expect(() => Rs.ident("")).toThrow();
  expect(() => Rs.ident("has space")).toThrow();
  expect(() => Rs.ident("0abc")).toThrow();
  expect(() => Rs.ident("with-dash")).toThrow();
  expect(() => Rs.ident("match")).toThrow();
  expect(() => Rs.ident("_")).toThrow();
  expect(Rs.rawIdent("match").text).toBe("r#match");
  expect(Rs.rawIdent("plain").text).toBe("plain");
  expect(() => Rs.rawIdent("no good")).toThrow();
  expect(() => Rs.rawIdent("self")).toThrow();
  expect(() => Rs.rawIdent("_")).toThrow();
  expect(() => Rs.ident("gen")).toThrow();
  expect(Object.isFrozen(Rs.ident("x"))).toBe(true);
});

test("literals encode ranges and suffixes exactly", () => {
  expect(Rs.litU64(42n).text).toBe("42u64");
  expect(Rs.litU64(0n).text).toBe("0u64");
  expect(Rs.litU64((1n << 64n) - 1n).text).toBe("18446744073709551615u64");
  expect(() => Rs.litU64(-1n)).toThrow();
  expect(() => Rs.litU64(1n << 64n)).toThrow();
  expect(Rs.litBool(true).text).toBe("true");
  expect(Rs.litBool(false).text).toBe("false");
  expect(Rs.litUnit().text).toBe("()");
  expect(Rs.litInt(32).text).toBe("32");
  expect(() => Rs.litInt(0.5)).toThrow();
  expect(Rs.litU8(255).text).toBe("255u8");
  expect(() => Rs.litU8(256)).toThrow();
  expect(() => Rs.litU8(-1)).toThrow();
});

test("string literals use Rust escapes, never braceless JSON escapes", () => {
  expect(Rs.stringLiteral('a"b\\c').text).toBe('"a\\"b\\\\c"');
  expect(Rs.stringLiteral("line\ntab\rcr").text).toBe('"line\\ntab\\rcr"');
  expect(Rs.stringLiteral("a\tb").text).toBe('"a\\tb"');
  expect(Rs.stringLiteral("emoji 😀").text).toBe('"emoji 😀"');
  // A lone surrogate becomes a braced Rust escape (valid UTF-8); JSON uses braceless ones.
  expect(Rs.stringLiteral("\ud800").text).toBe('"\\u{d800}"');
  expect(escapeRustContent("\ud800")).toBe("\\u{d800}");
  expect(escapeJsonContent("\ud800")).toBe("\\ud800");
  expect(escapeJsonContent('"\n')).toBe('\\"\\u000a');
});

test("format templates double literal braces and place holes in order", () => {
  const made = formatTemplate("a{", Rs.litU64(1n), "}b", Rs.litBool(true), "{{c}}");
  expect(made.template).toBe("a{{{}}}b{}{{{{c}}}}");
  expect(made.holes.map((h) => h.text)).toEqual(["1u64", "true"]);
  expect(Rs.println("ok:u64:", Rs.identExpr(Rs.ident("value"))).text).toBe(
    'println!("ok:u64:{}", value);',
  );
  expect(Rs.eprintln("static").text).toBe('eprintln!("static");');
});

test("structural builders own their delimiters", () => {
  const cond = Rs.identExpr(Rs.ident("p0"));
  const arm = (name: string, body: RsExpr) => ({ pat: Rs.pat(name), body });
  expect(
    Rs.match_(cond, [arm("Ok(value)", Rs.litU64(1n)), arm("Err(e)", Rs.litU64(2n))]).text,
  ).toBe("match p0 { Ok(value) => 1u64, Err(e) => 2u64 }");
  expect(Rs.if_(cond, Rs.litBool(true), Rs.litBool(false)).text).toBe("if p0 true else false");
  expect(Rs.if_(cond, Rs.litBool(true)).text).toBe("if p0 true");
  expect(Rs.block([Rs.let_(Rs.ident("v0"), undefined, Rs.litU64(3n))], Rs.litU64(4n)).text).toBe(
    "{\n    let v0 = 3u64;\n    4u64\n}",
  );
  expect(Rs.inlineBlock(Rs.litU64(1n), Rs.litU64(2n)).text).toBe("{ 1u64 2u64 }");
  expect(Rs.stmt(Rs.litU64(1n)).text).toBe("1u64;");
  expect(Rs.letMut(Rs.ident("x"), undefined, Rs.litBool(true)).text).toBe("let mut x = true;");
  expect(
    Rs.fnItem(
      Rs.ident("r_add"),
      [{ name: Rs.ident("p0"), type: Rs.namedType("u64") }],
      Rs.namedType("u64"),
      Rs.litU64(0n),
    ).text,
  ).toBe("fn r_add(p0: u64) -> u64 0u64");
  expect(Rs.fnItem(Rs.ident("store"), [], Rs.unitType(), Rs.block([], Rs.litUnit())).text).toBe(
    "fn store() {\n    ()\n}",
  );
  expect(
    Rs.matchBlock(Rs.identExpr(Rs.ident("v")), [{ pat: Rs.pat("A"), body: Rs.litU64(1n) }], {
      indent: 4,
    }).text,
  ).toBe("match v {\n        A => 1u64\n    }");
  expect(
    Rs.matchBlock(
      Rs.identExpr(Rs.ident("v")),
      [
        { pat: Rs.pat("A"), body: Rs.litU64(1n) },
        { pat: Rs.pat("B"), body: Rs.litU64(2n) },
      ],
      { indent: 4, trailingComma: true },
    ).text,
  ).toBe("match v {\n        A => 1u64,\n        B => 2u64,\n    }");
  expect(Rs.call(Rs.identExpr(Rs.ident("f")), [Rs.litU64(1n)]).text).toBe("f(1u64)");
  expect(() => Rs.pathCall([], Rs.ident("new"), [])).toThrow();
  expect(
    Rs.method(Rs.identExpr(Rs.ident("a")), Rs.ident("wrapping_add"), [Rs.litU64(1n)]).text,
  ).toBe("(a).wrapping_add(1u64)");
  expect(
    Rs.method(Rs.identExpr(Rs.ident("s")), Rs.ident("parse"), [], [Rs.namedType("bool")]).text,
  ).toBe("(s).parse::<bool>()");
  expect(Rs.macroCall(Rs.ident("vec"), [Rs.litU64(1n)], "[").text).toBe("vec![1u64]");
  expect(Rs.macroCall(Rs.ident("println"), [Rs.litU64(1n)]).text).toBe("println!(1u64)");
  expect(Rs.eq(Rs.litU64(1n), Rs.litU64(2n)).text).toBe("(1u64) == (2u64)");
  expect(Rs.ne(Rs.litU64(1n), Rs.litU64(2n)).text).toBe("(1u64) != (2u64)");
  expect(Rs.pat('"branch"').text).toBe('"branch"');
  expect(() => Rs.pat("a;b")).toThrow();
  expect(Rs.lt(Rs.litU64(1n), Rs.litU64(2n)).text).toBe("(1u64) < (2u64)");
  expect(Rs.not(Rs.litBool(true)).text).toBe("!(true)");
  expect(Rs.tuple(Rs.litU64(1n), Rs.litBool(true)).text).toBe("(1u64, true)");
  expect(Rs.vecLit(Rs.litU64(1n)).text).toBe("vec![1u64]");
  expect(Rs.field(Rs.identExpr(Rs.ident("e")), Rs.ident("code")).text).toBe("e.code");
  expect(Rs.tupleField(Rs.identExpr(Rs.ident("e")), 1).text).toBe("e.1");
  expect(() => Rs.tupleField(Rs.identExpr(Rs.ident("e")), -1)).toThrow();
  expect(Rs.index(Rs.identExpr(Rs.ident("args")), 2).text).toBe("args[2]");
  expect(() => Rs.index(Rs.identExpr(Rs.ident("args")), 1.5)).toThrow();
  expect(Rs.closure(Rs.pat("scope"), Rs.litU64(1n)).text).toBe("|scope| 1u64");
  expect(() => Rs.pat("")).toThrow();
  expect(() => Rs.pat("a{b")).toThrow();
  expect(Rs.forLoop(Rs.pat("(i, x)"), Rs.identExpr(Rs.ident("it")), Rs.litU64(0n)).text).toBe(
    "for (i, x) in it 0u64",
  );
  expect(Rs.return_(Rs.litU64(1n)).text).toBe("return 1u64");
  expect(Rs.try_(Rs.identExpr(Rs.ident("r"))).text).toBe("r?");
  expect(Rs.await(Rs.identExpr(Rs.ident("task"))).text).toBe("task.await");
  expect(Rs.awaitTry(Rs.identExpr(Rs.ident("task"))).text).toBe("task.await?");
  expect(Rs.cast(Rs.identExpr(Rs.ident("n")), Rs.u8Type()).text).toBe("(n) as u8");
  expect(Rs.struct(Rs.ident("Point"), [[Rs.ident("x"), Rs.litU64(1n)]]).text).toBe(
    "Point { x: 1u64 }",
  );
  expect(Rs.range(Rs.litU64(0n), Rs.litU64(3n)).text).toBe("0u64..3u64");
  expect(Rs.unwrapOr(Rs.identExpr(Rs.ident("v")), Rs.litU64(0n)).text).toBe("(v).unwrap_or(0u64)");
  expect(Rs.unreachableMatch(Rs.identExpr(Rs.ident("never"))).text).toBe("match never {}");
  expect(Rs.displayPrint(Rs.identExpr(Rs.ident("value")), "ok:{}:").text).toBe(
    'println!("ok:{{}}:{}", value);',
  );
  expect(Rs.prefix("!", Rs.litBool(true)).text).toBe("!true");
  expect(Rs.prefix("*", Rs.identExpr(Rs.ident("p"))).text).toBe("*p");
});

test("types compose from parts, never unchecked strings", () => {
  expect(Rs.namedType("u64").text).toBe("u64");
  expect(() => Rs.namedType("not a type!")).toThrow();
  expect(() => Rs.namedType("")).toThrow();
  expect(() => Rs.namedType("match")).toThrow();
  expect(Rs.unitType().text).toBe("()");
  expect(Rs.boolType().text).toBe("bool");
  expect(Rs.u8Type().text).toBe("u8");
  expect(Rs.usizeType().text).toBe("usize");
  expect(Rs.stringType().text).toBe("String");
  expect(Rs.pathType([Rs.ident("std"), Rs.ident("convert"), Rs.ident("Infallible")]).text).toBe(
    "std::convert::Infallible",
  );
  expect(() => Rs.pathType([])).toThrow();
  expect(Rs.vecType(Rs.strRefType()).text).toBe("Vec<&'static str>");
  expect(Rs.resultType(Rs.namedType("u64"), Rs.unitType()).text).toBe("Result<u64, ()>");
  expect(Rs.tupleType([Rs.namedType("u64"), Rs.boolType()]).text).toBe("(u64, bool)");
  expect(Rs.refType(Rs.namedType("String")).text).toBe("&String");
  expect(Rs.mutRefType(Rs.namedType("String")).text).toBe("&mut String");
  expect(Rs.strRefType().text).toBe("&'static str");
  expect(Rs.strType().text).toBe("str");
  expect(Rs.optionType(Rs.boolType()).text).toBe("Option<bool>");
  expect(Rs.arrayType(Rs.u8Type(), 4).text).toBe("[u8; 4]");
  expect(() => Rs.arrayType(Rs.u8Type(), -1)).toThrow();
  expect(Rs.verbatimType("dyn Trait").text).toBe("dyn Trait");
  expect(() => Rs.verbatimType("")).toThrow();
});

test("standard-library utilities compose Option, Result, iterator and format idioms", () => {
  const value = Rs.identExpr(Rs.ident("value"));
  const f = Rs.closure(Rs.pat("x"), Rs.identExpr(Rs.ident("x")));
  expect(Rs.some(value).text).toBe("Some(value)");
  expect(Rs.none().text).toBe("None");
  expect(Rs.optionMap(value, f).text).toBe("(value).map(|x| x)");
  expect(Rs.optionAndThen(value, f).text).toBe("(value).and_then(|x| x)");
  expect(Rs.optionOkOr(value, Rs.stringLiteral("missing")).text).toBe('(value).ok_or("missing")');
  expect(Rs.resultMap(value, f).text).toBe("(value).map(|x| x)");
  expect(Rs.resultMapErr(value, f).text).toBe("(value).map_err(|x| x)");
  expect(Rs.unwrap(value).text).toBe("(value).unwrap()");
  expect(Rs.expect(value, 'could not "read"').text).toBe('(value).expect("could not \\"read\\"")');
  expect(Rs.unwrapOrElse(value, f).text).toBe("(value).unwrap_or_else(|x| x)");
  expect(Rs.isSome(value).text).toBe("(value).is_some()");
  expect(Rs.isNone(value).text).toBe("(value).is_none()");
  expect(Rs.isOk(value).text).toBe("(value).is_ok()");
  expect(Rs.isErr(value).text).toBe("(value).is_err()");
  expect(
    Rs.chain(value, [
      { method: Rs.ident("iter"), args: [] },
      { method: Rs.ident("enumerate"), args: [] },
      {
        method: Rs.ident("collect"),
        args: [],
        turboTypes: [Rs.vecType(Rs.tupleType([Rs.usizeType(), Rs.refType(Rs.namedType("u64"))]))],
      },
    ]).text,
  ).toBe("(((value).iter()).enumerate()).collect::<Vec<(usize, &u64)>>()");
  expect(Rs.format("literal {brace}: ", value).text).toBe(
    'format!("literal {{brace}}: {}", value)',
  );
  expect(Rs.write(Rs.identExpr(Rs.ident("out")), "item=", value).text).toBe(
    'write!(out, "item={}", value)',
  );
  expect(Rs.stringFrom(Rs.stringLiteral("hello")).text).toBe('String::from("hello")');
  expect(Rs.boxNew(value).text).toBe("Box::new(value)");
  expect(Rs.vecWithCapacity(Rs.litU64(8n)).text).toBe("Vec::with_capacity(8u64)");
  expect(Rs.assert(Rs.litBool(true), "condition").text).toBe('assert!(true, "condition");');
  expect(Rs.assertEq(value, Rs.litU64(1n)).text).toBe("assert_eq!(value, 1u64);");
  expect(Rs.variantPat([Rs.ident("Some")], [Rs.identPat(Rs.ident("item"))]).text).toBe(
    "Some(item)",
  );
  expect(Rs.tuplePat(Rs.identPat(Rs.ident("i")), Rs.wildcardPat()).text).toBe("(i, _)");
});

test("tagged templates and custom function helpers preserve fragment roles", () => {
  const x = Rs.identExpr(Rs.ident("x"));
  const expr = Rs.exprTemplate`(${x}).wrapping_add(${Rs.litU64(1n)})`;
  const type = Rs.typeTemplate`Result<${Rs.namedType("u64")}, ${Rs.namedType("ParseError")}>`;
  expect(expr.text).toBe("(x).wrapping_add(1u64)");
  expect(type.text).toBe("Result<u64, ParseError>");
  expect(Rs.patTemplate`Some(${Rs.identPat(Rs.ident("value"))})`.text).toBe("Some(value)");

  const increment = Rs.defineFn(
    Rs.ident("increment"),
    [{ name: Rs.ident("value"), type: Rs.u64Type() }],
    Rs.u64Type(),
    (arg) => Rs.exprTemplate`(${arg(Rs.ident("value"))}).wrapping_add(1u64)`,
  );
  expect(increment.item.text).toBe("fn increment(value: u64) -> u64 (value).wrapping_add(1u64)");
  expect(increment.call(Rs.litU64(4n)).text).toBe("increment(4u64)");
  expect(() => Reflect.apply(increment.call, undefined, [])).toThrow("expects 1 arguments, got 0");
  expect(Rs.itemTemplate`\n${increment.item}\n`.text).toBe(
    "\nfn increment(value: u64) -> u64 (value).wrapping_add(1u64)\n",
  );
  expect(() =>
    Rs.defineFn(
      Rs.ident("bad"),
      [
        { name: Rs.ident("x"), type: Rs.u64Type() },
        { name: Rs.ident("x"), type: Rs.u64Type() },
      ],
      Rs.u64Type(),
      (arg) => arg(Rs.ident("x")),
    ),
  ).toThrow("Duplicate Rust function parameter");
  expect(() =>
    Rs.defineFn(
      Rs.ident("bad"),
      [{ name: Rs.ident("x"), type: Rs.u64Type() }],
      Rs.u64Type(),
      (arg) => arg(Rs.ident("missing")),
    ),
  ).toThrow("Unknown Rust function parameter");
});

test("paths, use trees, visibility and modules assemble valid item structures", () => {
  const imports = Rs.usePath(
    Rs.path([Rs.ident("std"), Rs.ident("collections")]),
    Rs.useGroup([
      Rs.useTree(Rs.path([Rs.ident("HashMap")])),
      Rs.usePath(
        Rs.path([Rs.ident("hash_map")]),
        Rs.useGroup([Rs.useSelf(), Rs.useTree(Rs.path([Rs.ident("HashMap")]), Rs.ident("Map"))]),
      ),
    ]),
  );
  expect(Rs.useItem(imports, Rs.visibility.public).text).toBe(
    "pub use std::collections::{HashMap, hash_map::{self, HashMap as Map}};",
  );
  expect(Rs.useItem(Rs.useTree(Rs.cratePath([Rs.ident("api")]))).text).toBe("use crate::api;");
  expect(Rs.useItem(Rs.useTree(Rs.absolutePath([Rs.ident("std")]))).text).toBe("use ::std;");
  expect(Rs.visibility.in(Rs.selfPath([Rs.ident("internal")])).text).toBe("pub(in self::internal)");
  expect(() => Rs.visibility.in(Rs.path([Rs.ident("internal")]))).toThrow();

  const local = Rs.withAttributes(
    [
      Rs.deriveAttribute(Rs.ident("Clone"), Rs.ident("Debug")),
      Rs.allowAttribute(Rs.ident("dead_code")),
    ],
    Rs.fnItem(Rs.ident("answer"), [], Rs.u64Type(), Rs.litU64(42n)),
  );
  const nested = Rs.moduleItem(
    Rs.ident("api"),
    [Rs.useItem(imports, Rs.visibility.public), Rs.withVisibility(Rs.visibility.public, local)],
    Rs.visibility.crate,
  );
  expect(nested.text).toBe(
    "pub(crate) mod api {\n    pub use std::collections::{HashMap, hash_map::{self, HashMap as Map}};\n\n    #[derive(Clone, Debug)]\n    #[allow(dead_code)]\n    pub fn answer() -> u64 42u64\n}",
  );
  expect(Rs.externalModuleItem(Rs.ident("generated"), Rs.visibility.public).text).toBe(
    "pub mod generated;",
  );
  expect(Rs.moduleFile([nested, Rs.externalModuleItem(Rs.ident("generated"))]).text).toBe(
    `${nested.text}\n\nmod generated;\n`,
  );
  expect(Rs.cfgFeatureAttribute('native"backend').text).toBe(
    '#[cfg(feature = "native\\"backend")]',
  );
});

test("declarative macros use role-indexed groups, metavariables and repetitions", () => {
  const value = Rs.ident("value");
  const one = Rs.macroRule(
    Rs.macroGroup("matcher", "()", [Rs.macroFragment(value, "expr")]),
    Rs.macroGroup("transcriber", "{}", [Rs.macroRef(value)]),
  );
  expect(Rs.macroRulesItem(Rs.ident("identity"), [one], { exported: true }).text).toBe(
    "#[macro_export]\nmacro_rules! identity {\n    ($value:expr) => {$value};\n}",
  );
  expect(Rs.macroGroup("matcher", "()", [Rs.macroLiteral("matcher", 'a "literal"')]).text).toBe(
    '("a \\"literal\\"")',
  );

  const many = Rs.macroRule(
    Rs.macroGroup("matcher", "()", [
      Rs.macroRepeat(
        "matcher",
        Rs.macroGroup("matcher", "()", [Rs.macroFragment(value, "expr")]),
        "*",
        Rs.macroPunct("matcher", ","),
      ),
    ]),
    Rs.macroGroup("transcriber", "[]", [
      Rs.macroRepeat(
        "transcriber",
        Rs.macroGroup("transcriber", "()", [Rs.macroRef(value)]),
        "*",
        Rs.macroPunct("transcriber", ","),
      ),
    ]),
  );
  expect(Rs.macroRulesItem(Rs.ident("array"), [many]).text).toBe(
    "macro_rules! array {\n    ($($value:expr),*) => [$($value),*];\n}",
  );
  expect(() => Rs.macroRulesItem(Rs.ident("empty"), [])).toThrow();
  expect(() =>
    Reflect.apply(Rs.macroGroup, undefined, ["matcher", "()", [Rs.macroRef(Rs.ident("value"))]]),
  ).toThrow("cannot contain tokens of another role");
  expect(() =>
    Rs.macroRepeat(
      "matcher",
      Rs.macroGroup("matcher", "()", [Rs.macroFragment(value, "ident")]),
      "?",
      Rs.macroPunct("matcher", ","),
    ),
  ).toThrow("cannot have a separator");
});

test("item, chain and literal builders cover emitter scaffolding shapes", () => {
  expect(Rs.litChar('"').text).toBe("'\"'");
  expect(Rs.litChar("'").text).toBe("'\\''");
  expect(Rs.litChar("\n").text).toBe("'\\n'");
  expect(() => Rs.litChar("ab")).toThrow();
  expect(escapeRustChar("\u0001")).toBe("\\u{1}");
  expect(escapeRustChar('a"')).toBe('a"');

  expect(Rs.dotCall(Rs.identExpr(Rs.ident("x")), Rs.ident("len"), []).text).toBe("x.len()");
  expect(
    Rs.dotChain(Rs.identExpr(Rs.ident("x")), [
      { method: Rs.ident("iter"), args: [] },
      { method: Rs.ident("collect"), args: [], turboTypes: [Rs.u8Type()] },
    ]).text,
  ).toBe("x.iter().collect::<u8>()");
  expect(Rs.cmp(Rs.identExpr(Rs.ident("i")), ">", Rs.litInt(0)).text).toBe("i > 0");
  expect(Rs.cmp(Rs.identExpr(Rs.ident("i")), "!=", Rs.stringLiteral("u")).text).toBe('i != "u"');
  expect(Rs.assignExpr(Rs.identExpr(Rs.ident("a")), Rs.litU64(1n)).text).toBe("a = 1u64");
  expect(Rs.refExpr(Rs.identExpr(Rs.ident("a"))).text).toBe("&a");
  expect(Rs.mutRefExpr(Rs.identExpr(Rs.ident("a"))).text).toBe("&mut a");

  expect(
    Rs.letPat(Rs.tuplePat(Rs.identPat(Rs.ident("a")), Rs.wildcardPat()), undefined, Rs.litU64(1n))
      .text,
  ).toBe("let (a, _) = 1u64;");
  expect(Rs.letDiscard(Rs.unitType(), Rs.litUnit()).text).toBe("let _: () = ();");
  expect(Rs.stringPat('a"b').text).toBe('"a\\"b"');
  expect(Rs.blockStmt(Rs.if_(Rs.litBool(true), Rs.litUnit())).text).toBe("if true ()");
  expect(Rs.inlineStmtBlock(Rs.stmt(Rs.litU64(1n)))).toBeDefined();
  expect(Rs.inlineStmtBlock(Rs.stmt(Rs.litU64(1n))).text).toBe("{ 1u64; }");

  expect(Rs.genericType(Rs.namedType("Vec"), [Rs.u8Type()]).text).toBe("Vec<u8>");
  expect(() => Rs.genericType(Rs.namedType("Vec"), [])).toThrow();
  expect(Rs.pathExpr(Rs.cratePath([Rs.ident("api")])).text).toBe("crate::api");
  expect(
    Rs.enumItem(Rs.ident("E"), [
      { name: Rs.ident("A") },
      { name: Rs.ident("B"), fields: [Rs.boolType()] },
    ]).text,
  ).toBe("enum E { A, B(bool) }");
  expect(() => Rs.enumItem(Rs.ident("E"), [])).toThrow();
  expect(() =>
    Rs.enumItem(Rs.ident("E"), [{ name: Rs.ident("A") }, { name: Rs.ident("A") }]),
  ).toThrow("Duplicate Rust enum variant");
  expect(Rs.constItem(Rs.ident("N"), Rs.u8Type(), Rs.litInt(2)).text).toBe("const N: u8 = 2;");
  expect(
    Rs.staticItem(Rs.ident("S"), Rs.u8Type(), Rs.litInt(0), true, Rs.visibility.public).text,
  ).toBe("pub static mut S: u8 = 0;");
  expect(
    Rs.threadLocalItem([
      { name: Rs.ident("T"), type: Rs.usizeType(), value: Rs.litInt(0), mutable: true },
    ]).text,
  ).toBe("thread_local! {\n    static mut T: usize = 0;\n}");
  expect(() => Rs.threadLocalItem([])).toThrow();
  expect(Rs.whileLoop(Rs.litBool(true), Rs.litUnit()).text).toBe("while true ()");
  expect(Rs.letElse(Rs.pat("Some(x)"), Rs.identExpr(Rs.ident("v")), Rs.litUnit()).text).toBe(
    "let Some(x) = v else ()",
  );
  expect(
    Rs.itemsText(
      [
        Rs.constItem(Rs.ident("A"), Rs.u8Type(), Rs.litInt(1)),
        Rs.constItem(Rs.ident("B"), Rs.u8Type(), Rs.litInt(2)),
      ],
      "\n",
    ).text,
  ).toBe("const A: u8 = 1;\nconst B: u8 = 2;\n");
  expect(Rs.printlnExpr("a:", Rs.identExpr(Rs.ident("v"))).text).toBe('println!("a:{}", v)');
  expect(Rs.eprintlnExpr("a").text).toBe('eprintln!("a")');
});

test("verbatim hatches round-trip audited scaffolding", () => {
  expect(Rs.verbatimExpr("a + b").text).toBe("a + b");
  expect(() => Rs.verbatimExpr("")).toThrow();
  expect(Rs.verbatimItem("fn f() {}").text).toBe("fn f() {}");
  expect(() => Rs.verbatimItem("")).toThrow();
  const fragment: RsExpr = Rs.litU64(7n);
  expect(fragment.text).toBe("7u64");
  expect(RustIdent).toBeDefined();
});
