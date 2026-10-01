/**
 * Internal helpers for emitting Rust source text.
 *
 * These are build-time TypeScript tools: they validate identifiers, literals
 * and syntactic roles while constructing source text, but they prove nothing
 * about borrowck, traits or layouts — rustc remains the authority. There is no
 * public extension contract; tests are the first callers.
 *
 * Fragments are role-branded opaque values whose brand is module-private, so
 * TypeScript refuses to cross a role boundary without a builder. Arithmetic on
 * raw strings cannot fabricate a fragment except through a `verbatim*` escape
 * hatch, which is reserved for audited static scaffolding (never user text).
 */
const brand: unique symbol = Symbol("reffect/rust-emit");
const pathBrand: unique symbol = Symbol("reffect/rust-path");
const visibilityBrand: unique symbol = Symbol("reffect/rust-visibility");
const useTreeBrand: unique symbol = Symbol("reffect/rust-use-tree");
const macroTokenBrand: unique symbol = Symbol("reffect/rust-macro-token");
const macroGroupBrand: unique symbol = Symbol("reffect/rust-macro-group");
const fileBrand: unique symbol = Symbol("reffect/rust-module-file");
const attributeBrand: unique symbol = Symbol("reffect/rust-attribute");
export interface RsExpr {
  readonly [brand]: "RsExpr";
  readonly text: string;
}
export interface RsStmt {
  readonly [brand]: "RsStmt";
  readonly text: string;
}
export interface RsItem {
  readonly [brand]: "RsItem";
  readonly text: string;
}
export interface RsModuleFile {
  readonly [fileBrand]: true;
  readonly text: string;
}
export interface RsAttribute {
  readonly [attributeBrand]: true;
  readonly text: string;
}
export interface RsType {
  readonly [brand]: "RsType";
  readonly text: string;
}
export interface RsPat {
  readonly [brand]: "RsPat";
  readonly text: string;
}
export type RsPathRoot = "relative" | "crate" | "self" | "super" | "absolute";
export interface RsPath {
  readonly [pathBrand]: true;
  readonly root: RsPathRoot;
  readonly segments: readonly RustIdent[];
  readonly text: string;
}
export interface RsVisibility {
  readonly [visibilityBrand]: true;
  readonly text: string;
}
export interface RsUseTree {
  readonly [useTreeBrand]: true;
  readonly text: string;
}
export type RsMacroRole = "matcher" | "transcriber";
export interface RsMacroToken<Role extends RsMacroRole> {
  readonly [macroTokenBrand]: Role;
  readonly text: string;
}
export interface RsMacroGroup<Role extends RsMacroRole> extends RsMacroToken<Role> {
  readonly [macroGroupBrand]: true;
}
export interface RsMacroRule {
  readonly matcher: RsMacroGroup<"matcher">;
  readonly transcriber: RsMacroGroup<"transcriber">;
}
const expr = (text: string): RsExpr => Object.freeze({ [brand]: "RsExpr", text }) as RsExpr;
const stmt = (text: string): RsStmt => Object.freeze({ [brand]: "RsStmt", text }) as RsStmt;
const item = (text: string): RsItem => Object.freeze({ [brand]: "RsItem", text }) as RsItem;
const type_ = (text: string): RsType => Object.freeze({ [brand]: "RsType", text }) as RsType;
const pat = (text: string): RsPat => Object.freeze({ [brand]: "RsPat", text }) as RsPat;
const path = (root: RsPathRoot, segments: ReadonlyArray<RustIdent>): RsPath => {
  if (segments.length === 0 && root === "relative")
    throw new TypeError("Relative Rust paths need at least one segment");
  const prefix = root === "relative" ? "" : root === "absolute" ? "::" : `${root}::`;
  const suffix = segments.map((segment) => segment.text).join("::");
  return Object.freeze({
    [pathBrand]: true as const,
    root,
    segments: Object.freeze([...segments]),
    text: segments.length === 0 ? (root === "absolute" ? "::" : root) : `${prefix}${suffix}`,
  });
};
const visibility = (text: string): RsVisibility =>
  Object.freeze({ [visibilityBrand]: true as const, text });
const privateVisibility = visibility("");
const useTree = (text: string): RsUseTree => Object.freeze({ [useTreeBrand]: true as const, text });
const moduleFile = (text: string): RsModuleFile =>
  Object.freeze({ [fileBrand]: true as const, text });
const attribute = (text: string): RsAttribute =>
  Object.freeze({ [attributeBrand]: true as const, text });
const macroToken = <Role extends RsMacroRole>(role: Role, text: string): RsMacroToken<Role> =>
  Object.freeze({ [macroTokenBrand]: role, text });
const macroGroup = <Role extends RsMacroRole>(
  role: Role,
  delimiter: "()" | "[]" | "{}",
  tokens: ReadonlyArray<RsMacroToken<Role>>,
): RsMacroGroup<Role> => {
  if (tokens.some((token) => token[macroTokenBrand] !== role))
    throw new TypeError(`Macro ${role} groups cannot contain tokens of another role`);
  const [open, close] = delimiter;
  return Object.freeze({
    [macroTokenBrand]: role,
    [macroGroupBrand]: true as const,
    text: `${open}${tokens.map((token) => token.text).join(" ")}${close}`,
  });
};
const useAlias = (alias: RustIdent | "_" | undefined): string =>
  alias === undefined ? "" : ` as ${alias === "_" ? "_" : alias.text}`;
const renderUseVisibility = (visibility: RsVisibility): string =>
  visibility.text.length ? `${visibility.text} ` : "";
const applyVisibility = (access: RsVisibility, target: RsItem): RsItem => {
  if (!access.text) return target;
  const lines = target.text.split("\n");
  let attributeLines = 0;
  while (lines[attributeLines]?.startsWith("#[")) attributeLines++;
  if (/^pub(?:\s|\()/.test(lines[attributeLines] ?? ""))
    throw new TypeError("Rust item visibility can only be applied once");
  lines[attributeLines] = `${access.text} ${lines[attributeLines] ?? ""}`;
  return item(lines.join("\n"));
};
const macroPunctuation = new Set([
  "=>",
  "::",
  ",",
  ";",
  ":",
  "=",
  "!",
  "+",
  "*",
  "?",
  "&",
  "|",
  ".",
  "#",
]);

export class RustIdent {
  private constructor(readonly text: string) {
    Object.freeze(this);
  }
  static make(this: void, text: string): RustIdent {
    if (!RustIdent.pattern.test(text) || text === "_" || RustIdent.keywords.has(text))
      throw new TypeError(`Invalid Rust identifier: ${JSON.stringify(text)}`);
    return new RustIdent(text);
  }
  /** Audited static scaffolding only; keywords are emitted as raw identifiers. */
  static raw(this: void, text: string): RustIdent {
    if (!RustIdent.pattern.test(text) || text === "_" || RustIdent.nonRawKeywords.has(text))
      throw new TypeError(`Invalid Rust identifier: ${JSON.stringify(text)}`);
    return new RustIdent(RustIdent.keywords.has(text) ? `r#${text}` : text);
  }
  private static readonly pattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
  private static readonly keywords = new Set(
    "as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe union use where while async await dyn abstract become box do final macro override priv typeof unsized virtual yield try gen".split(
      " ",
    ),
  );
  private static readonly nonRawKeywords = new Set(["self", "Self", "super", "crate"]);
}

const U64_MAX = (1n << 64n) - 1n;
/** Real Rust string content escaping (`\u{...}` with braces, never braceless `\uXXXX`). */
export const escapeRustContent = (text: string): string =>
  Array.from(text, (c) => {
    if (c === '"') return '\\"';
    if (c === "\\") return "\\\\";
    if (c === "\n") return "\\n";
    if (c === "\r") return "\\r";
    if (c === "\t") return "\\t";
    const code = c.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff))
      return `\\u{${code.toString(16)}}`;
    return c;
  }).join("");
/** Rust char-literal content escaping (`"` stays literal; `'` and controls are escaped). */
export const escapeRustChar = (text: string): string =>
  Array.from(text, (c) => {
    if (c === "'") return "\\'";
    if (c === "\\") return "\\\\";
    if (c === "\n") return "\\n";
    if (c === "\r") return "\\r";
    if (c === "\t") return "\\t";
    const code = c.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff))
      return `\\u{${code.toString(16)}}`;
    return c;
  }).join("");
/** JSON content escaping (braceless `\uXXXX`); for wire text, not Rust literals. */
export const escapeJsonContent = (text: string): string =>
  Array.from(text, (c) => {
    if (c === '"') return '\\"';
    if (c === "\\") return "\\\\";
    const code = c.codePointAt(0) ?? 0;
    if (code < 32 || (code >= 0xd800 && code <= 0xdfff))
      return `\\u${code.toString(16).padStart(4, "0")}`;
    return c;
  }).join("");

export interface RsFormat {
  readonly template: string;
  readonly holes: readonly RsExpr[];
}
/**
 * Builds a `println!`/`eprintln!`-style format template: literal text has its
 * braces doubled automatically, and each expression becomes a `{}` hole.
 */
export const formatTemplate = (...parts: ReadonlyArray<string | RsExpr>): RsFormat => {
  const holes: RsExpr[] = [];
  const template = parts
    .map((part) =>
      typeof part === "string"
        ? part.replaceAll("{", "{{").replaceAll("}", "}}")
        : (holes.push(part), "{}"),
    )
    .join("");
  return Object.freeze({ template, holes: Object.freeze(holes) });
};

export interface RsParam {
  readonly name: RustIdent;
  readonly type: RsType;
}
export type RsFnArgs<Params extends readonly RsParam[]> = {
  readonly [Index in keyof Params]: RsExpr;
};
export interface RsFunction<Params extends readonly RsParam[] = readonly RsParam[]> {
  readonly item: RsItem;
  readonly call: (...args: RsFnArgs<Params>) => RsExpr;
}

const joinArgs = (args: ReadonlyArray<RsExpr>): string => args.map((a) => a.text).join(", ");
const fragmentTemplate =
  <T extends { readonly text: string }>(wrap: (text: string) => T) =>
  (parts: TemplateStringsArray, ...holes: ReadonlyArray<T>): T =>
    wrap(parts.reduce((text, part, index) => text + part + (holes[index]?.text ?? ""), ""));
const formatMacro = (
  name: "format" | "write" | "println" | "eprintln",
  parts: ReadonlyArray<string | RsExpr>,
): RsExpr => {
  const template = formatTemplate(...parts);
  return expr(
    `${name}!(${[
      `"${escapeRustContent(template.template)}"`,
      ...template.holes.map((hole) => hole.text),
    ].join(", ")})`,
  );
};
const methodCall = (
  receiver: RsExpr,
  name: RustIdent,
  args: ReadonlyArray<RsExpr>,
  turboTypes: ReadonlyArray<RsType> = [],
): RsExpr =>
  expr(
    `(${receiver.text}).${name.text}${turboTypes.length ? `::<${turboTypes.map((t) => t.text).join(", ")}>` : ""}(${joinArgs(args)})`,
  );
const dotCall = (
  receiver: RsExpr,
  name: RustIdent,
  args: ReadonlyArray<RsExpr>,
  turboTypes: ReadonlyArray<RsType> = [],
): RsExpr =>
  expr(
    `${receiver.text}.${name.text}${turboTypes.length ? `::<${turboTypes.map((t) => t.text).join(", ")}>` : ""}(${joinArgs(args)})`,
  );

export const Rs = Object.freeze({
  ident: RustIdent.make,
  rawIdent: RustIdent.raw,
  exprTemplate: fragmentTemplate(expr),
  typeTemplate: fragmentTemplate(type_),
  patTemplate: fragmentTemplate(pat),
  itemTemplate: fragmentTemplate(item),
  path: (segments: ReadonlyArray<RustIdent>): RsPath => path("relative", segments),
  cratePath: (segments: ReadonlyArray<RustIdent> = []): RsPath => path("crate", segments),
  selfPath: (segments: ReadonlyArray<RustIdent> = []): RsPath => path("self", segments),
  superPath: (segments: ReadonlyArray<RustIdent> = []): RsPath => path("super", segments),
  absolutePath: (segments: ReadonlyArray<RustIdent>): RsPath => path("absolute", segments),
  visibility: Object.freeze({
    private: privateVisibility,
    public: visibility("pub"),
    crate: visibility("pub(crate)"),
    super: visibility("pub(super)"),
    in: (scope: RsPath): RsVisibility => {
      if (scope.root !== "crate" && scope.root !== "self" && scope.root !== "super")
        throw new TypeError("Restricted visibility paths must start with crate, self, or super");
      return visibility(`pub(in ${scope.text})`);
    },
  }),
  namedType: (name: string | RustIdent): RsType => {
    const text = typeof name === "string" ? name : name.text;
    RustIdent.make(text);
    return type_(text);
  },
  unitType: (): RsType => type_("()"),
  boolType: (): RsType => type_("bool"),
  u64Type: (): RsType => type_("u64"),
  u8Type: (): RsType => type_("u8"),
  usizeType: (): RsType => type_("usize"),
  stringType: (): RsType => type_("String"),
  strType: (): RsType => type_("str"),
  unit: (): RsExpr => expr("()"),
  optionType: (inner: RsType): RsType => type_(`Option<${inner.text}>`),
  boxType: (inner: RsType): RsType => type_(`Box<${inner.text}>`),
  strRefType: (): RsType => type_("&'static str"),
  pathType: (segments: ReadonlyArray<RustIdent>): RsType => {
    if (segments.length === 0) throw new TypeError("Type paths need at least one segment");
    return type_(segments.map((s) => s.text).join("::"));
  },
  genericType: (path: RsPath | RsType, args: ReadonlyArray<RsType>): RsType => {
    if (args.length === 0) throw new TypeError("Generic types need at least one argument");
    return type_(`${path.text}<${args.map((arg) => arg.text).join(", ")}>`);
  },
  pathExpr: (path: RsPath): RsExpr => expr(path.text),
  attribute: (name: RustIdent): RsAttribute => attribute(`#[${name.text}]`),
  deriveAttribute: (...traits: ReadonlyArray<RustIdent>): RsAttribute => {
    if (traits.length === 0) throw new TypeError("derive attributes need at least one trait");
    return attribute(`#[derive(${traits.map((trait) => trait.text).join(", ")})]`);
  },
  cfgFeatureAttribute: (feature: string): RsAttribute =>
    attribute(`#[cfg(feature = "${escapeRustContent(feature)}")]`),
  allowAttribute: (lint: RustIdent): RsAttribute => attribute(`#[allow(${lint.text})]`),
  vecType: (inner: RsType): RsType => type_(`Vec<${inner.text}>`),
  tupleType: (members: ReadonlyArray<RsType>): RsType =>
    type_(`(${members.map((m) => m.text).join(", ")})`),
  resultType: (ok: RsType, err: RsType): RsType => type_(`Result<${ok.text}, ${err.text}>`),
  ok: (value: RsExpr): RsExpr => expr(`Ok(${value.text})`),
  err: (value: RsExpr): RsExpr => expr(`Err(${value.text})`),
  refType: (inner: RsType): RsType => type_(`&${inner.text}`),
  mutRefType: (inner: RsType): RsType => type_(`&mut ${inner.text}`),
  arrayType: (inner: RsType, length: number): RsType => {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("Invalid array length");
    return type_(`[${inner.text}; ${length}]`);
  },
  verbatimType: (text: string): RsType => {
    if (!text.length) throw new TypeError("Verbatim types cannot be empty");
    return type_(text);
  },
  litU64: (value: bigint): RsExpr => {
    if (value < 0n || value > U64_MAX)
      throw new RangeError(`u64 literal out of range: ${String(value)}`);
    return expr(`${String(value)}u64`);
  },
  litInt: (value: number): RsExpr => {
    if (!Number.isSafeInteger(value))
      throw new RangeError(`Integer literal must be a safe integer: ${String(value)}`);
    return expr(String(value));
  },
  litU8: (value: number): RsExpr => {
    if (!Number.isInteger(value) || value < 0 || value > 255)
      throw new RangeError(`u8 literal out of range: ${String(value)}`);
    return expr(`${String(value)}u8`);
  },
  litBool: (value: boolean): RsExpr => expr(value ? "true" : "false"),
  litUnit: (): RsExpr => expr("()"),
  litChar: (value: string): RsExpr => {
    const scalars = Array.from(value);
    if (scalars.length !== 1)
      throw new TypeError(
        `Rust character literals need exactly one Unicode scalar: ${JSON.stringify(value)}`,
      );
    return expr(`'${escapeRustChar(value)}'`);
  },
  identExpr: (name: RustIdent): RsExpr => expr(name.text),
  stringLiteral: (text: string): RsExpr => expr(`"${escapeRustContent(text)}"`),
  tuple: (...members: ReadonlyArray<RsExpr>): RsExpr =>
    expr(`(${members.map((m) => m.text).join(", ")})`),
  vecLit: (...members: ReadonlyArray<RsExpr>): RsExpr =>
    expr(`vec![${members.map((m) => m.text).join(", ")}]`),
  call: (callee: RsExpr, args: ReadonlyArray<RsExpr>): RsExpr =>
    expr(`${callee.text}(${joinArgs(args)})`),
  pathCall: (
    segments: ReadonlyArray<RustIdent>,
    method: RustIdent,
    args: ReadonlyArray<RsExpr>,
  ): RsExpr => {
    if (segments.length === 0) throw new TypeError("Path calls need at least one segment");
    return expr(`${segments.map((s) => s.text).join("::")}::${method.text}(${joinArgs(args)})`);
  },
  method: methodCall,
  /** `receiver.name(args)` without precedence parentheses; the receiver must already be atomic. */
  dotCall,
  /** Fluent `a.b(x).c(y)` chain; each receiver is the previous call's result. */
  dotChain: (
    receiver: RsExpr,
    steps: ReadonlyArray<{
      readonly method: RustIdent;
      readonly args: ReadonlyArray<RsExpr>;
      readonly turboTypes?: ReadonlyArray<RsType>;
    }>,
  ): RsExpr =>
    steps.reduce(
      (current, step) => dotCall(current, step.method, step.args, step.turboTypes),
      receiver,
    ),
  chain: (
    receiver: RsExpr,
    steps: ReadonlyArray<{
      readonly method: RustIdent;
      readonly args: ReadonlyArray<RsExpr>;
      readonly turboTypes?: ReadonlyArray<RsType>;
    }>,
  ): RsExpr =>
    steps.reduce(
      (current, step) => methodCall(current, step.method, step.args, step.turboTypes),
      receiver,
    ),
  some: (value: RsExpr): RsExpr => expr(`Some(${value.text})`),
  none: (): RsExpr => expr("None"),
  optionMap: (value: RsExpr, f: RsExpr): RsExpr => methodCall(value, RustIdent.make("map"), [f]),
  optionAndThen: (value: RsExpr, f: RsExpr): RsExpr =>
    methodCall(value, RustIdent.make("and_then"), [f]),
  optionOkOr: (value: RsExpr, error: RsExpr): RsExpr =>
    methodCall(value, RustIdent.make("ok_or"), [error]),
  resultMap: (value: RsExpr, f: RsExpr): RsExpr => methodCall(value, RustIdent.make("map"), [f]),
  resultMapErr: (value: RsExpr, f: RsExpr): RsExpr =>
    methodCall(value, RustIdent.make("map_err"), [f]),
  unwrap: (value: RsExpr): RsExpr => methodCall(value, RustIdent.make("unwrap"), []),
  expect: (value: RsExpr, message: string): RsExpr =>
    methodCall(value, RustIdent.make("expect"), [expr(`"${escapeRustContent(message)}"`)]),
  toString: (value: RsExpr): RsExpr => methodCall(value, RustIdent.make("to_string"), []),
  iter: (value: RsExpr): RsExpr => methodCall(value, RustIdent.make("iter"), []),
  iterMut: (value: RsExpr): RsExpr => methodCall(value, RustIdent.make("iter_mut"), []),
  intoIter: (value: RsExpr): RsExpr => methodCall(value, RustIdent.make("into_iter"), []),
  enumerate: (value: RsExpr): RsExpr => methodCall(value, RustIdent.make("enumerate"), []),
  collect: (value: RsExpr, target: RsType): RsExpr =>
    methodCall(value, RustIdent.make("collect"), [], [target]),
  unwrapOrElse: (value: RsExpr, fallback: RsExpr): RsExpr =>
    methodCall(value, RustIdent.make("unwrap_or_else"), [fallback]),
  isSome: (value: RsExpr): RsExpr => methodCall(value, RustIdent.make("is_some"), []),
  isNone: (value: RsExpr): RsExpr => methodCall(value, RustIdent.make("is_none"), []),
  isOk: (value: RsExpr): RsExpr => methodCall(value, RustIdent.make("is_ok"), []),
  isErr: (value: RsExpr): RsExpr => methodCall(value, RustIdent.make("is_err"), []),
  binary: (
    left: RsExpr,
    operator: "==" | "!=" | "<" | ">" | "+" | "-" | "&&" | "||",
    right: RsExpr,
  ): RsExpr => expr(`(${left.text}) ${operator} (${right.text})`),
  /** `left op right` without precedence parentheses; operands must already be atomic. */
  cmp: (left: RsExpr, operator: "==" | "!=" | "<" | ">" | "<=" | ">=", right: RsExpr): RsExpr =>
    expr(`${left.text} ${operator} ${right.text}`),
  cast: (value: RsExpr, target: RsType): RsExpr => expr(`(${value.text}) as ${target.text}`),
  await: (value: RsExpr): RsExpr => expr(`${value.text}.await`),
  awaitTry: (value: RsExpr): RsExpr => expr(`${value.text}.await?`),
  struct: (name: RustIdent, fields: ReadonlyArray<readonly [RustIdent, RsExpr]>): RsExpr =>
    expr(`${name.text} { ${fields.map(([k, v]) => `${k.text}: ${v.text}`).join(", ")} }`),
  array: (...members: ReadonlyArray<RsExpr>): RsExpr => expr(`[${joinArgs(members)}]`),
  range: (start: RsExpr, end: RsExpr): RsExpr => expr(`${start.text}..${end.text}`),
  unwrapOr: (value: RsExpr, fallback: RsExpr): RsExpr =>
    expr(`(${value.text}).unwrap_or(${fallback.text})`),
  push: (target: RsExpr, value: RsExpr): RsExpr => expr(`(${target.text}).push(${value.text})`),
  macroCall: (
    name: RustIdent,
    args: ReadonlyArray<RsExpr>,
    brackets: "(" | "[" | "{" = "(",
  ): RsExpr => {
    const [open, close] =
      brackets === "(" ? ["(", ")"] : brackets === "[" ? ["[", "]"] : ["{", "}"];
    return expr(`${name.text}!${open}${joinArgs(args)}${close}`);
  },
  field: (value: RsExpr, name: RustIdent): RsExpr => expr(`${value.text}.${name.text}`),
  tupleField: (value: RsExpr, index: number): RsExpr => {
    if (!Number.isInteger(index) || index < 0)
      throw new RangeError(`Tuple index must be a non-negative integer: ${String(index)}`);
    return expr(`${value.text}.${String(index)}`);
  },
  index: (value: RsExpr, index: number): RsExpr => {
    if (!Number.isInteger(index) || index < 0)
      throw new RangeError(`Index must be a non-negative integer: ${String(index)}`);
    return expr(`${value.text}[${String(index)}]`);
  },
  prefix: (operator: "!" | "*" | "&", value: RsExpr): RsExpr => expr(`${operator}${value.text}`),
  refExpr: (value: RsExpr): RsExpr => expr(`&${value.text}`),
  mutRefExpr: (value: RsExpr): RsExpr => expr(`&mut ${value.text}`),
  eq: (left: RsExpr, right: RsExpr): RsExpr => expr(`(${left.text}) == (${right.text})`),
  ne: (left: RsExpr, right: RsExpr): RsExpr => expr(`(${left.text}) != (${right.text})`),
  lt: (left: RsExpr, right: RsExpr): RsExpr => expr(`(${left.text}) < (${right.text})`),
  not: (value: RsExpr): RsExpr => expr(`!(${value.text})`),
  closure: (params: RsPat, body: RsExpr): RsExpr => expr(`|${params.text}| ${body.text}`),
  match_: (
    scrutinee: RsExpr,
    arms: ReadonlyArray<{ readonly pat: RsPat; readonly guard?: RsExpr; readonly body: RsExpr }>,
  ): RsExpr =>
    expr(
      `match ${scrutinee.text} { ${arms.map((arm) => `${arm.pat.text}${arm.guard ? ` if ${arm.guard.text}` : ""} => ${arm.body.text}`).join(", ")} }`,
    ),
  if_: (condition: RsExpr, onTrue: RsExpr, onFalse?: RsExpr): RsExpr =>
    expr(
      onFalse === undefined
        ? `if ${condition.text} ${onTrue.text}`
        : `if ${condition.text} ${onTrue.text} else ${onFalse.text}`,
    ),
  ifLet: (pat: RsPat, scrutinee: RsExpr, onTrue: RsExpr, onFalse: RsExpr): RsExpr =>
    expr(`if let ${pat.text} = ${scrutinee.text} ${onTrue.text} else ${onFalse.text}`),
  block: (statements: ReadonlyArray<RsStmt>, tail?: RsExpr): RsExpr =>
    expr(
      `{\n${statements.map((s) => `    ${s.text}\n`).join("")}${tail ? `    ${tail.text}\n` : ""}}`,
    ),
  inlineBlock: (...parts: ReadonlyArray<RsExpr>): RsExpr =>
    expr(`{ ${parts.map((p) => p.text).join(" ")} }`),
  inlineStmtBlock: (...parts: ReadonlyArray<RsStmt>): RsExpr =>
    expr(`{ ${parts.map((p) => p.text).join(" ")} }`),
  stmt: (value: RsExpr): RsStmt => stmt(`${value.text};`),
  blockStmt: (value: RsExpr): RsStmt => stmt(value.text),
  exprStmt: (value: RsExpr): RsStmt => stmt(`${value.text};`),
  itemStmt: (value: RsItem): RsStmt => stmt(value.text),
  let_: (name: RustIdent, type: RsType | undefined, init: RsExpr): RsStmt =>
    stmt(
      type ? `let ${name.text}: ${type.text} = ${init.text};` : `let ${name.text} = ${init.text};`,
    ),
  letPat: (pattern: RsPat, type: RsType | undefined, init: RsExpr): RsStmt =>
    stmt(
      type
        ? `let ${pattern.text}: ${type.text} = ${init.text};`
        : `let ${pattern.text} = ${init.text};`,
    ),
  letMut: (name: RustIdent, type: RsType | undefined, init: RsExpr): RsStmt =>
    stmt(
      type
        ? `let mut ${name.text}: ${type.text} = ${init.text};`
        : `let mut ${name.text} = ${init.text};`,
    ),
  letDiscard: (type: RsType, init: RsExpr): RsStmt => stmt(`let _: ${type.text} = ${init.text};`),
  pat: (text: string): RsPat => {
    if (!text.length || /[{;}]/.test(text))
      throw new TypeError(`Invalid Rust pattern: ${JSON.stringify(text)}`);
    return pat(text);
  },
  wildcardPat: (): RsPat => pat("_"),
  identPat: (name: RustIdent): RsPat => pat(name.text),
  stringPat: (text: string): RsPat => pat(`"${escapeRustContent(text)}"`),
  tuplePat: (...members: ReadonlyArray<RsPat>): RsPat =>
    pat(`(${members.map((member) => member.text).join(", ")})`),
  variantPat: (path: ReadonlyArray<RustIdent>, members: ReadonlyArray<RsPat> = []): RsPat => {
    if (!path.length) throw new TypeError("Variant patterns need a path");
    return pat(
      `${path.map((segment) => segment.text).join("::")}${members.length ? `(${members.map((member) => member.text).join(", ")})` : ""}`,
    );
  },
  fnItem: (name: RustIdent, params: ReadonlyArray<RsParam>, ret: RsType, body: RsExpr): RsItem =>
    item(
      `fn ${name.text}(${params.map((p) => `${p.name.text}: ${p.type.text}`).join(", ")})${ret.text === "()" ? "" : ` -> ${ret.text}`} ${body.text}`,
    ),
  enumItem: (
    name: RustIdent,
    variants: ReadonlyArray<{ readonly name: RustIdent; readonly fields?: readonly RsType[] }>,
  ): RsItem => {
    if (variants.length === 0) throw new TypeError("Rust enums need at least one variant");
    const seen = new Set<string>();
    const body = variants
      .map((variant) => {
        if (seen.has(variant.name.text))
          throw new TypeError(`Duplicate Rust enum variant: ${variant.name.text}`);
        seen.add(variant.name.text);
        return variant.fields
          ? `${variant.name.text}(${variant.fields.map((field) => field.text).join(", ")})`
          : variant.name.text;
      })
      .join(", ");
    return item(`enum ${name.text} { ${body} }`);
  },
  constItem: (name: RustIdent, type: RsType, value: RsExpr): RsItem =>
    item(`const ${name.text}: ${type.text} = ${value.text};`),
  staticItem: (
    name: RustIdent,
    type: RsType,
    value: RsExpr,
    mutable = false,
    access: RsVisibility = privateVisibility,
  ): RsItem =>
    item(
      `${renderUseVisibility(access)}static ${mutable ? "mut " : ""}${name.text}: ${type.text} = ${value.text};`,
    ),
  threadLocalItem: (
    entries: ReadonlyArray<{
      readonly name: RustIdent;
      readonly type: RsType;
      readonly value: RsExpr;
      readonly mutable?: boolean;
    }>,
  ): RsItem => {
    if (entries.length === 0) throw new TypeError("thread_local! needs at least one binding");
    const body = entries
      .map(
        (entry) =>
          `    static ${entry.mutable ? "mut " : ""}${entry.name.text}: ${entry.type.text} = ${entry.value.text};`,
      )
      .join("\n");
    return item(`thread_local! {\n${body}\n}`);
  },
  whileLoop: (condition: RsExpr, body: RsExpr): RsExpr =>
    expr(`while ${condition.text} ${body.text}`),
  letElse: (pattern: RsPat, init: RsExpr, fallback: RsExpr): RsExpr =>
    expr(`let ${pattern.text} = ${init.text} else ${fallback.text}`),
  withVisibility: applyVisibility,
  withAttributes: (attributes: ReadonlyArray<RsAttribute>, target: RsItem): RsItem =>
    item(
      `${attributes.map((value) => value.text).join("\n")}${attributes.length ? "\n" : ""}${target.text}`,
    ),
  useTree: (value: RsPath, alias?: RustIdent | "_"): RsUseTree =>
    useTree(`${value.text}${useAlias(alias)}`),
  useSelf: (alias?: RustIdent | "_"): RsUseTree => useTree(`self${useAlias(alias)}`),
  useGlob: (): RsUseTree => useTree("*"),
  useGroup: (children: ReadonlyArray<RsUseTree>): RsUseTree =>
    useTree(`{${children.map((child) => child.text).join(", ")}}`),
  usePath: (prefix: RsPath, child: RsUseTree): RsUseTree =>
    useTree(`${prefix.text}::${child.text}`),
  useItem: (tree: RsUseTree, access: RsVisibility = privateVisibility): RsItem =>
    item(`${renderUseVisibility(access)}use ${tree.text};`),
  moduleItem: (
    name: RustIdent,
    members: ReadonlyArray<RsItem>,
    access: RsVisibility = privateVisibility,
  ): RsItem => {
    if (members.length === 0) return item(`${renderUseVisibility(access)}mod ${name.text} {}`);
    const body = members
      .map((member) =>
        member.text
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n"),
      )
      .join("\n\n");
    return item(`${renderUseVisibility(access)}mod ${name.text} {\n${body}\n}`);
  },
  externalModuleItem: (name: RustIdent, access: RsVisibility = privateVisibility): RsItem =>
    item(`${renderUseVisibility(access)}mod ${name.text};`),
  moduleFile: (members: ReadonlyArray<RsItem>): RsModuleFile =>
    moduleFile(members.map((member) => member.text).join("\n\n") + (members.length ? "\n" : "")),
  /** Joins items with an explicit separator; `moduleFile` is the double-newline default. */
  itemsText: (members: ReadonlyArray<RsItem>, separator = "\n\n"): RsModuleFile =>
    moduleFile(members.map((member) => member.text).join(separator) + (members.length ? "\n" : "")),
  macroIdent: <Role extends RsMacroRole>(role: Role, name: RustIdent): RsMacroToken<Role> =>
    macroToken(role, name.text),
  macroLiteral: <Role extends RsMacroRole>(
    role: Role,
    value: bigint | number | boolean | string,
  ): RsMacroToken<Role> => {
    if (typeof value === "bigint") return macroToken(role, Rs.litU64(value).text);
    if (typeof value === "number") return macroToken(role, Rs.litInt(value).text);
    if (typeof value === "boolean") return macroToken(role, Rs.litBool(value).text);
    return macroToken(role, Rs.stringLiteral(value).text);
  },
  macroPunct: <Role extends RsMacroRole>(
    role: Role,
    punct: "=>" | "::" | "," | ";" | ":" | "=" | "!" | "+" | "*" | "?" | "&" | "|" | "." | "#",
  ): RsMacroToken<Role> => macroToken(role, punct),
  macroFragment: (
    name: RustIdent,
    kind:
      | "block"
      | "expr"
      | "expr_2021"
      | "ident"
      | "item"
      | "lifetime"
      | "literal"
      | "meta"
      | "pat"
      | "pat_param"
      | "path"
      | "stmt"
      | "tt"
      | "ty"
      | "vis",
  ): RsMacroToken<"matcher"> => macroToken("matcher", `$${name.text}:${kind}`),
  macroRef: (name: RustIdent): RsMacroToken<"transcriber"> =>
    macroToken("transcriber", `$${name.text}`),
  macroGroup,
  macroRepeat: <Role extends RsMacroRole>(
    role: Role,
    contents: RsMacroGroup<Role>,
    repeat: "*" | "+" | "?",
    separator?: RsMacroToken<Role>,
  ): RsMacroToken<Role> => {
    if (contents[macroTokenBrand] !== role || contents[macroGroupBrand] !== true)
      throw new TypeError(`Macro ${role} repetition needs a matching token-tree group`);
    if (separator && separator[macroTokenBrand] !== role)
      throw new TypeError(`Macro ${role} repetition needs a matching separator token`);
    if (separator && !macroPunctuation.has(separator.text))
      throw new TypeError("Macro repetition separators must be a single punctuation token");
    if (separator && ["*", "+", "?"].includes(separator.text))
      throw new TypeError("Macro repetition operators cannot be separators");
    if (repeat === "?" && separator)
      throw new TypeError("Optional macro repetitions cannot have a separator");
    return macroToken(role, `$${contents.text}${separator?.text ?? ""}${repeat}`);
  },
  macroRule: (
    matcher: RsMacroGroup<"matcher">,
    transcriber: RsMacroGroup<"transcriber">,
  ): RsMacroRule => {
    if (matcher[macroTokenBrand] !== "matcher" || matcher[macroGroupBrand] !== true)
      throw new TypeError("Macro rules require a matcher-role group");
    if (transcriber[macroTokenBrand] !== "transcriber" || transcriber[macroGroupBrand] !== true)
      throw new TypeError("Macro rules require a transcriber-role group");
    return Object.freeze({ matcher, transcriber });
  },
  macroRulesItem: (
    name: RustIdent,
    rules: ReadonlyArray<RsMacroRule>,
    options: { readonly exported?: boolean } = {},
  ): RsItem => {
    if (rules.length === 0) throw new TypeError("macro_rules! definitions need at least one rule");
    const prefix = options.exported ? "#[macro_export]\n" : "";
    const body = rules
      .map((rule) => `    ${rule.matcher.text} => ${rule.transcriber.text};`)
      .join("\n");
    return item(`${prefix}macro_rules! ${name.text} {\n${body}\n}`);
  },
  defineFn: <const Params extends readonly RsParam[]>(
    name: RustIdent,
    params: Params,
    ret: RsType,
    body: (arg: (name: RustIdent) => RsExpr) => RsExpr,
  ): RsFunction<Params> => {
    const names = new Set<string>();
    const symbolic = new Map<string, RsExpr>();
    for (const parameter of params) {
      if (names.has(parameter.name.text))
        throw new TypeError(`Duplicate Rust function parameter: ${parameter.name.text}`);
      names.add(parameter.name.text);
      symbolic.set(parameter.name.text, expr(parameter.name.text));
    }
    const arg = (parameter: RustIdent): RsExpr => {
      const value = symbolic.get(parameter.text);
      if (value === undefined)
        throw new TypeError(`Unknown Rust function parameter: ${parameter.text}`);
      return value;
    };
    const item_ = Rs.fnItem(name, params, ret, body(arg));
    const call = (...args: RsFnArgs<Params>): RsExpr => {
      if (args.length !== params.length)
        throw new TypeError(`${name.text} expects ${params.length} arguments, got ${args.length}`);
      return expr(`${name.text}(${joinArgs(args)})`);
    };
    return Object.freeze({ item: item_, call });
  },
  forLoop: (pat: RsPat, iter: RsExpr, body: RsExpr): RsExpr =>
    expr(`for ${pat.text} in ${iter.text} ${body.text}`),
  return_: (value: RsExpr): RsExpr => expr(`return ${value.text}`),
  try_: (value: RsExpr): RsExpr => expr(`${value.text}?`),
  unreachableMatch: (value: RsExpr): RsExpr => expr(`match ${value.text} {}`),
  assign: (target: RsExpr, value: RsExpr): RsStmt => stmt(`${target.text} = ${value.text};`),
  assignExpr: (target: RsExpr, value: RsExpr): RsExpr => expr(`${target.text} = ${value.text}`),
  pushStmt: (target: RsExpr, value: RsExpr): RsStmt => stmt(`${target.text}.push(${value.text});`),
  debugPrint: (value: RsExpr): RsStmt => stmt(`println!("{:?}", ${value.text});`),
  displayPrint: (value: RsExpr, prefix = ""): RsStmt => {
    const template = formatTemplate(prefix, value);
    return stmt(
      `println!(${[`"${escapeRustContent(template.template)}"`, ...template.holes.map((h) => h.text)].join(", ")});`,
    );
  },
  assert: (condition: RsExpr, message?: string): RsStmt =>
    stmt(
      message === undefined
        ? `assert!(${condition.text});`
        : `assert!(${condition.text}, "${escapeRustContent(message)}");`,
    ),
  assertEq: (left: RsExpr, right: RsExpr, message?: string): RsStmt =>
    stmt(
      message === undefined
        ? `assert_eq!(${left.text}, ${right.text});`
        : `assert_eq!(${left.text}, ${right.text}, "${escapeRustContent(message)}");`,
    ),
  stringFrom: (value: RsExpr): RsExpr => expr(`String::from(${value.text})`),
  boxNew: (value: RsExpr): RsExpr => expr(`Box::new(${value.text})`),
  vecWithCapacity: (capacity: RsExpr): RsExpr => expr(`Vec::with_capacity(${capacity.text})`),
  printlnExpr: (...parts: ReadonlyArray<string | RsExpr>): RsExpr => formatMacro("println", parts),
  eprintlnExpr: (...parts: ReadonlyArray<string | RsExpr>): RsExpr =>
    formatMacro("eprintln", parts),
  matchBlock: (
    scrutinee: RsExpr,
    arms: ReadonlyArray<{ readonly pat: RsPat; readonly guard?: RsExpr; readonly body: RsExpr }>,
    options: { readonly indent?: number; readonly trailingComma?: boolean } = {},
  ): RsExpr => {
    const indent = options.indent ?? 0;
    const pad = " ".repeat(indent);
    const inner = " ".repeat(indent + 4);
    const comma = options.trailingComma ?? false;
    return expr(
      `match ${scrutinee.text} {\n${arms
        .map(
          (arm, index) =>
            `${inner}${arm.pat.text}${arm.guard ? ` if ${arm.guard.text}` : ""} => ${arm.body.text}${comma || index < arms.length - 1 ? "," : ""}`,
        )
        .join("\n")}\n${pad}}`,
    );
  },
  println: (...parts: ReadonlyArray<string | RsExpr>): RsStmt => {
    return stmt(`${formatMacro("println", parts).text};`);
  },
  eprintln: (...parts: ReadonlyArray<string | RsExpr>): RsStmt => {
    return stmt(`${formatMacro("eprintln", parts).text};`);
  },
  format: (...parts: ReadonlyArray<string | RsExpr>): RsExpr => formatMacro("format", parts),
  write: (target: RsExpr, ...parts: ReadonlyArray<string | RsExpr>): RsExpr => {
    const template = formatTemplate(...parts);
    return expr(
      `write!(${[
        target.text,
        `"${escapeRustContent(template.template)}"`,
        ...template.holes.map((hole) => hole.text),
      ].join(", ")})`,
    );
  },
  verbatimExpr: (text: string): RsExpr => {
    if (!text.length) throw new TypeError("Verbatim expressions cannot be empty");
    return expr(text);
  },
  verbatimStmt: (text: string): RsStmt => {
    if (!text.length) throw new TypeError("Verbatim statements cannot be empty");
    return stmt(text);
  },
  verbatimItem: (text: string): RsItem => {
    if (!text.length) throw new TypeError("Verbatim items cannot be empty");
    return item(text);
  },
});
