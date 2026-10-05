/**
 * Pure operations whose meaning is an ECMAScript or Effect function the reference calls directly,
 * implemented natively in the std-only `js_std` runtime module (docs/research/ssr-codemod.md,
 * step 1d). Each is total, and agrees with its JS reference on a differential corpus.
 */
import { DateTime, Number as EffectNumber, Option, Schema } from "effect";
import { Cookies } from "effect/http";
import {
  Capabilities,
  Expr,
  IRType,
  Native,
  NumberType,
  Operation,
  SemanticRef,
  StringType,
  Traits,
  installNumberParse,
} from "./kernel.ts";
import type { OptionValue } from "./option.ts";
import { RecordType, UndefinedOr } from "./records.ts";
import { OptionIR } from "./option.ts";

/** Effect `Number.parse` as `T | undefined`; `R.Number.parse` reads it as an Option. */
export const NumberParse = Operation.make(
  SemanticRef.operation("reffect/number.parse@1"),
  [StringType] as const,
  UndefinedOr(NumberType),
  (text) => Option.getOrUndefined(EffectNumber.parse(text)),
).pipe(Operation.withCapabilities([Capabilities.Number, Capabilities.String]));

installNumberParse((text) => OptionIR.fromUndefinedOr(Expr.apply(NumberParse, text)));

/** Effect `Cookies.parseHeader`: a `Cookie` header's pairs, the first of each name kept. */
export const CookiesParseHeader = Operation.make(
  SemanticRef.operation("reffect/cookies.parse-header@1"),
  [StringType] as const,
  RecordType.of(StringType, StringType),
  (header) => Cookies.parseHeader(header),
).pipe(Operation.withCapabilities([Capabilities.String]));

/**
 * Effect `DateTime.Utc`: an instant in UTC. Natively its epoch milliseconds as an `f64`, always a
 * valid JS time value (an integer within +-8.64e15), so it is Copy.
 */
export const UtcType: IRType<DateTime.Utc> = IRType.make(
  SemanticRef.type("reffect/date-time-utc@1"),
  Schema.declare(
    (value): value is DateTime.Utc => DateTime.isDateTime(value) && DateTime.isUtc(value),
  ),
  Native.Number,
).pipe(IRType.withTraits([Traits.Copyable, Traits.Cloneable]));
export const DateTimeMake = Operation.make(
  SemanticRef.operation("reffect/date-time.make@1"),
  [NumberType] as const,
  UndefinedOr(UtcType),
  (epochMillis) => Option.getOrUndefined(DateTime.make(epochMillis)),
).pipe(Operation.withCapabilities([Capabilities.Number]));
export const DateTimeFormatIso = Operation.make(
  SemanticRef.operation("reffect/date-time.format-iso@1"),
  [UtcType] as const,
  StringType,
  (instant) => DateTime.formatIso(instant),
).pipe(Operation.withCapabilities([Capabilities.String]));
export const DateTimeToEpochMillis = Operation.make(
  SemanticRef.operation("reffect/date-time.to-epoch-millis@1"),
  [UtcType] as const,
  NumberType,
  (instant) => DateTime.toEpochMillis(instant),
).pipe(Operation.withCapabilities([Capabilities.Number]));

/** Effect `DateTime`, by what R reads of it: UTC instants from epoch milliseconds. */
export const DateTimeIR = Object.freeze({
  Utc: UtcType,
  /** Effect `DateTime.make(epochMillis)`: None for a value JS `Date` cannot hold. */
  make: (epochMillis: Expr<number>): Expr<OptionValue<DateTime.Utc>> =>
    OptionIR.fromUndefinedOr(Expr.apply(DateTimeMake, epochMillis)),
  /** Effect `DateTime.formatIso`: `Date.prototype.toISOString`. */
  formatIso: (instant: Expr<DateTime.Utc>): Expr<string> => Expr.apply(DateTimeFormatIso, instant),
  toEpochMillis: (instant: Expr<DateTime.Utc>): Expr<number> =>
    Expr.apply(DateTimeToEpochMillis, instant),
});

/** `effect/http` `Cookies`, by what R reads of it. */
export const CookiesIR = Object.freeze({
  /** Effect `Cookies.parseHeader(header)`: name to value, decoded where it holds a `%`. */
  parseHeader: (header: Expr<string>): Expr<Readonly<Record<string, string>>> =>
    Expr.apply(CookiesParseHeader, header),
});
