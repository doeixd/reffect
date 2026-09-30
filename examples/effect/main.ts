import { Cause, Effect, Exit, FileSystem } from "effect";
import { NodeServices } from "@effect/platform-node";
import { CargoApi, Compile, NativeRunner, R, Reference } from "../../packages/reffect/src/index.ts";

const difference = R.fn([R.U64, R.U64], R.U64, R.U64, (a, b) =>
  R.Match.bool(R.Predicate.ltU64(a, b), R.Effect.succeed(R.U64.sub(b, a)), R.Effect.fail(a)).pipe(
    R.Effect.map((value) => R.U64.mul(value, R.U64.literal(2n))),
  ),
);
const observe = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.match(exit, {
    onSuccess: (value) => `success ${String(value)}`,
    onFailure: (cause) => `failure ${String(Cause.squash(cause))}`,
  });
const main = Effect.scoped(
  Effect.gen(function* () {
    const artifact = yield* Compile.run(R.program({ difference }));
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-effect-example-" });
    const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
    for (const profile of ["debug", "release"] as const) {
      yield* CargoApi.build(directory, profile);
      for (const args of [
        [2n, 7n],
        [7n, 2n],
      ] as const) {
        const reference = observe(yield* Effect.exit(Reference.run(difference, args)));
        const native = observe(
          yield* NativeRunner.run(artifact, directory, "difference", difference, args, profile),
        );
        if (reference !== native)
          throw new Error(`${profile}: ${reference} differs from ${native}`);
        yield* Effect.sync(() => console.log(`${profile}: ${native}`));
      }
    }
  }),
);
await Effect.runPromise(main.pipe(Effect.provide(NodeServices.layer)));
