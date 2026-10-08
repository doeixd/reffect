import { Cause, Context, Effect, Exit, Fiber, Logger, Scheduler } from "effect";
import { expect, test } from "vite-plus/test";
import { R } from "../src/authoring.ts";
import { Computation, PrivateEffectReference } from "../src/effect-ir.ts";
import type { EffectFn } from "../src/effect-ir.ts";
import { DeferredInterruptionFrames } from "../src/deferred-interruption-frames.ts";
import { QueueIR as Q } from "../src/queue.ts";
import { QueueDoneType } from "../src/queue-model.ts";
import { analyzeQueueBudget, queueBudgetLimit } from "../src/queue-budget.ts";
import { defaultDeferredBudgetContext } from "../src/deferred-budget.ts";
import { analyzeGeneratedQueueCleanupProfile } from "../src/queue-generated-profile.ts";

class Probe extends Scheduler.MixedScheduler {
  maximum = 0;
  yields = 0;
  override shouldYield(fiber: Fiber.Fiber<unknown, unknown>): boolean {
    this.maximum = Math.max(this.maximum, fiber.currentOpCount);
    const decision = super.shouldYield(fiber);
    if (decision) this.yields++;
    return decision;
  }
}
const all = <E, E2>(a: Computation<void, E>, b: Computation<void, E2>) =>
  R.Effect.all([a, b], { concurrency: "unbounded", discard: true });
const cleanup = (milliseconds = 1) =>
  R.Log.info("cleanup:start").pipe(
    R.Effect.andThen(R.Effect.sleep(milliseconds)),
    R.Effect.andThen(R.Log.info("cleanup:end")),
  );
const sequence = (steps: readonly Computation<void>[]): Computation<void> => {
  if (steps.length === 1) return steps[0];
  const split = Math.floor(steps.length / 2);
  return sequence(steps.slice(0, split)).pipe(R.Effect.andThen(sequence(steps.slice(split))));
};
const fixture = (kind: string, finalizer = cleanup()) =>
  R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.U64, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) => {
        const take = Q.take(owner).pipe(R.Effect.asVoid);
        const end = Q.end(owner).pipe(R.Effect.asVoid);
        const child =
          kind === "cleanup-interrupt"
            ? Q.offer(owner, R.U64.literal(1n)).pipe(R.Effect.asVoid, R.Effect.andThen(take))
            : take;
        const peer =
          kind === "source-interrupt"
            ? R.Effect.void
            : kind === "success"
              ? Q.offer(owner, R.U64.literal(1n)).pipe(R.Effect.asVoid, R.Effect.andThen(end))
              : end;
        return all(child.pipe(R.Effect.ensuring(finalizer)), peer).pipe(
          R.Effect.catch(() => R.Log.info("recovered")),
        );
      }),
    ),
  );
const receipt = (fn: EffectFn, observed = true) =>
  analyzeQueueBudget(fn, "body", defaultDeferredBudgetContext, observed, true);

// The opt-in is accounting, not generated topology admission.
test("Queue cleanup receipts are opt-in and retain child decorations without root observers", () => {
  const fn = fixture("done");
  expect(analyzeQueueBudget(fn).admitted).toBe(false);
  const ordinary = fixture("done", R.Effect.void);
  const a = receipt(ordinary),
    b = receipt(fn),
    bare = receipt(fn, false);
  expect(a.admitted && b.admitted).toBe(true);
  // Replacing Unit with Log -> Sleep -> Log changes cleanup expansion by31/39.
  expect(b.plain - a.plain).toBe(31);
  expect(b.framed - a.framed).toBe(39);
  // Only the root QueueScope/CatchAll/All/recovery spine adds observers.
  expect(b.framed - bare.framed).toBe(80);
  expect(b).toMatchObject({ offers: 0, takes: 1, terminals: 1 });
  expect(Object.isFrozen(b)).toBe(true);
  for (const milliseconds of [0, -1, 0.5, Infinity, NaN, 2147483648])
    expect(
      receipt(fixture("done", Computation.make(R.Unit, R.Never, { _tag: "Sleep", milliseconds })))
        .admitted,
    ).toBe(false);
  expect(
    receipt(
      fixture(
        "done",
        Computation.make(R.Unit, R.Never, { _tag: "Sleep", milliseconds: 2147483647 }),
      ),
    ).admitted,
  ).toBe(true);
});

test("shared cleanup incoming edges count fully and dormant oversized cleanup is refused", () => {
  const shared = cleanup();
  const make = (twice: boolean) =>
    R.fn([], R.Unit, R.Never, () =>
      Q.bounded(R.U64, 1, QueueDoneType).pipe(
        R.Effect.flatMap((owner) =>
          all(
            Q.take(owner).pipe(R.Effect.asVoid, R.Effect.ensuring(shared)),
            Q.end(owner).pipe(R.Effect.asVoid, R.Effect.ensuring(twice ? shared : R.Effect.void)),
          ).pipe(R.Effect.catch(() => R.Effect.void)),
        ),
      ),
    );
  const once = receipt(make(false)),
    twice = receipt(make(true));
  expect(twice.plain - once.plain).toBe(31);
  expect(twice.framed - once.framed).toBe(39);
  let large: Computation<void> = R.Effect.void;
  for (let i = 0; i < 400; i++) large = large.pipe(R.Effect.andThen(R.Effect.void));
  // Even a branch that will never execute contributes its finite worst-case receipt.
  const dormant = R.Match.bool(R.Bool.literal(true), R.Effect.void, large);
  expect(receipt(fixture("done", dormant))).toMatchObject({
    admitted: false,
    framed: queueBudgetLimit,
    diagnostics: [{ code: "QUEUE_BUDGET_EXCEEDED" }],
  });
});

test("official Queue cleanup success, Done and interruption stay under plain/framed receipts", async () => {
  for (const kind of ["success", "done", "source-interrupt", "cleanup-interrupt", "heavy"]) {
    for (const framed of [false, true]) {
      const fn = fixture(
          kind,
          kind === "heavy"
            ? sequence([...Array.from({ length: 60 }, () => R.Log.info("cleanup:work")), cleanup()])
            : cleanup(),
        ),
        bound = receipt(fn),
        probe = new Probe();
      const logs: string[] = [];
      const signal = new AbortController();
      const context = Context.empty().pipe(
        Context.add(Scheduler.Scheduler, probe),
        Context.add(Scheduler.MaxOpsBeforeYield, 2048),
        Context.add(Scheduler.PreventSchedulerYield, false),
        Context.add(
          Logger.CurrentLoggers,
          new Set([
            Logger.make((event) => {
              const message = String(event.message);
              logs.push(message);
              if (kind === "cleanup-interrupt" && message === "cleanup:start") signal.abort();
            }),
          ]),
        ),
      );
      const check = () => {
        analyzeGeneratedQueueCleanupProfile(R.program({ work: fn }));
        return [];
      };
      const frames = new DeferredInterruptionFrames();
      const effect = framed
        ? PrivateEffectReference.runWithFramesUnknown(
            fn,
            [],
            "functions.work.body",
            () => {
              check();
              frames.claim();
              frames.prepare(fn.body, "functions.work.body");
              return [];
            },
            frames.root("functions.work.body"),
          ).pipe(Effect.map((value) => value.exit))
        : PrivateEffectReference.runUnknown(fn, [], check).pipe(Effect.exit);
      const fiber = Effect.runForkWith(context)(effect, { signal: signal.signal });
      if (kind === "source-interrupt") {
        expect(fiber.pollUnsafe()).toBeUndefined();
        expect(logs).toEqual([]);
        fiber.interruptUnsafe();
      }
      const outer = await Effect.runPromise(Fiber.await(fiber));
      const exit = Exit.isSuccess(outer) ? outer.value : outer;
      if (kind.endsWith("interrupt")) {
        expect(
          Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
          `${kind}/${framed}: ${JSON.stringify(exit)}`,
        ).toBe(true);
        expect(logs).toEqual(["cleanup:start", "cleanup:end"]);
      } else {
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(logs).toEqual(
          kind === "success"
            ? ["cleanup:start", "cleanup:end"]
            : kind === "heavy"
              ? [
                  ...Array.from({ length: 60 }, () => "cleanup:work"),
                  "cleanup:start",
                  "cleanup:end",
                  "recovered",
                ]
              : ["cleanup:start", "cleanup:end", "recovered"],
        );
      }
      expect(probe.maximum).toBeLessThanOrEqual(framed ? bound.framed : bound.plain);
      expect(probe.yields).toBe(0);
      if (kind === "heavy") {
        // Removing cleanup accounting produces a receipt below actual evaluator work.
        const omitted = receipt(fixture("done", R.Effect.void));
        expect(probe.maximum).toBeGreaterThan(framed ? omitted.framed : omitted.plain);
      }
    }
  }
});
