import { Cause, Exit } from "effect";
import { PrivateEffectReference } from "./effect-ir.ts";
import type { FramedExit } from "./effect-ir.ts";
import { CompileError, fail } from "./kernel.ts";
import type { QueueAllObservation } from "./queue-execution.ts";

/** Attach recorded evidence when cancellation bypasses the framed result envelope. */
export const attachQueueAllRecordedFrames = <A>(
  observation: QueueAllObservation<FramedExit<A, Cause.Done<void>>>,
  boundary: Pick<FramedExit<A, Cause.Done<void>>, "frames" | "omitted">,
): QueueAllObservation<FramedExit<A, Cause.Done<void>>> => {
  if (!Exit.isFailure(observation.exit)) return observation;
  const projected = PrivateEffectReference.projectFramedCause(observation.exit.cause);
  const represented = (
    reason: Cause.Reason<unknown>,
  ): reason is Cause.Reason<CompileError | Cause.Done<void>> =>
    !Cause.isFailReason(reason) ||
    reason.error instanceof CompileError ||
    (Cause.isDone(reason.error) && reason.error.value === undefined);
  if (!projected.cause.reasons.every(represented))
    return Object.freeze({
      logs: observation.logs,
      exit: Exit.fail(
        fail(
          "QUEUE_OBSERVATION_CAUSE",
          "reference",
          "QueueAllExecution.runWithFrames",
          "The checked Queue All observation requires CompileError or unit Done failures",
        ),
      ),
    });
  // Validation above ensures these narrowing filters retain every reason.
  const reasons = projected.cause.reasons.filter(represented);
  const cause = Cause.fromReasons(reasons);
  if (
    (!projected.frames.length && !boundary.frames.length) ||
    reasons.some((reason) => Cause.isFailReason(reason) && reason.error instanceof CompileError)
  )
    return projected.cause === observation.exit.cause
      ? observation
      : Object.freeze({ logs: observation.logs, exit: Exit.failCause(cause) });
  const domain = (
    reason: Cause.Reason<CompileError | Cause.Done<void>>,
  ): reason is Cause.Reason<Cause.Done<void>> =>
    !Cause.isFailReason(reason) || Cause.isDone(reason.error);
  const trail = projected.frames.length ? projected : boundary;
  return Object.freeze({
    logs: observation.logs,
    exit: Exit.succeed(
      Object.freeze({
        exit: Exit.failCause(Cause.fromReasons(reasons.filter(domain))),
        frames: trail.frames,
        omitted: trail.omitted,
      }),
    ),
  });
};
