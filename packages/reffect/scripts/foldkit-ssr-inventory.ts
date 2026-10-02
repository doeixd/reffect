// Exploratory, non-mutating inventory of the pinned upstream Foldkit SSR graph (NS-1).
// Syntax-only: counts constructs reachable through runtime imports. Not Compile.analyze.
// Run: vp exec node --experimental-transform-types packages/reffect/scripts/foldkit-ssr-inventory.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseAst } from "vite/rolldown/parseAst";
import { R } from "../src/index.ts";

const repository = "https://github.com/foldkit/foldkit.git";
const commit = "0b2a4fd04171afa8c8911d22aa9bec2f22faae52";
const entry = "packages/foldkit/src/experimental/server/index.ts";
const cache = resolve(process.argv[2] ?? ".cache/upstream/foldkit");
const output = resolve(process.argv[3] ?? "docs/research/foldkit-ssr-inventory.json");

const git = (...args: string[]) =>
  execFileSync("git", ["-C", cache, ...args], { encoding: "utf8" }).trim();
if (!existsSync(join(cache, ".git"))) {
  mkdirSync(cache, { recursive: true });
  git("init", "--quiet");
  git("remote", "add", "origin", repository);
}
if (!existsSync(join(cache, entry)) || git("rev-parse", "HEAD") !== commit) {
  git("fetch", "--quiet", "--depth", "1", "origin", commit);
  git("checkout", "--quiet", "--detach", "FETCH_HEAD");
}
if (git("rev-parse", "HEAD") !== commit) throw new Error("Pinned Foldkit commit not checked out");

type Node = { readonly type: string; readonly [key: string]: unknown };
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";
const children = (node: Node): Node[] =>
  Object.entries(node).flatMap(([key, value]) =>
    key === "typeAnnotation" || key === "returnType" || key === "typeParameters"
      ? []
      : Array.isArray(value)
        ? value.filter(isNode)
        : isNode(value)
          ? [value]
          : [],
  );

const resolveImport = (from: string, specifier: string): string | undefined => {
  const base = resolve(dirname(from), specifier.replace(/\.js$/, ""));
  return [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(existsSync);
};

// Runtime edges only: `import type`, all-type specifier lists and type re-exports are skipped.
const runtimeSource = (node: Node): string | undefined => {
  if (
    (node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration") &&
    isNode(node.source)
  ) {
    if (node.importKind === "type" || node.exportKind === "type") return undefined;
    const specifiers = (node.specifiers as Node[] | undefined) ?? [];
    if (
      specifiers.length > 0 &&
      specifiers.every((s) => s.importKind === "type" || s.exportKind === "type")
    )
      return undefined;
    return String(node.source.value);
  }
  if (node.type === "ImportExpression" && isNode(node.source) && node.source.type === "Literal")
    return String(node.source.value);
  return undefined;
};

const counts = {
  effect: new Map<string, number>(),
  language: new Map<string, number>(),
  globals: new Map<string, number>(),
  methods: new Map<string, number>(),
  external: new Map<string, number>(),
};
const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
const language: Record<string, string> = {
  IfStatement: "if/else",
  ConditionalExpression: "ternary",
  SwitchStatement: "switch",
  ForStatement: "for",
  ForOfStatement: "for-of",
  ForInStatement: "for-in",
  WhileStatement: "while",
  DoWhileStatement: "do-while",
  TryStatement: "try",
  ThrowStatement: "throw",
  ClassDeclaration: "class",
  ClassExpression: "class",
  FunctionDeclaration: "function declaration",
  ArrowFunctionExpression: "closure",
  FunctionExpression: "closure",
  SpreadElement: "spread",
  ChainExpression: "optional chaining",
  TemplateLiteral: "template literal",
  UpdateExpression: "++/--",
  AwaitExpression: "await",
  ObjectExpression: "object literal",
  ArrayExpression: "array literal",
  ArrayPattern: "destructuring",
  ObjectPattern: "destructuring",
};
const trackedMethods = new Set([
  "map",
  "filter",
  "flatMap",
  "reduce",
  "forEach",
  "some",
  "every",
  "find",
  "findIndex",
  "includes",
  "indexOf",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "slice",
  "join",
  "sort",
  "reverse",
  "concat",
  "get",
  "set",
  "has",
  "delete",
  "add",
  "split",
  "replace",
  "replaceAll",
  "startsWith",
  "endsWith",
  "trim",
  "toLowerCase",
  "toUpperCase",
  "charCodeAt",
  "codePointAt",
  "test",
  "exec",
  "match",
  "matchAll",
]);
const globalNamespaces = new Set(["JSON", "Object", "Math", "Number", "Reflect", "Symbol"]);

const visited = new Set<string>();
const queue = [join(cache, entry)];
while (queue.length > 0) {
  const file = queue.shift()!;
  if (visited.has(file)) continue;
  visited.add(file);
  const program = parseAst(readFileSync(file, "utf8"), { lang: "ts" }) as unknown as Node;
  const effectLocals = new Map<string, string>();
  const walk = (node: Node) => {
    const source = runtimeSource(node);
    if (source !== undefined) {
      if (source.startsWith(".")) {
        const target = resolveImport(file, source);
        if (target) queue.push(target);
        else bump(counts.external, `unresolved:${source}`);
      } else
        bump(
          counts.external,
          source
            .split("/")
            .slice(0, source.startsWith("@") ? 2 : 1)
            .join("/"),
        );
      if (
        node.type === "ImportDeclaration" &&
        (source === "effect" || source.startsWith("effect/"))
      )
        for (const specifier of (node.specifiers as Node[]) ?? [])
          if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type")
            effectLocals.set(
              String((specifier.local as Node).name),
              String((specifier.imported as Node).name),
            );
    }
    const label = language[node.type];
    if (label) bump(counts.language, label);
    if (node.type === "LogicalExpression" && node.operator === "??") bump(counts.language, "??");
    if (node.type === "AssignmentExpression")
      bump(
        counts.language,
        isNode(node.left) && node.left.type === "MemberExpression"
          ? "property mutation"
          : "reassignment",
      );
    if (node.type === "YieldExpression" && node.delegate) bump(counts.language, "yield*");
    if (node.type === "Literal" && node.regex) bump(counts.globals, "RegExp literal");
    if (node.type === "NewExpression" && isNode(node.callee) && node.callee.type === "Identifier")
      bump(counts.globals, `new ${String(node.callee.name)}`);
    if (node.type === "MemberExpression" && isNode(node.object) && isNode(node.property)) {
      const object = node.object.type === "Identifier" ? String(node.object.name) : undefined;
      const property = node.property.type === "Identifier" ? String(node.property.name) : undefined;
      if (object && property && effectLocals.has(object))
        bump(counts.effect, `${effectLocals.get(object)}.${property}`);
      else if (object && property && globalNamespaces.has(object))
        bump(counts.globals, `${object}.${property}`);
    }
    if (
      node.type === "CallExpression" &&
      isNode(node.callee) &&
      node.callee.type === "MemberExpression" &&
      isNode(node.callee.property) &&
      node.callee.property.type === "Identifier" &&
      trackedMethods.has(String(node.callee.property.name)) &&
      !(
        isNode(node.callee.object) &&
        node.callee.object.type === "Identifier" &&
        effectLocals.has(String(node.callee.object.name))
      )
    )
      bump(counts.methods, `.${String(node.callee.property.name)}()`);
    children(node).forEach(walk);
  };
  walk(program);
}

// Spelling presence only: a same-named R member is not evidence of equivalent semantics.
const spelledInR = (name: string): boolean => {
  const [namespace, member] = name.split(".");
  const value = (R as unknown as Record<string, unknown>)[namespace];
  return typeof value === "object" && value !== null && member in value;
};
const sorted = (map: Map<string, number>) =>
  Object.fromEntries([...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
const files = [...visited].map((file) => relative(cache, file).replaceAll("\\", "/")).sort();
const report = {
  schema: "reffect.foldkit-ssr-inventory@1",
  repository,
  commit,
  entry,
  method: "syntax-only ESTree walk over runtime-import reachability; counts are occurrences",
  files,
  lines: [...visited].reduce((sum, file) => sum + readFileSync(file, "utf8").split("\n").length, 0),
  external: sorted(counts.external),
  effect: Object.fromEntries(
    Object.entries(sorted(counts.effect)).map(([name, count]) => [
      name,
      { count, spelledInR: spelledInR(name) },
    ]),
  ),
  language: sorted(counts.language),
  globals: sorted(counts.globals),
  methods: sorted(counts.methods),
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${files.length} files, ${report.lines} lines -> ${relative(process.cwd(), output)}`);
