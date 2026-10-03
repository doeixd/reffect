import { dual } from "effect/Function";
import { BoolType, Expr, IRType, NumberType, U64Type, arrayItem, fail } from "./kernel.ts";
import { ArrayIR, RecordIR } from "./records.ts";
import { OptionIR, type OptionValue } from "./option.ts";

/** Boolean conjunction expressed through lazy structured branching. */
const and: {
  (that: Expr<boolean>): (self: Expr<boolean>) => Expr<boolean>;
  (self: Expr<boolean>, that: Expr<boolean>): Expr<boolean>;
} = dual(2, (self: Expr<boolean>, that: Expr<boolean>) =>
  Expr.match(self, that, BoolType.literal(false)),
);
/** Boolean disjunction expressed through lazy structured branching. */
const or: {
  (that: Expr<boolean>): (self: Expr<boolean>) => Expr<boolean>;
  (self: Expr<boolean>, that: Expr<boolean>): Expr<boolean>;
} = dual(2, (self: Expr<boolean>, that: Expr<boolean>) =>
  Expr.match(self, BoolType.literal(true), that),
);
export const BooleanCombinators = Object.freeze({ and, or });

export type SymbolicPredicate<A> = (value: Expr<A>) => Expr<boolean>;
/** Combine symbolic predicates, preserving runtime short-circuiting. */
const predicateAnd: {
  <A>(that: SymbolicPredicate<A>): (self: SymbolicPredicate<A>) => SymbolicPredicate<A>;
  <A>(self: SymbolicPredicate<A>, that: SymbolicPredicate<A>): SymbolicPredicate<A>;
} = dual(
  2,
  <A>(self: SymbolicPredicate<A>, that: SymbolicPredicate<A>): SymbolicPredicate<A> =>
    (value) =>
      and(self(value), that(value)),
);
/** Combine symbolic predicates with disjunction. */
const predicateOr: typeof predicateAnd = dual(
  2,
  <A>(self: SymbolicPredicate<A>, that: SymbolicPredicate<A>): SymbolicPredicate<A> =>
    (value) =>
      or(self(value), that(value)),
);
/** Negate a predicate; the existing expression spelling remains supported. */
function predicateNot<A>(self: SymbolicPredicate<A>): SymbolicPredicate<A>;
function predicateNot(self: Expr<boolean>): Expr<boolean>;
function predicateNot<A>(
  self: SymbolicPredicate<A> | Expr<boolean>,
): SymbolicPredicate<A> | Expr<boolean> {
  return self instanceof Expr ? BoolType.not(self) : (value) => BoolType.not(self(value));
}
export const PredicateCombinators = Object.freeze({
  and: predicateAnd,
  or: predicateOr,
  not: predicateNot,
});

type ArrayPredicate<A> = (value: Expr<A>, index: Expr<bigint>) => Expr<boolean>;
/** Test whether an element matches; later predicates are skipped after a match. */
const some: {
  <A>(predicate: ArrayPredicate<A>): (self: Expr<ReadonlyArray<A>>) => Expr<boolean>;
  <A>(self: Expr<ReadonlyArray<A>>, predicate: ArrayPredicate<A>): Expr<boolean>;
} = dual(2, <A>(self: Expr<ReadonlyArray<A>>, predicate: ArrayPredicate<A>) =>
  ArrayIR.reduce(self, BoolType.literal(false), (found, value, index) =>
    or(found, predicate(value, index)),
  ),
);
/** Test whether all elements match, with true as the empty-array identity. */
const every: typeof some = dual(
  2,
  <A>(self: Expr<ReadonlyArray<A>>, predicate: ArrayPredicate<A>) =>
    ArrayIR.reduce(self, BoolType.literal(true), (valid, value, index) =>
      and(valid, predicate(value, index)),
    ),
);
/** Effect Array.isArrayEmpty, without a runtime refinement claim. */
const isArrayEmpty = <A>(self: Expr<ReadonlyArray<A>>): Expr<boolean> =>
  U64Type.eq(ArrayIR.length(self), U64Type.literal(0n));
/** Effect Array.isArrayNonEmpty, without a runtime refinement claim. */
const isArrayNonEmpty = <A>(self: Expr<ReadonlyArray<A>>): Expr<boolean> =>
  BoolType.not(isArrayEmpty(self));
/** First matching element, represented by the structural Option witness. */
const findFirst: {
  <A>(predicate: ArrayPredicate<A>): (self: Expr<ReadonlyArray<A>>) => Expr<OptionValue<A>>;
  <A>(self: Expr<ReadonlyArray<A>>, predicate: ArrayPredicate<A>): Expr<OptionValue<A>>;
} = dual(
  2,
  <A>(self: Expr<ReadonlyArray<A>>, predicate: ArrayPredicate<A>): Expr<OptionValue<A>> => {
    const item = arrayItem(self.type);
    if (!item)
      throw fail("TYPE_MISMATCH", "authoring", "Array.findFirst", "findFirst requires an array");
    // The source Expr's checked array witness supplies the element type.
    return ArrayIR.reduce(self, OptionIR.none(item as IRType<A>), (found, value, index) =>
      OptionIR.match(found, {
        onNone: () => Expr.match(predicate(value, index), OptionIR.some(value), found),
        onSome: () => found,
      }),
    );
  },
);
export const ArrayCombinators = Object.freeze({
  some,
  every,
  findFirst,
  isArrayEmpty,
  isReadonlyArrayEmpty: isArrayEmpty,
  isArrayNonEmpty,
  isReadonlyArrayNonEmpty: isArrayNonEmpty,
});

/** Effect Record.isEmptyRecord over string-keyed, own-property records. */
const isEmptyRecord = <A>(self: Expr<Readonly<Record<string, A>>>): Expr<boolean> =>
  NumberType.eq(RecordIR.size(self), NumberType.literal(0));
export const RecordCombinators = Object.freeze({ isEmptyRecord });
