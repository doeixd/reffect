import { Match } from "effect";
import type { Computation, EffectFn } from "./effect-ir.ts";
import { validQueueCapacity } from "./queue-model.ts";
import type { Diagnostic } from "./kernel.ts";
import { defaultDeferredBudgetContext } from "./deferred-budget.ts";
import type { DeferredBudgetContext } from "./deferred-budget.ts";

export const queueBudgetLimit = 2048;
export interface QueueBudgetAnalysis {
  readonly profile: "effect-4.0.0-default-zero-input";
  readonly plain: number;
  readonly framed: number;
  readonly offers: number;
  readonly takes: number;
  readonly terminals: number;
  readonly admitted: boolean;
  readonly diagnostics: readonly Diagnostic[];
}
interface Summary {
  readonly plain: number;
  readonly framed: number;
  readonly offers: number;
  readonly takes: number;
  readonly terminals: number;
}
const summary = (plain: number, framed = plain, offers = 0, takes = 0, terminals = 0): Summary => ({
  plain,
  framed,
  offers,
  takes,
  terminals,
});
const cap = (n: number) => Math.min(queueBudgetLimit, n);
const add = (a: Summary, b: Summary): Summary =>
  summary(
    cap(a.plain + b.plain),
    cap(a.framed + b.framed),
    cap(a.offers + b.offers),
    cap(a.takes + b.takes),
    cap(a.terminals + b.terminals),
  );
const maximum = (a: Summary, b: Summary): Summary =>
  summary(
    Math.max(a.plain, b.plain),
    Math.max(a.framed, b.framed),
    Math.max(a.offers, b.offers),
    Math.max(a.takes, b.takes),
    Math.max(a.terminals, b.terminals),
  );

/**
 * QBUD-001–004: conditional source expansion, separate from trusted callbacks,
 * generated ownership and enforcement of the reference host/context boundary.
 */
export const analyzeQueueBudget = (
  fn: EffectFn,
  path = "body",
  context: DeferredBudgetContext = defaultDeferredBudgetContext,
  interruptionFrames = true,
  cleanup = false,
): QueueBudgetAnalysis => {
  const diagnostics: Diagnostic[] = [];
  const active = new Set<Computation<unknown, unknown>>();
  const summaries = new Map<Computation<unknown, unknown>, Map<boolean, Summary>>();
  const issue = (code: string, at: string, message: string): Summary => {
    diagnostics.push({ code, stage: "check", path: at, message });
    return summary(queueBudgetLimit);
  };
  const walk = (
    c: Computation<unknown, unknown>,
    at: string,
    observed = interruptionFrames,
  ): Summary => {
    if (active.has(c))
      return issue("QUEUE_BUDGET_CYCLE", at, "Cyclic computation has no finite occurrence bound");
    const cached = summaries.get(c)?.get(observed);
    if (cached) return cached;
    active.add(c);
    const child = (value: Computation<unknown, unknown>, edge: string) =>
      walk(value, `${at}.${edge}`, observed);
    const unaccounted = () =>
      issue(
        "QUEUE_BUDGET_UNACCOUNTED",
        at,
        `${c.node._tag} has no audited Queue reference operation receipt`,
      );
    const ordinary = Match.value(c.node).pipe(
      Match.tags({
        Succeed: () => summary(5),
        Map: (n) => add(summary(7, 8), child(n.source, "source")),
        FlatMap: (n) => add(summary(2, 6), add(child(n.source, "source"), child(n.body, "body"))),
        CatchAll: (n) => add(summary(3, 5), add(child(n.source, "source"), child(n.body, "body"))),
        Match: (n) =>
          add(summary(4, 8), maximum(child(n.onTrue, "onTrue"), child(n.onFalse, "onFalse"))),
        Log: (n) => (n.attributes.length === 0 ? summary(9) : unaccounted()),
        QueueScope: (n) =>
          validQueueCapacity(n.capacity)
            ? add(summary(4, 6), child(n.body, "body"))
            : issue("QUEUE_BUDGET_CAPACITY", at, "Queue receipt requires literal capacity 1..3"),
        QueueOperation: (n) =>
          n.operation === "Offer"
            ? summary(16, 16, 1)
            : n.operation === "Take"
              ? summary(16, 18, 0, 1)
              : n.operation === "End" || n.operation === "Shutdown"
                ? summary(16, 16, 0, 0, 1)
                : unaccounted(),
        Ensuring: (n) =>
          cleanup
            ? add(
                summary(12, 14),
                add(child(n.body, "body"), walk(n.finalizer, `${at}.finalizer`, false)),
              )
            : unaccounted(),
        Sleep: (n) =>
          cleanup &&
          Number.isInteger(n.milliseconds) &&
          n.milliseconds >= 1 &&
          n.milliseconds <= 2147483647
            ? summary(14)
            : unaccounted(),
        TaskGroup: (n) => {
          if (n.mode !== "All" || n.children.length !== 2)
            return issue("QUEUE_BUDGET_TOPOLOGY", at, "Queue group receipt covers only All2");
          return n.children.reduce(
            (value, computation, i) => {
              // Group children omit the root observer but retain framed decorations.
              const receipt = walk(computation, `${at}.children[${i}]`, false);
              return add(value, receipt);
            },
            summary(28, 30),
          );
        },
      }),
      Match.orElse(unaccounted),
    );
    const result = observed ? add(summary(0, 20), ordinary) : ordinary;
    active.delete(c);
    const modes = summaries.get(c) ?? new Map<boolean, Summary>();
    modes.set(observed, result);
    summaries.set(c, modes);
    return result;
  };
  for (const key of Object.keys(defaultDeferredBudgetContext) as (keyof DeferredBudgetContext)[])
    if (context[key] !== defaultDeferredBudgetContext[key])
      issue(
        "QUEUE_BUDGET_CONTEXT",
        `context.${key}`,
        `${key} is outside the audited default context`,
      );
  const base =
    fn.input.length === 0
      ? add(summary(24), walk(fn.body, path))
      : issue(
          "QUEUE_BUDGET_INPUT",
          "inputs",
          "Input Schema decoding has no audited receipt; this profile requires zero inputs",
        );
  // Closing End can schedule a taker pass without an appended offer; finalize
  // resumes terminal takers too. Charge all occurrences, even false terminal calls.
  const retry = cap(16 * (base.offers + base.terminals) * base.takes);
  const total = add(base, summary(retry));
  if (!diagnostics.length && Math.max(total.plain, total.framed) >= queueBudgetLimit)
    issue(
      "QUEUE_BUDGET_EXCEEDED",
      path,
      "Whole-invocation Queue reference operation bound must be below 2048",
    );
  return Object.freeze({
    profile: "effect-4.0.0-default-zero-input",
    ...total,
    admitted: diagnostics.length === 0,
    diagnostics: Object.freeze(diagnostics),
  });
};
