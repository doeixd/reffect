import { Cause, Effect, Exit, FileSystem, Fiber, Logger, Option, Schedule } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  CompileError,
  Computation,
  Expr,
  FailureFrames,
  NativeRunner,
  Operation,
  R,
  Reference,
  Rust,
  SemanticRef,
} from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const recover = R.fn([R.Bool], R.U64, R.Never, (allowed) =>
  R.Match.bool(allowed, R.Effect.succeed(R.U64.literal(9n)), R.Effect.fail(allowed)).pipe(
    R.Effect.catchAll((error) =>
      R.Effect.succeed(R.Match.bool(error, R.U64.literal(1n), R.U64.literal(2n))),
    ),
  ),
);
const mapped = R.fn([R.Bool], R.U64, R.U64, (allowed) =>
  R.Effect.mapError(
    R.Match.bool(allowed, R.Effect.succeed(R.U64.literal(9n)), R.Effect.fail(allowed)),
    (error) => R.Match.bool(error, R.U64.literal(1n), R.U64.literal(2n)),
  ),
);
const fallback = R.fn([], R.U64, R.Never, () =>
  R.Effect.fail(R.Bool.literal(false)).pipe(R.Effect.orElse(R.Effect.succeed(R.U64.literal(4n)))),
);
const nested = R.fn([], R.U64, R.Bool, () =>
  R.Effect.fail(R.U64.literal(8n)).pipe(
    R.Effect.catchAll((error) => R.Effect.fail(R.U64.eq(error, R.U64.literal(8n)))),
    R.Effect.catchAll((error) => R.Effect.fail(R.Bool.not(error))),
  ),
);
const shared = R.fn([R.Bool], R.U64, R.Never, (allowed) => {
  const common = R.Effect.succeed(R.U64.literal(11n));
  const boolError = R.Match.bool(allowed, common, R.Effect.fail(R.Bool.literal(false))).pipe(
    R.Effect.orElse(R.Effect.succeed(R.U64.literal(12n))),
  );
  const u64Error = R.Match.bool(allowed, common, R.Effect.fail(R.U64.literal(8n))).pipe(
    R.Effect.orElse(R.Effect.succeed(R.U64.literal(13n))),
  );
  return R.Match.bool(allowed, boolError, u64Error);
});
const finalized = R.fn([], R.U64, R.Never, () =>
  R.Effect.fail(R.Bool.literal(false)).pipe(
    R.Effect.ensuring(R.Log.info("released")),
    R.Effect.catchAll(() =>
      R.Log.info("recovered").pipe(R.Effect.flatMap(() => R.Effect.succeed(R.U64.literal(5n)))),
    ),
  ),
);
const suspended = R.fn([R.Bool], R.U64, R.U64, (allowed) =>
  R.Effect.sleep(1).pipe(
    R.Effect.flatMap(() =>
      R.Match.bool(allowed, R.Effect.succeed(R.U64.literal(9n)), R.Effect.fail(allowed)),
    ),
    R.Effect.mapError((error) => R.Match.bool(error, R.U64.literal(1n), R.U64.literal(2n))),
  ),
);
const cancelled = R.fn([], R.Unit, R.Never, () =>
  R.Log.info("started").pipe(
    R.Effect.flatMap(() => R.Effect.sleep(10000)),
    R.Effect.ensuring(R.Log.info("released")),
    R.Effect.catchAll(() => R.Log.info("incorrect-recovery")),
  ),
);
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

test("recovery channels are typed and incompatible success witnesses are refused", async () => {
  const recovered = R.Effect.catchAll(R.Effect.fail(R.Bool.literal(false)), (error) =>
    R.Effect.succeed(R.Bool.not(error)),
  );
  expectTypeOf(recovered).toEqualTypeOf<Computation<boolean, never>>();
  const changed = R.Effect.mapError(R.Effect.fail(R.Bool.literal(false)), () => R.U64.literal(3n));
  expectTypeOf(changed).toEqualTypeOf<Computation<never, bigint>>();
  expect(() =>
    R.Effect.catchAll(R.Effect.succeed(R.Bool.literal(true)), () =>
      R.Effect.succeed(R.U64.literal(1n)),
    ),
  ).toThrow(CompileError);
  const forged = R.fn([], R.U64, R.Never, () =>
    Computation.make(R.U64, R.Never, {
      _tag: "CatchAll",
      source: R.Effect.fail(R.Bool.literal(false)),
      binder: Symbol("wrong"),
      body: R.Effect.fail(R.Bool.literal(true)),
    }),
  );
  const exit = await Effect.runPromise(Effect.exit(Compile.run(R.program({ forged }))));
  expect(Exit.isFailure(exit)).toBe(true);
  const unbound = R.fn([], R.Bool, R.Never, () =>
    Computation.make(R.Bool, R.Never, {
      _tag: "CatchAll",
      source: R.Effect.fail(R.Bool.literal(false)),
      binder: Symbol("handler"),
      body: R.Effect.succeed(Expr.parameter(R.Bool, Symbol("foreign"), 0)),
    }),
  );
  const invalid = await Effect.runPromise(Effect.exit(Compile.run(R.program({ unbound }))));
  expect(Exit.isFailure(invalid)).toBe(true);
  const broken = Operation.make(
    SemanticRef.operation("test/reference-defect@1"),
    [],
    R.Bool,
    () => {
      throw new Error("broken operation");
    },
  );
  const internal = R.fn([], R.Bool, R.Never, () =>
    R.Effect.succeed(Expr.apply(broken)).pipe(
      R.Effect.orElse(R.Effect.succeed(R.Bool.literal(true))),
    ),
  );
  for (const action of [
    Reference.run(internal, []).pipe(Effect.asVoid),
    Reference.runWithFrames(internal, []).pipe(Effect.asVoid),
  ]) {
    const outcome = await Effect.runPromise(Effect.exit(action));
    expect(Exit.isFailure(outcome)).toBe(true);
    if (Exit.isFailure(outcome)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(outcome.cause))).toBeInstanceOf(
        CompileError,
      );
    }
  }
});

test(
  "sync/async recovery agrees with Effect, resets handled frames and bypasses cancellation",
  async () => {
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
        Effect.provide(
          Logger.layer([Logger.make((options) => logs.push(String(options.message)))]),
        ),
      ),
    );
    expect(logs).toEqual(["released", "recovered", "started", "released"]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-recovery-" });
          for (const asynchronous of [false, true])
            for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
              const program = asynchronous
                ? R.program({
                    recover,
                    mapped,
                    fallback,
                    nested,
                    shared,
                    finalized,
                    suspended,
                    cancelled,
                  })
                : R.program({ recover, mapped, fallback, nested, shared });
              const artifact = yield* Compile.make(program).pipe(
                Compile.withTarget(asynchronous ? Rust.tokio : Rust.std),
                Compile.withFailureFrames(policy),
                Compile.run,
              );
              expect(artifact.files["src/lib.rs"]).not.toContain("Box<dyn");
              if (!FailureFrames.isNone(policy)) {
                expect(artifact.files["src/lib.rs"]).toContain("drop(_handled_frames)");
              }
              expect(artifact.explanation.crates).toEqual(asynchronous ? ["tokio@1.53.1"] : []);
              const directory = yield* CargoApi.write(
                artifact,
                `${parent}/${asynchronous}-${FailureFrames.isNone(policy)}`,
              );
              for (const profile of ["debug", "release"] as const) {
                yield* CargoApi.build(directory, profile);
                for (const allowed of [true, false]) {
                  expect(
                    yield* NativeRunner.run(
                      artifact,
                      directory,
                      "shared",
                      shared,
                      [allowed],
                      profile,
                    ),
                  ).toEqual(Exit.succeed(allowed ? 11n : 13n));
                  expect(
                    observe(
                      yield* NativeRunner.run(
                        artifact,
                        directory,
                        "recover",
                        recover,
                        [allowed],
                        profile,
                      ),
                    ),
                  ).toEqual(observe(yield* Effect.exit(Reference.run(recover, [allowed]))));
                  const actual = yield* FailureFrames.isNone(policy)
                    ? NativeRunner.run(
                        artifact,
                        directory,
                        "mapped",
                        mapped,
                        [allowed],
                        profile,
                      ).pipe(Effect.map((exit) => ({ exit, frames: [] })))
                    : NativeRunner.runWithFrames(
                        artifact,
                        directory,
                        "mapped",
                        mapped,
                        [allowed],
                        profile,
                      );
                  const oracle = yield* Reference.runWithFrames(
                    mapped,
                    [allowed],
                    "functions.mapped.body",
                  );
                  expect(observe(actual.exit)).toEqual(observe(oracle.exit));
                  expect(actual.frames.map(({ path, kind }) => ({ path, kind }))).toEqual(
                    FailureFrames.isNone(policy) ? [] : oracle.frames,
                  );
                  expect(
                    actual.frames.some((frame) => frame.path.endsWith(".source.onFalse")),
                  ).toBe(false);
                  if (asynchronous)
                    expect(
                      observe(
                        yield* NativeRunner.run(
                          artifact,
                          directory,
                          "suspended",
                          suspended,
                          [allowed],
                          profile,
                        ),
                      ),
                    ).toEqual(observe(yield* Effect.exit(Reference.run(suspended, [allowed]))));
                }
                expect(
                  yield* NativeRunner.run(artifact, directory, "fallback", fallback, [], profile),
                ).toEqual(Exit.succeed(4n));
                const actual = yield* FailureFrames.isNone(policy)
                  ? NativeRunner.run(artifact, directory, "nested", nested, [], profile).pipe(
                      Effect.map((exit) => ({ exit, frames: [] })),
                    )
                  : NativeRunner.runWithFrames(artifact, directory, "nested", nested, [], profile);
                const oracle = yield* Reference.runWithFrames(nested, [], "functions.nested.body");
                expect(observe(actual.exit)).toEqual(observe(oracle.exit));
                expect(actual.frames.map(({ path, kind }) => ({ path, kind }))).toEqual(
                  FailureFrames.isNone(policy) ? [] : oracle.frames,
                );
                if (asynchronous) {
                  const finished = yield* CargoApi.run(directory, "finalized", [], profile);
                  expect(messages(finished.stderr)).toEqual(["released", "recovered"]);
                  const main = `use std::future::Future;
#[tokio::main(flavor="current_thread")]
async fn main(){
let(sender,receiver)=tokio::sync::watch::channel(false);
let mut ctx=reffect_generated::AsyncContext::new(receiver);
let future=reffect_generated::r_cancelled(&mut ctx);tokio::pin!(future);
std::future::poll_fn(|cx|match future.as_mut().poll(cx){std::task::Poll::Pending=>{sender.send(true).unwrap();std::task::Poll::Ready(())},std::task::Poll::Ready(_)=>panic!("expected sleep")}).await;
assert!(matches!(future.await,Err(reffect_generated::AsyncError::Interrupted)));
println!("interrupted");
}`;
                  yield* fs.writeFileString(`${directory}/src/main.rs`, main);
                  yield* CargoApi.build(directory, profile);
                  const probe = yield* CargoApi.run(directory, "probe", [], profile);
                  expect(probe.stdout.trim()).toBe("interrupted");
                  expect(messages(probe.stderr)).toEqual(["started", "released"]);
                  yield* fs.writeFileString(
                    `${directory}/src/main.rs`,
                    artifact.files["src/main.rs"],
                  );
                }
              }
            }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120_000,
);
