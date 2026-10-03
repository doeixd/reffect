/**
 * `R.Stream`: the first finite Stream subset (STREAM-005), spelled as Effect v4 spells it. Sources
 * and operators build a `StreamIR`; `runCollect` consumes it as an Effect.
 */
import { Match } from "effect";
import { dual } from "effect/Function";
import type { Schedule } from "./schedule.ts";
import { Computation, EffectFn, joinType, streamEmit, streamRunCollect } from "./effect-ir.ts";
import { SchemaIR } from "./schema-json.ts";
import {
  BoolType,
  Expr,
  IRType,
  NeverType,
  NumberType,
  UnitType,
  arrayItem,
  fail,
} from "./kernel.ts";
import type { Symbols } from "./kernel.ts";
import { ArrayType } from "./records.ts";
import { StreamIR } from "./stream-ir.ts";
import type { StreamFn } from "./stream-ir.ts";

const at = (operation: string) => `Stream.${operation}`;
const sameItem = (a: IRType<unknown>, b: IRType<unknown>, operation: string) => {
  if (!IRType.same(a, b))
    throw fail("TYPE_MISMATCH", "authoring", at(operation), "Elements must share one witness");
};
const number = (value: Expr<number> | number, operation: string): Expr<number> => {
  if (typeof value === "number") return NumberType.literal(value);
  if (!IRType.same(value.type, NumberType))
    throw fail("TYPE_MISMATCH", "authoring", at(operation), "Bounds are Numbers");
  return value;
};
// Effect's Count.normalize: NaN and non-positive become 0, Infinity stays, the rest floor.
const normalizeCount = (n: number) => (n > 0 ? Math.floor(n) : 0);

/** `Stream.make(...values)`: one chunk of the given values. */
const make = <A>(...values: readonly [Expr<A>, ...Expr<A>[]]): StreamIR<A, never> => {
  const item = values[0].type;
  values.forEach((value) => sameItem(value.type, item, "make"));
  return new StreamIR(item, NeverType, {
    _tag: "FromArray",
    values: Expr.arrayMake(ArrayType.of(item), values),
  });
};
/** `Stream.fromIterable(array)`: the array as one chunk, nothing when it is empty. */
const fromIterable = <A>(values: Expr<ReadonlyArray<A>>): StreamIR<A, never> => {
  const item = arrayItem(values.type);
  if (!item)
    throw fail("TYPE_MISMATCH", "authoring", at("fromIterable"), "Requires an Array value");
  return new StreamIR(item as IRType<A>, NeverType, { _tag: "FromArray", values });
};
/** `Stream.range(min, max)`: inclusive, in chunks of 4096 as Effect emits them. */
const range = (min: Expr<number> | number, max: Expr<number> | number): StreamIR<number, never> =>
  new StreamIR(NumberType, NeverType, {
    _tag: "Range",
    min: number(min, "range"),
    max: number(max, "range"),
  });
/** `Stream.empty`, with an element witness for native representation. */
const empty = <A>(item: IRType<A>): StreamIR<A, never> =>
  new StreamIR(item, NeverType, { _tag: "Empty" });
/** `Stream.fail(error)`, with an element witness for native representation. */
const failWith = <A, E>(error: Expr<E>, item: IRType<A>): StreamIR<A, E> =>
  new StreamIR(item, error.type, { _tag: "Fail", error });

/**
 * `Stream.fromSchedule(schedule)`: the schedule's outputs, each after its delay. Native for
 * `Schedule.spaced(d)`, whose outputs count 0, 1, 2, … forever.
 */
const fromSchedule = (schedule: Schedule): StreamIR<number, never> =>
  Match.value(schedule.plan).pipe(
    Match.tag(
      "Spaced",
      (plan) =>
        new StreamIR(NumberType, NeverType, {
          _tag: "FromSchedule",
          milliseconds: plan.milliseconds,
        }),
    ),
    Match.orElse(() => {
      throw fail(
        "UNSUPPORTED_STREAM",
        "authoring",
        at("fromSchedule"),
        "Stream.fromSchedule is native for Schedule.spaced only",
      );
    }),
  );
/**
 * `Stream.ensuring(finalizer)`: run the finalizer when the stream ends, however it ends. Native
 * as the outermost operator of the stream a consumer runs.
 */
const ensuring: {
  (finalizer: Computation<void, never>): <A, E>(self: StreamIR<A, E>) => StreamIR<A, E>;
  <A, E>(self: StreamIR<A, E>, finalizer: Computation<void, never>): StreamIR<A, E>;
} = dual(2, <A, E>(self: StreamIR<A, E>, finalizer: Computation<void, never>): StreamIR<A, E> => {
  if (!(finalizer instanceof Computation) || !IRType.same(finalizer.error, NeverType))
    throw fail("TYPE_MISMATCH", "authoring", at("ensuring"), "Finalizers cannot fail");
  return new StreamIR(self.item, self.error, {
    _tag: "Ensuring",
    source: self as StreamIR<unknown, unknown>,
    finalizer,
  });
});
/** `Stream.map(f)`, per element. */
const map: {
  <A, B>(f: (value: Expr<A>) => Expr<B>): <E>(self: StreamIR<A, E>) => StreamIR<B, E>;
  <A, E, B>(self: StreamIR<A, E>, f: (value: Expr<A>) => Expr<B>): StreamIR<B, E>;
} = dual(2, <A, E, B>(self: StreamIR<A, E>, f: (value: Expr<A>) => Expr<B>): StreamIR<B, E> => {
  const item = Symbol("reffect/stream/item");
  const body = f(Expr.parameter(self.item, item, 0));
  if (!(body instanceof Expr))
    throw fail("TYPE_MISMATCH", "authoring", at("map"), "map returns a pure expression");
  return new StreamIR(body.type, self.error, {
    _tag: "Map",
    source: self as StreamIR<unknown, unknown>,
    item,
    body,
  });
});
/** `Stream.filter(predicate)`; chunks left empty are dropped. */
const filter: {
  <A>(predicate: (value: Expr<A>) => Expr<boolean>): <E>(self: StreamIR<A, E>) => StreamIR<A, E>;
  <A, E>(self: StreamIR<A, E>, predicate: (value: Expr<A>) => Expr<boolean>): StreamIR<A, E>;
} = dual(
  2,
  <A, E>(self: StreamIR<A, E>, predicate: (value: Expr<A>) => Expr<boolean>): StreamIR<A, E> => {
    const item = Symbol("reffect/stream/item");
    const body = predicate(Expr.parameter(self.item, item, 0));
    if (!(body instanceof Expr) || !IRType.same(body.type, BoolType))
      throw fail("TYPE_MISMATCH", "authoring", at("filter"), "filter needs a Boolean predicate");
    return new StreamIR(self.item, self.error, {
      _tag: "Filter",
      source: self as StreamIR<unknown, unknown>,
      item,
      body,
    });
  },
);
/** `Stream.take(n)`: `n` is a build-time count, normalized as Effect normalizes it. */
const take: {
  (n: number): <A, E>(self: StreamIR<A, E>) => StreamIR<A, E>;
  <A, E>(self: StreamIR<A, E>, n: number): StreamIR<A, E>;
} = dual(
  2,
  <A, E>(self: StreamIR<A, E>, n: number): StreamIR<A, E> =>
    new StreamIR(self.item, self.error, {
      _tag: "Take",
      source: self as StreamIR<unknown, unknown>,
      count: normalizeCount(n),
    }),
);
/** `Stream.rechunk(size)`: `size` is a build-time count of at least 1, as Effect normalizes it. */
const rechunk: {
  (size: number): <A, E>(self: StreamIR<A, E>) => StreamIR<A, E>;
  <A, E>(self: StreamIR<A, E>, size: number): StreamIR<A, E>;
} = dual(2, <A, E>(self: StreamIR<A, E>, size: number): StreamIR<A, E> => {
  const normalized = Math.max(1, normalizeCount(size));
  if (!Number.isSafeInteger(normalized))
    throw fail("UNSUPPORTED_REPRESENTATION", "authoring", at("rechunk"), "Chunk sizes are finite");
  return new StreamIR(self.item, self.error, {
    _tag: "Rechunk",
    source: self as StreamIR<unknown, unknown>,
    size: normalized,
  });
});
/** `Stream.concat(that)`: this stream's chunks, then that stream's. */
const concat: {
  <A, E2>(that: StreamIR<A, E2>): <E>(self: StreamIR<A, E>) => StreamIR<A, E | E2>;
  <A, E, E2>(self: StreamIR<A, E>, that: StreamIR<A, E2>): StreamIR<A, E | E2>;
} = dual(2, <A, E, E2>(self: StreamIR<A, E>, that: StreamIR<A, E2>): StreamIR<A, E | E2> => {
  sameItem(self.item, that.item, "concat");
  return new StreamIR(self.item, joinType(self.error, that.error) as IRType<E | E2>, {
    _tag: "Concat",
    first: self as StreamIR<unknown, unknown>,
    second: that as StreamIR<unknown, unknown>,
  });
});
/** `Stream.chunks`: each chunk becomes one Array element. */
const chunks = <A, E>(self: StreamIR<A, E>): StreamIR<ReadonlyArray<A>, E> =>
  new StreamIR(ArrayType.of(self.item) as IRType<ReadonlyArray<A>>, self.error, {
    _tag: "Chunks",
    source: self as StreamIR<unknown, unknown>,
  });
/** `Stream.runCollect`: every element, in order, or the stream's failure. */
const runCollect = <A, E>(self: StreamIR<A, E>): Computation<ReadonlyArray<A>, E> =>
  streamRunCollect(self as StreamIR<unknown, unknown>, ArrayType.of(self.item)) as Computation<
    ReadonlyArray<A>,
    E
  >;

/**
 * A streaming procedure (STREAM-006): `Stream.fn(inputs, error, build)` returns the stream a
 * `stream: true` RPC answers with. Elements are encoded as `Schema.toCodecJson` encodes them.
 */
const fn = <const I extends readonly IRType<unknown>[], A, E>(
  input: I,
  error: IRType<E>,
  build: (...args: Symbols<I>) => StreamIR<A, E>,
): StreamFn<I, A, E> =>
  EffectFn.make(input, UnitType, error, (...args) => {
    const stream = build(...args);
    if (!(stream instanceof StreamIR))
      throw fail("TYPE_MISMATCH", "authoring", at("fn"), "A streaming function returns a Stream");
    if (!IRType.same(stream.error, error) && !IRType.same(stream.error, NeverType))
      throw fail(
        "TYPE_MISMATCH",
        "authoring",
        at("fn"),
        "The stream fails with the declared error",
      );
    const item = Symbol("reffect/stream/encoded");
    const encoded = SchemaIR.encodeSync(SchemaIR.toCodecJson(stream.item))(
      Expr.parameter(stream.item, item, 0),
    );
    return streamEmit(stream as StreamIR<unknown, unknown>, item, encoded, error) as Computation<
      void,
      E
    >;
  });

export const StreamAuthoring = Object.freeze({
  fn,
  fromSchedule,
  ensuring,
  make,
  fromIterable,
  range,
  empty,
  fail: failWith,
  map,
  filter,
  take,
  rechunk,
  concat,
  chunks,
  runCollect,
});
