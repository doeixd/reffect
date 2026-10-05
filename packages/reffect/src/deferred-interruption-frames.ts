import { Cause, Effect, Exit, Match } from "effect";
import type { Computation, LogicalFrame } from "./effect-ir.ts";
import { maxLogicalFrames } from "./effect-ir.ts";
import type { EffectFn } from "./effect-ir.ts";
import { fail } from "./kernel.ts";
import type { Diagnostic } from "./kernel.ts";

/** Scope-indexed native helper identities and reference first-seen paths differ on shared roots. */
export const checkDeferredInterruptionPaths = (
  fn: EffectFn,
  basePath = "functions.work.body",
): readonly Diagnostic[] => {
  const seen = new Map<
    Computation<unknown, unknown>["node"],
    { readonly path: string; readonly observed: boolean }
  >();
  const issues: Diagnostic[] = [];
  const walk = (body: Computation<unknown, unknown>, path: string, observed = true): void => {
    const previous = seen.get(body.node);
    if (previous !== undefined) {
      if (observed || previous.observed)
        issues.push({
          code: "DEFERRED_FRAME_SHARING",
          stage: "check",
          path,
          message: `Shared root diagnostic boundaries require scope-indexed paths (first use: ${previous.path})`,
        });
      return;
    }
    seen.set(body.node, { path, observed });
    Match.value(body.node).pipe(
      Match.tags({
        DeferredScope: (node) => walk(node.body, `${path}.body`, observed),
        Map: (node) => walk(node.source, `${path}.source`, observed),
        FlatMap: (node) => {
          walk(node.source, `${path}.source`, observed);
          walk(node.body, `${path}.body`, observed);
        },
        Match: (node) => {
          walk(node.onTrue, `${path}.onTrue`, observed);
          walk(node.onFalse, `${path}.onFalse`, observed);
        },
        Ensuring: (node) => {
          walk(node.body, `${path}.body`, observed);
          walk(node.finalizer, `${path}.finalizer`, false);
        },
        TaskGroup: (node) =>
          node.children.forEach((child, index) => walk(child, `${path}.children[${index}]`, false)),
        MatchTags: (node) =>
          node.cases.forEach((branch, index) =>
            walk(branch.body, `${path}.cases[${index}]`, observed),
          ),
      }),
      // Excluded subtrees still seed first-seen paths; sharing with the root is ambiguous.
      Match.orElse(() => {}),
    );
  };
  walk(fn.body, basePath);
  return issues;
};

interface Boundary {
  readonly frame: LogicalFrame;
  readonly parent?: Boundary;
}

/** Private per-invocation diagnostics; never stored in Deferred payloads or native scalars. */
export class DeferredInterruptionFrames {
  private trail: readonly LogicalFrame[] = Object.freeze([]);
  private omitted = 0;
  private captured = false;
  private claimed = false;

  claim(): boolean {
    if (this.claimed) return false;
    this.claimed = true;
    return true;
  }

  root(basePath: string): DeferredInterruptionBoundary {
    return new DeferredInterruptionBoundary(this, {
      frame: Object.freeze({
        path: basePath.split(".").slice(0, -1).join(".") || basePath,
        kind: "function",
      }),
    });
  }

  capture(boundary: Boundary): void {
    if (this.captured) return;
    this.captured = true;
    const frames: LogicalFrame[] = [];
    let omitted = 0;
    for (let cursor: Boundary | undefined = boundary; cursor; cursor = cursor.parent) {
      if (frames.length < maxLogicalFrames) frames.push(cursor.frame);
      else omitted += 1;
    }
    this.trail = Object.freeze(frames);
    this.omitted = omitted;
  }

  snapshot(): { readonly frames: readonly LogicalFrame[]; readonly omitted: number } {
    return Object.freeze({ frames: this.trail, omitted: this.omitted });
  }
}

export class DeferredInterruptionBoundary {
  constructor(
    private readonly owner: DeferredInterruptionFrames,
    private readonly boundary: Boundary,
  ) {}

  child(
    computation: Computation<unknown, unknown>,
    path: string,
  ): DeferredInterruptionBoundary | undefined {
    const kind: LogicalFrame["kind"] | undefined = Match.value(computation.node).pipe(
      Match.tags({
        DeferredScope: () => "deferredScope" as const,
        DeferredAwait: () => "deferredAwait" as const,
        DeferredComplete: () => "deferredComplete" as const,
        DeferredIsDone: () => undefined,
        Succeed: () => "succeed" as const,
        TaskGroup: (node) => (node.mode === "All" ? "all" : "race"),
        FlatMap: () => "flatMap" as const,
        Map: () => "map" as const,
        Match: () => "match" as const,
        MatchTags: () => "match" as const,
        Ensuring: () => "ensuring" as const,
        Sleep: () => "sleep" as const,
        Log: () => "log" as const,
      }),
      Match.orElse(() => {
        throw fail(
          "DEFERRED_FRAME_NODE",
          "check",
          path,
          "No private interruption frame mapping for this node",
        );
      }),
    );
    // Synchronous inspection has no independently suspendable interruption point.
    if (kind === undefined) return undefined;
    return new DeferredInterruptionBoundary(this.owner, {
      frame: Object.freeze({ path, kind }),
      parent: this.boundary,
    });
  }

  observe<A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return body.pipe(
      Effect.onExit((exit) => {
        if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
          this.owner.capture(this.boundary);
        return Effect.void;
      }),
    );
  }
}
