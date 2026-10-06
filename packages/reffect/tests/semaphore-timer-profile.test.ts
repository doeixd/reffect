import { Cause, Effect, Exit } from "effect";
import { expect, test } from "vite-plus/test";
import { Compile, R, Rust, SemaphoreExecution } from "../src/index.ts";
import { Computation, matchComputation } from "../src/effect-ir.ts";
import type { EffectFn } from "../src/effect-ir.ts";
import type { Expr } from "../src/kernel.ts";
import { CompileError } from "../src/kernel.ts";
import { analyzeGeneratedSemaphoreProfile } from "../src/semaphore-generated-profile.ts";

const all = (
  children:
    | readonly [Computation<void>, Computation<void>]
    | readonly [Computation<void>, Computation<void>, Computation<void>],
) => R.Effect.all(children, { concurrency: "unbounded", discard: true });
const lexical = (
  build: (owner: Expr<import("effect").Semaphore.Semaphore>) => Computation<void>,
  capacity = 1,
) => R.fn([], R.Unit, R.Never, () => R.Semaphore.make(capacity).pipe(R.Effect.flatMap(build)));
const profile = (work: EffectFn) =>
  analyzeGeneratedSemaphoreProfile(R.program({ work })).get(work)!;
const refusal = (work: EffectFn, code: string) => {
  try {
    profile(work);
    expect.fail("Expected checked profile refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(CompileError);
    if (error instanceof CompileError)
      expect(error.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code, stage: "check" })]),
      );
  }
};

test("uniform positive timers admit All2/3 with capacities one through three", async () => {
  for (const capacity of [1, 2, 3]) {
    for (const width of [2, 3]) {
      const work = lexical((owner) => {
        const timed = R.Semaphore.withPermit(owner)(R.Effect.sleep(1));
        return width === 2 ? all([timed, timed]) : all([timed, timed, timed]);
      }, capacity);
      const receipt = profile(work);
      expect(receipt.taskCapacity).toBe(width + 1);
      expect(receipt.driver.timerRegistrations).toBe(receipt.bounds.computationOccurrences);
      expect(Number.isSafeInteger(receipt.driver.timerRegistrations)).toBe(true);
      expect((await SemaphoreExecution.run(work)).exit).toEqual(Exit.succeed(undefined));
      const artifact = await Effect.runPromise(
        Compile.make(R.program({ work })).pipe(Compile.withTarget(Rust.tokio), Compile.run),
      );
      expect(artifact.files["src/lib.rs"]).toContain(`scan_all${width}(`);
    }
  }
});

test("uniformity includes every source branch, renewed sleep and masked finalizer", () => {
  const work = lexical((owner) => {
    const branches = matchComputation(R.Bool.literal(true), R.Effect.sleep(2), R.Effect.sleep(2));
    const timed = branches.pipe(
      R.Effect.andThen(R.Effect.sleep(2)),
      R.Effect.ensuring(R.Effect.sleep(2)),
    );
    return all([R.Semaphore.withPermit(owner)(timed), R.Effect.sleep(2)]);
  });
  expect(profile(work).driver.timerRegistrations).toBeGreaterThanOrEqual(5);
  for (const timed of [
    matchComputation(R.Bool.literal(true), R.Effect.sleep(2), R.Effect.sleep(3)),
    R.Effect.sleep(2).pipe(R.Effect.ensuring(R.Effect.sleep(3))),
    R.Effect.sleep(2).pipe(R.Effect.andThen(R.Effect.sleep(3))),
  ]) {
    refusal(
      lexical(() => all([timed, R.Effect.sleep(2)])),
      "SEMAPHORE_CONCURRENT_TIMERS",
    );
  }
});

test("one timer-bearing child retains arbitrary positive sequential durations", () => {
  const work = lexical((owner) =>
    all([
      R.Semaphore.withPermit(owner)(
        R.Effect.sleep(1).pipe(
          R.Effect.andThen(R.Effect.sleep(2)),
          R.Effect.ensuring(R.Effect.sleep(3)),
        ),
      ),
      R.Semaphore.withPermit(owner)(R.Effect.void),
    ]),
  );
  expect(profile(work).taskCapacity).toBe(3);
});

test("zero sleeps in any All child branch or finalizer are refused even without competing timers", () => {
  for (const timed of [
    R.Effect.sleep(0),
    matchComputation(R.Bool.literal(true), R.Effect.void, R.Effect.sleep(0)),
    R.Effect.void.pipe(R.Effect.ensuring(R.Effect.sleep(0))),
  ]) {
    refusal(
      lexical(() => all([timed, R.Effect.void])),
      "SEMAPHORE_CONCURRENT_YIELD",
    );
    refusal(
      lexical(() => all([timed, R.Effect.sleep(1)])),
      "SEMAPHORE_CONCURRENT_YIELD",
    );
  }
});

test("root zero sleep stays admitted before and after an All", async () => {
  const work = lexical((owner) =>
    R.Effect.sleep(0).pipe(
      R.Effect.andThen(all([R.Semaphore.withPermit(owner)(R.Effect.sleep(1)), R.Effect.void])),
      R.Effect.andThen(R.Effect.sleep(0)),
    ),
  );
  expect(profile(work).taskCapacity).toBe(3);
  expect((await SemaphoreExecution.run(work)).exit).toEqual(Exit.succeed(undefined));
  expect(
    await Effect.runPromise(
      Compile.make(R.program({ work })).pipe(
        Compile.withTarget(Rust.tokio),
        Compile.run,
        Effect.exit,
      ),
    ),
  ).toSatisfy(Exit.isSuccess);
});

test("compiler and owned execution refuse mixed and zero timers before logs open", async () => {
  for (const [milliseconds, code] of [
    [2, "SEMAPHORE_CONCURRENT_TIMERS"],
    [0, "SEMAPHORE_CONCURRENT_YIELD"],
  ] as const) {
    const work = lexical((owner) =>
      R.Log.info("unopened root").pipe(
        R.Effect.andThen(
          all([
            R.Semaphore.withPermit(owner)(
              R.Log.info("unopened child").pipe(R.Effect.andThen(R.Effect.sleep(1))),
            ),
            R.Effect.void.pipe(R.Effect.ensuring(R.Effect.sleep(milliseconds))),
          ]),
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
          value: { diagnostics: expect.arrayContaining([expect.objectContaining({ code })]) },
        });
    }
  }
});

test("structural preflight refuses cycles before timer traversal", () => {
  const cyclic: Computation<void> = Computation.make(R.Unit, R.Never, {
    _tag: "Ensuring",
    get body() {
      return cyclic;
    },
    finalizer: R.Effect.sleep(0),
  });
  const work = R.fn([], R.Unit, R.Never, () =>
    Computation.make(R.Unit, R.Never, {
      _tag: "SemaphoreScope",
      capacity: 1,
      binder: Symbol("owner"),
      body: cyclic,
    }),
  );
  refusal(work, "SEMAPHORE_STRUCTURAL_CYCLE");
});
