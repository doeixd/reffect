import { Duration as OfficialDuration } from "effect";
import { fail } from "./kernel.ts";

/** Official Duration values used as authoring configuration, without a native IR witness. */
export type Duration = OfficialDuration.Duration;
export type DurationInput = OfficialDuration.Input;

/**
 * Pinned Effect Duration configuration helpers. These execute during authoring;
 * compiled Sleep/Schedule nodes retain only checked millisecond literals.
 */
export const DurationIR = Object.freeze({
  zero: OfficialDuration.zero,
  infinity: OfficialDuration.infinity,
  negativeInfinity: OfficialDuration.negativeInfinity,
  nanos: OfficialDuration.nanos,
  micros: OfficialDuration.micros,
  millis: OfficialDuration.millis,
  seconds: OfficialDuration.seconds,
  minutes: OfficialDuration.minutes,
  hours: OfficialDuration.hours,
  days: OfficialDuration.days,
  weeks: OfficialDuration.weeks,
  fromInput: OfficialDuration.fromInput,
  fromInputUnsafe: OfficialDuration.fromInputUnsafe,
  toMillis: OfficialDuration.toMillis,
  toSeconds: OfficialDuration.toSeconds,
  toMinutes: OfficialDuration.toMinutes,
  toHours: OfficialDuration.toHours,
  toDays: OfficialDuration.toDays,
  toWeeks: OfficialDuration.toWeeks,
  toNanos: OfficialDuration.toNanos,
  toNanosUnsafe: OfficialDuration.toNanosUnsafe,
  toHrTime: OfficialDuration.toHrTime,
  isDuration: OfficialDuration.isDuration,
  isFinite: OfficialDuration.isFinite,
  isZero: OfficialDuration.isZero,
  isNegative: OfficialDuration.isNegative,
  isPositive: OfficialDuration.isPositive,
  abs: OfficialDuration.abs,
  negate: OfficialDuration.negate,
  sum: OfficialDuration.sum,
  subtract: OfficialDuration.subtract,
  times: OfficialDuration.times,
  divide: OfficialDuration.divide,
  divideUnsafe: OfficialDuration.divideUnsafe,
  min: OfficialDuration.min,
  max: OfficialDuration.max,
  clamp: OfficialDuration.clamp,
  between: OfficialDuration.between,
  equals: OfficialDuration.equals,
  isLessThan: OfficialDuration.isLessThan,
  isLessThanOrEqualTo: OfficialDuration.isLessThanOrEqualTo,
  isGreaterThan: OfficialDuration.isGreaterThan,
  isGreaterThanOrEqualTo: OfficialDuration.isGreaterThanOrEqualTo,
  format: OfficialDuration.format,
});

/** Normalize configuration once; never round fractional delays into the admitted timer profile. */
export const checkedMilliseconds = (
  input: DurationInput,
  path: string,
  minimum: 0 | 1 = 0,
): number => {
  const invalid = () =>
    fail(
      "INVALID_DELAY",
      "authoring",
      path,
      `Delay requires ${minimum}–60000 integral milliseconds`,
    );
  // Preserve numeric NaN refusal even though upstream Duration constructors normalize it to zero.
  if (typeof input === "number" && Number.isNaN(input)) throw invalid();
  let milliseconds: number;
  try {
    milliseconds = OfficialDuration.toMillis(input);
  } catch {
    throw invalid();
  }
  if (!Number.isSafeInteger(milliseconds) || milliseconds < minimum || milliseconds > 60000)
    throw invalid();
  return milliseconds;
};
