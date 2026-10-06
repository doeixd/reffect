import { Match } from "effect";
import { Computation, EffectIR, isAsyncComputation } from "./effect-ir.ts";
import { catchAll } from "./error-recovery.ts";
import { ExitIR } from "./exit.ts";
import type { ExitValue } from "./exit.ts";
import { fail } from "./kernel.ts";

const readsDriver = (root: Computation<unknown, unknown>): boolean => {
  const seen = new Set<Computation<unknown, unknown>>();
  const walk = (c: Computation<unknown, unknown>): boolean => {
    if (seen.has(c)) return false;
    seen.add(c);
    return Match.value(c.node).pipe(
      Match.tagsExhaustive({
        ClockReadMillis: () => true,
        RandomDraw: () => true,
        Map: (n) => walk(n.source),
        FlatMap: (n) => walk(n.source) || walk(n.body),
        CatchAll: (n) => walk(n.source) || walk(n.body),
        DeferredScope: (n) => walk(n.body),
        SemaphoreMake: () => false,
        SemaphoreScope: (n) => walk(n.body),
        SemaphoreWithPermits: (n) => walk(n.body),
        DeferredMake: () => false,
        DeferredAwait: () => false,
        DeferredComplete: () => false,
        DeferredIsDone: () => false,
        RefScope: (n) => walk(n.body),
        Match: (n) => walk(n.onTrue) || walk(n.onFalse),
        MatchTags: (n) => n.cases.some((c) => walk(c.body)),
        ForEach: (n) => walk(n.body),
        Annotate: (n) => walk(n.body),
        Span: (n) => walk(n.body),
        // The admitted finite Stream IR has pure expressions and typed Fail only.
        StreamRunCollect: () => false,
        StreamEmit: () => false,
        // Async graphs have already been refused before this traversal.
        TaskGroup: () => false,
        Scope: () => false,
        AddFinalizer: () => false,
        AcquireRelease: () => false,
        RegisteredFile: () => false,
        FileScope: () => false,
        FileSize: () => false,
        Sleep: () => false,
        Launch: () => false,
        RemoteStore: () => false,
        Repeat: () => false,
        Retry: () => false,
        Ensuring: () => false,
        AcquireUseRelease: () => false,
        Succeed: () => false,
        Fail: () => false,
        Log: () => false,
        RefMake: () => false,
        RefGet: () => false,
        RefModify: () => false,
      }),
    );
  };
  return walk(root);
};

/** Capture synchronous typed outcomes as Exit data; async and driver-fault capture are refused. */
export const effectExit = <A, E>(self: Computation<A, E>): Computation<ExitValue<A, E>, never> => {
  if (isAsyncComputation(self) || readsDriver(self))
    throw fail(
      "UNSUPPORTED_EXIT_CAPTURE",
      "authoring",
      "Effect.exit",
      "Effect.exit requires a synchronous computation without Clock/Random reads",
    );
  return catchAll(
    EffectIR.map(self, (value) => ExitIR.succeed(value, self.error)),
    (error) => EffectIR.succeed(ExitIR.fail(error, self.output)),
  );
};
