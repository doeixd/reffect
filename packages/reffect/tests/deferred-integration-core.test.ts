import { Cause, Deferred, Effect, Exit, Logger } from "effect";
import { expect, test } from "vite-plus/test";
import { R, Reference, IRType, SemanticRef, Operation, Expr } from "../src/index.ts";
import { Computation, checkEffectFunction, isAsyncComputation } from "../src/effect-ir.ts";
import { DeferredIR } from "../src/deferred.ts";
import { containsDeferred, deferredType } from "../src/deferred-model.ts";

const late = R.fn([], R.U64, R.Never, () =>
  R.Effect.flatMap(DeferredIR.make(R.U64), (cell) =>
    DeferredIR.succeed(cell, R.U64.literal(7n)).pipe(
      R.Effect.flatMap((first) =>
        DeferredIR.succeed(R.U64.literal(9n))(cell).pipe(
          R.Effect.flatMap((second) =>
            DeferredIR.await(cell).pipe(
              R.Effect.map((value) =>
                R.U64.add(
                  value,
                  R.U64.add(
                    R.Match.bool(first, R.U64.literal(10n), R.U64.literal(0n)),
                    R.Match.bool(second, R.U64.literal(100n), R.U64.literal(0n)),
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
const fail = R.fn([], R.U64, R.Bool, () =>
  R.Effect.flatMap(DeferredIR.make(R.U64, R.Bool), (cell) =>
    DeferredIR.fail(cell, R.Bool.literal(false)).pipe(R.Effect.andThen(DeferredIR.await(cell))),
  ),
);

test("internal lexical Deferred matches official retained completion and losing completion", async () => {
  const oracle = Effect.gen(function* () {
    const cell = yield* Deferred.make<bigint>();
    const first = yield* Deferred.succeed(cell, 7n);
    const second = yield* Deferred.succeed(cell, 9n);
    return (yield* Deferred.await(cell)) + (first ? 10n : 0n) + (second ? 100n : 0n);
  });
  expect(await Effect.runPromise(Reference.run(late, []))).toBe(await Effect.runPromise(oracle));
  expect((await Effect.runPromise(Reference.runWithFrames(late, []))).exit).toEqual(
    Exit.succeed(17n),
  );
  expect(isAsyncComputation(late.body)).toBe(true);
  expect(checkEffectFunction(late, "late")).toEqual([]);
});

test("failed await produces waiter frames rather than retaining completion provenance", async () => {
  const official = Effect.gen(function* () {
    const cell = yield* Deferred.make<bigint, boolean>();
    yield* Deferred.fail(cell, false);
    return yield* Deferred.await(cell);
  });
  const reference = await Effect.runPromise(Effect.exit(Reference.run(fail, [])));
  const expected = await Effect.runPromise(Effect.exit(official));
  expect(
    Exit.isFailure(reference) &&
      reference.cause.reasons.map((reason) =>
        reason._tag === "Fail" ? reason.error : reason._tag,
      ),
  ).toEqual(
    Exit.isFailure(expected) &&
      expected.cause.reasons.map((reason) => (reason._tag === "Fail" ? reason.error : reason._tag)),
  );
  const framed = await Effect.runPromise(Reference.runWithFrames(fail, [], "functions.failed"));
  expect(Exit.isFailure(framed.exit) && Cause.hasFails(framed.exit.cause)).toBe(true);
  expect(framed.frames.some((frame) => frame.kind === "deferredAwait")).toBe(true);
  expect(framed.frames.some((frame) => frame.path.includes(".source"))).toBe(false);
});

test("owner handles cannot escape, and raw operations require the exact live channels", () => {
  const allocation = DeferredIR.make(R.U64);
  const escaped = R.fn([], allocation.output, R.Never, () => allocation);
  expect(
    checkEffectFunction(escaped, "escape").some((issue) => issue.code === "RESOURCE_ESCAPE"),
  ).toBe(true);
  const foreign = R.fn([], R.U64, R.Never, () =>
    Computation.make(R.U64, R.Never, {
      _tag: "DeferredAwait",
      binder: Symbol("foreign"),
      success: R.U64,
      error: R.Never,
    }),
  );
  expect(
    checkEffectFunction(foreign, "foreign").some((issue) => issue.code === "RESOURCE_ESCAPE"),
  ).toBe(true);
  const wrong = R.fn([], R.Bool, R.Never, () =>
    R.Effect.flatMap(allocation, (cell) => {
      if (cell.node._tag !== "Parameter") throw new Error("Expected binder");
      return Computation.make(R.Bool, R.Never, {
        _tag: "DeferredIsDone",
        binder: cell.node.binder,
        success: R.Bool,
        error: R.Never,
      });
    }),
  );
  expect(
    checkEffectFunction(wrong, "wrong").some((issue) => issue.code === "RESOURCE_ESCAPE"),
  ).toBe(true);
  expect(containsDeferred(R.Array(deferredType(R.U64, R.Never)))).toBe(true);
  expect(() => DeferredIR.make(R.String)).toThrow();
});

test("isDone changes only after first completion and lexical witnesses cannot be forged", async () => {
  const query = R.fn([], R.Bool, R.Never, () =>
    R.Effect.flatMap(DeferredIR.make(R.Unit), (cell) =>
      DeferredIR.isDone(cell).pipe(
        R.Effect.flatMap((before) =>
          DeferredIR.succeed(cell, R.Unit.literal()).pipe(
            R.Effect.andThen(DeferredIR.isDone(cell)),
            R.Effect.map((after) => R.Boolean.and(R.Bool.not(before), after)),
          ),
        ),
      ),
    ),
  );
  expect(await Effect.runPromise(Reference.run(query, []))).toBe(true);
  const real = deferredType(R.U64, R.Never);
  const forged = IRType.make(SemanticRef.type("test/forged-deferred@1"), real.schema, {
    ...real.native,
  });
  expect(containsDeferred(forged)).toBe(true);
  expect(containsDeferred(R.Struct({ nested: R.Array(forged) }))).toBe(true);
  const opaque = Operation.make(
    SemanticRef.operation("test/consume-deferred@1"),
    [real],
    R.Bool,
    () => true,
  );
  const consumed = R.fn([], R.Bool, R.Never, () =>
    R.Effect.flatMap(DeferredIR.make(R.U64), (cell) => R.Effect.succeed(Expr.apply(opaque, cell))),
  );
  expect(
    checkEffectFunction(consumed, "consumed").some((issue) => issue.code === "RESOURCE_ESCAPE"),
  ).toBe(true);
});

test("official reference broadcasts resumed prefixes before producer continuation", async () => {
  const trace = R.fn([], R.Unit, R.Never, () =>
    R.Effect.flatMap(DeferredIR.make(R.U64), (cell) =>
      R.Effect.all(
        [
          DeferredIR.await(cell).pipe(R.Effect.andThen(R.Log.info("waiter:one"))),
          DeferredIR.await(cell).pipe(R.Effect.andThen(R.Log.info("waiter:two"))),
          DeferredIR.succeed(cell, R.U64.literal(7n)).pipe(
            R.Effect.andThen(R.Log.info("producer")),
          ),
        ],
        { concurrency: "unbounded", discard: true },
      ),
    ),
  );
  const oracle = Effect.gen(function* () {
    const cell = yield* Deferred.make<bigint>();
    yield* Effect.all(
      [
        Deferred.await(cell).pipe(Effect.andThen(Effect.logInfo("waiter:one"))),
        Deferred.await(cell).pipe(Effect.andThen(Effect.logInfo("waiter:two"))),
        Deferred.succeed(cell, 7n).pipe(Effect.andThen(Effect.logInfo("producer"))),
      ],
      { concurrency: "unbounded", discard: true },
    );
  });
  const observe = async (effect: Effect.Effect<unknown, unknown>) => {
    const logs: string[] = [];
    await Effect.runPromise(
      effect.pipe(
        Effect.provide(Logger.layer([Logger.make((event) => logs.push(String(event.message)))])),
      ),
    );
    return logs;
  };
  const expected = await observe(oracle);
  expect(expected).toEqual(["waiter:one", "waiter:two", "producer"]);
  expect(await observe(Reference.run(trace, []))).toEqual(expected);
  expect(await observe(Reference.runWithFrames(trace, []))).toEqual(expected);
});
