import { getEventListeners } from "node:events";
import { Cause, Effect, Exit } from "effect";
import { expect, test } from "vite-plus/test";
import {
  AsyncEffects,
  Compile,
  CompileError,
  Computation,
  Expr,
  FailureFrames,
  IRType,
  QueueAllExecution,
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
const seq = <E, E2>(first: Computation<void, E>, next: Computation<void, E2>) =>
  first.pipe(R.Effect.andThen(next));
const boolLog = (changed: Expr<boolean>) =>
  R.Match.bool(changed, R.Log.info("shutdown:true"), R.Log.info("shutdown:false"));
const released = <A>(
  type: IRType<A>,
  value: Expr<A>,
  capacity: 1 | 2 | 3,
  closed: boolean,
  reverse = false,
) =>
  R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(type, capacity, QueueDoneType).pipe(
      R.Effect.flatMap((owner) => {
        let offers = R.Effect.void;
        for (let index = 0; index <= capacity; index++)
          offers = seq(offers, R.Queue.offer(owner, value).pipe(R.Effect.asVoid));
        const shutdown = R.Queue.shutdown(owner).pipe(R.Effect.flatMap(boolLog));
        const producer = seq(
          seq(offers, R.Log.info("producer:resumed")),
          seq(
            closed ? seq(R.Queue.end(owner).pipe(R.Effect.asVoid), shutdown) : shutdown,
            R.Queue.take(owner).pipe(R.Effect.asVoid),
          ),
        );
        const consumer = R.Queue.take(owner).pipe(
          R.Effect.flatMap(() => R.Log.info("consumer:value")),
        );
        return (reverse ? group(consumer, producer) : group(producer, consumer)).pipe(
          R.Effect.catch(() => R.Log.info("recovered")),
        );
      }),
    ),
  );
const work = released(R.Unit, R.Unit.literal(), 1, true);
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

test("single pending Offer passes public stages and artifact policies without widening old runners", async () => {
  const program = R.program({ work });
  const checked = await Effect.runPromise(Compile.check(program));
  const derived = await Effect.runPromise(Compile.derive(checked));
  expect(derived.effects).toContain(AsyncEffects.QueueOffer);
  expect(derived.effects).toContain(SyncEffects.QueueShutdown);
  const normalized = await Effect.runPromise(Compile.normalize(derived));
  const planned = await Effect.runPromise(Compile.plan(normalized, Rust.tokio));
  expect(await Effect.runPromise(Compile.verify(planned))).toBe(planned);
  for (const frames of [FailureFrames.None, FailureFrames.Bounded])
    for (const artifacts of [SourceArtifacts.None, SourceArtifacts.Full]) {
      const emitted = await Effect.runPromise(
        Compile.make(program).pipe(
          Compile.withTarget(Rust.tokio),
          Compile.withFailureFrames(frames),
          Compile.withSourceArtifacts(artifacts),
          Compile.run,
        ),
      );
      expect(emitted.failureFrames).toBe(frames);
      expect(emitted.sourceArtifacts).toBe(artifacts);
      expect(emitted.files["src/lib.rs"]!.includes("FrameTrail")).toBe(
        frames === FailureFrames.Bounded,
      );
      if (SourceArtifacts.isNone(artifacts)) expect(emitted).not.toHaveProperty("sources");
      else expect(emitted.sources?.ranges.length).toBeGreaterThan(0);
    }
  for (const run of [QueueExecution.run, QueueAllExecution.run, QueueCleanupExecution.run]) {
    const observation = await run(work);
    expect(diagnostics(observation.exit)).toContainEqual(
      expect.objectContaining({ stage: "check" }),
    );
    expect(observation.logs).toEqual([]);
  }
});

test("Take releases the sole producer before returning its value, with Open and Closing shutdown", async () => {
  const cases = [
    released(R.Unit, R.Unit.literal(), 1, false),
    released(R.Unit, R.Unit.literal(), 1, true),
    released(R.Bool, R.Bool.literal(true), 2, false),
    released(R.Bool, R.Bool.literal(false), 2, true),
    released(R.U64, R.U64.literal(42n), 3, false),
    released(R.U64, R.U64.literal(43n), 3, true),
  ];
  for (const [index, fn] of cases.entries()) {
    const plain = await QueueShutdownExecution.run(fn);
    expect(plain.logs[0]).toBe("producer:resumed");
    expect(plain.logs[1]).toBe("shutdown:true");
    expect(plain.logs).toContain("consumer:value");
    if (index % 2 === 1) {
      expect(plain.exit).toEqual(Exit.succeed(undefined));
      expect(plain.logs.at(-1)).toBe("recovered");
    } else {
      assertInterrupted(plain.exit, false);
      expect(plain.logs).not.toContain("recovered");
    }
    const framed = await QueueShutdownExecution.runWithFrames(fn);
    expect(framed.logs).toEqual(plain.logs);
    expect(Exit.isSuccess(framed.exit)).toBe(true);
    if (Exit.isSuccess(framed.exit)) {
      if (index % 2 === 1) expect(framed.exit.value.exit).toEqual(Exit.succeed(undefined));
      else assertInterrupted(framed.exit.value.exit, false);
    }
  }
  // A first-child Take is already waiting, but positive-capacity Offers only
  // schedule its release. The producer can block first; resuming it during
  // Take lets terminal failure cancel the consumer before its post-Take log.
  for (const closed of [false, true]) {
    const observation = await QueueShutdownExecution.run(
      released(R.Unit, R.Unit.literal(), 1, closed, true),
    );
    expect(observation.logs).toEqual(
      closed
        ? ["producer:resumed", "shutdown:true", "recovered"]
        : ["producer:resumed", "shutdown:true"],
    );
    if (closed) expect(observation.exit).toEqual(Exit.succeed(undefined));
    else assertInterrupted(observation.exit, false);
  }
});

test("direct shutdown completes a pending Offer with false rather than accepting its value", async () => {
  const fn = R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) => {
        const producer = seq(
          R.Queue.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid),
          seq(
            R.Queue.offer(owner, R.Unit.literal()).pipe(
              R.Effect.flatMap((accepted) =>
                R.Match.bool(accepted, R.Log.info("unexpected:true"), R.Log.info("offer:false")),
              ),
            ),
            R.Queue.take(owner),
          ),
        );
        return group(producer, R.Queue.shutdown(owner).pipe(R.Effect.flatMap(boolLog))).pipe(
          R.Effect.catch(() => R.Log.info("unexpected recovery")),
        );
      }),
    ),
  );
  const plain = await QueueShutdownExecution.run(fn);
  assertInterrupted(plain.exit, false);
  expect(plain.logs).toContain("offer:false");
  expect(plain.logs).toContain("shutdown:true");
  expect(plain.logs).not.toContain("unexpected:true");
  expect(plain.logs).not.toContain("unexpected recovery");
  const framed = await QueueShutdownExecution.runWithFrames(fn);
  expect(framed.logs).toEqual(plain.logs);
  expect(Exit.isSuccess(framed.exit)).toBe(true);
  if (Exit.isSuccess(framed.exit)) assertInterrupted(framed.exit.value.exit, false);
});

const cleanupWork = R.fn([], R.Unit, R.Never, () =>
  R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
    R.Effect.flatMap((owner) => {
      const offer = R.Queue.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid);
      const cleanup = seq(
        seq(R.Log.info("cleanup:start"), R.Effect.sleep(20)),
        R.Log.info("cleanup:end"),
      );
      const producer = seq(offer, offer).pipe(R.Effect.ensuring(cleanup));
      const peer = seq(
        R.Queue.take(owner),
        seq(
          R.Queue.end(owner).pipe(R.Effect.asVoid),
          seq(R.Queue.shutdown(owner).pipe(R.Effect.flatMap(boolLog)), R.Queue.take(owner)),
        ),
      );
      return group(producer, peer).pipe(R.Effect.catch(() => R.Log.info("recovered")));
    }),
  ),
);

test("caller cancellation awaits entered pending-producer cleanup and retains the peer Done", async () => {
  const completed = await QueueShutdownExecution.run(cleanupWork);
  expect(completed.exit).toEqual(Exit.succeed(undefined));
  expect(completed.logs).toEqual(["cleanup:start", "shutdown:true", "cleanup:end", "recovered"]);
  const controller = new AbortController();
  const pending = QueueShutdownExecution.run(cleanupWork, { signal: controller.signal });
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
  controller.abort();
  const plain = await pending;
  assertInterrupted(plain.exit, true);
  expect(plain.logs).toEqual(["cleanup:start", "shutdown:true", "cleanup:end"]);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  expect(Object.isFrozen(plain)).toBe(true);
  expect(Object.isFrozen(plain.logs)).toBe(true);
  const snapshot = [...plain.logs];
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  expect(plain.logs).toEqual(snapshot);
  const framedController = new AbortController();
  const pendingFrames = QueueShutdownExecution.runWithFrames(cleanupWork, {
    signal: framedController.signal,
  });
  framedController.abort();
  const framed = await pendingFrames;
  expect(framed.logs).toEqual(plain.logs);
  expect(Exit.isSuccess(framed.exit)).toBe(true);
  if (Exit.isSuccess(framed.exit)) {
    assertInterrupted(framed.exit.value.exit, true);
    expect(framed.exit.value.frames.map(({ kind }) => kind)).toEqual([
      "queueTake",
      "flatMap",
      "flatMap",
      "flatMap",
    ]);
    expect(framed.exit.value.omitted).toBe(0);
  }
  expect(getEventListeners(framedController.signal, "abort")).toHaveLength(0);
});

test("offer occurrence bound includes dormant, shared and both-branch edges", async () => {
  const invalid = (kind: "shared" | "dormant" | "branchSum" | "all3") =>
    R.fn([], R.Unit, R.Never, () =>
      R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
        R.Effect.flatMap((owner) => {
          const offer = R.Queue.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid);
          const before =
            kind === "dormant"
              ? seq(seq(offer, offer), R.Match.bool(R.Bool.literal(false), offer, R.Effect.void))
              : kind === "branchSum"
                ? seq(offer, R.Match.bool(R.Bool.literal(true), offer, offer))
                : kind === "shared"
                  ? seq(seq(offer, offer), offer)
                  : seq(offer, offer);
          const producer = seq(
            seq(before, R.Queue.shutdown(owner).pipe(R.Effect.asVoid)),
            R.Queue.take(owner),
          );
          const source =
            kind === "all3"
              ? R.Effect.all([producer, R.Effect.void, R.Effect.void], {
                  concurrency: "unbounded",
                  discard: true,
                })
              : group(producer, R.Effect.void);
          return source.pipe(R.Effect.catch(() => R.Effect.void));
        }),
      ),
    );
  for (const kind of ["shared", "dormant", "branchSum", "all3"] as const) {
    const fn = invalid(kind);
    const checked = await Effect.runPromise(
      Compile.check(R.program({ invalid: fn })).pipe(Effect.exit),
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
});
