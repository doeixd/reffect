import { dual } from "effect/Function";
import { Computation, joinType } from "./effect-ir.ts";
import { Expr, NeverType } from "./kernel.ts";
import type { IRType } from "./kernel.ts";

/** Recover the declared error channel; interruption and compiler failures bypass recovery. */
export const catchAll: {
  <E, B, E2>(
    build: (error: Expr<E>) => Computation<B, E2>,
  ): <A>(self: Computation<A, E>) => Computation<A | B, E2>;
  <A, E, B, E2>(
    self: Computation<A, E>,
    build: (error: Expr<E>) => Computation<B, E2>,
  ): Computation<A | B, E2>;
} = dual(
  2,
  <A, E, B, E2>(self: Computation<A, E>, build: (error: Expr<E>) => Computation<B, E2>) => {
    const binder = Symbol("reffect/catchAll");
    const body = build(Expr.parameter(self.error, binder, 0));
    return Computation.make(joinType(self.output, body.output) as IRType<A | B>, body.error, {
      _tag: "CatchAll",
      source: self,
      binder,
      body,
    });
  },
);

/** Transform typed errors without changing the successful result channel. */
export const mapError: {
  <E, E2>(build: (error: Expr<E>) => Expr<E2>): <A>(self: Computation<A, E>) => Computation<A, E2>;
  <A, E, E2>(self: Computation<A, E>, build: (error: Expr<E>) => Expr<E2>): Computation<A, E2>;
} = dual(2, <A, E, E2>(self: Computation<A, E>, build: (error: Expr<E>) => Expr<E2>) =>
  catchAll(self, (error) => {
    const mapped = build(error);
    return Computation.make<never, E2>(NeverType, mapped.type, { _tag: "Fail", error: mapped });
  }),
);

/** Evaluate the fallback only if the source fails with a typed error. */
export const orElse: {
  <B, E2>(fallback: Computation<B, E2>): <A, E>(self: Computation<A, E>) => Computation<A | B, E2>;
  <A, E, B, E2>(self: Computation<A, E>, fallback: Computation<B, E2>): Computation<A | B, E2>;
} = dual(2, <A, E, B, E2>(self: Computation<A, E>, fallback: Computation<B, E2>) =>
  catchAll(self, () => fallback),
);
