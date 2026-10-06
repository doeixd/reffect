import { Cause, Effect, Exit, Fiber, Logger } from "effect";
import { expect, test } from "vite-plus/test";
import { R, Compile, Rust, Reference } from "../src/index.ts";
import {
  Computation,
  EffectReference,
  checkEffectFunction,
  substituteComputation,
  isAsyncComputation,
} from "../src/effect-ir.ts";
import { Expr } from "../src/kernel.ts";
import { LatchIR as L } from "../src/latch.ts";
import { LatchType } from "../src/latch-model.ts";
import { analyzeScopes } from "../src/scope-analysis.ts";
import { analyzeTaskGroups } from "../src/structured-concurrency.ts";
import { analyzeDeferredBudget } from "../src/deferred-budget.ts";
import { analyzeSemaphoreBudget } from "../src/semaphore-budget.ts";
import { analyzeGeneratedDeferredProfile } from "../src/deferred-generated-profile.ts";
import { analyzeGeneratedSemaphoreProfile } from "../src/semaphore-generated-profile.ts";
import { nestingDepth } from "../src/nesting.ts";
import { Provenance } from "../src/provenance.ts";
import { PrivateEffectReference } from "../src/effect-ir.ts";
import { DeferredInterruptionFrames } from "../src/deferred-interruption-frames.ts";

const scoped = <A, E>(
  build: (latch: Expr<import("effect").Latch.Latch>) => Computation<A, E>,
  open = false,
) => L.make(open).pipe(R.Effect.flatMap(build));
const capture = <A, E>(effect: Effect.Effect<A, E>) => {
  const logs: string[] = [];
  return {
    logs,
    run: Effect.runPromise(
      effect.pipe(
        Effect.provideService(
          Logger.CurrentLoggers,
          new Set([
            Logger.make((entry) => {
              logs.push(String(entry.message));
            }),
          ]),
        ),
      ),
    ),
  };
};

test("private interruption boundary records the suspended Latch await and owner", async () => {
  const work = R.fn([], R.Unit, R.Never, () => scoped(L.await));
  const frames = new DeferredInterruptionFrames();
  frames.claim();
  frames.prepare(work.body, "functions.work.body");
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        PrivateEffectReference.runWithFramesUnknown(
          work,
          [],
          "functions.work.body",
          () => [],
          frames.root("functions.work.body"),
        ),
        { startImmediately: true },
      );
      yield* Fiber.interrupt(fiber);
      return yield* Fiber.await(fiber);
    }),
  );
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  expect(frames.snapshot()).toEqual({
    frames: [
      { kind: "latchAwait", path: "functions.work.body.body" },
      { kind: "latchScope", path: "functions.work.body" },
      { kind: "function", path: "functions.work" },
    ],
    omitted: 0,
  });
});
test("private Latch builders mirror state transitions through both official references", async () => {
  for (const initial of [false, true]) {
    for (const [operation, expected] of [
      [L.isOpen, initial],
      [L.open, !initial],
      [L.close, initial],
      [L.release, !initial],
    ] as const) {
      const work = R.fn([], R.Bool, R.Never, () => scoped(operation, initial));
      expect(checkEffectFunction(work, "work")).toEqual([]);
      expect(await Effect.runPromise(EffectReference.runUnknown(work, []))).toBe(expected);
      expect((await Effect.runPromise(EffectReference.runWithFrames(work, []))).exit).toEqual(
        Exit.succeed(expected),
      );
    }
  }
  const twice = R.fn([], R.Bool, R.Never, () =>
    scoped((owner) => L.open(owner).pipe(R.Effect.andThen(L.open(owner)))),
  );
  expect(await Effect.runPromise(EffectReference.run(twice, []))).toBe(false);
  const pulse = R.fn([], R.Bool, R.Never, () =>
    scoped((owner) => L.release(owner).pipe(R.Effect.andThen(L.isOpen(owner)))),
  );
  expect(await Effect.runPromise(EffectReference.run(pulse, []))).toBe(false);
  expect("Latch" in R).toBe(false);
});

test("whenOpen supports data-first/data-last and is await-then-body", async () => {
  for (const dataLast of [false, true]) {
    const work = R.fn([], R.U64, R.Never, () =>
      scoped(
        (owner) =>
          dataLast
            ? R.Effect.succeed(R.U64.literal(7n)).pipe(L.whenOpen(owner))
            : L.whenOpen(owner, R.Effect.succeed(R.U64.literal(7n))),
        true,
      ),
    );
    expect(await Effect.runPromise(EffectReference.runUnknown(work, []))).toBe(7n);
  }
  const work = R.fn([], R.Unit, R.Never, () =>
    scoped((owner) =>
      R.Effect.all(
        [
          L.await(owner).pipe(
            R.Effect.andThen(R.Log.info("resumed")),
            R.Effect.andThen(L.isOpen(owner)),
            R.Effect.flatMap((isOpen) =>
              R.Match.bool(isOpen, R.Log.info("open"), R.Log.info("closed")),
            ),
          ),
          L.open(owner).pipe(R.Effect.andThen(L.close(owner)), R.Effect.asVoid),
        ],
        { concurrency: "unbounded", discard: true },
      ),
    ),
  );
  const observed = capture(EffectReference.runUnknown(work, []));
  await observed.run;
  expect(observed.logs).toEqual(["resumed", "closed"]);
});

test("release is a pulse, not stored credit for future waits; cancellation runs cleanup", async () => {
  const work = R.fn([], R.Unit, R.Never, () =>
    scoped((owner) =>
      L.release(owner).pipe(
        R.Effect.andThen(L.await(owner)),
        R.Effect.ensuring(R.Log.info("cleanup")),
      ),
    ),
  );
  const observed = capture(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(EffectReference.runUnknown(work, []));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      return yield* Fiber.await(fiber);
    }),
  );
  const exit = await observed.run;
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  expect(observed.logs).toEqual(["cleanup"]);
});

test("lexical handles cannot escape through values, expressions or public channels", () => {
  const rogue = Expr.parameter(LatchType, Symbol("rogue"), 0);
  const awaitWork = R.fn([], R.Unit, R.Never, () => L.await(rogue));
  expect(checkEffectFunction(awaitWork, "work").map((d) => d.code)).toContain("RESOURCE_ESCAPE");
  for (const operation of [L.open, L.close, L.release, L.isOpen]) {
    const work = R.fn([], R.Bool, R.Never, () => operation(rogue));
    expect(checkEffectFunction(work, "work").map((d) => d.code)).toContain("RESOURCE_ESCAPE");
  }
  const escaped = R.fn([], LatchType, R.Never, () => L.make());
  expect(checkEffectFunction(escaped, "escaped").map((d) => d.code)).toContain("RESOURCE_ESCAPE");
  const leaked = R.fn([], LatchType, R.Never, () => scoped((owner) => R.Effect.succeed(owner)));
  expect(checkEffectFunction(leaked, "leaked").map((d) => d.code)).toContain("RESOURCE_ESCAPE");
  // @ts-expect-error only literal Boolean initial states are admitted
  expect(() => L.make(1)).toThrowError(/literal Boolean/);
  const malformed = R.fn([], R.Unit, R.Never, () =>
    Computation.make(R.Unit, R.Never, {
      _tag: "LatchScope",
      open: false,
      binder: Symbol(),
      body: L.open(rogue),
    }),
  );
  expect(checkEffectFunction(malformed, "malformed").map((d) => d.code)).toContain("TYPE_MISMATCH");
});

test("framed Latch scopes retain typed failures from gated bodies", async () => {
  const work = R.fn([], R.Unit, R.Bool, () =>
    scoped((owner) => L.whenOpen(owner, R.Effect.fail(R.Bool.literal(true))), true),
  );
  const result = await Effect.runPromise(EffectReference.runWithFrames(work, []));
  expect(Exit.isFailure(result.exit)).toBe(true);
  if (Exit.isFailure(result.exit))
    expect(
      result.exit.cause.reasons.map((reason) =>
        reason._tag === "Fail" ? reason.error : reason._tag,
      ),
    ).toEqual([true]);
  expect(result.frames.map((frame) => frame.kind)).toEqual([
    "fail",
    "flatMap",
    "latchScope",
    "function",
  ]);
});

test("public pure references reject lexical Latch handles before evaluation", async () => {
  const work = R.fn([LatchType], LatchType, (owner) => owner);
  const result = await Effect.runPromise(Reference.runUnknown(work, []).pipe(Effect.exit));
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result))
    expect(
      result.cause.reasons.flatMap((reason) =>
        reason._tag === "Fail" ? reason.error.diagnostics.map((d) => d.code) : [],
      ),
    ).toContain("RESOURCE_ESCAPE");
});

test("substitution preserves owner identity and reaches whenOpen body expressions", async () => {
  const external = Symbol("external");
  const authored = scoped(
    (owner) => L.whenOpen(owner, R.Effect.succeed(Expr.parameter(R.U64, external, 0))),
    true,
  );
  const replaced = substituteComputation(authored, external, () => R.U64.literal(19n));
  const work = R.fn([], R.U64, R.Never, () => replaced as Computation<bigint>);
  expect(checkEffectFunction(work, "work")).toEqual([]);
  expect(await Effect.runPromise(EffectReference.runUnknown(work, []))).toBe(19n);
  expect(isAsyncComputation(authored)).toBe(true);
  expect(isAsyncComputation(scoped(L.isOpen))).toBe(false);
});

test("Latch exhaustive traversals retain provenance and registered cleanup diagnostics", () => {
  const body = scoped(() =>
    R.Effect.all([R.Clock.currentTimeMillis.pipe(R.Effect.asVoid), R.Effect.void], {
      concurrency: "unbounded",
      discard: true,
    }),
  );
  const work = R.fn([], R.Unit, R.Never, () => body);
  expect(nestingDepth(work)).toBeGreaterThan(3);
  expect(analyzeTaskGroups(body).childClockPaths).toEqual(["body.body.children[0].source"]);
  expect(new Provenance(R.program({ work })).snapshot().occurrences.map((o) => o.path)).toContain(
    "functions.work.body.body.children[0].source",
  );
  const escaping = scoped((owner) =>
    R.Effect.scoped(R.Effect.addFinalizer(() => L.open(owner).pipe(R.Effect.asVoid))),
  );
  expect(analyzeScopes(escaping).diagnostics.map((d) => d.code)).toContain("RESOURCE_ESCAPE");
  const lexicalCleanup = scoped((owner) =>
    R.Effect.void.pipe(R.Effect.ensuring(L.close(owner).pipe(R.Effect.asVoid))),
  );
  expect(analyzeScopes(lexicalCleanup).diagnostics).toEqual([]);
});

test("native compilation and other coordination receipts refuse Latch without executing authored logs", async () => {
  const work = R.fn([], R.Unit, R.Never, () =>
    scoped((owner) => R.Log.info("must not run").pipe(R.Effect.andThen(L.await(owner)))),
  );
  const observed = capture(
    Compile.make(R.program({ work })).pipe(
      Compile.withTarget(Rust.tokio),
      Compile.run,
      Effect.exit,
    ),
  );
  const result = await observed.run;
  expect(observed.logs).toEqual([]);
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result))
    expect(
      result.cause.reasons.flatMap((reason) =>
        reason._tag === "Fail" ? reason.error.diagnostics.map((d) => d.code) : [],
      ),
    ).toContain("LATCH_NATIVE_UNSUPPORTED");
  expect(analyzeDeferredBudget(work).diagnostics.map((d) => d.code)).toContain(
    "DEFERRED_BUDGET_UNACCOUNTED",
  );
  expect(analyzeSemaphoreBudget(work).diagnostics.map((d) => d.code)).toContain(
    "SEMAPHORE_STRUCTURAL_PROFILE",
  );
  const deferred = R.fn([], R.Unit, R.Never, () =>
    R.Deferred.make(R.Unit).pipe(R.Effect.flatMap(() => work.body)),
  );
  const semaphore = R.fn([], R.Unit, R.Never, () =>
    R.Semaphore.make(1).pipe(R.Effect.flatMap((owner) => R.Semaphore.withPermit(owner)(work.body))),
  );
  expect(() => analyzeGeneratedDeferredProfile(R.program({ deferred }))).toThrow();
  expect(() => analyzeGeneratedSemaphoreProfile(R.program({ semaphore }))).toThrow();
});
