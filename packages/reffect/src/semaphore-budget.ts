import { Match } from "effect";
import type { Computation, EffectFn } from "./effect-ir.ts";
import type { Diagnostic } from "./kernel.ts";
import { analyzeSemaphoreStructure } from "./semaphore-structure.ts";
import { defaultDeferredBudgetContext } from "./deferred-budget.ts";
import type { DeferredBudgetContext } from "./deferred-budget.ts";

/** Conditional source-expansion analysis; callback/owned-context checks are separate. */
export const semaphoreBudgetLimit = 2048;

/** Generated-only ceilings: retry requires all Pending sources to be semantic. */
export interface SemaphoreDriverBudgets {
  readonly retry: 1;
  readonly scans: number;
  readonly callbacks: number;
  readonly settlement: 3;
}
export interface SemaphoreBudgetAnalysis {
  readonly profile: "effect-4.0.0-default-zero-input";
  /** Saturates at the refusal threshold, rather than claiming an exact count. */
  readonly plain: number;
  readonly framed: number;
  readonly admitted: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly bounds: SemaphoreDriverBudgets | undefined;
}
interface Weight {
  readonly plain: number;
  readonly framed: number;
}
const weight = (plain: number, framed = plain): Weight => ({ plain, framed });
const saturated = weight(semaphoreBudgetLimit);
const add = (a: Weight, b: Weight): Weight =>
  weight(
    Math.min(semaphoreBudgetLimit, a.plain + b.plain),
    Math.min(semaphoreBudgetLimit, a.framed + b.framed),
  );
const maximum = (a: Weight, b: Weight): Weight =>
  weight(Math.max(a.plain, b.plain), Math.max(a.framed, b.framed));

/**
 * Audited receipts: docs/research/semaphore-public-admission.md, SPUB-002/003,
 * plus ordinary primitive receipts in docs/research/deferred-budget.md.
 * A finite result requires the documented default host/context assumptions.
 * Callback identities and generated semantic Pending require separate checks.
 */
export const analyzeSemaphoreBudget = (
  fn: EffectFn,
  path = "body",
  context: DeferredBudgetContext = defaultDeferredBudgetContext,
  interruptionFrames = true,
): SemaphoreBudgetAnalysis => {
  const structure = analyzeSemaphoreStructure(fn, path);
  const rejected = (diagnostics: readonly Diagnostic[]): SemaphoreBudgetAnalysis =>
    Object.freeze({
      profile: "effect-4.0.0-default-zero-input",
      plain: semaphoreBudgetLimit,
      framed: semaphoreBudgetLimit,
      admitted: false,
      diagnostics: Object.freeze(Array.from(diagnostics)),
      bounds: undefined,
    });
  if (!structure.structurallyAdmitted || !structure.bounds) return rejected(structure.diagnostics);
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
        "SEMAPHORE_BUDGET_CYCLE",
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
        "SEMAPHORE_BUDGET_UNACCOUNTED",
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
            return issue("SEMAPHORE_BUDGET_TOPOLOGY", at, "Group receipt covers only 2/3 children");
          return n.children.reduce(
            (value, computation, i) => add(value, walk(computation, `${at}.children[${i}]`, false)),
            weight(24 + 2 * n.children.length, 26 + 2 * n.children.length),
          );
        },
        Sleep: (n) =>
          Number.isFinite(n.milliseconds) && n.milliseconds >= 0 && n.milliseconds <= 2147483647
            ? weight(14)
            : issue(
                "SEMAPHORE_BUDGET_TIMER",
                at,
                "Default timer receipt covers only 0..2147483647 milliseconds",
              ),
        Log: (n) => (n.attributes.length === 0 ? weight(9) : unaccounted()),
        LatchMake: unaccounted,
        LatchScope: unaccounted,
        LatchOperation: unaccounted,
        SemaphoreMake: unaccounted,
        SemaphoreScope: (n) => add(weight(4, 6), child(n.body, "body")),
        SemaphoreWithPermits: (n) => add(weight(8, 10), child(n.body, "body")),
        DeferredMake: unaccounted,
        DeferredScope: unaccounted,
        DeferredAwait: unaccounted,
        DeferredComplete: unaccounted,
        DeferredIsDone: unaccounted,
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
    // SPUB-002 / DINT-005: masked onExit, retained Exit and restoration.
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
        "SEMAPHORE_BUDGET_CONTEXT",
        `context.${key}`,
        `${key} is outside the audited default context`,
      );
  const total =
    fn.input.length === 0
      ? add(weight(24 + 12 * structure.bounds.registrations), walk(fn.body, path))
      : issue(
          "SEMAPHORE_BUDGET_INPUT",
          "inputs",
          "Input Schema decoding has no audited receipt; this profile requires zero inputs",
        );
  if (!diagnostics.length && Math.max(total.plain, total.framed) >= semaphoreBudgetLimit)
    issue(
      "SEMAPHORE_BUDGET_EXCEEDED",
      path,
      "Whole-invocation reference operation bound must be below 2048",
    );
  return Object.freeze({
    profile: "effect-4.0.0-default-zero-input",
    ...total,
    admitted: diagnostics.length === 0,
    diagnostics: Object.freeze(diagnostics),
    bounds:
      diagnostics.length === 0
        ? Object.freeze({
            retry: 1,
            scans: Math.max(1, structure.bounds.releaseScans + 1),
            callbacks: structure.bounds.selectedCallbacks,
            settlement: 3,
          })
        : undefined,
  });
};
