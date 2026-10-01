import { Effect, FileSystem, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
import { CargoApi, Compile, FailureFrames, R, SourceArtifacts } from "../src/index.ts";
import { CostRecord, costFn, costMain, layoutProbe } from "../tests/fixtures/frames/cost.ts";

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-frame-bench-" });
      for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
        const enabled = policy === FailureFrames.Bounded;
        const artifact = yield* Compile.make(R.program({ cost: costFn })).pipe(
          Compile.withSourceArtifacts(SourceArtifacts.None),
          Compile.withFailureFrames(policy),
          Compile.run,
        );
        const directory = yield* CargoApi.write(
          {
            files: {
              ...artifact.files,
              "src/lib.rs": artifact.files["src/lib.rs"] + layoutProbe(enabled),
              "src/main.rs": costMain(enabled),
            },
          },
          `${parent}/${policy._tag}`,
        );
        yield* CargoApi.build(directory, "release");
        for (let sample = 0; sample < 5; sample++) {
          const process = yield* CargoApi.run(directory, "100000", [], "release");
          const record = Schema.decodeUnknownSync(CostRecord)(JSON.parse(process.stdout));
          console.log(JSON.stringify({ policy: policy._tag, sample, ...record }));
        }
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
