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
  Source,
  SourceArtifacts,
} from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const token = R.U64.literal(9007199254740993n);
const release = (resource: ReturnType<typeof R.U64.literal>) =>
  R.Log.info("release:start", [["token", resource]]).pipe(
    R.Effect.flatMap(() => R.Effect.sleep(5)),
    R.Effect.flatMap(() => R.Log.info("release:done", [["token", resource]])),
  );
const bracket = R.fn([R.Bool], R.U64, R.Bool, (allowed) =>
  R.Effect.acquireUseRelease(
    R.Effect.succeed(token),
    (resource) => R.Match.bool(allowed, R.Effect.succeed(resource), R.Effect.fail(allowed)),
    release,
  ),
);
const failedAcquire = R.fn([], R.U64, R.Bool, () =>
  R.Effect.acquireUseRelease(
    R.Effect.fail(R.Bool.literal(false)),
    () => R.Effect.succeed(token),
    () => R.Log.info("must-not-release"),
  ),
);
const acquired = R.Log.info("acquire:start").pipe(
  R.Effect.flatMap(() => R.Effect.sleep(10)),
  R.Effect.flatMap(() => R.Log.info("acquire:done")),
  R.Effect.flatMap(() => R.Effect.succeed(token)),
);
const cancelAcquire = R.fn([], R.Unit, R.Never, () =>
  R.Effect.acquireUseRelease(
    acquired,
    (resource) => R.Log.info("use", [["token", resource]]),
    release,
  ),
);
const cancelUse = R.fn([], R.Unit, R.Never, () =>
  R.Effect.acquireUseRelease(
    R.Effect.succeed(token),
    (resource) =>
      R.Log.info("use", [["token", resource]]).pipe(R.Effect.flatMap(() => R.Effect.sleep(10000))),
    release,
  ),
);
const nested = R.fn([], R.Unit, R.Never, () =>
  R.Effect.acquireUseRelease(
    R.Effect.succeed(token),
    () =>
      R.Effect.acquireUseRelease(
        R.Effect.succeed(token),
        () => R.Effect.void,
        () => R.Log.info("inner"),
      ),
    () => R.Log.info("outer"),
  ),
);
const mapped = R.fn([], R.U64, R.Never, () =>
  R.Effect.acquireUseRelease(
    R.Effect.succeed(token),
    (resource) => R.Effect.succeed(resource),
    release,
  ).pipe(Source.at(Source.site(Source.file("scope.ts", "acquireUseRelease"), 0, 17))),
);
const program = R.program({ bracket, failedAcquire, cancelAcquire, cancelUse, nested, mapped });
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
const cancellationOracle = async (duringAcquire: boolean) => {
  const logs: string[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* Reference.run(duringAcquire ? cancelAcquire : cancelUse, []).pipe(
          Effect.forkScoped,
        );
        yield* Effect.sync(() => logs.includes(duringAcquire ? "acquire:start" : "use")).pipe(
          Effect.repeat({ while: (ready) => !ready, schedule: Schedule.spaced("1 millis") }),
          Effect.timeout("3 seconds"),
        );
        yield* Fiber.interrupt(fiber);
        expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
      }),
    ).pipe(
      Effect.provide(Logger.layer([Logger.make((options) => logs.push(String(options.message)))])),
    ),
  );
  return logs;
};

test("resource bracket refuses escaped symbolic binders and forged failing release", async () => {
  let leaked = token;
  const escaped = R.Effect.acquireUseRelease(
    R.Effect.succeed(token),
    (resource) => {
      leaked = resource;
      return R.Effect.void;
    },
    () => R.Effect.void,
  ).pipe(R.Effect.flatMap(() => R.Effect.succeed(leaked)));
  const badRelease = Computation.make(R.Unit, R.Never, {
    _tag: "Fail",
    error: R.Bool.literal(false),
  });
  const invalid = R.fn([], R.Unit, R.Never, () =>
    R.Effect.acquireUseRelease(
      R.Effect.succeed(token),
      () => R.Effect.void,
      () => badRelease,
    ),
  );
  const escaping = R.fn([], R.U64, R.Never, () => escaped);
  for (const selected of [R.program({ invalid }), R.program({ escaping })]) {
    const codes = await Effect.runPromise(
      Compile.run(selected, Rust.tokio).pipe(
        Effect.match({
          onSuccess: () => [],
          onFailure: (error) => error.diagnostics.map((d) => d.code),
        }),
      ),
    );
    expect(codes.length).toBeGreaterThan(0);
  }
  R.Effect.acquireUseRelease(
    R.Effect.succeed(token),
    () => R.Effect.void,
    // @ts-expect-error A release callback cannot fail with a domain value.
    () => R.Effect.fail(R.Bool.literal(false)),
  );
});

test(
  "resource bracket masks acquisition and release without dynamic Scope machinery",
  async () => {
    for (const allowed of [true, false]) {
      const logs: string[] = [];
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* Reference.run(bracket, [allowed]).pipe(Effect.forkScoped);
            yield* Effect.sync(() => logs.includes("release:start")).pipe(
              Effect.repeat({ while: (ready) => !ready, schedule: Schedule.spaced("1 millis") }),
              Effect.timeout("3 seconds"),
            );
            yield* Fiber.interrupt(fiber);
            return observe(yield* Fiber.await(fiber));
          }),
        ).pipe(
          Effect.provide(
            Logger.layer([Logger.make((options) => logs.push(String(options.message)))]),
          ),
        ),
      );
      expect(result).toEqual(
        allowed ? { error: undefined, interrupted: true } : { error: false, interrupted: false },
      );
      expect(logs).toEqual(["release:start", "release:done"]);
    }
    const acquireLogs = await cancellationOracle(true);
    const useLogs = await cancellationOracle(false);
    expect(acquireLogs).toEqual(["acquire:start", "acquire:done", "release:start", "release:done"]);
    expect(useLogs).toEqual(["use", "release:start", "release:done"]);
    const refused = await Effect.runPromise(
      Compile.run(program).pipe(
        Effect.match({
          onSuccess: () => [],
          onFailure: (error) => error.diagnostics.map((d) => d.code),
        }),
      ),
    );
    expect(refused).toContain("UNSUPPORTED_CAPABILITY");
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({
            directory: ".",
            prefix: "reffect-bracket-",
          });
          for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
            const artifact = yield* Compile.make(program).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withFailureFrames(policy),
              Compile.run,
            );
            expect(artifact.files["src/lib.rs"]).not.toContain("Box<dyn");
            expect(artifact.files["src/lib.rs"]).not.toContain("Vec<Finalizer");
            if (FailureFrames.isNone(policy))
              expect(artifact.files["src/lib.rs"]).not.toContain("FrameTrail");
            expect(artifact.sources.files.some((file) => file.path === "scope.ts")).toBe(true);
            expect(artifact.sources.ranges.length).toBeGreaterThan(0);
            const directory = yield* CargoApi.write(
              artifact,
              `${parent}/${FailureFrames.isNone(policy) ? "none" : "bounded"}`,
            );
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              for (const allowed of [true, false]) {
                expect(
                  observe(
                    yield* NativeRunner.run(
                      artifact,
                      directory,
                      "bracket",
                      bracket,
                      [allowed],
                      profile,
                    ),
                  ),
                ).toEqual(observe(yield* Effect.exit(Reference.run(bracket, [allowed]))));
                if (!allowed && !FailureFrames.isNone(policy)) {
                  const native = yield* NativeRunner.runWithFrames(
                    artifact,
                    directory,
                    "bracket",
                    bracket,
                    [allowed],
                    profile,
                  );
                  const reference = yield* Reference.runWithFrames(
                    bracket,
                    [allowed],
                    "functions.bracket.body",
                  );
                  expect(native.frames.map(({ path, kind }) => ({ path, kind }))).toEqual(
                    reference.frames,
                  );
                }
              }
              expect(
                observe(
                  yield* NativeRunner.run(
                    artifact,
                    directory,
                    "failedAcquire",
                    failedAcquire,
                    [],
                    profile,
                  ),
                ),
              ).toEqual({ error: false, interrupted: false });
              const probeMain = `
use std::future::Future;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
struct Counting;
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 { ALLOCS.fetch_add(1, Ordering::SeqCst); System.alloc(layout) }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) { System.dealloc(ptr, layout); }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 { ALLOCS.fetch_add(1, Ordering::SeqCst); System.realloc(ptr, layout, size) }
}
#[global_allocator] static ALLOCATOR: Counting = Counting;
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let (_sender, receiver) = tokio::sync::watch::channel(false);
    let before = ALLOCS.load(Ordering::SeqCst);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    assert_eq!(ALLOCS.load(Ordering::SeqCst) - before, 0);
    let before = ALLOCS.load(Ordering::SeqCst);
    let bracket_bytes = { let future = reffect_generated::r_bracket(&mut ctx, true); std::mem::size_of_val(&future) };
    let nested_bytes = { let future = reffect_generated::r_nested(&mut ctx); std::mem::size_of_val(&future) };
    assert_eq!(ALLOCS.load(Ordering::SeqCst) - before, 0);
    println!("layout:context={},bracket={},nested={}", std::mem::size_of_val(&ctx), bracket_bytes, nested_bytes);
    for mode in 0..4 {
        let (sender, receiver) = tokio::sync::watch::channel(false);
        let mut ctx = reffect_generated::AsyncContext::new(receiver);
        if mode == 0 {
            let future = reffect_generated::r_cancelAcquire(&mut ctx);
            tokio::pin!(future);
            std::future::poll_fn(|cx| match future.as_mut().poll(cx) {
                std::task::Poll::Pending => { sender.send(true).unwrap(); std::task::Poll::Ready(()) },
                _ => panic!("expected acquisition suspension"),
            }).await;
            assert!(matches!(future.await, Err(reffect_generated::AsyncError::Interrupted)));
        } else if mode == 1 {
            let future = reffect_generated::r_cancelUse(&mut ctx);
            tokio::pin!(future);
            std::future::poll_fn(|cx| match future.as_mut().poll(cx) {
                std::task::Poll::Pending => { sender.send(true).unwrap(); std::task::Poll::Ready(()) },
                _ => panic!("expected use suspension"),
            }).await;
            assert!(matches!(future.await, Err(reffect_generated::AsyncError::Interrupted)));
        } else if mode == 2 {
            assert!(matches!(reffect_generated::r_failedAcquire(&mut ctx).await, Err(reffect_generated::AsyncError::Fail(false))));
            reffect_generated::r_nested(&mut ctx).await.unwrap();
        } else {
            for allowed in [true, false] {
            let (sender, receiver) = tokio::sync::watch::channel(false);
            let mut ctx = reffect_generated::AsyncContext::new(receiver);
            let future = reffect_generated::r_bracket(&mut ctx, allowed);
            tokio::pin!(future);
            std::future::poll_fn(|cx| match future.as_mut().poll(cx) {
                std::task::Poll::Pending => { sender.send(true).unwrap(); std::task::Poll::Ready(()) },
                _ => panic!("expected release suspension"),
            }).await;
            let outcome = future.await;
            if allowed { assert!(matches!(outcome, Err(reffect_generated::AsyncError::Interrupted))); }
            else { assert!(matches!(outcome, Err(reffect_generated::AsyncError::Fail(false)))); }
            }
        }
    }
    println!("bracket conformance");
}
`;
              yield* fs.writeFileString(`${directory}/src/main.rs`, probeMain);
              yield* CargoApi.build(directory, profile);
              const result = yield* CargoApi.run(directory, "probe", [], profile);
              yield* fs.writeFileString(`${directory}/src/main.rs`, artifact.files["src/main.rs"]);
              expect(messages(result.stderr)).toEqual(
                acquireLogs.concat(useLogs, [
                  "inner",
                  "outer",
                  "release:start",
                  "release:done",
                  "release:start",
                  "release:done",
                ]),
              );
              expect(result.stdout).toContain("bracket conformance");
              console.info(
                `resource bracket ${FailureFrames.isNone(policy) ? "none" : "bounded"}/${profile}: ${result.stdout.trim().replaceAll("\n", ", ")}`,
              );
              const records = result.stderr
                .split("\n")
                .filter(
                  (line) =>
                    line.startsWith('{"schema":"reffect.log@1"') && line.includes('"token"'),
                )
                .map((line) => JSON.parse(line));
              for (const record of records)
                expect(record.annotations.token).toBe("9007199254740993");
            }
            const stripped = yield* Compile.make(program).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.withFailureFrames(policy),
              Compile.run,
            );
            expect(stripped.files["src/lib.rs"]).toContain("acquired");
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer), Effect.provide(Logger.layer([]))),
    );
  },
  nativeTestBudget(0) + 120000,
);
