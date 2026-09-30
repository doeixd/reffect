import { Effect, Match, Pipeable, Schema } from "effect";
import { dual } from "effect/Function";
import {
  BoolType,
  CompileError,
  Expr,
  IRType,
  NeverType,
  SemanticRef,
  checkExpression,
  evaluateExpression,
  fail,
} from "./kernel.ts";
import type { Diagnostic, Inputs, Symbols } from "./kernel.ts";

export const SyncEffects = Object.freeze({
  Succeed: SemanticRef.effect("reffect/effect/succeed@1"),
  Fail: SemanticRef.effect("reffect/effect/fail@1"),
  Map: SemanticRef.effect("reffect/effect/map@1"),
  FlatMap: SemanticRef.effect("reffect/effect/flatMap@1"),
  Match: SemanticRef.effect("reffect/effect/match-bool@1"),
});
export type ComputationNode =
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
    };

export class Computation<A, E = never> extends Pipeable.Class {
  private constructor(
    readonly output: IRType<A>,
    readonly error: IRType<E>,
    readonly node: ComputationNode,
  ) {
    super();
    Object.freeze(this);
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
const succeed = <A>(value: Expr<A>): Computation<A> =>
  Computation.make(value.type, NeverType, { _tag: "Succeed", value });
const failValue = <E>(error: Expr<E>): Computation<never, E> =>
  Computation.make(NeverType, error.type, { _tag: "Fail", error });
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
  ) {
    super();
    Object.freeze(this);
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
  ): Effect.Effect<unknown, unknown> =>
    Effect.suspend(() => {
      const expression = (e: Expr<unknown>) =>
        Effect.try({
          try: () => evaluateExpression(e, bindings),
          catch: (cause) => fail("REFERENCE_FAILURE", "reference", "expression", String(cause)),
        });
      return Match.value(c.node).pipe(
        Match.tagsExhaustive({
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
        }),
      );
    });
  return yield* evaluate(f.body, new Map([[f.binder, values]])) as Effect.Effect<
    A,
    E | CompileError
  >;
});
export const EffectReference = Object.freeze({
  runUnknown,
  run: <I extends readonly IRType<unknown>[], A, E>(f: EffectFn<I, A, E>, args: Inputs<I>) =>
    runUnknown(f, args),
});
export const EffectIR = Object.freeze({
  succeed,
  fail: failValue,
  map,
  flatMap,
  fn: EffectFn.make,
});
