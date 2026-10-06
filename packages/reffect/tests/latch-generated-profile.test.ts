import { Effect, Exit } from "effect";
import { expect, test } from "vite-plus/test";
import { Compile, R, Rust } from "../src/index.ts";
import { Computation, EffectFn } from "../src/effect-ir.ts";
import { CompileError, EqU64, Expr as Expression, Operation } from "../src/kernel.ts";
import type { Expr } from "../src/kernel.ts";
import { LatchIR as L } from "../src/latch.ts";
import { analyzeGeneratedLatchProfile } from "../src/latch-generated-profile.ts";
import { generatedDeferredGrowthLimits } from "../src/deferred-growth.ts";

const lexical = <A>(
  build: (owner: Expr<import("effect").Latch.Latch>) => Computation<A>,
  open = false,
) => L.make(open).pipe(R.Effect.flatMap(build));
const unit = (build: (owner: Expr<import("effect").Latch.Latch>) => Computation<void>) =>
  R.fn([], R.Unit, R.Never, () => lexical(build));
const all = (
  values:
    | readonly [Computation<void>, Computation<void>]
    | readonly [Computation<void>, Computation<void>, Computation<void>],
) => R.Effect.all(values, { concurrency: "unbounded", discard: true });
const analyze = (work: EffectFn) => analyzeGeneratedLatchProfile(R.program({ work })).get(work)!;
const growthRefusal = (work: EffectFn, detail: string) => {
  let failure: unknown;
  try {
    analyze(work);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(CompileError);
  expect(
    (failure as CompileError).diagnostics.some((issue) => issue.message.includes(detail)),
  ).toBe(true);
};

test("private receipts bound owner slots, expanded signals, awaits and timers", () => {
  const work = unit((owner) =>
    all([L.await(owner), L.await(owner), L.release(owner).pipe(R.Effect.asVoid)]),
  );
  const profile = analyze(work);
  expect(profile.ownerCount).toBe(1);
  expect(profile.taskCapacity).toBe(4);
  expect(profile.bounds.awaits).toBe(2);
  expect(profile.bounds.signals).toBe(1);
  expect(profile.driver).toEqual({
    protocolRetries: 1,
    cohorts: 1,
    callbacks: 2,
    settlementRounds: 3,
    timerRegistrations: profile.bounds.computationOccurrences,
  });
  expect(analyze(unit((owner) => L.open(owner).pipe(R.Effect.asVoid))).taskCapacity).toBe(1);
});

test("shared DAG edges and all source branches contribute finite work", () => {
  const work = unit((owner) => {
    const pulse = L.release(owner).pipe(R.Effect.asVoid);
    return R.Match.bool(R.Bool.literal(true), pulse, pulse.pipe(R.Effect.andThen(pulse)));
  });
  expect(analyze(work).bounds.signals).toBe(3);
});

test("builtin identity lookalikes are refused without evaluating their callback", () => {
  let calls = 0;
  const alias = Operation.make(EqU64.ref, [R.U64, R.U64], R.Bool, () => {
    calls++;
    return true;
  });
  const work = R.fn([], R.Bool, R.Never, () =>
    lexical(() => R.Effect.succeed(Expression.apply(alias, R.U64.literal(1n), R.U64.literal(1n)))),
  );
  expect(() => analyze(work)).toThrowError(/Only audited builtin scalar expressions/);
  expect(calls).toBe(0);
});

test("unsupported topology, owners and cleanup awaits refuse before lowering", () => {
  for (const work of [
    unit((owner) => all([all([L.await(owner), R.Effect.void]), R.Effect.void])),
    unit((owner) =>
      all([L.await(owner), R.Effect.void]).pipe(
        R.Effect.andThen(all([R.Effect.void, R.Effect.void])),
      ),
    ),
    unit(() => L.make(true).pipe(R.Effect.flatMap((other) => L.await(other)))),
    unit(() =>
      R.Semaphore.make(1).pipe(
        R.Effect.flatMap((owner) => R.Semaphore.withPermit(owner)(R.Effect.void)),
      ),
    ),
    unit((owner) => R.Effect.void.pipe(R.Effect.ensuring(L.await(owner)))),
    unit((owner) => R.Effect.void.pipe(R.Effect.ensuring(all([L.await(owner), R.Effect.void])))),
  ])
    expect(() => analyze(work)).toThrow();
  expect(() =>
    analyze(unit((owner) => R.Effect.void.pipe(R.Effect.ensuring(L.await(owner))))),
  ).toThrowError(/masked cleanup/);
  expect(() => analyze(R.fn([R.Bool], R.Unit, R.Never, () => lexical(L.await)))).toThrowError(
    /zero inputs/,
  );
});

test("uniform positive timer gates include finalizers and reject queued yields", () => {
  expect(
    analyze(
      unit((owner) =>
        all([
          L.await(owner).pipe(R.Effect.ensuring(R.Effect.sleep(2))),
          R.Effect.sleep(2).pipe(R.Effect.andThen(L.open(owner)), R.Effect.asVoid),
        ]),
      ),
    ).taskCapacity,
  ).toBe(3);
  expect(() =>
    analyze(
      unit((owner) =>
        all([
          L.await(owner).pipe(R.Effect.ensuring(R.Effect.sleep(3))),
          R.Effect.sleep(2).pipe(R.Effect.andThen(L.open(owner)), R.Effect.asVoid),
        ]),
      ),
    ),
  ).toThrowError(/uniform positive duration/);
  expect(() =>
    analyze(
      unit((owner) =>
        all([
          L.await(owner).pipe(R.Effect.ensuring(R.Effect.sleep(0))),
          L.open(owner).pipe(R.Effect.asVoid),
        ]),
      ),
    ),
  ).toThrowError(/queued-yield adapter/);
  expect(
    analyze(unit((owner) => R.Effect.sleep(0).pipe(R.Effect.andThen(L.await(owner))))).taskCapacity,
  ).toBe(1);
});

test("source, expression, text and cyclic growth refuse rather than recurse forever", () => {
  let body: Computation<void> = R.Effect.void;
  for (let i = 0; i < generatedDeferredGrowthLimits.computationDepth; i++)
    body = body.pipe(R.Effect.ensuring(R.Effect.void));
  growthRefusal(
    unit(() => body),
    "computationDepth",
  );
  growthRefusal(
    unit(() => R.Log.info("x".repeat(generatedDeferredGrowthLimits.textBytes + 1))),
    "textBytes",
  );
  let branches = R.Effect.void;
  for (let i = 0; i < 9; i++) branches = R.Match.bool(R.Bool.literal(true), branches, branches);
  growthRefusal(
    unit(() => branches),
    "computationOccurrences",
  );
  const cyclic: Computation<void> = Computation.make(R.Unit, R.Never, {
    _tag: "Ensuring",
    get body() {
      return cyclic;
    },
    finalizer: R.Effect.void,
  });
  growthRefusal(
    unit(() => cyclic),
    "Cyclic computation",
  );
  let deep = R.Bool.literal(true);
  for (let i = 0; i < generatedDeferredGrowthLimits.expressionDepth; i++)
    deep = Expression.match(R.Bool.literal(true), deep, R.Bool.literal(false));
  growthRefusal(
    R.fn([], R.Bool, R.Never, () => lexical(() => R.Effect.succeed(deep))),
    "expressionDepth",
  );
});

test("private selection leaves public Compile refusal and authored work untouched", async () => {
  const work = unit((owner) => R.Log.info("unreachable").pipe(R.Effect.andThen(L.await(owner))));
  expect(analyze(work).taskCapacity).toBe(1);
  const result = await Effect.runPromise(
    Compile.make(R.program({ work })).pipe(
      Compile.withTarget(Rust.tokio),
      Compile.run,
      Effect.exit,
    ),
  );
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result))
    expect(
      result.cause.reasons.flatMap((reason) =>
        reason._tag === "Fail" ? reason.error.diagnostics.map((d) => d.code) : [],
      ),
    ).toContain("LATCH_NATIVE_UNSUPPORTED");
});
