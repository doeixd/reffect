import { Match } from "effect";
import type { Computation, EffectFn } from "./effect-ir.ts";
import { BoolType, IRType, NumberType, StringType, U64Type, UnitType, fail } from "./kernel.ts";
import type { Expr } from "./kernel.ts";
import { nestingDepth, NESTING_LIMIT } from "./nesting.ts";

export const generatedDeferredGrowthLimits = Object.freeze({
  computationDepth: 50,
  computationOccurrences: 512,
  expressionDepth: 64,
  expressionOccurrences: 4096,
  textBytes: 65536,
  moduleComputations: 4096,
  moduleExpressions: 32768,
  moduleTextBytes: 262144,
  rustBytes: 2097152,
});

export interface GeneratedDeferredGrowth {
  readonly computationDepth: number;
  readonly computationOccurrences: number;
  readonly expressionDepth: number;
  readonly expressionOccurrences: number;
  readonly textBytes: number;
}
const empty: GeneratedDeferredGrowth = Object.freeze({
  computationDepth: 0,
  computationOccurrences: 0,
  expressionDepth: 0,
  expressionOccurrences: 0,
  textBytes: 0,
});
export const checkGeneratedDeferredNesting = (fn: EffectFn, path: string): void => {
  if (nestingDepth(fn) === undefined)
    throw fail("NESTING_LIMIT", "check", path, `IR nesting must not exceed ${NESTING_LIMIT}`);
};
const refuse = (path: string, dimension: string, limit: number, stage = "check"): never => {
  throw fail(
    "DEFERRED_GENERATED_GROWTH",
    stage,
    path,
    `Private generated Deferred ${dimension} must not exceed ${limit}`,
  );
};

// Stop at the bound without allocating an encoded copy of arbitrarily large text.
const textBytes = (text: string, limit: number): number => {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    const point = text.codePointAt(index)!;
    count += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
    if (point > 65535) index++;
    if (count > limit) return limit + 1;
  }
  return count;
};

/** DGROW-001..003: full edge expansion, independent of selected execution branches. */
export const analyzeGeneratedDeferredGrowth = (
  fn: EffectFn,
  basePath = "functions.work.body",
  coordination: "Deferred" | "Semaphore" | "Latch" = "Deferred",
): GeneratedDeferredGrowth => {
  const limits = generatedDeferredGrowthLimits;
  const dimensions = [
    "computationDepth",
    "computationOccurrences",
    "expressionDepth",
    "expressionOccurrences",
    "textBytes",
  ] as const;
  const scalarTypes = [BoolType, U64Type, UnitType, StringType, NumberType] as const;
  const computations = new Map<Computation<unknown, unknown>["node"], GeneratedDeferredGrowth>();
  const expressions = new Map<Expr<unknown>["node"], GeneratedDeferredGrowth>();
  const activeComputations = new Set<Computation<unknown, unknown>["node"]>();
  const activeExpressions = new Set<Expr<unknown>["node"]>();
  const check = (value: GeneratedDeferredGrowth, path: string): GeneratedDeferredGrowth => {
    for (const key of dimensions) if (value[key] > limits[key]) refuse(path, key, limits[key]);
    return value;
  };
  const add = (
    a: GeneratedDeferredGrowth,
    b: GeneratedDeferredGrowth,
    path: string,
  ): GeneratedDeferredGrowth =>
    check(
      {
        computationDepth: Math.max(a.computationDepth, b.computationDepth),
        computationOccurrences: Math.min(
          limits.computationOccurrences + 1,
          a.computationOccurrences + b.computationOccurrences,
        ),
        expressionDepth: Math.max(a.expressionDepth, b.expressionDepth),
        expressionOccurrences: Math.min(
          limits.expressionOccurrences + 1,
          a.expressionOccurrences + b.expressionOccurrences,
        ),
        textBytes: Math.min(limits.textBytes + 1, a.textBytes + b.textBytes),
      },
      path,
    );
  const unaccounted = (path: string): never => {
    throw fail("DEFERRED_GROWTH_UNACCOUNTED", "check", path, "No private scalar growth receipt");
  };
  const expression = (value: Expr<unknown>, path: string, depth = 1): GeneratedDeferredGrowth => {
    if (depth > limits.expressionDepth) refuse(path, "expressionDepth", limits.expressionDepth);
    if (!scalarTypes.some((t) => IRType.same(t, value.type))) return unaccounted(path);
    if (activeExpressions.has(value.node))
      throw fail("DEFERRED_GROWTH_CYCLE", "check", path, "Cyclic expression has no growth bound");
    const cached = expressions.get(value.node);
    if (cached) {
      if (depth + cached.expressionDepth - 1 > limits.expressionDepth)
        refuse(path, "expressionDepth", limits.expressionDepth);
      return cached;
    }
    activeExpressions.add(value.node);
    let children = empty;
    const child = (body: Expr<unknown>, edge: string) => {
      children = add(children, expression(body, `${path}.${edge}`, depth + 1), path);
    };
    Match.value(value.node).pipe(
      Match.tags({
        Parameter: () => {},
        Literal: (n) => {
          if (typeof n.value === "string")
            children = { ...empty, textBytes: textBytes(n.value, limits.textBytes) };
        },
        Apply: (n) => n.args.forEach((arg, index) => child(arg, `args[${index}]`)),
        Match: (n) => {
          child(n.condition, "condition");
          child(n.onTrue, "onTrue");
          child(n.onFalse, "onFalse");
        },
      }),
      Match.orElse(() => unaccounted(path)),
    );
    const result = Object.freeze(
      check(
        {
          ...children,
          expressionOccurrences: children.expressionOccurrences + 1,
          expressionDepth: children.expressionDepth + 1,
        },
        path,
      ),
    );
    activeExpressions.delete(value.node);
    expressions.set(value.node, result);
    return result;
  };
  const computation = (
    value: Computation<unknown, unknown>,
    path: string,
    depth = 1,
  ): GeneratedDeferredGrowth => {
    if (depth > limits.computationDepth) refuse(path, "computationDepth", limits.computationDepth);
    if (activeComputations.has(value.node))
      throw fail("DEFERRED_GROWTH_CYCLE", "check", path, "Cyclic computation has no growth bound");
    const cached = computations.get(value.node);
    if (cached) {
      if (depth + cached.computationDepth - 1 > limits.computationDepth)
        refuse(path, "computationDepth", limits.computationDepth);
      return cached;
    }
    activeComputations.add(value.node);
    let children = empty;
    let allowance = 1;
    const child = (body: Computation<unknown, unknown>, edge: string) => {
      children = add(children, computation(body, `${path}.${edge}`, depth + allowance), path);
    };
    const pure = (body: Expr<unknown>, edge: string) => {
      children = add(children, expression(body, `${path}.${edge}`), path);
    };
    Match.value(value.node).pipe(
      Match.tags({
        QueueMake: () => unaccounted(path),
        QueueScope: () => unaccounted(path),
        QueueOperation: () => unaccounted(path),
        LatchScope: (n) => {
          if (coordination !== "Latch") return unaccounted(path);
          child(n.body, "body");
        },
        LatchOperation: () => {
          if (coordination !== "Latch") return unaccounted(path);
        },
        SemaphoreScope: (n) => {
          if (coordination !== "Semaphore") return unaccounted(path);
          child(n.body, "body");
        },
        SemaphoreWithPermits: (n) => {
          if (coordination !== "Semaphore") return unaccounted(path);
          child(n.body, "body");
        },
        DeferredScope: (n) => child(n.body, "body"),
        DeferredAwait: () => {},
        DeferredComplete: (n) => pure(n.value, "value"),
        DeferredIsDone: () => {},
        Map: (n) => {
          child(n.source, "source");
          pure(n.body, "body");
        },
        FlatMap: (n) => {
          child(n.source, "source");
          child(n.body, "body");
        },
        Match: (n) => {
          pure(n.condition, "condition");
          child(n.onTrue, "onTrue");
          child(n.onFalse, "onFalse");
        },
        Ensuring: (n) => {
          child(n.body, "body");
          child(n.finalizer, "finalizer");
        },
        TaskGroup: (n) => {
          allowance = 4;
          n.children.forEach((body, index) => child(body, `children[${index}]`));
        },
        Succeed: (n) => pure(n.value, "value"),
        Sleep: () => {},
        Log: (n) => {
          children = { ...empty, textBytes: textBytes(n.message, limits.textBytes) };
          n.attributes.forEach(([key, body]) => pure(body, `attributes.${key}`));
        },
      }),
      Match.orElse(() => unaccounted(path)),
    );
    const result = Object.freeze(
      check(
        {
          ...children,
          computationOccurrences: children.computationOccurrences + 1,
          computationDepth: children.computationDepth + allowance,
        },
        path,
      ),
    );
    activeComputations.delete(value.node);
    computations.set(value.node, result);
    return result;
  };
  return computation(fn.body, basePath);
};

export const checkGeneratedDeferredModuleGrowth = (
  receipts: readonly GeneratedDeferredGrowth[],
): GeneratedDeferredGrowth => {
  const total = { ...empty };
  const dimensions = [
    ["computationOccurrences", "moduleComputations"],
    ["expressionOccurrences", "moduleExpressions"],
    ["textBytes", "moduleTextBytes"],
  ] as const;
  for (const [dimension, limitKey] of dimensions) {
    for (const receipt of receipts) {
      total[dimension] += receipt[dimension];
      if (total[dimension] > generatedDeferredGrowthLimits[limitKey])
        refuse("functions", limitKey, generatedDeferredGrowthLimits[limitKey]);
    }
  }
  for (const receipt of receipts) {
    total.computationDepth = Math.max(total.computationDepth, receipt.computationDepth);
    total.expressionDepth = Math.max(total.expressionDepth, receipt.expressionDepth);
  }
  return Object.freeze(total);
};

/** Actual Rust output includes registry templates and escaping not visible in IR counts. */
export const checkGeneratedDeferredRustBytes = (
  files: Readonly<Record<string, string>>,
  coordination: "Deferred" | "Semaphore" | "Latch" = "Deferred",
): void => {
  let total = 0;
  const limit = generatedDeferredGrowthLimits.rustBytes;
  for (const [path, contents] of Object.entries(files)) {
    if (!path.endsWith(".rs")) continue;
    total += textBytes(contents, limit - total);
    if (total > limit)
      throw fail(
        `${coordination.toUpperCase()}_GENERATED_GROWTH`,
        "emit",
        `files.${path}`,
        `Generated ${coordination} Rust bytes must not exceed ${limit}`,
      );
  }
};
