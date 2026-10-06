import { Effect, Exit, Logger } from "effect";
import { expect, test } from "vite-plus/test";
import { R } from "../src/index.ts";
import {
  Computation,
  EffectReference,
  checkEffectFunction,
  substituteComputation,
} from "../src/effect-ir.ts";
import { Expr } from "../src/kernel.ts";
import { SemaphoreIR as S } from "../src/semaphore.ts";
import { SemaphoreType } from "../src/semaphore-model.ts";

const answer = R.U64.literal(7n);
const guarded = R.fn([], R.U64, R.Never, () =>
  S.make(1).pipe(R.Effect.flatMap((owner) => S.withPermits(owner, 1)(R.Effect.succeed(answer)))),
);

test("private lexical Semaphore preserves plain and framed values", async () => {
  expect(checkEffectFunction(guarded, "guarded")).toEqual([]);
  expect(await Effect.runPromise(EffectReference.run(guarded, []))).toBe(7n);
  const framed = await Effect.runPromise(EffectReference.runWithFrames(guarded, []));
  expect(framed.exit).toEqual(Exit.succeed(7n));
  expect(framed.frames).toEqual([]);
});

test("curried one-permit helper can reuse released capacity", async () => {
  const twice = R.fn([], R.U64, R.Never, () =>
    S.make(1).pipe(
      R.Effect.flatMap((owner) =>
        S.withPermit(owner)(R.Effect.void).pipe(
          R.Effect.andThen(S.withPermit(owner)(R.Effect.succeed(answer))),
        ),
      ),
    ),
  );
  expect(await Effect.runPromise(EffectReference.run(twice, []))).toBe(7n);
});

test("Semaphore constructor and checker refuse invalid domains and escaped owners", () => {
  for (const capacity of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => S.make(capacity)).toThrowError(/positive safe integer/);
  const escaped = R.fn([], SemaphoreType, R.Never, () => S.make(1));
  expect(checkEffectFunction(escaped, "escaped").map((issue) => issue.code)).toContain(
    "RESOURCE_ESCAPE",
  );
  const rogue = Expr.parameter(SemaphoreType, Symbol("unowned"), 0);
  const unowned = R.fn([], R.U64, R.Never, () => S.withPermit(rogue)(R.Effect.succeed(answer)));
  expect(checkEffectFunction(unowned, "unowned").map((issue) => issue.code)).toContain(
    "RESOURCE_ESCAPE",
  );
  expect(() => S.withPermits(rogue, 2)).toThrowError(/exactly one permit/);
  const malformed = R.fn([], R.U64, R.Never, () =>
    Computation.make(R.U64, R.Never, {
      _tag: "SemaphoreScope",
      capacity: 0,
      binder: Symbol("malformed"),
      body: R.Effect.succeed(answer),
    }),
  );
  expect(checkEffectFunction(malformed, "malformed").map((issue) => issue.code)).toContain(
    "TYPE_MISMATCH",
  );
});

test("substitution reaches expressions inside a guarded body without changing its owner", async () => {
  const external = Symbol("external");
  const authored = S.make(1).pipe(
    R.Effect.flatMap((owner) =>
      S.withPermit(owner)(R.Effect.succeed(Expr.parameter(R.U64, external, 0))),
    ),
  );
  const replaced = substituteComputation(authored, external, () => R.U64.literal(19n));
  const fn = R.fn([], R.U64, R.Never, () => replaced as Computation<bigint>);
  expect(checkEffectFunction(fn, "substituted")).toEqual([]);
  expect(await Effect.runPromise(EffectReference.run(fn, []))).toBe(19n);
});

test("each reference run owns an independent semaphore", async () => {
  const fn = R.fn([], R.Unit, R.Never, () =>
    S.make(1).pipe(
      R.Effect.flatMap((owner) =>
        S.withPermit(owner)(
          R.Effect.log("enter").pipe(
            R.Effect.andThen(R.Effect.sleep(20)),
            R.Effect.andThen(R.Effect.log("exit")),
          ),
        ),
      ),
    ),
  );
  const logs: string[] = [];
  await Effect.runPromise(
    Effect.all([EffectReference.run(fn, []), EffectReference.run(fn, [])], {
      concurrency: "unbounded",
      discard: true,
    }).pipe(
      Effect.provideService(
        Logger.CurrentLoggers,
        new Set([
          Logger.make((entry) => {
            logs.push(String(entry.message));
          }),
        ]),
      ),
    ),
  );
  expect(logs).toEqual(["enter", "enter", "exit", "exit"]);
});

test("failure preserves its channel and cleanup finishes before permit reuse", async () => {
  const logs: string[] = [];
  const failed = R.fn([], R.Unit, R.Bool, () =>
    S.make(1).pipe(
      R.Effect.flatMap((owner) =>
        S.withPermit(owner)(
          R.Effect.fail(R.Bool.literal(true)).pipe(R.Effect.ensuring(R.Effect.log("cleanup"))),
        ),
      ),
    ),
  );
  const framed = await Effect.runPromise(
    EffectReference.runWithFrames(failed, [], "functions.failed").pipe(
      Effect.provideService(
        Logger.CurrentLoggers,
        new Set([
          Logger.make((entry) => {
            logs.push(String(entry.message));
          }),
        ]),
      ),
    ),
  );
  expect(logs).toEqual(["cleanup"]);
  expect(
    Exit.isFailure(framed.exit) &&
      framed.exit.cause.reasons.map((reason) =>
        reason._tag === "Fail" ? reason.error : reason._tag,
      ),
  ).toEqual([true]);
  expect(framed.frames.map((item) => item.kind)).toEqual([
    "fail",
    "ensuring",
    "semaphoreWithPermits",
    "semaphoreScope",
    "function",
  ]);
  const recovered = R.fn([], R.Unit, R.Never, () =>
    S.make(1).pipe(
      R.Effect.flatMap((owner) =>
        S.withPermit(owner)(
          R.Effect.fail(R.Bool.literal(true)).pipe(R.Effect.ensuring(R.Effect.log("cleanup"))),
        ).pipe(R.Effect.catchAll(() => S.withPermit(owner)(R.Effect.log("reused")))),
      ),
    ),
  );
  logs.length = 0;
  await Effect.runPromise(
    EffectReference.run(recovered, []).pipe(
      Effect.provideService(
        Logger.CurrentLoggers,
        new Set([
          Logger.make((entry) => {
            logs.push(String(entry.message));
          }),
        ]),
      ),
    ),
  );
  expect(logs).toEqual(["cleanup", "reused"]);
});
