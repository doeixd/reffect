import { getEventListeners } from "node:events";
import { Cause, Effect, Exit } from "effect";
import { expect, test } from "vite-plus/test";
import {
  AsyncEffects,
  Compile,
  CompileError,
  Computation,
  EffectFn,
  FailureFrames,
  FramedExit,
  Plan,
  QueueAllExecution,
  QueueAllObservation,
  QueueCleanupExecution,
  QueueDoneType,
  QueueExecution,
  R,
  Rust,
  SourceArtifacts,
  SyncEffects,
} from "../src/index.ts";

const group = <E, E2>(left: Computation<void, E>, right: Computation<void, E2>) =>
  R.Effect.all([left, right], { concurrency: "unbounded", discard: true });
const seq = <E>(first: Computation<void, E>, next: Computation<void, E>) =>
  first.pipe(R.Effect.andThen(next));
const make = (kind: "retained" | "successful" | "blocked" | "sticky" | "unopened" | "shared") =>
  R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) => {
        const take = R.Queue.take(owner);
        const end = R.Queue.end(owner).pipe(R.Effect.asVoid);
        const terminal = seq(end, take);
        // Positive Sleep suspends inside the mask before the caller aborts. No
        // logger callback, scheduler override or private evaluator is involved.
        const cleanup = seq(
          seq(R.Log.info("cleanup:start"), R.Effect.sleep(20)),
          R.Log.info("cleanup:end"),
        );
        const source =
          kind === "retained"
            ? group(terminal.pipe(R.Effect.ensuring(cleanup)), R.Effect.void)
            : kind === "successful"
              ? group(R.Effect.void.pipe(R.Effect.ensuring(cleanup)), take)
              : kind === "blocked"
                ? group(take.pipe(R.Effect.ensuring(cleanup)), R.Effect.void)
                : kind === "sticky"
                  ? group(R.Effect.void.pipe(R.Effect.ensuring(cleanup)), terminal)
                  : kind === "unopened"
                    ? group(terminal, R.Effect.void.pipe(R.Effect.ensuring(cleanup)))
                    : group(
                        take.pipe(R.Effect.ensuring(cleanup)),
                        R.Effect.void.pipe(R.Effect.ensuring(cleanup)),
                      );
        return source.pipe(R.Effect.catch(() => R.Log.info("recovered")));
      }),
    ),
  );
const work = make("retained");
const all = R.fn([], R.Unit, R.Never, () =>
  R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
    R.Effect.flatMap((owner) =>
      group(R.Queue.take(owner), R.Queue.end(owner).pipe(R.Effect.asVoid)).pipe(
        R.Effect.catch(() => R.Effect.void),
      ),
    ),
  ),
);
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
const ordinary = R.fn([], R.Unit, R.Never, () =>
  R.Queue.bounded(R.Unit, 1).pipe(
    R.Effect.flatMap((owner) =>
      group(R.Queue.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid), R.Queue.take(owner)),
    ),
  ),
);
const diagnostics = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.flatMap((reason) =>
        Cause.isFailReason(reason) && reason.error instanceof CompileError
          ? reason.error.diagnostics
          : [],
      )
    : [];
const interrupted = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause);
const assertDone = (exit: Exit.Exit<unknown, unknown>, expected: boolean) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failures = exit.cause.reasons.filter(Cause.isFailReason);
    expect(failures).toHaveLength(expected ? 1 : 0);
    for (const failure of failures) {
      expect(Cause.isDone(failure.error)).toBe(true);
      if (Cause.isDone(failure.error)) expect(failure.error.value).toBeUndefined();
      expect(failure.error).not.toHaveProperty("error");
      expect(failure.error).not.toHaveProperty("frames");
    }
  }
};
const settledLogs = async (observation: { readonly logs: readonly string[] }) => {
  const atExit = [...observation.logs];
  expect(Object.isFrozen(observation)).toBe(true);
  expect(Object.isFrozen(observation.logs)).toBe(true);
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  expect(observation.logs).toEqual(atExit);
};

test("public cleanup observation types retain canceled Done without changing authored Never", () => {
  const typed: EffectFn<readonly [], void, never> = work;
  const contracts = async () => {
    const plain: QueueAllObservation<void> = await QueueCleanupExecution.run(typed);
    const framed: QueueAllObservation<FramedExit<void, Cause.Done<void>>> =
      await QueueCleanupExecution.runWithFrames(typed);
    // @ts-expect-error Cancellation can retain source Done despite authored Never.
    const erased: Exit.Exit<void, CompileError> = plain.exit;
    void erased;
    void framed;
    void QueueCleanupExecution.run(
      // @ts-expect-error Cleanup observation requires a Unit result.
      R.fn([], R.Bool, R.Never, () => R.Effect.succeed(R.Bool.literal(true))),
    );
    // @ts-expect-error Cleanup observation cannot accept function arguments.
    void QueueCleanupExecution.run(R.fn([R.U64], R.Unit, R.Never, () => R.Effect.void));
    // @ts-expect-error Authored errors must remain Never.
    void QueueCleanupExecution.run(R.fn([], R.Unit, QueueDoneType, () => R.Effect.void));
    // @ts-expect-error The owned context exposes only cancellation, not custom services.
    void QueueCleanupExecution.run(typed, { context: {} });
  };
  void contracts;
});

test("public cleanup passes compiler stages and policies while old runners keep their admission", async () => {
  const program = R.program({ work, ordinary, local, all });
  const checked = await Effect.runPromise(Compile.check(program));
  const derived = await Effect.runPromise(Compile.derive(checked));
  expect(derived.types).toContain(QueueDoneType);
  expect(derived.effects).toContain(SyncEffects.QueueEnd);
  expect(derived.effects).toContain(AsyncEffects.Sleep);
  expect(derived.effects).toContain(AsyncEffects.Ensuring);
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
  const plain = await QueueCleanupExecution.run(work);
  expect(plain.exit).toEqual(Exit.succeed(undefined));
  expect(plain.logs).toEqual(["cleanup:start", "cleanup:end", "recovered"]);
  await settledLogs(plain);
  const framed = await QueueCleanupExecution.runWithFrames(work);
  expect(framed.exit).toEqual(
    Exit.succeed({ exit: Exit.succeed(undefined), frames: [], omitted: 0 }),
  );
  expect(framed.logs).toEqual(plain.logs);
  for (const run of [QueueExecution.run, QueueAllExecution.run]) {
    const refused = await run(work);
    expect(diagnostics(refused.exit)).toContainEqual(expect.objectContaining({ stage: "check" }));
    expect(refused.logs).toEqual([]);
  }
  for (const fn of [ordinary, local, all, R.fn([], R.Unit, R.Never, () => R.Effect.void)]) {
    const refused = await QueueCleanupExecution.run(fn);
    expect(diagnostics(refused.exit)).toContainEqual(
      expect.objectContaining({ code: "QUEUE_EXECUTION_CONTEXT" }),
    );
    expect(refused.logs).toEqual([]);
  }
});

test("natural cleanup cancellation settles masked logs and retains only recorded Done frames", async () => {
  const controller = new AbortController();
  const pending = QueueCleanupExecution.run(work, { signal: controller.signal });
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
  controller.abort();
  const plain = await pending;
  expect(interrupted(plain.exit)).toBe(true);
  assertDone(plain.exit, true);
  expect(plain.logs).toEqual(["cleanup:start", "cleanup:end"]);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  await settledLogs(plain);

  const framedController = new AbortController();
  const pendingFrames = QueueCleanupExecution.runWithFrames(work, {
    signal: framedController.signal,
  });
  framedController.abort();
  const framed = await pendingFrames;
  expect(framed.logs).toEqual(plain.logs);
  expect(Exit.isSuccess(framed.exit)).toBe(true);
  if (Exit.isSuccess(framed.exit)) {
    const result = framed.exit.value;
    expect(interrupted(result.exit)).toBe(true);
    assertDone(result.exit, true);
    // Cancellation bypasses restoration handlers. Their presence in the IR
    // cannot manufacture Ensuring/All/Scope/function frames for this carrier.
    expect(result.frames.map(({ kind }) => kind)).toEqual(["queueTake", "flatMap"]);
    expect(result.omitted).toBe(0);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.frames)).toBe(true);
  }
  await settledLogs(framed);
  for (const run of [QueueCleanupExecution.run, QueueCleanupExecution.runWithFrames]) {
    const preabort = await run(work, { signal: AbortSignal.abort() });
    const exit: Exit.Exit<unknown, CompileError | Cause.Done<void>> = preabort.exit;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(preabort.logs).toEqual([]);
  }
});

test("cleanup settlement covers success, blocked and shared sources without inventing sibling origin", async () => {
  for (const kind of ["successful", "blocked", "shared"] as const) {
    const controller = new AbortController();
    const pending = QueueCleanupExecution.run(make(kind), { signal: controller.signal });
    controller.abort();
    const observation = await pending;
    expect(interrupted(observation.exit), kind).toBe(true);
    assertDone(observation.exit, false);
    const starts = observation.logs.filter((message) => message === "cleanup:start");
    const ends = observation.logs.filter((message) => message === "cleanup:end");
    expect(starts).toHaveLength(kind === "shared" ? 2 : 1);
    expect(ends).toHaveLength(starts.length);
    expect(observation.logs).not.toContain("recovered");
    await settledLogs(observation);
  }
  for (const kind of ["sticky", "unopened"] as const) {
    const observation = await QueueCleanupExecution.run(make(kind));
    expect(observation.exit).toEqual(Exit.succeed(undefined));
    expect(observation.logs).toEqual(
      kind === "unopened" ? ["recovered"] : ["cleanup:start", "cleanup:end", "recovered"],
    );
    await settledLogs(observation);
  }
  // Here the Done source is the plain second child. A canonical first-child
  // cleanup path must not be mistaken for the origin of the retained failure.
  const controller = new AbortController();
  const pending = QueueCleanupExecution.runWithFrames(make("sticky"), {
    signal: controller.signal,
  });
  controller.abort();
  const observation = await pending;
  expect(Exit.isSuccess(observation.exit)).toBe(true);
  if (Exit.isSuccess(observation.exit)) {
    const value = observation.exit.value;
    expect(interrupted(value.exit)).toBe(true);
    assertDone(value.exit, true);
    expect(value.frames.map(({ kind }) => kind)).toEqual(["queueTake", "flatMap"]);
    expect(value.frames.every(({ path }) => path.includes("children[1]"))).toBe(true);
    expect(value.omitted).toBe(0);
  }
  expect(observation.logs).toEqual(["cleanup:start", "cleanup:end"]);
  await settledLogs(observation);
});

test("shared source nodes stay admitted without claiming canonical paths identify invocation origin", async () => {
  const sharedSource = R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) => {
        const terminal = seq(R.Queue.end(owner).pipe(R.Effect.asVoid), R.Queue.take(owner));
        const cleanup = seq(
          seq(R.Log.info("cleanup:start"), R.Effect.sleep(20)),
          R.Log.info("cleanup:end"),
        );
        return group(terminal.pipe(R.Effect.ensuring(cleanup)), terminal).pipe(
          R.Effect.catch(() => R.Log.info("recovered")),
        );
      }),
    ),
  );
  await Effect.runPromise(Compile.check(R.program({ sharedSource })));
  const controller = new AbortController();
  const pending = QueueCleanupExecution.runWithFrames(sharedSource, { signal: controller.signal });
  controller.abort();
  const observation = await pending;
  expect(Exit.isSuccess(observation.exit)).toBe(true);
  if (Exit.isSuccess(observation.exit)) {
    const result = observation.exit.value;
    expect(interrupted(result.exit)).toBe(true);
    assertDone(result.exit, true);
    expect(result.frames.map(({ kind }) => kind)).toEqual(["queueTake", "flatMap"]);
    // The shared node's first registered path is evidence about the node,
    // not an invocation-origin proof and not permission to add Ensuring.
    expect(result.frames.every(({ kind }) => kind !== "ensuring")).toBe(true);
  }
  expect(observation.logs).toEqual(["cleanup:start", "cleanup:end"]);
  await settledLogs(observation);
});

test("cleanup receipts cannot authorize unsafe placement, timers, Queue finalizers or forged plans", async () => {
  const invalid = (
    kind:
      | "second"
      | "sharedSecond"
      | "conditionalSecond"
      | "root"
      | "nested"
      | "handler"
      | "sourceSleep"
      | "zeroSleep"
      | "largeSleep"
      | "queueFinalizer"
      | "shutdown",
  ) =>
    R.fn([], R.Unit, R.Never, () =>
      R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
        R.Effect.flatMap((owner) => {
          const take = R.Queue.take(owner);
          const end = R.Queue.end(owner);
          const terminal = seq(end.pipe(R.Effect.asVoid), take);
          const timer = R.Effect.sleep(1);
          const finalizer =
            kind === "zeroSleep"
              ? R.Effect.sleep(0)
              : kind === "largeSleep"
                ? Computation.make(R.Unit, R.Never, { _tag: "Sleep", milliseconds: 60001 })
                : kind === "queueFinalizer"
                  ? end.pipe(R.Effect.asVoid)
                  : timer;
          const source = kind === "sourceSleep" ? seq(timer, terminal) : terminal;
          const child = source.pipe(R.Effect.ensuring(finalizer));
          const shared = take;
          const second =
            kind === "conditionalSecond"
              ? R.Match.bool(R.Bool.literal(true), take, R.Effect.void)
              : kind === "sharedSecond"
                ? seq(shared, shared)
                : take;
          let body =
            kind === "second" || kind === "sharedSecond" || kind === "conditionalSecond"
              ? group(terminal, second.pipe(R.Effect.ensuring(timer)))
              : kind === "nested"
                ? group(child.pipe(R.Effect.ensuring(R.Effect.void)), R.Effect.void)
                : kind === "shutdown" && end.node._tag === "QueueOperation"
                  ? group(
                      seq(
                        Computation.make(end.output, end.error, {
                          ...end.node,
                          operation: "Shutdown",
                        }).pipe(R.Effect.asVoid),
                        take,
                      ).pipe(R.Effect.ensuring(timer)),
                      R.Effect.void,
                    )
                  : group(child, R.Effect.void);
          if (kind === "root") body = body.pipe(R.Effect.ensuring(timer));
          return body.pipe(
            R.Effect.catch(() =>
              kind === "handler" ? R.Effect.void.pipe(R.Effect.ensuring(timer)) : R.Effect.void,
            ),
          );
        }),
      ),
    );
  const valid = await Effect.runPromise(
    Compile.derive(R.program({ work })).pipe(
      Effect.flatMap((analysis) => Compile.plan(analysis, Rust.tokio)),
    ),
  );
  for (const kind of [
    "second",
    "sharedSecond",
    "conditionalSecond",
    "root",
    "nested",
    "handler",
    "sourceSleep",
    "zeroSleep",
    "largeSleep",
    "queueFinalizer",
    "shutdown",
  ] as const) {
    const fn = invalid(kind);
    const code = kind === "root" ? "TASK_GROUP_RECOVERY" : "QUEUE_STRUCTURAL_PROFILE";
    const program = R.program({ work, invalid: fn });
    const checked = await Effect.runPromise(Compile.check(program).pipe(Effect.exit));
    expect(diagnostics(checked), kind).toContainEqual(
      expect.objectContaining({ code, stage: "check" }),
    );
    const forged = Plan.make(
      { ...valid.analysis, program },
      valid.target,
      valid.selections,
      valid.crates,
    );
    expect(
      diagnostics(await Effect.runPromise(Compile.verify(forged).pipe(Effect.exit))),
      kind,
    ).toContainEqual(expect.objectContaining({ code, stage: "check" }));
    const refused = await QueueCleanupExecution.run(fn);
    expect(diagnostics(refused.exit), kind).toContainEqual(
      expect.objectContaining({ code, stage: "check" }),
    );
    expect(refused.logs).toEqual([]);
  }
  const extraContext = { signal: undefined, context: {} };
  const accessor = {
    get signal(): AbortSignal {
      throw new Error("must not invoke accessor");
    },
  };
  for (const options of [extraContext, accessor]) {
    const refused = await QueueCleanupExecution.run(work, options);
    expect(diagnostics(refused.exit)).toContainEqual(
      expect.objectContaining({ code: "QUEUE_EXECUTION_CONTEXT" }),
    );
    expect(refused.logs).toEqual([]);
  }
});
