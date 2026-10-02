import { Cause, Effect, Exit, FileSystem, Fiber, Logger, Option, Schedule } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  Computation,
  FailureFrames,
  NativeRunner,
  R,
  Reference,
  Rust,
  SourceArtifacts,
} from "../src/index.ts";

const cleanup = (name: string) =>
  R.Effect.logInfo(`${name}:start`).pipe(
    R.Effect.andThen(R.Effect.sleep(5)),
    R.Effect.andThen(R.Effect.logInfo(`${name}:done`)),
  );
const body = R.Effect.logInfo("beat");
const finite = R.fn([], R.Unit, R.Never, () =>
  R.Effect.addFinalizer(() => cleanup("outer")).pipe(
    R.Effect.andThen(R.Effect.logInfo("started")),
    R.Effect.andThen(R.Effect.addFinalizer(() => cleanup("inner"))),
    R.Effect.andThen(R.Effect.repeat(body, { schedule: R.Schedule.spaced(5), times: 2 })),
    R.Effect.scoped,
  ),
);
const cancel = R.fn([], R.Unit, R.Never, () =>
  R.Effect.addFinalizer(() => cleanup("outer")).pipe(
    R.Effect.andThen(R.Effect.logInfo("started")),
    R.Effect.andThen(R.Effect.addFinalizer(() => cleanup("inner"))),
    R.Effect.andThen(R.Effect.repeat(body, { schedule: R.Schedule.spaced(1000) })),
    R.Effect.scoped,
  ),
);
const failed = R.fn([], R.Unit, R.Bool, () =>
  R.Effect.addFinalizer(() => cleanup("outer")).pipe(
    R.Effect.andThen(
      R.Effect.repeat(
        R.Effect.logInfo("failed-beat").pipe(
          R.Effect.andThen(R.Effect.fail(R.Bool.literal(false))),
          R.Effect.asVoid,
        ),
        { schedule: R.Schedule.spaced(5), times: 10 },
      ),
    ),
    R.Effect.andThen(R.Effect.addFinalizer(() => cleanup("skipped"))),
    R.Effect.scoped,
  ),
);
const zero = R.fn([], R.Unit, R.Never, () =>
  R.Effect.repeat(body, { schedule: R.Schedule.spaced(5), times: 0 }),
);
const nested = R.fn([], R.Unit, R.Never, () =>
  R.Effect.addFinalizer(() => cleanup("outer")).pipe(
    R.Effect.andThen(
      R.Effect.addFinalizer(() => cleanup("inner")).pipe(R.Effect.andThen(body), R.Effect.scoped),
    ),
    R.Effect.andThen(R.Effect.logInfo("after-inner")),
    R.Effect.scoped,
  ),
);
const program = R.program({ finite, cancel, failed, zero, nested });
const messages = (stderr: string): string[] =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
    .map((line) => JSON.parse(line).message);
const observe = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.match(exit, {
    onSuccess: (value) => ({ value }),
    onFailure: (cause) => ({
      error: Option.getOrUndefined(Cause.findErrorOption(cause)),
      interrupted: Cause.hasInterrupts(cause),
    }),
  });
const capture = async <A, E>(effect: Effect.Effect<A, E>) => {
  const logs: string[] = [];
  const exit = await Effect.runPromise(
    Effect.exit(effect).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make((options) => {
            logs.push(String(options.message));
          }),
        ]),
      ),
    ),
  );
  return { exit: observe(exit), logs };
};
const officialCleanup = (name: string) =>
  Effect.logInfo(`${name}:start`).pipe(
    Effect.andThen(Effect.sleep(5)),
    Effect.andThen(Effect.logInfo(`${name}:done`)),
  );
const official = (times?: number) =>
  Effect.addFinalizer(() => officialCleanup("outer")).pipe(
    Effect.andThen(Effect.logInfo("started")),
    Effect.andThen(Effect.addFinalizer(() => officialCleanup("inner"))),
    Effect.andThen(
      Effect.repeat(Effect.logInfo("beat"), {
        schedule: Schedule.spaced(times === undefined ? 1000 : 5),
        times,
      }),
    ),
    Effect.scoped,
  );
const interruptAfterBeat = (effect: Effect.Effect<void, unknown>) => {
  const logs: string[] = [];
  return Effect.gen(function* () {
    const fiber = yield* effect.pipe(Effect.forkScoped);
    yield* Effect.sync(() => logs.includes("beat")).pipe(
      Effect.repeat({ while: (ready) => !ready, schedule: Schedule.spaced(1) }),
      Effect.timeout("2 seconds"),
    );
    yield* Fiber.interrupt(fiber);
    return { exit: observe(yield* Fiber.await(fiber)), logs };
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Logger.layer([
        Logger.make((options) => {
          logs.push(String(options.message));
        }),
      ]),
    ),
  );
};

test("v4 scoped sequence preserves registration, repetition counts and nested closure", async () => {
  expect(await capture(Reference.run(finite, []))).toEqual(await capture(official(2)));
  expect((await capture(Reference.run(zero, []))).logs).toEqual(["beat"]);
  expect((await capture(Reference.run(nested, []))).logs).toEqual([
    "beat",
    "inner:start",
    "inner:done",
    "after-inner",
    "outer:start",
    "outer:done",
  ]);
  const v4Failed = Effect.addFinalizer(() => officialCleanup("outer")).pipe(
    Effect.andThen(
      Effect.repeat(Effect.logInfo("failed-beat").pipe(Effect.andThen(Effect.fail(false))), {
        schedule: Schedule.spaced(5),
        times: 10,
      }),
    ),
    Effect.andThen(Effect.addFinalizer(() => officialCleanup("skipped"))),
    Effect.scoped,
  );
  expect(await capture(Reference.run(failed, []))).toEqual(await capture(v4Failed));
  expect(await Effect.runPromise(interruptAfterBeat(Reference.run(cancel, [])))).toEqual(
    await Effect.runPromise(interruptAfterBeat(official())),
  );
  for (const duration of [0, -1, 0.5, 60001, Infinity, NaN])
    expect(() => R.Schedule.spaced(duration)).toThrow();
  for (const times of [-1, 0.5, Infinity, NaN, 1000001])
    expect(() => R.Effect.repeat(body, { schedule: R.Schedule.spaced(1), times })).toThrow();
  expect(R.Schedule.spaced("1 second").plan).toEqual({ _tag: "Spaced", milliseconds: 1000 });
  const forged = R.fn([], R.Unit, R.Never, () =>
    Computation.make(R.Unit, R.Never, {
      _tag: "Repeat",
      body,
      schedule: { _tag: "Spaced", milliseconds: 0 },
      times: undefined,
    }),
  );
  const invalid = await Effect.runPromise(Compile.check(R.program({ forged })).pipe(Effect.flip));
  expect(invalid.diagnostics.map((d) => d.code)).toContain("TYPE_MISMATCH");
  const refused = await Effect.runPromise(Compile.run(program).pipe(Effect.flip));
  expect(refused.diagnostics.map((d) => d.code)).toContain("UNSUPPORTED_CAPABILITY");
});

test("native concrete loops and registered finalizers agree with v4, including interruption", async () => {
  const finiteOracle = await capture(official(2));
  const cancelOracle = await Effect.runPromise(interruptAfterBeat(official()));
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({
        directory: ".",
        prefix: "reffect-heartbeat-",
      });
      for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
        const artifact = yield* Compile.make(program).pipe(
          Compile.withTarget(Rust.tokio),
          Compile.withSourceArtifacts(SourceArtifacts.None),
          Compile.withFailureFrames(policy),
          Compile.run,
        );
        expect(artifact.files["src/lib.rs"]).not.toContain("Box<dyn");
        expect(artifact.explanation.analysis.effects.map((effect) => effect.id)).toContain(
          "reffect/effect/repeat-scheduled@1",
        );
        const directory = yield* CargoApi.write(
          artifact,
          `${parent}/${FailureFrames.isNone(policy) ? "none" : "bounded"}`,
        );
        for (const profile of ["debug", "release"] as const) {
          yield* CargoApi.build(directory, profile);
          const output = yield* CargoApi.run(directory, "finite", [], profile);
          expect(messages(output.stderr)).toEqual(finiteOracle.logs);
          for (const [name, fn] of [
            ["zero", zero],
            ["nested", nested],
          ] as const) {
            const result = yield* CargoApi.run(directory, name, [], profile);
            expect(messages(result.stderr)).toEqual(
              (yield* Effect.promise(() => capture(Reference.run(fn, [])))).logs,
            );
          }
          const native = yield* NativeRunner.run(
            artifact,
            directory,
            "failed",
            failed,
            [],
            profile,
          );
          expect(observe(native)).toEqual(
            (yield* Effect.promise(() => capture(Reference.run(failed, [])))).exit,
          );
          expect(messages((yield* CargoApi.run(directory, "failed", [], profile)).stderr)).toEqual([
            "failed-beat",
            "outer:start",
            "outer:done",
          ]);
          if (!FailureFrames.isNone(policy)) {
            const nativeFrames = yield* NativeRunner.runWithFrames(
              artifact,
              directory,
              "failed",
              failed,
              [],
              profile,
            );
            const oracleFrames = yield* Reference.runWithFrames(
              failed,
              [],
              "functions.failed.body",
            );
            expect(nativeFrames.frames.map(({ path, kind }) => ({ path, kind }))).toEqual(
              oracleFrames.frames,
            );
          }
          const probe = `
use std::future::Future;
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let (sender, receiver) = tokio::sync::watch::channel(false);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    let future = reffect_generated::r_cancel(&mut ctx);
    tokio::pin!(future);
    std::future::poll_fn(|cx| match future.as_mut().poll(cx) {
        std::task::Poll::Pending => { sender.send(true).unwrap(); std::task::Poll::Ready(()) },
        std::task::Poll::Ready(_) => panic!("Expected first heartbeat then spacing"),
    }).await;
    assert!(matches!(future.await, Err(reffect_generated::AsyncError::Interrupted)));
    let (_sender, receiver) = tokio::sync::watch::channel(true);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    assert!(matches!(reffect_generated::r_cancel(&mut ctx).await, Err(reffect_generated::AsyncError::Interrupted)));
}
`;
          yield* fs.writeFileString(`${directory}/src/main.rs`, probe);
          yield* CargoApi.build(directory, profile);
          const interrupted = yield* CargoApi.run(directory, "probe", [], profile);
          expect(messages(interrupted.stderr)).toEqual(cancelOracle.logs);
          yield* fs.writeFileString(`${directory}/src/main.rs`, artifact.files["src/main.rs"]);
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.provide(Logger.layer([]))),
  );
}, 240000);
