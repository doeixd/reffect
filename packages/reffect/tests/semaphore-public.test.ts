import { Cause, Effect, Exit, FileSystem, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
import { Rpc, RpcGroup } from "effect/rpc";
import { expect, test } from "vite-plus/test";
import {
  Compile,
  CargoApi,
  FailureFrames,
  NativeRpc,
  NativeRunner,
  R,
  Rust,
  SemaphoreExecution,
  SemaphoreIR,
  SourceArtifacts,
} from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const scalar = R.fn([], R.U64, R.Never, () =>
  R.Semaphore.make(1).pipe(
    R.Effect.flatMap((owner) =>
      R.Semaphore.withPermit(owner)(
        R.Log.info("entered").pipe(R.Effect.andThen(R.Effect.succeed(R.U64.literal(7n)))),
      ),
    ),
  ),
);
const boolean = R.fn([], R.Bool, R.Never, () =>
  R.Semaphore.make(2).pipe(
    R.Effect.flatMap((owner) =>
      R.Semaphore.withPermits(owner, 1)(R.Effect.succeed(R.Bool.literal(true))),
    ),
  ),
);
const unit = R.fn([], R.Unit, R.Never, () =>
  R.Semaphore.make(3).pipe(
    R.Effect.flatMap((owner) => R.Semaphore.withPermit(owner)(R.Effect.void)),
  ),
);

test("public Semaphore exports preserve curried permits and owned scalar observations", async () => {
  expect(SemaphoreIR).toBe(R.Semaphore);
  expect(Object.keys(SemaphoreIR).sort()).toEqual(["make", "withPermit", "withPermits"]);
  expect(await SemaphoreExecution.run(scalar)).toMatchObject({
    exit: Exit.succeed(7n),
    logs: ["entered"],
  });
  expect((await SemaphoreExecution.run(boolean)).exit).toEqual(Exit.succeed(true));
  expect((await SemaphoreExecution.run(unit)).exit).toEqual(Exit.succeed(undefined));
  expect(await SemaphoreExecution.runWithFrames(scalar)).toMatchObject({
    exit: Exit.succeed({ exit: Exit.succeed(7n), frames: [], omitted: 0 }),
    logs: ["entered"],
  });
  const cancelled = await SemaphoreExecution.run(scalar, { signal: AbortSignal.abort() });
  expect(Exit.isFailure(cancelled.exit) && Cause.hasInterruptsOnly(cancelled.exit.cause)).toBe(
    true,
  );
  expect(cancelled.logs).toEqual([]);
});

test("public compilation emits independent Semaphore, Deferred and ordinary exports", async () => {
  const program = R.program({
    scalar,
    boolean,
    unit,
    ordinary: R.fn([], R.U64, () => R.U64.literal(11n)),
    deferred: R.fn([], R.Unit, R.Never, () =>
      R.Deferred.make(R.Unit).pipe(
        R.Effect.flatMap((cell) =>
          R.Deferred.succeed(cell, R.Unit.literal()).pipe(R.Effect.andThen(R.Deferred.await(cell))),
        ),
      ),
    ),
  });
  for (const frames of [FailureFrames.None, FailureFrames.Bounded]) {
    const artifact = await Effect.runPromise(
      Compile.make(program).pipe(
        Compile.withTarget(Rust.tokio),
        Compile.withSourceArtifacts(SourceArtifacts.None),
        Compile.withFailureFrames(frames),
        Compile.run,
      ),
    );
    expect(artifact.explanation.crates).toContain("tokio@1.53.1");
    const source = artifact.files["src/lib.rs"];
    expect(source).toContain("pub fn r_scalar");
    expect(source).toContain("pub fn r_boolean");
    expect(source).toContain("pub fn r_unit");
    expect(source).toContain("r_ordinary");
    expect(source).toContain("pub fn r_deferred");
    expect(source).toContain("assert_semaphore_future_layout");
    expect(source).toContain("assert_deferred_future_layout");
  }
});

test("public compilation admits unnested All2 and All3 with one lexical owner", async () => {
  for (const children of [2, 3]) {
    const work = R.fn([], R.Unit, R.Never, () =>
      R.Semaphore.make(1).pipe(
        R.Effect.flatMap((owner) => {
          const timed = R.Semaphore.withPermit(owner)(R.Effect.sleep(1));
          const immediate = R.Semaphore.withPermit(owner)(R.Effect.void);
          return children === 2
            ? R.Effect.all([timed, immediate], { concurrency: "unbounded", discard: true })
            : R.Effect.all([timed, immediate, immediate], {
                concurrency: "unbounded",
                discard: true,
              });
        }),
      ),
    );
    const artifact = await Effect.runPromise(
      Compile.make(R.program({ work })).pipe(Compile.withTarget(Rust.tokio), Compile.run),
    );
    expect(artifact.files["src/lib.rs"]).toContain(`scan_all${children}(`);
    expect((await SemaphoreExecution.run(work)).exit).toEqual(Exit.succeed(undefined));
  }
});

test("public compilation refuses unsupported Semaphore topology and channels", async () => {
  const capacity = R.fn([], R.Unit, R.Never, () =>
    R.Semaphore.make(4).pipe(R.Effect.flatMap(() => R.Effect.void)),
  );
  const typed = R.fn([], R.Unit, R.Bool, () =>
    R.Semaphore.make(1).pipe(
      R.Effect.flatMap((owner) =>
        R.Semaphore.withPermit(owner)(R.Effect.fail(R.Bool.literal(true))),
      ),
    ),
  );
  const nested = R.fn([], R.Unit, R.Never, () =>
    R.Semaphore.make(1).pipe(
      R.Effect.flatMap((owner) =>
        R.Semaphore.withPermit(owner)(R.Semaphore.withPermit(owner)(R.Effect.void)),
      ),
    ),
  );
  const mixed = R.fn([], R.Unit, R.Never, () =>
    R.Semaphore.make(1).pipe(
      R.Effect.flatMap((owner) =>
        R.Semaphore.withPermit(owner)(
          R.Deferred.make(R.Unit).pipe(
            R.Effect.flatMap((cell) =>
              R.Deferred.succeed(cell, R.Unit.literal()).pipe(
                R.Effect.andThen(R.Deferred.await(cell)),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  for (const work of [capacity, typed, nested, mixed]) {
    const result = await Effect.runPromise(Compile.run(R.program({ work })).pipe(Effect.exit));
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result))
      expect(Cause.findErrorOption(result.cause)).toMatchObject({
        value: {
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: "SEMAPHORE_STRUCTURAL_PROFILE", stage: "check" }),
          ]),
        },
      });
  }
});

test("public compiler and owned execution refuse independently timed All children", async () => {
  const work = R.fn([], R.Unit, R.Never, () =>
    R.Semaphore.make(2).pipe(
      R.Effect.flatMap((owner) =>
        R.Effect.all(
          [
            R.Semaphore.withPermit(owner)(
              R.Log.info("unopened").pipe(R.Effect.andThen(R.Effect.sleep(1))),
            ),
            R.Semaphore.withPermit(owner)(R.Effect.void.pipe(R.Effect.ensuring(R.Effect.sleep(1)))),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      ),
    ),
  );
  const compiled = await Effect.runPromise(Compile.run(R.program({ work })).pipe(Effect.exit));
  const observed = await SemaphoreExecution.run(work);
  expect(observed.logs).toEqual([]);
  const results: readonly Exit.Exit<unknown, unknown>[] = [compiled, observed.exit];
  for (const result of results) {
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result))
      expect(Cause.findErrorOption(result.cause)).toMatchObject({
        value: {
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: "SEMAPHORE_CONCURRENT_TIMERS" }),
          ]),
        },
      });
  }
});

test("public native RPC refuses unverified Semaphore request-context embedding", async () => {
  const group = RpcGroup.make(Rpc.make("Status", { payload: {}, success: Schema.Boolean }));
  const result = await Effect.runPromise(
    NativeRpc.compile(group, { Status: NativeRpc.bind(boolean) }).pipe(Effect.exit),
  );
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result))
    expect(Cause.findErrorOption(result.cause)).toMatchObject({
      value: {
        diagnostics: [
          expect.objectContaining({
            message: expect.stringContaining("Semaphore is admitted only for standalone exports"),
          }),
        ],
      },
    });
});

test(
  "public standalone Semaphore and independent exports agree after native build",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-semaphore-public-" });
          const contended = R.fn([], R.Unit, R.Never, () =>
            R.Semaphore.make(1).pipe(
              R.Effect.flatMap((owner) =>
                R.Effect.all(
                  [
                    R.Semaphore.withPermit(owner)(
                      R.Effect.sleep(1).pipe(R.Effect.ensuring(R.Effect.sleep(1))),
                    ),
                    R.Semaphore.withPermit(owner)(R.Effect.void),
                    R.Semaphore.withPermit(owner)(R.Effect.void),
                  ],
                  { concurrency: "unbounded", discard: true },
                ),
              ),
            ),
          );
          const program = R.program({
            scalar,
            boolean,
            unit,
            contended,
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
          });
          for (const frames of [FailureFrames.None, FailureFrames.Bounded]) {
            const artifact = yield* Compile.make(program).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.withFailureFrames(frames),
              Compile.run,
            );
            const directory = yield* CargoApi.write(artifact, `${parent}/${frames._tag}`);
            yield* CargoApi.build(directory);
            expect(yield* NativeRunner.run(artifact, directory, "scalar", scalar, [])).toEqual(
              (yield* Effect.promise(() => SemaphoreExecution.run(scalar))).exit,
            );
            expect(yield* NativeRunner.run(artifact, directory, "boolean", boolean, [])).toEqual(
              (yield* Effect.promise(() => SemaphoreExecution.run(boolean))).exit,
            );
            expect(yield* NativeRunner.run(artifact, directory, "unit", unit, [])).toEqual(
              (yield* Effect.promise(() => SemaphoreExecution.run(unit))).exit,
            );
            expect(
              yield* NativeRunner.run(artifact, directory, "contended", contended, []),
            ).toEqual((yield* Effect.promise(() => SemaphoreExecution.run(contended))).exit);
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
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);
