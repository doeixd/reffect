import { Cause, Effect, Exit, FileSystem, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Cargo,
  Compile,
  FailureFrames,
  Plan,
  NativeRunner,
  R,
  Reference,
  SourceArtifacts,
} from "../src/index.ts";
import { CostRecord, costFn, costMain, layoutProbe } from "./fixtures/frames/cost.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const program = R.program({ cost: costFn });

test("frame policy is independent, survives staged verification and refuses unregistered policies", async () => {
  const offSources: Array<Readonly<Record<string, string>>> = [];
  for (const source of [SourceArtifacts.Full, SourceArtifacts.None]) {
    const spec = Compile.make(program).pipe(
      Compile.withFailureFrames(FailureFrames.None),
      Compile.withSourceArtifacts(source),
    );
    const artifact = await Effect.runPromise(Compile.run(spec));
    offSources.push(artifact.files);
    expect(artifact.failureFrames).toBe(FailureFrames.None);
    expect(artifact.explanation.failureFrames).toBe(FailureFrames.None);
    expect(artifact.files["src/lib.rs"]).not.toMatch(
      /FrameTrail|LAST_FRAMES|frames\.push|store_frames|"kind"/,
    );
    expect(artifact.files["src/main.rs"]).not.toContain("reffect.frames");
    const planned = (
      await Effect.runPromise(Compile.plan(await Effect.runPromise(Compile.derive(program))))
    ).pipe(
      // Plan selection uses the same registered policy as complete requests.
      Plan.withFailureFrames(FailureFrames.None),
    );
    const staged = await Effect.runPromise(
      Compile.emit(await Effect.runPromise(Compile.verify(planned)), source),
    );
    expect(staged.files).toEqual(artifact.files);
    const refusal = await Effect.runPromise(
      NativeRunner.runWithFrames(artifact, "absent", "cost", costFn, [true]).pipe(
        Effect.map(() => undefined),
        Effect.catchTag("CompileError", (error) => Effect.succeed(error)),
        Effect.provide(NodeServices.layer),
      ),
    );
    expect(refusal?.diagnostics[0].code).toBe("UNSUPPORTED_FRAME_POLICY");
  }
  expect(offSources[0]).toEqual(offSources[1]);
  const invalid = structuredClone(FailureFrames.Bounded);
  const error = await Effect.runPromise(
    Compile.make(program).pipe(Compile.withFailureFrames(invalid), Compile.run, Effect.flip),
  );
  expect(error.diagnostics[0].code).toBe("UNSUPPORTED_FRAME_POLICY");
});

test(
  "native traces stay bounded while propagating, with measured allocation and layout costs",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-frame-cost-" });
          for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
            const enabled = policy === FailureFrames.Bounded;
            const artifact = yield* Compile.make(program).pipe(
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
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              const raw = yield* CargoApi.run(directory, "1000", [], profile);
              const record = Schema.decodeUnknownSync(CostRecord)(JSON.parse(raw.stdout));
              expect(record.success_allocs).toBe(0);
              expect(record.success_bytes).toBe(0);
              expect(record.failure_allocs).toBe(enabled ? record.iterations : 0);
              expect(record.failure_bytes).toBe(
                enabled ? record.trail_bytes * record.iterations : 0,
              );
              if (enabled)
                expect(record.helper_bytes).toBeGreaterThanOrEqual(record.plain_result_bytes);
              else expect(record.helper_bytes).toBe(record.plain_result_bytes);
              if (enabled) expect(record.helper_bytes).toBeLessThan(record.legacy_result_bytes);
              expect(record.frames).toBe(enabled ? 32 : 0);
              expect(record.omitted).toBe(enabled ? 99 : 0);
              expect(record.drained).toBe(true);
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0),
);

test(
  "frame-off native results match reference execution",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-frame-off-" });
          const { artifact, directory } = yield* Compile.build(
            Compile.make(program).pipe(Compile.withFailureFrames(FailureFrames.None)),
            `${parent}/crate`,
            "debug",
          ).pipe(Effect.provide(Cargo.layer));
          expect(artifact.failureFrames).toBe(FailureFrames.None);
          for (const profile of ["debug", "release"] as const) {
            if (profile === "release") yield* CargoApi.build(directory, profile);
            for (const flag of [true, false]) {
              const exit = yield* NativeRunner.run(
                artifact,
                directory,
                "cost",
                costFn,
                [flag],
                profile,
              );
              const expected = yield* Reference.run(costFn, [flag]).pipe(Effect.exit);
              if (Exit.isSuccess(exit) && Exit.isSuccess(expected))
                expect(exit.value).toBe(expected.value);
              else if (Exit.isFailure(exit) && Exit.isFailure(expected))
                expect(Cause.findErrorOption(exit.cause)).toEqual(
                  Cause.findErrorOption(expected.cause),
                );
              else throw new Error("Native/reference exit channels differ");
              expect(Exit.isSuccess(exit)).toBe(flag);
              const raw = yield* CargoApi.run(directory, "cost", [flag], profile);
              expect(raw.stdout.trim()).toBe(flag ? "ok:u64:7" : "err:u64:9");
              expect(raw.stderr).not.toContain("reffect.frames");
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0),
);
