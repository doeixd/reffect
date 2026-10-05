import { Cause, Effect, Exit, Match } from "effect";
import type { Computation, LogicalFrame } from "./effect-ir.ts";
import { maxLogicalFrames } from "./effect-ir.ts";
import { fail } from "./kernel.ts";

// Execution receipts do not bound helper expansion across unexecuted branches.
const maxDiagnosticPlanEntries = 4096;

interface FramePlan {
  readonly node: Computation<unknown, unknown>["node"];
  readonly path: string;
  readonly children: ReadonlyMap<string, FramePlan>;
}

// Mirror private native helper identity. All admitted error channels are Never.
const planFrames = (root: Computation<unknown, unknown>, basePath: string): FramePlan => {
  type LexicalScope = object;
  const memo = new Map<LexicalScope, Map<Computation<unknown, unknown>["node"], FramePlan>>();
  let entries = 0;
  const walk = (
    computation: Computation<unknown, unknown>,
    path: string,
    scope: LexicalScope,
  ): FramePlan => {
    const nodes = memo.get(scope) ?? new Map<Computation<unknown, unknown>["node"], FramePlan>();
    const cached = nodes.get(computation.node);
    if (cached) return cached;
    if (++entries > maxDiagnosticPlanEntries)
      throw fail(
        "DEFERRED_FRAME_GROWTH",
        "check",
        path,
        "Private diagnostic plans require at most 4096 scope-indexed helpers",
      );
    const children = new Map<string, FramePlan>();
    const entry = Object.freeze({ node: computation.node, path, children });
    nodes.set(computation.node, entry);
    memo.set(scope, nodes);
    const child = (body: Computation<unknown, unknown>, edge: string, fresh = false) =>
      children.set(edge, walk(body, `${path}.${edge}`, fresh ? {} : scope));
    Match.value(computation.node).pipe(
      Match.tags({
        DeferredScope: (node) => child(node.body, "body", true),
        Map: (node) => child(node.source, "source"),
        FlatMap: (node) => {
          child(node.source, "source");
          child(node.body, "body", true);
        },
        Match: (node) => {
          child(node.onTrue, "onTrue");
          child(node.onFalse, "onFalse");
        },
        Ensuring: (node) => {
          child(node.body, "body");
          child(node.finalizer, "finalizer");
        },
        TaskGroup: (node) =>
          node.children.forEach((body, index) => child(body, `children[${index}]`, true)),
        MatchTags: (node) =>
          node.cases.forEach((branch, index) => child(branch.body, `cases[${index}]`, true)),
        DeferredAwait: () => {},
        DeferredComplete: () => {},
        DeferredIsDone: () => {},
        Succeed: () => {},
        Sleep: () => {},
        Log: () => {},
      }),
      Match.orElse(() => {
        throw fail("DEFERRED_FRAME_NODE", "check", path, "No private diagnostic path mapping");
      }),
    );
    return entry;
  };
  return walk(root, basePath, {});
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
  private plan?: FramePlan;

  claim(): boolean {
    if (this.claimed) return false;
    this.claimed = true;
    return true;
  }

  prepare(body: Computation<unknown, unknown>, basePath: string): void {
    this.plan = planFrames(body, basePath);
  }

  rootPlan(): FramePlan | undefined {
    return this.plan;
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
    private readonly plan?: FramePlan,
  ) {}

  get path(): string {
    return this.boundary.frame.path;
  }

  child(
    computation: Computation<unknown, unknown>,
    fallbackPath: string,
    edge = "body",
  ): DeferredInterruptionBoundary | undefined {
    const plan = this.plan ? this.plan.children.get(edge) : this.owner.rootPlan();
    if (!plan || plan.node !== computation.node)
      throw fail("DEFERRED_FRAME_EDGE", "reference", fallbackPath, "Missing diagnostic child edge");
    const path = plan.path;
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
    return new DeferredInterruptionBoundary(
      this.owner,
      { frame: Object.freeze({ path, kind }), parent: this.boundary },
      plan,
    );
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
