import { Cause, Context, Effect, Exit, Logger, Scheduler } from "effect";
import { expect, test } from "vite-plus/test";
import { CompileError, Expr, QueueDoneType, R } from "../src/index.ts";
import { PrivateEffectReference } from "../src/effect-ir.ts";
import type { FramedExit, LogicalFrame } from "../src/effect-ir.ts";
import { attachQueueAllRecordedFrames } from "../src/queue-all-observation.ts";
import type { QueueAllObservation } from "../src/queue-execution.ts";

const boundary = Object.freeze({
  frames: Object.freeze([
    Object.freeze({ path: "recorded.all", kind: "all" } satisfies LogicalFrame),
  ]),
  omitted: 2,
});
const logs = Object.freeze(["recorded"]);
class Annotation extends Context.Service<Annotation, string>()("test/queue-all-annotation") {}
const failure = (cause: Cause.Cause<CompileError | Cause.Done<void>>) =>
  Object.freeze({ exit: Exit.failCause(cause), logs });

test("recorded All packaging preserves every mixed reason, payload and annotation", () => {
  const done = Cause.Done();
  const defect = new Error("recorded defect");
  const cause = Cause.fromReasons([
    ...Cause.fail(done).reasons,
    ...Cause.interrupt().reasons,
    ...Cause.die(defect).reasons,
  ]).pipe(Cause.annotate(Context.make(Annotation, "kept")));
  const observed = attachQueueAllRecordedFrames(failure(cause), boundary);
  expect(Exit.isSuccess(observed.exit)).toBe(true);
  if (!Exit.isSuccess(observed.exit)) return;
  const framed = observed.exit.value;
  expect(Object.isFrozen(observed)).toBe(true);
  expect(Object.isFrozen(framed)).toBe(true);
  expect(Object.isFrozen(framed.frames)).toBe(true);
  expect(observed.logs).toBe(logs);
  expect(framed.frames).toBe(boundary.frames);
  expect(framed.omitted).toBe(2);
  expect(Exit.isFailure(framed.exit)).toBe(true);
  if (!Exit.isFailure(framed.exit)) return;
  expect(framed.exit.cause.reasons).toEqual(cause.reasons);
  expect(Cause.hasInterruptsOnly(framed.exit.cause)).toBe(false);
  for (const reason of framed.exit.cause.reasons)
    expect(Context.getOrUndefined(Cause.reasonAnnotations(reason), Annotation)).toBe("kept");
  expect(framed.exit.cause.reasons.find(Cause.isFailReason)?.error).toBe(done);
  expect(framed.exit.cause.reasons.find(Cause.isDieReason)?.defect).toBe(defect);
});

test("CompileError stays outer and unopened cancellation invents no frames", () => {
  const error = new CompileError({ message: "rejected", diagnostics: [] });
  const cause = Cause.fromReasons([...Cause.fail(error).reasons, ...Cause.interrupt().reasons]);
  const observed = attachQueueAllRecordedFrames(failure(cause), boundary);
  expect(observed.exit).toEqual(Exit.failCause(cause));
  expect(
    Exit.isFailure(observed.exit) && observed.exit.cause.reasons.find(Cause.isFailReason)?.error,
  ).toBe(error);
  const preabort = failure(Cause.interrupt());
  expect(attachQueueAllRecordedFrames(preabort, { frames: [], omitted: 0 })).toBe(preabort);
});

test("untrusted Domain lookalikes and unsupported failures cannot leak through the public observation", () => {
  for (const error of [
    { _tag: "Domain", error: Cause.Done(), frames: boundary.frames, omitted: 0 },
    Cause.Done(1),
    "unexpected",
  ]) {
    const forged = { logs, exit: Exit.fail(error) };
    // @ts-expect-error Adversarial observations deliberately violate the represented error contract.
    const observed = attachQueueAllRecordedFrames(forged, boundary);
    expect(Exit.isFailure(observed.exit)).toBe(true);
    if (!Exit.isFailure(observed.exit)) continue;
    const reason = observed.exit.cause.reasons.find(Cause.isFailReason);
    expect(reason?.error).toBeInstanceOf(CompileError);
    if (reason?.error instanceof CompileError)
      expect(reason.error.diagnostics).toContainEqual(
        expect.objectContaining({ code: "QUEUE_OBSERVATION_CAUSE" }),
      );
  }
});

test("test-only aborting logger exposes a genuine interpreter carrier without inventing outer frames", async () => {
  const controller = new AbortController();
  const captured: string[] = [];
  const probe = R.fn([], R.Unit, QueueDoneType, () =>
    R.Effect.fail(Expr.literal(QueueDoneType, Cause.Done())).pipe(
      R.Effect.asVoid,
      R.Effect.ensuring(R.Log.info("abort-probe")),
    ),
  );
  // The synthetic Done source, finalizer and aborting logger exceed the public profile.
  // This proves carrier decoding, not natural cancellation reachability in QueueAllExecution.
  const context = Context.empty().pipe(
    Context.add(Scheduler.Scheduler, new Scheduler.MixedScheduler()),
    Context.add(Scheduler.MaxOpsBeforeYield, 2048),
    Context.add(Scheduler.PreventSchedulerYield, false),
    Context.add(
      Logger.CurrentLoggers,
      new Set([
        Logger.make((event) => {
          captured.push(String(event.message));
          controller.abort();
        }),
      ]),
    ),
  );
  const exit = await Effect.runPromiseExitWith(context)(
    Effect.sleep(1).pipe(
      Effect.andThen(
        PrivateEffectReference.runWithFramesUnknown(probe, [], "functions.probe.body", () => []),
      ),
    ),
    { signal: controller.signal },
  );
  expect(captured).toEqual(["abort-probe"]);
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) return;
  const annotated = Cause.annotate(exit.cause, Context.make(Annotation, "trusted-wrapper"));
  const projected = PrivateEffectReference.projectFramedCause(annotated);
  expect(projected.frames).toEqual([
    { path: "functions.probe.body.body.source", kind: "fail" },
    { path: "functions.probe.body.body", kind: "map" },
  ]);
  expect(
    projected.cause.reasons.some(
      (reason) => Cause.isFailReason(reason) && Cause.isDone(reason.error),
    ),
  ).toBe(true);
  const observation: QueueAllObservation<FramedExit<void, Cause.Done<void>>> = {
    exit: Exit.failCause(annotated),
    logs: Object.freeze(captured),
  };
  const observed = attachQueueAllRecordedFrames(observation, boundary);
  expect(Exit.isSuccess(observed.exit)).toBe(true);
  if (!Exit.isSuccess(observed.exit)) return;
  expect(observed.exit.value.frames).toEqual(projected.frames);
  expect(observed.exit.value.frames).not.toContainEqual(boundary.frames[0]);
  expect(Object.isFrozen(projected)).toBe(true);
  expect(Object.isFrozen(projected.frames)).toBe(true);
  const framed = observed.exit.value.exit;
  expect(Exit.isFailure(framed) && framed.cause).toEqual(projected.cause);
  if (Exit.isFailure(framed))
    for (const reason of framed.cause.reasons)
      expect(Context.getOrUndefined(Cause.reasonAnnotations(reason), Annotation)).toBe(
        "trusted-wrapper",
      );
});
