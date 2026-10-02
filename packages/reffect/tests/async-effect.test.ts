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
  Source,
} from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const cleanup = (name: string) =>
  R.Log.info(`${name}:start`).pipe(
    R.Effect.flatMap(() => R.Effect.sleep(20)),
    R.Effect.flatMap(() => R.Log.info(`${name}:done`)),
  );
const delayed = R.fn([R.Bool], R.U64, R.Bool, (allowed) =>
  R.Effect.sleep(1).pipe(
    R.Effect.flatMap(() =>
      R.Match.bool(allowed, R.Effect.succeed(R.U64.literal(42n)), R.Effect.fail(allowed)),
    ),
    R.Effect.ensuring(cleanup("inner")),
    R.Effect.ensuring(cleanup("outer")),
  ),
);
const cancel = R.fn([], R.Unit, R.Never, () =>
  R.Log.info("started").pipe(
    R.Effect.flatMap(() => R.Effect.sleep(10_000)),
    R.Effect.flatMap(() => R.Log.info("after")),
    R.Effect.ensuring(cleanup("inner")),
    R.Effect.ensuring(cleanup("outer")),
    R.Log.annotate("owner", R.U64.literal(9007199254740993n)),
    R.Log.span("request"),
  ),
);
const settled = R.fn([R.Bool], R.U64, R.Bool, (allowed) =>
  R.Match.bool(allowed, R.Effect.succeed(R.U64.literal(7n)), R.Effect.fail(allowed)).pipe(
    R.Effect.ensuring(cleanup("settled")),
  ),
);
const program = R.program({ delayed, cancel, settled });
const observe = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.match(exit, {
    onSuccess: (value) => ({ value }),
    onFailure: (cause) => ({
      error: Option.getOrUndefined(Cause.findErrorOption(cause)),
      interrupted: Cause.hasInterrupts(cause),
    }),
  });
const messages = (stderr: string): string[] =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
    .map((line) => JSON.parse(line).message);

const oracleCancellation = async () => {
  const logs: string[] = [];
  const logger = Logger.layer([
    Logger.make((options) => {
      logs.push(String(options.message));
    }),
  ]);
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Reference.run(cancel, []).pipe(Effect.forkScoped);
      yield* Effect.sync(() => logs.includes("started")).pipe(
        Effect.repeat({ while: (ready) => !ready, schedule: Schedule.spaced("1 millis") }),
        Effect.timeout("2 seconds"),
      );
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.hasInterrupts(exit)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(logger)),
  );
  return logs;
};
const oracleDuringCleanup = (allowed: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fiber = yield* Reference.run(settled, [allowed]).pipe(Effect.forkScoped);
      yield* Effect.sleep(10);
      yield* Fiber.interrupt(fiber);
      return observe(yield* Fiber.await(fiber));
    }),
  ).pipe(Effect.provide(Logger.layer([])));

test("async profile validates literal delays and non-failing cleanup, and refuses std", async () => {
  for (const duration of [-1, 0.5, NaN, Infinity, 60001])
    expect(() => R.Effect.sleep(duration)).toThrow();
  expect(() => R.Effect.sleep(60000)).not.toThrow();
  const refused = await Effect.runPromise(
    Compile.run(program).pipe(
      Effect.map(() => []),
      Effect.catchTag("CompileError", (error) =>
        Effect.succeed(error.diagnostics.map((d) => d.code)),
      ),
    ),
  );
  expect(refused).toContain("UNSUPPORTED_CAPABILITY");
  const forged = R.fn([], R.Unit, R.Never, () =>
    Computation.make(R.Unit, R.Never, { _tag: "Sleep", milliseconds: -1 }),
  );
  const invalid = await Effect.runPromise(
    Compile.run(R.program({ forged }), Rust.tokio).pipe(
      Effect.map(() => []),
      Effect.catchTag("CompileError", (error) =>
        Effect.succeed(error.diagnostics.map((d) => d.code)),
      ),
    ),
  );
  expect(invalid).toContain("TYPE_MISMATCH");
  const source = Source.site(Source.file("src/async.ts", "sleep(1)"), 0, 8);
  const annotated = R.fn([], R.Unit, R.Never, () => R.Effect.sleep(1).pipe(Source.at(source)));
  const full = await Effect.runPromise(Compile.run(R.program({ annotated }), Rust.tokio));
  expect(full.sources.ranges.length).toBeGreaterThan(0);
  expect(full.files["src/lib.rs"]).toContain("async fn");
  expect(full.files["src/lib.rs"]).not.toContain("LAST_FRAMES");
  const sync = await Effect.runPromise(
    Compile.run(R.program({ sync: R.fn([], R.Unit, R.Never, () => R.Effect.void) }), Rust.tokio),
  );
  expect(sync.explanation.crates).toEqual([]);
  expect(sync.files["src/lib.rs"]).not.toContain("AsyncContext");
  expect(sync.files["Cargo.toml"]).not.toContain("tokio");
});

test(
  "concrete Tokio futures agree with Effect on exits, bounded frames and masked cleanup",
  async () => {
    const oracleLogs = await oracleCancellation();
    expect(oracleLogs).toEqual([
      "started",
      "inner:start",
      "inner:done",
      "outer:start",
      "outer:done",
    ]);
    expect(await Effect.runPromise(oracleDuringCleanup(true))).toEqual({
      error: undefined,
      interrupted: true,
    });
    expect(await Effect.runPromise(oracleDuringCleanup(false))).toEqual({
      error: false,
      interrupted: false,
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({
            directory: ".",
            prefix: "reffect-async-",
          });
          for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
            const artifact = yield* Compile.make(program).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.withFailureFrames(policy),
              Compile.run,
            );
            expect(artifact.explanation.runtime).toBe(Rust.asyncResult);
            expect(artifact.explanation.crates).toEqual(["tokio@1.53.1"]);
            expect(artifact.files["src/lib.rs"]).not.toContain("Box<dyn");
            if (FailureFrames.isNone(policy))
              expect(artifact.files["src/lib.rs"]).not.toContain("FrameTrail");
            const directory = yield* CargoApi.write(
              artifact,
              `${parent}/${FailureFrames.isNone(policy) ? "none" : "bounded"}`,
            );
            const probeMain = `
use std::future::Future;
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let (sender, receiver) = tokio::sync::watch::channel(false);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    println!("context:{}", std::mem::size_of_val(&ctx));
    { let future = reffect_generated::r_cancel(&mut ctx); println!("future:{}", std::mem::size_of_val(&future)); }
    tokio::spawn(async move { tokio::time::sleep(std::time::Duration::from_millis(30)).await; sender.send(true).unwrap(); });
    assert!(matches!(reffect_generated::r_cancel(&mut ctx).await, Err(reffect_generated::AsyncError::Interrupted)));
    ${FailureFrames.isNone(policy) ? "" : "let (frames, omitted) = ctx.take_frames(); assert!(frames.len() <= 32); assert_eq!(omitted, 0); assert_eq!(ctx.take_frames(), (Vec::new(), 0));"}
    println!("interrupted");
    let (_sender, receiver) = tokio::sync::watch::channel(true);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    assert!(matches!(reffect_generated::r_settled(&mut ctx, true).await, Err(reffect_generated::AsyncError::Interrupted)));
    for allowed in [true, false] {
        let (sender, receiver) = tokio::sync::watch::channel(false);
        let mut ctx = reffect_generated::AsyncContext::new(receiver);
        let future = reffect_generated::r_settled(&mut ctx, allowed);
        tokio::pin!(future);
        std::future::poll_fn(|cx| match future.as_mut().poll(cx) {
            std::task::Poll::Pending => { sender.send(true).unwrap(); std::task::Poll::Ready(()) },
            std::task::Poll::Ready(_) => panic!("Expected suspension inside the delayed finalizer"),
        }).await;
        let result = future.await;
        if allowed { assert!(matches!(result, Err(reffect_generated::AsyncError::Interrupted))); }
        else { assert!(matches!(result, Err(reffect_generated::AsyncError::Fail(false)))); }
    }
}
`;
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              for (const allowed of [true, false]) {
                const reference = yield* Effect.exit(Reference.run(delayed, [allowed]));
                const native = yield* NativeRunner.run(
                  artifact,
                  directory,
                  "delayed",
                  delayed,
                  [allowed],
                  profile,
                );
                expect(observe(native)).toEqual(observe(reference));
                if (!allowed && !FailureFrames.isNone(policy)) {
                  const framed = yield* NativeRunner.runWithFrames(
                    artifact,
                    directory,
                    "delayed",
                    delayed,
                    [allowed],
                    profile,
                  );
                  const oracle = yield* Reference.runWithFrames(
                    delayed,
                    [allowed],
                    "functions.delayed.body",
                  );
                  expect(framed.frames.map(({ path, kind }) => ({ path, kind }))).toEqual(
                    oracle.frames,
                  );
                  expect(framed.omitted).toBe(oracle.omitted);
                }
              }
              yield* fs.writeFileString(`${directory}/src/main.rs`, probeMain);
              yield* CargoApi.build(directory, profile);
              const probe = yield* CargoApi.run(directory, "probe", [], profile);
              yield* fs.writeFileString(`${directory}/src/main.rs`, artifact.files["src/main.rs"]);
              expect(probe.stdout).toContain("interrupted");
              expect(messages(probe.stderr)).toEqual(
                oracleLogs.concat([
                  "settled:start",
                  "settled:done",
                  "settled:start",
                  "settled:done",
                ]),
              );
              const records = probe.stderr
                .split("\n")
                .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
                .map((line) => JSON.parse(line));
              for (const record of records) {
                const scoped = !record.message.startsWith("settled:");
                expect(record.annotations).toEqual(scoped ? { owner: "9007199254740993" } : {});
                expect(record.spans.map((span: { label: string }) => span.label)).toEqual(
                  scoped ? ["request"] : [],
                );
              }
              console.info(
                `async layout ${FailureFrames.isNone(policy) ? "none" : "bounded"}/${profile}: ${probe.stdout.trim().replaceAll("\n", ", ")}`,
              );
              expect(probe.stdout).toMatch(/context:\d+\nfuture:\d+\ninterrupted/);
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0),
);
