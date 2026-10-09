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
  readonly fallibleAll?: true;
  readonly cleanup?: true;
  readonly shutdown?: true;
  /** Conservative occurrence bound for shutdown-bearing functions with Offers. */
  readonly shutdownOfferBound?: number;
  /** Maximum pending Single producers: one from the offer budget, or two from All2. */
  readonly shutdownPendingOfferBound?: 1 | 2;
  /** A running consumer has at most one peer pending Offer at capacity release. */
  readonly shutdownReleaseOfferBound?: 1;
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
  profileMode: "None" | "Local" | "All" | "Cleanup" | "Shutdown",
): ReadonlyMap<EffectFn, GeneratedQueueProfile> => {
  const profiles = new Map<EffectFn, GeneratedQueueProfile>();
  const moduleGrowth: GeneratedDeferredGrowth[] = [];
  for (const [name, fn] of Object.entries(program.functions)) {
    if (!(fn instanceof EffectFn) || !hasQueueComputation(fn.body)) continue;
    const path = `functions.${name}.body`;
    const mode =
      profileMode === "All" || profileMode === "Cleanup" || profileMode === "Shutdown"
        ? Match.value(fn.body.node).pipe(
            Match.when(
              {
                _tag: "QueueScope",
                body: { node: { _tag: "CatchAll", source: { node: { _tag: "TaskGroup" } } } },
              },
              () => "All" as const,
            ),
            Match.orElse(() => "Local" as const),
          )
        : profileMode;
    let bounds: GeneratedDeferredGrowth;
    try {
      bounds = analyzeGeneratedDeferredGrowth(fn, path, "Queue");
      moduleGrowth.push(bounds);
      checkGeneratedDeferredModuleGrowth(moduleGrowth);
    } catch (error) {
      remapGrowth(error);
    }
    const check = () => {
      const diagnostics = checkEffectFunction(fn, `functions.${name}`).filter(
        (issue) =>
          !(
            mode === "All" &&
            issue.code === "TASK_GROUP_RECOVERY" &&
            issue.path === `${path}.body`
          ),
      );
      if (diagnostics.length)
        throw new CompileError({ message: "Invalid lexical Queue function", diagnostics });
    };
    if (mode !== "All") check();
    const root = Match.value(fn.body.node).pipe(
      Match.tag("QueueScope", (node) => node),
      Match.orElse(() => refuse(path, "Exactly one root lexical Queue is required")),
    );
    if (fn.input.length || !scalar(fn.output) || fn.error !== NeverType)
      refuse(path, "Generated Queue requires zero inputs and builtin scalar/Never channels");
    const done = mode !== "None" && root.error === QueueDoneType;
    const fallibleAll = mode === "All";
    const cleanupEnabled = (profileMode === "Cleanup" || profileMode === "Shutdown") && fallibleAll;
    let finalizers = 0;
    let offers = 0;
    let shutdowns = 0;
    let queueOperations = 0;
    if (
      fallibleAll &&
      (!done ||
        fn.output !== UnitType ||
        root.body.node._tag !== "CatchAll" ||
        root.body.node.source.node._tag !== "TaskGroup" ||
        root.body.node.source.error !== QueueDoneType)
    )
      refuse(path, "Fallible Queue requires root unit Done All2 recovery");
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
      cleanup = false,
      childIndex?: number,
    ): void => {
      if (
        !scalar(body.output) ||
        (body.error !== NeverType &&
          !(done && (caught || fallibleAll) && body.error === QueueDoneType))
      )
        refuse(at, "Computation channels must be builtin scalar/Never");
      Match.value(body.node).pipe(
        Match.tags({
          QueueOperation: (node) => {
            queueOperations++;
            if (!grouped || cleanup)
              refuse(at, "Queue operations require an All2 source and cannot enter cleanup");
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
              !(done && node.operation === "End") &&
              !(profileMode === "Shutdown" && fallibleAll && node.operation === "Shutdown")
            )
              refuse(at, "End/shutdown and Done are outside generated Queue");
            if (node.operation === "Offer") {
              offers++;
              audit(node.value, `${at}.value`);
            }
            if (node.operation === "Shutdown") shutdowns++;
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
              if (
                child.output !== UnitType ||
                (child.error !== NeverType && !(fallibleAll && child.error === QueueDoneType))
              )
                refuse(at, "All2 children require builtin Unit/Never channels");
              walk(child, `${at}.children[${index}]`, true, false, false, false, index);
            });
          },
          Succeed: (node) => audit(node.value, `${at}.value`),
          Map: (node) => {
            walk(node.source, `${at}.source`, grouped, conditional, caught, cleanup);
            audit(node.body, `${at}.body`);
          },
          FlatMap: (node) => {
            walk(node.source, `${at}.source`, grouped, conditional, caught, cleanup);
            walk(node.body, `${at}.body`, grouped, conditional, caught, cleanup);
          },
          Match: (node) => {
            audit(node.condition, `${at}.condition`);
            walk(node.onTrue, `${at}.onTrue`, grouped, true, caught, cleanup);
            walk(node.onFalse, `${at}.onFalse`, grouped, true, caught, cleanup);
          },
          Sleep: (node) => {
            if (
              !cleanupEnabled ||
              !cleanup ||
              !Number.isInteger(node.milliseconds) ||
              node.milliseconds < 1 ||
              node.milliseconds > 60000
            )
              refuse(at, "Only positive literal default-clock cleanup Sleep is supported");
          },
          Ensuring: (node) => {
            if (
              !cleanupEnabled ||
              !grouped ||
              childIndex === undefined ||
              cleanup ||
              node.body.output !== UnitType ||
              node.finalizer.output !== UnitType ||
              node.finalizer.error !== NeverType
            )
              refuse(
                at,
                "Only outer Unit child Ensuring with infallible queue-free cleanup is supported",
              );
            finalizers++;
            const sourceShutdowns = shutdowns;
            const sourceQueueOperations = queueOperations;
            walk(node.body, `${at}.body`, true);
            if (childIndex === 1 && queueOperations !== sourceQueueOperations)
              refuse(
                `${at}.body`,
                "Second-child finalization requires a queue-free source under the pinned observer profile",
              );
            if (shutdowns !== sourceShutdowns)
              refuse(
                `${at}.body`,
                "Shutdown source finalization is outside the pinned observer-registration profile",
              );
            walk(node.finalizer, `${at}.finalizer`, true, false, false, true);
          },
          CatchAll: (node) => {
            if (fallibleAll) {
              if (
                body !== root.body ||
                grouped ||
                conditional ||
                node.source.node._tag !== "TaskGroup" ||
                node.source.error !== QueueDoneType ||
                node.body.error !== NeverType ||
                node.body.output !== UnitType
              )
                refuse(at, "Only root All2 Done recovery is supported");
              walk(node.source, `${at}.source`, false, false, false);
              walk(node.body, `${at}.body`, false, false, false);
              return;
            }
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
    // In All2 a running consumer cannot also be a pending producer. Re-offering
    // suspends its peer on a full buffer before that peer can execute Shutdown.
    if (groups !== 1) refuse(path, "Exactly one unconditional unnested All2 is required");
    if (fallibleAll) check();
    const budget = analyzeQueueBudget(fn, path, undefined, true, finalizers > 0);
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
        ...(fallibleAll ? { fallibleAll: true as const } : {}),
        ...(finalizers ? { cleanup: true as const } : {}),
        ...(shutdowns ? { shutdown: true as const } : {}),
        ...(shutdowns && offers ? { shutdownOfferBound: offers } : {}),
        ...(shutdowns && offers > root.capacity
          ? {
              shutdownPendingOfferBound: offers === root.capacity + 1 ? (1 as const) : (2 as const),
            }
          : {}),
        ...(shutdowns && offers > root.capacity + 1
          ? { shutdownReleaseOfferBound: 1 as const }
          : {}),
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
): ReadonlyMap<EffectFn, GeneratedQueueProfile> => analyzeQueueProfile(program, "None");

/** Checked public End profile with child-local unit Done recovery. */
export const analyzeGeneratedQueueDoneProfile = (
  program: Program,
): ReadonlyMap<EffectFn, GeneratedQueueProfile> => analyzeQueueProfile(program, "Local");

/** Checked per-function receipts for ordinary, local Done and public root All2 recovery. */
export const analyzeGeneratedQueueFallibleProfile = (
  program: Program,
): ReadonlyMap<EffectFn, GeneratedQueueProfile> => analyzeQueueProfile(program, "All");

/** Checked public outer-child cleanup receipt; terminal finalizers stay refused. */
export const analyzeGeneratedQueueCleanupProfile = (
  program: Program,
): ReadonlyMap<EffectFn, GeneratedQueueProfile> => analyzeQueueProfile(program, "Cleanup");

/** Checked All2 Shutdown with at most one peer producer at release; terminal cleanup stays refused. */
export const analyzeGeneratedQueueShutdownProfile = (
  program: Program,
): ReadonlyMap<EffectFn, GeneratedQueueProfile> => analyzeQueueProfile(program, "Shutdown");
