import { Match } from "effect";
import { analyzeDeferredBudget, defaultDeferredBudgetContext } from "./deferred-budget.ts";
import {
  analyzeGeneratedDeferredGrowth,
  checkGeneratedDeferredModuleGrowth,
  checkGeneratedDeferredNesting,
} from "./deferred-growth.ts";
import type { GeneratedDeferredGrowth } from "./deferred-growth.ts";
import { deferredScalar } from "./deferred-model.ts";
import { EffectFn, checkEffectFunction } from "./effect-ir.ts";
import type { Computation } from "./effect-ir.ts";
import { CompileError, IRType, NeverType, fail } from "./kernel.ts";
import type { Program } from "./kernel.ts";
import { analyzeDeferredTopology, analyzeTaskGroups } from "./structured-concurrency.ts";

export interface GeneratedDeferredProfile {
  readonly taskCapacity: number;
  readonly ownerCount: number;
  readonly taskCapacities: ReadonlyMap<Computation<unknown, unknown>, number>;
}

/** Checked bounded standalone Deferred profile, shared by public admission and lowering. */
export const analyzeGeneratedDeferredProfile = (
  program: Program,
): ReadonlyMap<EffectFn, GeneratedDeferredProfile> => {
  const profiles = new Map<EffectFn, GeneratedDeferredProfile>();
  let growth: GeneratedDeferredGrowth | undefined;
  for (const [name, fn] of Object.entries(program.functions)) {
    if (!(fn instanceof EffectFn)) continue;
    const path = `functions.${name}`;
    checkGeneratedDeferredNesting(fn, path);
    const topology = analyzeDeferredTopology(fn.body, `${path}.body`, { nestedGroups: true });
    if (!topology.hasDeferred) continue;
    const receipt = analyzeGeneratedDeferredGrowth(fn, `${path}.body`);
    growth = checkGeneratedDeferredModuleGrowth(growth ? [growth, receipt] : [receipt]);
    const issues = checkEffectFunction(fn, path).filter(
      (issue) => issue.code !== "NESTED_TASK_GROUP",
    );
    if (issues.length)
      throw new CompileError({
        message: "Invalid generated Deferred function",
        diagnostics: issues,
      });
    const refuse = (at: string, message: string): never => {
      throw fail("DEFERRED_GENERATED_PROFILE", "lower", at, message);
    };
    if (fn.input.length || !deferredScalar(fn.output) || !IRType.same(fn.error, NeverType))
      refuse(
        path,
        "Bounded generated Deferred requires zero inputs, scalar success and Never error",
      );
    if (topology.diagnostics.length)
      throw new CompileError({
        message: "Unsupported generated Deferred topology",
        diagnostics: topology.diagnostics,
      });
    if (topology.taskCapacity > 6 || !Number.isSafeInteger(topology.ownerCount))
      refuse(
        path,
        "Bounded generated Deferred requires at most six live task contexts and finite owners",
      );
    if (analyzeTaskGroups(fn.body).requiresRichErrors)
      refuse(path, "Bounded generated Deferred has no compound outcome adapter");
    const budget = analyzeDeferredBudget(fn, `${path}.body`, defaultDeferredBudgetContext, true);
    if (!budget.admitted)
      throw new CompileError({
        message: "Unsupported conditional generated Deferred budget",
        diagnostics: budget.diagnostics,
      });
    const seen = new Map<Computation<unknown, unknown>, Set<string>>();
    const walk = (
      c: Computation<unknown, unknown>,
      at: string,
      ancestors: readonly ("All" | "Race")[] = [],
    ): void => {
      const context = ancestors.join("/");
      const contexts = seen.get(c) ?? new Set<string>();
      if (contexts.has(context)) return;
      contexts.add(context);
      seen.set(c, contexts);
      if (!IRType.same(c.error, NeverType) || !deferredScalar(c.output))
        refuse(at, "Every generated Deferred computation must have scalar success and Never error");
      const child = (body: Computation<unknown, unknown>, edge: string) =>
        walk(body, `${at}.${edge}`, ancestors);
      const unsupported = () =>
        refuse(at, "Operation is outside the bounded generated Deferred profile");
      Match.value(c.node).pipe(
        Match.tagsExhaustive({
          DeferredMake: unsupported,
          DeferredScope: (n) => {
            if (!deferredScalar(n.success) || !IRType.same(n.error, NeverType))
              refuse(at, "Generated Deferred owners require scalar success and Never error");
            child(n.body, "body");
          },
          DeferredAwait: () => {},
          DeferredComplete: (n) => {
            if (n.result !== "Succeed") unsupported();
          },
          DeferredIsDone: () => {},
          TaskGroup: (n) => {
            if (
              ancestors.length === 0
                ? n.mode !== "All"
                : ancestors.length !== 1 || ancestors[0] !== "All" || n.mode !== "Race"
            )
              refuse(
                at,
                "Bounded generated Deferred permits only outer All2/3 with an initial inner Race2",
              );
            n.children.forEach((value, i) =>
              walk(value, `${at}.children[${i}]`, [...ancestors, n.mode]),
            );
          },
          Ensuring: (n) => {
            child(n.body, "body");
            child(n.finalizer, "finalizer");
          },
          Map: (n) => child(n.source, "source"),
          FlatMap: (n) => {
            child(n.source, "source");
            child(n.body, "body");
          },
          Match: (n) => {
            child(n.onTrue, "onTrue");
            child(n.onFalse, "onFalse");
          },
          MatchTags: (n) => n.cases.forEach((value, i) => child(value.body, `cases[${i}]`)),
          Succeed: () => {},
          Sleep: () => {},
          Log: () => {},
          Fail: unsupported,
          CatchAll: unsupported,
          Retry: unsupported,
          Repeat: unsupported,
          ForEach: unsupported,
          Scope: unsupported,
          AddFinalizer: unsupported,
          AcquireRelease: unsupported,
          AcquireUseRelease: unsupported,
          RegisteredFile: unsupported,
          FileScope: unsupported,
          FileSize: unsupported,
          RefScope: unsupported,
          RefMake: unsupported,
          RefGet: unsupported,
          RefModify: unsupported,
          ClockReadMillis: unsupported,
          RandomDraw: unsupported,
          Launch: unsupported,
          RemoteStore: unsupported,
          StreamRunCollect: unsupported,
          StreamEmit: unsupported,
          Annotate: unsupported,
          Span: unsupported,
        }),
      );
    };
    walk(fn.body, `${path}.body`);
    profiles.set(
      fn,
      Object.freeze({
        taskCapacity: topology.taskCapacity,
        ownerCount: topology.ownerCount,
        taskCapacities: topology.taskCapacities,
      }),
    );
  }
  return profiles;
};
