import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Cause, Effect, Exit, Fiber, Logger } from "effect";
import { expect, test } from "vite-plus/test";
import { R, Rust, SourceArtifacts } from "../src/index.ts";
import { EffectReference } from "../src/effect-ir.ts";
import type { Computation, EffectFn } from "../src/effect-ir.ts";
import { emitFunctions, lowerQueueFunctions } from "../src/lower.ts";
import { QueueIR as Q } from "../src/queue.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const selected = new Map(Rust.std.implementations.map((item) => [item.operation.ref, item]));
const options = { concurrency: "unbounded", discard: true } as const;
const sequence = (steps: readonly Computation<void>[]) =>
  steps.reduce((result, next) => result.pipe(R.Effect.andThen(next)), R.Effect.void);
const pressure = (capacity: number, logging = true) =>
  R.fn([], R.U64, R.Never, () =>
    Q.bounded(R.U64, capacity).pipe(
      R.Effect.flatMap((owner) =>
        R.Effect.succeed(R.U64.literal(42n)).pipe(
          R.Effect.flatMap((captured) => {
            const producer = sequence(
              Array.from({ length: 4 }, (_, index) =>
                Q.offer(owner, R.U64.add(captured, R.U64.literal(BigInt(index)))).pipe(
                  R.Effect.flatMap((offered) =>
                    logging
                      ? R.Match.bool(offered, R.Log.info(`p:${index}`), R.Log.info("wrong-offer"))
                      : R.Effect.void,
                  ),
                ),
              ),
            );
            const consumer = sequence(
              Array.from({ length: 4 }, (_, index) =>
                Q.take(owner).pipe(
                  R.Effect.flatMap((value) =>
                    logging
                      ? R.Match.bool(
                          R.U64.eq(value, R.U64.add(captured, R.U64.literal(BigInt(index)))),
                          R.Log.info(`c:${index}`),
                          R.Log.info("wrong-payload"),
                        )
                      : R.Effect.void,
                  ),
                ),
              ),
            );
            return R.Effect.all([producer, consumer], options).pipe(R.Effect.as(captured));
          }),
        ),
      ),
    ),
  );
const boolean = R.fn([], R.Unit, R.Never, () =>
  Q.bounded(R.Bool, 1).pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.all(
        [
          Q.offer(owner, R.Bool.literal(false)).pipe(
            R.Effect.andThen(Q.offer(owner, R.Bool.literal(true))),
            R.Effect.asVoid,
          ),
          Q.take(owner).pipe(
            R.Effect.flatMap((value) =>
              R.Match.bool(value, R.Log.info("wrong-bool"), R.Log.info("bool:false")),
            ),
            R.Effect.andThen(
              Q.take(owner).pipe(
                R.Effect.flatMap((value) =>
                  R.Match.bool(value, R.Log.info("bool:true"), R.Log.info("wrong-bool")),
                ),
              ),
            ),
          ),
        ],
        options,
      ),
    ),
  ),
);
const unit = R.fn([], R.Unit, R.Never, () =>
  Q.bounded(R.Unit, 1).pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.all(
        [
          Q.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid),
          Q.take(owner).pipe(R.Effect.andThen(R.Log.info("unit:take"))),
        ],
        options,
      ),
    ),
  ),
);
const blocked = R.fn([], R.Unit, R.Never, () =>
  Q.bounded(R.U64, 1).pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.all(
        [
          Q.take(owner).pipe(R.Effect.andThen(R.Log.info("must-not-first"))),
          Q.take(owner).pipe(R.Effect.andThen(R.Log.info("must-not-second"))),
        ],
        options,
      ),
    ),
  ),
);
const functions = {
  pressure1: pressure(1),
  pressure2: pressure(2),
  pressure3: pressure(3),
  boolean,
  unit,
  blocked,
  quiet: pressure(1, false),
};
const observe = async (fn: EffectFn, cancelled = false) => {
  const logs: string[] = [];
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const work = EffectReference.runUnknown(fn, []);
      if (!cancelled) return yield* Effect.exit(work);
      const fiber = yield* Effect.forkChild(work, { startImmediately: true });
      yield* Fiber.interrupt(fiber);
      return yield* Fiber.await(fiber);
    }).pipe(
      Effect.provideService(
        Logger.CurrentLoggers,
        new Set([
          Logger.make((entry) => {
            logs.push(String(entry.message));
          }),
        ]),
      ),
    ),
  );
  return { logs, exit };
};
const harness = String.raw`
use reffect_generated as r;
use std::sync::atomic::{AtomicBool,AtomicUsize,Ordering};
struct Allocator;
static TRACK:AtomicBool=AtomicBool::new(false); static ALLOCATIONS:AtomicUsize=AtomicUsize::new(0);
unsafe impl std::alloc::GlobalAlloc for Allocator {
 unsafe fn alloc(&self,l:std::alloc::Layout)->*mut u8 { if TRACK.load(Ordering::Relaxed){ALLOCATIONS.fetch_add(1,Ordering::Relaxed);} unsafe{std::alloc::System.alloc(l)} }
 unsafe fn dealloc(&self,p:*mut u8,l:std::alloc::Layout){unsafe{std::alloc::System.dealloc(p,l)}}
 unsafe fn realloc(&self,p:*mut u8,l:std::alloc::Layout,n:usize)->*mut u8{if TRACK.load(Ordering::Relaxed){ALLOCATIONS.fetch_add(1,Ordering::Relaxed);}unsafe{std::alloc::System.realloc(p,l,n)}}
}
#[global_allocator] static ALLOCATOR:Allocator=Allocator;
async fn once<F:std::future::Future>(mut future:std::pin::Pin<&mut F>){std::future::poll_fn(|cx|{assert!(future.as_mut().poll(cx).is_pending());std::task::Poll::Ready(())}).await;}
async fn bounded<F:std::future::Future>(future:F)->F::Output{tokio::select!{biased;
 _=tokio::time::sleep(std::time::Duration::from_secs(2))=>panic!("Generated Queue must settle"),
 result=future=>result,
}}
#[tokio::main(flavor="current_thread")]
async fn main(){
 let (_parent,receiver)=tokio::sync::watch::channel(false);let mut ctx=r::AsyncContext::new(receiver);
 assert_eq!(bounded(r::r_pressure1(&mut ctx)).await.unwrap(),42);
 assert_eq!(bounded(r::r_pressure2(&mut ctx)).await.unwrap(),42);
 assert_eq!(bounded(r::r_pressure3(&mut ctx)).await.unwrap(),42);
 assert!(bounded(r::r_boolean(&mut ctx)).await.is_ok());assert!(bounded(r::r_unit(&mut ctx)).await.is_ok());
 let (cancel,receiver)=tokio::sync::watch::channel(false);let mut blocked=r::AsyncContext::new(receiver);
 {let future=r::r_blocked(&mut blocked);tokio::pin!(future);once(future.as_mut()).await;cancel.send(true).unwrap();assert!(matches!(bounded(future).await,Err(r::AsyncError::Interrupted)));}
 let (cancel,receiver)=tokio::sync::watch::channel(false);cancel.send(true).unwrap();let mut preabort=r::AsyncContext::new(receiver);
 assert!(matches!(r::r_blocked(&mut preabort).await,Err(r::AsyncError::Interrupted)));
 let layouts=r::reffect_queue_future_layouts(&mut ctx);
 ALLOCATIONS.store(0,Ordering::Relaxed);TRACK.store(true,Ordering::Relaxed);
 for _ in 0..1000{let future=r::r_quiet(&mut ctx);std::hint::black_box(&future);drop(future);}
 TRACK.store(false,Ordering::Relaxed);let construction=ALLOCATIONS.load(Ordering::Relaxed);
 ALLOCATIONS.store(0,Ordering::Relaxed);TRACK.store(true,Ordering::Relaxed);
 for _ in 0..1000{assert_eq!(r::r_quiet(&mut ctx).await.unwrap(),42);}
 TRACK.store(false,Ordering::Relaxed);let execution=ALLOCATIONS.load(Ordering::Relaxed);
 let (cancel,receiver)=tokio::sync::watch::channel(false);let mut blocked=r::AsyncContext::new(receiver);
 ALLOCATIONS.store(0,Ordering::Relaxed);TRACK.store(true,Ordering::Relaxed);
 {let future=r::r_blocked(&mut blocked);tokio::pin!(future);once(future.as_mut()).await;cancel.send(true).unwrap();assert!(matches!(future.await,Err(r::AsyncError::Interrupted)));}
 TRACK.store(false,Ordering::Relaxed);let cancellation=ALLOCATIONS.load(Ordering::Relaxed);
 assert_eq!((construction,execution,cancellation),(0,0,0));
 println!("COST construction={} execution={} cancellation={} layouts={:?}",construction,execution,cancellation,layouts);
 println!("queue-generated-ok");
}
`;

test(
  "private checked Queue IR generates differential Rust without child allocations",
  async () => {
    const observations = [];
    for (const [name, fn] of Object.entries(functions)) {
      if (name === "quiet") continue;
      const observation = await observe(fn, name === "blocked");
      observations.push(observation);
      if (name === "blocked")
        expect(
          Exit.isFailure(observation.exit) && Cause.hasInterruptsOnly(observation.exit.cause),
        ).toBe(true);
      else expect(Exit.isSuccess(observation.exit)).toBe(true);
      expect(
        observation.logs.some((log) => log.startsWith("wrong") || log.startsWith("must-not")),
      ).toBe(false);
    }
    expect(observations[0]!.logs).toEqual(["p:0", "p:1", "c:0", "p:2", "c:1", "p:3", "c:2", "c:3"]);
    const expectedLogs = observations.flatMap((observation) => observation.logs);
    const directory = await mkdtemp(join(tmpdir(), "reffect-queue-generated-"));
    const run = promisify(execFile);
    try {
      const emitted = emitFunctions(
        lowerQueueFunctions(R.program(functions), selected, SourceArtifacts.None),
      );
      for (const [path, contents] of Object.entries(emitted.files)) {
        await mkdir(dirname(join(directory, path)), { recursive: true });
        await writeFile(join(directory, path), contents);
      }
      await writeFile(join(directory, "src/main.rs"), harness);
      for (const mode of [[], ["--release"]]) {
        const result = await run("cargo", ["run", "--offline", "--quiet", ...mode], {
          cwd: directory,
          timeout: 180000,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            CARGO_PROFILE_DEV_DEBUG: "0",
            CARGO_INCREMENTAL: "0",
            CARGO_BUILD_JOBS: "1",
          },
        });
        const logs = result.stderr
          .split("\n")
          .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
          .map((line) => JSON.parse(line).message);
        expect(logs).toEqual(expectedLogs);
        expect(result.stdout).toContain("queue-generated-ok");
        process.stdout.write(
          `Queue generated ${mode.length ? "release" : "debug"}: ${result.stdout.trim()}\n`,
        );
      }
      const continuation = "self.pump_with_waker(event.task, waker);";
      expect(emitted.files["src/lib.rs"]!.split(continuation)).toHaveLength(2);
      await writeFile(
        join(directory, "src/lib.rs"),
        emitted.files["src/lib.rs"]!.replace(
          continuation,
          "/* mutation: lost producer continuation */",
        ),
      );
      let failure: unknown;
      try {
        await run("cargo", ["run", "--offline", "--quiet"], {
          cwd: directory,
          timeout: 180000,
          maxBuffer: 8 * 1024 * 1024,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        stderr: expect.stringContaining("Generated Queue must settle"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(360000),
);
