import { expect, test } from "vite-plus/test";
import { R } from "../src/index.ts";
import { Computation, matchComputation } from "../src/effect-ir.ts";
import type { Expr } from "../src/kernel.ts";
import { Expr as Expression } from "../src/kernel.ts";
import { SemaphoreIR as S } from "../src/semaphore.ts";
import { SemaphoreType } from "../src/semaphore-model.ts";
import { analyzeSemaphoreStructure, semaphoreStructureLimits } from "../src/semaphore-structure.ts";

const all = (
  children:
    | readonly [Computation<void>, Computation<void>]
    | readonly [Computation<void>, Computation<void>, Computation<void>],
) => R.Effect.all(children, { concurrency: "unbounded", discard: true });
const lexical = (
  build: (owner: Expr<import("effect").Semaphore.Semaphore>) => Computation<void>,
  capacity = 1,
) => R.fn([], R.Unit, R.Never, () => S.make(capacity).pipe(R.Effect.flatMap(build)));
const scope = (body: Computation<void>, capacity = 1) =>
  R.fn([], R.Unit, R.Never, () =>
    Computation.make(R.Unit, R.Never, {
      _tag: "SemaphoreScope",
      capacity,
      binder: Symbol("owner"),
      body,
    }),
  );
const refusal = (
  fn: Parameters<typeof analyzeSemaphoreStructure>[0],
  code = "SEMAPHORE_STRUCTURAL_PROFILE",
) => {
  const result = analyzeSemaphoreStructure(fn, "test.body");
  expect(result.structurallyAdmitted).toBe(false);
  expect(result.bounds).toBeUndefined();
  expect(result.diagnostics.map((issue) => issue.code)).toContain(code);
  expect(result.diagnostics.every((issue) => issue.path.startsWith("test.body"))).toBe(true);
};

test("zero-input scalar/Never lexical owners admit capacities one through three", () => {
  for (const capacity of [1, 2, 3]) {
    for (const fn of [
      lexical((owner) => S.withPermit(owner)(R.Effect.void), capacity),
      R.fn([], R.Bool, R.Never, () =>
        S.make(capacity).pipe(
          R.Effect.flatMap((owner) => S.withPermit(owner)(R.Effect.succeed(R.Bool.literal(true)))),
        ),
      ),
      R.fn([], R.U64, R.Never, () =>
        S.make(capacity).pipe(
          R.Effect.flatMap((owner) => S.withPermit(owner)(R.Effect.succeed(R.U64.literal(7n)))),
        ),
      ),
    ]) {
      const result = analyzeSemaphoreStructure(fn);
      expect(result.diagnostics).toEqual([]);
      expect(result.profile).toBe("private-semaphore-structure@1");
      expect(result.structurallyAdmitted).toBe(true);
      expect(result.bounds).toEqual({
        computationOccurrences: 3,
        expressionOccurrences: 1,
        computationDepth: 3,
        expressionDepth: 1,
        acquisitions: 1,
        releases: 1,
        releaseScans: 1,
        registrations: 2,
        selectedCallbacks: 2,
        taskCapacity: 1,
        waiterCapacity: 1,
      });
    }
  }
});

test("branches use execution maxima and source occurrence sums", () => {
  const result = analyzeSemaphoreStructure(
    lexical((owner) => {
      const guard = S.withPermit(owner)(R.Effect.void);
      return matchComputation(R.Bool.literal(true), guard, guard.pipe(R.Effect.andThen(guard)));
    }),
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.bounds).toMatchObject({
    computationOccurrences: 9,
    expressionOccurrences: 4,
    acquisitions: 2,
    releases: 2,
    releaseScans: 2,
    registrations: 4,
  });
});

test("shared DAG nodes are charged once per incoming occurrence", () => {
  const result = analyzeSemaphoreStructure(
    lexical((owner) => {
      const shared = S.withPermit(owner)(R.Effect.void);
      return shared.pipe(R.Effect.andThen(shared));
    }),
  );
  expect(result.bounds).toMatchObject({
    computationOccurrences: 6,
    expressionOccurrences: 2,
    acquisitions: 2,
  });
});

test("All2/3 bound live tasks, waiters and conservative re-registrations", () => {
  for (const width of [2, 3]) {
    const result = analyzeSemaphoreStructure(
      lexical((owner) => {
        const guard = S.withPermit(owner)(R.Effect.void);
        return width === 2 ? all([guard, guard]) : all([guard, guard, guard]);
      }),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.bounds).toMatchObject({
      computationOccurrences: 2 + 2 * width,
      expressionOccurrences: width,
      acquisitions: width,
      releaseScans: width,
      taskCapacity: width + 1,
      waiterCapacity: width,
      registrations: width + width * width,
      selectedCallbacks: width + width * width,
    });
  }
});

test("profile refuses inputs, non-scalar or failing channels and invalid lexical roots", () => {
  refusal(R.fn([R.Bool], R.Unit, R.Never, () => scope(R.Effect.void).body));
  refusal(
    R.fn([], R.Unit, R.Bool, () =>
      S.make(1).pipe(R.Effect.flatMap(() => R.Effect.fail(R.Bool.literal(true)))),
    ),
  );
  refusal(R.fn([], SemaphoreType, R.Never, () => S.make(1)));
  refusal(R.fn([], R.Unit, R.Never, () => R.Effect.void));
  for (const capacity of [0, 4, 1.5, NaN, Infinity]) refusal(scope(R.Effect.void, capacity));
});

test("escaped owners and malformed permit counts are refused", () => {
  const rogue = Expression.parameter(SemaphoreType, Symbol("escaped"), 0);
  refusal(scope(S.withPermit(rogue)(R.Effect.void)), "RESOURCE_ESCAPE");
  refusal(
    lexical((owner) =>
      Computation.make(R.Unit, R.Never, {
        _tag: "SemaphoreWithPermits",
        binder: owner.node._tag === "Parameter" ? owner.node.binder : Symbol(),
        permits: 2,
        body: R.Effect.void,
      }),
    ),
  );
});

test("nested acquisition and acquisition or coordination in cleanup are refused", () => {
  refusal(lexical((owner) => S.withPermit(owner)(S.withPermit(owner)(R.Effect.void))));
  refusal(
    lexical((owner) => R.Effect.void.pipe(R.Effect.ensuring(S.withPermit(owner)(R.Effect.void)))),
  );
  refusal(
    lexical(() => R.Effect.void.pipe(R.Effect.ensuring(all([R.Effect.void, R.Effect.void])))),
  );
  const deferredCleanup = R.Deferred.make(R.Unit).pipe(R.Effect.flatMap(() => R.Effect.void));
  refusal(lexical(() => R.Effect.void.pipe(R.Effect.ensuring(deferredCleanup))));
});

test("nested, repeated, branched, oversized and non-All groups are refused", () => {
  const group = all([R.Effect.void, R.Effect.void]);
  refusal(scope(all([group, R.Effect.void])));
  refusal(scope(group.pipe(R.Effect.andThen(group))));
  refusal(scope(matchComputation(R.Bool.literal(true), group, group)));
  for (const children of [[R.Effect.void], Array.from({ length: 4 }, () => R.Effect.void)])
    refusal(scope(Computation.make(R.Unit, R.Never, { _tag: "TaskGroup", mode: "All", children })));
  refusal(
    scope(
      Computation.make(R.Unit, R.Never, {
        _tag: "TaskGroup",
        mode: "Race",
        children: [R.Effect.void, R.Effect.void],
      }),
    ),
  );
  refusal(lexical(() => S.make(1).pipe(R.Effect.flatMap(() => R.Effect.void))));
});

test("computation cycles return a diagnostic before the general checker recurses", () => {
  const cyclic: Computation<void> = Computation.make(R.Unit, R.Never, {
    _tag: "Ensuring",
    get body() {
      return cyclic;
    },
    finalizer: R.Effect.void,
  });
  refusal(scope(cyclic), "SEMAPHORE_STRUCTURAL_CYCLE");
});

const expressionFn = (expression: Expr<boolean>) =>
  R.fn([], R.Bool, R.Never, () =>
    S.make(1).pipe(R.Effect.flatMap(() => R.Effect.succeed(expression))),
  );

test("forged expression cycles are refused before the general checker recurses", () => {
  // Hostile IR can bypass the immutable factories; the structural walk must still terminate.
  const cyclic: Expr<boolean> = Object.create(Expression.prototype, {
    type: { value: R.Bool },
    node: {
      get: () => ({
        _tag: "Match",
        condition: cyclic,
        onTrue: R.Bool.literal(true),
        onFalse: R.Bool.literal(false),
      }),
    },
  });
  refusal(expressionFn(cyclic), "SEMAPHORE_STRUCTURAL_CYCLE");
});

test("cached shared expression depth is charged at its deeper incoming edge", () => {
  const leaf = R.Bool.literal(true);
  let shared = leaf;
  for (let index = 0; index < 30; index++) shared = Expression.match(leaf, shared, leaf);
  let deeper = shared;
  for (let index = 0; index < 32; index++) deeper = Expression.match(leaf, deeper, leaf);
  const admitted = analyzeSemaphoreStructure(expressionFn(Expression.match(leaf, shared, deeper)));
  expect(admitted.diagnostics).toEqual([]);
  expect(admitted.bounds?.expressionDepth).toBe(semaphoreStructureLimits.expressionDepth);
  deeper = Expression.match(leaf, deeper, leaf);
  refusal(expressionFn(Expression.match(leaf, shared, deeper)), "SEMAPHORE_STRUCTURAL_GROWTH");
});

test("structural admission does not certify the fixed driver retry or scan ceiling", () => {
  const result = analyzeSemaphoreStructure(
    lexical((owner) => {
      let body = S.withPermit(owner)(R.Effect.void);
      for (let index = 0; index < 7; index++) body = body.pipe(R.Effect.andThen(body));
      return body;
    }),
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.structurallyAdmitted).toBe(true);
  expect(result.bounds).toMatchObject({ acquisitions: 128, releaseScans: 128, registrations: 256 });
});

test("depth and exponential shared-DAG expansion saturate with growth refusals", () => {
  let deep = R.Effect.void;
  for (let index = 0; index < semaphoreStructureLimits.computationDepth; index++)
    deep = deep.pipe(R.Effect.ensuring(R.Effect.void));
  refusal(scope(deep), "SEMAPHORE_STRUCTURAL_GROWTH");
  let wide = R.Effect.void;
  for (let index = 0; index < 30; index++) wide = wide.pipe(R.Effect.andThen(wide));
  refusal(scope(wide), "SEMAPHORE_STRUCTURAL_GROWTH");
  let expression = R.Bool.literal(true);
  for (let index = 0; index < 20; index++)
    expression = Expression.match(expression, expression, expression);
  refusal(
    R.fn([], R.Bool, R.Never, () =>
      S.make(1).pipe(R.Effect.flatMap(() => R.Effect.succeed(expression))),
    ),
    "SEMAPHORE_STRUCTURAL_GROWTH",
  );
});
