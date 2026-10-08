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
const buffered = (closed: boolean, reverse = false) =>
  R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.U64, 3, QueueDoneType).pipe(
      R.Effect.flatMap((owner) => {
        const shutdown = R.Queue.shutdown(owner).pipe(R.Effect.flatMap(boolLog));
        const fill = seq(
          seq(
            R.Queue.offer(owner, R.U64.literal(10n)).pipe(R.Effect.asVoid),
            owner.pipe(R.Queue.offer(R.U64.literal(20n)), R.Effect.asVoid),
          ),
          R.Queue.offer(owner, R.U64.literal(30n)).pipe(R.Effect.asVoid),
        );
        const terminal = closed
          ? seq(R.Queue.end(owner).pipe(R.Effect.asVoid), seq(shutdown, shutdown))
          : shutdown;
        const source = seq(
          seq(fill, terminal),
          R.Queue.take(owner).pipe(R.Effect.flatMap(() => R.Log.info("unexpected buffered value"))),
        );
        return (reverse ? group(R.Effect.void, source) : group(source, R.Effect.void)).pipe(
          R.Effect.catch(() => R.Log.info("recovered")),
        );
      }),
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

test("buffered public shutdown passes compiler stages and independent artifact policies", async () => {
  const work = buffered(true);
  const program = R.program({ work });
  const checked = await Effect.runPromise(Compile.check(program));
  const derived = await Effect.runPromise(Compile.derive(checked));
  expect(derived.effects).toContain(SyncEffects.QueueShutdown);
  expect(derived.effects).toContain(AsyncEffects.QueueOffer);
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
  for (const run of [QueueExecution.run, QueueAllExecution.run, QueueCleanupExecution.run]) {
    const refused = await run(work);
    expect(diagnostics(refused.exit)).toContainEqual(expect.objectContaining({ stage: "check" }));
    expect(refused.logs).toEqual([]);
  }
});

test("buffered Open discards values and interrupts while Closing preserves Done in either child", async () => {
  for (const closed of [false, true])
    for (const reverse of [false, true]) {
      const work = buffered(closed, reverse);
      const plain = await QueueShutdownExecution.run(work);
      const expectedLogs = closed
        ? ["shutdown:true", "shutdown:false", "recovered"]
        : ["shutdown:true"];
      expect(plain.logs).toEqual(expectedLogs);
      if (closed) expect(plain.exit).toEqual(Exit.succeed(undefined));
      else assertInterrupted(plain.exit, false);
      const framed = await QueueShutdownExecution.runWithFrames(work);
      expect(framed.logs).toEqual(expectedLogs);
      expect(Exit.isSuccess(framed.exit)).toBe(true);
      if (Exit.isSuccess(framed.exit)) {
        if (closed) expect(framed.exit.value.exit).toEqual(Exit.succeed(undefined));
        else assertInterrupted(framed.exit.value.exit, false);
      }
    }
});

test("Bool buffered shutdown counts closed Offers within the capacity bound", async () => {
  const work = R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Bool, 2, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        group(
          seq(
            seq(
              R.Queue.offer(owner, R.Bool.literal(true)).pipe(R.Effect.asVoid),
              seq(
                R.Queue.end(owner).pipe(R.Effect.asVoid),
                R.Queue.shutdown(owner).pipe(R.Effect.flatMap(boolLog)),
              ),
            ),
            seq(
              R.Queue.offer(owner, R.Bool.literal(false)).pipe(
                R.Effect.flatMap((accepted) =>
                  R.Match.bool(accepted, R.Log.info("unexpected offer"), R.Log.info("offer:false")),
                ),
              ),
              R.Queue.take(owner).pipe(R.Effect.asVoid),
            ),
          ),
          R.Effect.void,
        ).pipe(R.Effect.catch(() => R.Log.info("recovered"))),
      ),
    ),
  );
  const plain = await QueueShutdownExecution.run(work);
  expect(plain.exit).toEqual(Exit.succeed(undefined));
  expect(plain.logs).toEqual(["shutdown:true", "offer:false", "recovered"]);
});

test("caller cancellation awaits successful child cleanup and preserves the other child's Done", async () => {
  const work = R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) => {
        const cleanup = seq(
          seq(R.Log.info("cleanup:start"), R.Effect.sleep(20)),
          R.Log.info("cleanup:end"),
        );
        return group(
          seq(
            R.Queue.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid),
            R.Queue.end(owner).pipe(R.Effect.asVoid),
          ).pipe(R.Effect.ensuring(cleanup)),
          seq(R.Queue.shutdown(owner).pipe(R.Effect.flatMap(boolLog)), R.Queue.take(owner)),
        ).pipe(R.Effect.catch(() => R.Log.info("unexpected recovery")));
      }),
    ),
  );
  const controller = new AbortController();
  const pending = QueueShutdownExecution.run(work, { signal: controller.signal });
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
  controller.abort();
  const plain = await pending;
  assertInterrupted(plain.exit, true);
  expect(plain.logs).toEqual(["cleanup:start", "shutdown:true", "cleanup:end"]);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  expect(Object.isFrozen(plain.logs)).toBe(true);
  const snapshot = [...plain.logs];
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  expect(plain.logs).toEqual(snapshot);
  const framedController = new AbortController();
  const pendingFrames = QueueShutdownExecution.runWithFrames(work, {
    signal: framedController.signal,
  });
  framedController.abort();
  const framed = await pendingFrames;
  expect(framed.logs).toEqual(plain.logs);
  expect(Exit.isSuccess(framed.exit)).toBe(true);
  if (Exit.isSuccess(framed.exit)) {
    assertInterrupted(framed.exit.value.exit, true);
    // The Done belongs to the non-finalizing child; another child's Ensuring
    // cannot supply recorded source frames for it.
    expect(framed.exit.value.frames.map(({ kind }) => kind)).toEqual(["queueTake", "flatMap"]);
    expect(framed.exit.value.omitted).toBe(0);
  }
  expect(getEventListeners(framedController.signal, "abort")).toHaveLength(0);
});

test("capacity bound counts drained, dormant and shared Offers and preserves cleanup refusals", async () => {
  const invalid = (kind: "drained" | "branch" | "branchSum" | "shared" | "cleanup") =>
    R.fn([], R.Unit, R.Never, () =>
      R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
        R.Effect.flatMap((owner) => {
          const offer = R.Queue.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid);
          const take = R.Queue.take(owner);
          const shutdown = R.Queue.shutdown(owner).pipe(R.Effect.asVoid);
          const before =
            kind === "drained"
              ? seq(seq(seq(seq(offer, take), offer), take), offer)
              : kind === "branch"
                ? seq(seq(offer, offer), R.Match.bool(R.Bool.literal(false), offer, R.Effect.void))
                : kind === "branchSum"
                  ? R.Match.bool(R.Bool.literal(false), seq(offer, offer), seq(offer, offer))
                  : kind === "shared"
                    ? seq(seq(offer, offer), offer)
                    : offer;
          const source = seq(seq(before, shutdown), take);
          return group(
            kind === "cleanup" ? source.pipe(R.Effect.ensuring(R.Effect.sleep(1))) : source,
            R.Effect.void,
          ).pipe(R.Effect.catch(() => R.Effect.void));
        }),
      ),
    );
  for (const kind of ["drained", "branch", "branchSum", "shared", "cleanup"] as const) {
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
