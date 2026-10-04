import { Match } from "effect";
import type { Computation, EffectFn } from "./effect-ir.ts";
import type { Diagnostic } from "./kernel.ts";

/** Private, conditional source-expansion analysis; not a compiler admission rule. */
export const deferredBudgetLimit = 2048;
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
 * Audited receipts: docs/research/deferred-budget.md, DBUD-001..005.
 * A finite result requires the documented default host/context assumptions.
 * Public Deferred, Schema inputs and unaccounted operations remain refused.
 */
export const analyzeDeferredBudget = (fn: EffectFn, path = "body"): DeferredBudgetAnalysis => {
  const diagnostics: Diagnostic[] = [];
  const active = new Set<Computation<unknown, unknown>>();
  // Reuse context-independent summaries; each incoming edge still adds its full weight.
  const summaries = new Map<Computation<unknown, unknown>, Weight>();
  const issue = (code: string, at: string, message: string): Weight => {
    diagnostics.push({ code, stage: "check", path: at, message });
    return saturated;
  };
  const walk = (c: Computation<unknown, unknown>, at: string): Weight => {
    if (active.has(c))
      return issue(
        "DEFERRED_BUDGET_CYCLE",
        at,
        "Cyclic computation has no finite occurrence bound",
      );
    const summary = summaries.get(c);
    if (summary) return summary;
    active.add(c);
    const child = (value: Computation<unknown, unknown>, edge: string) =>
      walk(value, `${at}.${edge}`);
    const unaccounted = () =>
      issue(
        "DEFERRED_BUDGET_UNACCOUNTED",
        at,
        `${c.node._tag} has no audited reference operation receipt`,
      );
    const result = Match.value(c.node).pipe(
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
          add(weight(12, 14), add(child(n.body, "body"), child(n.finalizer, "finalizer"))),
        TaskGroup: (n) => {
          if (n.children.length < 2 || n.children.length > 3)
            return issue("DEFERRED_BUDGET_TOPOLOGY", at, "Group receipt covers only 2/3 children");
          return n.children.reduce(
            (value, computation, i) => add(value, child(computation, `children[${i}]`)),
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
        Repeat: unaccounted,
        Retry: unaccounted,
        ForEach: unaccounted,
        StreamRunCollect: unaccounted,
        StreamEmit: unaccounted,
        Annotate: unaccounted,
        Span: unaccounted,
      }),
    );
    active.delete(c);
    summaries.set(c, result);
    return result;
  };
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
