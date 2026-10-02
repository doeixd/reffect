import { Effect, Exit, FileSystem } from "effect";
import { NodeServices } from "@effect/platform-node";
import {
  CargoApi,
  Compile,
  NativeRunner,
  R,
  Reference,
  Rust,
} from "../../packages/reffect/src/index.ts";
import { makeSession } from "./program.ts";

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-scope-example-" });
      const path = `${parent}/input.txt`;
      yield* fs.writeFileString(path, "hello");
      const session = makeSession(path);
      const reference = yield* Reference.run(session, []);
      const artifact = yield* Compile.run(R.program({ session }), Rust.tokio);
      const directory = yield* CargoApi.write(artifact, `${parent}/native`);
      yield* CargoApi.fetch(directory);
      yield* CargoApi.build(directory);
      const result = yield* NativeRunner.run(artifact, directory, "session", session, []);
      if (reference !== 5n || !Exit.isSuccess(result) || result.value !== 5n)
        return yield* Effect.die("Session reference/native result mismatch");
      yield* Effect.logInfo("reference and native session complete", { reference, native: result });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
