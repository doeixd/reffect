import { Context, Effect, Layer, Match, Pipeable } from "effect";
import { Cargo } from "./cargo.ts";
import {
  AddU64,
  Capabilities,
  IRType,
  CompileError,
  MulU64,
  SubU64,
  Targets,
  U64Type,
  checkFunction,
  fail,
} from "./kernel.ts";
import type {
  AnyOperation,
  Capability,
  EffectRef,
  Expr,
  Fn,
  OperationRef,
  Program,
  Requirement,
  SemanticRef,
} from "./kernel.ts";

export interface Implementation {
  readonly id: string;
  readonly operation: AnyOperation;
  readonly target: SemanticRef<"target">;
  readonly strategy: "generated";
  readonly capabilities: readonly Capability[];
  readonly crates: readonly string[];
  readonly rationale: string;
  readonly method: "wrapping_add" | "wrapping_sub" | "wrapping_mul";
}
export class Target extends Pipeable.Class {
  private constructor(
    readonly ref: SemanticRef<"target">,
    readonly capabilities: readonly Capability[],
    readonly implementations: readonly Implementation[],
  ) {
    super();
    Object.freeze(this);
  }
  get id() {
    return this.ref.id;
  }
  static make(ref: SemanticRef<"target">, implementations: readonly Implementation[]): Target {
    return new Target(ref, Object.freeze([]), Object.freeze(Array.from(implementations)));
  }
  static withCapabilities(capabilities: readonly Capability[]) {
    return (self: Target): Target =>
      new Target(self.ref, Object.freeze(Array.from(capabilities)), self.implementations);
  }
}
const implementation = (
  operation: AnyOperation,
  method: Implementation["method"],
): Implementation =>
  Object.freeze({
    id: `rust/${operation.id}`,
    operation,
    target: Targets.RustStd,
    strategy: "generated",
    capabilities: Object.freeze([Capabilities.U64]),
    crates: Object.freeze([]),
    method,
    rationale: `Rust u64::${method} preserves modulo 2^64 bigint semantics in every profile`,
  });
const implementations = Object.freeze([
  implementation(AddU64 as AnyOperation, "wrapping_add"),
  implementation(SubU64 as AnyOperation, "wrapping_sub"),
  implementation(MulU64 as AnyOperation, "wrapping_mul"),
]);
export const Rust = Object.freeze({
  std: Target.make(Targets.RustStd, implementations).pipe(
    Target.withCapabilities([Capabilities.U64]),
  ),
});

export interface Analysis {
  readonly program: Program;
  readonly operations: readonly AnyOperation[];
  readonly capabilities: readonly Capability[];
  readonly effects: readonly EffectRef[];
  readonly requirements: readonly Requirement[];
}
export interface Selection {
  readonly operation: AnyOperation;
  readonly selected: Implementation;
  readonly rejected: readonly { readonly id: string; readonly reason: string }[];
}
export class Plan extends Pipeable.Class {
  private constructor(
    readonly analysis: Analysis,
    readonly target: Target,
    readonly selections: readonly Selection[],
    readonly crates: readonly string[],
  ) {
    super();
    Object.freeze(this);
  }
  static make(
    analysis: Analysis,
    target: Target,
    selections: readonly Selection[],
    crates: readonly string[],
  ): Plan {
    return new Plan(
      analysis,
      target,
      Object.freeze(Array.from(selections)),
      Object.freeze(Array.from(crates)),
    );
  }
  static withSelections(selections: readonly Selection[]) {
    return (self: Plan): Plan => Plan.make(self.analysis, self.target, selections, self.crates);
  }
  static withCrates(crates: readonly string[]) {
    return (self: Plan): Plan => Plan.make(self.analysis, self.target, self.selections, crates);
  }
}
export interface Ownership {
  readonly plan: Plan;
  readonly mode: "primitive-copy";
}
export type RustExpr =
  | { readonly _tag: "Parameter"; readonly index: number }
  | { readonly _tag: "Literal"; readonly value: bigint }
  | {
      readonly _tag: "Call";
      readonly method: Implementation["method"];
      readonly left: RustExpr;
      readonly right: RustExpr;
    };
export interface RustModule {
  readonly functions: readonly {
    readonly name: string;
    readonly arity: number;
    readonly body: RustExpr;
  }[];
}
export interface Artifact {
  readonly files: Readonly<Record<"Cargo.toml" | "src/lib.rs" | "src/main.rs", string>>;
  readonly explanation: Plan;
  readonly stages: readonly string[];
}
export const stages = Object.freeze([
  "check",
  "derive",
  "normalize",
  "plan",
  "verify",
  "optimize",
  "ownership",
  "lower",
  "emit",
]);

// Prefixing with r_ also makes Rust keywords legal and keeps source names out of syntax positions.
const validName = /^[A-Za-z][A-Za-z0-9_]*$/;
const check = Effect.fn("Compile.check")(function* (program: Program) {
  const issues = Object.entries(program.functions).flatMap(([name, f]) => [
    ...(!validName.test(name)
      ? [
          {
            code: "INVALID_NAME",
            stage: "check",
            path: `functions.${name}`,
            message: "Function name must be an ASCII identifier",
          },
        ]
      : []),
    ...checkFunction(f, `functions.${name}`),
  ]);
  if (!Object.keys(program.functions).length)
    return yield* fail("EMPTY_PROGRAM", "check", "functions", "At least one function is required");
  if (issues.length)
    return yield* new CompileError({ message: "Invalid program", diagnostics: issues });
  return program;
});

const derive = Effect.fn("Compile.derive")(function* (
  program: Program,
): Effect.fn.Return<Analysis, CompileError> {
  yield* check(program);
  const found = new Map<OperationRef, AnyOperation>();
  const serializedIds = new Map<string, OperationRef>();
  const visited = new Set<Expr<unknown>>();
  const walk = (e: Expr<unknown>) => {
    if (visited.has(e)) return;
    visited.add(e);
    Match.value(e.node).pipe(
      Match.tagsExhaustive({
        Parameter: () => {},
        Literal: () => {},
        Apply: (n) => {
          const op = n.operation;
          if (
            (serializedIds.has(op.id) && serializedIds.get(op.id) !== op.ref) ||
            (found.has(op.ref) && found.get(op.ref) !== op)
          )
            throw fail(
              "IDENTITY_COLLISION",
              "derive",
              op.id,
              "Distinct operations share a semantic ID",
            );
          serializedIds.set(op.id, op.ref);
          found.set(op.ref, op);
          n.args.forEach(walk);
        },
      }),
    );
  };
  yield* Effect.try({
    try: () => Object.values(program.functions).forEach((f) => walk(f.body)),
    catch: (e) =>
      e instanceof CompileError ? e : fail("INVALID_IR", "derive", "program", String(e)),
  });
  const operations = Object.freeze([...found.values()].sort((a, b) => a.id.localeCompare(b.id)));
  const collect = <A extends SemanticRef<string>>(refs: readonly A[]) =>
    Object.freeze(Array.from(new Set(refs)).sort((a, b) => a.id.localeCompare(b.id)));
  return Object.freeze({
    program,
    operations,
    capabilities: collect(operations.flatMap((op) => op.capabilities)),
    effects: collect(operations.flatMap((op) => op.effects)),
    requirements: collect(operations.flatMap((op) => op.requirements)),
  });
});
const normalize = Effect.fn("Compile.normalize")(function* (analysis: Analysis) {
  // The expression DAG is already canonical for the bootstrap subset. Re-derive to avoid stale reports.
  return yield* derive(analysis.program);
});

const plan = Effect.fn("Compile.plan")(function* (
  analysis: Analysis,
  target: Target = Rust.std,
): Effect.fn.Return<Plan, CompileError> {
  const derived = yield* derive(analysis.program);
  const selections: Selection[] = [];
  for (const op of derived.operations) {
    const rejected: { id: string; reason: string }[] = [];
    let selected: Implementation | undefined;
    for (const candidate of target.implementations.filter((i) => i.operation.id === op.id)) {
      const reason =
        candidate.operation.ref !== op.ref || candidate.operation !== op
          ? "Semantic identity collision"
          : candidate.target !== target.ref
            ? "Wrong target"
            : op.capabilities.some(
                  (c) => !target.capabilities.includes(c) || !candidate.capabilities.includes(c),
                )
              ? "Missing capability"
              : !implementations.includes(candidate)
                ? "No verified Rust lowering registered for this candidate"
                : undefined;
      if (reason) rejected.push({ id: candidate.id, reason });
      else if (selected)
        rejected.push({ id: candidate.id, reason: "An earlier compatible candidate was selected" });
      else selected = candidate;
    }
    if (!selected)
      return yield* fail(
        "UNSUPPORTED_OPERATION",
        "plan",
        op.id,
        `No semantics-preserving implementation for ${op.id}: ${rejected.map((r) => r.reason).join(", ") || "no candidates"}`,
      );
    selections.push(Object.freeze({ operation: op, selected, rejected: Object.freeze(rejected) }));
  }
  return Plan.make(
    derived,
    target,
    selections,
    Array.from(new Set(selections.flatMap((s) => s.selected.crates))).sort(),
  );
});
const verify = Effect.fn("Compile.verify")(function* (p: Plan) {
  const expected = yield* plan(p.analysis, p.target);
  if (
    p.selections.length !== expected.selections.length ||
    p.selections.some(
      (s, i) =>
        s.operation !== expected.selections[i].operation ||
        s.selected !== expected.selections[i].selected,
    ) ||
    p.crates.join() !== expected.crates.join()
  )
    return yield* fail(
      "INVALID_PLAN",
      "verify",
      "selections",
      "Selected plan does not cover the reachable graph with verified implementations",
    );
  for (const f of Object.values(p.analysis.program.functions)) {
    const visited = new Set<Expr<unknown>>();
    const supported = (e: Expr<unknown>): boolean => {
      if (visited.has(e)) return true;
      visited.add(e);
      return (
        IRType.same(e.type, U64Type) &&
        Match.value(e.node).pipe(
          Match.tagsExhaustive({
            Parameter: () => true,
            Literal: () => true,
            Apply: (n) => n.args.every(supported),
          }),
        )
      );
    };
    if (
      f.input.some((t) => !IRType.same(t, U64Type)) ||
      !IRType.same(f.output, U64Type) ||
      !supported(f.body)
    )
      return yield* fail(
        "UNSUPPORTED_REPRESENTATION",
        "verify",
        "function",
        "The Rust bootstrap target requires the checked builtin u64 representation",
      );
  }
  return expected;
});
const optimize = Effect.fn("Compile.optimize")(function* (p: Plan) {
  // No law-driven rewrites until evidence/conformance infrastructure warrants them.
  return yield* verify(p);
});
const analyzeOwnership = Effect.fn("Compile.ownership")(function* (
  p: Plan,
): Effect.fn.Return<Ownership, CompileError> {
  return Object.freeze({ plan: yield* verify(p), mode: "primitive-copy" });
});
const lower = Effect.fn("Compile.lower")(function* (
  ownership: Ownership,
): Effect.fn.Return<RustModule, CompileError> {
  const p = yield* verify(ownership.plan);
  if (ownership.mode !== "primitive-copy")
    return yield* fail("INVALID_OWNERSHIP", "lower", "ownership", "Unsupported ownership strategy");
  const selected = new Map<OperationRef, Implementation>(
    p.selections.map((s) => [s.operation.ref, s.selected]),
  );
  const expression = (e: Expr<unknown>): RustExpr => {
    return Match.value(e.node).pipe(
      Match.tagsExhaustive({
        Parameter: (n): RustExpr => ({ _tag: "Parameter", index: n.index }),
        Literal: (n): RustExpr => ({ _tag: "Literal", value: n.value as bigint }),
        Apply: (n): RustExpr => ({
          _tag: "Call",
          method: selected.get(n.operation.ref)!.method,
          left: expression(n.args[0]),
          right: expression(n.args[1]),
        }),
      }),
    );
  };
  return {
    functions: Object.entries(p.analysis.program.functions).map(([name, f]) => ({
      name,
      arity: f.input.length,
      body: expression(f.body),
    })),
  };
});
const render = (e: RustExpr): string =>
  Match.value(e).pipe(
    Match.tagsExhaustive({
      Parameter: (n) => `p${n.index}`,
      Literal: (n) => `${n.value}u64`,
      Call: (n) => `(${render(n.left)}).${n.method}(${render(n.right)})`,
    }),
  );
const emit = Effect.fn("Compile.emit")(function* (
  p: Plan,
): Effect.fn.Return<Artifact, CompileError> {
  const verified = yield* verify(p);
  const module = yield* lower(yield* analyzeOwnership(verified));
  const lib = module.functions
    .map(
      (f) =>
        `pub fn r_${f.name}(${Array.from({ length: f.arity }, (_, i) => `p${i}: u64`).join(", ")}) -> u64 {\n    ${render(f.body)}\n}\n`,
    )
    .join("\n");
  const arms = module.functions
    .map(
      (f) =>
        `        ${JSON.stringify(f.name)} if args.len() == ${f.arity + 1} => println!("{}", reffect_generated::r_${f.name}(${Array.from({ length: f.arity }, (_, i) => `args[${i + 1}].parse::<u64>().map_err(|_| "invalid u64")?`).join(", ")})),`,
    )
    .join("\n");
  return Object.freeze({
    explanation: verified,
    stages,
    files: Object.freeze({
      "Cargo.toml":
        '[package]\nname = "reffect_generated"\nversion = "0.0.0"\nedition = "2021"\n\n[workspace]\n',
      "src/lib.rs": lib,
      "src/main.rs": `fn main() -> Result<(), &'static str> {\n    let args: Vec<String> = std::env::args().skip(1).collect();\n    match args.first().map(String::as_str).ok_or("missing function")? {\n${arms}\n        _ => return Err("unknown function or incorrect arity"),\n    }\n    Ok(())\n}\n`,
    }),
  });
});
const run = Effect.fn("Compile.run")(function* (program: Program, target: Target = Rust.std) {
  const checked = yield* check(program);
  const derived = yield* derive(checked);
  const normalized = yield* normalize(derived);
  const planned = yield* plan(normalized, target);
  const verified = yield* verify(planned);
  const optimized = yield* optimize(verified);
  return yield* emit(optimized);
});

export const Compile = {
  check,
  derive,
  normalize,
  plan,
  verify,
  optimize,
  analyzeOwnership,
  lower,
  emit,
  run,
  build: Effect.fn("Compile.build")(function* (
    program: Program,
    output: string,
    profile: "debug" | "release" = "release",
    target: Target = Rust.std,
  ) {
    const cargo = yield* Cargo;
    const artifact = yield* run(program, target);
    const directory = yield* cargo.write(artifact, output);
    const process = yield* cargo.build(directory, profile);
    return { artifact, directory, process, stages: stages.concat("build") };
  }),
  explain: Effect.fn("Compile.explain")(function* (program: Program, target: Target = Rust.std) {
    return yield* plan(yield* derive(program), target);
  }),
};
export class Compiler extends Context.Service<Compiler, typeof Compile>()("reffect/Compiler") {
  static readonly layer = Layer.succeed(Compiler, Compile);
}

export type { Fn };
