import { Cause, Effect, Exit, FileSystem, Fiber, Logger, Option, Schedule } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  CompileError,
  Computation,
  FailureFrames,
  NativeRunner,
  R,
  Reference,
  Rust,
} from "../src/index.ts";
import { EffectCombinators as C } from "../src/effect-combinators.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const tapped = R.fn([R.Bool], R.U64, R.Bool, (allowed) =>
  R.Match.bool(
    allowed,
    R.Effect.succeed(R.U64.literal(9007199254740993n)),
    R.Effect.fail(allowed),
  ).pipe(
    C.tap((value) => R.Log.info("tap").pipe(C.as(value))),
    C.tap(R.Log.info("second")),
  ),
);
const tapFailed = R.fn([], R.U64, R.Bool, () =>
  C.tap(R.Effect.succeed(R.U64.literal(7n)), () => R.Effect.fail(R.Bool.literal(true))),
);
const replaced = R.fn([R.Bool], R.Bool, R.Bool, (allowed) =>
  R.Match.bool(allowed, R.Effect.succeed(R.U64.literal(7n)), R.Effect.fail(allowed)).pipe(
    C.as(R.Bool.literal(true)),
  ),
);
const discarded = R.fn([], R.Unit, R.Never, () => C.asVoid(R.Effect.succeed(R.U64.literal(7n))));
const conditional = R.fn([R.Bool], R.U64, R.Bool, (selected) =>
  R.Effect.fail(selected).pipe(
    C.catchIf(
      (error) => error,
      () => R.Effect.succeed(R.U64.literal(11n)),
    ),
  ),
);
const conditionalFail = R.fn([], R.U64, R.Bool, () =>
  C.catchIf(
    R.Effect.fail(R.Bool.literal(true)),
    (error) => error,
    () => C.as(R.Effect.fail(R.Bool.literal(false)), R.U64.literal(11n)),
  ),
);
const finalized = R.fn([], R.U64, R.Never, () =>
  R.Effect.fail(R.Bool.literal(true)).pipe(
    R.Effect.ensuring(R.Log.info("release")),
    C.catch(() => R.Log.info("recover").pipe(C.as(R.U64.literal(5n)))),
    C.tap(R.Log.info("tap")),
  ),
);
const cancelled = R.fn([], R.Unit, R.Never, () =>
  R.Effect.void.pipe(
    C.tap(R.Log.info("started").pipe(R.Effect.andThen(R.Effect.sleep(10000)))),
    R.Effect.ensuring(R.Log.info("release")),
    C.catch(() => R.Log.info("incorrect-recovery")),
  ),
);
const matched = R.fn([R.Bool], R.U64, R.Bool, (allowed) =>
  R.Match.bool(allowed, R.Effect.succeed(R.U64.literal(7n)), R.Effect.fail(allowed)).pipe(
    C.matchEffect({
      onSuccess: () =>
        R.Log.info("success-handler").pipe(
          R.Effect.andThen(C.as(R.Effect.fail(R.Bool.literal(true)), R.U64.literal(0n))),
        ),
      onFailure: () => R.Log.info("failure-handler").pipe(C.as(R.U64.literal(11n))),
    }),
  ),
);
const program = R.program({
  tapped,
  tapFailed,
  replaced,
  discarded,
  conditional,
  conditionalFail,
  finalized,
  cancelled,
  matched,
});
const observe = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.match(exit, {
    onSuccess: (value) => ({ value }),
    onFailure: (cause) => ({
      error: Option.getOrUndefined(Cause.findErrorOption(cause)),
      interrupted: Cause.hasInterrupts(cause),
    }),
  });
const messages = (stderr: string) =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
    .map((line) => JSON.parse(line).message);

test("Effect helpers preserve inferred channels and refuse unavailable witness joins", () => {
  expect(C.catch).toBe(R.Effect.catchAll);
  expect(R.Effect.tap).toBe(C.tap);
  expect(R.Effect.matchEffect).toBe(C.matchEffect);
  expectTypeOf(C.as(R.Effect.fail(R.Bool.literal(false)), R.U64.literal(1n))).toEqualTypeOf<
    Computation<bigint, boolean>
  >();
  expectTypeOf(C.asVoid(R.Effect.fail(R.Bool.literal(false)))).toEqualTypeOf<
    Computation<void, boolean>
  >();
  expectTypeOf(
    C.tap(R.Effect.succeed(R.U64.literal(1n)), () => R.Effect.fail(R.Bool.literal(false))),
  ).toEqualTypeOf<Computation<bigint, boolean>>();
  expectTypeOf(
    C.catchIf(
      R.Effect.fail(R.Bool.literal(false)),
      (error) => error,
      () => R.Effect.succeed(R.U64.literal(1n)),
    ),
  ).toEqualTypeOf<Computation<bigint, boolean>>();
  expectTypeOf(
    C.matchEffect(R.Effect.succeed(R.U64.literal(1n)), {
      onSuccess: (value) => R.Effect.succeed(value),
      onFailure: () => R.Effect.fail(R.Bool.literal(false)),
    }),
  ).toEqualTypeOf<Computation<bigint, boolean>>();
  expect(() =>
    C.matchEffect(R.Effect.succeed(R.U64.literal(1n)), {
      onSuccess: (value) => R.Effect.succeed(value),
      onFailure: () => R.Effect.succeed(R.Bool.literal(false)),
    }),
  ).toThrow(CompileError);
  expect(() =>
    C.tap(R.Effect.fail(R.Bool.literal(false)), R.Effect.fail(R.U64.literal(1n))),
  ).toThrow(CompileError);
  expect(() =>
    C.catchIf(
      R.Effect.fail(R.Bool.literal(false)),
      (error) => error,
      () => R.Effect.fail(R.U64.literal(1n)),
    ),
  ).toThrow(CompileError);
  expect(() =>
    C.catchIf(
      R.Effect.succeed(R.Bool.literal(false)),
      () => R.Bool.literal(true),
      () => R.Effect.succeed(R.U64.literal(1n)),
    ),
  ).toThrow();
});

test("official helpers agree on errors, lazy branches, finalization and cancellation", async () => {
  for (const allowed of [false, true]) {
    const source = allowed ? Effect.succeed(7n) : Effect.fail(allowed);
    const officialMatched = Effect.matchEffect(source, {
      onSuccess: () => Effect.fail(true),
      onFailure: () => Effect.succeed(11n),
    });
    expect(
      observe(await Effect.runPromise(Effect.exit(Reference.run(matched, [allowed])))),
    ).toEqual(observe(await Effect.runPromise(Effect.exit(officialMatched))));
    const upstream = (allowed ? Effect.succeed(9007199254740993n) : Effect.fail(allowed)).pipe(
      Effect.tap(Effect.void),
      Effect.tap(Effect.void),
    );
    expect(observe(await Effect.runPromise(Effect.exit(Reference.run(tapped, [allowed]))))).toEqual(
      observe(await Effect.runPromise(Effect.exit(upstream))),
    );
    expect(
      observe(await Effect.runPromise(Effect.exit(Reference.run(replaced, [allowed])))),
    ).toEqual(observe(await Effect.runPromise(Effect.exit(Effect.as(upstream, true)))));
    expect(
      observe(await Effect.runPromise(Effect.exit(Reference.run(conditional, [allowed])))),
    ).toEqual(
      observe(
        await Effect.runPromise(
          Effect.exit(
            Effect.catchIf(
              Effect.fail(allowed),
              (error) => error,
              () => Effect.succeed(11n),
            ),
          ),
        ),
      ),
    );
  }
  expect(observe(await Effect.runPromise(Effect.exit(Reference.run(tapFailed, []))))).toEqual(
    observe(
      await Effect.runPromise(Effect.exit(Effect.tap(Effect.succeed(7n), Effect.fail(true)))),
    ),
  );
  expect(observe(await Effect.runPromise(Effect.exit(Reference.run(conditionalFail, []))))).toEqual(
    { error: false, interrupted: false },
  );
  expect(await Effect.runPromise(Reference.run(discarded, []))).toBeUndefined();
  const logs: string[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* Reference.run(finalized, [])).toBe(5n);
      const fiber = yield* Reference.run(cancelled, []).pipe(Effect.forkScoped);
      yield* Effect.sync(() => logs.includes("started")).pipe(
        Effect.repeat({ while: (ready) => !ready, schedule: Schedule.spaced("1 millis") }),
        Effect.timeout("2 seconds"),
      );
      yield* Fiber.interrupt(fiber);
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
    }).pipe(
      Effect.scoped,
      Effect.provide(Logger.layer([Logger.make((options) => logs.push(String(options.message)))])),
    ),
  );
  expect(logs).toEqual(["release", "recover", "tap", "started", "release"]);
});

test(
  "generated helpers agree with reference and add no runtime substrate",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-combinators-" });
          const artifact = yield* Compile.make(program).pipe(
            Compile.withTarget(Rust.tokio),
            Compile.withFailureFrames(FailureFrames.None),
            Compile.run,
          );
          expect(artifact.explanation.crates).toEqual(["tokio@1.53.1"]);
          expect(artifact.files["src/lib.rs"]).not.toContain("Box<dyn");
          const pure = yield* Compile.run(
            R.program({ tapFailed, replaced, discarded, conditional, conditionalFail }),
          );
          expect(pure.explanation.crates).toEqual([]);
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          for (const profile of ["debug", "release"] as const) {
            yield* CargoApi.build(directory, profile);
            for (const selected of [false, true]) {
              expect(
                observe(
                  yield* NativeRunner.run(
                    artifact,
                    directory,
                    "tapped",
                    tapped,
                    [selected],
                    profile,
                  ),
                ),
              ).toEqual(observe(yield* Effect.exit(Reference.run(tapped, [selected]))));
              expect(
                observe(
                  yield* NativeRunner.run(
                    artifact,
                    directory,
                    "replaced",
                    replaced,
                    [selected],
                    profile,
                  ),
                ),
              ).toEqual(observe(yield* Effect.exit(Reference.run(replaced, [selected]))));
              expect(
                observe(
                  yield* NativeRunner.run(
                    artifact,
                    directory,
                    "conditional",
                    conditional,
                    [selected],
                    profile,
                  ),
                ),
              ).toEqual(observe(yield* Effect.exit(Reference.run(conditional, [selected]))));
              expect(
                observe(
                  yield* NativeRunner.run(
                    artifact,
                    directory,
                    "matched",
                    matched,
                    [selected],
                    profile,
                  ),
                ),
              ).toEqual(selected ? { error: true, interrupted: false } : { value: 11n });
              expect(
                messages(
                  (yield* CargoApi.run(directory, "matched", [String(selected)], profile)).stderr,
                ),
              ).toEqual([selected ? "success-handler" : "failure-handler"]);
              expect(
                messages(
                  (yield* CargoApi.run(directory, "tapped", [String(selected)], profile)).stderr,
                ),
              ).toEqual(selected ? ["tap", "second"] : []);
            }
            expect(
              observe(
                yield* NativeRunner.run(artifact, directory, "tapFailed", tapFailed, [], profile),
              ),
            ).toEqual({ error: true, interrupted: false });
            expect(
              observe(
                yield* NativeRunner.run(
                  artifact,
                  directory,
                  "conditionalFail",
                  conditionalFail,
                  [],
                  profile,
                ),
              ),
            ).toEqual({ error: false, interrupted: false });
            expect(
              yield* NativeRunner.run(artifact, directory, "discarded", discarded, [], profile),
            ).toEqual(Exit.succeed(undefined));
            expect(
              messages((yield* CargoApi.run(directory, "finalized", [], profile)).stderr),
            ).toEqual(["release", "recover", "tap"]);
            yield* fs.writeFileString(
              `${directory}/src/main.rs`,
              `use std::future::Future;
#[tokio::main(flavor="current_thread")]
async fn main(){
let(sender,receiver)=tokio::sync::watch::channel(false);
let mut ctx=reffect_generated::AsyncContext::new(receiver);
let future=reffect_generated::r_cancelled(&mut ctx);tokio::pin!(future);
std::future::poll_fn(|cx|match future.as_mut().poll(cx){std::task::Poll::Pending=>{sender.send(true).unwrap();std::task::Poll::Ready(())},std::task::Poll::Ready(_)=>panic!("expected suspension")}).await;
assert!(matches!(future.await,Err(reffect_generated::AsyncError::Interrupted)));
println!("interrupted");
}`,
            );
            yield* CargoApi.build(directory, profile);
            const cancelled = yield* CargoApi.run(directory, "probe", [], profile);
            expect(cancelled.stdout.trim()).toBe("interrupted");
            expect(messages(cancelled.stderr)).toEqual(["started", "release"]);
            yield* fs.writeFileString(`${directory}/src/main.rs`, artifact.files["src/main.rs"]);
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);
