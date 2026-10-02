import { Effect, Schedule } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import { Application } from "./program.ts";
import { Reference } from "../../packages/reffect/src/index.ts";

// Independently authored Effect v4 equivalent (the logger preserves machine stdout).
export const official = Effect.addFinalizer(() =>
  Effect.logInfo("Application is about to exit!"),
).pipe(
  Effect.andThen(Effect.logInfo("Application started!")),
  Effect.andThen(
    Effect.repeat(Effect.logInfo("still alive..."), {
      schedule: Schedule.spaced("1 second"),
    }),
  ),
  Effect.scoped,
);

NodeRuntime.runMain(Reference.run(Application, []));
