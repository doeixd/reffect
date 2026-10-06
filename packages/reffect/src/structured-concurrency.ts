import { Match } from "effect";
import { streamFinalizers } from "./stream-ir.ts";
import { isAsyncComputation } from "./effect-ir.ts";
import type { Computation } from "./effect-ir.ts";
import { BoolType, U64Type, UnitType, IRType, NeverType } from "./kernel.ts";
import type { Diagnostic } from "./kernel.ts";

export interface TaskGroupAnalysis {
  readonly diagnostics: readonly Diagnostic[];
  readonly hasFallibleGroups: boolean;
  readonly hasRetainedFailures: boolean;
  readonly requiresRichErrors: boolean;
  readonly richComputations: ReadonlySet<Computation<unknown, unknown>>;
  readonly richGroups: ReadonlySet<Computation<unknown, unknown>>;
  readonly cancellationGuards: ReadonlySet<Computation<unknown, unknown>>;
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
  let hasRetainedFailures = false;
  const childClockPaths: string[] = [];
  const seen = new Map<Computation<unknown, unknown>, Set<number>>();
  const parents = new Map<Computation<unknown, unknown>, Set<Computation<unknown, unknown>>>();
  const fallible = new Set<Computation<unknown, unknown>>();
  const retained = new Set<Computation<unknown, unknown>>();
  const groups = new Set<Computation<unknown, unknown>>();
  const cancellationGuards = new Set<Computation<unknown, unknown>>();
  const recoveries: {
    readonly computation: Computation<unknown, unknown>;
    readonly source: Computation<unknown, unknown>;
    readonly path: string;
    readonly cleanup: boolean;
  }[] = [];
  const scalar = (type: IRType<unknown>): boolean =>
    [BoolType, U64Type, UnitType].some((candidate) => IRType.same(candidate, type));
  // RCREC-002: preceding unmasked waits do not retain a selected typed failure.
  const retainedRisk = new Map<Computation<unknown, unknown>, boolean>();
  const checkingRisk = new Set<Computation<unknown, unknown>>();
  const maySuspendAfterFailure = (c: Computation<unknown, unknown>): boolean => {
    const known = retainedRisk.get(c);
    if (known !== undefined) return known;
    if (checkingRisk.has(c)) return true;
    checkingRisk.add(c);
    const risky = Match.value(c.node).pipe(
      Match.tagsExhaustive({
        TaskGroup: () => true,
        Scope: () => true,
        AddFinalizer: () => true,
        AcquireRelease: () => true,
        RegisteredFile: () => true,
        FileScope: () => true,
        LatchMake: () => true,
        LatchScope: () => true,
        LatchOperation: () => true,
        SemaphoreMake: () => true,
        SemaphoreScope: () => true,
        SemaphoreWithPermits: () => true,
        DeferredMake: () => true,
        DeferredScope: () => true,
        DeferredAwait: () => true,
        DeferredComplete: () => true,
        DeferredIsDone: () => true,
        StreamRunCollect: () => true,
        StreamEmit: () => true,
        Ensuring: (n) => isAsyncComputation(n.finalizer) || maySuspendAfterFailure(n.body),
        AcquireUseRelease: (n) =>
          isAsyncComputation(n.acquire) ||
          isAsyncComputation(n.release) ||
          maySuspendAfterFailure(n.acquire) ||
          maySuspendAfterFailure(n.use) ||
          maySuspendAfterFailure(n.release),
        RefScope: (n) => maySuspendAfterFailure(n.body),
        Repeat: (n) => maySuspendAfterFailure(n.body),
        Retry: (n) =>
          (scalar(n.body.error) && isAsyncComputation(n.body)) || maySuspendAfterFailure(n.body),
        Map: (n) => maySuspendAfterFailure(n.source),
        FlatMap: (n) => maySuspendAfterFailure(n.source) || maySuspendAfterFailure(n.body),
        CatchAll: (n) =>
          (scalar(n.source.error) && isAsyncComputation(n.source)) ||
          maySuspendAfterFailure(n.source) ||
          maySuspendAfterFailure(n.body),
        Match: (n) => maySuspendAfterFailure(n.onTrue) || maySuspendAfterFailure(n.onFalse),
        MatchTags: (n) => n.cases.some((value) => maySuspendAfterFailure(value.body)),
        ForEach: (n) => maySuspendAfterFailure(n.body),
        Annotate: (n) => maySuspendAfterFailure(n.body),
        Span: (n) => maySuspendAfterFailure(n.body),
        RefMake: () => false,
        RefGet: () => false,
        RefModify: () => false,
        ClockReadMillis: () => false,
        RandomDraw: () => false,
        FileSize: () => false,
        Succeed: () => false,
        Fail: () => false,
        Sleep: () => false,
        Launch: () => false,
        RemoteStore: () => false,
        SqlExecute: () => false,
        Log: () => false,
      }),
    );
    checkingRisk.delete(c);
    retainedRisk.set(c, risky);
    return risky;
  };
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
          groups.add(c);
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
        SqlExecute: () => {
          if (child) issue("TASK_GROUP_HOST", "SQL statements are not admitted in child tasks");
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
        LatchMake: () => {},
        LatchOperation: () => {},
        LatchScope: (n) => body(n.body, "body"),
        SemaphoreMake: () => {},
        SemaphoreScope: (n) => body(n.body, "body"),
        SemaphoreWithPermits: (n) => body(n.body, "body"),
        DeferredScope: (n) => body(n.body, "body"),
        DeferredMake: () => {},
        DeferredAwait: () => {},
        DeferredComplete: () => {},
        DeferredIsDone: () => {},
        RefScope: (n) => body(n.body, "body"),
        Repeat: (n) => body(n.body, "body"),
        Retry: (n) => {
          recoveries.push({ computation: c, source: n.body, path: at, cleanup });
          body(n.body, "body");
        },
        Map: (n) => body(n.source, "source"),
        FlatMap: (n) => {
          body(n.source, "source");
          body(n.body, "body");
        },
        CatchAll: (n) => {
          recoveries.push({ computation: c, source: n.source, path: at, cleanup });
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
  const propagate = (values: Set<Computation<unknown, unknown>>) => {
    const pending = Array.from(values);
    for (let index = 0; index < pending.length; index++)
      for (const parent of parents.get(pending[index]) ?? [])
        if (!values.has(parent)) {
          values.add(parent);
          pending.push(parent);
        }
  };
  propagate(fallible);
  for (const { computation, source, path: at, cleanup } of recoveries) {
    const asynchronous = isAsyncComputation(source);
    const changedComposite =
      !IRType.same(source.error, computation.error) &&
      !IRType.same(source.error, NeverType) &&
      !scalar(source.error);
    const compositeRetainedRisk = changedComposite && maySuspendAfterFailure(source);
    if (asynchronous && !cleanup && (!changedComposite || compositeRetainedRisk))
      cancellationGuards.add(computation);
    const compositeGroupRecovery = fallible.has(source) && changedComposite;
    if (compositeGroupRecovery)
      diagnostics.push({
        code: "TASK_GROUP_RECOVERY",
        stage: "check",
        path: at,
        message:
          "Changing a composite source error after a fallible task group needs storage for interruption-bypassed failures",
      });
    else if (asynchronous && !cleanup && compositeRetainedRisk)
      diagnostics.push({
        code: "TASK_GROUP_RETAINED_FAILURE",
        stage: "check",
        path: at,
        message:
          "Changing an asynchronous composite source error needs storage for interruption-bypassed failures",
      });
    // Cleanup remains masked throughout the admitted profile. Its typed recovery
    // cannot retain an earlier failure by skipping a handler on cancellation.
    if (asynchronous && !cleanup && scalar(source.error)) {
      hasRetainedFailures = true;
      retained.add(source);
      retained.add(computation);
    }
  }
  const richComputations = new Set([...fallible, ...retained]);
  propagate(richComputations);
  const richGroups = new Set([...groups].filter((group) => richComputations.has(group)));
  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    hasFallibleGroups,
    hasRetainedFailures,
    requiresRichErrors: hasFallibleGroups || hasRetainedFailures,
    richComputations,
    richGroups,
    cancellationGuards,
    childClockPaths: Object.freeze(childClockPaths),
  });
};

/** Private scheduling facts; analysis alone never admits native Deferred. */
export interface DeferredTopologyAnalysis {
  readonly hasDeferred: boolean;
  /** Maximum simultaneously live leaves, with the root counted when no group runs. */
  readonly leafCapacity: number;
  /** Root plus simultaneously live descendant contexts, including group ancestors. */
  readonly taskCapacity: number;
  /** Conservative expanded edge-occurrence count of lexical scopes; sums even alternative branches. */
  readonly ownerCount: number;
  /** Relative live-context reservation, reused separately for each IR occurrence. */
  readonly taskCapacities: ReadonlyMap<Computation<unknown, unknown>, number>;
  readonly diagnostics: readonly Diagnostic[];
}

/** See DADM-001/004: callbacks cannot create a new group in this private profile. */
export const analyzeDeferredTopology = (
  root: Computation<unknown, unknown>,
  path = "body",
  options: { readonly nestedGroups?: boolean } = {},
): DeferredTopologyAnalysis => {
  const taskGroups = analyzeTaskGroups(root, path);
  const diagnostics: Diagnostic[] = taskGroups.diagnostics.filter(
    (diagnostic) => !options.nestedGroups || diagnostic.code !== "NESTED_TASK_GROUP",
  );
  if (options.nestedGroups && taskGroups.requiresRichErrors)
    diagnostics.push({
      code: "DEFERRED_NESTED_OUTCOME",
      stage: "check",
      path,
      message: "Private nested coordination has no compound outcome adapter",
    });
  const taskCapacities = new Map<Computation<unknown, unknown>, number>();
  const active = new Set<Computation<unknown, unknown>>();
  let hasDeferred = false;
  interface Facts {
    readonly leaves: number;
    readonly tasks: number;
    readonly owners: number;
    readonly resumes: boolean;
  }
  const summaries = new Map<Computation<unknown, unknown>, Map<boolean, Facts>>();
  const quiet: Facts = { leaves: 1, tasks: 1, owners: 0, resumes: false };
  const count = (a: number, b: number): number =>
    a > Number.MAX_SAFE_INTEGER - b ? Infinity : a + b;
  const maximum = (a: Facts, b: Facts): Facts => ({
    leaves: Math.max(a.leaves, b.leaves),
    tasks: Math.max(a.tasks, b.tasks),
    owners: count(a.owners, b.owners),
    resumes: a.resumes || b.resumes,
  });
  const walk = (c: Computation<unknown, unknown>, at: string, afterResume: boolean): Facts => {
    const issue = (code: string, message: string) =>
      diagnostics.push({ code, stage: "check", path: at, message });
    if (active.has(c)) {
      issue("DEFERRED_TOPOLOGY_CYCLE", "Cyclic computation has no finite coordinated task bound");
      return { leaves: Infinity, tasks: Infinity, owners: Infinity, resumes: true };
    }
    const cached = summaries.get(c)?.get(afterResume);
    if (cached) return cached;
    active.add(c);
    const child = (value: Computation<unknown, unknown>, edge: string, resumed = afterResume) =>
      walk(value, `${at}.${edge}`, resumed);
    const result: Facts = Match.value(c.node).pipe(
      Match.tagsExhaustive({
        TaskGroup: (n) => {
          if (n.mode === "All" ? ![2, 3].includes(n.children.length) : n.children.length !== 2)
            issue("DEFERRED_TOPOLOGY_ARITY", "Coordinated groups require All2/3 or Race2");
          if (afterResume)
            issue(
              "DEFERRED_CALLBACK_GROUP",
              "Group startup after a Deferred await/completion needs a verified callback driver",
            );
          const children = n.children.map((value, i) => child(value, `children[${i}]`));
          return {
            leaves: children.reduce((sum, value) => count(sum, value.leaves), 0),
            tasks: count(
              1,
              children.reduce((sum, value) => count(sum, value.tasks), 0),
            ),
            owners: children.reduce((sum, value) => count(sum, value.owners), 0),
            resumes: children.some((value) => value.resumes),
          };
        },
        LatchMake: () => quiet,
        LatchOperation: () => quiet,
        LatchScope: (n) => child(n.body, "body"),
        SemaphoreMake: () => quiet,
        SemaphoreScope: (n) => child(n.body, "body"),
        SemaphoreWithPermits: (n) => child(n.body, "body"),
        DeferredMake: () => {
          hasDeferred = true;
          return quiet;
        },
        DeferredScope: (n) => {
          hasDeferred = true;
          const body = child(n.body, "body");
          return { ...body, owners: count(body.owners, 1) };
        },
        DeferredAwait: () => {
          hasDeferred = true;
          return { ...quiet, resumes: true };
        },
        DeferredComplete: () => {
          hasDeferred = true;
          return { ...quiet, resumes: true };
        },
        DeferredIsDone: () => {
          hasDeferred = true;
          return quiet;
        },
        FlatMap: (n) => {
          const source = child(n.source, "source");
          return maximum(source, child(n.body, "body", afterResume || source.resumes));
        },
        CatchAll: (n) => {
          const source = child(n.source, "source");
          return maximum(source, child(n.body, "body", afterResume || source.resumes));
        },
        Ensuring: (n) => {
          const body = child(n.body, "body");
          return maximum(body, child(n.finalizer, "finalizer", afterResume || body.resumes));
        },
        AcquireUseRelease: (n) => {
          const acquire = child(n.acquire, "acquire");
          const use = child(n.use, "use", afterResume || acquire.resumes);
          return maximum(
            maximum(acquire, use),
            child(n.release, "release", afterResume || acquire.resumes || use.resumes),
          );
        },
        AcquireRelease: (n) => {
          const acquire = child(n.acquire, "acquire");
          return maximum(acquire, child(n.release, "release", afterResume || acquire.resumes));
        },
        RegisteredFile: (n) => {
          const body = child(n.body, "body");
          return maximum(body, child(n.afterClose, "afterClose", afterResume || body.resumes));
        },
        FileScope: (n) => {
          const body = child(n.body, "body");
          return maximum(body, child(n.afterClose, "afterClose", afterResume || body.resumes));
        },
        Map: (n) => child(n.source, "source"),
        Match: (n) => maximum(child(n.onTrue, "onTrue"), child(n.onFalse, "onFalse")),
        MatchTags: (n) =>
          n.cases.reduce(
            (value, selected, i) => maximum(value, child(selected.body, `cases[${i}]`)),
            quiet,
          ),
        Repeat: (n) => {
          issue(
            "DEFERRED_TOPOLOGY_LOOP",
            "Iteration has no audited coordinated registration bound",
          );
          return { ...child(n.body, "body"), leaves: Infinity, tasks: Infinity, owners: Infinity };
        },
        Retry: (n) => {
          issue(
            "DEFERRED_TOPOLOGY_LOOP",
            "Iteration has no audited coordinated registration bound",
          );
          return { ...child(n.body, "body"), leaves: Infinity, tasks: Infinity, owners: Infinity };
        },
        ForEach: (n) => {
          issue(
            "DEFERRED_TOPOLOGY_LOOP",
            "Iteration has no audited coordinated registration bound",
          );
          return { ...child(n.body, "body"), leaves: Infinity, tasks: Infinity, owners: Infinity };
        },
        StreamRunCollect: () => {
          issue(
            "DEFERRED_TOPOLOGY_STREAM",
            "Streams have no audited coordinated registration bound",
          );
          return { leaves: Infinity, tasks: Infinity, owners: Infinity, resumes: true };
        },
        StreamEmit: () => {
          issue(
            "DEFERRED_TOPOLOGY_STREAM",
            "Streams have no audited coordinated registration bound",
          );
          return { leaves: Infinity, tasks: Infinity, owners: Infinity, resumes: true };
        },
        Scope: (n) => child(n.body, "body"),
        RefScope: (n) => child(n.body, "body"),
        Annotate: (n) => child(n.body, "body"),
        Span: (n) => child(n.body, "body"),
        AddFinalizer: (n) => child(n.finalizer, "finalizer", true),
        Succeed: () => quiet,
        Fail: () => quiet,
        RefMake: () => quiet,
        RefGet: () => quiet,
        RefModify: () => quiet,
        FileSize: () => quiet,
        ClockReadMillis: () => quiet,
        RandomDraw: () => quiet,
        Sleep: () => quiet,
        Launch: () => quiet,
        RemoteStore: () => quiet,
        SqlExecute: () => quiet,
        Log: () => quiet,
      }),
    );
    active.delete(c);
    taskCapacities.set(c, result.tasks);
    const contexts = summaries.get(c) ?? new Map<boolean, Facts>();
    contexts.set(afterResume, result);
    summaries.set(c, contexts);
    return result;
  };
  const facts = walk(root, path, false);
  return Object.freeze({
    hasDeferred,
    leafCapacity: facts.leaves,
    taskCapacity: facts.tasks,
    ownerCount: facts.owners,
    taskCapacities,
    diagnostics: Object.freeze(diagnostics),
  });
};
