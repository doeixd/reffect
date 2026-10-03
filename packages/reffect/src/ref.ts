import { Match } from "effect";
import type { Ref } from "effect";
import { dual } from "effect/Function";
import { Computation } from "./effect-ir.ts";
import { Expr, IRType, NeverType, UnitType, fail } from "./kernel.ts";
import { refContent, refScalar, refType } from "./ref-model.ts";

const handle = <A>(self: Expr<Ref.Ref<A>>) => {
  const content = refContent(self.type);
  const parameter = Match.value(self.node).pipe(
    Match.tag("Parameter", (node) => node),
    Match.orElse(() => undefined),
  );
  if (!content || !parameter || parameter.index !== 0)
    throw fail("RESOURCE_ESCAPE", "authoring", "Ref", "Ref operations require a lexical handle");
  return { content: content as IRType<A>, binder: parameter.binder };
};
/** Allocates a fresh scalar cell when executed; consume through Effect.flatMap. */
const make = <A>(initial: Expr<A>): Computation<Ref.Ref<A>> => {
  if (!refScalar(initial.type))
    throw fail(
      "UNSUPPORTED_REPRESENTATION",
      "authoring",
      "Ref.make",
      "Ref contents require Bool, U64 or Unit",
    );
  return Computation.make(refType(initial.type), NeverType, { _tag: "RefMake", initial });
};
/** Reads the current scalar snapshot as an ordered effect. */
const get = <A>(self: Expr<Ref.Ref<A>>): Computation<A> => {
  const { content, binder } = handle(self);
  return Computation.make(content, NeverType, { _tag: "RefGet", binder, content });
};
/** Atomically computes [result, nextValue] from one snapshot; callback expressions are pure. */
const modify: {
  <A, B>(
    f: (value: Expr<A>) => readonly [Expr<B>, Expr<NoInfer<A>>],
  ): (self: Expr<Ref.Ref<A>>) => Computation<B>;
  <A, B>(
    self: Expr<Ref.Ref<A>>,
    f: (value: Expr<A>) => readonly [Expr<B>, Expr<NoInfer<A>>],
  ): Computation<B>;
} = dual(
  2,
  <A, B>(self: Expr<Ref.Ref<A>>, f: (value: Expr<A>) => readonly [Expr<B>, Expr<NoInfer<A>>]) => {
    const { content, binder: ref } = handle(self);
    const binder = Symbol("reffect/ref-snapshot");
    const [result, next] = f(Expr.parameter(content, binder, 0));
    if (!(result instanceof Expr) || !(next instanceof Expr) || !IRType.same(content, next.type))
      throw fail(
        "TYPE_MISMATCH",
        "authoring",
        "Ref.modify",
        "Ref.modify requires pure result and matching next-value expressions",
      );
    return Computation.make(result.type, NeverType, {
      _tag: "RefModify",
      ref,
      content,
      binder,
      result,
      next,
    });
  },
);
/** Writes a scalar value and returns Unit. */
const set: {
  <A>(value: Expr<A>): (self: Expr<Ref.Ref<NoInfer<A>>>) => Computation<void>;
  <A>(self: Expr<Ref.Ref<A>>, value: Expr<NoInfer<A>>): Computation<void>;
} = dual(2, <A>(self: Expr<Ref.Ref<A>>, value: Expr<NoInfer<A>>) =>
  modify(self, () => [UnitType.literal(), value]),
);
/** Atomically updates a scalar value without suspending. */
const update: {
  <A>(f: (value: Expr<A>) => Expr<NoInfer<A>>): (self: Expr<Ref.Ref<A>>) => Computation<void>;
  <A>(self: Expr<Ref.Ref<A>>, f: (value: Expr<A>) => Expr<NoInfer<A>>): Computation<void>;
} = dual(2, <A>(self: Expr<Ref.Ref<A>>, f: (value: Expr<A>) => Expr<NoInfer<A>>) =>
  modify(self, (value) => [UnitType.literal(), f(value)]),
);
export const RefIR = Object.freeze({ make, get, set, update, modify });
