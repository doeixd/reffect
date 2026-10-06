import { Match } from "effect";
import type { Computation, EffectFn } from "./effect-ir.ts";
import { checkEffectFunction } from "./effect-ir.ts";
import type { Diagnostic, Expr } from "./kernel.ts";
import { BoolType, IRType, NeverType, U64Type, UnitType } from "./kernel.ts";

/** Private source/topology limits, independent of semantic scheduler operation budgets. */
export const semaphoreStructureLimits = Object.freeze({
  computationDepth: 64,
  expressionDepth: 64,
  computationOccurrences: 512,
  expressionOccurrences: 4096,
});
export interface SemaphoreStructuralBounds {
  readonly computationOccurrences: number;
  readonly expressionOccurrences: number;
  readonly computationDepth: number;
  readonly expressionDepth: number;
  readonly acquisitions: number;
  readonly releases: number;
  readonly releaseScans: number;
  readonly registrations: number;
  readonly selectedCallbacks: number;
  readonly taskCapacity: number;
  readonly waiterCapacity: number;
}
export interface SemaphoreStructureAnalysis {
  readonly profile: "private-semaphore-structure@1";
  readonly structurallyAdmitted: boolean;
  readonly bounds: SemaphoreStructuralBounds | undefined;
  readonly diagnostics: readonly Diagnostic[];
}
interface Summary {
  readonly computations: number;
  readonly expressions: number;
  readonly depth: number;
  readonly expressionDepth: number;
  readonly guards: number;
  readonly groups: number;
  readonly children: number;
}
const zero: Summary = {
  computations: 0,
  expressions: 0,
  depth: 0,
  expressionDepth: 0,
  guards: 0,
  groups: 0,
  children: 0,
};
class Refusal {
  constructor(readonly diagnostic: Diagnostic) {}
}
interface Context {
  readonly owner: symbol;
  readonly guarded: boolean;
  readonly cleanup: boolean;
  readonly grouped: boolean;
}

/**
 * SNAT-014: each incoming DAG edge contributes its complete source expansion.
 * Match uses a maximum for executed guards and a sum for expanded source nodes.
 * This receipt does not certify semantic scheduler budgets, fixed runtime retry/scan
 * ceilings, emitted text size, runtime layout, or trusted expression callbacks.
 * It is private structural evidence, not compiler admission or a callback audit.
 */
export const analyzeSemaphoreStructure = (
  fn: EffectFn,
  path = "functions.work.body",
): SemaphoreStructureAnalysis => {
  const refuse = (code: string, at: string, message: string): never => {
    throw new Refusal({ code, stage: "check", path: at, message });
  };
  const profile = (at: string, message: string): never =>
    refuse("SEMAPHORE_STRUCTURAL_PROFILE", at, message);
  const limits = semaphoreStructureLimits;
  const scalar = (type: IRType<unknown>): boolean =>
    [BoolType, U64Type, UnitType].some((candidate) => IRType.same(candidate, type));
  const capped = (a: number, b: number, ceiling: number): number => Math.min(ceiling + 1, a + b);
  const check = (summary: Summary, at: string): Summary => {
    if (
      summary.computations > limits.computationOccurrences ||
      summary.expressions > limits.expressionOccurrences ||
      summary.depth > limits.computationDepth ||
      summary.expressionDepth > limits.expressionDepth
    )
      refuse(
        "SEMAPHORE_STRUCTURAL_GROWTH",
        at,
        "Semaphore structural source occurrences or depth exceed the private bound",
      );
    if (summary.groups > 1)
      profile(at, "At most one All group is allowed across all expanded source branches");
    return summary;
  };
  const combine = (a: Summary, b: Summary, at: string, branch = false): Summary =>
    check(
      {
        computations: capped(a.computations, b.computations, limits.computationOccurrences),
        expressions: capped(a.expressions, b.expressions, limits.expressionOccurrences),
        depth: Math.max(a.depth, b.depth),
        expressionDepth: Math.max(a.expressionDepth, b.expressionDepth),
        guards: branch
          ? Math.max(a.guards, b.guards)
          : capped(a.guards, b.guards, limits.computationOccurrences),
        groups: Math.min(2, a.groups + b.groups),
        children: Math.max(a.children, b.children),
      },
      at,
    );
  const expressionMemo = new Map<
    Expr<unknown>,
    { readonly count: number; readonly depth: number }
  >();
  const activeExpressions = new Set<Expr<unknown>>();
  const expression = (
    value: Expr<unknown>,
    at: string,
    depth = 1,
  ): { readonly count: number; readonly depth: number } => {
    if (activeExpressions.has(value))
      refuse("SEMAPHORE_STRUCTURAL_CYCLE", at, "Expression cycle has no finite source bound");
    if (depth > limits.expressionDepth)
      refuse("SEMAPHORE_STRUCTURAL_GROWTH", at, "Expression depth exceeds the private bound");
    const cached = expressionMemo.get(value);
    if (cached) return cached;
    activeExpressions.add(value);
    const children = Match.value(value.node).pipe(
      Match.tagsExhaustive({
        Parameter: () => [],
        Literal: () => [],
        Undefined: () => [],
        Apply: (n) => n.args,
        Match: (n) => [n.condition, n.onTrue, n.onFalse],
        Make: (n) => n.fields.filter((field): field is Expr<unknown> => field !== undefined),
        Get: (n) => [n.value],
        MatchTags: (n) => [n.value, ...n.cases.map((item) => item.body)],
        ArrayMake: (n) => n.elements,
        ArrayLength: (n) => [n.value],
        MatchUndefined: (n) => [n.value, n.onDefined, n.onUndefined],
        RecordQuery: (n) => (n.key === undefined ? [n.value] : [n.value, n.key]),
        Defined: (n) => [n.value],
        ArrayLoop: () =>
          profile(at, "Dynamic expression iteration is outside the private structural profile"),
      }),
    );
    let count = 1;
    let longest = 1;
    for (const child of children) {
      const receipt = expression(child, `${at}.expression`, depth + 1);
      count = capped(count, receipt.count, limits.expressionOccurrences);
      longest = Math.max(longest, 1 + receipt.depth);
      if (count > limits.expressionOccurrences || longest > limits.expressionDepth)
        refuse("SEMAPHORE_STRUCTURAL_GROWTH", at, "Expression expansion exceeds the private bound");
    }
    activeExpressions.delete(value);
    const receipt = Object.freeze({ count, depth: longest });
    expressionMemo.set(value, receipt);
    return receipt;
  };
  const active = new Set<Computation<unknown, unknown>>();
  const memo = new Map<Computation<unknown, unknown>, Map<string, Summary>>();
  const walk = (
    value: Computation<unknown, unknown>,
    at: string,
    context: Context,
    depth = 1,
  ): Summary => {
    if (active.has(value))
      refuse("SEMAPHORE_STRUCTURAL_CYCLE", at, "Computation cycle has no finite source bound");
    if (depth > limits.computationDepth)
      refuse("SEMAPHORE_STRUCTURAL_GROWTH", at, "Computation depth exceeds the private bound");
    const key = `${context.guarded}/${context.cleanup}/${context.grouped}`;
    const cached = memo.get(value)?.get(key);
    if (cached) return cached;
    if (!scalar(value.output) || !IRType.same(value.error, NeverType))
      profile(at, "Computation channels must be scalar/Never");
    active.add(value);
    const child = (body: Computation<unknown, unknown>, edge: string, next = context): Summary =>
      walk(body, `${at}.${edge}`, next, depth + 1);
    const expr = (body: Expr<unknown>, edge: string): Summary => {
      const result = expression(body, `${at}.${edge}`);
      return { ...zero, expressions: result.count, expressionDepth: result.depth };
    };
    const unsupported = (): never =>
      profile(at, `${value.node._tag} is outside the private structural profile`);
    const inner = Match.value(value.node).pipe(
      Match.tagsExhaustive({
        QueueMake: unsupported,
        QueueScope: unsupported,
        QueueOperation: unsupported,
        LatchMake: unsupported,
        LatchScope: unsupported,
        LatchOperation: unsupported,
        SemaphoreMake: unsupported,
        SemaphoreScope: unsupported,
        SemaphoreWithPermits: (n) => {
          if (n.binder !== context.owner)
            refuse("RESOURCE_ESCAPE", at, "Semaphore acquisition requires the root lexical owner");
          if (n.permits !== 1 || context.guarded || context.cleanup)
            profile(at, "Only non-nested one-permit acquisition outside cleanup is supported");
          const body = child(n.body, "body", { ...context, guarded: true });
          return { ...body, guards: capped(body.guards, 1, limits.computationOccurrences) };
        },
        TaskGroup: (n) => {
          if (
            n.mode !== "All" ||
            n.children.length < 2 ||
            n.children.length > 3 ||
            context.grouped ||
            context.cleanup
          )
            profile(at, "Only one unnested All2/3 outside cleanup is supported");
          let summary = zero;
          for (let index = 0; index < n.children.length; index++)
            summary = combine(
              summary,
              child(n.children[index], `children[${index}]`, { ...context, grouped: true }),
              at,
            );
          return check(
            {
              ...summary,
              groups: Math.min(2, summary.groups + 1),
              children: Math.max(summary.children, n.children.length),
            },
            at,
          );
        },
        Succeed: (n) => expr(n.value, "value"),
        Map: (n) => combine(child(n.source, "source"), expr(n.body, "body"), at),
        FlatMap: (n) => combine(child(n.source, "source"), child(n.body, "body"), at),
        Match: (n) =>
          combine(
            expr(n.condition, "condition"),
            combine(child(n.onTrue, "onTrue"), child(n.onFalse, "onFalse"), at, true),
            at,
          ),
        Ensuring: (n) =>
          combine(
            child(n.body, "body"),
            child(n.finalizer, "finalizer", { ...context, cleanup: true }),
            at,
          ),
        Sleep: () => zero,
        Log: (n) =>
          n.attributes.reduce(
            (summary, [, value], index) =>
              combine(summary, expr(value, `attributes[${index}]`), at),
            zero,
          ),
        ClockReadMillis: unsupported,
        RandomDraw: unsupported,
        DeferredMake: unsupported,
        DeferredScope: unsupported,
        DeferredAwait: unsupported,
        DeferredComplete: unsupported,
        DeferredIsDone: unsupported,
        RefMake: unsupported,
        RefScope: unsupported,
        RefGet: unsupported,
        RefModify: unsupported,
        Scope: unsupported,
        AddFinalizer: unsupported,
        AcquireRelease: unsupported,
        RegisteredFile: unsupported,
        AcquireUseRelease: unsupported,
        FileScope: unsupported,
        FileSize: unsupported,
        Repeat: unsupported,
        Retry: unsupported,
        Launch: unsupported,
        RemoteStore: unsupported,
        SqlExecute: unsupported,
        StreamRunCollect: unsupported,
        StreamEmit: unsupported,
        Fail: unsupported,
        CatchAll: unsupported,
        MatchTags: unsupported,
        ForEach: unsupported,
        Annotate: unsupported,
        Span: unsupported,
      }),
    );
    const result = check(
      {
        ...inner,
        computations: capped(inner.computations, 1, limits.computationOccurrences),
        depth: inner.depth + 1,
      },
      at,
    );
    active.delete(value);
    let contexts = memo.get(value);
    if (!contexts) {
      contexts = new Map();
      memo.set(value, contexts);
    }
    contexts.set(key, result);
    return result;
  };
  try {
    if (fn.input.length !== 0 || !scalar(fn.output) || !IRType.same(fn.error, NeverType))
      profile(path, "Function must have zero inputs and scalar/Never channels");
    const root = Match.value(fn.body.node).pipe(
      Match.tag("SemaphoreScope", (node) => node),
      Match.orElse(() =>
        profile(path, "Exactly one root lexical Semaphore owner with capacity 1..3 is required"),
      ),
    );
    if (!Number.isInteger(root.capacity) || root.capacity < 1 || root.capacity > 3)
      profile(path, "Exactly one root lexical Semaphore owner with capacity 1..3 is required");
    const summary = walk(root.body, `${path}.body`, {
      owner: root.binder,
      guarded: false,
      cleanup: false,
      grouped: false,
    });
    const total = check(
      {
        ...summary,
        computations: capped(summary.computations, 1, limits.computationOccurrences),
        depth: summary.depth + 1,
      },
      path,
    );
    const diagnostics = checkEffectFunction(fn, path);
    if (diagnostics.length)
      return Object.freeze({
        profile: "private-semaphore-structure@1",
        structurallyAdmitted: false,
        bounds: undefined,
        diagnostics: Object.freeze(Array.from(diagnostics)),
      });
    const waiterCapacity = Math.max(1, total.children);
    const registrations = total.guards + waiterCapacity * total.guards;
    const bounds: SemaphoreStructuralBounds = Object.freeze({
      computationOccurrences: total.computations,
      expressionOccurrences: total.expressions,
      computationDepth: total.depth,
      expressionDepth: total.expressionDepth,
      acquisitions: total.guards,
      releases: total.guards,
      releaseScans: total.guards,
      registrations,
      selectedCallbacks: registrations,
      taskCapacity: total.children === 0 ? 1 : 1 + total.children,
      waiterCapacity,
    });
    return Object.freeze({
      profile: "private-semaphore-structure@1",
      structurallyAdmitted: true,
      bounds,
      diagnostics: Object.freeze([]),
    });
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return Object.freeze({
      profile: "private-semaphore-structure@1",
      structurallyAdmitted: false,
      bounds: undefined,
      diagnostics: Object.freeze([error.diagnostic]),
    });
  }
};
