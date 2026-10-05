/**
 * Milestone 8B step 2: the pinned upstream Foldkit SSR source to R builders
 * (docs/research/ssr-codemod.md). A partial evaluator over the typed AST: what is known while
 * translating (constants, a component's defaulted config, helper functions, conditionals over
 * them) is evaluated; what depends on the request or the Model becomes R builder code. The result
 * is a TypeScript module of `R` builders, compiled like a hand-written 8A page.
 *
 * Only the server-reachable graph from the entry's `renderPage` is read. Anything outside the
 * admitted subset is refused with its file and position: the translator never guesses.
 */
import { relative } from "node:path";
import { fail } from "./kernel.ts";
import { STRING_ATTRIBUTES, BOOLEAN_ATTRIBUTES } from "./html-ir.ts";
import { SyntaxKind, openFrontend } from "./ts-frontend.ts";
import type { Frontend, Identifier, Node } from "./ts-frontend.ts";

/** What the translation needs that the source does not state. */
export interface TranslateOptions {
  /** The project's tsconfig, which also maps `@foldkit/ui` when it is vendored. */
  readonly tsconfig: string;
  /** The server entry module, holding `renderPage`. */
  readonly entry: string;
  /** How the generated module imports reffect's `R` and its types. */
  readonly reffect: { readonly authoring: string; readonly kernel: string };
  /** The build id the Vite plugin would inject into `renderToString`. */
  readonly buildId: string;
  /** Recorded in the generated header: where the source comes from. */
  readonly provenance: string;
}

// ---- Values the evaluator works with.

/** An R type the generated code produces, as far as translation needs to know it. */
type Ty =
  | { readonly _tag: "String" }
  | { readonly _tag: "Number" }
  | { readonly _tag: "Bool" }
  | { readonly _tag: "Html" }
  | { readonly _tag: "Attr" }
  | { readonly _tag: "Document" }
  | { readonly _tag: "Page" }
  | { readonly _tag: "Entry" }
  | { readonly _tag: "Record" }
  | { readonly _tag: "Option"; readonly item: Ty }
  | { readonly _tag: "Literals"; readonly literals: readonly string[] }
  | { readonly _tag: "Struct"; readonly code: string; readonly fields: ReadonlyMap<string, Ty> };
type Env = ReadonlyMap<string, V>;
type V =
  | { readonly _tag: "Js"; readonly value: string | number | boolean | null | undefined }
  | { readonly _tag: "Array"; readonly items: readonly V[] }
  | { readonly _tag: "Object"; readonly props: ReadonlyMap<string, V> }
  | { readonly _tag: "Closure"; readonly node: Node; readonly env: Env }
  /** A function implemented here (a library function applied to evaluated arguments). */
  | {
      readonly _tag: "Native";
      readonly name: string;
      readonly apply: (args: readonly V[], at: Node) => V;
    }
  | { readonly _tag: "Library"; readonly module: string; readonly path: readonly string[] }
  | { readonly _tag: "Module"; readonly node: Node }
  | { readonly _tag: "Builder" }
  | { readonly _tag: "MessageUnion"; readonly code: string }
  | { readonly _tag: "Variant"; readonly code: string }
  | { readonly _tag: "Message"; readonly code: string }
  | { readonly _tag: "Response"; readonly status: V; readonly headers: V; readonly body: V }
  | { readonly _tag: "Now" }
  | { readonly _tag: "R"; readonly code: string; readonly ty: Ty };

const js = (value: string | number | boolean | null | undefined): V => ({ _tag: "Js", value });
const r = (code: string, ty: Ty): Extract<V, { _tag: "R" }> => ({ _tag: "R", code, ty });
const T = {
  String: { _tag: "String" },
  Number: { _tag: "Number" },
  Bool: { _tag: "Bool" },
  Html: { _tag: "Html" },
  Attr: { _tag: "Attr" },
  Document: { _tag: "Document" },
  Page: { _tag: "Page" },
  Entry: { _tag: "Entry" },
  Record: { _tag: "Record" },
} as const satisfies Record<string, Ty>;
const quote = (value: string) => JSON.stringify(value);

/** Translates the pinned SSR source into the text of an R builder module. */
export const translateSsr = async (options: TranslateOptions): Promise<string> => {
  const frontend = openFrontend(options.tsconfig);
  try {
    return await translate(frontend, options);
  } finally {
    frontend.close();
  }
};

const translate = async (frontend: Frontend, options: TranslateOptions): Promise<string> => {
  const root = options.tsconfig.replace(/[\\/][^\\/]*$/, "");
  const where = (node: Node) => {
    const file = node.getSourceFile();
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart());
    return `${relative(root, file.fileName).replaceAll("\\", "/")}:${line + 1}:${character + 1}`;
  };
  const refuse = (node: Node, message: string): never => {
    throw fail(
      "UNSUPPORTED_SOURCE",
      "migrate",
      where(node),
      `${message}: ${node.getText().slice(0, 80)}`,
    );
  };
  const field = <A>(node: Node, name: string): A => (node as unknown as Record<string, A>)[name]!;
  const kind = (node: Node) => node.kind;
  const text = (node: Node): string => field<string>(node, "text");

  // ---- The generated module's declarations, each emitted once, in dependency order.
  const declarations: string[] = [];
  const emitted = new Map<Node, V>();
  const usesMessage = { value: false };
  const requestFields = new Set<"url" | "method" | "cookie" | "now">();
  const request = (name: "url" | "method" | "cookie" | "now", ty: Ty) => {
    requestFields.add(name);
    return r(`R.Struct.get(request, ${quote(name)})`, ty);
  };

  // ---- Libraries: what the evaluator knows of a package export, by module and path.
  const loaded = new Map<string, Record<string, unknown>>();
  const importValue = async (module: string, path: readonly string[]) => {
    if (!loaded.has(module)) loaded.set(module, (await import(module)) as Record<string, unknown>);
    let value: unknown = loaded.get(module);
    for (const name of path) value = (value as Record<string, unknown> | undefined)?.[name];
    return value;
  };
  // Constants read from the package itself while translating (a build-time import).
  const constants = new Map<string, unknown>();
  const libraryKey = (module: string, path: readonly string[]) => `${module}#${path.join(".")}`;
  await (async () => {
    for (const [module, path] of [
      ["foldkit/experimental", ["Server", "HOST_METHOD_ANSWERS", "allow"]],
    ] as const)
      constants.set(libraryKey(module, path), await importValue(module, path));
  })();

  // ---- Conversions of values to R code.
  const stringCode = (value: V, at: Node): string => {
    if (value._tag === "Js" && typeof value.value === "string")
      return `R.String.literal(${quote(value.value)})`;
    if (value._tag === "Js" && typeof value.value === "number")
      return `R.String.literal(${quote(String(value.value))})`;
    if (value._tag === "R") {
      if (value.ty._tag === "String") return value.code;
      if (value.ty._tag === "Number") return `R.String.fromNumber(${value.code})`;
      if (value.ty._tag === "Literals")
        return `${literalsCode(value.ty.literals)}.text(${value.code})`;
    }
    return refuse(at, "Not a String the R profile can write");
  };
  const literalsCode = (literals: readonly string[]) =>
    `R.Literals([${literals.map(quote).join(", ")}])`;
  const typedCode = (value: V, ty: Ty, at: Node): string => {
    switch (ty._tag) {
      case "String":
        return stringCode(value, at);
      case "Number":
        if (value._tag === "Js" && typeof value.value === "number")
          return `R.Number.literal(${value.value})`;
        if (value._tag === "R" && value.ty._tag === "Number") return value.code;
        return refuse(at, "Not a Number");
      case "Bool":
        if (value._tag === "Js" && typeof value.value === "boolean")
          return `R.Bool.literal(${value.value})`;
        if (value._tag === "R" && value.ty._tag === "Bool") return value.code;
        return refuse(at, "Not a Boolean");
      case "Literals":
        if (
          value._tag === "Js" &&
          typeof value.value === "string" &&
          ty.literals.includes(value.value)
        )
          return `${literalsCode(ty.literals)}.literal(${quote(value.value)})`;
        if (value._tag === "R" && value.ty._tag === "Literals") return value.code;
        return refuse(at, `Not one of ${ty.literals.join(", ")}`);
      default:
        if (value._tag === "R") return value.code;
        return refuse(at, "Not an R value of the expected type");
    }
  };
  const structMake = (ty: Extract<Ty, { _tag: "Struct" }>, value: V, at: Node) => {
    if (value._tag !== "Object") return refuse(at, "Expected an object literal");
    for (const name of value.props.keys())
      if (!ty.fields.has(name)) refuse(at, `${name} is not a field of ${ty.code}`);
    const fields = [...ty.fields].map(([name, fieldTy]) => {
      const fieldValue = value.props.get(name);
      if (fieldValue === undefined) return refuse(at, `${name} is missing`);
      return `${name}: ${typedCode(fieldValue, fieldTy, at)}`;
    });
    return `${ty.code}.make({ ${fields.join(", ")} })`;
  };

  // ---- Schemas: `Schema.Struct({...})` declarations become R witnesses.
  const schemaOf = (node: Node): { readonly code: string; readonly ty: Ty } => {
    if (kind(node) === SyntaxKind.PropertyAccessExpression) {
      const lib = libraryOf(node);
      if (lib?.module === "effect" && lib.path[0] === "Schema" && lib.path.length === 2) {
        const name = lib.path[1];
        if (name === "Number") return { code: "R.Number", ty: T.Number };
        if (name === "String") return { code: "R.String", ty: T.String };
        if (name === "Boolean") return { code: "R.Bool", ty: T.Bool };
      }
    }
    if (kind(node) === SyntaxKind.CallExpression) {
      const lib = libraryOf(field<Node>(node, "expression"));
      const args = field<readonly Node[]>(node, "arguments");
      if (lib?.module === "effect" && lib.path.join(".") === "Schema.Literals") {
        const items = field<readonly Node[]>(args[0]!, "elements").map((element) =>
          kind(element) === SyntaxKind.StringLiteral ? text(element) : refuse(element, "A literal"),
        );
        return { code: literalsCode(items), ty: { _tag: "Literals", literals: items } };
      }
    }
    return refuse(node, "A schema outside Struct, Number, String, Boolean and string Literals");
  };
  const structWitness = (declaration: Node): V => {
    const known = emitted.get(declaration);
    if (known) return known;
    const name = text(field<Node>(declaration, "name"));
    const init = field<Node>(declaration, "initializer");
    const lib =
      kind(init) === SyntaxKind.CallExpression
        ? libraryOf(field<Node>(init, "expression"))
        : undefined;
    if (lib?.module !== "effect" || lib.path.join(".") !== "Schema.Struct")
      return refuse(init, "A Model or Flags schema is a Schema.Struct");
    const shape = field<readonly Node[]>(init, "arguments")[0]!;
    const fields = new Map<string, Ty>();
    const codes: string[] = [];
    for (const property of field<readonly Node[]>(shape, "properties")) {
      if (kind(property) !== SyntaxKind.PropertyAssignment)
        refuse(property, "A plain struct field");
      const fieldName = text(field<Node>(property, "name"));
      const schema = schemaOf(field<Node>(property, "initializer"));
      fields.set(fieldName, schema.ty);
      codes.push(`${fieldName}: ${schema.code}`);
    }
    declarations.push(`export const ${name} = R.Struct({ ${codes.join(", ")} });`);
    const value: V = r(name, { _tag: "Struct", code: name, fields });
    emitted.set(declaration, value);
    return value;
  };

  // ---- Identifiers and library references.
  const libraryOf = (
    node: Node,
  ): { readonly module: string; readonly path: readonly string[] } | undefined => {
    if (kind(node) === SyntaxKind.Identifier) {
      const origin = frontend.origin(node as Identifier);
      return origin._tag === "Library"
        ? { module: origin.module, path: origin.name === "*" ? [] : [origin.name] }
        : undefined;
    }
    if (kind(node) === SyntaxKind.PropertyAccessExpression) {
      const base = libraryOf(field<Node>(node, "expression"));
      return base && { module: base.module, path: [...base.path, text(field<Node>(node, "name"))] };
    }
    return undefined;
  };
  const declarationValue = (declaration: Node, at: Node): V => {
    if (kind(declaration) === SyntaxKind.SourceFile) return { _tag: "Module", node: declaration };
    if (kind(declaration) === SyntaxKind.FunctionDeclaration)
      return { _tag: "Closure", node: declaration, env: new Map() };
    if (kind(declaration) !== SyntaxKind.VariableDeclaration)
      return refuse(at, "An unsupported binding");
    const init = field<Node | undefined>(declaration, "initializer");
    if (init === undefined) return refuse(at, "A declaration without a value");
    // Schemas and message unions are declarations of the generated module.
    if (kind(init) === SyntaxKind.CallExpression) {
      const callee = libraryOf(field<Node>(init, "expression"));
      if (callee?.module === "effect" && callee.path.join(".") === "Schema.Struct")
        return structWitness(declaration);
      if (callee?.module === "foldkit/message" && callee.path.join(".") === "defineMessageUnion") {
        if (!emitted.has(declaration)) {
          declarations.push(
            `export const ${text(field<Node>(declaration, "name"))} = ${init.getText()};`,
          );
          emitted.set(declaration, {
            _tag: "MessageUnion",
            code: text(field<Node>(declaration, "name")),
          });
          usesMessage.value = true;
        }
        return emitted.get(declaration)!;
      }
    }
    // Top-level constants and functions are evaluated where they are used.
    return evaluate(init, new Map());
  };
  const identifier = (node: Node, env: Env): V => {
    const name = text(node);
    const bound = env.get(name);
    if (bound !== undefined) return bound;
    if (name === "undefined") return js(undefined);
    const origin = frontend.origin(node as Identifier);
    if (origin._tag === "Library")
      return {
        _tag: "Library",
        module: origin.module,
        path: origin.name === "*" ? [] : [origin.name],
      };
    if (origin._tag === "Source") return declarationValue(origin.declaration, node);
    if (name === "globalThis") return { _tag: "Library", module: "globalThis", path: [] };
    return refuse(node, "An identifier the translator cannot resolve");
  };

  // ---- Library functions the profile admits, as natives over evaluated values.
  const lambda = (() => {
    let next = 0;
    return (body: (parameter: V) => V, input: Ty, at: Node) => {
      const name = `v${++next}`;
      const result = body(r(name, input));
      if (result._tag !== "R" && !(result._tag === "Js"))
        return refuse(at, "A callback the profile cannot write");
      return {
        code: `(${name}) => ${result._tag === "R" ? result.code : typedCode(result, T.Number, at)}`,
        result,
      };
    };
  })();
  const callValue = (fn: V, args: readonly V[], at: Node): V => {
    if (fn._tag === "Closure") return applyClosure(fn, args, at);
    if (fn._tag === "Native") return fn.apply(args, at);
    if (fn._tag === "Library") return callLibrary(fn, args, at);
    return refuse(at, "Not a function the translator can call");
  };
  const native = (name: string, apply: (args: readonly V[], at: Node) => V): V => ({
    _tag: "Native",
    name,
    apply,
  });
  const optionItem = (value: V, at: Node): Ty =>
    value._tag === "R" && value.ty._tag === "Option" ? value.ty.item : refuse(at, "Not an Option");
  const callLibrary = (fn: Extract<V, { _tag: "Library" }>, args: readonly V[], at: Node): V => {
    const key = `${fn.module}#${fn.path.join(".")}`;
    switch (key) {
      case "effect#pipe":
        return args.slice(1).reduce((value, step) => callValue(step, [value], at), args[0]!);
      case "effect/http#Cookies.parseHeader":
        return r(`R.Cookies.parseHeader(${stringCode(args[0]!, at)})`, T.Record);
      case "effect#Record.get": {
        const key = args[0]!;
        return native("Record.get", ([self]) =>
          self!._tag === "R" && self!.ty._tag === "Record"
            ? r(`R.Record.get(${self!.code}, ${stringCode(key, at)})`, {
                _tag: "Option",
                item: T.String,
              })
            : refuse(at, "Record.get of a Record"),
        );
      }
      case "effect#Number.parse":
        return r(`R.Number.parse(${stringCode(args[0]!, at)})`, { _tag: "Option", item: T.Number });
      case "globalThis#Number.isSafeInteger":
        return r(`R.Number.isSafeInteger(${typedCode(args[0]!, T.Number, at)})`, T.Bool);
      case "effect#Option.flatMap": {
        const f = args[0]!;
        return native("Option.flatMap", ([self]) => {
          const callback = lambda((item) => callValue(f, [item], at), optionItem(self!, at), at);
          const result = callback.result;
          if (result._tag !== "R" || result.ty._tag !== "Option")
            return refuse(at, "flatMap returns an Option");
          return r(
            `R.Option.flatMap(${(self as Extract<V, { _tag: "R" }>).code}, ${callback.code})`,
            result.ty,
          );
        });
      }
      case "effect#Option.filter": {
        const predicate = args[0]!;
        return native("Option.filter", ([self]) => {
          const item = optionItem(self!, at);
          const callback = lambda((value) => callValue(predicate, [value], at), item, at);
          return r(
            `R.Option.filter(${(self as Extract<V, { _tag: "R" }>).code}, ${callback.code})`,
            { _tag: "Option", item },
          );
        });
      }
      case "effect#Option.getOrElse": {
        const fallback = args[0]!;
        return native("Option.getOrElse", ([self]) => {
          const item = optionItem(self!, at);
          const value = callValue(fallback, [], at);
          return r(
            `R.Option.getOrElse(${(self as Extract<V, { _tag: "R" }>).code}, () => ${typedCode(value, item, at)})`,
            item,
          );
        });
      }
      case "effect#Predicate.isNotUndefined":
        return args[0]!._tag === "R"
          ? refuse(at, "isNotUndefined of an R value")
          : js(!(args[0]!._tag === "Js" && args[0]!.value === undefined));
      default:
        return refuse(
          at,
          `The library function ${fn.module} ${fn.path.join(".")} is outside the profile`,
        );
    }
  };

  // ---- Functions: inlined with their parameters bound to the evaluated arguments.
  const bindPattern = (pattern: Node, value: V, env: Map<string, V>) => {
    if (kind(pattern) === SyntaxKind.Identifier) {
      env.set(text(pattern), value);
      return;
    }
    if (kind(pattern) === SyntaxKind.ObjectBindingPattern) {
      if (value._tag !== "Object")
        return refuse(pattern, "Destructuring needs a value known while translating");
      for (const element of field<readonly Node[]>(pattern, "elements")) {
        const name = field<Node>(element, "name");
        const property = field<Node | undefined>(element, "propertyName") ?? name;
        const initializer = field<Node | undefined>(element, "initializer");
        const found = value.props.get(text(property));
        bindPattern(name, found ?? (initializer ? evaluate(initializer, env) : js(undefined)), env);
      }
      return;
    }
    refuse(pattern, "A binding pattern outside identifiers and object destructuring");
  };
  const applyClosure = (
    closure: Extract<V, { _tag: "Closure" }>,
    args: readonly V[],
    at: Node,
  ): V => {
    const env = new Map(closure.env);
    field<readonly Node[]>(closure.node, "parameters").forEach((parameter, i) => {
      const initializer = field<Node | undefined>(parameter, "initializer");
      const arg = args[i] ?? (initializer ? evaluate(initializer, env) : js(undefined));
      bindPattern(field<Node>(parameter, "name"), arg, env);
    });
    const body = field<Node>(closure.node, "body");
    if (kind(body) !== SyntaxKind.Block) return evaluate(body, env);
    return evaluateBlock(field<readonly Node[]>(body, "statements"), env, at);
  };
  const evaluateBlock = (statements: readonly Node[], env: Map<string, V>, at: Node): V => {
    for (const statement of statements) {
      if (kind(statement) === SyntaxKind.VariableStatement) {
        for (const declaration of field<readonly Node[]>(
          field<Node>(statement, "declarationList"),
          "declarations",
        ))
          bindPattern(
            field<Node>(declaration, "name"),
            evaluate(field<Node>(declaration, "initializer"), env),
            env,
          );
        continue;
      }
      if (kind(statement) === SyntaxKind.ReturnStatement)
        return evaluate(field<Node>(statement, "expression"), env);
      refuse(statement, "A statement outside const declarations and return");
    }
    return refuse(at, "A function body without a return");
  };

  // ---- The Html builder `h`.
  const ELEMENT_NAMES = new Set([
    "a",
    "article",
    "aside",
    "button",
    "div",
    "em",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "header",
    "label",
    "li",
    "main",
    "nav",
    "ol",
    "option",
    "p",
    "pre",
    "section",
    "select",
    "span",
    "strong",
    "textarea",
    "ul",
    "br",
    "hr",
    "input",
  ]);
  const STRINGS = new Set<string>(STRING_ATTRIBUTES);
  const BOOLEANS = new Set<string>(BOOLEAN_ATTRIBUTES);
  const attributeCode = (name: string, args: readonly V[], at: Node): V => {
    const [value] = args;
    if (name === "OnClick" || name === "OnDoubleClick" || name === "OnSubmit") {
      if (value?._tag !== "Message") return refuse(at, "An event takes one of the app's Messages");
      return r(`H.${name}(${value.code})`, T.Attr);
    }
    if (name === "InnerHTML" || name === "Tabindex") {
      if (value?._tag !== "Js") return refuse(at, `${name} takes a value known while translating`);
      return r(`H.${name}(${JSON.stringify(value.value)})`, T.Attr);
    }
    if (name === "DataAttribute") {
      if (value?._tag !== "Js" || typeof value.value !== "string")
        return refuse(at, "A data key is a literal");
      return r(`H.DataAttribute(${quote(value.value)}, ${stringArgument(args[1]!, at)})`, T.Attr);
    }
    if (STRINGS.has(name)) return r(`H.${name}(${stringArgument(value!, at)})`, T.Attr);
    if (BOOLEANS.has(name)) {
      if (value?._tag === "Js" && typeof value.value === "boolean")
        return r(`H.${name}(${value.value})`, T.Attr);
      return r(`H.${name}(${typedCode(value!, T.Bool, at)})`, T.Attr);
    }
    return refuse(at, `The attribute ${name} is outside the profile`);
  };
  // A literal stays a literal where R.Html takes one.
  const stringArgument = (value: V, at: Node) =>
    value._tag === "Js" && typeof value.value === "string"
      ? quote(value.value)
      : stringCode(value, at);
  const childCode = (value: V, at: Node): string => {
    if (value._tag === "Js" && typeof value.value === "string") return quote(value.value);
    if (value._tag === "R" && value.ty._tag === "Html") return value.code;
    return stringCode(value, at);
  };
  const listOf = (value: V, at: Node): readonly V[] =>
    value._tag === "Array" ? value.items : refuse(at, "A list known while translating");
  const builder = (name: string, args: readonly V[], at: Node): V => {
    if (ELEMENT_NAMES.has(name)) {
      const attributes = listOf(args[0] ?? { _tag: "Array", items: [] }, at).map((attribute) =>
        attribute._tag === "R" && attribute.ty._tag === "Attr"
          ? attribute.code
          : refuse(at, "An attribute"),
      );
      const children =
        args[1] === undefined ? [] : listOf(args[1], at).map((child) => childCode(child, at));
      return r(
        args[1] === undefined && attributes.length === 0
          ? `H.${name}([])`
          : `H.${name}([${attributes.join(", ")}]${args[1] === undefined ? "" : `, [${children.join(", ")}]`})`,
        T.Html,
      );
    }
    return attributeCode(name, args, at);
  };

  // ---- Expressions.
  const evaluate = (node: Node, env: Env): V => {
    switch (kind(node)) {
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NoSubstitutionTemplateLiteral:
        return js(text(node));
      case SyntaxKind.NumericLiteral:
        return js(Number(text(node)));
      case SyntaxKind.TrueKeyword:
        return js(true);
      case SyntaxKind.FalseKeyword:
        return js(false);
      case SyntaxKind.NullKeyword:
        return js(null);
      case SyntaxKind.ParenthesizedExpression:
      case SyntaxKind.AsExpression:
      case SyntaxKind.SatisfiesExpression:
        return evaluate(field<Node>(node, "expression"), env);
      case SyntaxKind.Identifier:
        return identifier(node, env);
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.FunctionExpression:
        return { _tag: "Closure", node, env };
      case SyntaxKind.ArrayLiteralExpression: {
        const items: V[] = [];
        for (const element of field<readonly Node[]>(node, "elements")) {
          if (kind(element) === SyntaxKind.SpreadElement)
            items.push(...listOf(evaluate(field<Node>(element, "expression"), env), element));
          else items.push(evaluate(element, env));
        }
        return { _tag: "Array", items };
      }
      case SyntaxKind.ObjectLiteralExpression: {
        const props = new Map<string, V>();
        for (const property of field<readonly Node[]>(node, "properties")) {
          if (kind(property) === SyntaxKind.PropertyAssignment)
            props.set(
              propertyName(field<Node>(property, "name")),
              evaluate(field<Node>(property, "initializer"), env),
            );
          else if (kind(property) === SyntaxKind.ShorthandPropertyAssignment)
            props.set(
              text(field<Node>(property, "name")),
              identifier(field<Node>(property, "name"), env),
            );
          else refuse(property, "An object member outside plain properties");
        }
        return { _tag: "Object", props };
      }
      case SyntaxKind.TemplateExpression: {
        const parts: V[] = [js(text(field<Node>(node, "head")))];
        for (const span of field<readonly Node[]>(node, "templateSpans")) {
          parts.push(evaluate(field<Node>(span, "expression"), env));
          parts.push(js(text(field<Node>(span, "literal"))));
        }
        return concat(parts, node);
      }
      case SyntaxKind.BinaryExpression:
        return binary(node, env);
      case SyntaxKind.PrefixUnaryExpression: {
        const operand = evaluate(field<Node>(node, "operand"), env);
        if (
          field<SyntaxKind>(node, "operator") === SyntaxKind.ExclamationToken &&
          operand._tag === "Js"
        )
          return js(!operand.value);
        return refuse(node, "A unary operator outside ! on a known value");
      }
      case SyntaxKind.ConditionalExpression: {
        const condition = evaluate(field<Node>(node, "condition"), env);
        if (condition._tag === "Js")
          return evaluate(field<Node>(node, condition.value ? "whenTrue" : "whenFalse"), env);
        return refuse(node, "A conditional on a value only the request knows");
      }
      case SyntaxKind.PropertyAccessExpression:
        return property(node, env);
      case SyntaxKind.CallExpression:
        return call(node, env);
      case SyntaxKind.NewExpression:
        return construct(node, env);
      default:
        return refuse(node, `${SyntaxKind[kind(node)]} is outside the translated subset`);
    }
  };
  const propertyName = (name: Node) =>
    kind(name) === SyntaxKind.Identifier || kind(name) === SyntaxKind.StringLiteral
      ? text(name)
      : refuse(name, "A computed property name");
  const concat = (parts: readonly V[], at: Node): V => {
    if (parts.every((part) => part._tag === "Js"))
      return js(parts.map((part) => String((part as { value: unknown }).value)).join(""));
    const codes = parts
      .filter((part) => !(part._tag === "Js" && part.value === ""))
      .map((part) => stringCode(part, at));
    return r(
      codes.slice(1).reduce((left, right) => `R.String.concat(${left}, ${right})`, codes[0]!),
      T.String,
    );
  };
  const binary = (node: Node, env: Env): V => {
    const operator = field<Node>(node, "operatorToken").kind;
    const left = evaluate(field<Node>(node, "left"), env);
    if (operator === SyntaxKind.AmpersandAmpersandToken && left._tag === "Js")
      return left.value ? evaluate(field<Node>(node, "right"), env) : left;
    // `request.headers.get('cookie') ?? ''`: the page's cookie text is already "" when absent.
    if (operator === SyntaxKind.QuestionQuestionToken) {
      const right = evaluate(field<Node>(node, "right"), env);
      if (
        left._tag === "R" &&
        left.code.endsWith(`, "cookie")`) &&
        right._tag === "Js" &&
        right.value === ""
      )
        return left;
      if (left._tag === "Js") return left.value === null || left.value === undefined ? right : left;
      return refuse(node, "?? on a value only the request knows");
    }
    const right = evaluate(field<Node>(node, "right"), env);
    if (operator === SyntaxKind.PlusToken) return concat([left, right], node);
    if (operator === SyntaxKind.EqualsEqualsEqualsToken) {
      if (left._tag === "Js" && right._tag === "Js") return js(left.value === right.value);
      return r(`R.String.eq(${stringCode(left, node)}, ${stringCode(right, node)})`, T.Bool);
    }
    return refuse(node, "A binary operator outside +, ===, && and ??");
  };
  const property = (node: Node, env: Env): V => {
    const name = text(field<Node>(node, "name"));
    const lib = libraryOf(node);
    if (lib !== undefined) {
      const key = libraryKey(lib.module, lib.path);
      if (constants.has(key)) {
        const value = constants.get(key);
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
          return js(value);
      }
      return { _tag: "Library", module: lib.module, path: lib.path };
    }
    const base = evaluate(field<Node>(node, "expression"), env);
    switch (base._tag) {
      case "Object": {
        const found = base.props.get(name);
        return found ?? js(undefined);
      }
      case "Module": {
        const origin = frontend.origin(field<Node>(node, "name") as Identifier);
        if (origin._tag !== "Source")
          return refuse(node, "A module member the translator cannot resolve");
        return declarationValue(origin.declaration, node);
      }
      case "MessageUnion":
        return { _tag: "Variant", code: `${base.code}.${name}` };
      case "Builder":
        return native(`h.${name}`, (args, at) => builder(name, args, at));
      case "Library":
        return { _tag: "Library", module: base.module, path: [...base.path, name] };
      case "Now":
        return refuse(node, "A Date member outside toISOString");
      case "R": {
        // The page request's members are what the host supplies (8B step 1d).
        if (base.code === "request" && name === "method") return request("method", T.String);
        if (base.code === "request" && name === "url") return request("url", T.String);
        if (base.code === "request" && name === "headers")
          return { _tag: "Library", module: "request", path: ["headers"] };
        if (base.code === "request")
          return refuse(node, `The request's ${name} is outside the page request`);
        if (base.ty._tag === "Struct") {
          const ty = base.ty.fields.get(name);
          if (ty === undefined) return refuse(node, `${name} is not a field`);
          return r(`R.Struct.get(${base.code}, ${quote(name)})`, ty);
        }
        return refuse(node, "A member of an R value outside struct fields");
      }
      default:
        return refuse(node, "A member the translator cannot read");
    }
  };
  const call = (node: Node, env: Env): V => {
    const callee = field<Node>(node, "expression");
    const args = field<readonly Node[]>(node, "arguments").map((arg) => evaluate(arg, env));
    // Methods on values the profile knows.
    if (kind(callee) === SyntaxKind.PropertyAccessExpression) {
      const method = text(field<Node>(callee, "name"));
      const receiver = evaluate(field<Node>(callee, "expression"), env);
      if (method === "toString" && receiver._tag === "R" && receiver.ty._tag === "Number")
        return r(`R.String.fromNumber(${receiver.code})`, T.String);
      if (method === "toString" && receiver._tag === "Js") return js(String(receiver.value));
      if (method === "toISOString" && receiver._tag === "Now")
        return r(`R.DateTime.formatIso(${request("now", T.String).code})`, T.String);
      if (receiver._tag === "Library" && receiver.module === "request" && method === "get") {
        const header = args[0];
        if (header?._tag === "Js" && header.value === "cookie") return request("cookie", T.String);
        return refuse(node, "A request header other than cookie");
      }
    }
    const fn = evaluate(callee, env);
    if (fn._tag === "Variant") {
      const fields = args[0];
      const entries =
        fields === undefined
          ? []
          : fields._tag === "Object"
            ? [...fields.props]
            : refuse(node, "Message fields are an object");
      usesMessage.value = true;
      return {
        _tag: "Message",
        code: `H.message(${fn.code}, {${entries.map(([name, value]) => ` ${name}: ${stringCode(value, node)}`).join(",")}${entries.length ? " " : ""}})`,
      };
    }
    return callValue(fn, args, node);
  };
  const construct = (node: Node, env: Env): V => {
    const callee = field<Node>(node, "expression");
    const args = (field<readonly Node[] | undefined>(node, "arguments") ?? []).map((arg) =>
      evaluate(arg, env),
    );
    const name = kind(callee) === SyntaxKind.Identifier ? text(callee) : "";
    if (name === "Date" && args.length === 0) return { _tag: "Now" };
    if (name === "Response") {
      const init = args[1];
      const options = init?._tag === "Object" ? init.props : new Map<string, V>();
      return {
        _tag: "Response",
        body: args[0] ?? js(null),
        status: options.get("status") ?? js(200),
        headers: options.get("headers") ?? { _tag: "Object", props: new Map() },
      };
    }
    return refuse(node, "A constructor outside new Date() and new Response(...)");
  };

  // ---- The page: the entry's renderPage, an Effect.gen body over its request.
  const headersCode = (headers: V, at: Node) => {
    if (headers._tag !== "Object") return refuse(at, "Headers are an object literal");
    const pairs = [...headers.props].map(
      ([name, value]) =>
        `H.Header.make({ name: R.String.literal(${quote(name)}), value: ${stringCode(value, at)} })`,
    );
    return `R.Array.make(${pairs.join(", ")})`;
  };
  const serverFunction = (lib: { readonly module: string; readonly path: readonly string[] }) =>
    lib.module === "foldkit/experimental" && lib.path[0] === "Server"
      ? lib.path.slice(1).join(".")
      : undefined;
  const entryCode = (statements: readonly Node[], env: Map<string, V>, at: Node): string => {
    const [statement, ...rest] = statements;
    if (statement === undefined) return refuse(at, "renderPage's generator returns no entry");
    if (kind(statement) === SyntaxKind.IfStatement) {
      const condition = evaluate(field<Node>(statement, "expression"), env);
      const thenStatement = field<Node>(statement, "thenStatement");
      const thenStatements =
        kind(thenStatement) === SyntaxKind.Block
          ? field<readonly Node[]>(thenStatement, "statements")
          : [thenStatement];
      if (field<Node | undefined>(statement, "elseStatement") !== undefined)
        refuse(statement, "An if with an else");
      return `R.Match.bool(${typedCode(condition, T.Bool, statement)}, ${entryCode(thenStatements, new Map(env), statement)}, ${entryCode(rest, env, statement)})`;
    }
    if (kind(statement) === SyntaxKind.VariableStatement) {
      for (const declaration of field<readonly Node[]>(
        field<Node>(statement, "declarationList"),
        "declarations",
      )) {
        let init = field<Node>(declaration, "initializer");
        if (kind(init) === SyntaxKind.YieldExpression) init = field<Node>(init, "expression");
        env.set(text(field<Node>(declaration, "name")), serverValue(init, env));
      }
      return entryCode(rest, env, statement);
    }
    if (kind(statement) === SyntaxKind.ReturnStatement) {
      const value = serverValue(field<Node>(statement, "expression"), env);
      if (value._tag === "R" && value.ty._tag === "Entry") return value.code;
      return refuse(statement, "renderPage returns Server.Rendered or Server.Responded");
    }
    return refuse(statement, "A renderPage statement outside if/return, const and return");
  };
  // Server's functions, then ordinary evaluation.
  const serverValue = (node: Node, env: Env): V => {
    if (kind(node) === SyntaxKind.CallExpression) {
      const lib = libraryOf(field<Node>(node, "expression"));
      const fn = lib && serverFunction(lib);
      const args = field<readonly Node[]>(node, "arguments");
      if (fn === "renderToString") {
        const program = evaluate(args[0]!, env);
        const options = evaluate(args[1]!, env);
        if (program._tag !== "Object" || options._tag !== "Object")
          return refuse(node, "renderToString's program and options are objects");
        const flagsWitness = program.props.get("Flags");
        if (flagsWitness?._tag !== "R" || flagsWitness.ty._tag !== "Struct")
          return refuse(node, "A program with Flags");
        program.props.get("init");
        const flags = options.props.get("flags");
        if (flags === undefined) return refuse(node, "renderToString's flags");
        return r(
          `H.renderToString({ init, view }, { buildId: ${quote(options_.buildId)}, flags: ${structMake(flagsWitness.ty, flags, node)} })`,
          T.Page,
        );
      }
      if (fn === "Rendered") {
        const page = serverValue(args[0]!, env);
        const settings = args[1] ? evaluate(args[1], env) : undefined;
        if (page._tag !== "R" || page.ty._tag !== "Page")
          return refuse(node, "Rendered of a rendered application");
        const headers = settings?._tag === "Object" ? settings.props.get("headers") : undefined;
        const status = settings?._tag === "Object" ? settings.props.get("status") : undefined;
        const parts = [
          ...(status === undefined ? [] : [`status: ${typedCode(status, T.Number, node)}`]),
          ...(headers === undefined ? [] : [`headers: ${headersCode(headers, node)}`]),
        ];
        return r(
          `H.rendered(${page.code}${parts.length ? `, { ${parts.join(", ")} }` : ""})`,
          T.Entry,
        );
      }
      if (fn === "Responded") {
        const response = evaluate(args[0]!, env);
        if (response._tag !== "Response") return refuse(node, "Responded of a new Response(...)");
        const body =
          response.body._tag === "Js" && response.body.value === null
            ? []
            : [`body: ${stringCode(response.body, node)}`];
        return r(
          `H.responded({ status: ${typedCode(response.status, T.Number, node)}, headers: ${headersCode(response.headers, node)}${body.length ? `, ${body[0]}` : ""} })`,
          T.Entry,
        );
      }
      // An app function returning a server entry (renderPage's helpers) is inlined.
    }
    return evaluate(node, env);
  };
  const options_ = options;

  // ---- From the entry: renderPage(request) => Effect.runPromise(Effect.gen(function* () {...})).
  const entryFile = frontend.file(options.entry);
  const renderPage = entryFile.statements
    .filter((statement) => kind(statement) === SyntaxKind.VariableStatement)
    .flatMap((statement) => [
      ...field<readonly Node[]>(field<Node>(statement, "declarationList"), "declarations"),
    ])
    .find((declaration) => text(field<Node>(declaration, "name")) === "renderPage");
  if (renderPage === undefined)
    throw fail("UNSUPPORTED_SOURCE", "migrate", options.entry, "The entry exports no renderPage");
  const arrow = field<Node>(renderPage, "initializer");
  const run = field<Node>(arrow, "body");
  const runLib =
    kind(run) === SyntaxKind.CallExpression ? libraryOf(field<Node>(run, "expression")) : undefined;
  if (runLib?.module !== "effect" || runLib.path.join(".") !== "Effect.runPromise")
    refuse(run, "renderPage runs Effect.runPromise(Effect.gen(...))");
  const gen = field<readonly Node[]>(run, "arguments")[0]!;
  const genLib =
    kind(gen) === SyntaxKind.CallExpression ? libraryOf(field<Node>(gen, "expression")) : undefined;
  if (genLib?.module !== "effect" || genLib.path.join(".") !== "Effect.gen")
    refuse(gen, "renderPage runs Effect.gen");
  const generator = field<readonly Node[]>(gen, "arguments")[0]!;
  const requestParameter = text(
    field<Node>(field<readonly Node[]>(arrow, "parameters")[0]!, "name"),
  );
  const env = new Map<string, V>([
    [requestParameter, r("request", { _tag: "Struct", code: "request", fields: new Map() })],
  ]);

  // init and view are named callbacks of the generated module; the rest is inlined.
  const callbacks: string[] = [];
  const translateCallback = (name: "init" | "view", declaration: Node) => {
    const closure = declarationValue(declaration, declaration);
    if (closure._tag !== "Closure") return refuse(declaration, `${name} is a function`);
    const parameters = field<readonly Node[]>(closure.node, "parameters");
    if (name === "init") {
      const flags = structWitness(flagsDeclaration!);
      const model = structWitness(modelDeclaration!);
      const parameter = text(field<Node>(parameters[0]!, "name"));
      const result = applyClosure(
        closure,
        [r(parameter, (flags as Extract<V, { _tag: "R" }>).ty)],
        declaration,
      );
      if (result._tag !== "Object") return refuse(declaration, "init returns { model }");
      for (const key of result.props.keys())
        if (key !== "model") refuse(declaration, "init's commands do not run on the server");
      callbacks.push(
        `const init = (${parameter}: Expr<Value<typeof ${flagsDeclarationName}>>) =>\n  ${structMake((model as Extract<V, { _tag: "R" }>).ty as Extract<Ty, { _tag: "Struct" }>, result.props.get("model")!, declaration)};`,
      );
      return;
    }
    const model = structWitness(modelDeclaration!);
    const parameter = text(field<Node>(parameters[0]!, "name"));
    const result = applyClosure(
      closure,
      [r(parameter, (model as Extract<V, { _tag: "R" }>).ty), { _tag: "Builder" }],
      declaration,
    );
    if (result._tag !== "Object") return refuse(declaration, "view returns { title, body }");
    const title = result.props.get("title");
    const body = result.props.get("body");
    if (title === undefined || body?._tag !== "R" || body.ty._tag !== "Html")
      return refuse(declaration, "view returns { title, body }");
    callbacks.push(
      `const view = (${parameter}: Expr<Value<typeof ${modelDeclarationName}>>) =>\n  H.Document.make({ title: ${stringCode(title, declaration)}, body: ${body.code} });`,
    );
  };
  // The program renderToString runs: { Flags, init, view } in the entry.
  let flagsDeclaration: Node | undefined;
  let modelDeclaration: Node | undefined;
  let initDeclaration: Node | undefined;
  let viewDeclaration: Node | undefined;
  let flagsDeclarationName = "Flags";
  let modelDeclarationName = "Model";
  const findProgram = (node: Node) => {
    if (kind(node) === SyntaxKind.CallExpression) {
      const lib = libraryOf(field<Node>(node, "expression"));
      if (lib && serverFunction(lib) === "renderToString") {
        const object = field<readonly Node[]>(node, "arguments")[0]!;
        for (const member of field<readonly Node[]>(object, "properties")) {
          const name = text(field<Node>(member, "name"));
          const origin = frontend.origin(field<Node>(member, "name") as Identifier);
          if (origin._tag !== "Source") refuse(member, `${name} is a declaration of the app`);
          const declaration = (origin as Extract<typeof origin, { _tag: "Source" }>).declaration;
          if (name === "Flags") {
            flagsDeclaration = declaration;
            flagsDeclarationName = text(field<Node>(declaration, "name"));
          }
          if (name === "init") initDeclaration = declaration;
          if (name === "view") viewDeclaration = declaration;
        }
      }
    }
    node.forEachChild(findProgram);
  };
  findProgram(generator);
  if (!flagsDeclaration || !initDeclaration || !viewDeclaration)
    return refuse(gen, "renderToString runs { Flags, init, view }");
  // The Model is what view's first parameter is declared as.
  const viewParameter = field<readonly Node[]>(
    field<Node>(viewDeclaration, "initializer"),
    "parameters",
  )[0]!;
  const modelType = field<Node | undefined>(viewParameter, "type");
  const modelName = modelType ? field<Node>(modelType, "typeName") : undefined;
  if (!modelName) return refuse(viewParameter, "view's model parameter names its Model type");
  // `type Model = typeof Model.Type`: the schema of the same name in that module.
  modelDeclarationName = text(modelName);
  modelDeclaration = viewDeclaration
    .getSourceFile()
    .statements.filter((statement) => kind(statement) === SyntaxKind.VariableStatement)
    .flatMap((statement) => [
      ...field<readonly Node[]>(field<Node>(statement, "declarationList"), "declarations"),
    ])
    .find((declaration) => text(field<Node>(declaration, "name")) === modelDeclarationName);
  if (!modelDeclaration) return refuse(viewParameter, "The Model schema is declared beside view");

  structWitness(modelDeclaration);
  structWitness(flagsDeclaration);
  translateCallback("init", initDeclaration);
  translateCallback("view", viewDeclaration);
  const page = entryCode(
    field<readonly Node[]>(field<Node>(generator, "body"), "statements"),
    env,
    generator,
  );

  const requestStruct = (["url", "method", "cookie", "now"] as const)
    .filter((name) => requestFields.has(name))
    .map((name) => `${name}: ${name === "now" ? "R.DateTime.Utc" : "R.String"}`);
  const imports = [
    ...(usesMessage.value ? ['import { defineMessageUnion } from "foldkit/message";'] : []),
    ...(declarations.some((declaration) => declaration.includes("Schema."))
      ? ['import { Schema } from "effect";']
      : []),
    `import { R } from ${quote(options.reffect.authoring)};`,
    `import type { Expr, Value } from ${quote(options.reffect.kernel)};`,
  ];
  return [
    `// Generated by reffect's milestone 8B translator from ${options.provenance}. Do not edit:`,
    "// regenerate it from the pinned source instead (docs/research/ssr-codemod.md).",
    ...imports,
    "",
    "const H = R.Html;",
    ...declarations,
    `export const PageRequest = R.Struct({ ${requestStruct.join(", ")} });`,
    ...callbacks,
    `/** The entry's renderPage: what the native host answers each page request with. */`,
    `export const page = R.fn([PageRequest], H.Entry, (request) =>\n  ${page},\n);`,
    "",
  ].join("\n");
};
