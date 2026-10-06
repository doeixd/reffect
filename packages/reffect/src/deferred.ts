import { Match } from "effect";
import type { Deferred } from "effect";
import { dual } from "effect/Function";
import { Computation } from "./effect-ir.ts";
import { BoolType, Expr, IRType, NeverType, fail as diagnostic } from "./kernel.ts";
import { deferredChannels, deferredError, deferredScalar, deferredType } from "./deferred-model.ts";
const handle = <A, E>(self: Expr<Deferred.Deferred<A, E>>) => {
  const channels = deferredChannels(self.type);
  const parameter = Match.value(self.node).pipe(
    Match.tag("Parameter", (node) => node),
    Match.orElse(() => undefined),
  );
  if (!channels || !parameter || parameter.index !== 0)
    throw diagnostic(
      "RESOURCE_ESCAPE",
      "authoring",
      "Deferred",
      "Deferred operations require a lexical handle",
    );
  return {
    success: channels.success as IRType<A>,
    error: channels.error as IRType<E>,
    binder: parameter.binder,
  };
};
const make = <A, E = never>(
  success: IRType<A>,
  error: IRType<E> = NeverType as IRType<E>,
): Computation<Deferred.Deferred<A, E>> => {
  if (!deferredScalar(success) || !deferredError(error))
    throw diagnostic(
      "UNSUPPORTED_REPRESENTATION",
      "authoring",
      "Deferred.make",
      "Deferred requires scalar success and scalar/Never error channels",
    );
  return Computation.make(deferredType(success, error), NeverType, {
    _tag: "DeferredMake",
    success,
    error,
  });
};
const awaitDeferred = <A, E>(self: Expr<Deferred.Deferred<A, E>>): Computation<A, E> => {
  const channels = handle(self);
  return Computation.make(channels.success, channels.error, { _tag: "DeferredAwait", ...channels });
};
const complete = <A, E>(
  self: Expr<Deferred.Deferred<A, E>>,
  result: "Succeed" | "Fail",
  value: Expr<unknown>,
): Computation<boolean> => {
  const channels = handle(self);
  if (!IRType.same(value.type, result === "Succeed" ? channels.success : channels.error))
    throw diagnostic(
      "TYPE_MISMATCH",
      "authoring",
      "Deferred.complete",
      "Deferred completion payload must match its channel",
    );
  return Computation.make(BoolType, NeverType, {
    _tag: "DeferredComplete",
    ...channels,
    result,
    value,
  });
};
const succeed: {
  <A>(value: Expr<A>): <E>(self: Expr<Deferred.Deferred<NoInfer<A>, E>>) => Computation<boolean>;
  <A, E>(self: Expr<Deferred.Deferred<A, E>>, value: Expr<NoInfer<A>>): Computation<boolean>;
} = dual(2, <A, E>(self: Expr<Deferred.Deferred<A, E>>, value: Expr<A>) =>
  complete(self, "Succeed", value),
);
const fail: {
  <E>(value: Expr<E>): <A>(self: Expr<Deferred.Deferred<A, NoInfer<E>>>) => Computation<boolean>;
  <A, E>(self: Expr<Deferred.Deferred<A, E>>, value: Expr<NoInfer<E>>): Computation<boolean>;
} = dual(2, <A, E>(self: Expr<Deferred.Deferred<A, E>>, value: Expr<E>) =>
  complete(self, "Fail", value),
);
const isDone = <A, E>(self: Expr<Deferred.Deferred<A, E>>): Computation<boolean> =>
  Computation.make(BoolType, NeverType, { _tag: "DeferredIsDone", ...handle(self) });
/** Internal coordination builders include typed failure; public admission is scalar/Never only. */
export const DeferredIR = Object.freeze({ make, await: awaitDeferred, succeed, fail, isDone });

/** Public scalar/Never coordination; handles stay inside their lexical function. */
export const DeferredPublic = Object.freeze({
  make: <A>(success: IRType<A>): Computation<Deferred.Deferred<A, never>> => make(success),
  await: awaitDeferred,
  succeed,
  isDone,
});
