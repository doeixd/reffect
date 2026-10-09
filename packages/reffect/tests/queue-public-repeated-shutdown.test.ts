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
const checkedValue = (condition: Expr<boolean>, message: string) =>
  R.Match.bool(condition, R.Log.info(message), R.Log.info("wrong-payload"));
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
    if (!done) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
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

const repeated = <A>(
  type: IRType<A>,
  values: readonly Expr<A>[],
  capacity: 1 | 2 | 3,
  closed: boolean,
  check: (value: Expr<A>, index: number) => Expr<boolean>,
) =>
  R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(type, capacity, QueueDoneType).pipe(
      R.Effect.flatMap((owner) => {
        let offers = R.Effect.void;
        for (const [index, value] of values.entries())
          offers = seq(
            offers,
            R.Queue.offer(owner, value).pipe(
              R.Effect.flatMap((accepted) =>
                R.Match.bool(
                  accepted,
                  R.Log.info(`offer${index + 1}:true`),
                  R.Log.info(`offer${index + 1}:false`),
                ),
              ),
            ),
          );
        const shutdown = R.Queue.shutdown(owner).pipe(R.Effect.flatMap(boolLog));
        const producer = seq(
          offers,
          seq(
            closed ? seq(R.Queue.end(owner).pipe(R.Effect.asVoid), shutdown) : shutdown,
            R.Queue.take(owner).pipe(R.Effect.asVoid),
          ),
        );
        let takes = R.Effect.void.pipe(
          R.Effect.andThen(
            R.Queue.take(owner).pipe(
              R.Effect.flatMap((value) => checkedValue(check(value, 0), "take:1")),
            ),
          ),
        );
        for (let index = 1; index < 3; index++)
          takes = seq(
            takes,
            R.Queue.take(owner).pipe(
              R.Effect.flatMap((value) => checkedValue(check(value, index), `take:${index + 1}`)),
            ),
          );
        return group(producer, takes).pipe(R.Effect.catch(() => R.Log.info("recovered")));
      }),
    ),
  );
const work = repeated(
  R.Unit,
  Array.from({ length: 4 }, () => R.Unit.literal()),
  1,
  true,
  () => R.Bool.literal(true),
);

test("repeated backpressure passes public compilation and keeps previous runners bounded", async () => {
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

test("repeated producer registration preserves scalar FIFO payloads and reentrant log order", async () => {
  for (const closed of [false, true]) {
    const cases = [
      repeated(
        R.Unit,
        Array.from({ length: 4 }, () => R.Unit.literal()),
        1,
        closed,
        () => R.Bool.literal(true),
      ),
      repeated(
        R.Bool,
        [true, false, true, false, true].map((value) => R.Bool.literal(value)),
        2,
        closed,
        (value, index) => (index === 1 ? R.Bool.not(value) : value),
      ),
      repeated(
        R.U64,
        [11n, 22n, 33n, 44n, 55n, 66n].map((value) => R.U64.literal(value)),
        3,
        closed,
        (value, index) => R.U64.eq(value, R.U64.literal(BigInt((index + 1) * 11))),
      ),
    ];
    for (const [index, fn] of cases.entries()) {
      const plain = await QueueShutdownExecution.run(fn);
      expect(plain.logs).not.toContain("wrong-payload");
      for (let take = 1; take <= 3; take++) {
        expect(plain.logs).toContain(`take:${take}`);
        expect(plain.logs).toContain(`offer${index + take + 1}:true`);
        expect(plain.logs.indexOf(`offer${index + take + 1}:true`)).toBeLessThan(
          plain.logs.indexOf(`take:${take}`),
        );
      }
      expect(plain.logs.filter((message) => message.startsWith("offer"))).toHaveLength(index + 4);
      expect(
        plain.logs.some((message) => message.startsWith("offer") && message.endsWith(":false")),
      ).toBe(false);
      expect(plain.logs).toContain("shutdown:true");
      if (closed) {
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
        if (closed) expect(framed.exit.value.exit).toEqual(Exit.succeed(undefined));
        else assertInterrupted(framed.exit.value.exit, false);
      }
    }
  }
  expect((await QueueShutdownExecution.run(work)).logs).toEqual([
    "offer1:true",
    "offer2:true",
    "take:1",
    "offer3:true",
    "take:2",
    "offer4:true",
    "shutdown:true",
    "take:3",
    "recovered",
  ]);
});

const alternating = R.fn([], R.Unit, R.Never, () =>
  R.Queue.bounded(R.U64, 1, QueueDoneType).pipe(
    R.Effect.flatMap((owner) => {
      const offer = (value: bigint) =>
        R.Queue.offer(owner, R.U64.literal(value)).pipe(
          R.Effect.flatMap((accepted) =>
            R.Match.bool(
              accepted,
              R.Log.info(`offer${value}:true`),
              R.Log.info(`offer${value}:false`),
            ),
          ),
        );
      const take = (who: string, expected: bigint) =>
        R.Queue.take(owner).pipe(
          R.Effect.flatMap((value) =>
            checkedValue(R.U64.eq(value, R.U64.literal(expected)), `${who}:take:${expected}`),
          ),
        );
      const left = seq(
        seq(seq(seq(offer(1n), offer(2n)), take("left", 2n)), take("left", 4n)),
        seq(
          offer(6n),
          seq(
            R.Queue.end(owner).pipe(R.Effect.asVoid),
            seq(
              R.Queue.shutdown(owner).pipe(R.Effect.flatMap(boolLog)),
              R.Queue.take(owner).pipe(R.Effect.asVoid),
            ),
          ),
        ),
      );
      const right = seq(
        seq(seq(seq(seq(take("right", 1n), offer(3n)), take("right", 3n)), offer(4n)), offer(5n)),
        take("right", 5n),
      );
      return group(left, right).pipe(R.Effect.catch(() => R.Log.info("recovered")));
    }),
  ),
);

test("both children can become the blocked producer during an alternating handoff", async () => {
  const plain = await QueueShutdownExecution.run(alternating);
  expect(plain.exit).toEqual(Exit.succeed(undefined));
  expect(plain.logs).toEqual([
    "offer1:true",
    "offer2:true",
    "left:take:2",
    "right:take:1",
    "offer3:true",
    "right:take:3",
    "offer4:true",
    "offer5:true",
    "right:take:5",
    "left:take:4",
    "offer6:true",
    "shutdown:true",
    "recovered",
  ]);
  const framed = await QueueShutdownExecution.runWithFrames(alternating);
  expect(framed.logs).toEqual(plain.logs);
  expect(Exit.isSuccess(framed.exit) && Exit.isSuccess(framed.exit.value.exit)).toBe(true);
});

test("Closing accepts its already pending Offer and rejects later registrations before shutdown", async () => {
  const fn = R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.U64, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) => {
        const offer = (value: bigint) =>
          R.Queue.offer(owner, R.U64.literal(value)).pipe(
            R.Effect.flatMap((accepted) =>
              R.Match.bool(
                accepted,
                R.Log.info(`offer${value}:true`),
                R.Log.info(`offer${value}:false`),
              ),
            ),
          );
        const left = seq(seq(offer(1n), offer(2n)), offer(3n));
        const right = seq(
          R.Queue.end(owner).pipe(R.Effect.asVoid),
          seq(
            R.Queue.take(owner).pipe(
              R.Effect.flatMap((value) =>
                checkedValue(R.U64.eq(value, R.U64.literal(1n)), "take:1"),
              ),
            ),
            seq(
              R.Queue.shutdown(owner).pipe(R.Effect.flatMap(boolLog)),
              R.Queue.take(owner).pipe(R.Effect.asVoid),
            ),
          ),
        );
        return group(left, right).pipe(R.Effect.catch(() => R.Log.info("recovered")));
      }),
    ),
  );
  const plain = await QueueShutdownExecution.run(fn);
  expect(plain.exit).toEqual(Exit.succeed(undefined));
  expect(plain.logs).toEqual([
    "offer1:true",
    "offer2:true",
    "offer3:false",
    "take:1",
    "shutdown:true",
    "recovered",
  ]);
  const framed = await QueueShutdownExecution.runWithFrames(fn);
  expect(framed.logs).toEqual(plain.logs);
  expect(Exit.isSuccess(framed.exit) && Exit.isSuccess(framed.exit.value.exit)).toBe(true);
});

const cleanup = seq(
  seq(R.Log.info("cleanup:start"), R.Effect.sleep(20)),
  R.Log.info("cleanup:end"),
);
const cancelled = (bothPending: boolean) =>
  R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) => {
        const offer = R.Queue.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid);
        const first = seq(
          offer,
          bothPending ? seq(R.Log.info("filled"), offer) : seq(offer, offer),
        ).pipe(R.Effect.ensuring(cleanup));
        const shutdown = R.Queue.shutdown(owner).pipe(R.Effect.flatMap(boolLog));
        const second = bothPending
          ? seq(offer, seq(shutdown, R.Queue.take(owner)))
          : seq(
              seq(R.Queue.take(owner), R.Queue.take(owner)),
              seq(R.Queue.end(owner).pipe(R.Effect.asVoid), seq(shutdown, R.Queue.take(owner))),
            );
        return group(first, second).pipe(R.Effect.catch(() => R.Log.info("unexpected recovery")));
      }),
    ),
  );

test("natural caller abort retires two globally pending Offers and awaits first-child cleanup", async () => {
  // With both children suspended in Offer, no actor can free capacity. Caller
  // cancellation must unregister both waits and join the admitted finalizer.
  for (const bothPending of [true, false]) {
    const controller = new AbortController();
    const pending = QueueShutdownExecution.run(cancelled(bothPending), {
      signal: controller.signal,
    });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    controller.abort();
    const plain = await pending;
    assertInterrupted(plain.exit, !bothPending);
    expect(plain.logs).toEqual(
      bothPending
        ? ["filled", "cleanup:start", "cleanup:end"]
        : ["cleanup:start", "shutdown:true", "cleanup:end"],
    );
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(Object.isFrozen(plain.logs)).toBe(true);
    const snapshot = [...plain.logs];
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(plain.logs).toEqual(snapshot);
    const framedController = new AbortController();
    const pendingFrames = QueueShutdownExecution.runWithFrames(cancelled(bothPending), {
      signal: framedController.signal,
    });
    framedController.abort();
    const framed = await pendingFrames;
    expect(framed.logs).toEqual(plain.logs);
    expect(Exit.isSuccess(framed.exit)).toBe(true);
    if (Exit.isSuccess(framed.exit)) {
      assertInterrupted(framed.exit.value.exit, !bothPending);
      expect(framed.exit.value.omitted).toBe(0);
      expect(framed.exit.value.frames.map(({ kind }) => kind)).not.toContain("ensuring");
    }
    expect(getEventListeners(framedController.signal, "abort")).toHaveLength(0);
  }
});

test("topology, source suspension, queue-active cleanup and default-context budgets remain refused", async () => {
  const invalid = (
    kind: "all3" | "nested" | "sourceSleep" | "queueCleanup" | "budget" | "dormantBudget",
  ) =>
    R.fn([], R.Unit, R.Never, () =>
      R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
        R.Effect.flatMap((owner) => {
          const offer = R.Queue.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid);
          const take = R.Queue.take(owner);
          const shutdown = R.Queue.shutdown(owner).pipe(R.Effect.asVoid);
          let before: Computation<void, Cause.Done<void>> = R.Effect.void;
          if (kind === "budget" || kind === "dormantBudget")
            for (let index = 0; index < 10; index++) before = seq(before, seq(offer, take));
          const producer =
            kind === "sourceSleep"
              ? seq(R.Effect.sleep(1), shutdown)
              : kind === "queueCleanup"
                ? offer.pipe(R.Effect.ensuring(offer))
                : seq(
                    kind === "dormantBudget"
                      ? R.Match.bool(R.Bool.literal(false), before, R.Effect.void)
                      : before,
                    shutdown,
                  );
          const source =
            kind === "all3"
              ? R.Effect.all([producer, R.Effect.void, R.Effect.void], {
                  concurrency: "unbounded",
                  discard: true,
                })
              : kind === "nested"
                ? group(group(producer, R.Effect.void), R.Effect.void)
                : group(producer, kind === "queueCleanup" ? shutdown : R.Effect.void);
          return source.pipe(R.Effect.catch(() => R.Effect.void));
        }),
      ),
    );
  for (const kind of [
    "all3",
    "nested",
    "sourceSleep",
    "queueCleanup",
    "budget",
    "dormantBudget",
  ] as const) {
    const fn = invalid(kind);
    const checked = await Effect.runPromise(
      Compile.check(R.program({ invalid: fn })).pipe(Effect.exit),
    );
    expect(diagnostics(checked), kind).toContainEqual(
      expect.objectContaining({
        code:
          kind === "budget" || kind === "dormantBudget"
            ? "QUEUE_BUDGET_EXCEEDED"
            : "QUEUE_STRUCTURAL_PROFILE",
        stage: "check",
      }),
    );
    const refused = await QueueShutdownExecution.run(fn);
    expect(diagnostics(refused.exit), kind).toContainEqual(
      expect.objectContaining({ stage: "check" }),
    );
    expect(refused.logs).toEqual([]);
  }
});
