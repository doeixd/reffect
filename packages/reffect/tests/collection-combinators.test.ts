import {
  Array as A,
  Boolean as B,
  Effect,
  Exit,
  FileSystem,
  Predicate,
  Record as Rec,
  Option,
} from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  FailureFrames,
  NativeRunner,
  R,
  Reference,
  Rust,
  SourceArtifacts,
} from "../src/index.ts";
import {
  ArrayCombinators as C,
  BooleanCombinators as Bool,
  PredicateCombinators as P,
  RecordCombinators as RC,
} from "../src/collection-combinators.ts";
import { OptionIR } from "../src/option.ts";
import { Expr, Operation, SemanticRef } from "../src/kernel.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const values = R.fn([R.U64, R.U64, R.U64], R.Bool, (a, b, c) =>
  R.Array.make(a, b, c).pipe(
    C.some((x, i) => Bool.and(R.U64.eq(x, R.U64.literal(5n)), R.U64.lt(i, R.U64.literal(2n)))),
  ),
);
const all = R.fn([R.U64, R.U64, R.U64], R.Bool, (a, b, c) =>
  C.every(R.Array.make(a, b, c), (x) => R.U64.lt(x, R.U64.literal(9n))),
);
const emptySome = R.fn([], R.Bool, () => C.some(R.Array.empty(R.U64), () => R.Bool.literal(true)));
const emptyEvery = R.fn([], R.Bool, () =>
  C.every(R.Array.empty(R.U64), () => R.Bool.literal(false)),
);
const logical = R.fn([R.Bool, R.Bool], R.Bool, (a, b) => Bool.or(Bool.and(a, b), P.not(a)));
const pred = R.fn([R.U64], R.Bool, (n) =>
  P.or(
    P.and(
      (x: Expr<bigint>) => R.U64.lt(x, R.U64.literal(5n)),
      (x: Expr<bigint>) => R.U64.lt(R.U64.literal(0n), x),
    ),
    P.not((x: Expr<bigint>) => R.U64.lt(x, R.U64.literal(9n))),
  )(n),
);
const emptiness = R.fn([R.Bool], R.Bool, (empty) =>
  C.isArrayNonEmpty(R.Match.bool(empty, R.Array.empty(R.U64), R.Array.make(R.U64.literal(1n)))),
);
const recordEmpty = R.fn([R.Record(R.String, R.U64)], R.Bool, RC.isEmptyRecord);
const first = R.fn([R.U64, R.U64, R.U64], R.U64, (a, b, c) =>
  C.findFirst(R.Array.make(a, b, c), (x, i) =>
    Bool.and(R.U64.lt(R.U64.literal(1n), x), R.U64.lt(i, R.U64.literal(2n))),
  ).pipe(OptionIR.getOrElse(() => R.U64.literal(99n))),
);
const firstString = R.fn([R.String, R.String], R.String, (a, b) =>
  C.findFirst(R.Array.make(a, b, R.String.literal("tail<")), (value) =>
    R.String.includes(value, R.String.literal("<")),
  ).pipe(OptionIR.getOrElse(() => R.String.literal("none"))),
);
const program = R.program({
  values,
  all,
  emptySome,
  emptyEvery,
  logical,
  pred,
  emptiness,
  first,
  firstString,
});

test("pure collection helpers match official Effect modules", async () => {
  expect(R.Array.length).toBeDefined();
  expect(R.Array.some).toBe(C.some);
  expect(R.Array.findFirst).toBe(C.findFirst);
  expect(R.Boolean.and).toBe(Bool.and);
  expect(R.Predicate.not).toBe(P.not);
  expect(R.Record.isEmptyRecord).toBe(RC.isEmptyRecord);
  expect(R.Bool).toBe(R.Bool.literal(true).type);
  for (const args of [
    [0n, 0n, 0n],
    [5n, 0n, 0n],
    [0n, 5n, 0n],
    [0n, 0n, 5n],
    [5n, 5n, 5n],
    [8n, 9n, 10n],
  ] as const) {
    expect(await Effect.runPromise(Reference.run(values, args))).toBe(
      A.some(args, (x, i) => x === 5n && i < 2),
    );
    expect(await Effect.runPromise(Reference.run(all, args))).toBe(A.every(args, (x) => x < 9n));
    expect(await Effect.runPromise(Reference.run(first, args))).toBe(
      Option.getOrElse(
        A.findFirst(args, (x, i) => x > 1n && i < 2),
        () => 99n,
      ),
    );
  }
  expect(await Effect.runPromise(Reference.run(emptySome, []))).toBe(A.some([], () => true));
  expect(await Effect.runPromise(Reference.run(emptyEvery, []))).toBe(A.every([], () => false));
  for (const a of [false, true])
    for (const b of [false, true])
      expect(await Effect.runPromise(Reference.run(logical, [a, b]))).toBe(
        B.or(B.and(a, b), B.not(a)),
      );
  const official = Predicate.or(
    Predicate.and(
      (n: bigint) => n < 5n,
      (n: bigint) => n > 0n,
    ),
    Predicate.not((n: bigint) => n < 9n),
  );
  for (const n of [0n, 1n, 4n, 5n, 8n, 9n, R.U64.max])
    expect(await Effect.runPromise(Reference.run(pred, [n]))).toBe(official(n));
  for (const empty of [false, true])
    expect(await Effect.runPromise(Reference.run(emptiness, [empty]))).toBe(
      A.isArrayNonEmpty(empty ? [] : [1n]),
    );
  const unusual: Record<string, bigint> = {};
  Object.defineProperty(unusual, "__proto__", { value: 1n, enumerable: true });
  for (const record of [{}, { a: 1n }, unusual]) {
    expect(await Effect.runPromise(Reference.run(recordEmpty, [record]))).toBe(
      Rec.isEmptyRecord(record),
    );
  }
});

test("findFirst handles owned strings and empty arrays", async () => {
  for (const args of [
    ["a<", "b<"],
    ["plain", "b<"],
    ["plain", "other"],
  ] as const)
    expect(await Effect.runPromise(Reference.run(firstString, args))).toBe(
      Option.getOrElse(
        A.findFirst([...args, "tail<"], (value) => value.includes("<")),
        () => "none",
      ),
    );
  const empty = R.fn([], R.U64, () =>
    C.findFirst(R.Array.empty(R.U64), () => R.Bool.literal(true)).pipe(
      OptionIR.getOrElse(() => R.U64.literal(99n)),
    ),
  );
  expect(await Effect.runPromise(Reference.run(empty, []))).toBe(99n);
});

test("decisive array results skip later runtime predicates", async () => {
  const bomb = Operation.make(
    SemanticRef.operation("test/collections.unreachable@1"),
    [],
    R.Bool,
    () => {
      throw new Error("predicate was evaluated");
    },
  );
  const danger = Expr.apply(bomb);
  const booleanAnd = R.fn([], R.Bool, () => Bool.and(R.Bool.literal(false), danger));
  const booleanOr = R.fn([], R.Bool, () => Bool.or(R.Bool.literal(true), danger));
  const predicateAnd = R.fn(
    [R.U64],
    R.Bool,
    P.and(
      () => R.Bool.literal(false),
      () => danger,
    ),
  );
  const predicateOr = R.fn(
    [R.U64],
    R.Bool,
    P.or(
      () => R.Bool.literal(true),
      () => danger,
    ),
  );
  expect(await Effect.runPromise(Reference.run(booleanAnd, []))).toBe(false);
  expect(await Effect.runPromise(Reference.run(booleanOr, []))).toBe(true);
  expect(await Effect.runPromise(Reference.run(predicateAnd, [0n]))).toBe(false);
  expect(await Effect.runPromise(Reference.run(predicateOr, [0n]))).toBe(true);
  const first = R.fn([], R.Bool, () =>
    C.some(R.Array.make(R.U64.literal(0n), R.U64.literal(1n)), (x) =>
      R.Match.bool(R.U64.eq(x, R.U64.literal(0n)), R.Bool.literal(true), danger),
    ),
  );
  const rejected = R.fn([], R.Bool, () =>
    C.every(R.Array.make(R.U64.literal(0n), R.U64.literal(1n)), (x) =>
      R.Match.bool(R.U64.eq(x, R.U64.literal(0n)), R.Bool.literal(false), danger),
    ),
  );
  expect(await Effect.runPromise(Reference.run(first, []))).toBe(true);
  const found = R.fn([], R.U64, () =>
    C.findFirst(R.Array.make(R.U64.literal(0n), R.U64.literal(1n)), (x) =>
      R.Match.bool(R.U64.eq(x, R.U64.literal(0n)), R.Bool.literal(true), danger),
    ).pipe(OptionIR.getOrElse(() => R.U64.literal(99n))),
  );
  expect(await Effect.runPromise(Reference.run(found, []))).toBe(0n);
  expect(await Effect.runPromise(Reference.run(rejected, []))).toBe(false);
});

test(
  "native collection helpers preserve std-only specialization",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({
            prefix: "reffect-collection-combinators-",
          });
          for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
            const artifact = yield* Compile.make(program).pipe(
              Compile.withTarget(Rust.std),
              Compile.withFailureFrames(policy),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.run,
            );
            expect(artifact.explanation.crates).toEqual([]);
            const directory = yield* CargoApi.write(artifact, `${parent}/${policy._tag}`);
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              for (const args of [
                ["a<", "b<"],
                ["plain", "b<"],
                ["plain", "other"],
              ] as const)
                expect(
                  yield* NativeRunner.run(
                    artifact,
                    directory,
                    "firstString",
                    firstString,
                    args,
                    profile,
                  ),
                ).toEqual(
                  Exit.succeed(
                    Option.getOrElse(
                      A.findFirst([...args, "tail<"], (value) => value.includes("<")),
                      () => "none",
                    ),
                  ),
                );
              for (const args of [
                [0n, 0n, 0n],
                [5n, 0n, 0n],
                [0n, 5n, 0n],
                [0n, 0n, 5n],
                [8n, 9n, 10n],
              ] as const) {
                expect(
                  yield* NativeRunner.run(artifact, directory, "values", values, args, profile),
                ).toEqual(Exit.succeed(A.some(args, (x, i) => x === 5n && i < 2)));
                expect(
                  yield* NativeRunner.run(artifact, directory, "all", all, args, profile),
                ).toEqual(Exit.succeed(A.every(args, (x) => x < 9n)));
                expect(
                  yield* NativeRunner.run(artifact, directory, "first", first, args, profile),
                ).toEqual(
                  Exit.succeed(
                    Option.getOrElse(
                      A.findFirst(args, (x, i) => x > 1n && i < 2),
                      () => 99n,
                    ),
                  ),
                );
              }
              expect(
                yield* NativeRunner.run(artifact, directory, "emptySome", emptySome, [], profile),
              ).toEqual(Exit.succeed(false));
              expect(
                yield* NativeRunner.run(artifact, directory, "emptyEvery", emptyEvery, [], profile),
              ).toEqual(Exit.succeed(true));
              for (const a of [false, true])
                for (const b of [false, true])
                  expect(
                    yield* NativeRunner.run(
                      artifact,
                      directory,
                      "logical",
                      logical,
                      [a, b],
                      profile,
                    ),
                  ).toEqual(Exit.succeed(B.or(B.and(a, b), B.not(a))));
              for (const n of [0n, 1n, 4n, 5n, 8n, 9n, R.U64.max])
                expect(
                  yield* NativeRunner.run(artifact, directory, "pred", pred, [n], profile),
                ).toEqual(Exit.succeed((n < 5n && n > 0n) || n >= 9n));
              for (const empty of [false, true])
                expect(
                  yield* NativeRunner.run(
                    artifact,
                    directory,
                    "emptiness",
                    emptiness,
                    [empty],
                    profile,
                  ),
                ).toEqual(Exit.succeed(!empty));
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0),
);
