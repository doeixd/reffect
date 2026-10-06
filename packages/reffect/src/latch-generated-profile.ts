import { Match } from "effect";
import { Computation, EffectFn, checkEffectFunction } from "./effect-ir.ts";
import type { Program } from "./kernel.ts";
import { BoolType, CompileError, IRType, NeverType, U64Type, UnitType, fail } from "./kernel.ts";
import { hasLatchComputation } from "./latch-profile.ts";
import { authoredChildren } from "./provenance.ts";
import { checkDeferredExecutionReferences } from "./deferred-execution.ts";
import {
  analyzeGeneratedDeferredGrowth,
  checkGeneratedDeferredModuleGrowth,
} from "./deferred-growth.ts";
import type { GeneratedDeferredGrowth } from "./deferred-growth.ts";

export interface GeneratedLatchProfile {
  readonly taskCapacity: number;
  readonly ownerCount: 1;
  readonly bounds: {
    readonly computationOccurrences: number;
    readonly expressionOccurrences: number;
    readonly computationDepth: number;
    readonly expressionDepth: number;
    readonly signals: number;
    readonly awaits: number;
    readonly taskCapacity: number;
  };
  readonly driver: {
    readonly protocolRetries: 1;
    readonly cohorts: number;
    readonly callbacks: number;
    readonly settlementRounds: 3;
    readonly timerRegistrations: number;
  };
}
const refuse = (code: string, path: string, message: string): never => {
  throw fail(code, "check", path, message);
};
const scalar = (type: IRType<unknown>): boolean =>
  [BoolType, U64Type, UnitType].some((candidate) => IRType.same(candidate, type));
const children = (body: Computation<unknown, unknown>) =>
  authoredChildren(body).filter(
    (edge): edge is [string, Computation<unknown, unknown>] => edge[1] instanceof Computation,
  );
const remap = (error: unknown): never => {
  if (!(error instanceof CompileError)) throw error;
  throw new CompileError({
    message: "Unsupported generated Latch profile",
    diagnostics: error.diagnostics.map((issue) => ({
      ...issue,
      code: issue.code.replace("DEFERRED_", "LATCH_"),
      message: issue.message.replaceAll("Deferred", "Latch"),
    })),
  });
};
const sleepLiterals = (body: Computation<unknown, unknown>): readonly number[] =>
  Match.value(body.node).pipe(
    Match.tag("Sleep", (node) => [node.milliseconds]),
    Match.orElse(() => children(body).flatMap(([, child]) => sleepLiterals(child))),
  );

/** Private generated ownership receipts; these do not certify reference evaluator operation budgets. */
export const analyzeGeneratedLatchProfile = (
  program: Program,
): ReadonlyMap<EffectFn, GeneratedLatchProfile> => {
  const profiles = new Map<EffectFn, GeneratedLatchProfile>();
  const moduleGrowth: GeneratedDeferredGrowth[] = [];
  for (const [name, fn] of Object.entries(program.functions)) {
    if (!(fn instanceof EffectFn) || !hasLatchComputation(fn.body)) continue;
    const path = `functions.${name}.body`;
    const root = Match.value(fn.body.node).pipe(
      Match.tag("LatchScope", (node) => node),
      Match.orElse(() =>
        refuse("LATCH_STRUCTURAL_PROFILE", path, "Exactly one root lexical Latch is required"),
      ),
    );
    if (fn.input.length || !scalar(fn.output) || !IRType.same(fn.error, NeverType))
      refuse(
        "LATCH_STRUCTURAL_PROFILE",
        path,
        "Generated Latch requires zero inputs and scalar/Never channels",
      );
    // Growth walks every incoming DAG edge and rejects cycles/depth before the
    // recursive ownership/timer walk and trusted reference identity audit below.
    let growth: GeneratedDeferredGrowth;
    try {
      growth = analyzeGeneratedDeferredGrowth(fn, path, "Latch");
      moduleGrowth.push(growth);
      checkGeneratedDeferredModuleGrowth(moduleGrowth);
    } catch (error) {
      remap(error);
    }
    let groups = 0;
    let taskCapacity = 1;
    let awaits = 0;
    let signals = 0;
    const walk = (
      body: Computation<unknown, unknown>,
      at: string,
      grouped = false,
      cleanup = false,
    ): void => {
      if (!scalar(body.output) || !IRType.same(body.error, NeverType))
        refuse("LATCH_STRUCTURAL_PROFILE", at, "Computation channels must be scalar/Never");
      Match.value(body.node).pipe(
        Match.tags({
          LatchOperation: (node) => {
            if (node.binder !== root.binder)
              refuse("RESOURCE_ESCAPE", at, "Latch operation requires the root lexical owner");
            if (node.operation === "Await") {
              if (cleanup)
                refuse(
                  "LATCH_CLEANUP_AWAIT",
                  at,
                  "Await in masked cleanup requires a separate ownership/liveness proof",
                );
              awaits++;
            } else if (node.operation === "Open" || node.operation === "Release") signals++;
          },
          TaskGroup: (node) => {
            if (
              node.mode !== "All" ||
              ![2, 3].includes(node.children.length) ||
              grouped ||
              cleanup ||
              ++groups > 1
            )
              refuse(
                "LATCH_STRUCTURAL_PROFILE",
                at,
                "Only one unnested All2/3 outside cleanup is supported",
              );
            taskCapacity = node.children.length + 1;
            const timers = node.children.map(sleepLiterals);
            const literals = timers.flat();
            if (literals.includes(0))
              refuse(
                "LATCH_CONCURRENT_YIELD",
                at,
                "Sleep(0) in All children or cleanup needs a separately verified queued-yield adapter",
              );
            if (
              timers.filter((values) => values.length).length > 1 &&
              !literals.every((ms) => ms === literals[0])
            )
              refuse(
                "LATCH_CONCURRENT_TIMERS",
                at,
                "Competing child timers require one uniform positive duration across branches and finalizers",
              );
            node.children.forEach((child, index) =>
              walk(child, `${at}.children[${index}]`, true, cleanup),
            );
          },
          Ensuring: (node) => {
            walk(node.body, `${at}.body`, grouped, cleanup);
            walk(node.finalizer, `${at}.finalizer`, grouped, true);
          },
          Sleep: (node) => {
            if (
              !Number.isInteger(node.milliseconds) ||
              node.milliseconds < 0 ||
              node.milliseconds > 2147483647
            )
              refuse(
                "LATCH_TIMER_RANGE",
                at,
                "Timer literals must be integral 0..2147483647 milliseconds",
              );
          },
          Log: (node) => {
            if (node.attributes.length)
              refuse("LATCH_STRUCTURAL_PROFILE", at, "Only plain literal logs are supported");
          },
          Succeed: () => {},
          Map: () =>
            children(body).forEach(([edge, child]) =>
              walk(child, `${at}.${edge}`, grouped, cleanup),
            ),
          FlatMap: () =>
            children(body).forEach(([edge, child]) =>
              walk(child, `${at}.${edge}`, grouped, cleanup),
            ),
          Match: () =>
            children(body).forEach(([edge, child]) =>
              walk(child, `${at}.${edge}`, grouped, cleanup),
            ),
        }),
        Match.orElse(() =>
          refuse(
            "LATCH_STRUCTURAL_PROFILE",
            at,
            `${body.node._tag} is outside the private generated Latch profile`,
          ),
        ),
      );
    };
    walk(root.body, `${path}.body`);
    const diagnostics = checkEffectFunction(fn, `functions.${name}`);
    if (diagnostics.length)
      throw new CompileError({ message: "Invalid lexical Latch function", diagnostics });
    checkDeferredExecutionReferences(fn, (at, message) =>
      fail("LATCH_REFERENCE_CONTEXT", "check", at, message),
    );
    profiles.set(
      fn,
      Object.freeze({
        taskCapacity,
        ownerCount: 1,
        bounds: Object.freeze({
          computationOccurrences: growth!.computationOccurrences,
          expressionOccurrences: growth!.expressionOccurrences,
          computationDepth: growth!.computationDepth,
          expressionDepth: growth!.expressionDepth,
          signals,
          awaits,
          taskCapacity,
        }),
        driver: Object.freeze({
          protocolRetries: 1,
          cohorts: signals,
          callbacks: awaits,
          settlementRounds: 3,
          timerRegistrations: growth!.computationOccurrences,
        }),
      }),
    );
  }
  return profiles;
};
