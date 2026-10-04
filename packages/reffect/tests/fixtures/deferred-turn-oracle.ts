import { Deferred, Effect, Exit, Fiber } from "effect";

/** Independent official-Effect oracle. Registration is asserted directly; no timer orders callbacks. */
export type DeferredTurnScenario =
  | "reversed-registration"
  | "waiter-yields"
  | "nested-completion"
  | "nested-waiter-yields"
  | "interrupt-next-waiter"
  | "interrupt-producer"
  | "interrupt-masked-producer";

export const deferredTurnExpected: Readonly<Record<DeferredTurnScenario, readonly string[]>> = {
  "reversed-registration": ["w2:resumed", "w1:resumed", "producer:true"],
  "waiter-yields": ["w1:resumed", "w2:resumed", "producer:true", "w1:after-yield"],
  "nested-completion": [
    "w1:resumed",
    "other:resumed",
    "nested:true",
    "w2:resumed",
    "producer:true",
  ],
  "nested-waiter-yields": [
    "w1:resumed",
    "other:resumed",
    "nested:true",
    "w2:resumed",
    "producer:true",
    "other:after-yield",
  ],
  "interrupt-next-waiter": ["w1:resumed", "interrupt-w2", "w2:cleanup", "producer:true"],
  "interrupt-producer": ["w1:resumed", "interrupt-producer", "w2:resumed", "producer:cleanup"],
  "interrupt-masked-producer": [
    "w1:resumed",
    "interrupt-producer",
    "w2:resumed",
    "producer:true",
    "producer:cleanup",
  ],
};

export const deferredTurnOracle = (scenario: DeferredTurnScenario) =>
  Effect.gen(function* () {
    const trace: string[] = [];
    const main = Deferred.makeUnsafe<number>();
    const secondary = Deferred.makeUnsafe<number>();
    const start = Deferred.makeUnsafe<void>();
    const log = (message: string) =>
      Effect.sync(() => {
        trace.push(message);
      });
    const nested = scenario === "nested-completion" || scenario === "nested-waiter-yields";
    let second: Fiber.Fiber<void>;
    let producer: Fiber.Fiber<void>;
    const firstBody = Effect.gen(function* () {
      yield* Deferred.await(main);
      yield* log("w1:resumed");
      if (scenario === "waiter-yields") {
        yield* Effect.yieldNow;
        yield* log("w1:after-yield");
      }
      if (nested) {
        const first = yield* Deferred.succeed(secondary, 9);
        yield* log(`nested:${first}`);
      }
      if (scenario === "interrupt-next-waiter") {
        yield* log("interrupt-w2");
        yield* Effect.sync(() => second.interruptUnsafe());
      }
      if (scenario === "interrupt-producer" || scenario === "interrupt-masked-producer") {
        yield* log("interrupt-producer");
        yield* Effect.sync(() => producer.interruptUnsafe());
      }
    });
    const secondBody = Effect.gen(function* () {
      yield* Deferred.await(main);
      yield* log("w2:resumed");
    });
    const secondEffect =
      scenario === "interrupt-next-waiter"
        ? Effect.ensuring(secondBody, log("w2:cleanup"))
        : secondBody;
    let first: Fiber.Fiber<void>;
    if (scenario === "reversed-registration") {
      second = yield* Effect.forkChild(secondEffect, { startImmediately: true });
      first = yield* Effect.forkChild(firstBody, { startImmediately: true });
    } else {
      first = yield* Effect.forkChild(firstBody, { startImmediately: true });
      second = yield* Effect.forkChild(secondEffect, { startImmediately: true });
    }
    const observers = [first, second];
    if (nested) {
      const other = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Deferred.await(secondary);
          yield* log("other:resumed");
          if (scenario === "nested-waiter-yields") {
            yield* Effect.yieldNow;
            yield* log("other:after-yield");
          }
        }),
        { startImmediately: true },
      );
      observers.push(other);
    }
    yield* Effect.sync(() => {
      if (main.resumes?.length !== 2) throw new Error("Both main callbacks must be registered");
      if (nested && secondary.resumes?.length !== 1)
        throw new Error("Secondary callback must be registered");
    });
    const produce = Effect.gen(function* () {
      yield* Deferred.await(start);
      const won = yield* Deferred.succeed(main, 7);
      yield* log(`producer:${won}`);
    });
    const masked =
      scenario === "interrupt-masked-producer" ? Effect.uninterruptible(produce) : produce;
    const withCleanup =
      scenario === "interrupt-producer" || scenario === "interrupt-masked-producer"
        ? Effect.ensuring(masked, log("producer:cleanup"))
        : masked;
    producer = yield* Effect.forkChild(withCleanup, { startImmediately: true });
    yield* Effect.sync(() => {
      if (start.resumes?.length !== 1) throw new Error("Producer gate must be registered");
    });
    yield* Deferred.succeed(start, undefined);
    const producerExit = yield* Fiber.await(producer);
    yield* Fiber.awaitAll(observers);
    return { trace, producerInterrupted: Exit.isFailure(producerExit) };
  });
