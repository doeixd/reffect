import { Duration, Match } from "effect";
import { fail } from "./kernel.ts";

/** Plain, serializable schedule body; interpreted by reference and lowered by native. */
export type SchedulePlan =
  | { readonly _tag: "Recurs"; readonly times: number }
  | { readonly _tag: "Spaced"; readonly milliseconds: number }
  | { readonly _tag: "Exponential"; readonly milliseconds: number; readonly factor: number }
  | { readonly _tag: "Forever" };

const millisecondsOf = (duration: Duration.Input): number => {
  let milliseconds: number;
  try {
    milliseconds = Duration.toMillis(Duration.fromInputUnsafe(duration));
  } catch {
    throw fail("INVALID_DELAY", "authoring", "schedule", "Invalid schedule duration");
  }
  return milliseconds;
};
const validMilliseconds = (milliseconds: number): boolean =>
  Number.isSafeInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 60000;
export const validTimes = (times: number | undefined): boolean =>
  times === undefined || (Number.isSafeInteger(times) && times >= 0 && times <= 1000000);
/** Validates a serialized plan, including forged IR nodes that bypass the constructors. */
export const validSchedulePlan = (plan: SchedulePlan): boolean =>
  Match.value(plan).pipe(
    Match.tagsExhaustive({
      Recurs: (p) => Number.isSafeInteger(p.times) && p.times >= 0 && p.times <= 1000000,
      Spaced: (p) => validMilliseconds(p.milliseconds) && p.milliseconds >= 1,
      Exponential: (p) =>
        validMilliseconds(p.milliseconds) &&
        Number.isFinite(p.factor) &&
        p.factor > 0 &&
        p.factor <= 1000,
      Forever: () => true,
    }),
  );

/** A bounded, statically representable Effect v4 Schedule. */
export class Schedule {
  private constructor(readonly plan: SchedulePlan) {
    Object.freeze(this);
  }
  static recurs(this: void, times: number): Schedule {
    if (!validTimes(times))
      throw fail(
        "INVALID_SCHEDULE",
        "authoring",
        "schedule",
        "recurs requires 0–1000000 integral recurrences",
      );
    return new Schedule(Object.freeze({ _tag: "Recurs", times: times as number }));
  }
  static spaced(this: void, duration: Duration.Input): Schedule {
    const milliseconds = millisecondsOf(duration);
    if (!validMilliseconds(milliseconds) || milliseconds < 1)
      throw fail(
        "INVALID_DELAY",
        "authoring",
        "schedule",
        "spaced requires 1–60000 integral milliseconds",
      );
    return new Schedule(Object.freeze({ _tag: "Spaced", milliseconds }));
  }
  static exponential(this: void, base: Duration.Input, factor = 2): Schedule {
    const milliseconds = millisecondsOf(base);
    if (!validMilliseconds(milliseconds))
      throw fail(
        "INVALID_DELAY",
        "authoring",
        "schedule",
        "exponential requires a 0–60000 integral millisecond base",
      );
    if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0 || factor > 1000)
      throw fail(
        "INVALID_SCHEDULE",
        "authoring",
        "schedule",
        "exponential requires a finite factor greater than 0 and at most 1000",
      );
    return new Schedule(Object.freeze({ _tag: "Exponential", milliseconds, factor }));
  }
  static readonly forever: Schedule = new Schedule(Object.freeze({ _tag: "Forever" }));
}
export const ScheduleIR = Object.freeze({
  recurs: Schedule.recurs,
  spaced: Schedule.spaced,
  exponential: Schedule.exponential,
  forever: Schedule.forever,
});
