import type { ProvenanceSnapshot } from "./provenance.ts";
import { Provenance } from "./provenance.ts";
import { SourceWriter } from "./source-writer.ts";
import type { GeneratedRange } from "./source-artifact.ts";
import { Match } from "effect";
import { BoolType, IRType, NeverType, U64Type } from "./kernel.ts";
import type { Expr, OperationRef, Program } from "./kernel.ts";
import { EffectFn } from "./effect-ir.ts";
import type { Computation } from "./effect-ir.ts";
import type { Implementation } from "./compiler.ts";
import type { GeneratedFiles } from "./cargo.ts";
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
  | { readonly _tag: "Literal"; readonly value: bigint | boolean }
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
  literal: (value: bigint | boolean): RustExpr => Object.freeze({ _tag: "Literal", value }),
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
              Literal: (n) => RustExpr.literal(n.value as bigint | boolean),
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

export const emitFunctions = (
  module: LoweredModule,
): { readonly files: GeneratedFiles["files"]; readonly ranges: readonly GeneratedRange[] } => {
  const uses = module.provenance
    ? new Map(module.provenance.occurrences.map((use) => [use.path, use.id]))
    : undefined;
  const useAt = (path: string) => uses?.get(path);
  const writer = new SourceWriter("src/lib.rs", !SourceArtifacts.isNone(module.sourceArtifacts));
  const typeName = (type: IRType<unknown>) => type.native.type;
  const write = (text: string) => writer.write(text);
  const mapped = (origin: string | undefined, use: string | undefined, text: string) =>
    writer.mapped(origin, use, () => write(text));
  for (const f of module.functions) {
    const call = (index: number, occurrence?: string) => {
      const helper = f.helpers[index];
      mapped(
        helper.origin,
        occurrence,
        `h_${f.name}_${index}(${helper.input.map((p) => p.name).join(", ")})`,
      );
    };
    const adapt = (index: number, output: IRType<unknown>, occurrence?: string) => {
      if (IRType.same(f.helpers[index].output, NeverType) && !IRType.same(output, NeverType)) {
        write("match ");
        call(index, occurrence);
        write(" { Ok(value) => match value {}, Err(error) => Err(error) }");
      } else call(index, occurrence);
    };
    const render = (e: RustExpr, role?: GeneratedRange["role"]): void => {
      const body = () =>
        Match.value(e).pipe(
          Match.tagsExhaustive({
            Parameter: (n) => write(`p${n.index}`),
            Bound: (n) => write(n.name),
            Local: (n) => write(`v${n.index}`),
            Literal: (n) => write(typeof n.value === "bigint" ? `${n.value}u64` : String(n.value)),
            Call: (n) => {
              if (n.method === "not") {
                write("!(");
                render(n.args[0]);
                write(")");
              } else if (n.method === "eq" || n.method === "lt") {
                write("(");
                render(n.args[0]);
                write(n.method === "eq" ? ") == (" : ") < (");
                render(n.args[1]);
                write(")");
              } else {
                write("(");
                render(n.args[0]);
                write(`).${n.method}(`);
                render(n.args[1]);
                write(")");
              }
            },
            Match: (n) => {
              write("if ");
              render(n.condition);
              write(" { ");
              call(n.onTrue, n.onTrueUse);
              write(" } else { ");
              call(n.onFalse, n.onFalseUse);
              write(" }");
            },
          }),
        );
      if (e.origin) writer.mapped(e.origin, e.occurrence, body, role);
      else body();
    };
    const renderBlock = (block: RustBlock) => {
      write("{\n");
      for (const binding of block.bindings) {
        write(`    let v${binding.index}: `);
        if (binding.value.origin)
          writer.mapped(
            binding.value.origin,
            binding.value.occurrence,
            () => write(typeName(binding.type)),
            "definition",
          );
        else write(typeName(binding.type));
        write(" = ");
        render(binding.value, "definition");
        write(";\n");
      }
      write("    ");
      render(block.body);
      write("\n}");
    };
    const resultType = (output: IRType<unknown>, error?: IRType<unknown>) =>
      error ? `Result<${typeName(output)}, ${typeName(error)}>` : typeName(output);
    for (const helper of f.helpers) {
      // Inlining shared control flow can recreate exponential trees; preserve existing optimization boundary.
      write("#[inline(never)]\nfn ");
      writer.mapped(
        helper.origin,
        useAt(helper.path),
        () => write(`h_${f.name}_${helper.index}`),
        "definition",
      );
      write(`(${helper.input.map((p) => `${p.name}: ${typeName(p.type)}`).join(", ")}) -> `);
      writer.mapped(
        helper.origin,
        useAt(helper.path),
        () => write(resultType(helper.output, helper.error)),
        "definition",
      );
      write(" ");
      const use = (edge: string) => useAt(`${helper.path}.${edge}`);
      Match.value(helper.body).pipe(
        Match.tagsExhaustive({
          Pure: (n) => renderBlock(n.block),
          Succeed: (n) => {
            write("{ ");
            mapped(helper.origin, undefined, "Ok");
            write("(");
            renderBlock(n.block);
            write(") }");
          },
          Fail: (n) => {
            write("{ ");
            mapped(helper.origin, undefined, "Err");
            write("(");
            renderBlock(n.block);
            write(") }");
          },
          Map: (n) => {
            write("{ match ");
            call(n.source, use("source"));
            write(` { Ok(${n.binder}) => Ok(`);
            renderBlock(n.block);
            write("), Err(error) => Err(error) } }");
          },
          FlatMap: (n) => {
            write("{ match ");
            call(n.source, use("source"));
            write(` { Ok(${n.binder}) => `);
            adapt(n.body, helper.output, use("body"));
            write(", Err(error) => Err(error) } }");
          },
          Match: (n) => {
            write("{ if ");
            renderBlock(n.condition);
            write(" { ");
            adapt(n.onTrue, helper.output, use("onTrue"));
            write(" } else { ");
            adapt(n.onFalse, helper.output, use("onFalse"));
            write(" } }");
          },
        }),
      );
      write("\n\n");
    }
    write("\npub fn ");
    writer.mapped(f.origin, useAt(f.path), () => write(`r_${f.name}`), "definition");
    write(`(${f.input.map((type, i) => `p${i}: ${typeName(type)}`).join(", ")}) -> `);
    writer.mapped(
      f.origin,
      useAt(f.path),
      () =>
        write(
          Match.value(f.node).pipe(
            Match.tagsExhaustive({
              Pure: () => typeName(f.output),
              Effect: (n) => resultType(f.output, n.error),
            }),
          ),
        ),
      "definition",
    );
    write(" ");
    Match.value(f.node).pipe(
      Match.tagsExhaustive({
        Pure: (n) => renderBlock(n.block),
        Effect: (n) => {
          write("{ ");
          adapt(n.root, f.output, useAt(`${f.path}.body`));
          write(" }");
        },
      }),
    );
    write("\n\n");
  }
  const print = (type: IRType<unknown>, value: string, channel?: "ok" | "err") => {
    if (IRType.same(type, NeverType)) return `match ${value} {}`;
    const prefix = channel
      ? `${channel}:${IRType.same(type, U64Type) ? "u64" : "bool"}:`
      : IRType.same(type, BoolType)
        ? "bool:"
        : "";
    return `println!("${prefix}{}", ${value})`;
  };
  const arms = module.functions
    .map((f) => {
      const call = `reffect_generated::r_${f.name}(${f.input.map((type, i) => `args[${i + 1}].parse::<${typeName(type)}>().map_err(|_| "invalid ${typeName(type)}")?`).join(", ")})`;
      const output = Match.value(f.node).pipe(
        Match.tagsExhaustive({
          Pure: () => `{ let value = ${call}; ${print(f.output, "value")}; }`,
          Effect: (n) =>
            `match ${call} { Ok(value) => ${print(f.output, "value", "ok")}, Err(error) => ${print(n.error, "error", "err")} }`,
        }),
      );
      return `        "${f.name}" if args.len() == ${f.input.length + 1} => ${output},`;
    })
    .join("\n");
  const files = Object.freeze({
    "Cargo.toml":
      '[package]\nname = "reffect_generated"\nversion = "0.0.0"\nedition = "2021"\n\n[workspace]\n',
    "src/lib.rs": writer.text,
    "src/main.rs": `fn main() -> Result<(), &'static str> {\n    let args: Vec<String> = std::env::args().skip(1).collect();\n    match args.first().map(String::as_str).ok_or("missing function")? {\n${arms}\n        _ => return Err("unknown function or incorrect arity"),\n    }\n    Ok(())\n}\n`,
  });
  return Object.freeze({ files, ranges: writer.ranges });
};
