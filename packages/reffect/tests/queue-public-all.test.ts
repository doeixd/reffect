import { Cause, Effect, Exit } from "effect";
import { expect, test } from "vite-plus/test";
import {
  Compile,
  CompileError,
  Computation,
  EffectFn,
  Expr,
  FailureFrames,
  FramedExit,
  Plan,
  QueueAllExecution,
  QueueAllObservation,
  QueueDoneType,
  QueueExecution,
  R,
  Rust,
  SourceArtifacts,
  SyncEffects,
} from "../src/index.ts";

const group = <E, E2>(left: Computation<void, E>, right: Computation<void, E2>) =>
  R.Effect.all([left, right], { concurrency: "unbounded", discard: true });
const recovered = (end: boolean) =>
  R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        group(
          R.Queue.take(owner),
          end ? R.Queue.end(owner).pipe(R.Effect.asVoid) : R.Effect.void,
        ).pipe(R.Effect.catch(() => R.Log.info("recovered"))),
      ),
    ),
  );
const work = recovered(true);
const blocked = recovered(false);
const local = R.fn([], R.Unit, R.Never, () =>
  R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
    R.Effect.flatMap((owner) =>
      group(
        R.Queue.take(owner).pipe(R.Effect.catch(() => R.Effect.void)),
        R.Queue.end(owner).pipe(R.Effect.asVoid),
      ),
    ),
  ),
);
const diagnostics = (exit: Exit.Exit<unknown, CompileError | Cause.Done<void>>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.flatMap((reason) =>
        Cause.isFailReason(reason) && reason.error instanceof CompileError
          ? reason.error.diagnostics
          : [],
      )
    : [];

test("public All observation types retain Done independently of the authored Never channel", () => {
  const typed: EffectFn<readonly [], void, never> = work;
  const contracts = async () => {
    const plain: QueueAllObservation<void> = await QueueAllExecution.run(typed);
    const plainExit: Exit.Exit<void, CompileError | Cause.Done<void>> = plain.exit;
    const framed: QueueAllObservation<FramedExit<void, Cause.Done<void>>> =
      await QueueAllExecution.runWithFrames(typed);
    void plainExit;
    void framed;
    void QueueAllExecution.run(
      // @ts-expect-error Root All observation is restricted to Unit results.
      R.fn([], R.Bool, R.Never, () => R.Effect.succeed(R.Bool.literal(true))),
    );
    // @ts-expect-error Root All observation cannot accept function arguments.
    void QueueAllExecution.run(R.fn([R.U64], R.Unit, R.Never, () => R.Effect.void));
    // @ts-expect-error Authored function errors must remain Never.
    void QueueAllExecution.run(R.fn([], R.Unit, QueueDoneType, () => R.Effect.void));
    // @ts-expect-error Retained source Done cannot be silently represented as Never.
    const erased: Exit.Exit<void, CompileError> = plain.exit;
    void erased;
  };
  void contracts;
});

test("public root All recovery passes stages and policies without broadening the local runner", async () => {
  const scalarRecovery = R.fn([], R.Unit, R.Never, () =>
    group(R.Effect.fail(R.U64.literal(7n)).pipe(R.Effect.asVoid), R.Effect.sleep(1)).pipe(
      R.Effect.catch(() => R.Effect.void),
    ),
  );
  const program = R.program({ work, local, scalarRecovery });
  const checked = await Effect.runPromise(Compile.check(program));
  const derived = await Effect.runPromise(Compile.derive(checked));
  expect(derived.types).toContain(QueueDoneType);
  expect(derived.effects).toContain(SyncEffects.QueueEnd);
  const normalized = await Effect.runPromise(Compile.normalize(derived));
  const planned = await Effect.runPromise(Compile.plan(normalized, Rust.tokio));
  expect(await Effect.runPromise(Compile.verify(planned))).toBe(planned);
  for (const frames of [FailureFrames.None, FailureFrames.Bounded])
    for (const artifacts of [SourceArtifacts.None, SourceArtifacts.Full]) {
      const artifact = await Effect.runPromise(
        Compile.make(program).pipe(
          Compile.withTarget(Rust.tokio),
          Compile.withFailureFrames(frames),
          Compile.withSourceArtifacts(artifacts),
          Compile.run,
        ),
      );
      expect(artifact.failureFrames).toBe(frames);
      expect(artifact.sourceArtifacts).toBe(artifacts);
      expect(artifact.files["src/lib.rs"]).not.toContain("__reffect_queue_done_unit");
      expect(artifact.files["src/lib.rs"]!.includes("FrameTrail")).toBe(
        frames === FailureFrames.Bounded,
      );
    }
  const observed = await QueueAllExecution.run(work);
  expect(observed.exit).toEqual(Exit.succeed(undefined));
  expect(observed.logs).toEqual(["recovered"]);
  expect(Object.isFrozen(observed)).toBe(true);
  expect(Object.isFrozen(observed.logs)).toBe(true);
  const framed = await QueueAllExecution.runWithFrames(work);
  expect(framed.exit).toEqual(
    Exit.succeed({ exit: Exit.succeed(undefined), frames: [], omitted: 0 }),
  );
  expect(framed.logs).toEqual(observed.logs);
  expect(Exit.isFailure((await QueueExecution.run(work)).exit)).toBe(true);
  expect((await QueueExecution.run(local)).exit).toEqual(Exit.succeed(undefined));
  for (const unsupported of [local, R.fn([], R.Unit, R.Never, () => R.Effect.void)]) {
    const rejected = await QueueAllExecution.run(unsupported);
    expect(diagnostics(rejected.exit)).toContainEqual(expect.objectContaining({ stage: "check" }));
    expect(rejected.logs).toEqual([]);
  }
});

test("owned All cancellation bypasses recovery and preserves honest interruption observations", async () => {
  const before = await QueueAllExecution.run(work, { signal: AbortSignal.abort() });
  expect(Exit.isFailure(before.exit) && Cause.hasInterruptsOnly(before.exit.cause)).toBe(true);
  expect(before.logs).toEqual([]);
  const controller = new AbortController();
  const pending = QueueAllExecution.run(blocked, { signal: controller.signal });
  controller.abort();
  const interrupted = await pending;
  expect(Exit.isFailure(interrupted.exit) && Cause.hasInterruptsOnly(interrupted.exit.cause)).toBe(
    true,
  );
  expect(interrupted.logs).toEqual([]);
  const framedController = new AbortController();
  const pendingFrames = QueueAllExecution.runWithFrames(blocked, {
    signal: framedController.signal,
  });
  framedController.abort();
  const observed = await pendingFrames;
  expect(Exit.isSuccess(observed.exit)).toBe(true);
  if (Exit.isSuccess(observed.exit)) {
    const framed = observed.exit.value;
    expect(Exit.isFailure(framed.exit) && Cause.hasInterruptsOnly(framed.exit.cause)).toBe(true);
    expect(framed.frames.map(({ kind }) => kind)).toEqual([
      "all",
      "catchAll",
      "queueScope",
      "function",
    ]);
    expect(framed.omitted).toBe(0);
  }
  expect(observed.logs).toEqual([]);
});

test("a checked All receipt cannot authorize outer, sibling or nested recoveries", async () => {
  const escape = R.fn([], R.Unit, QueueDoneType, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        group(R.Queue.take(owner), R.Queue.end(owner).pipe(R.Effect.asVoid)),
      ),
    ),
  );
  const outer = R.fn([], R.Unit, R.Never, () =>
    escape.body.pipe(R.Effect.catch(() => R.Effect.void)),
  );
  const sibling = R.fn([], R.Unit, R.Never, () =>
    group(
      R.Effect.fail(Expr.literal(QueueDoneType, Cause.Done())).pipe(R.Effect.asVoid),
      R.Effect.sleep(1),
    ).pipe(R.Effect.catch(() => R.Effect.void)),
  );
  const nested = R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        group(R.Queue.take(owner), R.Queue.end(owner).pipe(R.Effect.asVoid)).pipe(
          R.Effect.catch(() => group(R.Effect.void, R.Effect.void)),
        ),
      ),
    ),
  );
  const cleanup = R.fn([], R.Unit, R.Never, () => work.body.pipe(R.Effect.ensuring(R.Effect.void)));
  const valid = await Effect.runPromise(
    Compile.derive(R.program({ work })).pipe(
      Effect.flatMap((analysis) => Compile.plan(analysis, Rust.tokio)),
    ),
  );
  for (const [name, invalid] of Object.entries({ escape, outer, sibling, nested, cleanup })) {
    const program = R.program({ work, invalid });
    const result = await Effect.runPromise(Compile.check(program).pipe(Effect.exit));
    expect(diagnostics(result), name).toContainEqual(expect.objectContaining({ stage: "check" }));
    if (name === "sibling")
      expect(diagnostics(result)).toContainEqual(
        expect.objectContaining({ code: "QUEUE_NATIVE_UNSUPPORTED" }),
      );
    const forged = Plan.make(
      { ...valid.analysis, program },
      valid.target,
      valid.selections,
      valid.crates,
    );
    expect(
      diagnostics(await Effect.runPromise(Compile.verify(forged).pipe(Effect.exit))),
    ).toContainEqual(expect.objectContaining({ stage: "check" }));
  }
});
