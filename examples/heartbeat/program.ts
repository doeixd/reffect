import { R } from "../../packages/reffect/src/index.ts";

/** Omit times for the long-running application; times counts additional heartbeats. */
export const heartbeat = (times?: number) =>
  R.fn([], R.Unit, R.Never, () =>
    R.Effect.addFinalizer(() => R.Effect.logInfo("Application is about to exit!")).pipe(
      R.Effect.andThen(R.Effect.logInfo("Application started!")),
      R.Effect.andThen(
        R.Effect.repeat(R.Effect.logInfo("still alive..."), {
          schedule: R.Schedule.spaced("1 second"),
          ...(times === undefined ? {} : { times }),
        }),
      ),
      R.Effect.scoped,
    ),
  );

export const Application = heartbeat();
