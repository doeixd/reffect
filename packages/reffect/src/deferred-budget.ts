import { Match } from "effect";
import type { Computation, EffectFn } from "./effect-ir.ts";
import type { Diagnostic } from "./kernel.ts";

/** Private, conditional source-expansion analysis; not a compiler admission rule. */
export const deferredBudgetLimit = 2048;
export interface DeferredBudgetContext {
  readonly scheduler: "default" | "custom";
  readonly clock: "default" | "custom";
  readonly tracer: "default" | "custom";
  readonly hooks: "absent" | "custom";
  readonly outerHostEffects: "bounded-exit-only" | "custom";
}
/** Internal declaration of the conditional proof assumptions; never a user override. */
export const defaultDeferredBudgetContext: DeferredBudgetContext = Object.freeze({
  scheduler: "default",
  clock: "default",
  tracer: "default",
  hooks: "absent",
  outerHostEffects: "bounded-exit-only",
});
export interface DeferredBudgetAnalysis {
  readonly profile: "effect-4.0.0-default-zero-input";
  /** Saturates at the refusal threshold, rather than claiming an exact count. */
  readonly plain: number;
  readonly framed: number;
  readonly admitted: boolean;
  readonly diagnostics: readonly Diagnostic[];
}
interface Weight {
  readonly plain: number;
  readonly framed: number;
}
const weight = (plain: number, framed = plain): Weight => ({ plain, framed });
const saturated = weight(deferredBudgetLimit);
const add = (a: Weight, b: Weight): Weight =>
  weight(
    Math.min(deferredBudgetLimit, a.plain + b.plain),
    Math.min(deferredBudgetLimit, a.framed + b.framed),
  );
const maximum = (a: Weight, b: Weight): Weight =>
  weight(Math.max(a.plain, b.plain), Math.max(a.framed, b.framed));

/**
 * Audited receipts: docs/research/deferred-budget.md, DBUD-001..005, and DADM-002
 * in docs/research/deferred-integration-admission.md.
 * A finite result requires the documented default host/context assumptions.
 * Public admission, Schema inputs and unaccounted operations remain refused.
 */
export const analyzeDeferredBudget = (
  fn: EffectFn,
  path = "body",
  context: DeferredBudgetContext = defaultDeferredBudgetContext,
  interruptionFrames = false,
): DeferredBudgetAnalysis => {
  const diagnostics: Diagnostic[] = [];
  const active = new Set<Computation<unknown, unknown>>();
  // Reuse context-independent summaries; each incoming edge still adds its full weight.
  const summaries = new Map<Computation<unknown, unknown>, Map<boolean, Weight>>();
  const issue = (code: string, at: string, message: string): Weight => {
    diagnostics.push({ code, stage: "check", path: at, message });
    return saturated;
  };
  const walk = (
    c: Computation<unknown, unknown>,
    at: string,
    observed = interruptionFrames,
  ): Weight => {
    if (active.has(c))
      return issue(
        "DEFERRED_BUDGET_CYCLE",
        at,
        "Cyclic computation has no finite occurrence bound",
      );
    const summary = summaries.get(c)?.get(observed);
    if (summary) return summary;
    active.add(c);
    const child = (value: Computation<unknown, unknown>, edge: string) =>
      walk(value, `${at}.${edge}`, observed);
    const unaccounted = () =>
      issue(
        "DEFERRED_BUDGET_UNACCOUNTED",
        at,
        `${c.node._tag} has no audited reference operation receipt`,
      );
    const ordinary = Match.value(c.node).pipe(
      Match.tagsExhaustive({
        Succeed: () => weight(5),
        Fail: () => weight(5, 7),
        Map: (n) => add(weight(7, 8), child(n.source, "source")),
        FlatMap: (n) => add(weight(2, 6), add(child(n.source, "source"), child(n.body, "body"))),
        Match: (n) =>
          add(weight(4, 8), maximum(child(n.onTrue, "onTrue"), child(n.onFalse, "onFalse"))),
        MatchTags: (n) =>
          add(
            weight(4, 8),
            n.cases.reduce(
              (value, selected, i) => maximum(value, child(selected.body, `cases[${i}]`)),
              weight(0),
            ),
          ),
        CatchAll: (n) => add(weight(3, 5), add(child(n.source, "source"), child(n.body, "body"))),
        Ensuring: (n) =>
          add(
            weight(12, 14),
            add(child(n.body, "body"), walk(n.finalizer, `${at}.finalizer`, false)),
          ),
        TaskGroup: (n) => {
          if (n.children.length < 2 || n.children.length > 3)
            return issue("DEFERRED_BUDGET_TOPOLOGY", at, "Group receipt covers only 2/3 children");
          return n.children.reduce(
            (value, computation, i) => add(value, walk(computation, `${at}.children[${i}]`, false)),
            weight(24 + 2 * n.children.length, 26 + 2 * n.children.length),
          );
        },
        Sleep: (n) =>
          Number.isFinite(n.milliseconds) && n.milliseconds >= 0 && n.milliseconds <= 2147483647
            ? weight(14)
            : issue(
                "DEFERRED_BUDGET_TIMER",
                at,
                "Default timer receipt covers only 0..2147483647 milliseconds",
              ),
        Log: (n) => (n.attributes.length === 0 ? weight(9) : unaccounted()),
        QueueMake: unaccounted,
        QueueScope: unaccounted,
        QueueOperation: unaccounted,
        LatchMake: unaccounted,
        LatchScope: unaccounted,
        LatchOperation: unaccounted,
        SemaphoreMake: unaccounted,
        SemaphoreScope: unaccounted,
        SemaphoreWithPermits: unaccounted,
        DeferredMake: () => weight(3),
        DeferredScope: (n) => add(weight(4, 6), child(n.body, "body")),
        DeferredAwait: () => weight(11, 13),
        DeferredComplete: () => weight(6, 8),
        DeferredIsDone: () => weight(3),
        Scope: unaccounted,
        AddFinalizer: unaccounted,
        AcquireRelease: unaccounted,
        AcquireUseRelease: unaccounted,
        RegisteredFile: unaccounted,
        FileScope: unaccounted,
        FileSize: unaccounted,
        RefMake: unaccounted,
        RefScope: unaccounted,
        RefGet: unaccounted,
        RefModify: unaccounted,
        ClockReadMillis: unaccounted,
        RandomDraw: unaccounted,
        Launch: unaccounted,
        RemoteStore: unaccounted,
        SqlExecute: unaccounted,
        Repeat: unaccounted,
        Retry: unaccounted,
        ForEach: unaccounted,
        StreamRunCollect: unaccounted,
        StreamEmit: unaccounted,
        Annotate: unaccounted,
        Span: unaccounted,
      }),
    );
    // DINT-005: masked onExit observation, including retained Exit and restoration.
    // Infallible groups discard child trails; masked cleanup has no root observer.
    const result = observed ? add(weight(0, 20), ordinary) : ordinary;
    active.delete(c);
    const modes = summaries.get(c) ?? new Map<boolean, Weight>();
    modes.set(observed, result);
    summaries.set(c, modes);
    return result;
  };
  for (const key of Object.keys(defaultDeferredBudgetContext) as (keyof DeferredBudgetContext)[])
    if (context[key] !== defaultDeferredBudgetContext[key])
      issue(
        "DEFERRED_BUDGET_CONTEXT",
        `context.${key}`,
        `${key} is outside the audited default context`,
      );
  const total =
    fn.input.length === 0
      ? add(weight(24), walk(fn.body, path))
      : issue(
          "DEFERRED_BUDGET_INPUT",
          "inputs",
          "Input Schema decoding has no audited receipt; this profile requires zero inputs",
        );
  if (!diagnostics.length && Math.max(total.plain, total.framed) >= deferredBudgetLimit)
    issue(
      "DEFERRED_BUDGET_EXCEEDED",
      path,
      "Whole-invocation reference operation bound must be below 2048",
    );
  return {
    profile: "effect-4.0.0-default-zero-input",
    ...total,
    admitted: diagnostics.length === 0,
    diagnostics,
  };
};
