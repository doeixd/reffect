import { Cause, Deferred, Effect, Exit } from "effect";
import { expect, test } from "vite-plus/test";
import { Compile, Expr, Operation, R, Reference, Rust, SemanticRef } from "../src/index.ts";
import { deferredType } from "../src/deferred-model.ts";
import { DeferredIR } from "../src/deferred.ts";
import { checkEffectFunction } from "../src/effect-ir.ts";
import { lowerFunctions } from "../src/lower.ts";
import { Provenance } from "../src/provenance.ts";

const work = R.fn([], R.U64, R.Never, () =>
  DeferredIR.make(R.U64).pipe(
    R.Effect.flatMap((owner) =>
      DeferredIR.succeed(owner, R.U64.literal(7n)).pipe(R.Effect.andThen(DeferredIR.await(owner))),
    ),
  ),
);

test("private reference Deferred works while native planning refuses before emission", async () => {
  expect(await Effect.runPromise(Reference.run(work, []))).toBe(7n);
  const analysis = await Effect.runPromise(Compile.derive(R.program({ work })));
  expect(analysis.effects.map((ref) => ref.id)).toEqual(
    expect.arrayContaining([
      "reffect/deferred/make@1",
      "reffect/deferred/complete@1",
      "reffect/deferred/await@1",
    ]),
  );
  const exit = await Effect.runPromise(
    Compile.make(R.program({ work })).pipe(
      Compile.withTarget(Rust.tokio),
      Compile.run,
      Effect.exit,
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit))
    expect(Cause.findErrorOption(exit.cause)).toMatchObject({
      value: { diagnostics: [{ code: "DEFERRED_NATIVE_INTEGRATION", stage: "plan" }] },
    });
});

test("Deferred provenance retains the lexical body and completion payload edges", () => {
  const provenance = new Provenance(R.program({ work }));
  const paths = provenance.occurrences.map((occurrence) => occurrence.path);
  expect(paths).toContain("functions.work.body.body.source.value");
  expect(paths).toContain("functions.work.body.body.body");
});

test("delayed resource finalizers cannot borrow a lexical Deferred owner", () => {
  const delayed = R.fn([], R.Unit, R.Never, () =>
    DeferredIR.make(R.U64).pipe(
      R.Effect.flatMap((owner) =>
        R.Effect.scoped(
          R.Effect.addFinalizer(() =>
            DeferredIR.succeed(owner, R.U64.literal(7n)).pipe(R.Effect.asVoid),
          ),
        ),
      ),
    ),
  );
  expect(checkEffectFunction(delayed, "delayed").map((issue) => issue.code)).toContain(
    "RESOURCE_ESCAPE",
  );
  const immediate = R.fn([], R.Unit, R.Never, () =>
    DeferredIR.make(R.U64).pipe(
      R.Effect.flatMap((owner) =>
        R.Effect.void.pipe(
          R.Effect.ensuring(DeferredIR.succeed(owner, R.U64.literal(7n)).pipe(R.Effect.asVoid)),
        ),
      ),
    ),
  );
  expect(checkEffectFunction(immediate, "immediate")).toEqual([]);
});

test("direct lowering cannot bypass Deferred native admission", () => {
  expect(() => lowerFunctions(R.program({ work }), new Map())).toThrowError(/Deferred/);
});

test("pure function operation arguments cannot hide a lexical Deferred value", async () => {
  const type = deferredType(R.U64, R.Never);
  const consume = Operation.make(
    SemanticRef.operation("test/pure-deferred-consume@1"),
    [type],
    R.Bool,
    () => true,
  );
  const disguised = R.fn([], R.Bool, () =>
    Expr.apply(consume, Expr.literal(type, Deferred.makeUnsafe<bigint>())),
  );
  const runs: readonly Effect.Effect<unknown, unknown>[] = [
    Reference.run(disguised, []),
    Compile.run(R.program({ disguised })),
  ];
  for (const run of runs) {
    const exit = await Effect.runPromise(run.pipe(Effect.exit));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(Cause.findErrorOption(exit.cause)).toMatchObject({
        value: {
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: "RESOURCE_ESCAPE" }),
          ]),
        },
      });
  }
});
