import { Expr, Fn, IRType, fail } from "./kernel.ts";
import type { AnyFn } from "./kernel.ts";
import { Computation, EffectFn, EffectIR, joinType, substituteComputation } from "./effect-ir.ts";

type InputsOf<F> =
  F extends Fn<infer I, infer _A>
    ? I
    : F extends EffectFn<infer I, infer _A, infer _E>
      ? I
      : readonly IRType<unknown>[];
type OutputOf<F> =
  F extends Fn<infer _I, infer A> ? A : F extends EffectFn<infer _I, infer A, infer _E> ? A : never;
type ErrorOf<F> = F extends EffectFn<infer _I, infer _A, infer E> ? E : never;
type IsEffectFn<F> = F extends EffectFn<infer _I, infer _A, infer _E> ? true : false;
type Last<Fs extends readonly AnyFn[]> = Fs extends readonly [...infer _Rest, infer L extends AnyFn]
  ? L
  : never;
type HasEffect<Fs extends readonly AnyFn[]> = true extends {
  [K in keyof Fs]: IsEffectFn<Fs[K]>;
}[number]
  ? true
  : false;
type ErrorsOf<Fs extends readonly AnyFn[]> = { [K in keyof Fs]: ErrorOf<Fs[K]> }[number];

/** Effect v4-shaped result of `R.flow`: a `Fn` when every component is pure, else an `EffectFn`. */
export type FlowResult<Fs extends readonly AnyFn[]> = Fs extends readonly [infer F extends AnyFn]
  ? F
  : HasEffect<Fs> extends true
    ? EffectFn<InputsOf<Fs[0]>, OutputOf<Last<Fs>>, ErrorsOf<Fs>>
    : Fn<InputsOf<Fs[0]>, OutputOf<Last<Fs>>>;

interface PureIntermediate {
  readonly kind: "pure";
  readonly inputs: readonly IRType<unknown>[];
  readonly output: IRType<unknown>;
  readonly binder: symbol;
  readonly body: Expr<unknown>;
}
interface EffectIntermediate {
  readonly kind: "effect";
  readonly inputs: readonly IRType<unknown>[];
  readonly output: IRType<unknown>;
  readonly error: IRType<unknown>;
  readonly binder: symbol;
  readonly body: Computation<unknown, unknown>;
}
type Intermediate = PureIntermediate | EffectIntermediate;

const asIntermediate = (fn: AnyFn): Intermediate =>
  fn instanceof Fn
    ? {
        kind: "pure",
        inputs: fn.input,
        output: fn.output,
        binder: fn.binder,
        body: fn.body,
      }
    : {
        kind: "effect",
        inputs: fn.input,
        output: fn.output,
        error: fn.error,
        binder: fn.binder,
        body: fn.body,
      };
const replaceFirst =
  (value: Expr<unknown>) =>
  (index: number): Expr<unknown> | undefined =>
    index === 0 ? value : undefined;
const compose = (prev: Intermediate, next: AnyFn): Intermediate => {
  if (next.input.length !== 1)
    throw fail(
      "ARITY_MISMATCH",
      "authoring",
      "flow",
      "Every function after the first must take exactly one input",
    );
  if (!IRType.same(prev.output, next.input[0]))
    throw fail(
      "TYPE_MISMATCH",
      "authoring",
      "flow",
      "A composed function's output must match the next function's input",
    );
  if (next instanceof Fn) {
    if (prev.kind === "pure")
      return {
        kind: "pure",
        inputs: prev.inputs,
        output: next.output,
        binder: prev.binder,
        body: Expr.substitute(next.body, next.binder, replaceFirst(prev.body)),
      };
    return {
      kind: "effect",
      inputs: prev.inputs,
      output: next.output,
      error: prev.error,
      binder: prev.binder,
      body: EffectIR.map(prev.body, (value) =>
        Expr.substitute(next.body, next.binder, replaceFirst(value)),
      ),
    };
  }
  if (prev.kind === "pure")
    return {
      kind: "effect",
      inputs: prev.inputs,
      output: next.output,
      error: next.error,
      binder: prev.binder,
      body: substituteComputation(next.body, next.binder, replaceFirst(prev.body)),
    };
  return {
    kind: "effect",
    inputs: prev.inputs,
    output: next.output,
    error: joinType(prev.error, next.error),
    binder: prev.binder,
    body: EffectIR.flatMap(prev.body, (value) =>
      substituteComputation(next.body, next.binder, replaceFirst(value)),
    ),
  };
};
const finalize = (value: Intermediate): AnyFn =>
  value.kind === "pure"
    ? Fn.make(value.inputs, value.output, (...args) =>
        Expr.substitute(value.body, value.binder, (index) => args[index]),
      )
    : EffectFn.make(value.inputs, value.output, value.error, (...args) =>
        substituteComputation(value.body, value.binder, (index) => args[index]),
      );
const flowImpl = (...fns: readonly unknown[]): AnyFn => {
  if (fns.length === 0)
    throw fail("ARITY_MISMATCH", "authoring", "flow", "flow requires at least one function");
  const parts = fns.map((fn) => {
    if (!(fn instanceof Fn || fn instanceof EffectFn))
      throw fail(
        "TYPE_MISMATCH",
        "authoring",
        "flow",
        "flow composes Fn and EffectFn values; import flow from effect for plain functions",
      );
    return fn;
  });
  if (parts.length === 1) return parts[0];
  let intermediate = asIntermediate(parts[0]);
  for (let index = 1; index < parts.length; index++)
    intermediate = compose(intermediate, parts[index]);
  return finalize(intermediate);
};

/**
 * Composes `Fn`/`EffectFn` values left-to-right, mirroring the arity rules of
 * Effect v4 `flow`: the first function may take any number of inputs and every
 * later function must be unary. The result is a `Fn` when all components are
 * pure, otherwise an `EffectFn` whose error channel follows `joinType`
 * (Never or an identical witness). Plain function composition is Effect's `flow`.
 */
export const flow = flowImpl as <const Fs extends readonly AnyFn[]>(...fns: Fs) => FlowResult<Fs>;
