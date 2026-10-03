import { dual } from "effect/Function";
import { CauseIR, causeErrorType } from "./cause.ts";
import type { CauseValue } from "./cause.ts";
import { BoolType, Expr, IRType, UnitType, fail, structLayout, unionCases } from "./kernel.ts";
import { OptionIR } from "./option.ts";
import { TaggedUnion, matchTags } from "./records.ts";

/** Plain Effect Exit data whose failure contains only typed Fail reasons. */
export type ExitValue<A, E> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly cause: CauseValue<E> };
const exitType = <A, E>(success: IRType<A>, error: IRType<E>) =>
  TaggedUnion({ Success: { value: success }, Failure: { cause: CauseIR(error) } });
const channels = <A, E>(self: Expr<ExitValue<A, E>>) => {
  const cases = unionCases(self.type);
  const success = cases?.find((c) => structLayout(c)?.tag === "Success");
  const failure = cases?.find((c) => structLayout(c)?.tag === "Failure");
  const value = success && structLayout(success)?.fields.find((f) => f.name === "value")?.type;
  const cause = failure && structLayout(failure)?.fields.find((f) => f.name === "cause")?.type;
  // Cause's own observer validates its complete structural witness.
  if (!value || !cause)
    throw fail("TYPE_MISMATCH", "authoring", "Exit", "Requires a Fail-only Exit witness");
  const binder = Symbol("reffect/exit/cause");
  const errorType = causeErrorType(Expr.parameter(cause as IRType<CauseValue<E>>, binder, 0));
  if (!IRType.same(self.type, exitType(value, errorType)))
    throw fail("TYPE_MISMATCH", "authoring", "Exit", "Requires a Fail-only Exit witness");
  return { success: value as IRType<A>, error: errorType as IRType<E> };
};
/** Effect Exit.succeed, with an explicit native error witness. */
const succeed = <A, E>(value: Expr<A>, error: IRType<E>): Expr<ExitValue<A, E>> =>
  exitType(value.type, error).cases.Success.make({ value });
/** Effect Exit.failCause, with an explicit native success witness. */
const failCause = <E, A>(cause: Expr<CauseValue<E>>, success: IRType<A>): Expr<ExitValue<A, E>> => {
  const error = causeErrorType(cause);
  return exitType(success, error).cases.Failure.make({ cause });
};
/** Effect Exit.fail, representing a singleton typed failure Cause. */
const failure = <E, A>(error: Expr<E>, success: IRType<A>): Expr<ExitValue<A, E>> =>
  failCause(CauseIR.fail(error), success);
type MatchOptions<A, E, B> = {
  readonly onSuccess: (value: Expr<A>) => Expr<B>;
  readonly onFailure: (cause: Expr<CauseValue<E>>) => Expr<NoInfer<B>>;
};
/** Effect Exit.match; both branches produce the same checked pure witness. */
const match: {
  <A, E, B>(options: MatchOptions<A, E, B>): (self: Expr<ExitValue<A, E>>) => Expr<B>;
  <A, E, B>(self: Expr<ExitValue<A, E>>, options: MatchOptions<A, E, B>): Expr<B>;
} = dual(2, <A, E, B>(self: Expr<ExitValue<A, E>>, options: MatchOptions<A, E, B>): Expr<B> => {
  channels(self);
  const result: Expr<B> = matchTags(self, {
    Success: (value) => options.onSuccess(Expr.get<A>(value, "value")),
    Failure: (value) => options.onFailure(Expr.get<CauseValue<E>>(value, "cause")),
  });
  if (!(result instanceof Expr))
    throw fail("TYPE_MISMATCH", "authoring", "Exit.match", "Handlers must return pure expressions");
  return result;
});
/** Effect Exit.map, preserving the complete failure Cause. */
const map: {
  <A, B>(f: (value: Expr<A>) => Expr<B>): <E>(self: Expr<ExitValue<A, E>>) => Expr<ExitValue<B, E>>;
  <A, E, B>(self: Expr<ExitValue<A, E>>, f: (value: Expr<A>) => Expr<B>): Expr<ExitValue<B, E>>;
} = dual(2, <A, E, B>(self: Expr<ExitValue<A, E>>, f: (value: Expr<A>) => Expr<B>) => {
  const types = channels(self);
  const binder = Symbol("reffect/exit/map");
  const body = f(Expr.parameter(types.success, binder, 0));
  return match(self, {
    onSuccess: (value) =>
      succeed(
        Expr.substitute(body, binder, () => value),
        types.error,
      ),
    onFailure: (cause) => failCause(cause, body.type),
  });
});
/** Effect Exit.mapBoth selects only the first error and rebuilds a singleton failure. */
const mapBoth: {
  <A, E, B, F>(options: {
    readonly onSuccess: (value: Expr<A>) => Expr<B>;
    readonly onFailure: (error: Expr<E>) => Expr<F>;
  }): (self: Expr<ExitValue<A, E>>) => Expr<ExitValue<B, F>>;
  <A, E, B, F>(
    self: Expr<ExitValue<A, E>>,
    options: {
      readonly onSuccess: (value: Expr<A>) => Expr<B>;
      readonly onFailure: (error: Expr<E>) => Expr<F>;
    },
  ): Expr<ExitValue<B, F>>;
} = dual(
  2,
  <A, E, B, F>(
    self: Expr<ExitValue<A, E>>,
    options: {
      readonly onSuccess: (value: Expr<A>) => Expr<B>;
      readonly onFailure: (error: Expr<E>) => Expr<F>;
    },
  ) => {
    const types = channels(self);
    const valueBinder = Symbol("reffect/exit/value");
    const errorBinder = Symbol("reffect/exit/error");
    const value = options.onSuccess(Expr.parameter(types.success, valueBinder, 0));
    const error = options.onFailure(Expr.parameter(types.error, errorBinder, 0));
    return match(self, {
      onSuccess: (v) =>
        succeed(
          Expr.substitute(value, valueBinder, () => v),
          error.type,
        ),
      onFailure: (cause) =>
        OptionIR.match(CauseIR.findErrorOption(cause), {
          onNone: () => failCause(CauseIR.empty(error.type), value.type),
          onSome: (e) =>
            failure(
              Expr.substitute(error, errorBinder, () => e),
              value.type,
            ),
        }),
    });
  },
);
/** Effect Exit.mapError preserves success and collapses a nonempty Cause to its first mapped error. */
const mapError: {
  <E, F>(f: (error: Expr<E>) => Expr<F>): <A>(self: Expr<ExitValue<A, E>>) => Expr<ExitValue<A, F>>;
  <A, E, F>(self: Expr<ExitValue<A, E>>, f: (error: Expr<E>) => Expr<F>): Expr<ExitValue<A, F>>;
} = dual(2, <A, E, F>(self: Expr<ExitValue<A, E>>, f: (error: Expr<E>) => Expr<F>) =>
  mapBoth(self, { onSuccess: (value) => value, onFailure: f }),
);
const isSuccess = <A, E>(self: Expr<ExitValue<A, E>>) =>
  match(self, {
    onSuccess: () => BoolType.literal(true),
    onFailure: () => BoolType.literal(false),
  });
const isFailure = <A, E>(self: Expr<ExitValue<A, E>>) => BoolType.not(isSuccess(self));
const hasFails = <A, E>(self: Expr<ExitValue<A, E>>) =>
  match(self, { onSuccess: () => BoolType.literal(false), onFailure: CauseIR.hasFails });
const absentReason = <A, E>(self: Expr<ExitValue<A, E>>) => {
  channels(self);
  return BoolType.literal(false);
};
const getSuccess = <A, E>(self: Expr<ExitValue<A, E>>) =>
  match(self, { onSuccess: OptionIR.some, onFailure: () => OptionIR.none(channels(self).success) });
const getCause = <A, E>(self: Expr<ExitValue<A, E>>) =>
  match(self, {
    onSuccess: () => OptionIR.none(CauseIR(channels(self).error)),
    onFailure: OptionIR.some,
  });
const findErrorOption = <A, E>(self: Expr<ExitValue<A, E>>) =>
  match(self, {
    onSuccess: () => OptionIR.none(channels(self).error),
    onFailure: CauseIR.findErrorOption,
  });
const asVoid = <A, E>(self: Expr<ExitValue<A, E>>) => map(self, () => UnitType.literal());

export const ExitIR = Object.freeze(
  Object.assign(exitType, {
    succeed,
    fail: failure,
    failCause,
    match,
    map,
    mapError,
    mapBoth,
    asVoid,
    isSuccess,
    isFailure,
    hasFails,
    hasDies: absentReason,
    hasInterrupts: absentReason,
    getSuccess,
    getCause,
    findErrorOption,
  }),
);
