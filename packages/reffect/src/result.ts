import { dual } from "effect/Function";
import { Computation, EffectIR } from "./effect-ir.ts";
import { catchAll } from "./error-recovery.ts";
import { BoolType, Expr, IRType, fail, structLayout, unionCases } from "./kernel.ts";
import { TaggedUnion, matchTags } from "./records.ts";

/** Plain Result data; upstream prototype/iterator branding is outside this profile. */
export type ResultValue<A, E> =
  | { readonly _tag: "Success"; readonly success: A }
  | { readonly _tag: "Failure"; readonly failure: E };
const resultType = <A, E>(success: IRType<A>, failure: IRType<E>) =>
  TaggedUnion({ Success: { success }, Failure: { failure } });
const channels = <A, E>(self: Expr<ResultValue<A, E>>) => {
  const cases = unionCases(self.type);
  const success = cases?.find((c) => structLayout(c)?.tag === "Success");
  const failure = cases?.find((c) => structLayout(c)?.tag === "Failure");
  const s = success && structLayout(success);
  const f = failure && structLayout(failure);
  if (
    cases?.length !== 2 ||
    s?.fields.length !== 1 ||
    f?.fields.length !== 1 ||
    s.fields[0].name !== "success" ||
    f.fields[0].name !== "failure" ||
    s.fields[0].optional !== undefined ||
    f.fields[0].optional !== undefined
  )
    throw fail(
      "TYPE_MISMATCH",
      "authoring",
      "Result",
      "Result requires Success/success and Failure/failure witnesses",
    );
  return {
    success: s.fields[0].type as IRType<A>,
    failure: f.fields[0].type as IRType<E>,
    successCase: success!,
    failureCase: failure!,
  };
};
const succeed = <A, E>(value: Expr<A>, error: IRType<E>): Expr<ResultValue<A, E>> =>
  resultType(value.type, error).cases.Success.make({ success: value });
const failure = <E, A>(error: Expr<E>, success: IRType<A>): Expr<ResultValue<A, E>> =>
  resultType(success, error.type).cases.Failure.make({ failure: error });
type Options<A, E, B> = {
  readonly onSuccess: (value: Expr<A>) => Expr<B>;
  readonly onFailure: (error: Expr<E>) => Expr<NoInfer<B>>;
};
const match: {
  <A, E, B>(options: Options<A, E, B>): (self: Expr<ResultValue<A, E>>) => Expr<B>;
  <A, E, B>(self: Expr<ResultValue<A, E>>, options: Options<A, E, B>): Expr<B>;
  <A, E, B, E1, C, E2>(options: {
    readonly onSuccess: (value: Expr<A>) => Computation<B, E1>;
    readonly onFailure: (error: Expr<E>) => Computation<C, E2>;
  }): (self: Expr<ResultValue<A, E>>) => Computation<B | C, E1 | E2>;
  <A, E, B, E1, C, E2>(
    self: Expr<ResultValue<A, E>>,
    options: {
      readonly onSuccess: (value: Expr<A>) => Computation<B, E1>;
      readonly onFailure: (error: Expr<E>) => Computation<C, E2>;
    },
  ): Computation<B | C, E1 | E2>;
} = dual(
  2,
  <A, E>(
    self: Expr<ResultValue<A, E>>,
    options: {
      readonly onSuccess: (value: Expr<A>) => Expr<unknown> | Computation<unknown, unknown>;
      readonly onFailure: (error: Expr<E>) => Expr<unknown> | Computation<unknown, unknown>;
    },
  ) => {
    channels(self);
    return matchTags(self, {
      Success: (value) => options.onSuccess(Expr.get<A>(value, "success")),
      Failure: (error) => options.onFailure(Expr.get<E>(error, "failure")),
    });
  },
);
const branch = <A, E>(self: Expr<ResultValue<A, E>>) => {
  const types = channels(self);
  const successBinder = Symbol("reffect/result/success");
  const failureBinder = Symbol("reffect/result/failure");
  return {
    ...types,
    successBinder,
    failureBinder,
    value: Expr.get<A>(Expr.parameter(types.successCase, successBinder, 0), "success"),
    error: Expr.get<E>(Expr.parameter(types.failureCase, failureBinder, 0), "failure"),
  };
};
const mappedBranches = <A, E, B, F>(
  self: Expr<ResultValue<A, E>>,
  b: ReturnType<typeof branch<A, E>>,
  value: Expr<B>,
  error: Expr<F>,
): Expr<ResultValue<B, F>> => {
  const output = resultType(value.type, error.type);
  return Expr.matchTags(self, output, [
    {
      tag: "Success",
      binder: b.successBinder,
      body: output.cases.Success.make({ success: value }),
    },
    {
      tag: "Failure",
      binder: b.failureBinder,
      body: output.cases.Failure.make({ failure: error }),
    },
  ]);
};
const map: {
  <A, B>(
    f: (value: Expr<A>) => Expr<B>,
  ): <E>(self: Expr<ResultValue<A, E>>) => Expr<ResultValue<B, E>>;
  <A, E, B>(self: Expr<ResultValue<A, E>>, f: (value: Expr<A>) => Expr<B>): Expr<ResultValue<B, E>>;
} = dual(2, <A, E, B>(self: Expr<ResultValue<A, E>>, f: (value: Expr<A>) => Expr<B>) => {
  const b = branch(self);
  return mappedBranches(self, b, f(b.value), b.error);
});
const mapError: {
  <E, F>(
    f: (error: Expr<E>) => Expr<F>,
  ): <A>(self: Expr<ResultValue<A, E>>) => Expr<ResultValue<A, F>>;
  <A, E, F>(self: Expr<ResultValue<A, E>>, f: (error: Expr<E>) => Expr<F>): Expr<ResultValue<A, F>>;
} = dual(2, <A, E, F>(self: Expr<ResultValue<A, E>>, f: (error: Expr<E>) => Expr<F>) => {
  const b = branch(self);
  return mappedBranches(self, b, b.value, f(b.error));
});
const flatMap: {
  <A, B, E>(
    f: (value: Expr<A>) => Expr<ResultValue<B, E>>,
  ): (self: Expr<ResultValue<A, E>>) => Expr<ResultValue<B, E>>;
  <A, E, B>(
    self: Expr<ResultValue<A, E>>,
    f: (value: Expr<A>) => Expr<ResultValue<B, NoInfer<E>>>,
  ): Expr<ResultValue<B, E>>;
} = dual(
  2,
  <A, E, B>(self: Expr<ResultValue<A, E>>, f: (value: Expr<A>) => Expr<ResultValue<B, E>>) => {
    const b = branch(self);
    const body = f(b.value);
    const next = channels(body);
    if (!IRType.same(b.failure, next.failure))
      throw fail(
        "TYPE_MISMATCH",
        "authoring",
        "Result.flatMap",
        "flatMap requires the same error witness; use mapError explicitly",
      );
    return Expr.matchTags(self, body.type, [
      { tag: "Success", binder: b.successBinder, body },
      { tag: "Failure", binder: b.failureBinder, body: Expr.make(body.type, "Failure", [b.error]) },
    ]);
  },
);
const isSuccess = <A, E>(self: Expr<ResultValue<A, E>>) =>
  match(self, {
    onSuccess: () => BoolType.literal(true),
    onFailure: () => BoolType.literal(false),
  });
const isFailure = <A, E>(self: Expr<ResultValue<A, E>>) => BoolType.not(isSuccess(self));
const getOrElse: {
  <E, A>(fallback: (error: Expr<E>) => Expr<A>): (self: Expr<ResultValue<A, E>>) => Expr<A>;
  <A, E>(self: Expr<ResultValue<A, E>>, fallback: (error: Expr<E>) => Expr<NoInfer<A>>): Expr<A>;
} = dual(2, <A, E>(self: Expr<ResultValue<A, E>>, fallback: (error: Expr<E>) => Expr<A>) =>
  match(self, { onSuccess: (value) => value, onFailure: fallback }),
);
const mapBoth: {
  <A, E, B, F>(options: {
    readonly onSuccess: (value: Expr<A>) => Expr<B>;
    readonly onFailure: (error: Expr<E>) => Expr<F>;
  }): (self: Expr<ResultValue<A, E>>) => Expr<ResultValue<B, F>>;
  <A, E, B, F>(
    self: Expr<ResultValue<A, E>>,
    options: {
      readonly onSuccess: (value: Expr<A>) => Expr<B>;
      readonly onFailure: (error: Expr<E>) => Expr<F>;
    },
  ): Expr<ResultValue<B, F>>;
} = dual(
  2,
  <A, E, B, F>(
    self: Expr<ResultValue<A, E>>,
    options: {
      readonly onSuccess: (value: Expr<A>) => Expr<B>;
      readonly onFailure: (error: Expr<E>) => Expr<F>;
    },
  ) => {
    const b = branch(self);
    return mappedBranches(self, b, options.onSuccess(b.value), options.onFailure(b.error));
  },
);
export const ResultIR = Object.freeze(
  Object.assign(resultType, {
    succeed,
    fail: failure,
    match,
    map,
    mapError,
    flatMap,
    mapBoth,
    getOrElse,
    isSuccess,
    isFailure,
  }),
);

/** Capture typed errors as plain Result data; defects and interruption bypass catchAll. */
export const effectResult = <A, E>(
  self: Computation<A, E>,
): Computation<ResultValue<A, E>, never> =>
  catchAll(
    EffectIR.map(self, (value) => succeed(value, self.error)),
    (error) => EffectIR.succeed(failure(error, self.output)),
  );
