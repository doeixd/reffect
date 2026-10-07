import { Match } from "effect";
import { Computation, EffectFn, checkEffectFunction } from "./effect-ir.ts";
import { BoolType, CompileError, IRType, NeverType, U64Type, UnitType, fail } from "./kernel.ts";
import type { Expr, Program } from "./kernel.ts";
import { hasQueueComputation, usesQueueNativeType } from "./queue-profile.ts";
import { analyzeQueueBudget } from "./queue-budget.ts";
import type { QueueBudgetAnalysis } from "./queue-budget.ts";
import { QueueDoneType, validQueueCapacity } from "./queue-model.ts";
import { checkDeferredExecutionReferences } from "./deferred-execution.ts";
import {
  analyzeGeneratedDeferredGrowth,
  checkGeneratedDeferredModuleGrowth,
} from "./deferred-growth.ts";
import type { GeneratedDeferredGrowth } from "./deferred-growth.ts";

export interface GeneratedQueueProfile {
  readonly success: IRType<unknown>;
  readonly capacity: number;
  readonly completion: "None" | "End";
  readonly ownerCount: 1;
  readonly taskCapacity: 2;
  readonly bounds: GeneratedDeferredGrowth;
  readonly budget: QueueBudgetAnalysis;
}
const scalar = (type: IRType<unknown>): boolean =>
  [BoolType, U64Type, UnitType].some((builtin) => builtin === type);
const refuse = (path: string, message: string): never => {
  throw fail("QUEUE_STRUCTURAL_PROFILE", "check", path, message);
};
const remapGrowth = (error: unknown): never => {
  if (!(error instanceof CompileError)) throw error;
  throw new CompileError({
    message: `Unsupported generated Queue growth: ${error.message.replaceAll("Deferred", "Queue")}`,
    diagnostics: error.diagnostics.map((issue) => ({
      ...issue,
      code: issue.code.replace("DEFERRED_", "QUEUE_"),
      message: issue.message.replaceAll("Deferred", "Queue"),
    })),
  });
};
/** Checked representation/ownership receipt plus a conditional default-context budget. */
const analyzeQueueProfile = (
  program: Program,
  localDone: boolean,
): ReadonlyMap<EffectFn, GeneratedQueueProfile> => {
  const profiles = new Map<EffectFn, GeneratedQueueProfile>();
  const moduleGrowth: GeneratedDeferredGrowth[] = [];
  for (const [name, fn] of Object.entries(program.functions)) {
    if (!(fn instanceof EffectFn) || !hasQueueComputation(fn.body)) continue;
    const path = `functions.${name}.body`;
    let bounds: GeneratedDeferredGrowth;
    try {
      bounds = analyzeGeneratedDeferredGrowth(fn, path, "Queue");
      moduleGrowth.push(bounds);
      checkGeneratedDeferredModuleGrowth(moduleGrowth);
    } catch (error) {
      remapGrowth(error);
    }
    const diagnostics = checkEffectFunction(fn, `functions.${name}`);
    if (diagnostics.length)
      throw new CompileError({ message: "Invalid lexical Queue function", diagnostics });
    const root = Match.value(fn.body.node).pipe(
      Match.tag("QueueScope", (node) => node),
      Match.orElse(() => refuse(path, "Exactly one root lexical Queue is required")),
    );
    if (fn.input.length || !scalar(fn.output) || fn.error !== NeverType)
      refuse(path, "Generated Queue requires zero inputs and builtin scalar/Never channels");
    const done = localDone && root.error === QueueDoneType;
    if (
      !scalar(root.success) ||
      (!done && root.error !== NeverType) ||
      !validQueueCapacity(root.capacity)
    )
      refuse(path, "Queue owner requires builtin Bool/U64/Unit, Never and literal capacity 1..3");
    const audit = (expression: Expr<unknown>, occurrence: string) => {
      if (usesQueueNativeType(expression))
        refuse(occurrence, "Queue/Done values and hidden pure channels cannot escape");
      const body = Computation.make(expression.type, NeverType, {
        _tag: "Succeed",
        value: expression,
      });
      checkDeferredExecutionReferences(
        EffectFn.make([], expression.type, NeverType, () => body),
        (_at, message) => fail("QUEUE_REFERENCE_CONTEXT", "check", occurrence, message),
      );
    };
    let groups = 0;
    const walk = (
      body: Computation<unknown, unknown>,
      at: string,
      grouped = false,
      conditional = false,
      caught = false,
    ): void => {
      if (
        !scalar(body.output) ||
        (body.error !== NeverType && !(done && caught && body.error === QueueDoneType))
      )
        refuse(at, "Computation channels must be builtin scalar/Never");
      Match.value(body.node).pipe(
        Match.tags({
          QueueOperation: (node) => {
            if (!grouped) refuse(at, "Queue operations are only supported inside All2 children");
            if (
              node.binder !== root.binder ||
              node.success !== root.success ||
              node.error !== root.error
            )
              refuse(
                at,
                "Queue operation requires the root lexical owner and exact builtin channels",
              );
            if (
              node.operation !== "Offer" &&
              node.operation !== "Take" &&
              !(done && node.operation === "End")
            )
              refuse(at, "End/shutdown and Done are outside generated Queue");
            if (node.operation === "Offer") audit(node.value, `${at}.value`);
          },
          TaskGroup: (node) => {
            if (
              node.mode !== "All" ||
              node.children.length !== 2 ||
              grouped ||
              conditional ||
              caught ||
              ++groups > 1
            )
              refuse(at, "Exactly one unconditional unnested All2 is supported");
            node.children.forEach((child, index) => {
              if (child.output !== UnitType || child.error !== NeverType)
                refuse(at, "All2 children require builtin Unit/Never channels");
              walk(child, `${at}.children[${index}]`, true, false);
            });
          },
          Succeed: (node) => audit(node.value, `${at}.value`),
          Map: (node) => {
            walk(node.source, `${at}.source`, grouped, conditional, caught);
            audit(node.body, `${at}.body`);
          },
          FlatMap: (node) => {
            walk(node.source, `${at}.source`, grouped, conditional, caught);
            walk(node.body, `${at}.body`, grouped, conditional, caught);
          },
          Match: (node) => {
            audit(node.condition, `${at}.condition`);
            walk(node.onTrue, `${at}.onTrue`, grouped, true, caught);
            walk(node.onFalse, `${at}.onFalse`, grouped, true, caught);
          },
          CatchAll: (node) => {
            if (
              !done ||
              !grouped ||
              node.source.error !== QueueDoneType ||
              node.body.error !== NeverType
            )
              refuse(at, "Only child-local unit Done recovery with a Never handler is supported");
            walk(node.source, `${at}.source`, grouped, conditional, true);
            walk(node.body, `${at}.body`, grouped, conditional, false);
          },
          Log: (node) => {
            if (node.attributes.length) refuse(at, "Only plain literal logs are supported");
          },
        }),
        Match.orElse(() =>
          refuse(at, `${body.node._tag} is outside the private generated Queue profile`),
        ),
      );
    };
    walk(root.body, `${path}.body`);
    if (groups !== 1) refuse(path, "Exactly one unconditional unnested All2 is required");
    const budget = analyzeQueueBudget(fn, path);
    if (!budget.admitted)
      throw new CompileError({
        message: "Unsupported Queue reference budget",
        diagnostics: budget.diagnostics,
      });
    profiles.set(
      fn,
      Object.freeze({
        success: root.success,
        capacity: root.capacity,
        completion: done ? "End" : "None",
        ownerCount: 1,
        taskCapacity: 2,
        bounds: bounds!,
        budget,
      }),
    );
  }
  return profiles;
};

export const analyzeGeneratedQueueProfile = (
  program: Program,
): ReadonlyMap<EffectFn, GeneratedQueueProfile> => analyzeQueueProfile(program, false);

/** Private End-only profile; compiler/public selection remains end-free. */
export const analyzeGeneratedQueueDoneProfile = (
  program: Program,
): ReadonlyMap<EffectFn, GeneratedQueueProfile> => analyzeQueueProfile(program, true);
