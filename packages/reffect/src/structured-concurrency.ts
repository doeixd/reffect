import { Match } from "effect";
import { streamFinalizers } from "./stream-ir.ts";
import type { Computation } from "./effect-ir.ts";
import { BoolType, U64Type, UnitType, IRType, NeverType } from "./kernel.ts";
import type { Diagnostic } from "./kernel.ts";

export interface TaskGroupAnalysis {
  readonly diagnostics: readonly Diagnostic[];
  readonly hasFallibleGroups: boolean;
  /** Child-owned reads whose mutable injected driver identity is not yet supported. */
  readonly childClockPaths: readonly string[];
}

/** Checks execution boundaries, including cleanup and scope-independent shared nodes. */
export const analyzeTaskGroups = (
  root: Computation<unknown, unknown>,
  path = "body",
): TaskGroupAnalysis => {
  const diagnostics: Diagnostic[] = [];
  let hasFallibleGroups = false;
  const childClockPaths: string[] = [];
  const seen = new Map<Computation<unknown, unknown>, Set<number>>();
  const parents = new Map<Computation<unknown, unknown>, Set<Computation<unknown, unknown>>>();
  const fallible = new Set<Computation<unknown, unknown>>();
  const recoveries: {
    readonly computation: Computation<unknown, unknown>;
    readonly source: Computation<unknown, unknown>;
    readonly path: string;
  }[] = [];
  const walk = (
    c: Computation<unknown, unknown>,
    at: string,
    child: boolean,
    cleanup: boolean,
    parent?: Computation<unknown, unknown>,
  ): void => {
    if (parent) {
      const edges = parents.get(c) ?? new Set<Computation<unknown, unknown>>();
      edges.add(parent);
      parents.set(c, edges);
    }
    const context = Number(child) + Number(cleanup) * 2;
    const contexts = seen.get(c) ?? new Set<number>();
    if (contexts.has(context)) return;
    contexts.add(context);
    seen.set(c, contexts);
    const issue = (code: string, message: string) =>
      diagnostics.push({ code, stage: "check", path: at, message });
    const body = (value: Computation<unknown, unknown>, edge: string) =>
      walk(value, `${at}.${edge}`, child, cleanup, c);
    const finalizer = (value: Computation<unknown, unknown>, edge: string) =>
      walk(value, `${at}.${edge}`, child, true, c);
    Match.value(c.node).pipe(
      Match.tagsExhaustive({
        TaskGroup: (n) => {
          if (!IRType.same(c.error, NeverType)) {
            hasFallibleGroups = true;
            fallible.add(c);
          }
          if (child)
            issue("NESTED_TASK_GROUP", "Nested task groups need a proven total live-task budget");
          if (cleanup) issue("TASK_GROUP_CLEANUP", "Cleanup cannot create a task group");
          n.children.forEach((value, index) =>
            walk(value, `${at}.children[${index}]`, true, cleanup, c),
          );
        },
        ClockReadMillis: () => {
          if (child) childClockPaths.push(at);
        },
        RandomDraw: () => {
          if (child)
            issue("TASK_GROUP_SERVICE", "Child tasks cannot capture a mutable Random driver");
        },
        Launch: () => {
          if (child) issue("TASK_GROUP_HOST", "Child tasks cannot launch a host lifetime");
        },
        RemoteStore: () => {
          if (child)
            issue(
              "TASK_GROUP_HOST",
              "Remote store identity and mutation interleaving are not admitted in child tasks",
            );
        },
        Scope: (n) => body(n.body, "body"),
        AddFinalizer: (n) => finalizer(n.finalizer, "finalizer"),
        AcquireRelease: (n) => {
          body(n.acquire, "acquire");
          finalizer(n.release, "release");
        },
        RegisteredFile: (n) => {
          body(n.body, "body");
          finalizer(n.afterClose, "afterClose");
        },
        FileScope: (n) => {
          body(n.body, "body");
          finalizer(n.afterClose, "afterClose");
        },
        AcquireUseRelease: (n) => {
          body(n.acquire, "acquire");
          body(n.use, "use");
          finalizer(n.release, "release");
        },
        Ensuring: (n) => {
          body(n.body, "body");
          finalizer(n.finalizer, "finalizer");
        },
        RefScope: (n) => body(n.body, "body"),
        Repeat: (n) => body(n.body, "body"),
        Retry: (n) => body(n.body, "body"),
        Map: (n) => body(n.source, "source"),
        FlatMap: (n) => {
          body(n.source, "source");
          body(n.body, "body");
        },
        CatchAll: (n) => {
          recoveries.push({ computation: c, source: n.source, path: at });
          body(n.source, "source");
          body(n.body, "body");
        },
        Match: (n) => {
          body(n.onTrue, "onTrue");
          body(n.onFalse, "onFalse");
        },
        MatchTags: (n) => n.cases.forEach((value, index) => body(value.body, `cases[${index}]`)),
        ForEach: (n) => body(n.body, "body"),
        Annotate: (n) => body(n.body, "body"),
        Span: (n) => body(n.body, "body"),
        RefMake: () => {},
        RefGet: () => {},
        RefModify: () => {},
        FileSize: () => {},
        Succeed: () => {},
        StreamRunCollect: (n) =>
          streamFinalizers(n.stream).forEach((f) => finalizer(f.finalizer, f.path)),
        StreamEmit: (n) => {
          if (child)
            issue("TASK_GROUP_HOST", "Child tasks cannot concurrently emit into a streaming host");
          streamFinalizers(n.stream).forEach((f) => finalizer(f.finalizer, f.path));
        },
        Fail: () => {},
        Sleep: () => {},
        Log: () => {},
      }),
    );
  };
  walk(root, path, false, false);
  // Reverse edges include shared nodes even when their context was already visited.
  // Propagation therefore answers source reachability without recursively rechecking graphs.
  const pending = Array.from(fallible);
  for (let index = 0; index < pending.length; index++)
    for (const parent of parents.get(pending[index]) ?? [])
      if (!fallible.has(parent)) {
        fallible.add(parent);
        pending.push(parent);
      }
  for (const { computation, source, path: at } of recoveries)
    if (
      fallible.has(source) &&
      !IRType.same(source.error, computation.error) &&
      ![NeverType, BoolType, U64Type, UnitType].some((type) => IRType.same(type, source.error))
    )
      diagnostics.push({
        code: "TASK_GROUP_RECOVERY",
        stage: "check",
        path: at,
        message:
          "Changing a composite source error after a fallible task group needs storage for interruption-bypassed failures",
      });
  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    hasFallibleGroups,
    childClockPaths: Object.freeze(childClockPaths),
  });
};
