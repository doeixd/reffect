import { Match } from "effect";
import { Computation, EffectFn } from "./effect-ir.ts";
import {
  analyzeGeneratedDeferredGrowth,
  checkGeneratedDeferredModuleGrowth,
} from "./deferred-growth.ts";
import type { GeneratedDeferredGrowth } from "./deferred-growth.ts";
import { CompileError } from "./kernel.ts";
import type { Program } from "./kernel.ts";
import { analyzeSemaphoreBudget } from "./semaphore-budget.ts";
import { checkSemaphoreExecutionReferences } from "./semaphore-execution.ts";
import { analyzeSemaphoreStructure } from "./semaphore-structure.ts";
import type { SemaphoreStructuralBounds } from "./semaphore-structure.ts";

export interface GeneratedSemaphoreProfile {
  readonly taskCapacity: number;
  readonly ownerCount: 1;
  readonly bounds: SemaphoreStructuralBounds;
  /** Lowering certifies every generated Pending through its semantic marker. */
  readonly driver: {
    readonly protocolRetries: 1;
    readonly scans: number;
    readonly callbacks: number;
    readonly settlementRounds: 3;
  };
}

export const hasSemaphoreComputation = (body: Computation<unknown, unknown>): boolean => {
  const pending = [body];
  const seen = new Set<Computation<unknown, unknown>>();
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (
      Match.value(current.node).pipe(
        Match.tags({
          SemaphoreMake: () => true,
          SemaphoreScope: () => true,
          SemaphoreWithPermits: () => true,
        }),
        Match.orElse(() => false),
      )
    )
      return true;
    for (const field of Object.values(current.node)) {
      if (field instanceof Computation) pending.push(field);
      else if (Array.isArray(field))
        for (const item of field) {
          if (item instanceof Computation) pending.push(item);
          else if (
            item &&
            typeof item === "object" &&
            "body" in item &&
            item.body instanceof Computation
          )
            pending.push(item.body);
        }
    }
  }
  return false;
};
const computationChildren = (
  body: Computation<unknown, unknown>,
): readonly Computation<unknown, unknown>[] => {
  const children: Computation<unknown, unknown>[] = [];
  for (const field of Object.values(body.node)) {
    if (field instanceof Computation) children.push(field);
    else if (Array.isArray(field))
      for (const item of field) {
        if (item instanceof Computation) children.push(item);
        else if (
          item &&
          typeof item === "object" &&
          "body" in item &&
          item.body instanceof Computation
        )
          children.push(item.body);
      }
  }
  return children;
};
/** SPUB-007: a Pending marker alone does not establish independent timer wake order. */
const checkConcurrentTimers = (body: Computation<unknown, unknown>, path: string): void => {
  const hasSleep = (child: Computation<unknown, unknown>): boolean =>
    Match.value(child.node).pipe(
      Match.tag("Sleep", () => true),
      Match.orElse(() => computationChildren(child).some(hasSleep)),
    );
  Match.value(body.node).pipe(
    Match.tag("TaskGroup", (node) => {
      if (node.children.filter(hasSleep).length > 1)
        throw new CompileError({
          message: "Unsupported concurrent Semaphore timers",
          diagnostics: [
            {
              code: "SEMAPHORE_CONCURRENT_TIMERS",
              stage: "check",
              path,
              message:
                "At most one All child may contain Sleep, including finalizers; independent timer wake ordering is not yet verified",
            },
          ],
        });
    }),
    Match.orElse(() => undefined),
  );
  for (const child of computationChildren(body)) checkConcurrentTimers(child, path);
};
const remapGrowth = (error: unknown): never => {
  if (!(error instanceof CompileError)) throw error;
  throw new CompileError({
    message: "Unsupported generated Semaphore growth",
    diagnostics: error.diagnostics.map((issue) => ({
      ...issue,
      code: issue.code.replace("DEFERRED_", "SEMAPHORE_"),
      message: issue.message.replaceAll("Deferred", "Semaphore"),
    })),
  });
};

/** SPUB-001..006: closed generated profile, never a user-issued admission override. */
export const analyzeGeneratedSemaphoreProfile = (
  program: Program,
): ReadonlyMap<EffectFn, GeneratedSemaphoreProfile> => {
  const profiles = new Map<EffectFn, GeneratedSemaphoreProfile>();
  const growth: GeneratedDeferredGrowth[] = [];
  for (const [name, fn] of Object.entries(program.functions)) {
    if (!(fn instanceof EffectFn) || !hasSemaphoreComputation(fn.body)) continue;
    const path = `functions.${name}.body`;
    const structure = analyzeSemaphoreStructure(fn, path);
    if (!structure.structurallyAdmitted || !structure.bounds)
      throw new CompileError({
        message: "Unsupported generated Semaphore structure",
        diagnostics: structure.diagnostics,
      });
    checkConcurrentTimers(fn.body, path);
    checkSemaphoreExecutionReferences(fn);
    const budget = analyzeSemaphoreBudget(fn, path);
    if (!budget.admitted || !budget.bounds)
      throw new CompileError({
        message: "Unsupported generated Semaphore budget",
        diagnostics: budget.diagnostics,
      });
    try {
      growth.push(analyzeGeneratedDeferredGrowth(fn, path, "Semaphore"));
      checkGeneratedDeferredModuleGrowth(growth);
    } catch (error) {
      remapGrowth(error);
    }
    profiles.set(
      fn,
      Object.freeze({
        taskCapacity: structure.bounds.taskCapacity,
        ownerCount: 1,
        bounds: structure.bounds,
        driver: Object.freeze({
          protocolRetries: budget.bounds.retry,
          scans: budget.bounds.scans,
          callbacks: budget.bounds.callbacks,
          settlementRounds: budget.bounds.settlement,
        }),
      }),
    );
  }
  return profiles;
};
