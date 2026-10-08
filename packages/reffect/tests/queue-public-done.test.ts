import { Cause, Effect, Exit, Queue, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import {
  Compile,
  CompileError,
  Computation,
  Expr,
  FailureFrames,
  IRType,
  Operation,
  Plan,
  QueueDoneType,
  QueueExecution,
  R,
  Rust,
  SemanticRef,
  SourceArtifacts,
  SyncEffects,
} from "../src/index.ts";

const all = (left: Computation<void>, right: Computation<void>) =>
  R.Effect.all([left, right], { concurrency: "unbounded", discard: true });
const completed = R.fn([], R.Bool, R.Never, () =>
  R.Queue.make(R.U64, { capacity: 1, strategy: "suspend" }, QueueDoneType).pipe(
    R.Effect.flatMap((owner) =>
      all(
        R.Queue.take(owner).pipe(
          R.Effect.asVoid,
          R.Effect.catch(() => R.Log.info("done")),
        ),
        R.Queue.end(owner).pipe(
          R.Effect.andThen(R.Queue.end(owner)),
          R.Effect.flatMap((again) =>
            R.Match.bool(again, R.Log.info("wrong"), R.Log.info("already-ended")),
          ),
        ),
      ).pipe(R.Effect.as(R.Bool.literal(true))),
    ),
  ),
);
const diagnostics = (exit: Exit.Exit<unknown, CompileError>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.flatMap((reason) =>
        Cause.isFailReason(reason) ? reason.error.diagnostics : [],
      )
    : [];

test("public Done constructors preserve exact inferred channels and require an explicit witness", () => {
  const defaultQueue: Computation<Queue.Queue<bigint, never>> = R.Queue.bounded(R.U64, 1);
  const doneQueue: Computation<Queue.Queue<bigint, Cause.Done<void>>> = R.Queue.bounded(
    R.U64,
    1,
    QueueDoneType,
  );
  const explicitNever: Computation<Queue.Queue<boolean, never>> = R.Queue.make(
    R.Bool,
    { capacity: 1 },
    R.Never,
  );
  expect(defaultQueue.error).toBe(R.Never);
  expect(doneQueue.error).toBe(R.Never);
  expect(explicitNever.error).toBe(R.Never);
  const forgedDone = IRType.make(
    SemanticRef.type("test/forged-unit-done"),
    Schema.declare(
      (value): value is Cause.Done<void> => Cause.isDone(value) && value.value === undefined,
    ),
    QueueDoneType.native,
  );
  expect(() => R.Queue.bounded(R.U64, 1, forgedDone)).toThrow(/Never\/unit Done/);
  const contracts = () => {
    // @ts-expect-error Explicit completion channels cannot omit their witness.
    R.Queue.make<bigint, Cause.Done<void>>(R.U64, { capacity: 1 });
    // @ts-expect-error Explicit completion channels cannot omit their witness.
    R.Queue.bounded<bigint, Cause.Done<void>>(R.U64, 1);
    // @ts-expect-error Arbitrary scalar errors are not unit Done.
    R.Queue.make(R.U64, { capacity: 1 }, R.Bool);
    const nonUnit = IRType.make(
      SemanticRef.type("test/non-unit-done"),
      Schema.declare(
        (value): value is Cause.Done<number> =>
          Cause.isDone(value) && typeof value.value === "number",
      ),
      QueueDoneType.native,
    );
    // @ts-expect-error Done payloads other than unit remain unsupported.
    R.Queue.bounded(R.U64, 1, nonUnit);
    doneQueue.pipe(
      R.Effect.flatMap((owner) => {
        const take: Computation<bigint, Cause.Done<void>> = R.Queue.take(owner);
        const end: Computation<boolean> = R.Queue.end(owner);
        void take;
        return end;
      }),
    );
  };
  void contracts;
});

test("public End survives every compiler stage with scoped representation and policy independence", async () => {
  const program = R.program({ completed });
  const checked = await Effect.runPromise(Compile.check(program));
  const analysis = await Effect.runPromise(Compile.derive(checked));
  expect(analysis.types).toContain(QueueDoneType);
  expect(analysis.effects).toContain(SyncEffects.QueueEnd);
  const normalized = await Effect.runPromise(Compile.normalize(analysis));
  const planned = await Effect.runPromise(Compile.plan(normalized, Rust.tokio));
  expect(await Effect.runPromise(Compile.verify(planned))).toBe(planned);
  for (const failureFrames of [FailureFrames.None, FailureFrames.Bounded]) {
    for (const sourceArtifacts of [SourceArtifacts.None, SourceArtifacts.Full]) {
      const artifact = await Effect.runPromise(
        Compile.make(program).pipe(
          Compile.withTarget(Rust.tokio),
          Compile.withFailureFrames(failureFrames),
          Compile.withSourceArtifacts(sourceArtifacts),
          Compile.run,
        ),
      );
      expect(artifact.sourceArtifacts).toBe(sourceArtifacts);
      expect(artifact.failureFrames).toBe(failureFrames);
      expect(artifact.files["src/lib.rs"]).not.toContain("__reffect_queue_done_unit");
      expect(artifact.files["src/lib.rs"]!.includes("FrameTrail")).toBe(
        failureFrames === FailureFrames.Bounded,
      );
    }
  }
  const observed = await QueueExecution.run(completed);
  expect(observed.exit).toEqual(Exit.succeed(true));
  expect(observed.logs).toEqual(["done", "already-ended"]);
  expect(Object.isFrozen(observed.logs)).toBe(true);
  const framed = await QueueExecution.runWithFrames(completed);
  expect(framed.exit).toEqual(Exit.succeed({ exit: Exit.succeed(true), frames: [], omitted: 0 }));
  expect(framed.logs).toEqual(observed.logs);
  const preabort = await QueueExecution.run(completed, { signal: AbortSignal.abort() });
  expect(Exit.isFailure(preabort.exit) && Cause.hasInterruptsOnly(preabort.exit.cause)).toBe(true);
  expect(preabort.logs).toEqual([]);
});

test("local Done runner rejects root recovery while compiler preserves exact recovery and marker limits", async () => {
  const uncaught = R.fn([], R.Unit, QueueDoneType, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        R.Effect.all([R.Queue.end(owner).pipe(R.Effect.asVoid), R.Queue.take(owner)], {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    ),
  );
  const rootRecovery = R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        R.Effect.all([R.Queue.end(owner).pipe(R.Effect.asVoid), R.Queue.take(owner)], {
          concurrency: "unbounded",
          discard: true,
        }).pipe(R.Effect.catch(() => R.Effect.void)),
      ),
    ),
  );
  expect(
    Exit.isSuccess(
      await Effect.runPromise(
        Compile.make(R.program({ rootRecovery })).pipe(
          Compile.withTarget(Rust.tokio),
          Compile.run,
          Effect.exit,
        ),
      ),
    ),
  ).toBe(true);
  expect(Exit.isFailure((await QueueExecution.run(rootRecovery)).exit)).toBe(true);
  const outerRecovery = R.fn([], R.Unit, R.Never, () =>
    uncaught.body.pipe(R.Effect.catch(() => R.Effect.void)),
  );
  const cleanup = R.fn([], R.Bool, R.Never, () =>
    completed.body.pipe(R.Effect.ensuring(R.Effect.void)),
  );
  let calls = 0;
  const marker = Operation.make(
    SemanticRef.operation("test/public-end-hidden-done"),
    [QueueDoneType],
    R.Bool,
    () => {
      calls++;
      return true;
    },
  );
  // @ts-expect-error Adversarial Apply omits an operand but retains its forbidden signature.
  const expression = Expr.apply(marker);
  const hidden = R.fn([], R.Bool, () => expression);
  for (const work of [uncaught, outerRecovery, cleanup, hidden]) {
    const result = await Effect.runPromise(
      Compile.make(R.program({ completed, work })).pipe(
        Compile.withTarget(Rust.tokio),
        Compile.run,
        Effect.exit,
      ),
    );
    expect(diagnostics(result).length).toBeGreaterThan(0);
  }
  expect(calls).toBe(0);
  const valid = await Effect.runPromise(
    Compile.derive(R.program({ completed })).pipe(
      Effect.flatMap((analysis) => Compile.plan(analysis, Rust.tokio)),
    ),
  );
  const forged = Plan.make(
    { ...valid.analysis, program: R.program({ outerRecovery }) },
    valid.target,
    valid.selections,
    valid.crates,
  );
  const result = await Effect.runPromise(Compile.verify(forged).pipe(Effect.exit));
  expect(diagnostics(result)).toContainEqual(expect.objectContaining({ stage: "check" }));
});
