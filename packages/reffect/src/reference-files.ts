import { Context, Effect, Layer, Option } from "effect";
import { FileLease } from "./file-model.ts";

/** Injectable filesystem oracle for the bounded read-only file profile. */
export class ReferenceFiles extends Context.Service<
  ReferenceFiles,
  {
    readonly open: (path: string) => Effect.Effect<FileLease, boolean>;
  }
>()("reffect/ReferenceFiles") {
  static readonly layer = Layer.effect(
    ReferenceFiles,
    Effect.gen(function* () {
      const fs = yield* Effect.promise(() => import("node:fs/promises"));
      return ReferenceFiles.of({
        open: Effect.fn("ReferenceFiles.open")(function* (path: string) {
          const file = yield* Effect.tryPromise({
            try: () => fs.open(path, "r"),
            catch: () => false,
          });
          return new FileLease(
            Effect.tryPromise({
              try: async () => (await file.stat({ bigint: true })).size,
              catch: () => false,
            }),
            Effect.promise(() => file.close().catch(() => undefined)),
          );
        }),
      });
    }),
  );
}

export const openReferenceFile = Effect.fn("ReferenceFiles.openSelected")(function* (path: string) {
  const provided = yield* Effect.serviceOption(ReferenceFiles);
  if (Option.isSome(provided)) return yield* provided.value.open(path);
  return yield* Effect.flatMap(ReferenceFiles, (files) => files.open(path)).pipe(
    Effect.provide(ReferenceFiles.layer),
  );
});
