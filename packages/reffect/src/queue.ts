import { Match } from "effect";
import type { Cause, Queue } from "effect";
import { dual } from "effect/Function";
import { Computation } from "./effect-ir.ts";
import { BoolType, Expr, IRType, NeverType, fail } from "./kernel.ts";
import {
  QueueDoneType,
  queueChannels,
  queueError,
  queueScalar,
  queueType,
  validQueueCapacity,
} from "./queue-model.ts";
const handle = <A, E>(self: Expr<Queue.Queue<A, E>>) => {
  const channels = queueChannels(self.type);
  const parameter = Match.value(self.node).pipe(
    Match.tag("Parameter", (node) => node),
    Match.orElse(() => undefined),
  );
  if (!channels || !parameter || parameter.index !== 0)
    throw fail(
      "RESOURCE_ESCAPE",
      "authoring",
      "Queue",
      "Queue operations require a lexical handle",
    );
  return {
    success: channels.success as IRType<A>,
    error: channels.error as IRType<E>,
    binder: parameter.binder,
  };
};
const make = <A, E = never>(
  success: IRType<A>,
  options: { readonly capacity: number; readonly strategy?: "suspend" },
  error: IRType<E> = NeverType as IRType<E>,
): Computation<Queue.Queue<A, E>> => {
  if (
    !options ||
    !validQueueCapacity(options.capacity) ||
    (options.strategy !== undefined && options.strategy !== "suspend")
  )
    throw fail(
      "UNSUPPORTED_REPRESENTATION",
      "authoring",
      "Queue.make",
      "Queue requires literal capacity 1..3 and suspend strategy",
    );
  if (!queueScalar(success) || !queueError(error))
    throw fail(
      "UNSUPPORTED_REPRESENTATION",
      "authoring",
      "Queue.make",
      "Queue requires Bool/U64/Unit payload and Never/unit Done error",
    );
  return Computation.make(queueType(success, error), NeverType, {
    _tag: "QueueMake",
    success,
    error,
    capacity: options.capacity,
  });
};
const bounded = <A, E = never>(
  success: IRType<A>,
  capacity: number,
  error: IRType<E> = NeverType as IRType<E>,
) => make(success, { capacity }, error);
const offer: {
  <A>(value: Expr<A>): <E>(self: Expr<Queue.Queue<NoInfer<A>, E>>) => Computation<boolean>;
  <A, E>(self: Expr<Queue.Queue<A, E>>, value: Expr<NoInfer<A>>): Computation<boolean>;
} = dual(2, <A, E>(self: Expr<Queue.Queue<A, E>>, value: Expr<A>) => {
  const channels = handle(self);
  if (!IRType.same(channels.success, value.type))
    throw fail(
      "TYPE_MISMATCH",
      "authoring",
      "Queue.offer",
      "Offer payload must match the Queue channel",
    );
  return Computation.make(BoolType, NeverType, {
    _tag: "QueueOperation",
    operation: "Offer",
    ...channels,
    value,
  });
});
const take = <A, E>(self: Expr<Queue.Queue<A, E>>): Computation<A, E> => {
  const channels = handle(self);
  return Computation.make(channels.success, channels.error, {
    _tag: "QueueOperation",
    operation: "Take",
    ...channels,
  });
};
const end = <A>(self: Expr<Queue.Queue<A, Cause.Done<void>>>): Computation<boolean> => {
  const channels = handle(self);
  if (!IRType.same(channels.error, QueueDoneType))
    throw fail(
      "TYPE_MISMATCH",
      "authoring",
      "Queue.end",
      "Queue.end requires the explicit unit Done witness",
    );
  return Computation.make(BoolType, NeverType, {
    _tag: "QueueOperation",
    operation: "End",
    ...channels,
  });
};
const shutdown = <A, E>(self: Expr<Queue.Queue<A, E>>): Computation<boolean> =>
  Computation.make(BoolType, NeverType, {
    _tag: "QueueOperation",
    operation: "Shutdown",
    ...handle(self),
  });
/** Internal reference builders retain End/shutdown and Done; public admission is narrower. */
export const QueueIR = Object.freeze({ make, bounded, offer, take, end, shutdown });

// Separate overloads keep the default Never channel honest: a Done channel requires a witness.
function publicMake<A>(
  success: IRType<A>,
  options: { readonly capacity: number; readonly strategy?: "suspend" },
): Computation<Queue.Queue<A, never>>;
function publicMake<A, E extends Cause.Done<void>>(
  success: IRType<A>,
  options: { readonly capacity: number; readonly strategy?: "suspend" },
  error: IRType<E>,
): Computation<Queue.Queue<A, E>>;
function publicMake<A, E extends Cause.Done<void>>(
  success: IRType<A>,
  options: { readonly capacity: number; readonly strategy?: "suspend" },
  error?: IRType<E>,
): Computation<Queue.Queue<A, never>> | Computation<Queue.Queue<A, E>> {
  return error === undefined ? make(success, options) : make(success, options, error);
}
function publicBounded<A>(success: IRType<A>, capacity: number): Computation<Queue.Queue<A, never>>;
function publicBounded<A, E extends Cause.Done<void>>(
  success: IRType<A>,
  capacity: number,
  error: IRType<E>,
): Computation<Queue.Queue<A, E>>;
function publicBounded<A, E extends Cause.Done<void>>(
  success: IRType<A>,
  capacity: number,
  error?: IRType<E>,
): Computation<Queue.Queue<A, never>> | Computation<Queue.Queue<A, E>> {
  return error === undefined ? bounded(success, capacity) : bounded(success, capacity, error);
}

/** Bounded suspend Queue with optional unit Done; native admission requires checked local recovery. */
export const QueuePublic = Object.freeze({
  make: publicMake,
  bounded: publicBounded,
  offer,
  take,
  end,
});
