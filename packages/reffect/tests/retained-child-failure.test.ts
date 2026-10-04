import { Cause, Effect, Exit, Fiber, Logger } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vite-plus/test";
import { Compile, R, Reference, Rust } from "../src/index.ts";
import type { EffectFn } from "../src/index.ts";

const options = { concurrency: "unbounded", discard: true } as const;
const child = () =>
  R.Effect.fail(R.U64.literal(7n)).pipe(
    R.Effect.asVoid,
    R.Effect.ensuring(
      R.Log.info("cleanup:start").pipe(
        R.Effect.andThen(R.Effect.sleep(20)),
        R.Effect.andThen(R.Log.info("cleanup:done")),
      ),
    ),
  );
const retained = R.fn([], R.Unit, R.Never, () =>
  R.Effect.all(
    [child().pipe(R.Effect.catchAll(() => R.Log.info("caught"))), R.Effect.sleep(60000)],
    options,
  ),
);

const observe = (body: Effect.Effect<void, unknown>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events: string[] = [];
        const logger = Logger.layer([Logger.make((event) => events.push(String(event.message)))]);
        const fiber = yield* body.pipe(Effect.provide(logger), Effect.forkScoped);
        yield* TestClock.adjust(0);
        // The log proves cancellation happens after Fail is selected and while
        // its finalizer is suspended, rather than before the child starts.
        expect(events).toEqual(["cleanup:start"]);
        fiber.interruptUnsafe();
        yield* TestClock.adjust(100);
        const exit = yield* Fiber.await(fiber);
        return {
          events,
          reasons: Exit.isSuccess(exit)
            ? ["Success"]
            : exit.cause.reasons.map((reason) => {
                if (Cause.isInterruptReason(reason)) return "Interrupt";
                if (!Cause.isFailReason(reason)) throw new Error("Unexpected defect");
                const error = reason.error;
                const payload =
                  typeof error === "object" && error !== null && "error" in error
                    ? error.error
                    : error;
                return `Fail:${String(payload)}`;
              }),
        };
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

test("a canceled Never child retains the earlier failure and skips typed recovery", async () => {
  // Independently authored: this oracle never reads the R graph.
  const official = Effect.all(
    [
      Effect.fail(7n).pipe(
        Effect.asVoid,
        Effect.ensuring(
          Effect.logInfo("cleanup:start").pipe(
            Effect.andThen(Effect.sleep(20)),
            Effect.andThen(Effect.logInfo("cleanup:done")),
          ),
        ),
        Effect.catch(() => Effect.logInfo("caught")),
      ),
      Effect.sleep(60000),
    ],
    options,
  );
  const expected = {
    events: ["cleanup:start", "cleanup:done"],
    reasons: ["Interrupt", "Fail:7"],
  };
  expect(await observe(official)).toEqual(expected);
  // Reference execution uses the same admission checker. Refusal remains its
  // contract until native storage can represent the retained outcome.
  for (const run of [Reference.run(retained, []), Reference.runWithFrames(retained, [])]) {
    const exit = await Effect.runPromise(run.pipe(Effect.exit));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(Cause.findErrorOption(exit.cause)).toMatchObject({
        value: {
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: "TASK_GROUP_RETAINED_FAILURE" }),
          ]),
        },
      });
  }
});

const compile = <A, E>(name: string, fn: EffectFn<readonly [], A, E>) =>
  Compile.make(R.program({ [name]: fn })).pipe(Compile.withTarget(Rust.tokio), Compile.run);

test("native admission refuses async typed child recovery for changed and unchanged errors", async () => {
  const sameError = R.fn([], R.Unit, R.U64, () =>
    R.Effect.all(
      [
        child().pipe(R.Effect.catchAll((error) => R.Effect.fail(error).pipe(R.Effect.asVoid))),
        R.Effect.sleep(60000),
      ],
      options,
    ),
  );
  for (const fn of [retained, sameError]) {
    const exit = await Effect.runPromise(compile("refused", fn).pipe(Effect.exit));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.findErrorOption(exit.cause)).toMatchObject({
        value: {
          diagnostics: expect.arrayContaining([
            expect.objectContaining({
              code: "TASK_GROUP_RETAINED_FAILURE",
              stage: "check",
              path: "functions.refused.body.children[0]",
            }),
          ]),
        },
      });
    }
  }
});

test("synchronous typed sources and non-failing async child sources remain admitted", async () => {
  const synchronous = R.fn([], R.Unit, R.Never, () =>
    R.Effect.all(
      [
        R.Effect.fail(R.U64.literal(7n)).pipe(
          R.Effect.asVoid,
          R.Effect.catchAll(() => R.Effect.sleep(1)),
        ),
        R.Effect.void,
      ],
      options,
    ),
  );
  const nonFailing = R.fn([], R.Unit, R.Never, () =>
    R.Effect.all(
      [R.Effect.sleep(1).pipe(R.Effect.catchAll(() => R.Effect.void)), R.Effect.void],
      options,
    ),
  );
  for (const fn of [synchronous, nonFailing]) {
    expect(
      await Effect.runPromise(compile("allowed", fn).pipe(Effect.exit)).then(Exit.isSuccess),
    ).toBe(true);
  }
});
