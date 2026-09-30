import { Match } from "effect";
import { BoolType, IRType, NeverType, U64Type } from "./kernel.ts";
import type { Expr, OperationRef, Program } from "./kernel.ts";
import { EffectFn } from "./effect-ir.ts";
import type { Computation } from "./effect-ir.ts";
import type { Implementation } from "./compiler.ts";
import type { GeneratedFiles } from "./cargo.ts";

export type RustExpr =
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
    };
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
  readonly index: number;
  readonly input: readonly Parameter[];
  readonly output: IRType<unknown>;
  readonly error?: IRType<unknown>;
  readonly body: HelperBody;
}
interface RustFunction {
  readonly name: string;
  readonly input: readonly IRType<unknown>[];
  readonly output: IRType<unknown>;
  readonly helpers: readonly Helper[];
  readonly node:
    | { readonly _tag: "Pure"; readonly block: RustBlock }
    | { readonly _tag: "Effect"; readonly root: number; readonly error: IRType<unknown> };
}
export interface RustModule {
  readonly functions: readonly RustFunction[];
}
interface Scope {
  readonly bindings: ReadonlyMap<symbol, readonly Parameter[]>;
  readonly input: readonly Parameter[];
}

export const lowerFunctions = (
  program: Program,
  selected: ReadonlyMap<OperationRef, Implementation>,
): RustModule =>
  Object.freeze({
    functions: Object.freeze(
      Object.entries(program.functions).map(([name, f]): RustFunction => {
        let next = 0;
        const helpers = new Map<number, Helper>();
        const pureMemo = new Map<Expr<unknown>, Map<Scope, number>>();
        const effectMemo = new Map<Computation<unknown, unknown>, Map<Scope, number>>();
        const input = Object.freeze(
          f.input.map((type, i) => Object.freeze({ name: `p${i}`, type })),
        );
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
        const pureHelper = (e: Expr<unknown>, scope: Scope): number => {
          const cached = pureMemo.get(e)?.get(scope);
          if (cached !== undefined) return cached;
          const index = next++;
          const scopes = pureMemo.get(e) ?? new Map<Scope, number>();
          scopes.set(scope, index);
          pureMemo.set(e, scopes);
          const body: HelperBody = Object.freeze({ _tag: "Pure", block: block(e, scope) });
          helpers.set(index, Object.freeze({ index, input: scope.input, output: e.type, body }));
          return index;
        };
        const block = (root: Expr<unknown>, scope: Scope): RustBlock => {
          const bindings: RustBinding[] = [];
          const memo = new Map<Expr<unknown>, RustExpr>();
          const expression = (e: Expr<unknown>): RustExpr => {
            const cached = memo.get(e);
            if (cached) return cached;
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
                    args: Object.freeze(n.args.map(expression)),
                  }),
                Match: (n): RustExpr =>
                  Object.freeze({
                    _tag: "Match",
                    condition: expression(n.condition),
                    onTrue: pureHelper(n.onTrue, scope),
                    onFalse: pureHelper(n.onFalse, scope),
                  }),
              }),
            );
            const local = Match.value(e.node).pipe(
              Match.tags({ Apply: () => true, Match: () => true }),
              Match.orElse(() => false),
            );
            const result = local ? RustExpr.local(bindings.length) : value;
            if (local)
              bindings.push(Object.freeze({ index: bindings.length, type: e.type, value }));
            memo.set(e, result);
            return result;
          };
          const body = expression(root);
          return Object.freeze({ bindings: Object.freeze(bindings), body });
        };
        const effectHelper = (
          c: Computation<unknown, unknown>,
          scope: Scope,
          error: IRType<unknown>,
        ): number => {
          const cached = effectMemo.get(c)?.get(scope);
          if (cached !== undefined) return cached;
          const index = next++;
          const scopes = effectMemo.get(c) ?? new Map<Scope, number>();
          scopes.set(scope, index);
          effectMemo.set(c, scopes);
          const body: HelperBody = Match.value(c.node).pipe(
            Match.tagsExhaustive({
              Succeed: (n): HelperBody => ({ _tag: "Succeed", block: block(n.value, scope) }),
              Fail: (n): HelperBody => ({ _tag: "Fail", block: block(n.error, scope) }),
              Map: (n): HelperBody => ({
                _tag: "Map",
                source: effectHelper(n.source, scope, error),
                binder: `b${index}`,
                block: block(n.body, nestedScope(scope, n.binder, n.source.output, index)),
              }),
              FlatMap: (n): HelperBody => ({
                _tag: "FlatMap",
                source: effectHelper(n.source, scope, error),
                binder: `b${index}`,
                body: effectHelper(
                  n.body,
                  nestedScope(scope, n.binder, n.source.output, index),
                  error,
                ),
              }),
              Match: (n): HelperBody => ({
                _tag: "Match",
                condition: block(n.condition, scope),
                onTrue: effectHelper(n.onTrue, scope, error),
                onFalse: effectHelper(n.onFalse, scope, error),
              }),
            }),
          );
          helpers.set(
            index,
            Object.freeze({
              index,
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
                root: effectHelper(f.body, rootScope, f.error),
                error: f.error,
              })
            : Object.freeze({ _tag: "Pure", block: block(f.body, rootScope) });
        return Object.freeze({
          name,
          input: f.input,
          output: f.output,
          helpers: Object.freeze(Array.from(helpers.values()).sort((a, b) => a.index - b.index)),
          node,
        });
      }),
    ),
  });

export const emitFunctions = (module: RustModule): GeneratedFiles["files"] => {
  const typeName = (type: IRType<unknown>) => type.native.type;
  const renderFunction = (f: RustFunction) => {
    const call = (index: number) =>
      `h_${f.name}_${index}(${f.helpers[index].input.map((p) => p.name).join(", ")})`;
    const adapt = (index: number, output: IRType<unknown>) =>
      IRType.same(f.helpers[index].output, NeverType) && !IRType.same(output, NeverType)
        ? `match ${call(index)} { Ok(value) => match value {}, Err(error) => Err(error) }`
        : call(index);
    const render = (e: RustExpr): string =>
      Match.value(e).pipe(
        Match.tagsExhaustive({
          Parameter: (n) => `p${n.index}`,
          Bound: (n) => n.name,
          Local: (n) => `v${n.index}`,
          Literal: (n) => (typeof n.value === "bigint" ? `${n.value}u64` : String(n.value)),
          Call: (n) => {
            const args = n.args.map(render);
            if (n.method === "not") return `!(${args[0]})`;
            if (n.method === "eq") return `(${args[0]}) == (${args[1]})`;
            if (n.method === "lt") return `(${args[0]}) < (${args[1]})`;
            return `(${args[0]}).${n.method}(${args[1]})`;
          },
          Match: (n) =>
            `if ${render(n.condition)} { ${call(n.onTrue)} } else { ${call(n.onFalse)} }`,
        }),
      );
    const renderBlock = (b: RustBlock) =>
      `{\n${b.bindings.map((binding) => `    let v${binding.index}: ${typeName(binding.type)} = ${render(binding.value)};\n`).join("")}    ${render(b.body)}\n}`;
    const helpers = f.helpers
      .map((helper) => {
        const body = Match.value(helper.body).pipe(
          Match.tagsExhaustive({
            Pure: (n) => renderBlock(n.block),
            Succeed: (n) => `{ Ok(${renderBlock(n.block)}) }`,
            Fail: (n) => `{ Err(${renderBlock(n.block)}) }`,
            Map: (n) =>
              `{ match ${call(n.source)} { Ok(${n.binder}) => Ok(${renderBlock(n.block)}), Err(error) => Err(error) } }`,
            FlatMap: (n) =>
              `{ match ${call(n.source)} { Ok(${n.binder}) => ${adapt(n.body, helper.output)}, Err(error) => Err(error) } }`,
            Match: (n) =>
              `{ if ${renderBlock(n.condition)} { ${adapt(n.onTrue, helper.output)} } else { ${adapt(n.onFalse, helper.output)} } }`,
          }),
        );
        const result = helper.error
          ? `Result<${typeName(helper.output)}, ${typeName(helper.error)}>`
          : typeName(helper.output);
        // Preserve shared control-flow graphs through Rust optimization; inlining can recreate exponential trees.
        return `#[inline(never)]\nfn h_${f.name}_${helper.index}(${helper.input.map((p) => `${p.name}: ${typeName(p.type)}`).join(", ")}) -> ${result} ${body}\n`;
      })
      .join("\n");
    const body = Match.value(f.node).pipe(
      Match.tagsExhaustive({
        Pure: (n) => renderBlock(n.block),
        Effect: (n) => `{ ${adapt(n.root, f.output)} }`,
      }),
    );
    const result = Match.value(f.node).pipe(
      Match.tagsExhaustive({
        Pure: () => typeName(f.output),
        Effect: (n) => `Result<${typeName(f.output)}, ${typeName(n.error)}>`,
      }),
    );
    return `${helpers}\npub fn r_${f.name}(${f.input.map((type, i) => `p${i}: ${typeName(type)}`).join(", ")}) -> ${result} ${body}\n`;
  };
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
  return Object.freeze({
    "Cargo.toml":
      '[package]\nname = "reffect_generated"\nversion = "0.0.0"\nedition = "2021"\n\n[workspace]\n',
    "src/lib.rs": module.functions.map(renderFunction).join("\n"),
    "src/main.rs": `fn main() -> Result<(), &'static str> {\n    let args: Vec<String> = std::env::args().skip(1).collect();\n    match args.first().map(String::as_str).ok_or("missing function")? {\n${arms}\n        _ => return Err("unknown function or incorrect arity"),\n    }\n    Ok(())\n}\n`,
  });
};
