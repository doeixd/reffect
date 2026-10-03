import { Cause, Effect, Exit, FileSystem, Option, Result, Stream } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  Computation,
  Expr,
  FailureFrames,
  NativeRunner,
  R,
  Reference,
  Rust,
  SourceArtifacts,
} from "../src/index.ts";
import type { CauseValue, ExitValue } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const CauseU64 = R.Cause(R.U64);
const ExitU64 = R.Exit(R.U64, R.U64);
const projectCause = <E>(cause: Cause.Cause<E>): CauseValue<E> => ({
  reasons: cause.reasons
    .filter(Cause.isFailReason)
    .map((reason) => ({ _tag: "Fail", error: reason.error })),
});
const projectExit = <A, E>(exit: Exit.Exit<A, E>): ExitValue<A, E> =>
  Exit.match(exit, {
    onSuccess: (value) => ({ _tag: "Success", value }),
    onFailure: (cause) => ({ _tag: "Failure", cause: projectCause(cause) }),
  });
const officialCause = (errors: readonly bigint[]) =>
  Cause.fromReasons(errors.map(Cause.makeFailReason));
const causeInput = (errors: readonly bigint[]): CauseValue<bigint> =>
  projectCause(officialCause(errors));
const corpus = [[], [2n], [3n, 8n], [2n, 2n], [0n, 18446744073709551615n]];
const mapped = R.fn([CauseU64], CauseU64, (cause) => R.Cause.map(cause, () => R.U64.literal(0n)));
const first = R.fn([CauseU64], R.Option(R.U64), R.Cause.findErrorOption);
const firstResult = R.fn([CauseU64], R.Result(R.U64, R.Cause(R.Never)), R.Cause.findError);
const errorMapped = R.fn([ExitU64], ExitU64, (exit) =>
  R.Exit.mapError(exit, (error) => R.U64.add(error, R.U64.literal(1n))),
);
const bothMapped = R.fn([ExitU64], R.Exit(R.String, R.U64), (exit) =>
  R.Exit.mapBoth(exit, {
    onSuccess: () => R.String.literal("ok😀"),
    onFailure: (error) => R.U64.add(error, R.U64.literal(1n)),
  }),
);
const capture = R.fn([R.Bool, R.U64], ExitU64, R.Never, (ok, value) =>
  R.Effect.exit(R.Match.bool(ok, R.Effect.succeed(value), R.Effect.fail(value))),
);
const nonCopy = R.fn([R.Exit(R.String, R.String)], R.Exit(R.String, R.String), (exit) =>
  R.Exit.map(exit, (value) => R.String.concat(value, R.String.literal("!"))),
);
const Observed = R.Struct({
  success: R.Bool,
  failure: R.Bool,
  fails: R.Bool,
  dies: R.Bool,
  interrupts: R.Bool,
  value: R.Option(R.U64),
  cause: R.Option(CauseU64),
  first: R.Option(R.U64),
  void: R.Exit(R.Unit, R.U64),
});
const observed = R.fn([ExitU64], Observed, (exit) =>
  Observed.make({
    success: R.Exit.isSuccess(exit),
    failure: R.Exit.isFailure(exit),
    fails: R.Exit.hasFails(exit),
    dies: R.Exit.hasDies(exit),
    interrupts: R.Exit.hasInterrupts(exit),
    value: R.Exit.getSuccess(exit),
    cause: R.Exit.getCause(exit),
    first: R.Exit.findErrorOption(exit),
    void: R.Exit.asVoid(exit),
  }),
);
const projectOption = <A>(option: Option.Option<A>) =>
  Option.match(option, {
    onNone: () => ({ _tag: "None" }),
    onSome: (value) => ({ _tag: "Some", value }),
  });

test("Fail-only Cause and Exit data agree with stable public APIs, including duplicate and empty reasons", async () => {
  expect(R.Cause(R.U64)).toBe(CauseU64);
  expect(R.Exit(R.U64, R.U64)).toBe(ExitU64);
  for (const errors of corpus) {
    const official = officialCause(errors);
    const input = causeInput(errors);
    expect(await Effect.runPromise(Reference.run(mapped, [input]))).toEqual(
      projectCause(Cause.map(official, () => 0n)),
    );
    const expected = Cause.findErrorOption(official);
    expect(await Effect.runPromise(Reference.run(first, [input]))).toEqual(
      Option.match(expected, {
        onNone: () => ({ _tag: "None" }),
        onSome: (value) => ({ _tag: "Some", value }),
      }),
    );
    expect(await Effect.runPromise(Reference.run(firstResult, [input]))).toEqual(
      Result.match(Cause.findError(official), {
        onSuccess: (success) => ({ _tag: "Success", success }),
        onFailure: (failure) => ({ _tag: "Failure", failure: projectCause(failure) }),
      }),
    );
    for (const exit of [Exit.succeed(9n), Exit.failCause(official)]) {
      expect(await Effect.runPromise(Reference.run(observed, [projectExit(exit)]))).toEqual({
        success: Exit.isSuccess(exit),
        failure: Exit.isFailure(exit),
        fails: Exit.hasFails(exit),
        dies: Exit.hasDies(exit),
        interrupts: Exit.hasInterrupts(exit),
        value: projectOption(Exit.getSuccess(exit)),
        cause: projectOption(Option.map(Exit.getCause(exit), projectCause)),
        first: projectOption(Exit.findErrorOption(exit)),
        void: projectExit(Exit.asVoid(exit)),
      });
      expect(await Effect.runPromise(Reference.run(errorMapped, [projectExit(exit)]))).toEqual(
        projectExit(Exit.mapError(exit, (error) => error + 1n)),
      );
      expect(await Effect.runPromise(Reference.run(bothMapped, [projectExit(exit)]))).toEqual(
        projectExit(
          Exit.mapBoth(exit, { onSuccess: () => "ok😀", onFailure: (error) => error + 1n }),
        ),
      );
    }
  }
  for (const exit of [Exit.succeed("hi😀"), Exit.fail("bad"), Exit.failCause(Cause.empty)])
    expect(await Effect.runPromise(Reference.run(nonCopy, [projectExit(exit)]))).toEqual(
      projectExit(Exit.map(exit, (value) => `${value}!`)),
    );
  for (const ok of [true, false]) {
    const expected = await Effect.runPromise(
      Effect.exit(ok ? Effect.succeed(7n) : Effect.fail(7n)),
    );
    expect(await Effect.runPromise(Reference.run(capture, [ok, 7n]))).toEqual(
      projectExit(expected),
    );
    const framed = await Effect.runPromise(Reference.runWithFrames(capture, [ok, 7n]));
    expect(framed.exit).toEqual(Exit.succeed(projectExit(expected)));
    expect(framed.frames).toEqual([]);
  }
});

test("Exit observers distinguish empty failure, build callbacks once and refuse incompatible witnesses/captures", async () => {
  let success = 0,
    failure = 0,
    causes = 0;
  R.Exit.mapBoth(R.Exit.succeed(R.U64.literal(1n), R.U64), {
    onSuccess: (value) => {
      success++;
      return value;
    },
    onFailure: (error) => {
      failure++;
      return error;
    },
  });
  R.Cause.map(R.Cause.empty(R.U64), (error) => {
    causes++;
    return error;
  });
  expect([success, failure, causes]).toEqual([1, 1, 1]);
  const flags = R.fn([ExitU64], R.Bool, (exit) =>
    R.Match.bool(R.Exit.isFailure(exit), R.Bool.not(R.Exit.hasFails(exit)), R.Bool.literal(false)),
  );
  expect(
    await Effect.runPromise(Reference.run(flags, [projectExit(Exit.failCause(Cause.empty))])),
  ).toBe(true);
  expect(await Effect.runPromise(Reference.run(flags, [projectExit(Exit.fail(1n))]))).toBe(false);
  expect(await Effect.runPromise(Reference.run(flags, [projectExit(Exit.succeed(1n))]))).toBe(
    false,
  );
  const bad = R.Struct({
    reasons: R.Array(R.TaggedUnion({ Fail: { error: R.U64, extra: R.Bool } })),
  });
  expect(() =>
    R.Cause.hasFails(
      bad.make({
        reasons: R.Array.empty(R.TaggedUnion({ Fail: { error: R.U64, extra: R.Bool } })),
      }),
    ),
  ).toThrow("Fail-only Cause witness");
  expect(() => {
    // @ts-expect-error Result payload fields are incompatible with Exit fields.
    R.Exit.isFailure(R.Result.succeed(R.U64.literal(1n), R.U64));
  }).toThrow("Exit witness");
  const captures: readonly Computation<unknown, unknown>[] = [
    R.Effect.sleep(1),
    R.Effect.map(R.Effect.sleep(1), () => R.U64.literal(1n)),
    R.Match.bool(
      R.Bool.literal(true),
      R.Effect.succeed(R.U64.literal(1n)),
      R.Effect.map(R.Clock.currentTimeMillis, () => R.U64.literal(1n)),
    ),
    R.Effect.flatMap(R.Effect.succeed(R.Bool.literal(true)), () => R.Random.nextBoolean),
    R.Effect.ensuring(R.Effect.succeed(R.U64.literal(1n)), R.Effect.succeed(R.Unit.literal())),
  ];
  for (const source of captures)
    expect(() => R.Effect.exit(source)).toThrow("synchronous computation without Clock/Random");
  const dieInput = { reasons: [{ _tag: "Die", defect: "boom" }] };
  expect(Exit.isFailure(await Effect.runPromiseExit(Reference.runUnknown(first, [dieInput])))).toBe(
    true,
  );
});

// Explicit checked builders materialize multi-reason values; no JS literal lowering shortcut.
const twoReasons = () => {
  return R.Cause.fromReasons(
    R.Array.make(
      R.Cause.makeFailReason(R.U64.literal(3n)),
      R.Cause.makeFailReason(R.U64.literal(8n)),
    ),
  );
};
const countMapped = R.fn([], R.U64, () =>
  R.Array.length(
    Expr.get<CauseValue<bigint>["reasons"]>(
      R.Cause.map(twoReasons(), () => R.U64.literal(0n)),
      "reasons",
    ),
  ),
);
const countExitMapped = R.fn([], R.U64, () =>
  R.Exit.match(
    R.Exit.mapError(R.Exit.failCause(twoReasons(), R.U64), (error) => error),
    {
      onSuccess: () => R.U64.literal(99n),
      onFailure: (cause) =>
        R.Array.length(Expr.get<CauseValue<bigint>["reasons"]>(cause, "reasons")),
    },
  ),
);
const captureScalar = R.fn([R.Bool, R.U64], R.U64, R.Never, (ok, value) =>
  R.Effect.exit(R.Match.bool(ok, R.Effect.succeed(value), R.Effect.fail(value))).pipe(
    R.Effect.map(
      R.Exit.match({
        onSuccess: (n) => n,
        onFailure: (cause) =>
          R.Option.getOrElse(R.Cause.findErrorOption(cause), () => R.U64.literal(0n)),
      }),
    ),
  ),
);
const asyncOuter = R.fn([R.U64], R.U64, R.Never, (n) =>
  R.Effect.sleep(1).pipe(
    R.Effect.flatMap(() => R.Effect.exit(R.Effect.succeed(n))),
    R.Effect.map(R.Exit.match({ onSuccess: (v) => v, onFailure: () => R.U64.literal(0n) })),
  ),
);
const capturedStream = R.fn([R.Bool], R.U64, R.Never, (ok) =>
  R.Effect.exit(
    R.Match.bool(
      ok,
      R.Stream.runCollect(R.Stream.make(R.U64.literal(1n), R.U64.literal(2n))),
      R.Stream.runCollect(R.Stream.fail(R.U64.literal(9n), R.U64)),
    ),
  ).pipe(
    R.Effect.map(
      R.Exit.match({
        onSuccess: (values) => R.Array.length(values),
        onFailure: (cause) =>
          R.Option.getOrElse(R.Cause.findErrorOption(cause), () => R.U64.literal(0n)),
      }),
    ),
  ),
);

const nativeText = R.fn([R.Bool, R.String], R.String, (ok, text) =>
  R.Exit.match(
    R.Exit.mapBoth(R.Match.bool(ok, R.Exit.succeed(text, R.String), R.Exit.fail(text, R.String)), {
      onSuccess: (value) => R.String.concat(value, R.String.literal("!")),
      onFailure: (error) => R.String.concat(error, R.String.literal("?")),
    }),
    {
      onSuccess: (value) => value,
      onFailure: (cause) =>
        R.Option.getOrElse(R.Cause.findErrorOption(cause), () => R.String.literal("empty")),
    },
  ),
);

test(
  "native Cause/Exit transformations preserve first/all errors and synchronous capture inside an async parent",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-exit-" });
          for (const frames of [FailureFrames.None, FailureFrames.Bounded]) {
            const artifact = yield* Compile.make(
              R.program({
                countMapped,
                countExitMapped,
                captureScalar,
                asyncOuter,
                nativeText,
                capturedStream,
              }),
            ).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withFailureFrames(frames),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.run,
            );
            expect(artifact.files["src/lib.rs"]).not.toContain("Box<Union_");
            if (frames === FailureFrames.None)
              expect(artifact.files["src/lib.rs"]).not.toContain("Box<");
            const directory = yield* CargoApi.write(artifact, `${parent}/${frames._tag}`);
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              expect(
                yield* NativeRunner.run(
                  artifact,
                  directory,
                  "countMapped",
                  countMapped,
                  [],
                  profile,
                ),
              ).toEqual(Exit.succeed(2n));
              expect(
                yield* NativeRunner.run(
                  artifact,
                  directory,
                  "countExitMapped",
                  countExitMapped,
                  [],
                  profile,
                ),
              ).toEqual(Exit.succeed(1n));
              for (const ok of [true, false])
                expect(
                  yield* NativeRunner.run(
                    artifact,
                    directory,
                    "captureScalar",
                    captureScalar,
                    [ok, 7n],
                    profile,
                  ),
                ).toEqual(Exit.succeed(7n));
              expect(
                yield* NativeRunner.run(
                  artifact,
                  directory,
                  "asyncOuter",
                  asyncOuter,
                  [9n],
                  profile,
                ),
              ).toEqual(Exit.succeed(9n));
              for (const ok of [true, false]) {
                const collected = yield* Effect.exit(
                  Stream.runCollect(ok ? Stream.make(1n, 2n) : Stream.fail(9n)),
                );
                const expected = Exit.match(collected, {
                  onSuccess: (values) => BigInt(values.length),
                  onFailure: (cause) => Option.getOrElse(Cause.findErrorOption(cause), () => 0n),
                });
                expect(
                  yield* NativeRunner.run(
                    artifact,
                    directory,
                    "capturedStream",
                    capturedStream,
                    [ok],
                    profile,
                  ),
                ).toEqual(Exit.succeed(expected));
                expect(yield* Reference.run(capturedStream, [ok])).toBe(expected);
                const oracle = Exit.mapBoth(ok ? Exit.succeed("hi😀") : Exit.fail("hi😀"), {
                  onSuccess: (value) => `${value}!`,
                  onFailure: (error) => `${error}?`,
                });
                expect(
                  yield* NativeRunner.run(
                    artifact,
                    directory,
                    "nativeText",
                    nativeText,
                    [ok, "hi😀"],
                    profile,
                  ),
                ).toEqual(
                  Exit.succeed(
                    Exit.match(oracle, {
                      onSuccess: (value) => value,
                      onFailure: (cause) =>
                        Option.getOrElse(Cause.findErrorOption(cause), () => "empty"),
                    }),
                  ),
                );
              }
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0),
);

test(
  "explicit Cause values pay array allocation while empty/success/scalar paths remain allocation-free",
  async () => {
    const program = R.program({
      baseline: R.fn([R.U64], R.U64, (n) => n),
      causeEmpty: R.fn([], CauseU64, () => R.Cause.empty(R.U64)),
      causeFail: R.fn([R.U64], CauseU64, R.Cause.fail),
      exitSuccess: R.fn([R.U64], ExitU64, (n) => R.Exit.succeed(n, R.U64)),
      exitFail: R.fn([R.U64], ExitU64, (n) => R.Exit.fail(n, R.U64)),
      capture: R.fn([R.Bool, R.U64], ExitU64, R.Never, (ok, n) =>
        R.Effect.exit(R.Match.bool(ok, R.Effect.succeed(n), R.Effect.fail(n))),
      ),
    });
    const probe = `use reffect_generated as r;
use std::alloc::{GlobalAlloc,Layout,System};
use std::sync::atomic::{AtomicUsize,AtomicIsize,Ordering::Relaxed};
static ALLOCS:AtomicUsize=AtomicUsize::new(0);
static LIVE:AtomicIsize=AtomicIsize::new(0);
struct Counting;
unsafe impl GlobalAlloc for Counting {
 unsafe fn alloc(&self,l:Layout)->*mut u8 { let p=unsafe{System.alloc(l)}; if !p.is_null(){ALLOCS.fetch_add(1,Relaxed);LIVE.fetch_add(1,Relaxed);} p }
 unsafe fn dealloc(&self,p:*mut u8,l:Layout){LIVE.fetch_sub(1,Relaxed);unsafe{System.dealloc(p,l)}}
 unsafe fn realloc(&self,p:*mut u8,l:Layout,n:usize)->*mut u8{ALLOCS.fetch_add(1,Relaxed);unsafe{System.realloc(p,l,n)}}
}
#[global_allocator]static ALLOCATOR:Counting=Counting;
fn measure<T>(name:&str,mut f:impl FnMut()->T){
 let before=ALLOCS.load(Relaxed);let live=LIVE.load(Relaxed);
 for _ in 0..100 {drop(std::hint::black_box(f()));}
 let allocated=ALLOCS.load(Relaxed)-before;let retained=LIVE.load(Relaxed)-live;
 println!("{name}={allocated},{retained}");
}
fn main(){
 println!("warmup");
 println!("layout scalar={},cause={},exit={}",std::mem::size_of::<u64>(),std::mem::size_of_val(&r::r_causeEmpty()),std::mem::size_of_val(&r::r_exitSuccess(7)));
 measure("baseline",||r::r_baseline(7));
 measure("empty",r::r_causeEmpty);
 measure("cause",||r::r_causeFail(7));
 measure("success",||r::r_exitSuccess(7));
 measure("failure",||r::r_exitFail(7));
 measure("captureSuccess",||r::r_capture(true,7));
 measure("captureFailure",||r::r_capture(false,7));
}`;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-exit-cost-" });
          for (const frames of [FailureFrames.None, FailureFrames.Bounded]) {
            const artifact = yield* Compile.make(program).pipe(
              Compile.withTarget(Rust.std),
              Compile.withFailureFrames(frames),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.run,
            );
            expect(artifact.files["Cargo.toml"]).not.toContain("tokio");
            const directory = yield* CargoApi.write(artifact, `${parent}/${frames._tag}`);
            yield* fs.writeFileString(`${directory}/src/main.rs`, probe);
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              const result = yield* CargoApi.run(directory, "probe", [], profile);
              expect(result.exitCode).toBe(0);
              for (const name of ["baseline", "empty", "success", "captureSuccess"])
                expect(result.stdout).toContain(`${name}=0,0`);
              // Existing conservative composite ownership clones intermediate arrays.
              expect(result.stdout).toContain(`cause=${profile === "debug" ? 200 : 100},0`);
              expect(result.stdout).toContain(`failure=${profile === "debug" ? 300 : 100},0`);
              const captured = /captureFailure=(\d+),(-?\d+)/.exec(result.stdout);
              expect(captured).not.toBeNull();
              expect(Number(captured![1])).toBeGreaterThanOrEqual(100);
              expect(Number(captured![2])).toBe(0);
              if (process.env.REFFECT_EXIT_MEASUREMENTS)
                yield* fs.writeFileString(
                  `${process.env.REFFECT_EXIT_MEASUREMENTS}-${frames._tag}-${profile}.txt`,
                  result.stdout,
                );
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0),
);
