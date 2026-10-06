import { DeferredPublic } from "./deferred.ts";
import { CookiesIR, DateTimeIR } from "./js-std.ts";
import { SchemaIR } from "./schema-json.ts";
import { UrlIR } from "./url.ts";
import { StreamAuthoring } from "./stream.ts";
import { LiveHubIR, RemoteStoreIR } from "./remote-store.ts";
import { SqlSchemaIR, sql } from "./sql.ts";
import { HtmlIR } from "./html.ts";
import { Source } from "./source.ts";
import { flow } from "./flow.ts";
import {
  Fn,
  Program,
  Expr,
  BoolType,
  NumberType,
  StringType,
  UnknownType,
  U64Type,
  UnitType,
  NeverType,
  IRType,
  fail,
  recordValue,
} from "./kernel.ts";
import type { Symbols } from "./kernel.ts";
import { Computation, EffectFn, EffectIR, LogIR, matchComputation } from "./effect-ir.ts";
import { catchAll, mapError, orElse } from "./error-recovery.ts";
import { ContextIR } from "./context.ts";
import { LayerIR } from "./layer.ts";
import {
  ArrayIR,
  Literals,
  RecordIR,
  Struct,
  TaggedUnion,
  UndefinedOr,
  NullOr,
  forEach,
  optional,
  optionalKey,
  valueTags,
} from "./records.ts";
import { FileIR } from "./file-resource.ts";
import { ScheduleIR } from "./schedule.ts";
import { ScopedIR } from "./scoped-sequence.ts";
import { OptionIR } from "./option.ts";
import type { OptionValue } from "./option.ts";
import { dual } from "effect/Function";
import { ResultIR, effectResult } from "./result.ts";
import { CauseIR } from "./cause.ts";
import { ExitIR } from "./exit.ts";
import { effectExit } from "./effect-exit.ts";
import { DurationIR } from "./duration.ts";
import { EffectCombinators } from "./effect-combinators.ts";
import { RefIR } from "./ref.ts";
import { ClockIR } from "./clock.ts";
import { RandomIR } from "./random.ts";
import {
  ArrayCombinators,
  BooleanCombinators,
  PredicateCombinators,
  RecordCombinators,
} from "./collection-combinators.ts";

const ArrayModule = Object.freeze(
  Object.assign(
    Object.defineProperty(<A>(item: IRType<A>) => ArrayIR(item), "length", {
      value: ArrayIR.length,
      writable: true,
      enumerable: true,
      configurable: true,
    }),
    ArrayIR,
    ArrayCombinators,
  ),
);
/**
 * Effect `Record.get(self, key)`: the own key's value as an Option. Its Option lives above the
 * records module, so it is assembled here.
 */
const recordGet: {
  (key: Expr<string>): <V>(self: Expr<Readonly<Record<string, V>>>) => Expr<OptionValue<V>>;
  <V>(self: Expr<Readonly<Record<string, V>>>, key: Expr<string>): Expr<OptionValue<V>>;
} = dual(
  2,
  <V>(self: Expr<Readonly<Record<string, V>>>, key: Expr<string>): Expr<OptionValue<V>> => {
    const value = recordValue(self.type);
    if (value === undefined || !IRType.same(key.type, StringType))
      throw fail("TYPE_MISMATCH", "authoring", "Record.get", "get takes a Record and a String key");
    return OptionIR.fromUndefinedOr(
      Expr.recordQuery("Get", UndefinedOr(value as IRType<V>), self, key),
    );
  },
);
const RecordModule = Object.freeze(
  Object.assign(
    <A>(key: IRType<string>, value: IRType<A>) => RecordIR(key, value),
    RecordIR,
    RecordCombinators,
    { get: recordGet },
  ),
);

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
  flow,
  Source,
  program: Program.make,
  literal: Expr.literal,
  U64: U64Type,
  Bool: BoolType,
  Unit: UnitType,
  Never: NeverType,
  String: StringType,
  Number: NumberType,
  Unknown: UnknownType,
  Schema: SchemaIR,
  /** What a page reads of its URL: the Web URL API's pathname and search parameters. */
  Url: UrlIR,
  /** `effect/http` Cookies: what a page reads of its `Cookie` header. */
  Cookies: CookiesIR,
  /** Effect `DateTime`: UTC instants, as a page's `now` is one. */
  DateTime: DateTimeIR,
  RemoteStore: RemoteStoreIR,
  /** The `sql` tagged template of `yield* SqlClient.SqlClient` (SQL-001). */
  sql,
  SqlSchema: SqlSchemaIR,
  LiveHub: LiveHubIR,
  /** Foldkit Remote values an R page reads (M9-3). */
  Remote: Object.freeze({
    /**
     * Upstream's `Page<A>`: a query read's items in edge order, and whether more lie either side.
     * A Struct witness, so a page can be made and its fields read like any other (#15).
     */
    Page: <A>(item: IRType<A>) =>
      Struct({ items: ArrayModule(item), hasNext: BoolType, hasPrevious: BoolType }),
    /**
     * The settled subset of upstream's `RemoteData<A>` a page's get view reads: `Ready` with the
     * entity's value, or `NotFound`. Match it with `R.Match.valueTags`.
     */
    Data: <A>(value: IRType<A>) => TaggedUnion({ Ready: { value }, NotFound: {} }),
  }),
  Html: HtmlIR,
  Struct,
  TaggedUnion,
  UndefinedOr,
  /** `Schema.NullOr(T)`, read with `R.Option.fromNullOr`. */
  NullOr,
  optional,
  optionalKey,
  Array: ArrayModule,
  Stream: StreamAuthoring,
  Record: RecordModule,
  Option: OptionIR,
  Result: ResultIR,
  Cause: CauseIR,
  Exit: ExitIR,
  Duration: DurationIR,
  Ref: RefIR,
  Deferred: DeferredPublic,
  Clock: ClockIR,
  Random: RandomIR,
  Boolean: Object.freeze({ not: BoolType.not, ...BooleanCombinators }),
  Literals,
  Match: Object.freeze({ bool, valueTags }),
  Predicate: Object.freeze({
    eqU64: U64Type.eq,
    ltU64: U64Type.lt,
    eqBool: BoolType.eq,
    ...PredicateCombinators,
  }),
  Effect: Object.freeze({
    ...EffectIR,
    ...ScopedIR,
    catchAll,
    mapError,
    orElse,
    forEach,
    ...EffectCombinators,
    result: effectResult,
    exit: effectExit,
  }),
  Schedule: ScheduleIR,
  Log: LogIR,
  Context: ContextIR,
  Layer: LayerIR,
  File: FileIR,
});
