import { dual } from "effect/Function";
import {
  BoolType,
  Expr,
  IRType,
  NeverType,
  U64Type,
  arrayItem,
  fail,
  structLayout,
} from "./kernel.ts";
import { ArrayIR, Struct, TaggedUnion } from "./records.ts";
import { OptionIR } from "./option.ts";
import type { OptionValue } from "./option.ts";
import { ResultIR } from "./result.ts";
import type { ResultValue } from "./result.ts";

/** The Fail-only data projection of Effect v4 Cause, without instance branding or annotations. */
export interface CauseValue<E> {
  readonly reasons: ReadonlyArray<FailReasonValue<E>>;
}
export interface FailReasonValue<E> {
  readonly _tag: "Fail";
  readonly error: E;
}
const reasonType = <E>(error: IRType<E>) => TaggedUnion({ Fail: { error } }).cases.Fail;
const causeType = <E>(error: IRType<E>): IRType<CauseValue<E>> =>
  Struct({ reasons: ArrayIR(reasonType(error)) });

export const causeErrorType = <E>(self: Expr<CauseValue<E>>): IRType<E> => {
  const layout = structLayout(self.type);
  const reasons = layout?.fields.find((field) => field.name === "reasons")?.type;
  const reason = reasons && arrayItem(reasons);
  // The canonical witness comparison below verifies the complete shape, not just this field.
  const error =
    reason && structLayout(reason)?.fields.find((field) => field.name === "error")?.type;
  if (!error || !IRType.same(self.type, causeType(error)))
    throw fail("TYPE_MISMATCH", "authoring", "Cause", "Requires a Fail-only Cause witness");
  return error as IRType<E>;
};
const reasons = <E>(self: Expr<CauseValue<E>>) => {
  const error = causeErrorType(self);
  return { error, value: Expr.get<CauseValue<E>["reasons"]>(self, "reasons") };
};
/** Effect Cause.empty, with an explicit native error witness. */
const empty = <E>(error: IRType<E>): Expr<CauseValue<E>> =>
  Struct({ reasons: ArrayIR(reasonType(error)) }).make({
    reasons: ArrayIR.empty(reasonType(error)),
  });
/** Effect Cause.makeFailReason, without upstream annotation/instance state. */
const makeFailReason = <E>(error: Expr<E>): Expr<FailReasonValue<E>> =>
  Expr.make(reasonType(error.type), undefined, [error]);
/** Effect Cause.fromReasons, retaining ordered Fail-only reasons and duplicates. */
const fromReasons = <E>(value: Expr<ReadonlyArray<FailReasonValue<E>>>): Expr<CauseValue<E>> => {
  const result = Struct({ reasons: value.type }).make({ reasons: value });
  causeErrorType(result);
  return result;
};
/** Effect Cause.fail, materializing one typed failure reason. */
const failure = <E>(error: Expr<E>): Expr<CauseValue<E>> =>
  fromReasons(ArrayIR.make(makeFailReason(error)));
/** Effect Cause.map: map all Fail reasons, preserving order and duplicates. */
const map: {
  <E, F>(f: (error: Expr<E>) => Expr<F>): (self: Expr<CauseValue<E>>) => Expr<CauseValue<F>>;
  <E, F>(self: Expr<CauseValue<E>>, f: (error: Expr<E>) => Expr<F>): Expr<CauseValue<F>>;
} = dual(2, <E, F>(self: Expr<CauseValue<E>>, f: (error: Expr<E>) => Expr<F>) => {
  const input = reasons(self);
  const values = ArrayIR.map(input.value, (reason) => {
    const error = f(Expr.get<E>(reason, "error"));
    return Expr.make(reasonType(error.type), undefined, [error]);
  });
  return Struct({ reasons: values.type }).make({ reasons: values });
});
/** Effect Cause.hasFails; every admitted reason is a typed failure. */
const hasFails = <E>(self: Expr<CauseValue<E>>): Expr<boolean> =>
  BoolType.not(U64Type.eq(ArrayIR.length(reasons(self).value), U64Type.literal(0n)));
const absentReason = <E>(self: Expr<CauseValue<E>>): Expr<boolean> => {
  causeErrorType(self);
  return BoolType.literal(false);
};
/** Effect Cause.findErrorOption, selecting the first reason without discarding its ordering. */
const findErrorOption = <E>(self: Expr<CauseValue<E>>): Expr<OptionValue<E>> => {
  const input = reasons(self);
  return ArrayIR.reduce(input.value, OptionIR.none(input.error), (found, reason, index) =>
    Expr.match(
      U64Type.eq(index, U64Type.literal(0n)),
      OptionIR.some(Expr.get<E>(reason, "error")),
      found,
    ),
  );
};
/** Effect Cause.findError: the empty failure has no remaining error channel. */
const findError = <E>(self: Expr<CauseValue<E>>): Expr<ResultValue<E, CauseValue<never>>> =>
  OptionIR.match(findErrorOption(self), {
    onNone: () => ResultIR.fail(empty(NeverType), causeErrorType(self)),
    onSome: (error) => ResultIR.succeed(error, causeType(NeverType)),
  });

export const CauseIR = Object.freeze(
  Object.assign(causeType, {
    empty,
    makeFailReason,
    fromReasons,
    fail: failure,
    map,
    hasFails,
    hasDies: absentReason,
    hasInterrupts: absentReason,
    hasInterruptsOnly: absentReason,
    findError,
    findErrorOption,
  }),
);
