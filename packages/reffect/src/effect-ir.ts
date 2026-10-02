import { Effect, Exit, Match, Option, Pipeable, Schema, Schedule } from "effect";
import type { Scope } from "effect";
import { Schedule as ScheduleValue, validSchedulePlan, validTimes } from "./schedule.ts";
import type { SchedulePlan } from "./schedule.ts";
import { emptySource, snapshotSource } from "./source.ts";
import type { SourceMetadata } from "./source.ts";
import { dual } from "effect/Function";
import {
  BoolType,
  CompileError,
  Expr,
  IRType,
  NeverType,
  U64Type,
  UnitType,
  SemanticRef,
  checkExpression,
  evaluateExpression,
  fail,
  structLayout,
  unionCases,
} from "./kernel.ts";
import type { Diagnostic, Inputs, MatchCase, Symbols } from "./kernel.ts";
import { FileHandleType, FileLease, validFilePath } from "./file-model.ts";
import { openReferenceFile } from "./reference-files.ts";
import { LaunchHost } from "./launch-host.ts";
import { analyzeScopes } from "./scope-analysis.ts";
export { maxScopeFinalizers } from "./scope-analysis.ts";

export const SyncEffects = Object.freeze({
  CatchAll: SemanticRef.effect("reffect/effect/catch-all@1"),
  Succeed: SemanticRef.effect("reffect/effect/succeed@1"),
  Fail: SemanticRef.effect("reffect/effect/fail@1"),
  Map: SemanticRef.effect("reffect/effect/map@1"),
  FlatMap: SemanticRef.effect("reffect/effect/flatMap@1"),
  Match: SemanticRef.effect("reffect/effect/match-bool@1"),
  Log: SemanticRef.effect("reffect/effect/log@1"),
  Annotate: SemanticRef.effect("reffect/effect/annotate@1"),
  Span: SemanticRef.effect("reffect/effect/span@1"),
});
export const AsyncEffects = Object.freeze({
  Scope: SemanticRef.effect("reffect/effect/scope@1"),
  AddFinalizer: SemanticRef.effect("reffect/effect/add-finalizer@1"),
  AcquireRelease: SemanticRef.effect("reffect/effect/acquire-release@1"),
  RegisteredFile: SemanticRef.effect("reffect/effect/registered-file@1"),
  Repeat: SemanticRef.effect("reffect/effect/repeat-scheduled@1"),
  Retry: SemanticRef.effect("reffect/effect/retry-scheduled@1"),
  Sleep: SemanticRef.effect("reffect/effect/sleep@1"),
  Launch: SemanticRef.effect("reffect/effect/launch@1"),
  Ensuring: SemanticRef.effect("reffect/effect/ensuring@1"),
  AcquireUseRelease: SemanticRef.effect("reffect/effect/acquireUseRelease@1"),
  FileScope: SemanticRef.effect("reffect/effect/scoped-file@1"),
  FileSize: SemanticRef.effect("reffect/effect/file-size@1"),
});
const validDelay = (milliseconds: number): boolean =>
  Number.isSafeInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 60_000;
export type LogLevel = "Trace" | "Debug" | "Info" | "Warn" | "Error" | "Fatal";
export const logLevels = Object.freeze([
  "Trace",
  "Debug",
  "Info",
  "Warn",
  "Error",
  "Fatal",
] as const);
export type LogAttribute = readonly [key: string, value: Expr<boolean> | Expr<bigint>];
/** Static annotation keys/labels: nonempty ASCII without quotes, backslashes or controls. */
const validLogName = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 128 &&
  Array.from(value).every((c) => {
    const code = c.charCodeAt(0);
    return code > 31 && code < 127 && c !== '"' && c !== "\\";
  });
const checkLogName = (kind: string, value: string): void => {
  if (!validLogName(value))
    throw fail(
      "INVALID_LOG_METADATA",
      "authoring",
      kind,
      "Log keys and span labels must be nonempty ASCII without quotes, backslashes or controls",
    );
};
export type ComputationNode =
  | { readonly _tag: "Scope"; readonly body: Computation<unknown, unknown> }
  | { readonly _tag: "AddFinalizer"; readonly finalizer: Computation<void, never> }
  | {
      readonly _tag: "AcquireRelease";
      readonly acquire: Computation<unknown, unknown>;
      readonly binder: symbol;
      readonly release: Computation<void, never>;
    }
  | {
      readonly _tag: "RegisteredFile";
      readonly path: string;
      readonly binder: symbol;
      readonly body: Computation<unknown, unknown>;
      readonly afterClose: Computation<void, never>;
    }
  | {
      readonly _tag: "Repeat";
      readonly body: Computation<void, unknown>;
      readonly schedule: SchedulePlan;
      readonly times: number | undefined;
    }
  | {
      readonly _tag: "Retry";
      readonly body: Computation<unknown, unknown>;
      readonly schedule: SchedulePlan;
      readonly times: number | undefined;
    }
  | {
      readonly _tag: "FileScope";
      readonly path: string;
      readonly binder: symbol;
      readonly body: Computation<unknown, unknown>;
      readonly afterClose: Computation<void, never>;
    }
  | { readonly _tag: "FileSize"; readonly binder: symbol }
  | {
      readonly _tag: "CatchAll";
      readonly source: Computation<unknown, unknown>;
      readonly binder: symbol;
      readonly body: Computation<unknown, unknown>;
    }
  | {
      readonly _tag: "AcquireUseRelease";
      readonly acquire: Computation<unknown, unknown>;
      readonly binder: symbol;
      readonly use: Computation<unknown, unknown>;
      readonly release: Computation<void, never>;
    }
  | { readonly _tag: "Sleep"; readonly milliseconds: number }
  | { readonly _tag: "Launch"; readonly values: readonly Expr<unknown>[] }
  | {
      readonly _tag: "Ensuring";
      readonly body: Computation<unknown, unknown>;
      readonly finalizer: Computation<void, never>;
    }
  | { readonly _tag: "Succeed"; readonly value: Expr<unknown> }
  | { readonly _tag: "Fail"; readonly error: Expr<unknown> }
  | {
      readonly _tag: "Map";
      readonly source: Computation<unknown, unknown>;
      readonly binder: symbol;
      readonly body: Expr<unknown>;
    }
  | {
      readonly _tag: "FlatMap";
      readonly source: Computation<unknown, unknown>;
      readonly binder: symbol;
      readonly body: Computation<unknown, unknown>;
    }
  | {
      readonly _tag: "Match";
      readonly condition: Expr<boolean>;
      readonly onTrue: Computation<unknown, unknown>;
      readonly onFalse: Computation<unknown, unknown>;
    }
  | {
      readonly _tag: "MatchTags";
      readonly value: Expr<unknown>;
      readonly cases: readonly MatchCase<Computation<unknown, unknown>>[];
    }
  | {
      readonly _tag: "Log";
      readonly level: LogLevel;
      readonly message: string;
      readonly attributes: readonly LogAttribute[];
    }
  | {
      readonly _tag: "Annotate";
      readonly key: string;
      readonly value: Expr<boolean> | Expr<bigint>;
      readonly body: Computation<unknown, unknown>;
    }
  | {
      readonly _tag: "Span";
      readonly label: string;
      readonly body: Computation<unknown, unknown>;
    };

export class Computation<A, E = never> extends Pipeable.Class {
  private constructor(
    readonly output: IRType<A>,
    readonly error: IRType<E>,
    readonly node: ComputationNode,
    readonly source: SourceMetadata = emptySource,
  ) {
    super();
    Object.freeze(this);
  }
  withSource(source: SourceMetadata): Computation<A, E> {
    return new Computation(this.output, this.error, this.node, snapshotSource(source));
  }
  static make<A, E>(output: IRType<A>, error: IRType<E>, node: ComputationNode): Computation<A, E> {
    return new Computation(output, error, Object.freeze(node));
  }
}
export const joinType = (a: IRType<unknown>, b: IRType<unknown>): IRType<unknown> => {
  if (IRType.same(a, NeverType)) return b;
  if (IRType.same(b, NeverType) || IRType.same(a, b)) return a;
  throw fail(
    "TYPE_MISMATCH",
    "authoring",
    "channels",
    "Joining different non-Never witnesses requires an explicit union representation",
  );
};
/**
 * Compiler-internal capture-free substitution over a computation graph: embedded
 * expressions and nested computations bound to `binder` receive `replacement`.
 * Used by `R.flow`; shared nodes stay shared and cycles are refused.
 */
export const substituteComputation = (
  root: Computation<unknown, unknown>,
  binder: symbol,
  replacement: (index: number) => Expr<unknown> | undefined,
): Computation<unknown, unknown> => {
  const memo = new Map<Computation<unknown, unknown>, Computation<unknown, unknown>>();
  const active = new Set<Computation<unknown, unknown>>();
  const substituting = (value: Expr<unknown>): Expr<unknown> =>
    Expr.substitute(value, binder, replacement);
  const walk = (self: Computation<unknown, unknown>): Computation<unknown, unknown> => {
    const cached = memo.get(self);
    if (cached) return cached;
    if (active.has(self))
      throw fail("IR_CYCLE", "authoring", "substitute", "Computation graph contains a cycle");
    active.add(self);
    const rebuild = (node: ComputationNode): Computation<unknown, unknown> =>
      Computation.make(self.output, self.error, node).withSource(self.source);
    const result: Computation<unknown, unknown> = Match.value(self.node).pipe(
      Match.tagsExhaustive({
        Scope: (n) => {
          const body = walk(n.body);
          return body === n.body ? self : rebuild({ _tag: "Scope", body });
        },
        AddFinalizer: (n) => {
          const finalizer = walk(n.finalizer) as Computation<void, never>;
          return finalizer === n.finalizer ? self : rebuild({ _tag: "AddFinalizer", finalizer });
        },
        AcquireRelease: (n) => {
          const acquire = walk(n.acquire);
          const release = walk(n.release) as Computation<void, never>;
          return acquire === n.acquire && release === n.release
            ? self
            : rebuild({ _tag: "AcquireRelease", acquire, binder: n.binder, release });
        },
        RegisteredFile: (n) => {
          const body = walk(n.body);
          const afterClose = walk(n.afterClose) as Computation<void, never>;
          return body === n.body && afterClose === n.afterClose
            ? self
            : rebuild({ _tag: "RegisteredFile", path: n.path, binder: n.binder, body, afterClose });
        },
        Sleep: () => self,
        Launch: (n) => {
          const values = n.values.map(substituting);
          return values.every((value, index) => value === n.values[index])
            ? self
            : rebuild({ _tag: "Launch", values });
        },
        FileSize: () => self,
        Succeed: (n) => {
          const value = substituting(n.value);
          return value === n.value ? self : rebuild({ _tag: "Succeed", value });
        },
        Fail: (n) => {
          const error = substituting(n.error);
          return error === n.error ? self : rebuild({ _tag: "Fail", error });
        },
        Log: (n) => {
          const attributes: LogAttribute[] = n.attributes.map(
            ([key, value]) => Object.freeze([key, substituting(value)]) as LogAttribute,
          );
          return attributes.every(([, value], index) => value === n.attributes[index][1])
            ? self
            : rebuild({ _tag: "Log", level: n.level, message: n.message, attributes });
        },
        Map: (n) => {
          const source = walk(n.source);
          const body = substituting(n.body);
          return source === n.source && body === n.body
            ? self
            : rebuild({ _tag: "Map", source, binder: n.binder, body });
        },
        FlatMap: (n) => {
          const source = walk(n.source);
          const body = walk(n.body);
          return source === n.source && body === n.body
            ? self
            : rebuild({ _tag: "FlatMap", source, binder: n.binder, body });
        },
        Match: (n) => {
          const condition = substituting(n.condition) as Expr<boolean>;
          const onTrue = walk(n.onTrue);
          const onFalse = walk(n.onFalse);
          return condition === n.condition && onTrue === n.onTrue && onFalse === n.onFalse
            ? self
            : rebuild({ _tag: "Match", condition, onTrue, onFalse });
        },
        MatchTags: (n) => {
          const value = substituting(n.value);
          const cases = n.cases.map((c) => Object.freeze({ ...c, body: walk(c.body) }));
          return value === n.value && cases.every((c, i) => c.body === n.cases[i].body)
            ? self
            : rebuild({ _tag: "MatchTags", value, cases: Object.freeze(cases) });
        },
        CatchAll: (n) => {
          const source = walk(n.source);
          const body = walk(n.body);
          return source === n.source && body === n.body
            ? self
            : rebuild({ _tag: "CatchAll", source, binder: n.binder, body });
        },
        AcquireUseRelease: (n) => {
          const acquire = walk(n.acquire);
          const use = walk(n.use);
          const release = walk(n.release) as Computation<void, never>;
          return acquire === n.acquire && use === n.use && release === n.release
            ? self
            : rebuild({ _tag: "AcquireUseRelease", acquire, binder: n.binder, use, release });
        },
        Ensuring: (n) => {
          const body = walk(n.body);
          const finalizer = walk(n.finalizer) as Computation<void, never>;
          return body === n.body && finalizer === n.finalizer
            ? self
            : rebuild({ _tag: "Ensuring", body, finalizer });
        },
        FileScope: (n) => {
          const body = walk(n.body);
          const afterClose = walk(n.afterClose) as Computation<void, never>;
          return body === n.body && afterClose === n.afterClose
            ? self
            : rebuild({ _tag: "FileScope", path: n.path, binder: n.binder, body, afterClose });
        },
        Repeat: (n) => {
          const body = walk(n.body) as Computation<void, unknown>;
          return body === n.body
            ? self
            : rebuild({ _tag: "Repeat", body, schedule: n.schedule, times: n.times });
        },
        Retry: (n) => {
          const body = walk(n.body);
          return body === n.body
            ? self
            : rebuild({ _tag: "Retry", body, schedule: n.schedule, times: n.times });
        },
        Annotate: (n) => {
          const value = substituting(n.value);
          const body = walk(n.body);
          return value === n.value && body === n.body
            ? self
            : rebuild({
                _tag: "Annotate",
                key: n.key,
                value: value as LogAttribute[1],
                body: body as Computation<unknown, unknown>,
              });
        },
        Span: (n) => {
          const body = walk(n.body);
          return body === n.body ? self : rebuild({ _tag: "Span", label: n.label, body });
        },
      }),
    );
    active.delete(self);
    memo.set(self, result);
    return result;
  };
  return walk(root);
};
const succeed = <A>(value: Expr<A>): Computation<A> =>
  Computation.make(value.type, NeverType, { _tag: "Succeed", value });
const failValue = <E>(error: Expr<E>): Computation<never, E> =>
  Computation.make(NeverType, error.type, { _tag: "Fail", error });
const sleep = (milliseconds: number): Computation<void> => {
  if (!validDelay(milliseconds))
    throw fail(
      "INVALID_DELAY",
      "authoring",
      "sleep",
      "Delay requires an integer literal from 0 to 60000 milliseconds",
    );
  return Computation.make(UnitType, NeverType, { _tag: "Sleep", milliseconds });
};
const scalarLaunch = (type: IRType<unknown>): boolean =>
  IRType.same(type, BoolType) || IRType.same(type, U64Type) || IRType.same(type, UnitType);
/**
 * Internal server-lifetime hold: hands scalar service values to the host once, then waits like
 * Effect.never until interrupted. Not exported on R; NativeRpc stages it inside a provide.
 */
export const launch = (values: readonly Expr<unknown>[]): Computation<never, never> =>
  Computation.make(NeverType, NeverType, { _tag: "Launch", values: Object.freeze([...values]) });
const launchReference = (values: readonly unknown[]): Effect.Effect<never> =>
  Effect.serviceOption(LaunchHost).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(new Error("Launch requires a LaunchHost in the reference")),
        onSome: (host) => host.publish(values),
      }),
    ),
    Effect.andThen(Effect.never),
  );
const toEffectSchedule = (plan: SchedulePlan): Schedule.Schedule<unknown, unknown, never, never> =>
  Match.value(plan).pipe(
    Match.tagsExhaustive({
      Recurs: (p) => Schedule.recurs(p.times),
      Spaced: (p) => Schedule.spaced(p.milliseconds),
      Exponential: (p) => Schedule.exponential(p.milliseconds, p.factor),
      Forever: () => Schedule.forever,
    }),
  );
/** Continuation and delay for the reference retry loop; mirrors the native generated loop. */
const scheduleContinues = (
  plan: SchedulePlan,
  completed: number,
  times: number | undefined,
): boolean =>
  (plan._tag !== "Recurs" || completed < plan.times) && (times === undefined || completed < times);
const scheduleDelay = (plan: SchedulePlan, completed: number): number =>
  plan._tag === "Exponential"
    ? Math.min(plan.milliseconds * plan.factor ** completed, Number.MAX_SAFE_INTEGER)
    : plan._tag === "Spaced"
      ? plan.milliseconds
      : 0;
const scheduleOf = (
  input: ScheduleValue | { schedule: ScheduleValue; times?: number },
): { readonly schedule: ScheduleValue; readonly times: number | undefined } =>
  input instanceof ScheduleValue
    ? { schedule: input, times: undefined }
    : { schedule: input.schedule, times: input.times };
const checkSchedule = (schedule: ScheduleValue, times: number | undefined): void => {
  if (!(schedule instanceof ScheduleValue) || !validTimes(times))
    throw fail(
      "INVALID_SCHEDULE",
      "authoring",
      "schedule",
      "A schedule value and 0–1000000 additional runs are required",
    );
};
type RepeatOptions = ScheduleValue | { readonly schedule: ScheduleValue; readonly times?: number };
const repeat: {
  (options: RepeatOptions): <E>(self: Computation<void, E>) => Computation<void, E>;
  <E>(self: Computation<void, E>, options: RepeatOptions): Computation<void, E>;
} = dual(2, <E>(self: Computation<void, E>, options: RepeatOptions) => {
  const { schedule, times } = scheduleOf(options);
  checkSchedule(schedule, times);
  return Computation.make(UnitType, self.error, {
    _tag: "Repeat",
    body: self,
    schedule: schedule.plan,
    times,
  });
});
const retry: {
  <E>(options: RepeatOptions): <A>(self: Computation<A, E>) => Computation<A, E>;
  <A, E>(self: Computation<A, E>, options: RepeatOptions): Computation<A, E>;
} = dual(2, <A, E>(self: Computation<A, E>, options: RepeatOptions) => {
  const { schedule, times } = scheduleOf(options);
  checkSchedule(schedule, times);
  return Computation.make(self.output, self.error, {
    _tag: "Retry",
    body: self,
    schedule: schedule.plan,
    times,
  });
});
const ensuring: {
  (finalizer: Computation<void, never>): <A, E>(self: Computation<A, E>) => Computation<A, E>;
  <A, E>(self: Computation<A, E>, finalizer: Computation<void, never>): Computation<A, E>;
} = dual(2, <A, E>(self: Computation<A, E>, finalizer: Computation<void, never>) =>
  Computation.make(self.output, self.error, { _tag: "Ensuring", body: self, finalizer }),
);
const acquireUseRelease = <Resource, E, A, E2>(
  acquire: Computation<Resource, E>,
  use: (resource: Expr<Resource>) => Computation<A, E2>,
  release: (resource: Expr<Resource>) => Computation<void, never>,
): Computation<A, E | E2> => {
  const binder = Symbol("reffect/acquireUseRelease");
  const resource = Expr.parameter(acquire.output, binder, 0);
  const body = use(resource);
  return Computation.make(body.output, joinType(acquire.error, body.error) as IRType<E | E2>, {
    _tag: "AcquireUseRelease",
    acquire,
    binder,
    use: body,
    release: release(resource),
  });
};
/** Acquire a scalar and register its Exit-independent release in the nearest lexical scope. */
const acquireRelease = <Resource extends bigint | boolean | void, E>(
  acquire: Computation<Resource, E>,
  release: (resource: Expr<Resource>) => Computation<void, never>,
): Computation<Resource, E> => {
  const binder = Symbol("reffect/acquireRelease");
  return Computation.make(acquire.output, acquire.error, {
    _tag: "AcquireRelease",
    acquire,
    binder,
    release: release(Expr.parameter(acquire.output, binder, 0)),
  });
};
const addFinalizer = (finalizer: () => Computation<void, never>): Computation<void, never> =>
  Computation.make(UnitType, NeverType, { _tag: "AddFinalizer", finalizer: finalizer() });
const scoped = <A, E>(self: Computation<A, E>): Computation<A, E> =>
  Computation.make(self.output, self.error, { _tag: "Scope", body: self });
/** Reachability used for execution profiles, never a second semantic interpreter. */
export const isAsyncComputation = (root: Computation<unknown, unknown>): boolean => {
  const seen = new Set<Computation<unknown, unknown>>();
  const walk = (c: Computation<unknown, unknown>): boolean => {
    if (seen.has(c)) return false;
    seen.add(c);
    return Match.value(c.node).pipe(
      Match.tagsExhaustive({
        Scope: () => true,
        AddFinalizer: () => true,
        AcquireRelease: () => true,
        RegisteredFile: () => true,
        FileScope: () => true,
        FileSize: () => true,
        Sleep: () => true,
        Launch: () => true,
        Repeat: () => true,
        Retry: () => true,
        Ensuring: () => true,
        AcquireUseRelease: () => true,
        Succeed: () => false,
        Fail: () => false,
        Log: () => false,
        Map: (n) => walk(n.source),
        FlatMap: (n) => walk(n.source) || walk(n.body),
        CatchAll: (n) => walk(n.source) || walk(n.body),
        Match: (n) => walk(n.onTrue) || walk(n.onFalse),
        MatchTags: (n) => n.cases.some((c) => walk(c.body)),
        Annotate: (n) => walk(n.body),
        Span: (n) => walk(n.body),
      }),
    );
  };
  return walk(root);
};
const map: {
  <A, B>(build: (value: Expr<A>) => Expr<B>): <E>(self: Computation<A, E>) => Computation<B, E>;
  <A, E, B>(self: Computation<A, E>, build: (value: Expr<A>) => Expr<B>): Computation<B, E>;
} = dual(2, <A, E, B>(self: Computation<A, E>, build: (value: Expr<A>) => Expr<B>) => {
  const binder = Symbol("reffect/map");
  const body = build(Expr.parameter(self.output, binder, 0));
  return Computation.make(body.type, self.error, { _tag: "Map", source: self, binder, body });
});
const flatMap: {
  <A, B, E2>(
    build: (value: Expr<A>) => Computation<B, E2>,
  ): <E>(self: Computation<A, E>) => Computation<B, E | E2>;
  <A, E, B, E2>(
    self: Computation<A, E>,
    build: (value: Expr<A>) => Computation<B, E2>,
  ): Computation<B, E | E2>;
} = dual(
  2,
  <A, E, B, E2>(self: Computation<A, E>, build: (value: Expr<A>) => Computation<B, E2>) => {
    const binder = Symbol("reffect/flatMap");
    const body = build(Expr.parameter(self.output, binder, 0));
    const error = joinType(self.error, body.error) as IRType<E | E2>;
    return Computation.make(body.output, error, { _tag: "FlatMap", source: self, binder, body });
  },
);
export const matchComputation = <A, E, B, E2>(
  condition: Expr<boolean>,
  onTrue: Computation<A, E>,
  onFalse: Computation<B, E2>,
): Computation<A | B, E | E2> => {
  if (!IRType.same(condition.type, BoolType))
    throw fail("TYPE_MISMATCH", "authoring", "Match", "Match requires a Boolean witness");
  return Computation.make(
    joinType(onTrue.output, onFalse.output) as IRType<A | B>,
    joinType(onTrue.error, onFalse.error) as IRType<E | E2>,
    { _tag: "Match", condition, onTrue, onFalse },
  );
};
export class EffectFn<
  I extends readonly IRType<unknown>[] = readonly IRType<unknown>[],
  A = unknown,
  E = unknown,
>
  extends Pipeable.Class
{
  private constructor(
    readonly input: I,
    readonly output: IRType<A>,
    readonly error: IRType<E>,
    readonly binder: symbol,
    readonly body: Computation<A, E>,
    readonly source: SourceMetadata = emptySource,
  ) {
    super();
    Object.freeze(this);
  }
  withSource(source: SourceMetadata): EffectFn<I, A, E> {
    return new EffectFn(
      this.input,
      this.output,
      this.error,
      this.binder,
      this.body,
      snapshotSource(source),
    );
  }
  static make<const I extends readonly IRType<unknown>[], A, E>(
    this: void,
    input: I,
    output: IRType<A>,
    error: IRType<E>,
    build: (...args: Symbols<I>) => Computation<NoInfer<A>, NoInfer<E>>,
  ): EffectFn<I, A, E> {
    const binder = Symbol("reffect/effect-function");
    const args = input.map((type, index) => Expr.parameter(type, binder, index)) as Symbols<I>;
    return new EffectFn(
      Object.freeze(Array.from(input)) as unknown as I,
      output,
      error,
      binder,
      build(...args),
    );
  }
}

export const checkEffectFunction = (f: EffectFn, path: string): readonly Diagnostic[] => {
  const issues: Diagnostic[] = [];
  const add = (at: string, message: string) =>
    issues.push({ code: "TYPE_MISMATCH", stage: "check", path: at, message });
  const agrees = (actual: IRType<unknown>, declared: IRType<unknown>) =>
    IRType.same(actual, NeverType) || IRType.same(actual, declared);
  const joined = (actual: IRType<unknown>, left: IRType<unknown>, right: IRType<unknown>) =>
    IRType.same(left, NeverType)
      ? IRType.same(actual, right)
      : IRType.same(right, NeverType)
        ? IRType.same(actual, left)
        : IRType.same(actual, left) && IRType.same(actual, right);
  type Bindings = ReadonlyMap<symbol, readonly IRType<unknown>[]>;
  const visited = new Map<Computation<unknown, unknown>, Set<Bindings>>();
  const active = new Set<Computation<unknown, unknown>>();
  const walk = (c: Computation<unknown, unknown>, bindings: Bindings, at: string) => {
    if (visited.get(c)?.has(bindings)) return;
    if (active.has(c)) {
      issues.push({
        code: "IR_CYCLE",
        stage: "check",
        path: at,
        message: "Computation graph contains a cycle",
      });
      return;
    }
    active.add(c);
    const expression = (e: Expr<unknown>, step: string) =>
      issues.push(...checkExpression(e, bindings, `${at}.${step}`));
    Match.value(c.node).pipe(
      Match.tagsExhaustive({
        Scope: (n) => {
          if (!IRType.same(c.output, n.body.output) || !IRType.same(c.error, n.body.error))
            add(at, "Scope preserves its body channels");
          walk(n.body, bindings, `${at}.body`);
        },
        AddFinalizer: (n) => {
          if (
            !IRType.same(c.output, UnitType) ||
            !IRType.same(c.error, NeverType) ||
            !IRType.same(n.finalizer.output, UnitType) ||
            !IRType.same(n.finalizer.error, NeverType)
          )
            add(at, "AddFinalizer requires Unit/Never registration and cleanup channels");
          walk(n.finalizer, bindings, `${at}.finalizer`);
        },
        AcquireRelease: (n) => {
          if (
            !IRType.same(c.output, n.acquire.output) ||
            !IRType.same(c.error, n.acquire.error) ||
            !IRType.same(n.release.output, UnitType) ||
            !IRType.same(n.release.error, NeverType) ||
            ![BoolType, U64Type, UnitType, NeverType].some((type) =>
              IRType.same(type, n.acquire.output),
            )
          )
            add(
              at,
              "AcquireRelease preserves scalar acquisition channels and requires Unit/Never release",
            );
          walk(n.acquire, bindings, `${at}.acquire`);
          const nested = new Map(bindings);
          nested.set(n.binder, [n.acquire.output]);
          walk(n.release, nested, `${at}.release`);
        },
        RegisteredFile: (n) => {
          if (
            !validFilePath(n.path) ||
            !IRType.same(c.output, n.body.output) ||
            !joined(c.error, BoolType, n.body.error) ||
            !IRType.same(n.afterClose.output, UnitType) ||
            !IRType.same(n.afterClose.error, NeverType)
          )
            add(
              at,
              "RegisteredFile requires a valid path, body channels joined with Boolean IO failure and Unit/Never cleanup",
            );
          const nested = new Map(bindings);
          nested.set(n.binder, [FileHandleType]);
          walk(n.body, nested, `${at}.body`);
          walk(n.afterClose, bindings, `${at}.afterClose`);
        },
        FileScope: (n) => {
          if (
            !validFilePath(n.path) ||
            !IRType.same(c.output, n.body.output) ||
            !joined(c.error, BoolType, n.body.error) ||
            !IRType.same(n.afterClose.output, UnitType) ||
            !IRType.same(n.afterClose.error, NeverType)
          )
            add(
              at,
              "FileScope requires a valid path, body channels joined with Boolean IO failure and Unit/Never cleanup",
            );
          const nested = new Map(bindings);
          nested.set(n.binder, [FileHandleType]);
          walk(n.body, nested, `${at}.body`);
          walk(n.afterClose, bindings, `${at}.afterClose`);
        },
        FileSize: (n) => {
          if (!IRType.same(c.output, U64Type) || !IRType.same(c.error, BoolType))
            add(at, "FileSize requires u64/Boolean channels");
          if (!bindings.get(n.binder)?.some((type) => IRType.same(type, FileHandleType)))
            issues.push({
              code: "RESOURCE_ESCAPE",
              stage: "check",
              path: at,
              message: "File operations require an active lexical file scope",
            });
        },
        Sleep: (n) => {
          if (
            !validDelay(n.milliseconds) ||
            !IRType.same(c.output, UnitType) ||
            !IRType.same(c.error, NeverType)
          )
            add(
              at,
              "Sleep requires Unit/Never channels and an integer delay from 0 to 60000 milliseconds",
            );
        },
        Launch: (n) => {
          if (!IRType.same(c.output, NeverType) || !IRType.same(c.error, NeverType))
            add(at, "Launch requires Never channels");
          n.values.forEach((value, index) => {
            if (!scalarLaunch(value.type))
              add(`${at}.values`, "Launch values require Boolean, u64 or Unit witnesses");
            expression(value, `values.${index}`);
          });
        },
        Repeat: (n) => {
          if (
            !validSchedulePlan(n.schedule) ||
            !validTimes(n.times) ||
            !IRType.same(c.output, UnitType) ||
            !IRType.same(n.body.output, UnitType) ||
            !IRType.same(c.error, n.body.error)
          )
            add(
              at,
              "Repeat requires a valid bounded schedule, Unit output, matching body errors and a valid additional-run count",
            );
          walk(n.body, bindings, `${at}.body`);
        },
        Retry: (n) => {
          if (
            !validSchedulePlan(n.schedule) ||
            !validTimes(n.times) ||
            !IRType.same(c.output, n.body.output) ||
            !IRType.same(c.error, n.body.error)
          )
            add(
              at,
              "Retry requires a valid bounded schedule, matching body channels and a valid additional-run count",
            );
          walk(n.body, bindings, `${at}.body`);
        },
        CatchAll: (n) => {
          if (
            !joined(c.output, n.source.output, n.body.output) ||
            !IRType.same(c.error, n.body.error)
          )
            add(at, "CatchAll channel witnesses are inconsistent");
          walk(n.source, bindings, `${at}.source`);
          const nested = new Map(bindings);
          nested.set(n.binder, [n.source.error]);
          walk(n.body, nested, `${at}.body`);
        },
        AcquireUseRelease: (n) => {
          if (
            !IRType.same(c.output, n.use.output) ||
            !joined(c.error, n.acquire.error, n.use.error) ||
            !IRType.same(n.release.output, UnitType) ||
            !IRType.same(n.release.error, NeverType)
          )
            add(
              at,
              "AcquireUseRelease preserves use output, joins acquisition/use errors, and requires Unit/Never release",
            );
          walk(n.acquire, bindings, `${at}.acquire`);
          const nested = new Map(bindings);
          nested.set(n.binder, [n.acquire.output]);
          walk(n.use, nested, `${at}.use`);
          walk(n.release, nested, `${at}.release`);
        },
        Ensuring: (n) => {
          if (
            !IRType.same(c.output, n.body.output) ||
            !IRType.same(c.error, n.body.error) ||
            !IRType.same(n.finalizer.output, UnitType) ||
            !IRType.same(n.finalizer.error, NeverType)
          )
            add(at, "Ensuring preserves body channels and requires a Unit/Never finalizer");
          walk(n.body, bindings, `${at}.body`);
          walk(n.finalizer, bindings, `${at}.finalizer`);
        },
        Succeed: (n) => {
          if (!IRType.same(c.output, n.value.type) || !IRType.same(c.error, NeverType))
            add(at, "Succeed channel witnesses are inconsistent");
          expression(n.value, "value");
        },
        Fail: (n) => {
          if (!IRType.same(c.output, NeverType) || !IRType.same(c.error, n.error.type))
            add(at, "Fail channel witnesses are inconsistent");
          expression(n.error, "error");
        },
        Map: (n) => {
          if (!IRType.same(c.output, n.body.type) || !IRType.same(c.error, n.source.error))
            add(at, "Map channel witnesses are inconsistent");
          walk(n.source, bindings, `${at}.source`);
          const nested = new Map(bindings);
          nested.set(n.binder, [n.source.output]);
          issues.push(...checkExpression(n.body, nested, `${at}.body`));
        },
        FlatMap: (n) => {
          if (
            !IRType.same(c.output, n.body.output) ||
            !joined(c.error, n.source.error, n.body.error)
          )
            add(at, "FlatMap channel witnesses are inconsistent");
          walk(n.source, bindings, `${at}.source`);
          const nested = new Map(bindings);
          nested.set(n.binder, [n.source.output]);
          walk(n.body, nested, `${at}.body`);
        },
        Match: (n) => {
          if (
            !IRType.same(n.condition.type, BoolType) ||
            !joined(c.output, n.onTrue.output, n.onFalse.output) ||
            !joined(c.error, n.onTrue.error, n.onFalse.error)
          )
            add(at, "Match condition/channel witnesses are inconsistent");
          expression(n.condition, "condition");
          walk(n.onTrue, bindings, `${at}.onTrue`);
          walk(n.onFalse, bindings, `${at}.onFalse`);
        },
        MatchTags: (n) => {
          const caseTypes = unionCases(n.value.type);
          const tags = caseTypes?.map((t) => structLayout(t)?.tag);
          if (
            !tags ||
            tags.length !== n.cases.length ||
            tags.some((tag) => n.cases.filter((x) => x.tag === tag).length !== 1)
          )
            add(at, "Tagged match requires exactly one case per union tag");
          if (
            n.cases.some((x) => !agrees(x.body.output, c.output) || !agrees(x.body.error, c.error))
          )
            add(at, "Tagged match case channel witnesses are inconsistent");
          expression(n.value, "value");
          n.cases.forEach((x, i) => {
            const caseType = caseTypes?.[tags!.indexOf(x.tag)];
            if (!caseType) return;
            const nested = new Map(bindings);
            nested.set(x.binder, [caseType]);
            walk(x.body, nested, `${at}.cases[${i}]`);
          });
        },
        Log: (n) => {
          if (!IRType.same(c.output, UnitType) || !IRType.same(c.error, NeverType))
            add(at, "Log channel witnesses are inconsistent");
          if (!logLevels.includes(n.level)) add(at, "Log level is not a supported severity");
          for (const [key, value] of n.attributes) {
            if (!validLogName(key)) add(at, "Log attribute keys are invalid");
            if (!IRType.same(value.type, BoolType) && !IRType.same(value.type, U64Type))
              issues.push({
                code: "TYPE_MISMATCH",
                stage: "check",
                path: `${at}.attributes`,
                message: "Log attributes require Boolean or u64 witnesses",
              });
            expression(value, "attributes");
          }
        },
        Annotate: (n) => {
          if (!IRType.same(c.output, n.body.output) || !IRType.same(c.error, n.body.error))
            add(at, "Annotate channel witnesses are inconsistent");
          if (!validLogName(n.key)) add(at, "Annotation key is invalid");
          if (!IRType.same(n.value.type, BoolType) && !IRType.same(n.value.type, U64Type))
            add(at, "Annotation values require Boolean or u64 witnesses");
          expression(n.value, "value");
          walk(n.body, bindings, `${at}.body`);
        },
        Span: (n) => {
          if (!IRType.same(c.output, n.body.output) || !IRType.same(c.error, n.body.error))
            add(at, "Span channel witnesses are inconsistent");
          if (!validLogName(n.label)) add(at, "Span label is invalid");
          walk(n.body, bindings, `${at}.body`);
        },
      }),
    );
    active.delete(c);
    const scopes = visited.get(c) ?? new Set<Bindings>();
    scopes.add(bindings);
    visited.set(c, scopes);
  };
  if (!agrees(f.body.output, f.output) || !agrees(f.body.error, f.error))
    add(path, "Effect function body differs from declared success/error witnesses");
  walk(f.body, new Map([[f.binder, f.input]]), `${path}.body`);
  issues.push(...analyzeScopes(f.body, `${path}.body`).diagnostics);
  return issues;
};

const runUnknown = Effect.fn("EffectReference.runUnknown")(function* <
  I extends readonly IRType<unknown>[],
  A,
  E,
>(f: EffectFn<I, A, E>, args: readonly unknown[]): Effect.fn.Return<A, E | CompileError> {
  const issues = checkEffectFunction(f, "function");
  if (issues.length)
    return yield* new CompileError({ message: "Invalid effect function", diagnostics: issues });
  if (args.length !== f.input.length)
    return yield* fail("ARITY_MISMATCH", "reference", "args", "Incorrect input count");
  const values: unknown[] = [];
  for (let i = 0; i < args.length; i++)
    values.push(
      yield* Schema.decodeUnknownEffect(f.input[i].schema)(args[i]).pipe(
        Effect.mapError((e) => fail("INVALID_INPUT", "reference", `args[${i}]`, e.message)),
      ),
    );
  type Bindings = ReadonlyMap<symbol, readonly unknown[]>;
  const evaluate = (
    c: Computation<unknown, unknown>,
    bindings: Bindings,
  ): Effect.Effect<unknown, unknown, Scope.Scope> =>
    Effect.suspend(() => {
      const expression = (e: Expr<unknown>) =>
        Effect.try({
          try: () => evaluateExpression(e, bindings),
          catch: (cause) => fail("REFERENCE_FAILURE", "reference", "expression", String(cause)),
        });
      return Match.value(c.node).pipe(
        Match.tagsExhaustive({
          Scope: (n) => Effect.scoped(evaluate(n.body, bindings)),
          AddFinalizer: (n) =>
            Effect.addFinalizer(() =>
              evaluate(n.finalizer, bindings).pipe(Effect.asVoid, Effect.orDie),
            ),
          AcquireRelease: (n) =>
            Effect.acquireRelease(evaluate(n.acquire, bindings), (resource) => {
              const nested = new Map(bindings);
              nested.set(n.binder, [resource]);
              return evaluate(n.release, nested).pipe(Effect.asVoid, Effect.orDie);
            }),
          RegisteredFile: (n) =>
            Effect.acquireRelease(openReferenceFile(n.path), (file) =>
              file.close.pipe(
                Effect.flatMap(() => evaluate(n.afterClose, bindings)),
                Effect.asVoid,
                Effect.orDie,
              ),
            ).pipe(
              Effect.flatMap((file) => {
                const nested = new Map(bindings);
                nested.set(n.binder, [file]);
                return evaluate(n.body, nested);
              }),
            ),
          FileScope: (n) =>
            Effect.acquireUseRelease(
              openReferenceFile(n.path),
              (file) => {
                const nested = new Map(bindings);
                nested.set(n.binder, [file]);
                return evaluate(n.body, nested);
              },
              (file) =>
                file.close.pipe(
                  Effect.flatMap(() => evaluate(n.afterClose, bindings)),
                  Effect.asVoid,
                  Effect.orDie,
                ),
            ),
          FileSize: (n) => {
            const file = bindings.get(n.binder)?.[0];
            return file instanceof FileLease
              ? file.size
              : Effect.fail(fail("RESOURCE_ESCAPE", "reference", "file", "Missing file lease"));
          },
          CatchAll: (n) =>
            evaluate(n.source, bindings).pipe(
              Effect.catch((error) => {
                if (error instanceof CompileError) return Effect.fail(error);
                const nested = new Map(bindings);
                nested.set(n.binder, [error]);
                return evaluate(n.body, nested);
              }),
            ),
          AcquireUseRelease: (n) =>
            Effect.acquireUseRelease(
              evaluate(n.acquire, bindings),
              (resource) => {
                const nested = new Map(bindings);
                nested.set(n.binder, [resource]);
                return evaluate(n.use, nested);
              },
              (resource) => {
                const nested = new Map(bindings);
                nested.set(n.binder, [resource]);
                return evaluate(n.release, nested).pipe(Effect.asVoid, Effect.orDie);
              },
            ),
          Sleep: (n) => Effect.sleep(n.milliseconds),
          Launch: (n) => Effect.forEach(n.values, expression).pipe(Effect.flatMap(launchReference)),
          Repeat: (n) =>
            evaluate(n.body, bindings).pipe(
              Effect.repeat({ schedule: toEffectSchedule(n.schedule), times: n.times }),
              Effect.asVoid,
            ),
          Retry: (n) =>
            evaluate(n.body, bindings).pipe(
              Effect.retry({ schedule: toEffectSchedule(n.schedule), times: n.times }),
            ),
          Ensuring: (n) =>
            evaluate(n.body, bindings).pipe(
              Effect.ensuring(evaluate(n.finalizer, bindings).pipe(Effect.asVoid, Effect.orDie)),
            ),
          Succeed: (n) => expression(n.value).pipe(Effect.flatMap(Effect.succeed)),
          Fail: (n) => expression(n.error).pipe(Effect.flatMap(Effect.fail)),
          Map: (n) =>
            evaluate(n.source, bindings).pipe(
              Effect.map((value) => {
                const nested = new Map(bindings);
                nested.set(n.binder, [value]);
                return nested;
              }),
              Effect.flatMap((nested) =>
                Effect.try({
                  try: () => evaluateExpression(n.body, nested),
                  catch: (cause) => fail("REFERENCE_FAILURE", "reference", "map", String(cause)),
                }),
              ),
            ),
          FlatMap: (n) =>
            evaluate(n.source, bindings).pipe(
              Effect.flatMap((value) => {
                const nested = new Map(bindings);
                nested.set(n.binder, [value]);
                return evaluate(n.body, nested);
              }),
            ),
          Match: (n) =>
            expression(n.condition).pipe(
              Effect.flatMap((value) => evaluate(value ? n.onTrue : n.onFalse, bindings)),
            ),
          MatchTags: (n) =>
            expression(n.value).pipe(
              Effect.flatMap((value) => {
                const selected = n.cases.find(
                  (x) => x.tag === (value as { readonly _tag: string })._tag,
                )!;
                return evaluate(selected.body, new Map(bindings).set(selected.binder, [value]));
              }),
            ),
          Log: (n) =>
            Effect.forEach(n.attributes, ([key, value]) =>
              expression(value).pipe(Effect.map((evaluated) => [key, evaluated] as const)),
            ).pipe(
              Effect.flatMap((entries) => {
                const record = Object.fromEntries(entries);
                const logged = Effect.logWithLevel(n.level)(n.message);
                return Object.keys(record).length === 0
                  ? logged
                  : logged.pipe(Effect.annotateLogs(record));
              }),
            ),
          Annotate: (n) =>
            expression(n.value).pipe(
              Effect.flatMap((value) =>
                evaluate(n.body, bindings).pipe(Effect.annotateLogs(n.key, value)),
              ),
            ),
          Span: (n) => evaluate(n.body, bindings).pipe(Effect.withLogSpan(n.label)),
        }),
      );
    });
  return yield* evaluate(f.body, new Map([[f.binder, values]])) as Effect.Effect<
    A,
    E | CompileError
  >;
});
export interface LogicalFrame {
  readonly path: string;
  readonly kind:
    | "function"
    | "succeed"
    | "fail"
    | "map"
    | "flatMap"
    | "match"
    | "annotate"
    | "span"
    | "sleep"
    | "launch"
    | "repeat"
    | "retry"
    | "catchAll"
    | "ensuring"
    | "scope"
    | "addFinalizer"
    | "acquireRelease"
    | "registeredFile"
    | "acquireUseRelease"
    | "fileScope"
    | "fileSize"
    | "log";
}
export const maxLogicalFrames = 32;
export interface FramedExit<A, E> {
  readonly exit: Exit.Exit<A, E>;
  readonly frames: readonly LogicalFrame[];
  readonly omitted: number;
}
type FramedFailure =
  | {
      readonly _tag: "Domain";
      readonly error: unknown;
      readonly frames: readonly LogicalFrame[];
      readonly omitted: number;
    }
  | { readonly _tag: "Internal"; readonly cause: CompileError };
const frame = (path: string, kind: LogicalFrame["kind"]): LogicalFrame =>
  Object.freeze({ path, kind });
const runWithFramesUnknown = Effect.fn("EffectReference.runWithFramesUnknown")(function* <
  I extends readonly IRType<unknown>[],
  A,
  E,
>(
  f: EffectFn<I, A, E>,
  args: readonly unknown[],
  basePath = "functions.body",
): Effect.fn.Return<FramedExit<A, E>, CompileError> {
  const issues = checkEffectFunction(f, "function");
  if (issues.length)
    return yield* new CompileError({ message: "Invalid effect function", diagnostics: issues });
  if (args.length !== f.input.length)
    return yield* fail("ARITY_MISMATCH", "reference", "args", "Incorrect input count");
  const values: unknown[] = [];
  for (let i = 0; i < args.length; i++)
    values.push(
      yield* Schema.decodeUnknownEffect(f.input[i].schema)(args[i]).pipe(
        Effect.mapError((e) => fail("INVALID_INPUT", "reference", `args[${i}]`, e.message)),
      ),
    );
  // Canonical first-seen paths, mirroring lowering traversal order (Match visits
  // onTrue before onFalse; FlatMap visits source before body). Shared nodes keep
  // their first-seen path on both sides, so identical computations report identical
  // frames. Scope-divergent sharing is not yet path-resolved; see research.
  const adapted = new Map<Computation<unknown, unknown>, string>();
  const adapting = new Set<Computation<unknown, unknown>>();
  const adaptNode = (c: Computation<unknown, unknown>, path: string): void => {
    if (adapted.has(c)) return;
    if (adapting.has(c))
      throw fail("IR_CYCLE", "reference", path, "Computation graph contains a cycle");
    adapting.add(c);
    adapted.set(c, path);
    Match.value(c.node).pipe(
      Match.tagsExhaustive({
        Scope: (n) => adaptNode(n.body, `${path}.body`),
        AddFinalizer: (n) => adaptNode(n.finalizer, `${path}.finalizer`),
        AcquireRelease: (n) => {
          adaptNode(n.acquire, `${path}.acquire`);
          adaptNode(n.release, `${path}.release`);
        },
        RegisteredFile: (n) => {
          adaptNode(n.body, `${path}.body`);
          adaptNode(n.afterClose, `${path}.afterClose`);
        },
        FileScope: (n) => {
          adaptNode(n.body, `${path}.body`);
          adaptNode(n.afterClose, `${path}.afterClose`);
        },
        FileSize: () => {},
        CatchAll: (n) => {
          adaptNode(n.source, `${path}.source`);
          adaptNode(n.body, `${path}.body`);
        },
        AcquireUseRelease: (n) => {
          adaptNode(n.acquire, `${path}.acquire`);
          adaptNode(n.use, `${path}.use`);
          adaptNode(n.release, `${path}.release`);
        },
        Sleep: () => {},
        Launch: () => {},
        Repeat: (n) => adaptNode(n.body, `${path}.body`),
        Retry: (n) => adaptNode(n.body, `${path}.body`),
        Ensuring: (n) => {
          adaptNode(n.body, `${path}.body`);
          adaptNode(n.finalizer, `${path}.finalizer`);
        },
        Succeed: () => {},
        Fail: () => {},
        Map: (n) => {
          adaptNode(n.source, `${path}.source`);
        },
        FlatMap: (n) => {
          adaptNode(n.source, `${path}.source`);
          adaptNode(n.body, `${path}.body`);
        },
        Match: (n) => {
          adaptNode(n.onTrue, `${path}.onTrue`);
          adaptNode(n.onFalse, `${path}.onFalse`);
        },
        MatchTags: (n) => n.cases.forEach((x, i) => adaptNode(x.body, `${path}.cases[${i}]`)),
        Log: () => {},
        Annotate: (n) => {
          adaptNode(n.body, `${path}.body`);
        },
        Span: (n) => {
          adaptNode(n.body, `${path}.body`);
        },
      }),
    );
    adapting.delete(c);
  };
  try {
    adaptNode(f.body, basePath);
  } catch (cause) {
    return yield* cause instanceof CompileError
      ? cause
      : fail("INVALID_IR", "reference", basePath, String(cause));
  }
  type Bindings = ReadonlyMap<symbol, readonly unknown[]>;
  const evaluate = (
    c: Computation<unknown, unknown>,
    bindings: Bindings,
  ): Effect.Effect<unknown, FramedFailure, Scope.Scope> =>
    Effect.suspend(() => {
      const path = adapted.get(c) ?? basePath;
      const expression = (e: Expr<unknown>, step: string) =>
        Effect.try({
          try: () => evaluateExpression(e, bindings),
          catch: (): FramedFailure => ({
            _tag: "Internal",
            cause: fail("REFERENCE_FAILURE", "reference", step, "Expression failed"),
          }),
        });
      const outward = (failure: FramedFailure, kind: LogicalFrame["kind"]): FramedFailure =>
        failure._tag === "Internal"
          ? failure
          : {
              _tag: "Domain",
              error: failure.error,
              frames:
                failure.frames.length < maxLogicalFrames
                  ? failure.frames.concat([frame(path, kind)])
                  : failure.frames,
              omitted: failure.omitted + (failure.frames.length < maxLogicalFrames ? 0 : 1),
            };
      return Match.value(c.node).pipe(
        Match.tagsExhaustive({
          Scope: (n) =>
            Effect.scoped(evaluate(n.body, bindings)).pipe(
              Effect.mapError((failure) => outward(failure, "scope")),
            ),
          AddFinalizer: (n) =>
            Effect.addFinalizer(() =>
              evaluate(n.finalizer, bindings).pipe(Effect.asVoid, Effect.orDie),
            ),
          AcquireRelease: (n) =>
            Effect.acquireRelease(evaluate(n.acquire, bindings), (resource) => {
              const nested = new Map(bindings);
              nested.set(n.binder, [resource]);
              return evaluate(n.release, nested).pipe(Effect.asVoid, Effect.orDie);
            }).pipe(Effect.mapError((failure) => outward(failure, "acquireRelease"))),
          RegisteredFile: (n) =>
            Effect.acquireRelease(
              openReferenceFile(n.path).pipe(
                Effect.mapError((error): FramedFailure => ({
                  _tag: "Domain",
                  error,
                  frames: [],
                  omitted: 0,
                })),
              ),
              (file) =>
                file.close.pipe(
                  Effect.flatMap(() => evaluate(n.afterClose, bindings)),
                  Effect.asVoid,
                  Effect.orDie,
                ),
            ).pipe(
              Effect.flatMap((file) => {
                const nested = new Map(bindings);
                nested.set(n.binder, [file]);
                return evaluate(n.body, nested);
              }),
              Effect.mapError((failure) => outward(failure, "registeredFile")),
            ),
          FileScope: (n) =>
            Effect.acquireUseRelease(
              openReferenceFile(n.path).pipe(
                Effect.mapError((error): FramedFailure => ({
                  _tag: "Domain",
                  error,
                  frames: [],
                  omitted: 0,
                })),
              ),
              (file) => {
                const nested = new Map(bindings);
                nested.set(n.binder, [file]);
                return evaluate(n.body, nested);
              },
              (file) =>
                file.close.pipe(
                  Effect.flatMap(() => evaluate(n.afterClose, bindings)),
                  Effect.asVoid,
                  Effect.orDie,
                ),
            ).pipe(Effect.mapError((failure) => outward(failure, "fileScope"))),
          FileSize: (n) => {
            const file = bindings.get(n.binder)?.[0];
            return file instanceof FileLease
              ? file.size.pipe(
                  Effect.mapError((error): FramedFailure => ({
                    _tag: "Domain",
                    error,
                    frames: [frame(path, "fileSize")],
                    omitted: 0,
                  })),
                )
              : Effect.fail({
                  _tag: "Internal",
                  cause: fail("RESOURCE_ESCAPE", "reference", "file", "Missing file lease"),
                } as const);
          },
          CatchAll: (n) =>
            evaluate(n.source, bindings).pipe(
              Effect.catch((failure) => {
                if (failure._tag === "Internal") return Effect.fail(failure);
                const nested = new Map(bindings);
                nested.set(n.binder, [failure.error]);
                return evaluate(n.body, nested).pipe(
                  Effect.mapError((error) => outward(error, "catchAll")),
                );
              }),
            ),
          AcquireUseRelease: (n) =>
            Effect.acquireUseRelease(
              evaluate(n.acquire, bindings),
              (resource) => {
                const nested = new Map(bindings);
                nested.set(n.binder, [resource]);
                return evaluate(n.use, nested);
              },
              (resource) => {
                const nested = new Map(bindings);
                nested.set(n.binder, [resource]);
                return evaluate(n.release, nested).pipe(Effect.asVoid, Effect.orDie);
              },
            ).pipe(Effect.mapError((failure) => outward(failure, "acquireUseRelease"))),
          Sleep: (n) => Effect.sleep(n.milliseconds),
          Launch: (n) =>
            Effect.forEach(n.values, (value, index) =>
              expression(value, `${path}.values.${index}`),
            ).pipe(
              Effect.mapError((cause): FramedFailure =>
                cause instanceof CompileError
                  ? { _tag: "Internal", cause }
                  : (cause as FramedFailure),
              ),
              Effect.flatMap(launchReference),
            ),
          Repeat: (n) =>
            evaluate(n.body, bindings).pipe(
              Effect.repeat({ schedule: toEffectSchedule(n.schedule), times: n.times }),
              Effect.asVoid,
              Effect.mapError((failure) => outward(failure, "repeat")),
            ),
          Retry: (n) => {
            let completed = 0;
            const attempt = (): Effect.Effect<unknown, FramedFailure, Scope.Scope> =>
              evaluate(n.body, bindings).pipe(
                Effect.catch((failure: FramedFailure) => {
                  if (failure._tag === "Internal") return Effect.fail(failure);
                  if (!scheduleContinues(n.schedule, completed, n.times))
                    return Effect.fail(failure);
                  const delay = scheduleDelay(n.schedule, completed);
                  completed += 1;
                  return Effect.sleep(delay).pipe(Effect.flatMap(attempt));
                }),
              );
            return attempt().pipe(Effect.mapError((failure) => outward(failure, "retry")));
          },
          Ensuring: (n) =>
            evaluate(n.body, bindings).pipe(
              Effect.ensuring(evaluate(n.finalizer, bindings).pipe(Effect.asVoid, Effect.orDie)),
              Effect.mapError((failure) => outward(failure, "ensuring")),
            ),
          Succeed: (n) =>
            expression(n.value, `${path}.value`).pipe(
              Effect.mapError((cause): FramedFailure =>
                cause instanceof CompileError
                  ? { _tag: "Internal", cause }
                  : (cause as FramedFailure),
              ),
            ),
          Fail: (n) =>
            expression(n.error, `${path}.error`).pipe(
              Effect.mapError((cause): FramedFailure =>
                cause instanceof CompileError
                  ? { _tag: "Internal", cause }
                  : (cause as FramedFailure),
              ),
              Effect.flatMap((payload): Effect.Effect<unknown, FramedFailure> =>
                Effect.fail({
                  _tag: "Domain",
                  error: payload,
                  frames: [frame(path, "fail")],
                  omitted: 0,
                } as const),
              ),
            ),
          Map: (n) =>
            evaluate(n.source, bindings).pipe(
              Effect.mapError((failure) => outward(failure, "map")),
              Effect.flatMap((value) => {
                const nested = new Map(bindings);
                nested.set(n.binder, [value]);
                return expression(n.body, `${path}.body`).pipe(
                  Effect.mapError((cause): FramedFailure =>
                    cause instanceof CompileError
                      ? { _tag: "Internal", cause }
                      : (cause as FramedFailure),
                  ),
                );
              }),
            ),
          FlatMap: (n) =>
            evaluate(n.source, bindings).pipe(
              Effect.mapError((failure) => outward(failure, "flatMap")),
              Effect.flatMap((value) => {
                const nested = new Map(bindings);
                nested.set(n.binder, [value]);
                return evaluate(n.body, nested).pipe(
                  Effect.mapError((failure) => outward(failure, "flatMap")),
                );
              }),
            ),
          Match: (n) =>
            expression(n.condition, `${path}.condition`).pipe(
              Effect.mapError((cause): FramedFailure =>
                cause instanceof CompileError
                  ? { _tag: "Internal", cause }
                  : (cause as FramedFailure),
              ),
              Effect.flatMap((value) =>
                (value ? evaluate(n.onTrue, bindings) : evaluate(n.onFalse, bindings)).pipe(
                  Effect.mapError((failure) => outward(failure, "match")),
                ),
              ),
            ),
          MatchTags: (n) =>
            expression(n.value, `${path}.value`).pipe(
              Effect.mapError((cause): FramedFailure =>
                cause instanceof CompileError
                  ? { _tag: "Internal", cause }
                  : (cause as FramedFailure),
              ),
              Effect.flatMap((value) => {
                const selected = n.cases.find(
                  (x) => x.tag === (value as { readonly _tag: string })._tag,
                )!;
                return evaluate(
                  selected.body,
                  new Map(bindings).set(selected.binder, [value]),
                ).pipe(Effect.mapError((failure) => outward(failure, "match")));
              }),
            ),
          Log: (n) =>
            Effect.forEach(n.attributes, ([key, value]) =>
              expression(value, `${path}.attributes.${key}`).pipe(
                Effect.map((evaluated) => [key, evaluated] as const),
                Effect.mapError((cause): FramedFailure =>
                  cause instanceof CompileError
                    ? { _tag: "Internal", cause }
                    : (cause as FramedFailure),
                ),
              ),
            ).pipe(
              Effect.flatMap((entries) => {
                const record = Object.fromEntries(entries);
                const logged = Effect.logWithLevel(n.level)(n.message);
                return Object.keys(record).length === 0
                  ? logged
                  : logged.pipe(Effect.annotateLogs(record));
              }),
            ),
          Annotate: (n) =>
            expression(n.value, `${path}.value`).pipe(
              Effect.mapError((cause): FramedFailure =>
                cause instanceof CompileError
                  ? { _tag: "Internal", cause }
                  : (cause as FramedFailure),
              ),
              Effect.flatMap((value) =>
                evaluate(n.body, bindings).pipe(
                  Effect.annotateLogs(n.key, value),
                  Effect.mapError((failure) => outward(failure, "annotate")),
                ),
              ),
            ),
          Span: (n) =>
            evaluate(n.body, bindings).pipe(
              Effect.withLogSpan(n.label),
              Effect.mapError((failure) => outward(failure, "span")),
            ),
        }),
      );
    });
  // The lexical checker proves that every registration is discharged by its own Scope node.
  const checked = evaluate(f.body, new Map([[f.binder, values]])) as Effect.Effect<
    unknown,
    FramedFailure
  >;
  const outcome = yield* checked.pipe(
    Effect.map((value) => ({ _tag: "Ok", value }) as const),
    Effect.catch((failure: FramedFailure) =>
      failure._tag === "Internal"
        ? Effect.fail(failure.cause)
        : Effect.succeed({ _tag: "Err", failure } as const),
    ),
  );
  if (outcome._tag === "Ok")
    return {
      exit: Exit.succeed(outcome.value as A),
      frames: Object.freeze([]),
      omitted: 0,
    };
  const hasRoom = outcome.failure.frames.length < maxLogicalFrames;
  const kept = hasRoom
    ? outcome.failure.frames.concat([
        frame(basePath.split(".").slice(0, -1).join(".") || basePath, "function"),
      ])
    : outcome.failure.frames;
  return {
    exit: Exit.fail(outcome.failure.error as E),
    frames: Object.freeze(kept),
    omitted: outcome.failure.omitted + (hasRoom ? 0 : 1),
  };
});
export const EffectReference = Object.freeze({
  runUnknown,
  run: <I extends readonly IRType<unknown>[], A, E>(f: EffectFn<I, A, E>, args: Inputs<I>) =>
    runUnknown(f, args),
  runWithFramesUnknown,
  runWithFrames: <I extends readonly IRType<unknown>[], A, E>(
    f: EffectFn<I, A, E>,
    args: Inputs<I>,
    basePath?: string,
  ) => runWithFramesUnknown(f, args, basePath),
});
const logAttributes = (attributes: readonly LogAttribute[]): readonly LogAttribute[] => {
  const seen = new Set<string>();
  for (const [key] of attributes) {
    checkLogName("attribute", key);
    if (seen.has(key))
      throw fail(
        "INVALID_LOG_METADATA",
        "authoring",
        "attribute",
        "Log attribute keys must be unique within one record",
      );
    seen.add(key);
  }
  return Object.freeze(Array.from(attributes));
};
const logMessage = (level: LogLevel, message: string, attributes: readonly LogAttribute[] = []) => {
  if (!logLevels.includes(level))
    throw fail("INVALID_LOG_METADATA", "authoring", "level", "Unknown log severity");
  if (typeof message !== "string")
    throw fail("INVALID_LOG_METADATA", "authoring", "message", "Log messages are static strings");
  return Computation.make(UnitType, NeverType, {
    _tag: "Log",
    level,
    message,
    attributes: logAttributes(attributes),
  });
};
const annotate: {
  (
    key: string,
    value: Expr<boolean> | Expr<bigint>,
  ): <A, E>(self: Computation<A, E>) => Computation<A, E>;
  <A, E>(
    self: Computation<A, E>,
    key: string,
    value: Expr<boolean> | Expr<bigint>,
  ): Computation<A, E>;
} = dual(3, <A, E>(self: Computation<A, E>, key: string, value: Expr<boolean> | Expr<bigint>) => {
  checkLogName("annotation", key);
  return Computation.make(self.output, self.error, {
    _tag: "Annotate",
    key,
    value,
    body: self,
  });
});
const span: {
  (label: string): <A, E>(self: Computation<A, E>) => Computation<A, E>;
  <A, E>(self: Computation<A, E>, label: string): Computation<A, E>;
} = dual(2, <A, E>(self: Computation<A, E>, label: string) => {
  checkLogName("span", label);
  return Computation.make(self.output, self.error, { _tag: "Span", label, body: self });
});
export const LogIR = Object.freeze({
  levels: logLevels,
  log: logMessage,
  trace: (message: string, attributes: readonly LogAttribute[] = []) =>
    logMessage("Trace", message, attributes),
  debug: (message: string, attributes: readonly LogAttribute[] = []) =>
    logMessage("Debug", message, attributes),
  info: (message: string, attributes: readonly LogAttribute[] = []) =>
    logMessage("Info", message, attributes),
  warn: (message: string, attributes: readonly LogAttribute[] = []) =>
    logMessage("Warn", message, attributes),
  error: (message: string, attributes: readonly LogAttribute[] = []) =>
    logMessage("Error", message, attributes),
  fatal: (message: string, attributes: readonly LogAttribute[] = []) =>
    logMessage("Fatal", message, attributes),
  annotate,
  span,
});
/** Effect v4-mirrored log helpers; all delegate to the single `Log` computation node. */
const logAt =
  (level: LogLevel) =>
  (message: string, attributes: readonly LogAttribute[] = []) =>
    logMessage(level, message, attributes);
export const EffectIR = Object.freeze({
  void: succeed(UnitType.literal()),
  asVoid: <A, E>(self: Computation<A, E>): Computation<void, E> =>
    map(self, () => UnitType.literal()),
  succeed,
  sleep,
  repeat,
  retry,
  ensuring,
  acquireUseRelease,
  acquireRelease,
  addFinalizer,
  scoped,
  fail: failValue,
  map,
  flatMap,
  fn: EffectFn.make,
  log: logAt("Info"),
  logTrace: logAt("Trace"),
  logDebug: logAt("Debug"),
  logInfo: logAt("Info"),
  logWarning: logAt("Warn"),
  logError: logAt("Error"),
  logFatal: logAt("Fatal"),
  annotateLogs: annotate,
  withLogSpan: span,
});
