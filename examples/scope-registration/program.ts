import { R } from "../../packages/reffect/src/index.ts";

export const makeSession = (path: string) =>
  R.fn([], R.U64, R.Bool, () =>
    R.Effect.addFinalizer(() => R.Effect.logInfo("session released")).pipe(
      R.Effect.andThen(
        R.File.acquireReadOnly(
          path,
          (file) => file.size,
          R.Effect.logInfo("file closed").pipe(
            R.Effect.andThen(R.Effect.sleep(5)),
            R.Effect.andThen(R.Effect.logInfo("file cleanup awaited")),
          ),
        ),
      ),
      R.Effect.flatMap((size) =>
        R.Effect.logInfo("registration returned; file still owned by session", [
          ["size", size],
        ]).pipe(R.Effect.andThen(R.Effect.sleep(5)), R.Effect.andThen(R.Effect.succeed(size))),
      ),
      R.Effect.scoped,
    ),
  );
