import { dual } from "effect/Function";
import { Computation, EffectIR, matchComputation } from "./effect-ir.ts";
import { catchAll } from "./error-recovery.ts";
import { Expr, UnitType } from "./kernel.ts";
import { effectResult, ResultIR } from "./result.ts";

/** Pinned Effect v4 spelling for typed error recovery. */
export { catchAll as catch };

/** Replace a successful value with a checked expression. */
export const as: {
  <B>(value: Expr<B>): <A, E>(self: Computation<A, E>) => Computation<B, E>;
  <A, E, B>(self: Computation<A, E>, value: Expr<B>): Computation<B, E>;
} = dual(2, <A, E, B>(self: Computation<A, E>, value: Expr<B>) => EffectIR.map(self, () => value));

/** Discard the successful value while preserving errors and interruption. */
export const asVoid = <A, E>(self: Computation<A, E>): Computation<void, E> =>
  as(self, UnitType.literal());

/** Run a checked effect after success, preserving the original successful value. */
export const tap: {
  <A, B, E2>(
    build: (value: Expr<A>) => Computation<B, E2>,
  ): <E>(self: Computation<A, E>) => Computation<A, E | E2>;
  <B, E2>(next: Computation<B, E2>): <A, E>(self: Computation<A, E>) => Computation<A, E | E2>;
  <A, E, B, E2>(
    self: Computation<A, E>,
    build: (value: Expr<A>) => Computation<B, E2>,
  ): Computation<A, E | E2>;
  <A, E, B, E2>(self: Computation<A, E>, next: Computation<B, E2>): Computation<A, E | E2>;
} = dual(
  2,
  <A, E, B, E2>(
    self: Computation<A, E>,
    next: Computation<B, E2> | ((value: Expr<A>) => Computation<B, E2>),
  ) =>
    EffectIR.flatMap(self, (value) => as(typeof next === "function" ? next(value) : next, value)),
);

/** Recover only errors satisfying a symbolic Boolean predicate. */
export const catchIf: {
  <E, B, E2>(
    predicate: (error: Expr<E>) => Expr<boolean>,
    build: (error: Expr<E>) => Computation<B, E2>,
  ): <A>(self: Computation<A, E>) => Computation<A | B, E | E2>;
  <A, E, B, E2>(
    self: Computation<A, E>,
    predicate: (error: Expr<E>) => Expr<boolean>,
    build: (error: Expr<E>) => Computation<B, E2>,
  ): Computation<A | B, E | E2>;
} = dual(
  3,
  <A, E, B, E2>(
    self: Computation<A, E>,
    predicate: (error: Expr<E>) => Expr<boolean>,
    build: (error: Expr<E>) => Computation<B, E2>,
  ) =>
    catchAll(self, (error) =>
      matchComputation(predicate(error), build(error), EffectIR.fail(error)),
    ),
);

/** Handle the source's success or typed failure without catching either handler's errors. */
export const matchEffect: {
  <A, E, B, E1, C, E2>(options: {
    readonly onSuccess: (value: Expr<A>) => Computation<B, E1>;
    readonly onFailure: (error: Expr<E>) => Computation<C, E2>;
  }): (self: Computation<A, E>) => Computation<B | C, E1 | E2>;
  <A, E, B, E1, C, E2>(
    self: Computation<A, E>,
    options: {
      readonly onSuccess: (value: Expr<A>) => Computation<B, E1>;
      readonly onFailure: (error: Expr<E>) => Computation<C, E2>;
    },
  ): Computation<B | C, E1 | E2>;
} = dual(
  2,
  <A, E, B, E1, C, E2>(
    self: Computation<A, E>,
    options: {
      readonly onSuccess: (value: Expr<A>) => Computation<B, E1>;
      readonly onFailure: (error: Expr<E>) => Computation<C, E2>;
    },
  ) => EffectIR.flatMap(effectResult(self), (result) => ResultIR.match(result, options)),
);

export const EffectCombinators = Object.freeze({
  catch: catchAll,
  as,
  asVoid,
  tap,
  catchIf,
  matchEffect,
});
