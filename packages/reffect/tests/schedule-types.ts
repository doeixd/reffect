import { Schedule as EffectSchedule } from "effect";
import { expectTypeOf } from "vite-plus/test";
import { Computation, R, Schedule } from "../src/index.ts";

// Checked by strict TypeScript; these invalid authored programs are never executed.
export const scheduleTypeChecks = () => {
  expectTypeOf(R.Schedule.recurs(3)).toEqualTypeOf<Schedule>();
  expectTypeOf(R.Schedule.spaced("1 second")).toEqualTypeOf<Schedule>();
  expectTypeOf(R.Schedule.exponential(2, 2)).toEqualTypeOf<Schedule>();
  expectTypeOf(R.Schedule.forever).toEqualTypeOf<Schedule>();
  const body = R.Effect.logInfo("beat");
  expectTypeOf(R.Effect.repeat(body, R.Schedule.recurs(2))).toEqualTypeOf<
    Computation<void, never>
  >();
  expectTypeOf(R.Effect.repeat(body, { schedule: R.Schedule.spaced(5), times: 2 })).toEqualTypeOf<
    Computation<void, never>
  >();
  const failing = R.Effect.fail(R.Bool.literal(false));
  expectTypeOf(R.Effect.retry(failing, R.Schedule.recurs(1))).toEqualTypeOf<
    Computation<never, boolean>
  >();
  const value = R.Effect.succeed(R.U64.literal(1n));
  expectTypeOf(R.Effect.retry(value, { schedule: R.Schedule.forever, times: 2 })).toEqualTypeOf<
    Computation<bigint, never>
  >();
  // @ts-expect-error repeat requires a Unit body
  R.Effect.repeat(value, R.Schedule.recurs(1));
  // @ts-expect-error stock runtime schedules are not statically representable
  R.Effect.repeat(body, EffectSchedule.recurs(1));
  // @ts-expect-error an options object requires a Schedule value
  R.Effect.repeat(body, { schedule: 5 });
  // @ts-expect-error additional runs must be a number
  R.Effect.repeat(body, { schedule: R.Schedule.forever, times: "2" });
};
