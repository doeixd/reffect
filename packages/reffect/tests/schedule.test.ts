import { Cause, Effect, Exit, FileSystem, Logger, Option, Schedule } from "effect";
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

const beat = (message: string) => R.Effect.logInfo(message);
const recurs = R.fn([], R.Unit, R.Never, () =>
  R.Effect.repeat(beat("recurs"), { schedule: R.Schedule.recurs(3) }),
);
const spaced = R.fn([], R.Unit, R.Never, () =>
  R.Effect.repeat(beat("spaced"), { schedule: R.Schedule.spaced(5), times: 2 }),
);
const exponential = R.fn([], R.Unit, R.Never, () =>
  R.Effect.repeat(beat("exponential"), { schedule: R.Schedule.exponential(2, 2), times: 3 }),
);
const forever = R.fn([], R.Unit, R.Never, () =>
  R.Effect.repeat(beat("forever"), { schedule: R.Schedule.forever, times: 3 }),
);
const retries = R.fn([], R.Unit, R.Bool, () =>
  R.Effect.retry(
    beat("retry").pipe(R.Effect.andThen(R.Effect.fail(R.Bool.literal(false))), R.Effect.asVoid),
    { schedule: R.Schedule.recurs(2) },
  ),
);
const retryOk = R.fn([], R.U64, R.Bool, () =>
  R.Effect.retry(R.Effect.succeed(R.U64.literal(7n)), R.Schedule.recurs(2)),
);
const retrySlow = R.fn([], R.Unit, R.Bool, () =>
  R.Effect.retry(
    beat("slow").pipe(R.Effect.andThen(R.Effect.fail(R.Bool.literal(false))), R.Effect.asVoid),
    { schedule: R.Schedule.spaced(1000) },
  ),
);
const program = R.program({ recurs, spaced, exponential, forever, retries, retryOk, retrySlow });

const official = {
  recurs: Effect.repeat(Effect.logInfo("recurs"), { schedule: Schedule.recurs(3) }),
  spaced: Effect.repeat(Effect.logInfo("spaced"), { schedule: Schedule.spaced(5), times: 2 }),
  exponential: Effect.repeat(Effect.logInfo("exponential"), {
    schedule: Schedule.exponential(2, 2),
    times: 3,
  }),
  forever: Effect.repeat(Effect.logInfo("forever"), { schedule: Schedule.forever, times: 3 }),
  retries: Effect.retry(Effect.logInfo("retry").pipe(Effect.andThen(Effect.fail(false))), {
    schedule: Schedule.recurs(2),
  }),
  retryOk: Effect.retry(Effect.succeed(7n), Schedule.recurs(2)),
};
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
const messages = (stderr: string): string[] =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
    .map((line) => JSON.parse(line).message);

test("bounded schedules agree with Effect v4 and refuse unrepresentable inputs", async () => {
  expect(await capture(Reference.run(recurs, []))).toEqual(await capture(official.recurs));
  expect(await capture(Reference.run(spaced, []))).toEqual(await capture(official.spaced));
  expect(await capture(Reference.run(exponential, []))).toEqual(
    await capture(official.exponential),
  );
  expect(await capture(Reference.run(forever, []))).toEqual(await capture(official.forever));
  expect(await capture(Reference.run(retries, []))).toEqual(await capture(official.retries));
  expect(await capture(Reference.run(retryOk, []))).toEqual(await capture(official.retryOk));
  for (const times of [-1, 0.5, Infinity, NaN, 1000001])
    expect(() => R.Schedule.recurs(times)).toThrow();
  for (const duration of [0, -1, 0.5, 60001, Infinity, NaN])
    expect(() => R.Schedule.spaced(duration)).toThrow();
  expect(() => R.Schedule.exponential(-1)).toThrow();
  for (const factor of [0, -1, Infinity, NaN, 1001])
    expect(() => R.Schedule.exponential(1, factor)).toThrow();
  const forged = R.fn([], R.Unit, R.Never, () =>
    Computation.make(R.Unit, R.Never, {
      _tag: "Repeat",
      body: beat("forged"),
      schedule: { _tag: "Exponential", milliseconds: 1, factor: 0 },
      times: undefined,
    }),
  );
  const invalid = await Effect.runPromise(Compile.check(R.program({ forged })).pipe(Effect.flip));
  expect(invalid.diagnostics.map((d) => d.code)).toContain("TYPE_MISMATCH");
  const artifact = await Effect.runPromise(Compile.run(program, Rust.tokio));
  expect(artifact.files["src/lib.rs"]).not.toContain("Box<dyn>");
});

test("native scheduled loops and retries agree with reference in debug/release", async () => {
  const oracles = {
    recurs: await capture(official.recurs),
    spaced: await capture(official.spaced),
    exponential: await capture(official.exponential),
    forever: await capture(official.forever),
    retries: await capture(official.retries),
    retryOk: await capture(official.retryOk),
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({
        directory: ".",
        prefix: "reffect-schedule-",
      });
      for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
        const artifact = yield* Compile.make(program).pipe(
          Compile.withTarget(Rust.tokio),
          Compile.withSourceArtifacts(SourceArtifacts.None),
          Compile.withFailureFrames(policy),
          Compile.run,
        );
        const directory = yield* CargoApi.write(
          artifact,
          `${parent}/${FailureFrames.isNone(policy) ? "none" : "bounded"}`,
        );
        for (const profile of ["debug", "release"] as const) {
          yield* CargoApi.build(directory, profile);
          for (const name of ["recurs", "spaced", "exponential", "forever"] as const) {
            const result = yield* CargoApi.run(directory, name, [], profile);
            expect(messages(result.stderr)).toEqual(oracles[name].logs);
          }
          const failed = yield* NativeRunner.run(
            artifact,
            directory,
            "retries",
            retries,
            [],
            profile,
          );
          expect(observe(failed)).toEqual(oracles.retries.exit);
          expect(messages((yield* CargoApi.run(directory, "retries", [], profile)).stderr)).toEqual(
            oracles.retries.logs,
          );
          const ok = yield* NativeRunner.run(artifact, directory, "retryOk", retryOk, [], profile);
          expect(observe(ok)).toEqual(oracles.retryOk.exit);
          if (!FailureFrames.isNone(policy)) {
            const probe = `
use std::future::Future;
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let (sender, receiver) = tokio::sync::watch::channel(false);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    let future = reffect_generated::r_retrySlow(&mut ctx);
    tokio::pin!(future);
    std::future::poll_fn(|cx| match future.as_mut().poll(cx) {
        std::task::Poll::Pending => { sender.send(true).unwrap(); std::task::Poll::Ready(()) },
        std::task::Poll::Ready(_) => panic!("Expected a retry delay after the first attempt"),
    }).await;
    assert!(matches!(future.await, Err(reffect_generated::AsyncError::Interrupted)));
}
`;
            yield* fs.writeFileString(`${directory}/src/main.rs`, probe);
            yield* CargoApi.build(directory, profile);
            const interrupted = yield* CargoApi.run(directory, "probe", [], profile);
            expect(messages(interrupted.stderr)).toEqual(["slow"]);
            yield* fs.writeFileString(`${directory}/src/main.rs`, artifact.files["src/main.rs"]);
            const framed = yield* NativeRunner.runWithFrames(
              artifact,
              directory,
              "retries",
              retries,
              [],
              profile,
            );
            const oracle = yield* Reference.runWithFrames(retries, [], "functions.retries.body");
            expect(framed.frames.map(({ path, kind }) => ({ path, kind }))).toEqual(oracle.frames);
          }
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.provide(Logger.layer([]))),
  );
}, 240000);
