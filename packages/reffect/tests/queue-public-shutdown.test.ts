import { getEventListeners } from "node:events";
import { Cause, Effect, Exit } from "effect";
import { expect, test } from "vite-plus/test";
import {
  Compile,
  CompileError,
  Computation,
  EffectFn,
  FailureFrames,
  FramedExit,
  QueueAllExecution,
  QueueAllObservation,
  QueueCleanupExecution,
  QueueDoneType,
  QueueExecution,
  QueueShutdownExecution,
  R,
  Rust,
  SourceArtifacts,
  SyncEffects,
} from "../src/index.ts";

const group = <E, E2>(left: Computation<void, E>, right: Computation<void, E2>) =>
  R.Effect.all([left, right], { concurrency: "unbounded", discard: true });
const seq = <E>(first: Computation<void, E>, next: Computation<void, E>) =>
  first.pipe(R.Effect.andThen(next));
const make = (kind: "done" | "open" | "reverse" | "retained" | "blocked") =>
  R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) => {
        const take = R.Queue.take(owner);
        const end = R.Queue.end(owner).pipe(R.Effect.asVoid);
        const shutdown = owner.pipe(
          R.Queue.shutdown,
          R.Effect.flatMap((changed) =>
            R.Match.bool(changed, R.Log.info("shutdown:true"), R.Log.info("shutdown:false")),
          ),
        );
        const cleanup = seq(
          seq(R.Log.info("cleanup:start"), R.Effect.sleep(20)),
          R.Log.info("cleanup:end"),
        );
        const source =
          kind === "done"
            ? group(seq(seq(end, shutdown), take), R.Effect.void)
            : kind === "reverse"
              ? group(shutdown, take)
              : kind === "retained"
                ? group(seq(end, take).pipe(R.Effect.ensuring(cleanup)), shutdown)
                : kind === "blocked"
                  ? group(take.pipe(R.Effect.ensuring(cleanup)), shutdown)
                  : group(take, shutdown);
        return source.pipe(R.Effect.catch(() => R.Log.info("recovered")));
      }),
    ),
  );
const work = make("done");
const diagnostics = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.flatMap((reason) =>
        Cause.isFailReason(reason) && reason.error instanceof CompileError
          ? reason.error.diagnostics
          : [],
      )
    : [];
const assertInterrupted = (exit: Exit.Exit<unknown, unknown>, done: boolean) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    const failures = exit.cause.reasons.filter(Cause.isFailReason);
    expect(failures).toHaveLength(done ? 1 : 0);
    for (const failure of failures) {
      expect(Cause.isDone(failure.error)).toBe(true);
      if (Cause.isDone(failure.error)) expect(failure.error.value).toBeUndefined();
      expect(failure.error).not.toHaveProperty("error");
      expect(failure.error).not.toHaveProperty("frames");
    }
  }
};
const assertSettled = async (observation: { readonly logs: readonly string[] }) => {
  const snapshot = [...observation.logs];
  expect(Object.isFrozen(observation)).toBe(true);
  expect(Object.isFrozen(observation.logs)).toBe(true);
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  expect(observation.logs).toEqual(snapshot);
};

test("public shutdown types preserve Bool results and retained Done observations", () => {
  const typed: EffectFn<readonly [], void, never> = work;
  const contracts = async () => {
    const plain: QueueAllObservation<void> = await QueueShutdownExecution.run(typed);
    const framed: QueueAllObservation<FramedExit<void, Cause.Done<void>>> =
      await QueueShutdownExecution.runWithFrames(typed);
    // @ts-expect-error Cancellation can retain source Done despite authored Never.
    const erased: Exit.Exit<void, CompileError> = plain.exit;
    void erased;
    void framed;
    void QueueShutdownExecution.run(
      // @ts-expect-error Shutdown observation requires a Unit result.
      R.fn([], R.Bool, R.Never, () => R.Effect.succeed(R.Bool.literal(true))),
    );
    // @ts-expect-error Owned observation cannot accept function arguments.
    void QueueShutdownExecution.run(R.fn([R.U64], R.Unit, R.Never, () => R.Effect.void));
    // @ts-expect-error Authored errors must remain Never.
    void QueueShutdownExecution.run(R.fn([], R.Unit, QueueDoneType, () => R.Effect.void));
    // @ts-expect-error Owned options cannot supply reference services.
    void QueueShutdownExecution.run(typed, { context: {} });
  };
  void contracts;
});

test("public offer-free shutdown passes compiler policies without widening previous runners", async () => {
  const program = R.program({ work });
  const checked = await Effect.runPromise(Compile.check(program));
  const derived = await Effect.runPromise(Compile.derive(checked));
  expect(derived.types).toContain(QueueDoneType);
  expect(derived.effects).toContain(SyncEffects.QueueShutdown);
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
      expect(artifact.files["src/lib.rs"]!.includes("FrameTrail")).toBe(
        frames === FailureFrames.Bounded,
      );
      if (SourceArtifacts.isNone(artifacts)) expect(artifact).not.toHaveProperty("sources");
      else expect(artifact.sources?.ranges.length).toBeGreaterThan(0);
    }
  const plain = await QueueShutdownExecution.run(work);
  expect(plain.exit).toEqual(Exit.succeed(undefined));
  expect(plain.logs).toEqual(["shutdown:false", "recovered"]);
  await assertSettled(plain);
  const framed = await QueueShutdownExecution.runWithFrames(work);
  expect(framed.exit).toEqual(
    Exit.succeed({ exit: Exit.succeed(undefined), frames: [], omitted: 0 }),
  );
  expect(framed.logs).toEqual(plain.logs);
  for (const run of [QueueExecution.run, QueueAllExecution.run, QueueCleanupExecution.run]) {
    const refused = await run(work);
    expect(diagnostics(refused.exit)).toContainEqual(expect.objectContaining({ stage: "check" }));
    expect(refused.logs).toEqual([]);
  }
});

test("open shutdown interrupts in both request orders and waits for entered cleanup", async () => {
  for (const kind of ["open", "reverse", "blocked"] as const) {
    const plain = await QueueShutdownExecution.run(make(kind));
    assertInterrupted(plain.exit, false);
    expect(plain.logs).not.toContain("recovered");
    if (kind === "blocked") {
      expect(plain.logs).toContain("cleanup:start");
      expect(plain.logs).toContain("cleanup:end");
    }
    await assertSettled(plain);
    const framed = await QueueShutdownExecution.runWithFrames(make(kind));
    expect(Exit.isSuccess(framed.exit)).toBe(true);
    if (Exit.isSuccess(framed.exit)) {
      assertInterrupted(framed.exit.value.exit, false);
      expect(framed.exit.value.omitted).toBe(0);
    }
    expect(framed.logs).toEqual(plain.logs);
  }
});

test("caller cancellation waits for masked cleanup and retains recorded Done without private carriers", async () => {
  const retained = make("retained");
  const controller = new AbortController();
  const pending = QueueShutdownExecution.run(retained, { signal: controller.signal });
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
  controller.abort();
  const plain = await pending;
  assertInterrupted(plain.exit, true);
  expect(plain.logs).toEqual(["cleanup:start", "shutdown:false", "cleanup:end"]);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  await assertSettled(plain);
  const framedController = new AbortController();
  const pendingFrames = QueueShutdownExecution.runWithFrames(retained, {
    signal: framedController.signal,
  });
  framedController.abort();
  const framed = await pendingFrames;
  expect(framed.logs).toEqual(plain.logs);
  expect(Exit.isSuccess(framed.exit)).toBe(true);
  if (Exit.isSuccess(framed.exit)) {
    const result = framed.exit.value;
    assertInterrupted(result.exit, true);
    // Recorded source frames do not justify synthesizing native restoration boundaries.
    expect(result.frames.map(({ kind }) => kind)).toEqual(["queueTake", "flatMap"]);
    expect(result.omitted).toBe(0);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.frames)).toBe(true);
  }
  await assertSettled(framed);
  for (const run of [QueueShutdownExecution.run, QueueShutdownExecution.runWithFrames]) {
    const observation = await run(retained, { signal: AbortSignal.abort() });
    const exit: Exit.Exit<unknown, CompileError | Cause.Done<void>> = observation.exit;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(observation.logs).toEqual([]);
  }
});

test("shutdown receipts reject every Offer edge and unsafe finalization placement before execution", async () => {
  const invalid = (
    kind: "offer" | "branch" | "handler" | "sourceCleanup" | "finalizer" | "secondCleanup",
  ) =>
    R.fn([], R.Unit, R.Never, () =>
      R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
        R.Effect.flatMap((owner) => {
          const take = R.Queue.take(owner);
          const shutdown = R.Queue.shutdown(owner).pipe(R.Effect.asVoid);
          const offer = R.Queue.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid);
          const left =
            kind === "offer"
              ? seq(offer, take)
              : kind === "branch"
                ? R.Match.bool(R.Bool.literal(false), offer, take)
                : kind === "sourceCleanup"
                  ? seq(shutdown, take).pipe(R.Effect.ensuring(R.Effect.sleep(1)))
                  : kind === "finalizer"
                    ? take.pipe(R.Effect.ensuring(shutdown))
                    : take;
          const source =
            kind === "secondCleanup"
              ? group(shutdown, take.pipe(R.Effect.ensuring(R.Effect.sleep(1))))
              : group(left, shutdown);
          return source.pipe(R.Effect.catch(() => (kind === "handler" ? offer : R.Effect.void)));
        }),
      ),
    );
  for (const kind of [
    "offer",
    "branch",
    "handler",
    "sourceCleanup",
    "finalizer",
    "secondCleanup",
  ] as const) {
    const fn = invalid(kind);
    const checked = await Effect.runPromise(
      Compile.check(R.program({ work, invalid: fn })).pipe(Effect.exit),
    );
    expect(diagnostics(checked), kind).toContainEqual(
      expect.objectContaining({ code: "QUEUE_STRUCTURAL_PROFILE", stage: "check" }),
    );
    const refused = await QueueShutdownExecution.run(fn);
    expect(diagnostics(refused.exit), kind).toContainEqual(
      expect.objectContaining({ stage: "check" }),
    );
    expect(refused.logs).toEqual([]);
  }
  const noShutdown = R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        group(R.Queue.take(owner), R.Queue.end(owner).pipe(R.Effect.asVoid)).pipe(
          R.Effect.catch(() => R.Effect.void),
        ),
      ),
    ),
  );
  const cleanupOnly = R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        group(
          seq(R.Queue.end(owner).pipe(R.Effect.asVoid), R.Queue.take(owner)).pipe(
            R.Effect.ensuring(R.Effect.sleep(1)),
          ),
          R.Effect.void,
        ).pipe(R.Effect.catch(() => R.Effect.void)),
      ),
    ),
  );
  expect((await QueueCleanupExecution.run(cleanupOnly)).exit).toEqual(Exit.succeed(undefined));
  for (const fn of [noShutdown, cleanupOnly, R.fn([], R.Unit, R.Never, () => R.Effect.void)]) {
    const refused = await QueueShutdownExecution.run(fn);
    expect(diagnostics(refused.exit)).toContainEqual(
      expect.objectContaining({ code: "QUEUE_EXECUTION_CONTEXT" }),
    );
    expect(refused.logs).toEqual([]);
  }
  const neverOwner = R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1).pipe(
      R.Effect.flatMap((owner) =>
        group(R.Queue.take(owner), R.Queue.shutdown(owner).pipe(R.Effect.asVoid)),
      ),
    ),
  );
  const localRecovery = R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        group(
          R.Queue.take(owner).pipe(R.Effect.catch(() => R.Effect.void)),
          R.Queue.shutdown(owner).pipe(R.Effect.asVoid),
        ),
      ),
    ),
  );
  for (const fn of [neverOwner, localRecovery]) {
    const checked = await Effect.runPromise(
      Compile.check(R.program({ invalid: fn })).pipe(Effect.exit),
    );
    expect(diagnostics(checked)).toContainEqual(
      expect.objectContaining({ code: "QUEUE_STRUCTURAL_PROFILE", stage: "check" }),
    );
    const refused = await QueueShutdownExecution.run(fn);
    expect(diagnostics(refused.exit)).toContainEqual(expect.objectContaining({ stage: "check" }));
    expect(refused.logs).toEqual([]);
  }
  const extraContext = { signal: undefined, context: {} };
  const accessor = {
    get signal(): AbortSignal {
      throw new Error("must not invoke accessor");
    },
  };
  const malformedSignal = { signal: new AbortController().signal };
  // Corrupt the runtime boundary without weakening the public TypeScript contract.
  Reflect.set(malformedSignal, "signal", {});
  for (const options of [extraContext, accessor, malformedSignal]) {
    const refused = await QueueShutdownExecution.run(work, options);
    expect(diagnostics(refused.exit)).toContainEqual(
      expect.objectContaining({ code: "QUEUE_EXECUTION_CONTEXT" }),
    );
    expect(refused.logs).toEqual([]);
  }
});
