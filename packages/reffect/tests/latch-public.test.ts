import { Cause, Effect, Exit, FileSystem, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
import { Rpc, RpcGroup } from "effect/rpc";
import { expect, test } from "vite-plus/test";
import {
  Capabilities,
  Compile,
  CargoApi,
  FailureFrames,
  LatchExecution,
  LatchIR,
  NativeRpc,
  NativeRunner,
  Plan,
  R,
  Rust,
  SourceArtifacts,
} from "../src/index.ts";
import { emitFunctions, lowerFunctions, lowerLatchFunctions } from "../src/lower.ts";
import type { Computation } from "../src/effect-ir.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const options = { concurrency: "unbounded", discard: true } as const;
const scalar = R.fn([], R.U64, R.Never, () =>
  R.Latch.make(true).pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.succeed(R.U64.literal(7n)).pipe(
        R.Effect.flatMap((value) =>
          R.Latch.whenOpen(owner)(
            R.Log.info("entered").pipe(R.Effect.andThen(R.Effect.succeed(value))),
          ),
        ),
      ),
    ),
  ),
);
const boolean = R.fn([], R.Bool, R.Never, () =>
  R.Latch.make().pipe(
    R.Effect.flatMap((owner) =>
      R.Latch.open(owner).pipe(
        R.Effect.flatMap((opened) =>
          R.Latch.open(owner).pipe(
            R.Effect.flatMap((openedAgain) =>
              R.Latch.close(owner).pipe(
                R.Effect.andThen(R.Latch.release(owner)),
                R.Effect.andThen(R.Latch.isOpen(owner)),
                R.Effect.flatMap((isOpen) =>
                  R.Match.bool(
                    openedAgain,
                    R.Effect.succeed(R.Bool.literal(false)),
                    R.Match.bool(
                      isOpen,
                      R.Effect.succeed(R.Bool.literal(false)),
                      R.Effect.succeed(opened),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  ),
);
const unit = R.fn([], R.Unit, R.Never, () =>
  R.Latch.make(true).pipe(R.Effect.flatMap((owner) => R.Latch.whenOpen(owner, R.Effect.void))),
);
const cohort = R.fn([], R.Unit, R.Never, () =>
  R.Latch.make().pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.all(
        [
          R.Latch.await(owner).pipe(R.Effect.andThen(R.Log.info("first"))),
          R.Latch.await(owner).pipe(R.Effect.andThen(R.Log.info("second"))),
          R.Log.info("producer").pipe(
            R.Effect.andThen(R.Latch.open(owner)),
            R.Effect.andThen(R.Latch.close(owner)),
            R.Effect.asVoid,
          ),
        ],
        options,
      ),
    ),
  ),
);
const timed = R.fn([], R.Unit, R.Never, () =>
  R.Latch.make().pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.all(
        [
          R.Latch.await(owner).pipe(R.Effect.ensuring(R.Effect.sleep(1))),
          R.Effect.sleep(1).pipe(R.Effect.andThen(R.Latch.release(owner)), R.Effect.asVoid),
        ],
        options,
      ),
    ),
  ),
);

test("public Latch exports preserve state transitions, both whenOpen forms and owned observations", async () => {
  expect(LatchIR).toBe(R.Latch);
  expect(Object.keys(LatchIR).sort()).toEqual([
    "await",
    "close",
    "isOpen",
    "make",
    "open",
    "release",
    "whenOpen",
  ]);
  expect(await LatchExecution.run(scalar)).toMatchObject({
    exit: Exit.succeed(7n),
    logs: ["entered"],
  });
  expect((await LatchExecution.run(boolean)).exit).toEqual(Exit.succeed(true));
  expect((await LatchExecution.run(unit)).exit).toEqual(Exit.succeed(undefined));
  expect(await LatchExecution.runWithFrames(scalar)).toMatchObject({
    exit: Exit.succeed({ exit: Exit.succeed(7n), frames: [], omitted: 0 }),
    logs: ["entered"],
  });
  expect(await LatchExecution.run(cohort)).toMatchObject({
    exit: Exit.succeed(undefined),
    logs: ["producer", "first", "second"],
  });
  const cancelled = await LatchExecution.run(scalar, { signal: AbortSignal.abort() });
  expect(Exit.isFailure(cancelled.exit) && Cause.hasInterruptsOnly(cancelled.exit.cause)).toBe(
    true,
  );
  expect(cancelled.logs).toEqual([]);
});

test("public scalar-only Latch requires async capability and emits checked native ownership", async () => {
  const unsupported = await Effect.runPromise(
    Compile.make(R.program({ scalar })).pipe(
      Compile.withTarget(Rust.std),
      Compile.run,
      Effect.exit,
    ),
  );
  expect(Exit.isFailure(unsupported)).toBe(true);
  if (Exit.isFailure(unsupported))
    expect(Cause.findErrorOption(unsupported.cause)).toMatchObject({
      value: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "UNSUPPORTED_CAPABILITY",
            path: Capabilities.AsyncResult.id,
          }),
        ]),
      },
    });
  for (const frames of [FailureFrames.None, FailureFrames.Bounded]) {
    const artifact = await Effect.runPromise(
      Compile.make(R.program({ scalar, boolean, unit, cohort, timed })).pipe(
        Compile.withTarget(Rust.tokio),
        Compile.withSourceArtifacts(SourceArtifacts.None),
        Compile.withFailureFrames(frames),
        Compile.run,
      ),
    );
    expect(artifact.explanation.crates).toContain("tokio@1.53.1");
    expect(artifact.explanation.analysis.capabilities).toContain(Capabilities.AsyncResult);
    const source = artifact.files["src/lib.rs"];
    expect(source).toContain("assert_latch_future_layout");
    expect(source).toContain("latch_all2(");
    expect(source).toContain("latch_all3(");
    expect(source).not.toContain("struct ScanSemaphore");
    expect(source).not.toContain("ScanPermit");
    expect(source).toContain("pub fn r_scalar(ctx: &mut AsyncContext)");
  }
});

test("public Latch compilation refuses unsupported topology and channels before evaluation", async () => {
  const typed = R.fn([], R.Unit, R.Bool, () =>
    R.Latch.make(true).pipe(R.Effect.flatMap(() => R.Effect.fail(R.Bool.literal(true)))),
  );
  const input = R.fn([R.U64], R.Unit, R.Never, (value) =>
    R.Latch.make(true).pipe(R.Effect.flatMap(() => R.Effect.succeed(value).pipe(R.Effect.asVoid))),
  );
  const multiple = R.fn([], R.Unit, R.Never, () =>
    R.Latch.make(true).pipe(
      R.Effect.flatMap(() => R.Latch.make(true).pipe(R.Effect.flatMap(() => R.Effect.void))),
    ),
  );
  const mixed = R.fn([], R.Unit, R.Never, () =>
    R.Latch.make(true).pipe(
      R.Effect.flatMap(() =>
        R.Semaphore.make(1).pipe(
          R.Effect.flatMap((owner) => R.Semaphore.withPermit(owner)(R.Effect.void)),
        ),
      ),
    ),
  );
  const cleanup = R.fn([], R.Unit, R.Never, () =>
    R.Latch.make(true).pipe(
      R.Effect.flatMap((owner) =>
        R.Latch.await(owner).pipe(R.Effect.ensuring(R.Latch.await(owner))),
      ),
    ),
  );
  const nested = R.fn([], R.Unit, R.Never, () =>
    R.Latch.make(true).pipe(
      R.Effect.flatMap((owner) =>
        R.Effect.all(
          [R.Effect.all([R.Latch.await(owner), R.Effect.void], options), R.Effect.void],
          options,
        ),
      ),
    ),
  );
  const race = R.fn([], R.Unit, R.Never, () =>
    R.Latch.make(true).pipe(
      R.Effect.flatMap((owner) => R.Effect.race(R.Latch.await(owner), R.Effect.void)),
    ),
  );
  for (const [work, code] of [
    [typed, "LATCH_STRUCTURAL_PROFILE"],
    [input, "LATCH_STRUCTURAL_PROFILE"],
    [multiple, "LATCH_STRUCTURAL_PROFILE"],
    [mixed, "LATCH_GROWTH_UNACCOUNTED"],
    [cleanup, "LATCH_CLEANUP_AWAIT"],
    [nested, "LATCH_STRUCTURAL_PROFILE"],
    [race, "LATCH_STRUCTURAL_PROFILE"],
  ] as const) {
    const result = await Effect.runPromise(
      Compile.make(R.program({ work })).pipe(
        Compile.withTarget(Rust.tokio),
        Compile.run,
        Effect.exit,
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result))
      expect(Cause.findErrorOption(result.cause)).toMatchObject({
        value: {
          diagnostics: expect.arrayContaining([expect.objectContaining({ code, stage: "check" })]),
        },
      });
  }
});

test("public Latch rejects competing mixed timers and concurrent yields before authored logs", async () => {
  for (const [duration, code] of [
    [2, "LATCH_CONCURRENT_TIMERS"],
    [0, "LATCH_CONCURRENT_YIELD"],
  ] as const) {
    const work = R.fn([], R.Unit, R.Never, () =>
      R.Latch.make(true).pipe(
        R.Effect.flatMap((owner) =>
          R.Log.info("unopened").pipe(
            R.Effect.andThen(
              R.Effect.all(
                [
                  R.Latch.await(owner).pipe(R.Effect.andThen(R.Effect.sleep(1))),
                  R.Effect.sleep(duration),
                ],
                options,
              ),
            ),
          ),
        ),
      ),
    );
    const compiled = await Effect.runPromise(
      Compile.make(R.program({ work })).pipe(
        Compile.withTarget(Rust.tokio),
        Compile.run,
        Effect.exit,
      ),
    );
    const observed = await LatchExecution.run(work);
    expect(observed.logs).toEqual([]);
    const results: readonly Exit.Exit<unknown, unknown>[] = [compiled, observed.exit];
    for (const result of results) {
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Cause.findErrorOption(result.cause)).toMatchObject({
          value: { diagnostics: expect.arrayContaining([expect.objectContaining({ code })]) },
        });
    }
  }
});

test("direct lowering cannot bypass Latch structural checks", () => {
  const work = R.fn([], R.Unit, R.Never, () =>
    R.Latch.make(true).pipe(
      R.Effect.flatMap((owner) =>
        R.Latch.await(owner).pipe(R.Effect.ensuring(R.Latch.await(owner))),
      ),
    ),
  );
  const selected = new Map(
    Rust.tokio.implementations.map((implementation) => [
      implementation.operation.ref,
      implementation,
    ]),
  );
  expect(() => emitFunctions(lowerLatchFunctions(R.program({ work }), selected))).toThrow(
    "Await in masked cleanup",
  );
  expect(() => emitFunctions(lowerFunctions(R.program({ unit }), selected))).toThrow(
    "Latch cohort scheduling",
  );
});

test("manually assembled plans cannot bypass Latch shape or reference budget checks", async () => {
  const sequence = (items: readonly Computation<void>[]): Computation<void> => {
    if (items.length === 1) return items[0];
    const split = Math.floor(items.length / 2);
    return R.Effect.andThen(sequence(items.slice(0, split)), sequence(items.slice(split)));
  };
  const budget = R.fn([], R.Unit, R.Never, () =>
    R.Latch.make().pipe(
      R.Effect.flatMap((owner) => {
        const shared = R.Latch.release(owner).pipe(R.Effect.asVoid);
        return sequence(Array.from({ length: 64 }, () => shared));
      }),
    ),
  );
  const shape = R.fn([], R.Unit, R.Never, () =>
    R.Latch.make(true).pipe(
      R.Effect.flatMap((owner) =>
        R.Latch.await(owner).pipe(R.Effect.ensuring(R.Latch.await(owner))),
      ),
    ),
  );
  const checked = await Effect.runPromise(
    Compile.derive(R.program({ unit })).pipe(
      Effect.flatMap((analysis) => Compile.plan(analysis, Rust.tokio)),
    ),
  );
  for (const [work, code] of [
    [shape, "LATCH_CLEANUP_AWAIT"],
    [budget, "LATCH_BUDGET_EXCEEDED"],
  ] as const) {
    const forged = Plan.make(
      { ...checked.analysis, program: R.program({ work }) },
      checked.target,
      checked.selections,
      checked.crates,
    );
    const result = await Effect.runPromise(Compile.verify(forged).pipe(Effect.exit));
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result))
      expect(Cause.findErrorOption(result.cause)).toMatchObject({
        value: { diagnostics: expect.arrayContaining([expect.objectContaining({ code })]) },
      });
  }
});

test("public native RPC refuses Latch request context embedding", async () => {
  const group = RpcGroup.make(Rpc.make("Status", { payload: {}, success: Schema.Boolean }));
  const result = await Effect.runPromise(
    NativeRpc.compile(group, { Status: NativeRpc.bind(boolean) }).pipe(Effect.exit),
  );
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result))
    expect(Cause.findErrorOption(result.cause)).toMatchObject({
      value: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("Latch is admitted only for standalone exports"),
          }),
        ]),
      },
    });
});

test(
  "public standalone Latch and independent exports agree after native build",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-latch-public-" });
          const program = R.program({
            scalar,
            boolean,
            unit,
            cohort,
            timed,
            ordinary: R.fn([], R.U64, () => R.U64.literal(11n)),
            deferred: R.fn([], R.U64, R.Never, () =>
              R.Deferred.make(R.U64).pipe(
                R.Effect.flatMap((cell) =>
                  R.Deferred.succeed(cell, R.U64.literal(13n)).pipe(
                    R.Effect.andThen(R.Deferred.await(cell)),
                  ),
                ),
              ),
            ),
            semaphore: R.fn([], R.U64, R.Never, () =>
              R.Semaphore.make(1).pipe(
                R.Effect.flatMap((owner) =>
                  R.Semaphore.withPermit(owner)(R.Effect.succeed(R.U64.literal(17n))),
                ),
              ),
            ),
          });
          for (const frames of [FailureFrames.None, FailureFrames.Bounded]) {
            const artifact = yield* Compile.make(program).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.withFailureFrames(frames),
              Compile.run,
            );
            const source = artifact.files["src/lib.rs"];
            expect(source.match(/struct ScanTasks<const/g)).toHaveLength(1);
            expect(source).toContain("struct CohortLatch");
            expect(source).toContain("struct ScanSemaphore");
            expect(source).toContain("struct DeferredTurns");
            const directory = yield* CargoApi.write(artifact, `${parent}/${frames._tag}`);
            yield* CargoApi.build(directory);
            expect(yield* NativeRunner.run(artifact, directory, "scalar", scalar, [])).toEqual(
              (yield* Effect.promise(() => LatchExecution.run(scalar))).exit,
            );
            expect(yield* NativeRunner.run(artifact, directory, "boolean", boolean, [])).toEqual(
              (yield* Effect.promise(() => LatchExecution.run(boolean))).exit,
            );
            expect(yield* NativeRunner.run(artifact, directory, "unit", unit, [])).toEqual(
              (yield* Effect.promise(() => LatchExecution.run(unit))).exit,
            );
            expect(yield* NativeRunner.run(artifact, directory, "cohort", cohort, [])).toEqual(
              (yield* Effect.promise(() => LatchExecution.run(cohort))).exit,
            );
            expect(yield* NativeRunner.run(artifact, directory, "timed", timed, [])).toEqual(
              (yield* Effect.promise(() => LatchExecution.run(timed))).exit,
            );
            expect(
              yield* NativeRunner.run(
                artifact,
                directory,
                "ordinary",
                program.functions.ordinary,
                [],
              ),
            ).toEqual(Exit.succeed(11n));
            expect(
              yield* NativeRunner.run(
                artifact,
                directory,
                "deferred",
                program.functions.deferred,
                [],
              ),
            ).toEqual(Exit.succeed(13n));
            expect(
              yield* NativeRunner.run(
                artifact,
                directory,
                "semaphore",
                program.functions.semaphore,
                [],
              ),
            ).toEqual(Exit.succeed(17n));
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);
