import { dual } from "effect/Function";
import {
  BoolType,
  Expr,
  IRType,
  UnitType,
  fail,
  structLayout,
  unionCases,
  undefinedOrItem,
} from "./kernel.ts";
import { TaggedUnionType, UndefinedOr, matchTags } from "./records.ts";

/** The readonly tagged-data projection of Effect Option; no instance brand or methods. */
export type OptionValue<A> =
  | { readonly _tag: "None" }
  | { readonly _tag: "Some"; readonly value: A };
export type OptionType<A> = TaggedUnionType<{
  readonly None: {};
  readonly Some: { readonly value: IRType<A> };
}>;

const optionType = <A>(item: IRType<A>): OptionType<A> =>
  TaggedUnionType.of({ None: {}, Some: { value: item } });
const itemType = <A>(self: Expr<OptionValue<A>>, operation: string): IRType<A> => {
  const members = unionCases(self.type);
  const some = members?.find((member) => structLayout(member)?.tag === "Some");
  const item = some && structLayout(some)?.fields.find((field) => field.name === "value")?.type;
  if (!item || !IRType.same(self.type, optionType(item)))
    throw fail("TYPE_MISMATCH", "authoring", `Option.${operation}`, "Requires an Option witness");
  return item as IRType<A>;
};
/** Effect `Option.some(value)`, inferring the payload witness from the expression. */
const some = <A>(value: Expr<A>): Expr<OptionValue<A>> =>
  optionType(value.type).cases.Some.make({ value });
/** Effect `Option.none()`, with an explicit payload witness for native representation. */
const none = <A>(item: IRType<A>): Expr<OptionValue<A>> => optionType(item).cases.None.make({});

type MatchOptions<A, B> = {
  readonly onNone: () => Expr<B>;
  readonly onSome: (value: Expr<A>) => Expr<NoInfer<B>>;
};
/** Effect `Option.match`, with pure branches sharing one representable result witness. */
const match: {
  <A, B>(options: MatchOptions<A, B>): (self: Expr<OptionValue<A>>) => Expr<B>;
  <A, B>(self: Expr<OptionValue<A>>, options: MatchOptions<A, B>): Expr<B>;
} = dual(2, <A, B>(self: Expr<OptionValue<A>>, options: MatchOptions<A, B>): Expr<B> => {
  itemType(self, "match");
  return matchTags(self, {
    None: () => {
      const result = options.onNone();
      if (!(result instanceof Expr))
        throw fail(
          "TYPE_MISMATCH",
          "authoring",
          "Option.match",
          "Handlers must return pure expressions",
        );
      return result;
    },
    Some: (value) => {
      const result = options.onSome(Expr.get<A>(value, "value"));
      if (!(result instanceof Expr))
        throw fail(
          "TYPE_MISMATCH",
          "authoring",
          "Option.match",
          "Handlers must return pure expressions",
        );
      return result;
    },
  });
});
/** Effect `Option.map`: preserve None and transform Some. */
const map: {
  <A, B>(f: (value: Expr<A>) => Expr<B>): (self: Expr<OptionValue<A>>) => Expr<OptionValue<B>>;
  <A, B>(self: Expr<OptionValue<A>>, f: (value: Expr<A>) => Expr<B>): Expr<OptionValue<B>>;
} = dual(
  2,
  <A, B>(self: Expr<OptionValue<A>>, f: (value: Expr<A>) => Expr<B>): Expr<OptionValue<B>> => {
    const item = itemType(self, "map");
    const binder = Symbol("reffect/option/map");
    const body = f(Expr.parameter(item, binder, 0));
    // Reuse the symbolic body through substitution, so authoring invokes f exactly once.
    return match(self, {
      onNone: () => none(body.type),
      onSome: (value) => some(Expr.substitute(body, binder, () => value)),
    });
  },
);
/** Effect `Option.flatMap`, requiring an Option-valued callback. */
const flatMap: {
  <A, B>(
    f: (value: Expr<A>) => Expr<OptionValue<B>>,
  ): (self: Expr<OptionValue<A>>) => Expr<OptionValue<B>>;
  <A, B>(
    self: Expr<OptionValue<A>>,
    f: (value: Expr<A>) => Expr<OptionValue<B>>,
  ): Expr<OptionValue<B>>;
} = dual(
  2,
  <A, B>(
    self: Expr<OptionValue<A>>,
    f: (value: Expr<A>) => Expr<OptionValue<B>>,
  ): Expr<OptionValue<B>> => {
    const item = itemType(self, "flatMap");
    const binder = Symbol("reffect/option/flatMap");
    const body = f(Expr.parameter(item, binder, 0));
    const output = itemType(body, "flatMap");
    return match(self, {
      onNone: () => none(output),
      onSome: (value) => Expr.substitute(body, binder, () => value),
    });
  },
);
/** Effect `Option.getOrElse`, with a fallback sharing the payload witness. */
const getOrElse: {
  <A>(onNone: () => Expr<A>): (self: Expr<OptionValue<A>>) => Expr<A>;
  <A>(self: Expr<OptionValue<A>>, onNone: () => Expr<NoInfer<A>>): Expr<A>;
} = dual(2, <A>(self: Expr<OptionValue<A>>, onNone: () => Expr<A>): Expr<A> =>
  match(self, { onNone, onSome: (value) => value }),
);
/** Effect `Option.orElse`, with a fallback Option sharing the payload witness. */
const orElse: {
  <A>(onNone: () => Expr<OptionValue<A>>): (self: Expr<OptionValue<A>>) => Expr<OptionValue<A>>;
  <A>(
    self: Expr<OptionValue<A>>,
    onNone: () => Expr<OptionValue<NoInfer<A>>>,
  ): Expr<OptionValue<A>>;
} = dual(
  2,
  <A>(self: Expr<OptionValue<A>>, onNone: () => Expr<OptionValue<A>>): Expr<OptionValue<A>> =>
    match(self, { onNone, onSome: some }),
);
/** Effect `Option.isNone`, as a compiled Boolean expression. */
const isNone = <A>(self: Expr<OptionValue<A>>): Expr<boolean> =>
  match(self, { onNone: () => BoolType.literal(true), onSome: () => BoolType.literal(false) });
/** Effect `Option.isSome`, as a compiled Boolean expression. */
const isSome = <A>(self: Expr<OptionValue<A>>): Expr<boolean> => BoolType.not(isNone(self));
/** Effect `Option.filter`, retaining only a Some whose predicate holds. */
const filter: {
  <A>(
    predicate: (value: Expr<A>) => Expr<boolean>,
  ): (self: Expr<OptionValue<A>>) => Expr<OptionValue<A>>;
  <A>(
    self: Expr<OptionValue<A>>,
    predicate: (value: Expr<A>) => Expr<boolean>,
  ): Expr<OptionValue<A>>;
} = dual(
  2,
  <A>(
    self: Expr<OptionValue<A>>,
    predicate: (value: Expr<A>) => Expr<boolean>,
  ): Expr<OptionValue<A>> => {
    const item = itemType(self, "filter");
    return match(self, {
      onNone: () => none(item),
      onSome: (value) => Expr.match(predicate(value), some(value), none(item)),
    });
  },
);
/** Effect `Option.exists`, false for None. */
const exists: {
  <A>(predicate: (value: Expr<A>) => Expr<boolean>): (self: Expr<OptionValue<A>>) => Expr<boolean>;
  <A>(self: Expr<OptionValue<A>>, predicate: (value: Expr<A>) => Expr<boolean>): Expr<boolean>;
} = dual(
  2,
  <A>(self: Expr<OptionValue<A>>, predicate: (value: Expr<A>) => Expr<boolean>): Expr<boolean> =>
    match(self, { onNone: () => BoolType.literal(false), onSome: predicate }),
);
/** Effect `Option.as`: replace a present payload. */
const as: {
  <B>(value: Expr<B>): <A>(self: Expr<OptionValue<A>>) => Expr<OptionValue<B>>;
  <A, B>(self: Expr<OptionValue<A>>, value: Expr<B>): Expr<OptionValue<B>>;
} = dual(2, <A, B>(self: Expr<OptionValue<A>>, value: Expr<B>) => map(self, () => value));
/** Effect `Option.asVoid`: preserve presence with a Unit payload. */
const asVoid = <A>(self: Expr<OptionValue<A>>): Expr<OptionValue<void>> =>
  as(self, Expr.literal(UnitType, undefined));
/** Effect `Option.flatten`: remove one optional layer without losing Some(None). */
const flatten = <A>(self: Expr<OptionValue<OptionValue<A>>>): Expr<OptionValue<A>> =>
  flatMap(self, (value) => value);
/** Effect `Option.fromUndefinedOr`, preserving only defined payloads. */
const fromUndefinedOr = <A>(self: Expr<A | undefined>): Expr<OptionValue<A>> => {
  const item = undefinedOrItem(self.type);
  if (!item)
    throw fail("TYPE_MISMATCH", "authoring", "Option.fromUndefinedOr", "Requires UndefinedOr");
  return UndefinedOr.match(self, { onUndefined: () => none(item as IRType<A>), onDefined: some });
};
/** Effect `Option.getOrUndefined`; payload witnesses must exclude undefined. */
const getOrUndefined = <A>(self: Expr<OptionValue<A>>): Expr<A | undefined> => {
  const output = UndefinedOr(itemType(self, "getOrUndefined"));
  return match(self, {
    onNone: () => Expr.undefined(output),
    onSome: (value) => Expr.defined(output, value),
  });
};
/** Effect `Option.zipRight`: require both Options, keeping the right payload. */
const zipRight: {
  <B>(that: Expr<OptionValue<B>>): <A>(self: Expr<OptionValue<A>>) => Expr<OptionValue<B>>;
  <A, B>(self: Expr<OptionValue<A>>, that: Expr<OptionValue<B>>): Expr<OptionValue<B>>;
} = dual(2, <A, B>(self: Expr<OptionValue<A>>, that: Expr<OptionValue<B>>) =>
  flatMap(self, () => that),
);
/** Effect `Option.zipLeft`: require both Options, keeping the left payload. */
const zipLeft: {
  <B>(that: Expr<OptionValue<B>>): <A>(self: Expr<OptionValue<A>>) => Expr<OptionValue<A>>;
  <A, B>(self: Expr<OptionValue<A>>, that: Expr<OptionValue<B>>): Expr<OptionValue<A>>;
} = dual(2, <A, B>(self: Expr<OptionValue<A>>, that: Expr<OptionValue<B>>) =>
  flatMap(self, (value) => as(that, value)),
);
/** Effect `Option.tap`: require callback presence while retaining the original payload. */
const tap: {
  <A, B>(
    f: (value: Expr<A>) => Expr<OptionValue<B>>,
  ): (self: Expr<OptionValue<A>>) => Expr<OptionValue<A>>;
  <A, B>(
    self: Expr<OptionValue<A>>,
    f: (value: Expr<A>) => Expr<OptionValue<B>>,
  ): Expr<OptionValue<A>>;
} = dual(2, <A, B>(self: Expr<OptionValue<A>>, f: (value: Expr<A>) => Expr<OptionValue<B>>) =>
  flatMap(self, (value) => as(f(value), value)),
);
/** Callable Option witness factory and bounded, pipeable Effect Option combinators. */
export const OptionIR = Object.freeze(
  Object.assign(optionType, {
    some,
    none,
    match,
    map,
    flatMap,
    getOrElse,
    orElse,
    isNone,
    isSome,
    filter,
    exists,
    as,
    asVoid,
    flatten,
    fromUndefinedOr,
    getOrUndefined,
    zipRight,
    zipLeft,
    tap,
    filterMap: flatMap,
  }),
);
