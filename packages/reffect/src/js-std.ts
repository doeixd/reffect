/**
 * Pure operations whose meaning is an ECMAScript or Effect function the reference calls directly,
 * implemented natively in the std-only `js_std` runtime module (docs/research/ssr-codemod.md,
 * step 1d). Each is total, and agrees with its JS reference on a differential corpus.
 */
import { Number as EffectNumber, Option } from "effect";
import {
  Capabilities,
  Expr,
  NumberType,
  Operation,
  SemanticRef,
  StringType,
  installNumberParse,
} from "./kernel.ts";
import { UndefinedOr } from "./records.ts";
import { OptionIR } from "./option.ts";

/** Effect `Number.parse` as `T | undefined`; `R.Number.parse` reads it as an Option. */
export const NumberParse = Operation.make(
  SemanticRef.operation("reffect/number.parse@1"),
  [StringType] as const,
  UndefinedOr(NumberType),
  (text) => Option.getOrUndefined(EffectNumber.parse(text)),
).pipe(Operation.withCapabilities([Capabilities.Number, Capabilities.String]));

installNumberParse((text) => OptionIR.fromUndefinedOr(Expr.apply(NumberParse, text)));
