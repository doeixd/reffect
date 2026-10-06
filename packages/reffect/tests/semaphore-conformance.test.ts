import { Cause, Effect, Exit, Fiber, Logger, Semaphore } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vite-plus/test";
import { Compile, R, Reference, Rust } from "../src/index.ts";
import { SemaphoreIR as S } from "../src/semaphore.ts";
import { lowerFunctions } from "../src/lower.ts";

const options = { concurrency: "unbounded", discard: true } as const;
const work = R.fn([], R.Unit, R.Never, () =>
  S.make(1).pipe(
    R.Effect.flatMap((owner) => {
      const child = (n: number) =>
        R.Log.info(`${n}:attempt`).pipe(
          R.Effect.andThen(
            S.withPermit(owner)(
              R.Log.info(`${n}:enter`).pipe(
                R.Effect.andThen(n === 1 ? R.Effect.sleep(10) : R.Effect.void),
                R.Effect.andThen(R.Log.info(`${n}:body-done`)),
                R.Effect.ensuring(
                  n === 1
                    ? R.Log.info("1:cleanup-start").pipe(
                        R.Effect.andThen(R.Effect.sleep(20)),
                        R.Effect.andThen(R.Log.info("1:cleanup-done")),
                      )
                    : R.Log.info(`${n}:cleanup`),
                ),
              ),
            ),
          ),
          R.Effect.andThen(R.Log.info(`${n}:after-release`)),
        );
      return R.Effect.all([child(1), child(2), child(3)], options);
    }),
  ),
);
const official = Effect.flatMap(Semaphore.make(1), (owner) =>
  Effect.all(
    [1, 2, 3].map((n) =>
      Effect.logInfo(`${n}:attempt`).pipe(
        Effect.andThen(
          owner.withPermit(
            Effect.logInfo(`${n}:enter`).pipe(
              Effect.andThen(n === 1 ? Effect.sleep(10) : Effect.void),
              Effect.andThen(Effect.logInfo(`${n}:body-done`)),
              Effect.ensuring(
                n === 1
                  ? Effect.logInfo("1:cleanup-start").pipe(
                      Effect.andThen(Effect.sleep(20)),
                      Effect.andThen(Effect.logInfo("1:cleanup-done")),
                    )
                  : Effect.logInfo(`${n}:cleanup`),
              ),
            ),
          ),
        ),
        Effect.andThen(Effect.logInfo(`${n}:after-release`)),
      ),
    ),
    options,
  ),
);

const observe = async (effect: Effect.Effect<unknown, unknown>, cancel: boolean) => {
  const logs: string[] = [];
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(effect);
      yield* Effect.yieldNow;
      expect(logs).toEqual(["1:attempt", "1:enter", "2:attempt", "3:attempt"]);
      if (cancel) {
        const interrupted = yield* Effect.forkChild(Fiber.interrupt(fiber));
        yield* Effect.yieldNow;
        expect(logs.at(-1)).toBe("1:cleanup-start");
        yield* TestClock.adjust(20);
        yield* Fiber.join(interrupted);
      } else {
        yield* TestClock.adjust(10);
        expect(logs.at(-1)).toBe("1:cleanup-start");
        expect(logs).not.toContain("2:enter");
        yield* TestClock.adjust(20);
      }
      return yield* Fiber.await(fiber);
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provide(Logger.layer([Logger.make((event) => logs.push(String(event.message)))])),
    ),
  );
  return { logs, interrupted: Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) };
};

test("scoped permit cleanup precedes scheduled reuse across three authored children", async () => {
  const oracle = await observe(official, false);
  expect(await observe(Reference.run(work, []), false)).toEqual(oracle);
  expect(await observe(Reference.runWithFrames(work, []), false)).toEqual(oracle);
  expect(oracle.logs.indexOf("1:cleanup-done")).toBeLessThan(oracle.logs.indexOf("2:enter"));
  expect(oracle.logs.indexOf("1:after-release")).toBeLessThan(oracle.logs.indexOf("2:enter"));
  expect(oracle.interrupted).toBe(false);
});
test("parent interruption cancels queued children and awaits held permit cleanup", async () => {
  const oracle = await observe(official, true);
  expect(await observe(Reference.run(work, []), true)).toEqual(oracle);
  expect(oracle.interrupted).toBe(true);
  expect(oracle.logs).not.toContain("2:enter");
  expect(oracle.logs).not.toContain("3:enter");
  expect(oracle.logs.at(-1)).toBe("1:cleanup-done");
});
test("reference support and raw experiments cannot bypass native admission", async () => {
  const refused = await Effect.runPromise(
    Compile.make(R.program({ work })).pipe(
      Compile.withTarget(Rust.tokio),
      Compile.run,
      Effect.exit,
    ),
  );
  expect(refused).toMatchObject({
    cause: {
      reasons: [
        {
          error: {
            diagnostics: [
              expect.objectContaining({ code: "SEMAPHORE_NATIVE_INTEGRATION", stage: "plan" }),
            ],
          },
        },
      ],
    },
  });
  expect(() => lowerFunctions(R.program({ work }), new Map())).toThrowError(/Semaphore/);
});
