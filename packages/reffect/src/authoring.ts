import { Source } from "./source.ts";
import { Fn, Program, Expr, BoolType, U64Type, UnitType, NeverType } from "./kernel.ts";
import type { IRType, Symbols } from "./kernel.ts";
import { Computation, EffectFn, EffectIR, LogIR, matchComputation } from "./effect-ir.ts";
import { catchAll, mapError, orElse } from "./error-recovery.ts";
import { ContextIR } from "./context.ts";
import { LayerIR } from "./layer.ts";

function fn<const I extends readonly IRType<unknown>[], A>(
  input: I,
  output: IRType<A>,
  build: (...args: Symbols<I>) => Expr<A>,
): Fn<I, A>;
function fn<const I extends readonly IRType<unknown>[], A, E>(
  input: I,
  output: IRType<A>,
  error: IRType<E>,
  build: (...args: Symbols<I>) => Computation<NoInfer<A>, NoInfer<E>>,
): EffectFn<I, A, E>;
function fn(
  input: readonly IRType<unknown>[],
  output: IRType<unknown>,
  errorOrBuild: IRType<unknown> | ((...args: Expr<unknown>[]) => Expr<unknown>),
  build?: (...args: Expr<unknown>[]) => Computation<unknown, unknown>,
): Fn | EffectFn {
  return typeof errorOrBuild === "function"
    ? Fn.make(input, output, errorOrBuild)
    : EffectFn.make(input, output, errorOrBuild, build!);
}
function bool<A>(condition: Expr<boolean>, onTrue: Expr<A>, onFalse: Expr<NoInfer<A>>): Expr<A>;
function bool<A, E, B, E2>(
  condition: Expr<boolean>,
  onTrue: Computation<A, E>,
  onFalse: Computation<B, E2>,
): Computation<A | B, E | E2>;
function bool(
  condition: Expr<boolean>,
  onTrue: Expr<unknown> | Computation<unknown, unknown>,
  onFalse: Expr<unknown> | Computation<unknown, unknown>,
): Expr<unknown> | Computation<unknown, unknown> {
  if (onTrue instanceof Expr && onFalse instanceof Expr)
    return Expr.match(condition, onTrue, onFalse);
  if (onTrue instanceof Computation && onFalse instanceof Computation)
    return matchComputation(condition, onTrue, onFalse);
  throw new TypeError("Match branches must both be pure expressions or both be computations");
}
export const R = Object.freeze({
  fn,
  Source,
  program: Program.make,
  literal: Expr.literal,
  U64: U64Type,
  Bool: BoolType,
  Unit: UnitType,
  Never: NeverType,
  Match: Object.freeze({ bool }),
  Predicate: Object.freeze({
    not: BoolType.not,
    eqU64: U64Type.eq,
    ltU64: U64Type.lt,
    eqBool: BoolType.eq,
  }),
  Effect: Object.freeze({ ...EffectIR, catchAll, mapError, orElse }),
  Log: LogIR,
  Context: ContextIR,
  Layer: LayerIR,
});
