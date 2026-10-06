import type { Semaphore } from "effect";
import { Match } from "effect";
import { Computation } from "./effect-ir.ts";
import type { Expr } from "./kernel.ts";
import { IRType, NeverType, fail } from "./kernel.ts";
import { SemaphoreType, validSemaphoreCapacity, validSemaphorePermits } from "./semaphore-model.ts";

const owner = (self: Expr<Semaphore.Semaphore>): symbol => {
  const parameter = Match.value(self.node).pipe(
    Match.tag("Parameter", (node) => node),
    Match.orElse(() => undefined),
  );
  if (!IRType.same(self.type, SemaphoreType) || !parameter || parameter.index !== 0)
    throw fail(
      "RESOURCE_ESCAPE",
      "authoring",
      "Semaphore",
      "Semaphore operations require a lexical handle",
    );
  return parameter.binder;
};
const make = (capacity: number): Computation<Semaphore.Semaphore> => {
  if (!validSemaphoreCapacity(capacity))
    throw fail(
      "INVALID_SEMAPHORE_CAPACITY",
      "authoring",
      "Semaphore.make",
      "Capacity must be a positive safe integer",
    );
  return Computation.make(SemaphoreType, NeverType, { _tag: "SemaphoreMake", capacity });
};
const withPermits = (self: Expr<Semaphore.Semaphore>, permits: number) => {
  const binder = owner(self);
  if (!validSemaphorePermits(permits))
    throw fail(
      "UNSUPPORTED_SEMAPHORE_PERMITS",
      "authoring",
      "Semaphore.withPermits",
      "This initial slice admits exactly one permit",
    );
  return <A, E>(body: Computation<A, E>): Computation<A, E> =>
    Computation.make(body.output, body.error, {
      _tag: "SemaphoreWithPermits",
      binder,
      permits,
      body,
    });
};
/** Lexical scoped Semaphore builders; native execution admits only the checked bounded profile. */
export const SemaphoreIR = Object.freeze({
  make,
  withPermits,
  withPermit: (self: Expr<Semaphore.Semaphore>) => withPermits(self, 1),
});
