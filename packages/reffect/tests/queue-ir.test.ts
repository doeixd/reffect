import { Cause, Effect, Exit, Fiber, Logger, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { R, Compile, Rust, Reference } from "../src/index.ts";
import {
  Computation,
  EffectReference,
  PrivateEffectReference,
  checkEffectFunction,
  substituteComputation,
  isAsyncComputation,
} from "../src/effect-ir.ts";
import {
  CompileError,
  Expr,
  IRType,
  Operation,
  SemanticRef,
  Targets,
  checkExpression,
  checkFunction,
} from "../src/kernel.ts";
import { QueueIR as Q } from "../src/queue.ts";
import { QueueDoneType, queueType } from "../src/queue-model.ts";
import { analyzeScopes } from "../src/scope-analysis.ts";
import { analyzeTaskGroups } from "../src/structured-concurrency.ts";
import { analyzeDeferredBudget } from "../src/deferred-budget.ts";
import { analyzeSemaphoreBudget } from "../src/semaphore-budget.ts";
import { analyzeGeneratedDeferredProfile } from "../src/deferred-generated-profile.ts";
import { analyzeGeneratedSemaphoreProfile } from "../src/semaphore-generated-profile.ts";
import { analyzeGeneratedLatchProfile } from "../src/latch-generated-profile.ts";
import { lowerFunctions } from "../src/lower.ts";
import { nestingDepth } from "../src/nesting.ts";
import { Provenance } from "../src/provenance.ts";
import { DeferredInterruptionFrames } from "../src/deferred-interruption-frames.ts";

const codes = (work: Parameters<typeof checkEffectFunction>[0]) =>
  checkEffectFunction(work, "work").map((d) => d.code);
const capture = <A, E>(effect: Effect.Effect<A, E>) => {
  const logs: string[] = [];
  return {
    logs,
    run: Effect.runPromise(
      effect.pipe(
        Effect.provideService(
          Logger.CurrentLoggers,
          new Set([
            Logger.make((entry) => {
              logs.push(String(entry.message));
            }),
          ]),
        ),
      ),
    ),
  };
};

test("private Queue builders preserve data-first/data-last offers and fresh lexical state", async () => {
  for (const capacity of [1, 2, 3]) {
    for (const dataLast of [false, true]) {
      const work = R.fn([], R.U64, R.Never, () =>
        Q.make(R.U64, { capacity, strategy: "suspend" }).pipe(
          R.Effect.flatMap((owner) =>
            (dataLast
              ? owner.pipe(Q.offer(R.U64.literal(17n)))
              : Q.offer(owner, R.U64.literal(17n))
            ).pipe(R.Effect.andThen(Q.take(owner))),
          ),
        ),
      );
      expect(codes(work)).toEqual([]);
      for (let invocation = 0; invocation < 2; invocation++) {
        expect(await Effect.runPromise(EffectReference.run(work, []))).toBe(17n);
        expect((await Effect.runPromise(EffectReference.runWithFrames(work, []))).exit).toEqual(
          Exit.succeed(17n),
        );
      }
    }
  }
  const work = R.fn([], R.Bool, R.Never, () =>
    Q.bounded(R.Unit, 1).pipe(R.Effect.flatMap((owner) => Q.shutdown(owner))),
  );
  for (let invocation = 0; invocation < 2; invocation++) {
    expect(await Effect.runPromise(EffectReference.run(work, []))).toBe(true);
    expect((await Effect.runPromise(EffectReference.runWithFrames(work, []))).exit).toEqual(
      Exit.succeed(true),
    );
  }
});

test("Done retains its distinct witness and queued values drain before terminal take", async () => {
  expect(Schema.is(QueueDoneType.schema)(Cause.Done())).toBe(true);
  expect(Schema.is(QueueDoneType.schema)(Cause.Done(1))).toBe(false);
  expect(Schema.is(QueueDoneType.schema)(undefined)).toBe(false);
  const work = R.fn([], R.U64, QueueDoneType, () =>
    Q.bounded(R.U64, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        Q.offer(owner, R.U64.literal(23n)).pipe(
          R.Effect.andThen(Q.end(owner)),
          R.Effect.andThen(Q.take(owner)),
        ),
      ),
    ),
  );
  expect(codes(work)).toEqual([]);
  expect(await Effect.runPromise(EffectReference.run(work, []))).toBe(23n);
  expect((await Effect.runPromise(EffectReference.runWithFrames(work, []))).exit).toEqual(
    Exit.succeed(23n),
  );
  const terminal = R.fn([], R.U64, QueueDoneType, () =>
    Q.bounded(R.U64, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) => Q.end(owner).pipe(R.Effect.andThen(Q.take(owner)))),
    ),
  );
  const ordinary = await Effect.runPromise(EffectReference.run(terminal, []).pipe(Effect.exit));
  const framed = await Effect.runPromise(EffectReference.runWithFrames(terminal, []));
  for (const exit of [ordinary, framed.exit]) {
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(
        exit.cause.reasons.map((reason) => reason._tag === "Fail" && Cause.isDone(reason.error)),
      ).toEqual([true]);
  }
  expect(framed.frames.map((frame) => frame.kind)).toEqual([
    "queueTake",
    "flatMap",
    "queueScope",
    "function",
  ]);
});

test("authoring refuses unsupported capacities, strategies, channels and mismatched offers", () => {
  for (const capacity of [0, -1, 4, 1.5, NaN, Infinity])
    expect(() => Q.bounded(R.Bool, capacity)).toThrow();
  // @ts-expect-error only the suspend strategy is supported
  expect(() => Q.make(R.Bool, { capacity: 1, strategy: "dropping" })).toThrow();
  expect(() => Q.bounded(R.String, 1)).toThrow();
  expect(() => Q.bounded(R.Bool, 1, R.Bool)).toThrow();
  const owner = Expr.parameter(queueType(R.Bool, R.Never), Symbol("owner"), 0);
  // @ts-expect-error the offered expression must match the payload channel
  expect(() => Q.offer(owner, R.U64.literal(1n))).toThrow();
  // @ts-expect-error Never queues do not have the Done capability
  expect(() => Q.end(owner)).toThrow();
  const counterfeit = IRType.make(SemanticRef.type("test/counterfeit-queue"), Schema.Unknown, {
    target: Targets.RustStd,
    type: "__reffect_lexical_queue",
  });
  // Deliberate counterfeit witness: runtime validation must not trust the native marker.
  const forged = Expr.parameter(counterfeit, Symbol("forged"), 0);
  expect(() => Q.take(forged as Expr<import("effect").Queue.Queue<boolean>>)).toThrow();
});

test("handles cannot escape through results, composite values, expression use or public pure reference", async () => {
  const ownerType = queueType(R.Bool, R.Never);
  const escaped = R.fn([], ownerType, R.Never, () => Q.bounded(R.Bool, 1));
  expect(codes(escaped)).toContain("RESOURCE_ESCAPE");
  const retained = R.fn([], ownerType, R.Never, () =>
    Q.bounded(R.Bool, 1).pipe(R.Effect.flatMap((owner) => R.Effect.succeed(owner))),
  );
  expect(codes(retained)).toContain("RESOURCE_ESCAPE");
  const Box = R.Struct({ owner: ownerType });
  const boxed = R.fn([], Box, R.Never, () =>
    Q.bounded(R.Bool, 1).pipe(R.Effect.flatMap((owner) => R.Effect.succeed(Box.make({ owner })))),
  );
  expect(codes(boxed)).toContain("RESOURCE_ESCAPE");
  const rogue = Expr.parameter(ownerType, Symbol("rogue"), 0);
  const work = R.fn([], R.Bool, R.Never, () => Q.take(rogue));
  expect(codes(work)).toContain("RESOURCE_ESCAPE");
  const hidden = R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Bool, 1).pipe(
      R.Effect.flatMap((owner) =>
        R.Effect.succeed(R.Struct.get(Box.make({ owner }), "owner")).pipe(R.Effect.asVoid),
      ),
    ),
  );
  expect(codes(hidden)).toContain("RESOURCE_ESCAPE");
  const pure = R.fn([ownerType], ownerType, (owner) => owner);
  const exit = await Effect.runPromise(Reference.runUnknown(pure, []).pipe(Effect.exit));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit))
    expect(
      exit.cause.reasons.flatMap((reason) =>
        reason._tag === "Fail" ? reason.error.diagnostics.map((d) => d.code) : [],
      ),
    ).toContain("RESOURCE_ESCAPE");
});

test("Queue scopes traverse substitution, provenance, task groups and cleanup lifetime checks", async () => {
  const work = R.fn([R.U64], R.U64, R.Never, (input) =>
    Q.bounded(R.U64, 1).pipe(
      R.Effect.flatMap((owner) => Q.offer(owner, input).pipe(R.Effect.andThen(Q.take(owner)))),
    ),
  );
  expect(codes(work)).toEqual([]);
  expect(await Effect.runPromise(EffectReference.run(work, [31n]))).toBe(31n);
  const external = Symbol("external");
  const body = Q.bounded(R.U64, 1).pipe(
    R.Effect.flatMap((owner) =>
      Q.offer(owner, Expr.parameter(R.U64, external, 0)).pipe(R.Effect.andThen(Q.take(owner))),
    ),
  );
  const replaced = substituteComputation(body, external, () => R.U64.literal(41n));
  expect(
    await Effect.runPromise(
      EffectReference.runUnknown(
        R.fn([], replaced.output, replaced.error, () => replaced),
        [],
      ),
    ),
  ).toBe(41n);
  expect(isAsyncComputation(body)).toBe(true);
  const owner = Expr.parameter(queueType(R.Bool, R.Never), Symbol(), 0);
  expect(isAsyncComputation(Q.offer(owner, R.Bool.literal(true)))).toBe(true);
  expect(isAsyncComputation(Q.take(owner))).toBe(true);
  const children = Q.bounded(R.Unit, 1).pipe(
    R.Effect.flatMap(() =>
      R.Effect.all([R.Clock.currentTimeMillis.pipe(R.Effect.asVoid), R.Effect.void], {
        concurrency: "unbounded",
        discard: true,
      }),
    ),
  );
  const traversal = R.fn([], R.Unit, R.Never, () => children);
  expect(nestingDepth(traversal)).toBeGreaterThan(3);
  expect(analyzeTaskGroups(children).childClockPaths).toEqual(["body.body.children[0].source"]);
  expect(
    new Provenance(R.program({ traversal })).snapshot().occurrences.map((o) => o.path),
  ).toContain("functions.traversal.body.body.children[0].source");
  const escaping = Q.bounded(R.Bool, 1).pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.scoped(R.Effect.addFinalizer(() => Q.shutdown(owner).pipe(R.Effect.asVoid))),
    ),
  );
  expect(analyzeScopes(escaping).diagnostics.map((d) => d.code)).toContain("RESOURCE_ESCAPE");
  const inline = R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Bool, 1).pipe(
      R.Effect.flatMap((owner) =>
        R.Effect.void.pipe(R.Effect.ensuring(Q.shutdown(owner).pipe(R.Effect.asVoid))),
      ),
    ),
  );
  expect(analyzeScopes(inline.body).diagnostics).toEqual([]);
  expect(codes(inline)).toEqual([]);
  expect(await Effect.runPromise(EffectReference.run(inline, []))).toBeUndefined();
});

test("bounded All producer/consumer applies backpressure and preserves consumption order", async () => {
  const work = R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.U64, 1).pipe(
      R.Effect.flatMap((owner) =>
        R.Effect.all(
          [
            Q.offer(owner, R.U64.literal(1n)).pipe(
              R.Effect.andThen(Q.offer(owner, R.U64.literal(2n))),
              R.Effect.asVoid,
            ),
            Q.take(owner).pipe(
              R.Effect.flatMap((first) =>
                R.Match.bool(
                  R.U64.eq(first, R.U64.literal(1n)),
                  R.Log.info("first"),
                  R.Log.info("wrong"),
                ),
              ),
              R.Effect.andThen(Q.take(owner)),
              R.Effect.flatMap((second) =>
                R.Match.bool(
                  R.U64.eq(second, R.U64.literal(2n)),
                  R.Log.info("second"),
                  R.Log.info("wrong"),
                ),
              ),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        ).pipe(R.Effect.andThen(Q.shutdown(owner)), R.Effect.asVoid),
      ),
    ),
  );
  expect(codes(work)).toEqual([]);
  for (const framed of [false, true]) {
    const observed = capture(
      framed
        ? EffectReference.runWithFrames(work, []).pipe(
            Effect.flatMap((result) =>
              Exit.isSuccess(result.exit) ? Effect.void : Effect.failCause(result.exit.cause),
            ),
          )
        : EffectReference.run(work, []),
    );
    await observed.run;
    expect(observed.logs).toEqual(["first", "second"]);
  }
});

test("blocked offer and take preserve interruption frames and run cancellation cleanup", async () => {
  for (const offering of [false, true]) {
    const work = R.fn([], R.Unit, R.Never, () =>
      Q.bounded(R.Bool, 1).pipe(
        R.Effect.flatMap((owner) =>
          (offering
            ? Q.offer(owner, R.Bool.literal(true)).pipe(
                R.Effect.andThen(Q.offer(owner, R.Bool.literal(false))),
                R.Effect.asVoid,
              )
            : Q.take(owner).pipe(R.Effect.asVoid)
          ).pipe(R.Effect.ensuring(R.Log.info("cleanup"))),
        ),
      ),
    );
    for (const framed of [false, true]) {
      const frames = new DeferredInterruptionFrames();
      frames.claim();
      frames.prepare(work.body, "functions.work.body");
      const observed = capture(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            framed
              ? PrivateEffectReference.runWithFramesUnknown(
                  work,
                  [],
                  "functions.work.body",
                  () => [],
                  frames.root("functions.work.body"),
                )
              : EffectReference.run(work, []),
            { startImmediately: true },
          );
          yield* Fiber.interrupt(fiber);
          return yield* Fiber.await(fiber);
        }),
      );
      const exit = await observed.run;
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(observed.logs).toEqual(["cleanup"]);
      if (framed) {
        const snapshot = frames.snapshot();
        expect(snapshot.frames[0]?.kind).toBe(offering ? "queueOffer" : "queueTake");
        expect(snapshot.frames.map((frame) => frame.kind)).toContain("queueScope");
        expect(snapshot.frames.find((frame) => frame.kind === "queueScope")?.path).toBe(
          "functions.work.body",
        );
        expect(snapshot.frames[0]?.path).toMatch(/^functions\.work\.body\.body\./);
        expect(snapshot.frames.at(-1)?.kind).toBe("function");
        expect(snapshot.omitted).toBe(0);
      }
    }
  }
});

test("native compilation refuses unchecked Queue shapes and generic lowering stays gated", async () => {
  const work = R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Bool, 1).pipe(R.Effect.flatMap(() => R.Log.info("must not run"))),
  );
  const observed = capture(
    Compile.make(R.program({ work })).pipe(
      Compile.withTarget(Rust.tokio),
      Compile.run,
      Effect.exit,
    ),
  );
  const exit = await observed.run;
  expect(observed.logs).toEqual([]);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit))
    expect(
      exit.cause.reasons.flatMap((reason) =>
        reason._tag === "Fail" ? reason.error.diagnostics.map((d) => d.code) : [],
      ),
    ).toContain("QUEUE_STRUCTURAL_PROFILE");
  const selected = new Map(Rust.std.implementations.map((i) => [i.operation.ref, i]));
  let lowerFailure: unknown;
  try {
    lowerFunctions(R.program({ work }), selected);
  } catch (error) {
    lowerFailure = error;
  }
  expect(lowerFailure).toBeInstanceOf(CompileError);
  if (lowerFailure instanceof CompileError)
    expect(lowerFailure.diagnostics.map((d) => d.code)).toContain("QUEUE_NATIVE_UNSUPPORTED");
  expect(analyzeDeferredBudget(work).diagnostics.map((d) => d.code)).toContain(
    "DEFERRED_BUDGET_UNACCOUNTED",
  );
  expect(analyzeSemaphoreBudget(work).diagnostics.map((d) => d.code)).toContain(
    "SEMAPHORE_STRUCTURAL_PROFILE",
  );
  const deferred = R.fn([], R.Unit, R.Never, () =>
    R.Deferred.make(R.Unit).pipe(R.Effect.flatMap(() => work.body)),
  );
  const semaphore = R.fn([], R.Unit, R.Never, () =>
    R.Semaphore.make(1).pipe(R.Effect.flatMap((owner) => R.Semaphore.withPermit(owner)(work.body))),
  );
  const latch = R.fn([], R.Unit, R.Never, () =>
    R.Latch.make(true).pipe(R.Effect.flatMap((owner) => R.Latch.whenOpen(owner, work.body))),
  );
  expect(() => analyzeGeneratedDeferredProfile(R.program({ deferred }))).toThrow();
  expect(() => analyzeGeneratedSemaphoreProfile(R.program({ semaphore }))).toThrow();
  expect(() => analyzeGeneratedLatchProfile(R.program({ latch }))).toThrow();
});

test("manually constructed Queue nodes validate capacity, owner channels and operation contracts", () => {
  const binder = Symbol("owner");
  const scope = <A, E>(body: Computation<A, E>, capacity = 1) =>
    Computation.make(body.output, body.error, {
      _tag: "QueueScope",
      success: R.Bool,
      error: R.Never,
      capacity,
      binder,
      body,
    });
  const malformedOffer = Computation.make(R.Bool, R.Never, {
    _tag: "QueueOperation",
    operation: "Offer",
    success: R.Bool,
    error: R.Never,
    binder,
    value: R.U64.literal(1n),
  });
  const malformedTake = Computation.make(R.Unit, R.Never, {
    _tag: "QueueOperation",
    operation: "Take",
    success: R.Bool,
    error: R.Never,
    binder,
  });
  const endWithoutDone = Computation.make(R.Bool, R.Never, {
    _tag: "QueueOperation",
    operation: "End",
    success: R.Bool,
    error: R.Never,
    binder,
  });
  const foreignChannel = Computation.make(R.U64, R.Never, {
    _tag: "QueueOperation",
    operation: "Take",
    success: R.U64,
    error: R.Never,
    binder,
  });
  const foreignBinder = Computation.make(R.Bool, R.Never, {
    _tag: "QueueOperation",
    operation: "Take",
    success: R.Bool,
    error: R.Never,
    binder: Symbol("other"),
  });
  const invalidContracts: readonly Computation<unknown>[] = [
    malformedOffer,
    malformedTake,
    endWithoutDone,
  ];
  for (const body of invalidContracts) {
    const work = R.fn([], R.Unit, R.Never, () => scope(body).pipe(R.Effect.asVoid));
    expect(codes(work)).toContain("TYPE_MISMATCH");
  }
  const invalidOwners: readonly Computation<unknown>[] = [foreignChannel, foreignBinder];
  for (const body of invalidOwners) {
    const work = R.fn([], R.Unit, R.Never, () => scope(body).pipe(R.Effect.asVoid));
    expect(codes(work)).toContain("RESOURCE_ESCAPE");
  }
  for (const capacity of [0, 4, 1.25]) {
    const work = R.fn([], R.Unit, R.Never, () => scope(R.Effect.void, capacity));
    expect(codes(work)).toContain("TYPE_MISMATCH");
  }
  const unsupportedChannels = R.fn([], R.Unit, R.Never, () =>
    Computation.make(R.Unit, R.Never, {
      _tag: "QueueScope",
      success: R.String,
      error: R.Bool,
      capacity: 1,
      binder,
      body: R.Effect.void,
    }),
  );
  expect(codes(unsupportedChannels)).toContain("TYPE_MISMATCH");
  const malformedMake = R.fn([], queueType(R.Bool, R.Never), R.Never, () =>
    Computation.make(queueType(R.Bool, R.Never), R.Never, {
      _tag: "QueueMake",
      success: R.Bool,
      error: R.Never,
      capacity: 0,
    }),
  );
  expect(codes(malformedMake)).toContain("TYPE_MISMATCH");
  const mismatchedScope = R.fn([], R.Bool, R.Never, () =>
    Computation.make(R.Bool, R.Never, {
      _tag: "QueueScope",
      success: R.Bool,
      error: R.Never,
      capacity: 1,
      binder,
      body: R.Effect.void,
    }),
  );
  expect(codes(mismatchedScope)).toContain("TYPE_MISMATCH");
});

test("shutdown completes a blocked offer with false while take remains interruption", async () => {
  const work = R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Bool, 1).pipe(
      R.Effect.flatMap((owner) =>
        R.Effect.all(
          [
            Q.offer(owner, R.Bool.literal(true)).pipe(
              R.Effect.andThen(Q.offer(owner, R.Bool.literal(false))),
              R.Effect.flatMap((accepted) =>
                R.Match.bool(accepted, R.Log.info("accepted"), R.Log.info("rejected")),
              ),
            ),
            Q.shutdown(owner).pipe(R.Effect.asVoid),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      ),
    ),
  );
  expect(codes(work)).toEqual([]);
  for (const framed of [false, true]) {
    const observed = capture(
      framed
        ? EffectReference.runWithFrames(work, []).pipe(
            Effect.flatMap((result) =>
              Exit.isSuccess(result.exit) ? Effect.void : Effect.failCause(result.exit.cause),
            ),
          )
        : EffectReference.run(work, []),
    );
    await observed.run;
    expect(observed.logs).toEqual(["rejected"]);
  }
  const taking = R.fn([], R.Bool, R.Never, () =>
    Q.bounded(R.Bool, 1).pipe(
      R.Effect.flatMap((owner) => Q.shutdown(owner).pipe(R.Effect.andThen(Q.take(owner)))),
    ),
  );
  const ordinary = await Effect.runPromise(EffectReference.run(taking, []).pipe(Effect.exit));
  const framed = await Effect.runPromise(EffectReference.runWithFrames(taking, []));
  for (const exit of [ordinary, framed.exit])
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
});

test("Done catch within a task child recovers through both official references", async () => {
  const work = R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Bool, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        R.Effect.all(
          [
            Q.end(owner).pipe(R.Effect.asVoid),
            Q.take(owner).pipe(
              R.Effect.asVoid,
              R.Effect.catch(() => R.Effect.void),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      ),
    ),
  );
  expect(codes(work)).toEqual([]);
  expect(await Effect.runPromise(EffectReference.run(work, []))).toBeUndefined();
  expect((await Effect.runPromise(EffectReference.runWithFrames(work, []))).exit).toEqual(
    Exit.succeed(undefined),
  );
});

test("sequential terminal take recovers Done through both official references", async () => {
  const work = R.fn([], R.Bool, R.Never, () =>
    Q.bounded(R.Bool, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        Q.end(owner).pipe(
          R.Effect.andThen(Q.take(owner)),
          R.Effect.catchAll(() => R.Effect.succeed(R.Bool.literal(true))),
        ),
      ),
    ),
  );
  expect(codes(work)).toEqual([]);
  expect(await Effect.runPromise(EffectReference.run(work, []))).toBe(true);
  expect((await Effect.runPromise(EffectReference.runWithFrames(work, []))).exit).toEqual(
    Exit.succeed(true),
  );
});

test("pure Done values and hidden Apply Queue/Done signatures fail before native emission", async () => {
  const done = Expr.literal(QueueDoneType, Cause.Done());
  expect(checkExpression(done, new Map(), "done").map((d) => d.code)).toContain("RESOURCE_ESCAPE");
  const literal = R.fn([], QueueDoneType, () => done);
  const signature = R.fn([QueueDoneType], R.Bool, () => R.Bool.literal(true));
  expect(checkFunction(literal, "literal").map((d) => d.code)).toContain("RESOURCE_ESCAPE");
  expect(checkFunction(signature, "signature").map((d) => d.code)).toContain("RESOURCE_ESCAPE");
  const queueInput = Operation.make(
    SemanticRef.operation("test/hidden-queue-input"),
    [queueType(R.Bool, R.Never)],
    R.Bool,
    () => {
      throw new Error("must not run");
    },
  );
  const doneInput = Operation.make(
    SemanticRef.operation("test/hidden-done-input"),
    [QueueDoneType],
    R.Bool,
    () => {
      throw new Error("must not run");
    },
  );
  // Deliberately omit the private arguments: only the operation signature retains the forbidden marker.
  // @ts-expect-error forged Apply node omits its Queue operand
  const queueExpression = Expr.apply(queueInput);
  // @ts-expect-error forged Apply node omits its Done operand
  const doneExpression = Expr.apply(doneInput);
  for (const expression of [queueExpression, doneExpression])
    expect(checkExpression(expression, new Map(), "hidden").map((d) => d.code)).toContain(
      "RESOURCE_ESCAPE",
    );
  const hiddenQueue = R.fn([], R.Bool, () => queueExpression);
  const hiddenDone = R.fn([], R.Bool, () => doneExpression);
  const selected = new Map(Rust.std.implementations.map((i) => [i.operation.ref, i]));
  for (const program of [
    R.program({ literal }),
    R.program({ signature }),
    R.program({ hiddenQueue }),
    R.program({ hiddenDone }),
  ]) {
    const exit = await Effect.runPromise(
      Compile.make(program).pipe(Compile.withTarget(Rust.tokio), Compile.run, Effect.exit),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(
        exit.cause.reasons.flatMap((reason) =>
          reason._tag === "Fail" ? reason.error.diagnostics.map((d) => d.code) : [],
        ),
      ).toContain("QUEUE_NATIVE_UNSUPPORTED");
    let lowerFailure: unknown;
    try {
      lowerFunctions(program, selected);
    } catch (error) {
      lowerFailure = error;
    }
    expect(lowerFailure).toBeInstanceOf(CompileError);
    if (lowerFailure instanceof CompileError)
      expect(lowerFailure.diagnostics.map((d) => d.code)).toContain("QUEUE_NATIVE_UNSUPPORTED");
  }
});

test("Done recovery after a fallible group or asynchronous finalizer retains its safety gate", () => {
  const group = R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Bool, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        R.Effect.all([Q.end(owner).pipe(R.Effect.asVoid), Q.take(owner).pipe(R.Effect.asVoid)], {
          concurrency: "unbounded",
          discard: true,
        }).pipe(R.Effect.catchAll(() => R.Effect.void)),
      ),
    ),
  );
  expect(codes(group)).toContain("TASK_GROUP_RECOVERY");
  const cleanup = R.fn([], R.Bool, R.Never, () =>
    Q.bounded(R.Bool, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        Q.end(owner).pipe(
          R.Effect.andThen(Q.take(owner)),
          R.Effect.ensuring(R.Effect.sleep(1)),
          R.Effect.catchAll(() => R.Effect.succeed(R.Bool.literal(true))),
        ),
      ),
    ),
  );
  expect(codes(cleanup)).toContain("TASK_GROUP_RETAINED_FAILURE");
});
