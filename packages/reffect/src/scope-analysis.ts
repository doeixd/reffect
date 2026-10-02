import { Match } from "effect";
import type { Computation } from "./effect-ir.ts";
import type { Diagnostic } from "./kernel.ts";
import { IRType, Traits } from "./kernel.ts";
import type { Expr } from "./kernel.ts";
import { FileHandleType } from "./file-model.ts";
import type { SchedulePlan } from "./schedule.ts";

/** Compile-time admission budget; accepted programs cannot overflow their native scope. */
export const maxScopeFinalizers = 16;

export interface ScopeAnalysis {
  readonly diagnostics: readonly Diagnostic[];
  readonly capacities: ReadonlyMap<Computation<unknown, unknown>, number>;
  /** Registrations the root retains for an enclosing scope, capped above the budget. */
  readonly retained: number;
}

const maximumRuns = (schedule: SchedulePlan, times: number | undefined): number =>
  1 +
  Math.min(
    times ?? Infinity,
    Match.value(schedule).pipe(
      Match.tagsExhaustive({
        Recurs: (n) => n.times,
        Spaced: () => Infinity,
        Exponential: () => Infinity,
        Forever: () => Infinity,
      }),
    ),
  );

/** Counts execution occurrences in the nearest scope, including finite repeat/retry attempts. */
export const analyzeScopes = (
  root: Computation<unknown, unknown>,
  path = "body",
): ScopeAnalysis => {
  const diagnostics: Diagnostic[] = [];
  const capacities = new Map<Computation<unknown, unknown>, number>();
  const memo = new Map<Computation<unknown, unknown>, Map<number, number>>();
  const active = new Set<Computation<unknown, unknown>>();
  const diagnostic = (code: string, at: string, message: string) =>
    diagnostics.push({ code, stage: "check", path: at, message });
  const capped = (count: number) => Math.min(count, maxScopeFinalizers + 1);
  const walk = (
    c: Computation<unknown, unknown>,
    at: string,
    scoped: boolean,
    cleanup: boolean,
    delayed: boolean,
  ): number => {
    const key = Number(scoped) + Number(cleanup) * 2 + Number(delayed) * 4;
    const cached = memo.get(c)?.get(key);
    if (cached !== undefined) return cached;
    // The channel/binder checker reports cycles; do not recurse into them here.
    if (active.has(c)) return 0;
    active.add(c);
    const child = (body: Computation<unknown, unknown>, edge: string) =>
      walk(body, `${at}.${edge}`, scoped, cleanup, delayed);
    const finalizer = (body: Computation<unknown, unknown>, edge: string, deferred: boolean) =>
      walk(body, `${at}.${edge}`, scoped, true, delayed || deferred);
    const registration = () => {
      if (!scoped)
        diagnostic("SCOPE_REQUIRED", at, "Registration requires an enclosing Effect.scoped region");
      if (cleanup)
        diagnostic("SCOPE_CLEANUP", at, "Cleanup cannot register resources or finalizers");
    };
    const expression = (root: Expr<unknown>, edge: string) => {
      if (!delayed) return;
      const seen = new Set<Expr<unknown>>();
      const visit = (value: Expr<unknown>) => {
        if (seen.has(value)) return;
        seen.add(value);
        if (IRType.same(value.type, FileHandleType))
          diagnostic(
            "RESOURCE_ESCAPE",
            `${at}.${edge}`,
            "Delayed cleanup cannot capture borrowed file values",
          );
        Match.value(value.node).pipe(
          Match.tagsExhaustive({
            Parameter: () => {
              // Registration records hold owned scalar captures only (STR-005, REC-004).
              if (!value.type.traits.includes(Traits.Copyable))
                diagnostic(
                  "RESOURCE_ESCAPE",
                  `${at}.${edge}`,
                  "Delayed cleanup cannot capture strings or composite values in this profile",
                );
            },
            Literal: () => {},
            Apply: (n) => n.args.forEach(visit),
            Match: (n) => {
              visit(n.condition);
              visit(n.onTrue);
              visit(n.onFalse);
            },
            Make: (n) => n.fields.forEach((field) => field && visit(field)),
            Get: (n) => visit(n.value),
            MatchUndefined: (n) => {
              visit(n.value);
              visit(n.onDefined);
              visit(n.onUndefined);
            },
            Defined: (n) => visit(n.value),
            Undefined: () => {},
            RecordQuery: (n) => {
              visit(n.value);
              if (n.key) visit(n.key);
            },
            ArrayMake: (n) => n.elements.forEach(visit),
            ArrayLength: (n) => visit(n.value),
            ArrayLoop: (n) => {
              visit(n.source);
              visit(n.body);
              Match.value(n.op).pipe(
                Match.tag("Reduce", (reduce) => visit(reduce.init)),
                Match.orElse(() => undefined),
              );
            },
            MatchTags: (n) => {
              visit(n.value);
              n.cases.forEach((c) => visit(c.body));
            },
          }),
        );
      };
      visit(root);
    };
    const count = Match.value(c.node).pipe(
      Match.tagsExhaustive({
        Scope: (n) => {
          if (cleanup) diagnostic("SCOPE_CLEANUP", at, "Cleanup cannot create resource scopes");
          const capacity = walk(n.body, `${at}.body`, true, cleanup, delayed);
          capacities.set(c, capacity);
          if (capacity > maxScopeFinalizers)
            diagnostic(
              "SCOPE_CAPACITY",
              at,
              `Scope registrations exceed the statically proven budget of ${maxScopeFinalizers}`,
            );
          return 0;
        },
        AddFinalizer: (n) => {
          registration();
          finalizer(n.finalizer, "finalizer", true);
          return 1;
        },
        AcquireRelease: (n) => {
          registration();
          finalizer(n.release, "release", true);
          return capped(1 + child(n.acquire, "acquire"));
        },
        RegisteredFile: (n) => {
          registration();
          finalizer(n.afterClose, "afterClose", true);
          return capped(1 + child(n.body, "body"));
        },
        FileScope: (n) => {
          if (cleanup) diagnostic("SCOPE_CLEANUP", at, "Cleanup cannot acquire lexical files");
          finalizer(n.afterClose, "afterClose", false);
          return child(n.body, "body");
        },
        FileSize: () => {
          if (delayed)
            diagnostic(
              "RESOURCE_ESCAPE",
              at,
              "Delayed cleanup cannot capture borrowed file handles",
            );
          return 0;
        },
        AcquireUseRelease: (n) => {
          const acquire = child(n.acquire, "acquire");
          const use = child(n.use, "use");
          finalizer(n.release, "release", false);
          return capped(acquire + use);
        },
        Ensuring: (n) => {
          finalizer(n.finalizer, "finalizer", false);
          return child(n.body, "body");
        },
        Repeat: (n) => {
          const body = child(n.body, "body");
          if (!body) return 0;
          const runs = maximumRuns(n.schedule, n.times);
          if (!Number.isFinite(runs))
            diagnostic(
              "SCOPE_CAPACITY",
              at,
              "Unbounded repetition cannot retain registrations in one scope",
            );
          return capped(body * runs);
        },
        Retry: (n) => {
          const body = child(n.body, "body");
          if (!body) return 0;
          const runs = maximumRuns(n.schedule, n.times);
          if (!Number.isFinite(runs))
            diagnostic(
              "SCOPE_CAPACITY",
              at,
              "Unbounded retry cannot retain registrations in one scope",
            );
          return capped(body * runs);
        },
        FlatMap: (n) => capped(child(n.source, "source") + child(n.body, "body")),
        CatchAll: (n) => capped(child(n.source, "source") + child(n.body, "body")),
        Map: (n) => {
          expression(n.body, "body");
          return child(n.source, "source");
        },
        Match: (n) => {
          expression(n.condition, "condition");
          return Math.max(child(n.onTrue, "onTrue"), child(n.onFalse, "onFalse"));
        },
        MatchTags: (n) => {
          expression(n.value, "value");
          return Math.max(0, ...n.cases.map((x, i) => child(x.body, `cases[${i}]`)));
        },
        ForEach: (n) => {
          expression(n.source, "source");
          // Iteration count is a runtime length, so retained registrations cannot be bounded.
          if (child(n.body, "body") > 0)
            diagnostic(
              "SCOPE_CAPACITY",
              at,
              "forEach over a runtime array cannot retain registrations in one scope",
            );
          return 0;
        },
        Annotate: (n) => {
          expression(n.value, "value");
          return child(n.body, "body");
        },
        Span: (n) => child(n.body, "body"),
        Succeed: (n) => {
          expression(n.value, "value");
          return 0;
        },
        Fail: (n) => {
          expression(n.error, "error");
          return 0;
        },
        Sleep: () => 0,
        Launch: (n) => {
          if (cleanup) diagnostic("LAUNCH_CLEANUP", at, "Cleanup cannot launch a server lifetime");
          n.values.forEach((value, index) => expression(value, `values.${index}`));
          return 0;
        },
        Log: (n) => {
          n.attributes.forEach(([, value]) => expression(value, "attributes"));
          return 0;
        },
      }),
    );
    active.delete(c);
    const contexts = memo.get(c) ?? new Map<number, number>();
    contexts.set(key, count);
    memo.set(c, contexts);
    return count;
  };
  const retained = walk(root, path, false, false, false);
  return Object.freeze({ diagnostics: Object.freeze(diagnostics), capacities, retained });
};
