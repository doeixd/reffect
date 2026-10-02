import { Duration } from "effect";
import { fail } from "./kernel.ts";

/** A statically representable spaced schedule; milliseconds follow each successful run. */
export class SpacedSchedule {
  private constructor(readonly milliseconds: number) {
    Object.freeze(this);
  }
  static make(this: void, duration: Duration.Input): SpacedSchedule {
    let milliseconds: number;
    try {
      milliseconds = Duration.toMillis(Duration.fromInputUnsafe(duration));
    } catch {
      throw fail("INVALID_DELAY", "authoring", "schedule", "Invalid spaced duration");
    }
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 60000)
      throw fail(
        "INVALID_DELAY",
        "authoring",
        "schedule",
        "Spaced schedules require 1–60000 integral milliseconds",
      );
    return new SpacedSchedule(milliseconds);
  }
}
export const ScheduleIR = Object.freeze({ spaced: SpacedSchedule.make });
export const validRepeatCount = (times: number | undefined): boolean =>
  times === undefined || (Number.isSafeInteger(times) && times >= 0 && times <= 1000000);
