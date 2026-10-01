import type { ProvenanceSnapshot } from "./provenance.ts";
import { Provenance } from "./provenance.ts";
import { SourceWriter, joinFragments, mapFragment, textFragment } from "./source-writer.ts";
import type { MappedFragment } from "./source-writer.ts";
import type { GeneratedRange } from "./source-artifact.ts";
import { Match, Predicate } from "effect";
import { BoolType, IRType, NeverType, U64Type, UnitType, fail } from "./kernel.ts";
import type { Expr, OperationRef, Program } from "./kernel.ts";
import { EffectFn } from "./effect-ir.ts";
import type { Computation } from "./effect-ir.ts";
import type { Implementation } from "./compiler.ts";
import type { GeneratedFiles } from "./cargo.ts";
import { Rs, escapeJsonContent } from "./rust-emit.ts";
import type { RsExpr, RsType } from "./rust-emit.ts";
import { SourceArtifacts, checkArtifactPolicy } from "./artifact-policy.ts";
import type {
  ArtifactPolicy,
  FullSourceArtifacts,
  NoneSourceArtifacts,
} from "./artifact-policy.ts";

export type RustExpr = (
  | { readonly _tag: "Parameter"; readonly index: number }
  | { readonly _tag: "Bound"; readonly name: string }
  | { readonly _tag: "Local"; readonly index: number }
  | { readonly _tag: "Literal"; readonly value: bigint | boolean | void }
  | {
      readonly _tag: "Call";
      readonly method: Implementation["method"];
      readonly args: readonly RustExpr[];
    }
  | {
      readonly _tag: "Match";
      readonly condition: RustExpr;
      readonly onTrue: number;
      readonly onFalse: number;
      readonly onTrueUse?: string;
      readonly onFalseUse?: string;
    }
) & { readonly origin?: string; readonly occurrence?: string };
export const RustExpr = Object.freeze({
  parameter: (index: number): RustExpr => Object.freeze({ _tag: "Parameter", index }),
  bound: (name: string): RustExpr => Object.freeze({ _tag: "Bound", name }),
  local: (index: number): RustExpr => Object.freeze({ _tag: "Local", index }),
  literal: (value: bigint | boolean | void): RustExpr => Object.freeze({ _tag: "Literal", value }),
  call: (method: Implementation["method"], left: RustExpr, right: RustExpr): RustExpr =>
    Object.freeze({ _tag: "Call", method, args: Object.freeze([left, right]) }),
});
export interface RustBinding {
  readonly index: number;
  readonly type: IRType<unknown>;
  readonly value: RustExpr;
}
interface RustBlock {
  readonly bindings: readonly RustBinding[];
  readonly body: RustExpr;
}
interface Parameter {
  readonly name: string;
  readonly type: IRType<unknown>;
}
type HelperBody =
  | { readonly _tag: "Pure"; readonly block: RustBlock }
  | { readonly _tag: "Succeed"; readonly block: RustBlock }
  | { readonly _tag: "Fail"; readonly block: RustBlock }
  | {
      readonly _tag: "Map";
      readonly source: number;
      readonly binder: string;
      readonly block: RustBlock;
    }
  | {
      readonly _tag: "FlatMap";
      readonly source: number;
      readonly binder: string;
      readonly body: number;
    }
  | {
      readonly _tag: "Match";
      readonly condition: RustBlock;
      readonly onTrue: number;
      readonly onFalse: number;
    }
  | {
      readonly _tag: "Log";
      readonly level: string;
      readonly message: string;
      readonly attributes: readonly {
        readonly key: string;
        readonly type: IRType<unknown>;
        readonly block: RustBlock;
      }[];
    }
  | {
      readonly _tag: "Annotate";
      readonly key: string;
      readonly type: IRType<unknown>;
      readonly value: RustBlock;
      readonly body: number;
    }
  | {
      readonly _tag: "Span";
      readonly label: string;
      readonly body: number;
    };
interface Helper {
  readonly origin?: string;
  readonly path: string;
  readonly index: number;
  readonly input: readonly Parameter[];
  readonly output: IRType<unknown>;
  readonly error?: IRType<unknown>;
  readonly body: HelperBody;
}
interface RustFunction {
  readonly origin?: string;
  readonly path: string;
  readonly name: string;
  readonly input: readonly IRType<unknown>[];
  readonly output: IRType<unknown>;
  readonly helpers: readonly Helper[];
  readonly node:
    | { readonly _tag: "Pure"; readonly block: RustBlock }
    | { readonly _tag: "Effect"; readonly root: number; readonly error: IRType<unknown> };
}
export interface RustModule {
  readonly sourceArtifacts: FullSourceArtifacts;
  readonly provenance: ProvenanceSnapshot;
  readonly functions: readonly RustFunction[];
}
export interface UnmappedRustModule {
  readonly sourceArtifacts: NoneSourceArtifacts;
  readonly provenance?: never;
  readonly functions: readonly RustFunction[];
}
export type LoweredModule = RustModule | UnmappedRustModule;
interface Scope {
  readonly bindings: ReadonlyMap<symbol, readonly Parameter[]>;
  readonly input: readonly Parameter[];
}

export function lowerFunctions(
  program: Program,
  selected: ReadonlyMap<OperationRef, Implementation>,
): RustModule;
export function lowerFunctions(
  program: Program,
  selected: ReadonlyMap<OperationRef, Implementation>,
  policy: FullSourceArtifacts,
): RustModule;
export function lowerFunctions(
  program: Program,
  selected: ReadonlyMap<OperationRef, Implementation>,
  policy: NoneSourceArtifacts,
): UnmappedRustModule;
export function lowerFunctions(
  program: Program,
  selected: ReadonlyMap<OperationRef, Implementation>,
  policy: ArtifactPolicy,
): LoweredModule;
export function lowerFunctions(
  program: Program,
  selected: ReadonlyMap<OperationRef, Implementation>,
  policy: ArtifactPolicy = SourceArtifacts.Full,
): LoweredModule {
  checkArtifactPolicy(policy);
  const provenance = SourceArtifacts.isNone(policy) ? undefined : new Provenance(program);
  const functions = Object.freeze(
    Object.entries(program.functions).map(([name, f]): RustFunction => {
      const path = `functions.${name}`;
      let next = 0;
      const helpers = new Map<number, Helper>();
      const pureMemo = new Map<Expr<unknown>["node"], Map<Scope, number>>();
      const effectMemo = new Map<Computation<unknown, unknown>["node"], Map<Scope, number>>();
      const input = Object.freeze(f.input.map((type, i) => Object.freeze({ name: `p${i}`, type })));
      const rootScope: Scope = { bindings: new Map([[f.binder, input]]), input };
      const nestedScope = (
        scope: Scope,
        binder: symbol,
        type: IRType<unknown>,
        id: number,
      ): Scope => {
        const parameter = Object.freeze({ name: `b${id}`, type });
        const bindings = new Map(scope.bindings);
        bindings.set(binder, [parameter]);
        return { bindings, input: Object.freeze(scope.input.concat([parameter])) };
      };
      const pureHelper = (e: Expr<unknown>, scope: Scope, path: string): number => {
        const cached = pureMemo.get(e.node)?.get(scope);
        if (cached !== undefined) return cached;
        const index = next++;
        const scopes = pureMemo.get(e.node) ?? new Map<Scope, number>();
        scopes.set(scope, index);
        pureMemo.set(e.node, scopes);
        const body: HelperBody = Object.freeze({ _tag: "Pure", block: block(e, scope, path) });
        helpers.set(
          index,
          Object.freeze({
            index,
            input: scope.input,
            output: e.type,
            body,
            origin: provenance?.origin(e),
            path,
          }),
        );
        return index;
      };
      const block = (root: Expr<unknown>, scope: Scope, path: string): RustBlock => {
        const bindings: RustBinding[] = [];
        const memo = new Map<Expr<unknown>["node"], RustExpr>();
        const expression = (e: Expr<unknown>, path: string): RustExpr => {
          const source = provenance
            ? { origin: provenance.origin(e), occurrence: provenance.use(path) }
            : undefined;
          const cached = memo.get(e.node);
          if (cached) return provenance ? Object.freeze({ ...cached, ...source }) : cached;
          const value = Match.value(e.node).pipe(
            Match.tagsExhaustive({
              Parameter: (n) => {
                const parameter = scope.bindings.get(n.binder)![n.index];
                return RustExpr.bound(parameter.name);
              },
              Literal: (n) => RustExpr.literal(n.value as bigint | boolean | void),
              Apply: (n): RustExpr =>
                Object.freeze({
                  _tag: "Call",
                  method: selected.get(n.operation.ref)!.method,
                  args: Object.freeze(
                    n.args.map((arg, i) => expression(arg, `${path}.args[${i}]`)),
                  ),
                }),
              Match: (n): RustExpr =>
                Object.freeze({
                  _tag: "Match",
                  condition: expression(n.condition, `${path}.condition`),
                  onTrue: pureHelper(n.onTrue, scope, `${path}.onTrue`),
                  onTrueUse: provenance?.use(`${path}.onTrue`),
                  onFalse: pureHelper(n.onFalse, scope, `${path}.onFalse`),
                  onFalseUse: provenance?.use(`${path}.onFalse`),
                }),
            }),
          );
          const local = Match.value(e.node).pipe(
            Match.tags({ Apply: () => true, Match: () => true }),
            Match.orElse(() => false),
          );
          const reference = local ? RustExpr.local(bindings.length) : value;
          const result = provenance ? Object.freeze({ ...reference, ...source }) : reference;
          if (local)
            bindings.push(
              Object.freeze({
                index: bindings.length,
                type: e.type,
                value: provenance ? Object.freeze({ ...value, ...source }) : value,
              }),
            );
          memo.set(e.node, result);
          return result;
        };
        const body = expression(root, path);
        return Object.freeze({ bindings: Object.freeze(bindings), body });
      };
      const effectHelper = (
        c: Computation<unknown, unknown>,
        scope: Scope,
        error: IRType<unknown>,
        path: string,
      ): number => {
        const cached = effectMemo.get(c.node)?.get(scope);
        if (cached !== undefined) return cached;
        const index = next++;
        const scopes = effectMemo.get(c.node) ?? new Map<Scope, number>();
        scopes.set(scope, index);
        effectMemo.set(c.node, scopes);
        const body: HelperBody = Match.value(c.node).pipe(
          Match.tagsExhaustive({
            Succeed: (n): HelperBody => ({
              _tag: "Succeed",
              block: block(n.value, scope, `${path}.value`),
            }),
            Fail: (n): HelperBody => ({
              _tag: "Fail",
              block: block(n.error, scope, `${path}.error`),
            }),
            Map: (n): HelperBody => ({
              _tag: "Map",
              source: effectHelper(n.source, scope, error, `${path}.source`),
              binder: `b${index}`,
              block: block(
                n.body,
                nestedScope(scope, n.binder, n.source.output, index),
                `${path}.body`,
              ),
            }),
            FlatMap: (n): HelperBody => ({
              _tag: "FlatMap",
              source: effectHelper(n.source, scope, error, `${path}.source`),
              binder: `b${index}`,
              body: effectHelper(
                n.body,
                nestedScope(scope, n.binder, n.source.output, index),
                error,
                `${path}.body`,
              ),
            }),
            Match: (n): HelperBody => ({
              _tag: "Match",
              condition: block(n.condition, scope, `${path}.condition`),
              onTrue: effectHelper(n.onTrue, scope, error, `${path}.onTrue`),
              onFalse: effectHelper(n.onFalse, scope, error, `${path}.onFalse`),
            }),
            Log: (n): HelperBody => ({
              _tag: "Log",
              level: n.level,
              message: n.message,
              attributes: Object.freeze(
                n.attributes.map(([key, value]) =>
                  Object.freeze({
                    key,
                    type: value.type,
                    block: block(value, scope, `${path}.attributes.${key}`),
                  }),
                ),
              ),
            }),
            Annotate: (n): HelperBody => ({
              _tag: "Annotate",
              key: n.key,
              type: n.value.type,
              value: block(n.value, scope, `${path}.value`),
              body: effectHelper(n.body, scope, error, `${path}.body`),
            }),
            Span: (n): HelperBody => ({
              _tag: "Span",
              label: n.label,
              body: effectHelper(n.body, scope, error, `${path}.body`),
            }),
          }),
        );
        helpers.set(
          index,
          Object.freeze({
            index,
            origin: provenance?.origin(c),
            path,
            input: scope.input,
            output: c.output,
            error,
            body: Object.freeze(body),
          }),
        );
        return index;
      };
      const node: RustFunction["node"] =
        f instanceof EffectFn
          ? Object.freeze({
              _tag: "Effect",
              root: effectHelper(f.body, rootScope, f.error, `${path}.body`),
              error: f.error,
            })
          : Object.freeze({ _tag: "Pure", block: block(f.body, rootScope, `${path}.body`) });
      return Object.freeze({
        name,
        path,
        origin: provenance?.origin(f),
        input: f.input,
        output: f.output,
        helpers: Object.freeze(Array.from(helpers.values()).sort((a, b) => a.index - b.index)),
        node,
      });
    }),
  );
  return provenance
    ? Object.freeze({
        sourceArtifacts: SourceArtifacts.Full,
        provenance: provenance.snapshot(),
        functions,
      })
    : Object.freeze({ sourceArtifacts: SourceArtifacts.None, functions });
}

const rsSegments = (...names: string[]) => names.map((name) => Rs.ident(name));
const identExpr = (name: string) => Rs.identExpr(Rs.ident(name));
const stdCellPath = rsSegments("std", "cell");
const refCellPath = [...stdCellPath, Rs.ident("RefCell")];
const cellPath = [...stdCellPath, Rs.ident("Cell")];
const framesType = Rs.vecType(Rs.strRefType());
const refCellOf = (inner: RsType) => Rs.genericType(Rs.pathType(refCellPath), [inner]);
const cellOf = (inner: RsType) => Rs.genericType(Rs.pathType(cellPath), [inner]);
const newCall = (path: ReturnType<typeof rsSegments>, args: readonly RsExpr[]) =>
  Rs.pathCall(path, Rs.ident("new"), args);

/** Failure-only frame stash; success paths never touch it. No dependencies. */
const framePrelude = Rs.itemsText(
  [
    Rs.threadLocalItem([
      {
        name: Rs.ident("LAST_FRAMES"),
        type: refCellOf(framesType),
        value: newCall(refCellPath, [newCall(rsSegments("Vec"), [])]),
      },
      {
        name: Rs.ident("LAST_OMITTED"),
        type: cellOf(Rs.usizeType()),
        value: newCall(cellPath, [Rs.litInt(0)]),
      },
    ]),
    Rs.fnItem(
      Rs.ident("store_frames"),
      [{ name: Rs.ident("frames"), type: framesType }],
      Rs.unitType(),
      Rs.block([
        Rs.let_(
          Rs.ident("omitted"),
          undefined,
          Rs.dotChain(identExpr("frames"), [
            { method: Rs.ident("len"), args: [] },
            { method: Rs.ident("saturating_sub"), args: [Rs.litInt(32)] },
          ]),
        ),
        Rs.letMut(Rs.ident("kept"), undefined, identExpr("frames")),
        Rs.stmt(Rs.dotCall(identExpr("kept"), Rs.ident("truncate"), [Rs.litInt(32)])),
        Rs.stmt(Rs.dotCall(identExpr("LAST_OMITTED"), Rs.ident("set"), [identExpr("omitted")])),
        Rs.stmt(
          Rs.dotCall(identExpr("LAST_FRAMES"), Rs.ident("with"), [
            Rs.closure(
              Rs.pat("cell"),
              Rs.assignExpr(
                Rs.prefix("*", Rs.dotCall(identExpr("cell"), Rs.ident("borrow_mut"), [])),
                identExpr("kept"),
              ),
            ),
          ]),
        ),
      ]),
    ),
    Rs.withVisibility(
      Rs.visibility.public,
      Rs.fnItem(
        Rs.ident("take_last_frames"),
        [],
        Rs.tupleType([framesType, Rs.usizeType()]),
        Rs.block(
          [],
          Rs.tuple(
            Rs.dotCall(identExpr("LAST_FRAMES"), Rs.ident("with"), [
              Rs.closure(
                Rs.pat("cell"),
                Rs.pathCall(rsSegments("std", "mem"), Rs.ident("take"), [
                  Rs.mutRefExpr(
                    Rs.prefix("*", Rs.dotCall(identExpr("cell"), Rs.ident("borrow_mut"), [])),
                  ),
                ]),
              ),
            ]),
            Rs.dotCall(identExpr("LAST_OMITTED"), Rs.ident("get"), []),
          ),
        ),
      ),
    ),
  ],
  "\n",
);
/** JSON string literal; lone surrogates become \u escapes, keeping Rust sources valid UTF-8. */
const jsonString = (text: string): RsExpr => Rs.verbatimExpr(`"${escapeJsonContent(text)}"`);
const rustString = (text: string): RsExpr => Rs.stringLiteral(text);
const attrVariant = (type: IRType<unknown>): ReturnType<typeof Rs.ident> => {
  if (IRType.same(type, BoolType)) return Rs.ident("Bool");
  if (IRType.same(type, U64Type)) return Rs.ident("U64");
  throw fail(
    "UNSUPPORTED_REPRESENTATION",
    "lower",
    "log-attribute",
    "Log attributes require Boolean or u64 witnesses",
  );
};
/** Logging scopes and records; success paths never emit. No dependencies. */
const logPrelude = Rs.itemsText(
  [
    Rs.withAttributes(
      [Rs.deriveAttribute(Rs.ident("Clone"), Rs.ident("Copy"))],
      Rs.enumItem(Rs.ident("LogAttr"), [
        { name: Rs.ident("Bool"), fields: [Rs.boolType()] },
        { name: Rs.ident("U64"), fields: [Rs.u64Type()] },
      ]),
    ),
    Rs.constItem(Rs.ident("MIN_LOG_LEVEL"), Rs.u8Type(), Rs.litInt(2)),
    Rs.fnItem(
      Rs.ident("log_attr_json"),
      [
        { name: Rs.ident("value"), type: Rs.namedType("LogAttr") },
        { name: Rs.ident("out"), type: Rs.mutRefType(Rs.stringType()) },
      ],
      Rs.unitType(),
      Rs.block(
        [],
        Rs.matchBlock(
          identExpr("value"),
          [
            {
              pat: Rs.variantPat(rsSegments("LogAttr", "Bool"), [Rs.identPat(Rs.ident("b"))]),
              body: Rs.dotCall(identExpr("out"), Rs.ident("push_str"), [
                Rs.if_(
                  identExpr("b"),
                  Rs.inlineBlock(Rs.stringLiteral("true")),
                  Rs.inlineBlock(Rs.stringLiteral("false")),
                ),
              ]),
            },
            {
              pat: Rs.variantPat(rsSegments("LogAttr", "U64"), [Rs.identPat(Rs.ident("n"))]),
              body: Rs.inlineStmtBlock(
                Rs.stmt(Rs.dotCall(identExpr("out"), Rs.ident("push"), [Rs.litChar('"')])),
                Rs.stmt(
                  Rs.dotCall(identExpr("out"), Rs.ident("push_str"), [
                    Rs.prefix("&", Rs.dotCall(identExpr("n"), Rs.ident("to_string"), [])),
                  ]),
                ),
                Rs.stmt(Rs.dotCall(identExpr("out"), Rs.ident("push"), [Rs.litChar('"')])),
              ),
            },
          ],
          { indent: 4 },
        ),
      ),
    ),
    Rs.threadLocalItem([
      {
        name: Rs.ident("LOG_ANNOS"),
        type: refCellOf(Rs.vecType(Rs.tupleType([Rs.strRefType(), Rs.namedType("LogAttr")]))),
        value: newCall(refCellPath, [newCall(rsSegments("Vec"), [])]),
      },
      {
        name: Rs.ident("LOG_SPANS"),
        type: refCellOf(
          Rs.vecType(
            Rs.tupleType([Rs.strRefType(), Rs.pathType(rsSegments("std", "time", "Instant"))]),
          ),
        ),
        value: newCall(refCellPath, [newCall(rsSegments("Vec"), [])]),
      },
    ]),
  ],
  "\n",
);
const logLevelOrdinal: Readonly<Record<string, number>> = Object.freeze({
  Trace: 0,
  Debug: 1,
  Info: 2,
  Warn: 3,
  Error: 4,
  Fatal: 5,
});
const frameLiteral = (
  functionName: string,
  path: string,
  kind: string,
  origin: string | undefined,
): RsExpr => {
  const json =
    '{"function":"' +
    escapeJsonContent(functionName) +
    '","path":"' +
    escapeJsonContent(path) +
    '","kind":"' +
    escapeJsonContent(kind) +
    '"' +
    (origin === undefined ? "" : ',"origin":"' + escapeJsonContent(origin) + '"') +
    "}";
  return Rs.stringLiteral(json);
};

export const emitFunctions = (
  module: LoweredModule,
): { readonly files: GeneratedFiles["files"]; readonly ranges: readonly GeneratedRange[] } => {
  const uses = module.provenance
    ? new Map(module.provenance.occurrences.map((use) => [use.path, use.id]))
    : undefined;
  const useAt = (path: string) => uses?.get(path);
  const writer = new SourceWriter("src/lib.rs", !SourceArtifacts.isNone(module.sourceArtifacts));
  const rsTypeOf = (type: IRType<unknown>): RsType => {
    if (IRType.same(type, U64Type)) return Rs.namedType("u64");
    if (IRType.same(type, BoolType)) return Rs.namedType("bool");
    if (IRType.same(type, UnitType)) return Rs.unitType();
    if (IRType.same(type, NeverType))
      return Rs.pathType([Rs.ident("std"), Rs.ident("convert"), Rs.ident("Infallible")]);
    throw fail(
      "UNSUPPORTED_REPRESENTATION",
      "lower",
      "type",
      "Only canonical witnesses have native types",
    );
  };
  const typeName = (type: IRType<unknown>) => rsTypeOf(type).text;
  const write = (text: string | { readonly text: string }) =>
    writer.write(typeof text === "string" ? text : text.text);
  const hasEffect = module.functions.some((f) => f.node._tag === "Effect");
  if (hasEffect) write(framePrelude);
  const hasLogScopes = module.functions.some((f) =>
    f.helpers.some(
      (h) => h.body._tag === "Log" || h.body._tag === "Annotate" || h.body._tag === "Span",
    ),
  );
  if (hasLogScopes) write(logPrelude);
  for (const f of module.functions) {
    const callText = (index: number): string => {
      const helper = f.helpers[index];
      return Rs.call(
        Rs.identExpr(Rs.ident(`h_${f.name}_${helper.index}`)),
        helper.input.map((p) => Rs.identExpr(Rs.ident(p.name))),
      ).text;
    };
    const callFrag = (index: number, occurrence?: string): MappedFragment =>
      mapFragment(f.helpers[index].origin, occurrence, textFragment(callText(index)));
    const adaptFrag = (index: number, output: IRType<unknown>, occurrence?: string) => {
      if (IRType.same(f.helpers[index].output, NeverType) && !IRType.same(output, NeverType))
        return joinFragments([
          "match ",
          callFrag(index, occurrence),
          " { Ok(value) => match value {}, Err((error, frames)) => Err((error, frames)) }",
        ]);
      return callFrag(index, occurrence);
    };
    const render = (e: RustExpr, role?: GeneratedRange["role"]): MappedFragment =>
      mapFragment(
        e.origin,
        e.occurrence,
        Match.value(e).pipe(
          Match.tagsExhaustive({
            Parameter: (n) => textFragment(Rs.ident(`p${n.index}`).text),
            Bound: (n) => textFragment(Rs.ident(n.name).text),
            Local: (n) => textFragment(Rs.ident(`v${n.index}`).text),
            Literal: (n) => {
              if (Predicate.isUndefined(n.value)) return textFragment(Rs.litUnit().text);
              if (Predicate.isBigInt(n.value)) return textFragment(Rs.litU64(n.value).text);
              if (Predicate.isBoolean(n.value)) return textFragment(Rs.litBool(n.value).text);
              throw fail(
                "UNSUPPORTED_REPRESENTATION",
                "lower",
                "literal",
                "Literals require Boolean, u64 or Unit witnesses",
              );
            },
            Call: (n) => {
              if (n.method === "not") return joinFragments(["!(", render(n.args[0]), ")"]);
              if (n.method === "eq" || n.method === "lt")
                return joinFragments([
                  "(",
                  render(n.args[0]),
                  n.method === "eq" ? ") == (" : ") < (",
                  render(n.args[1]),
                  ")",
                ]);
              return joinFragments([
                "(",
                render(n.args[0]),
                `).${Rs.ident(n.method).text}(`,
                render(n.args[1]),
                ")",
              ]);
            },
            Match: (n) =>
              joinFragments([
                "if ",
                render(n.condition),
                " { ",
                callFrag(n.onTrue, n.onTrueUse),
                " } else { ",
                callFrag(n.onFalse, n.onFalseUse),
                " }",
              ]),
          }),
        ),
        role,
      );
    const renderBlock = (block: RustBlock): MappedFragment => {
      const parts: Array<string | MappedFragment> = ["{\n"];
      for (const binding of block.bindings) {
        parts.push(`    let ${Rs.ident(`v${binding.index}`).text}: `);
        parts.push(
          mapFragment(
            binding.value.origin,
            binding.value.occurrence,
            textFragment(typeName(binding.type)),
            "definition",
          ),
        );
        parts.push(" = ");
        parts.push(render(binding.value, "definition"));
        parts.push(";\n");
      }
      parts.push("    ");
      parts.push(render(block.body));
      parts.push("\n}");
      return joinFragments(parts);
    };
    const resultType = (output: IRType<unknown>, error?: IRType<unknown>) =>
      error ? Rs.resultType(rsTypeOf(output), rsTypeOf(error)).text : rsTypeOf(output).text;
    // Internal Effect helpers carry failure frames alongside the payload; the public
    // function strips them back to Result<T, E> and stashes the frames for the binary.
    const tracedType = (output: IRType<unknown>, error: IRType<unknown>) =>
      Rs.resultType(rsTypeOf(output), Rs.tupleType([rsTypeOf(error), Rs.vecType(Rs.strRefType())]))
        .text;
    const frameOf = (helper: Helper, kind: string): RsExpr =>
      frameLiteral(f.name, helper.path, kind, helper.origin);
    for (const helper of f.helpers) {
      const use = (edge: string) => useAt(`${helper.path}.${edge}`);
      const signature =
        helper.body._tag === "Pure"
          ? resultType(helper.output, helper.error)
          : helper.error
            ? tracedType(helper.output, helper.error)
            : resultType(helper.output, helper.error);
      const helperBody: MappedFragment = Match.value(helper.body).pipe(
        Match.tagsExhaustive({
          Pure: (n) => renderBlock(n.block),
          Succeed: (n) =>
            joinFragments([
              "{ ",
              mapFragment(helper.origin, undefined, textFragment("Ok")),
              "(",
              renderBlock(n.block),
              ") }",
            ]),
          Fail: (n) =>
            joinFragments([
              "{ ",
              mapFragment(helper.origin, undefined, textFragment("Err")),
              "((",
              renderBlock(n.block),
              `, vec![${frameOf(helper, "fail").text}])) }`,
            ]),
          Map: (n) =>
            joinFragments([
              "{ match ",
              callFrag(n.source, use("source")),
              ` { Ok(${Rs.ident(n.binder).text}) => Ok(`,
              renderBlock(n.block),
              `), Err((error, mut frames)) => { frames.push(${frameOf(helper, "map").text}); Err((error, frames)) } } }`,
            ]),
          FlatMap: (n) =>
            joinFragments([
              "{ match ",
              callFrag(n.source, use("source")),
              ` { Ok(${Rs.ident(n.binder).text}) => match `,
              adaptFrag(n.body, helper.output, use("body")),
              ` { Ok(value) => Ok(value), Err((error, mut frames)) => { frames.push(${frameOf(helper, "flatMap").text}); Err((error, frames)) } }`,
              `, Err((error, mut frames)) => { frames.push(${frameOf(helper, "flatMap").text}); Err((error, frames)) } } }`,
            ]),
          Match: (n) =>
            joinFragments([
              "{ if ",
              renderBlock(n.condition),
              " { match ",
              adaptFrag(n.onTrue, helper.output, use("onTrue")),
              ` { Ok(value) => Ok(value), Err((error, mut frames)) => { frames.push(${frameOf(helper, "match").text}); Err((error, frames)) } }`,
              " } else { match ",
              adaptFrag(n.onFalse, helper.output, use("onFalse")),
              ` { Ok(value) => Ok(value), Err((error, mut frames)) => { frames.push(${frameOf(helper, "match").text}); Err((error, frames)) } } } }`,
            ]),
          Log: (n) => {
            const ordinal = logLevelOrdinal[n.level] ?? 99;
            const head =
              '{"schema":"reffect.log@1","level":"' +
              n.level +
              '","message":' +
              jsonString(n.message).text;
            const parts: Array<string | MappedFragment> = [
              `{ if ${Rs.litU8(ordinal).text} >= MIN_LOG_LEVEL { { let mut log_record = String::from(${rustString(head).text});`,
              ` log_record.push_str(",\\"annotations\\":{");`,
              ` { let mut log_attr_first = true;`,
            ];
            for (const attr of n.attributes) {
              parts.push(` { let log_attr_value = LogAttr::${attrVariant(attr.type).text}(`);
              parts.push(renderBlock(attr.block));
              parts.push(
                `); if !log_attr_first { log_record.push(','); } log_attr_first = false; log_record.push_str(${rustString(`"${attr.key}":`).text}); log_attr_json(log_attr_value, &mut log_record); }`,
              );
            }
            const shadowed =
              n.attributes.length === 0
                ? ``
                : ` if ${n.attributes.map((attr) => `*name == ${rustString(attr.key).text}`).join(" || ")} { continue; }`;
            parts.push(
              ` LOG_ANNOS.with(|scope| { for (name, value) in scope.borrow().iter() {${shadowed} if !log_attr_first { log_record.push(','); } log_attr_first = false; log_record.push_str("\\""); log_record.push_str(name); log_record.push_str("\\":"); log_attr_json(*value, &mut log_record); } });`,
              ` } log_record.push('}');`,
              ` LOG_SPANS.with(|scope| { log_record.push_str(",\\"spans\\":["); for (index, entry) in scope.borrow().iter().rev().enumerate() { if index > 0 { log_record.push(','); } log_record.push_str("{\\"label\\":\\""); log_record.push_str(entry.0); log_record.push_str("\\",\\"elapsed_ms\\":"); log_record.push_str(&entry.1.elapsed().as_millis().to_string()); log_record.push('}'); } log_record.push(']'); });`,
              ` log_record.push('}'); eprintln!("{}", log_record); } } Ok(()) }`,
            );
            return joinFragments(parts);
          },
          Annotate: (n) => {
            const key = rustString(n.key).text;
            return joinFragments([
              `{ let saved_log_annos = LOG_ANNOS.with(|scope| scope.borrow().clone());`,
              ` LOG_ANNOS.with(|scope| { let value = LogAttr::${attrVariant(n.type).text}(`,
              renderBlock(n.value),
              `); let mut scope = scope.borrow_mut(); if let Some(slot) = scope.iter_mut().find(|(name, _)| *name == `,
              key,
              `) { *slot = (`,
              key,
              `, value); } else { scope.push((`,
              key,
              `, value)); } });`,
              ` match `,
              adaptFrag(n.body, helper.output, use("body")),
              ` { Ok(value) => { LOG_ANNOS.with(|scope| *scope.borrow_mut() = saved_log_annos); Ok(value) } Err((error, mut frames)) => { LOG_ANNOS.with(|scope| *scope.borrow_mut() = saved_log_annos); frames.push(${frameOf(helper, "annotate").text}); Err((error, frames)) } } }`,
            ]);
          },
          Span: (n) =>
            joinFragments([
              `{ LOG_SPANS.with(|scope| scope.borrow_mut().push((`,
              rustString(n.label).text,
              `, std::time::Instant::now())));`,
              ` match `,
              adaptFrag(n.body, helper.output, use("body")),
              ` { Ok(value) => { LOG_SPANS.with(|scope| { scope.borrow_mut().pop(); }); Ok(value) } Err((error, mut frames)) => { LOG_SPANS.with(|scope| { scope.borrow_mut().pop(); }); frames.push(${frameOf(helper, "span").text}); Err((error, frames)) } } }`,
            ]),
        }),
      );
      // Inlining shared control flow can recreate exponential trees; preserve existing optimization boundary.
      writer.writeFragment(
        joinFragments([
          "#[inline(never)]\nfn ",
          mapFragment(
            helper.origin,
            useAt(helper.path),
            textFragment(Rs.ident(`h_${f.name}_${helper.index}`).text),
            "definition",
          ),
          `(${helper.input.map((p) => `${Rs.ident(p.name).text}: ${rsTypeOf(p.type).text}`).join(", ")}) -> `,
          mapFragment(helper.origin, useAt(helper.path), textFragment(signature), "definition"),
          " ",
          helperBody,
          "\n\n",
        ]),
      );
    }
    writer.writeFragment(
      joinFragments([
        "\npub fn ",
        mapFragment(
          f.origin,
          useAt(f.path),
          textFragment(Rs.ident(`r_${f.name}`).text),
          "definition",
        ),
        `(${f.input.map((type, i) => `p${i}: ${rsTypeOf(type).text}`).join(", ")}) -> `,
        mapFragment(
          f.origin,
          useAt(f.path),
          textFragment(
            Match.value(f.node).pipe(
              Match.tagsExhaustive({
                Pure: () => typeName(f.output),
                Effect: (n) => resultType(f.output, n.error),
              }),
            ),
          ),
          "definition",
        ),
        " ",
        Match.value(f.node).pipe(
          Match.tagsExhaustive({
            Pure: (n) => renderBlock(n.block),
            // Public functions keep Result<T, E>; frames go to the thread-local stash for the binary.
            Effect: (n) =>
              joinFragments([
                "{ match ",
                adaptFrag(n.root, f.output, useAt(`${f.path}.body`)),
                ` { Ok(value) => Ok(value), Err((error, mut frames)) => { frames.push(${frameLiteral(f.name, f.path, "function", f.origin).text}); store_frames(frames); Err(error) } } }`,
              ]),
          }),
        ),
        "\n\n",
      ]),
    );
  }
  const print = (type: IRType<unknown>, value: RsExpr, channel?: "ok" | "err"): RsExpr => {
    if (IRType.same(type, NeverType)) return Rs.unreachableMatch(value);
    if (IRType.same(type, UnitType))
      return Rs.inlineStmtBlock(
        Rs.letDiscard(Rs.unitType(), value),
        Rs.println(`${channel ? `${channel}:` : ""}unit`),
      );
    const prefix = channel
      ? `${channel}:${IRType.same(type, U64Type) ? "u64" : "bool"}:`
      : IRType.same(type, BoolType)
        ? "bool:"
        : "";
    return Rs.printlnExpr(prefix, value);
  };
  const parseArg = (type: IRType<unknown>, index: number): RsExpr =>
    IRType.same(type, UnitType)
      ? Rs.inlineBlock(
          Rs.if_(
            Rs.cmp(Rs.index(identExpr("args"), index), "!=", Rs.stringLiteral("unit")),
            Rs.inlineStmtBlock(Rs.stmt(Rs.return_(Rs.err(Rs.stringLiteral("invalid unit"))))),
          ),
          Rs.litUnit(),
        )
      : Rs.try_(
          Rs.dotChain(Rs.index(identExpr("args"), index), [
            { method: Rs.ident("parse"), args: [], turboTypes: [rsTypeOf(type)] },
            {
              method: Rs.ident("map_err"),
              args: [Rs.closure(Rs.pat("_"), Rs.stringLiteral(`invalid ${rsTypeOf(type).text}`))],
            },
          ]),
        );
  const callExpr = (f: LoweredModule["functions"][number]): RsExpr =>
    Rs.pathCall(
      rsSegments("reffect_generated"),
      Rs.ident(`r_${f.name}`),
      f.input.map((type, i) => parseArg(type, i + 1)),
    );
  const framesBlock = Rs.inlineStmtBlock(
    Rs.letPat(
      Rs.tuplePat(Rs.identPat(Rs.ident("frames")), Rs.identPat(Rs.ident("omitted"))),
      undefined,
      Rs.pathCall(rsSegments("reffect_generated"), Rs.ident("take_last_frames"), []),
    ),
    Rs.letMut(Rs.ident("body"), undefined, Rs.stringFrom(Rs.stringLiteral("["))),
    Rs.blockStmt(
      Rs.forLoop(
        Rs.pat("(i, frame)"),
        Rs.dotChain(identExpr("frames"), [
          { method: Rs.ident("iter"), args: [] },
          { method: Rs.ident("enumerate"), args: [] },
        ]),
        Rs.inlineStmtBlock(
          Rs.blockStmt(
            Rs.if_(
              Rs.cmp(identExpr("i"), ">", Rs.litInt(0)),
              Rs.inlineStmtBlock(
                Rs.stmt(Rs.dotCall(identExpr("body"), Rs.ident("push"), [Rs.litChar(",")])),
              ),
            ),
          ),
          Rs.stmt(Rs.dotCall(identExpr("body"), Rs.ident("push_str"), [identExpr("frame")])),
        ),
      ),
    ),
    Rs.stmt(Rs.dotCall(identExpr("body"), Rs.ident("push"), [Rs.litChar("]")])),
    Rs.eprintln(
      '{"schema":"reffect.frames@1","frames":',
      identExpr("body"),
      ',"omitted":',
      identExpr("omitted"),
      "}",
    ),
  );
  const arms = module.functions.map((f) => ({
    pat: Rs.stringPat(f.name),
    guard: Rs.cmp(
      Rs.dotCall(identExpr("args"), Rs.ident("len"), []),
      "==",
      Rs.litInt(f.input.length + 1),
    ),
    body: Match.value(f.node).pipe(
      Match.tagsExhaustive({
        Pure: () =>
          Rs.inlineStmtBlock(
            Rs.let_(Rs.ident("value"), undefined, callExpr(f)),
            Rs.stmt(print(f.output, identExpr("value"))),
          ),
        Effect: (n) =>
          Rs.match_(callExpr(f), [
            { pat: Rs.pat("Ok(value)"), body: print(f.output, identExpr("value"), "ok") },
            {
              pat: Rs.pat("Err(error)"),
              body: Rs.inlineStmtBlock(
                Rs.stmt(print(n.error, identExpr("error"), "err")),
                Rs.blockStmt(framesBlock),
              ),
            },
          ]),
      }),
    ),
  }));
  const mainBody = Rs.block(
    [
      Rs.let_(
        Rs.ident("args"),
        Rs.vecType(Rs.stringType()),
        Rs.dotChain(Rs.pathCall(rsSegments("std", "env"), Rs.ident("args"), []), [
          { method: Rs.ident("skip"), args: [Rs.litInt(1)] },
          { method: Rs.ident("collect"), args: [] },
        ]),
      ),
      Rs.blockStmt(
        Rs.matchBlock(
          Rs.try_(
            Rs.dotChain(identExpr("args"), [
              { method: Rs.ident("first"), args: [] },
              {
                method: Rs.ident("map"),
                args: [Rs.pathExpr(Rs.path(rsSegments("String", "as_str")))],
              },
              { method: Rs.ident("ok_or"), args: [Rs.stringLiteral("missing function")] },
            ]),
          ),
          [
            ...arms,
            {
              pat: Rs.wildcardPat(),
              body: Rs.return_(Rs.err(Rs.stringLiteral("unknown function or incorrect arity"))),
            },
          ],
          { indent: 4, trailingComma: true },
        ),
      ),
    ],
    Rs.ok(Rs.litUnit()),
  );
  const files = Object.freeze({
    "Cargo.toml":
      '[package]\nname = "reffect_generated"\nversion = "0.0.0"\nedition = "2021"\n\n[workspace]\n',
    "src/lib.rs": writer.text,
    "src/main.rs": `${
      Rs.fnItem(Rs.ident("main"), [], Rs.resultType(Rs.unitType(), Rs.strRefType()), mainBody).text
    }\n`,
  });
  return Object.freeze({ files, ranges: writer.ranges });
};
