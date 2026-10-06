import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Cause, Effect, Exit, Fiber, Logger, Scheduler } from "effect";
import { expect, test } from "vite-plus/test";
import { FailureFrames, R, Rust, SourceArtifacts } from "../src/index.ts";
import { LatchIR as L } from "../src/latch.ts";
import { DeferredIR as D } from "../src/deferred.ts";
import { SemaphoreIR as S } from "../src/semaphore.ts";
import { DeferredInterruptionFrames } from "../src/deferred-interruption-frames.ts";
import { PrivateEffectReference } from "../src/effect-ir.ts";
import type { EffectFn } from "../src/effect-ir.ts";
import { emitFunctions, lowerLatchFunctions } from "../src/lower.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const selected = new Map(Rust.std.implementations.map((i) => [i.operation.ref, i]));
const options = { concurrency: "unbounded", discard: true } as const;
const sleep = () => R.Effect.sleep(20);
const scalar = R.fn([], R.U64, R.Never, () =>
  L.make(true).pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.succeed(R.U64.literal(23n)).pipe(
        R.Effect.flatMap((captured) => L.whenOpen(owner, R.Effect.succeed(captured))),
      ),
    ),
  ),
);
const transitions = R.fn([], R.Bool, R.Never, () =>
  L.make().pipe(
    R.Effect.flatMap((owner) =>
      L.open(owner).pipe(
        R.Effect.flatMap((opened) =>
          L.open(owner).pipe(
            R.Effect.andThen(L.close(owner)),
            R.Effect.andThen(L.release(owner)),
            R.Effect.andThen(L.isOpen(owner)),
            R.Effect.flatMap((isOpen) =>
              R.Match.bool(
                isOpen,
                R.Effect.succeed(R.Bool.literal(false)),
                R.Effect.succeed(opened),
              ),
            ),
          ),
        ),
      ),
    ),
  ),
);
const pulse = R.fn([], R.Unit, R.Never, () =>
  L.make().pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.all(
        [
          L.await(owner).pipe(R.Effect.andThen(R.Log.info("pulse:first"))),
          L.await(owner).pipe(R.Effect.andThen(R.Log.info("pulse:second"))),
          R.Log.info("pulse:producer").pipe(
            R.Effect.andThen(L.open(owner)),
            R.Effect.andThen(L.close(owner)),
            R.Effect.asVoid,
          ),
        ],
        options,
      ),
    ),
  ),
);
const reentrant = R.fn([], R.Unit, R.Never, () =>
  L.make().pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.all(
        [
          L.await(owner).pipe(
            R.Effect.andThen(R.Log.info("reentrant:old-first")),
            R.Effect.andThen(L.release(owner)),
            R.Effect.andThen(L.await(owner)),
            R.Effect.andThen(R.Log.info("reentrant:new-first")),
          ),
          L.await(owner).pipe(R.Effect.andThen(R.Log.info("reentrant:old-second"))),
          L.release(owner).pipe(
            R.Effect.andThen(L.await(owner)),
            R.Effect.andThen(R.Log.info("reentrant:new-producer")),
            R.Effect.andThen(L.open(owner)),
            R.Effect.asVoid,
          ),
        ],
        options,
      ),
    ),
  ),
);
const renewed = R.fn([], R.Unit, R.Never, () =>
  L.make().pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.all(
        [
          L.await(owner).pipe(
            R.Effect.andThen(R.Log.info("renewed:first-pulse")),
            R.Effect.andThen(L.await(owner)),
            R.Effect.andThen(R.Log.info("renewed:second-pulse")),
          ),
          L.await(owner).pipe(R.Effect.andThen(R.Log.info("renewed:peer"))),
          L.release(owner).pipe(
            R.Effect.andThen(L.release(owner)),
            R.Effect.andThen(sleep()),
            R.Effect.andThen(R.Log.info("renewed:producer")),
            R.Effect.andThen(L.release(owner)),
            R.Effect.asVoid,
          ),
        ],
        options,
      ),
    ),
  ),
);
const timed = R.fn([], R.Unit, R.Never, () =>
  L.make().pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.all(
        [
          sleep().pipe(
            R.Effect.andThen(R.Log.info("timed:first")),
            R.Effect.andThen(L.release(owner)),
            R.Effect.asVoid,
          ),
          sleep().pipe(R.Effect.andThen(R.Log.info("timed:second"))),
          L.await(owner).pipe(R.Effect.andThen(R.Log.info("timed:waiter"))),
        ],
        options,
      ),
    ),
  ),
);
const blocked = R.fn([], R.Unit, R.Never, () => L.make().pipe(R.Effect.flatMap(L.await)));
const late = R.fn([], R.Unit, R.Never, () =>
  L.make().pipe(
    R.Effect.flatMap((owner) => L.release(owner).pipe(R.Effect.andThen(L.await(owner)))),
  ),
);
const cancelled = R.fn([], R.Unit, R.Never, () =>
  L.make().pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.all(
        [
          L.await(owner).pipe(
            R.Effect.andThen(R.Log.info("cancel:must-not-resume-first")),
            R.Effect.ensuring(
              R.Log.info("cancel:first-start").pipe(
                R.Effect.andThen(sleep()),
                R.Effect.andThen(L.release(owner)),
                R.Effect.andThen(R.Log.info("cancel:first-done")),
              ),
            ),
          ),
          L.await(owner).pipe(
            R.Effect.andThen(R.Log.info("cancel:must-not-resume-second")),
            R.Effect.ensuring(
              R.Log.info("cancel:second-start").pipe(
                R.Effect.andThen(sleep()),
                R.Effect.andThen(L.close(owner)),
                R.Effect.andThen(R.Log.info("cancel:second-done")),
              ),
            ),
          ),
        ],
        options,
      ).pipe(R.Effect.ensuring(L.release(owner).pipe(R.Effect.asVoid))),
    ),
  ),
);
const quiet = R.fn([], R.Unit, R.Never, () =>
  L.make().pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.all([L.await(owner), L.release(owner).pipe(R.Effect.asVoid)], options),
    ),
  ),
);
const ordinary = R.fn([], R.Unit, R.Never, () => R.Effect.sleep(1));
const deferred = R.fn([], R.Unit, R.Never, () =>
  D.make(R.Unit).pipe(
    R.Effect.flatMap((cell) =>
      D.succeed(cell, R.Unit.literal()).pipe(R.Effect.andThen(D.await(cell))),
    ),
  ),
);
const semaphore = R.fn([], R.Unit, R.Never, () =>
  S.make(1).pipe(R.Effect.flatMap((owner) => S.withPermit(owner)(R.Effect.void))),
);
const functions = {
  scalar,
  transitions,
  pulse,
  reentrant,
  renewed,
  timed,
  blocked,
  late,
  cancelled,
  quiet,
  ordinary,
  deferred,
  semaphore,
};

const observe = async (name: string, fn: EffectFn, interrupt = false) => {
  const logs: string[] = [];
  const frames = new DeferredInterruptionFrames();
  frames.claim();
  frames.prepare(fn.body, `functions.${name}.body`);
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const reference = PrivateEffectReference.runWithFramesUnknown(
        fn,
        [],
        `functions.${name}.body`,
        () => [],
        frames.root(`functions.${name}.body`),
      ).pipe(
        Effect.flatMap((result) =>
          Exit.isSuccess(result.exit)
            ? Effect.succeed(result.exit.value)
            : Effect.failCause(result.exit.cause),
        ),
      );
      if (!interrupt) return yield* Effect.exit(reference);
      const fiber = yield* Effect.forkChild(reference, { startImmediately: true });
      yield* Fiber.interrupt(fiber);
      return yield* Fiber.await(fiber);
    }).pipe(
      Effect.provideService(Scheduler.Scheduler, new Scheduler.MixedScheduler()),
      Effect.provideService(Scheduler.MaxOpsBeforeYield, 100000),
      Effect.provideService(
        Logger.CurrentLoggers,
        new Set([Logger.make((entry) => logs.push(String(entry.message)))]),
      ),
    ),
  );
  return { exit, logs, frames: frames.snapshot() };
};
const observeOverdue = async () => {
  const running = observe("timed", timed);
  const until = performance.now() + 60;
  while (performance.now() < until) {
    /* Capture both due callbacks before scheduled cohorts. */
  }
  return running;
};
const execute = promisify(execFile);

test("private official Latch workloads detach cohorts, coalesce pulses and discard child interruption trails", async () => {
  expect((await observe("scalar", scalar)).exit).toEqual(Exit.succeed(23n));
  expect((await observe("transitions", transitions)).exit).toEqual(Exit.succeed(true));
  expect((await observe("pulse", pulse)).logs).toEqual([
    "pulse:producer",
    "pulse:first",
    "pulse:second",
  ]);
  expect((await observe("reentrant", reentrant)).logs).toEqual([
    "reentrant:old-first",
    "reentrant:old-second",
    "reentrant:new-producer",
    "reentrant:new-first",
  ]);
  expect((await observe("renewed", renewed)).logs).toEqual([
    "renewed:first-pulse",
    "renewed:peer",
    "renewed:producer",
    "renewed:second-pulse",
  ]);
  expect((await observeOverdue()).logs).toEqual(["timed:first", "timed:second", "timed:waiter"]);
  for (const [name, fn, kinds] of [
    ["blocked", blocked, ["latchAwait", "latchScope", "function"]],
    ["late", late, ["latchAwait", "flatMap", "latchScope", "function"]],
    ["cancelled", cancelled, ["all", "ensuring", "latchScope", "function"]],
  ] as const) {
    const observed = await observe(name, fn, true);
    expect(Exit.isFailure(observed.exit) && Cause.hasInterruptsOnly(observed.exit.cause)).toBe(
      true,
    );
    expect(observed.frames.frames.map((frame) => frame.kind)).toEqual(kinds);
    expect(observed.logs.some((log) => log.includes("must-not"))).toBe(false);
  }
});

test.each([FailureFrames.None, FailureFrames.Bounded])(
  "private generated Latch roots preserve official cohorts, cleanup, frames and measured invocation costs ($_tag)",
  async (failureFrames) => {
    const observations = await Promise.all([
      observe("pulse", pulse),
      observe("reentrant", reentrant),
      observe("renewed", renewed),
      observe("late", late, true),
      observe("cancelled", cancelled, true),
      observe("blocked", blocked, true),
      observeOverdue(),
    ]);
    const expectedLogs = observations.flatMap((observation) => observation.logs);
    const root = await mkdtemp(join(tmpdir(), "reffect-latch-generated-"));
    try {
      const emitted = emitFunctions(
        lowerLatchFunctions(R.program(functions), selected, SourceArtifacts.None, failureFrames),
      );
      for (const [path, contents] of Object.entries(emitted.files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), contents);
      }
      const frames = (name: "blocked" | "late" | "cancelled", index: number) =>
        FailureFrames.isNone(failureFrames)
          ? ""
          : `
 let (frames,omitted)=ctx.take_frames(); assert_eq!(omitted,0);
 assert_eq!(frames.len(),${observations[index].frames.frames.length});
 ${observations[index].frames.frames.map((frame, i) => `assert!(frames[${i}].contains(${JSON.stringify(`"kind":"${frame.kind}"`)}), "${name} frame kind: {:?}",frames);`).join("\n")}
`;
      await writeFile(
        join(root, "src/main.rs"),
        String.raw`
use reffect_generated as r;
use std::future::Future;
use std::pin::Pin;
use std::task::Poll;
use std::sync::atomic::{AtomicBool,AtomicUsize,Ordering};
struct Counter;
static TRACK:AtomicBool=AtomicBool::new(false);
static ALLOCATIONS:AtomicUsize=AtomicUsize::new(0);
unsafe impl std::alloc::GlobalAlloc for Counter {
 unsafe fn alloc(&self,layout:std::alloc::Layout)->*mut u8 {
  if TRACK.load(Ordering::Relaxed) { ALLOCATIONS.fetch_add(1,Ordering::Relaxed); }
  unsafe { std::alloc::System.alloc(layout) }
 }
 unsafe fn dealloc(&self,ptr:*mut u8,layout:std::alloc::Layout) { unsafe { std::alloc::System.dealloc(ptr,layout) } }
 unsafe fn realloc(&self,ptr:*mut u8,layout:std::alloc::Layout,size:usize)->*mut u8 {
  if TRACK.load(Ordering::Relaxed) { ALLOCATIONS.fetch_add(1,Ordering::Relaxed); }
  unsafe { std::alloc::System.realloc(ptr,layout,size) }
 }
}
#[global_allocator] static ALLOCATOR:Counter=Counter;
async fn once<F:Future>(mut future:Pin<&mut F>) {
 std::future::poll_fn(|cx| { assert!(future.as_mut().poll(cx).is_pending()); Poll::Ready(()) }).await;
}
#[tokio::main(flavor="current_thread")]
async fn main() {
 let (_sender,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 assert_eq!(r::r_scalar(&mut ctx).await.unwrap(),23);
 assert!(r::r_transitions(&mut ctx).await.unwrap());
 assert!(r::r_pulse(&mut ctx).await.is_ok());
 assert!(r::r_reentrant(&mut ctx).await.is_ok());
 { let future=r::r_renewed(&mut ctx); tokio::pin!(future); once(future.as_mut()).await;
   tokio::time::sleep(std::time::Duration::from_millis(60)).await; assert!(future.await.is_ok()); }
 let (cancel,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 { let future=r::r_late(&mut ctx); tokio::pin!(future); once(future.as_mut()).await;
   cancel.send(true).unwrap(); assert!(matches!(future.await,Err(r::AsyncError::Interrupted))); }
${frames("late", 3)}
 let (cancel,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 { let future=r::r_cancelled(&mut ctx); tokio::pin!(future); once(future.as_mut()).await;
   cancel.send(true).unwrap(); once(future.as_mut()).await;
   tokio::time::sleep(std::time::Duration::from_millis(60)).await;
   assert!(matches!(future.await,Err(r::AsyncError::Interrupted))); }
${frames("cancelled", 4)}
 let (cancel,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 { let future=r::r_blocked(&mut ctx); tokio::pin!(future); once(future.as_mut()).await;
   cancel.send(true).unwrap(); assert!(matches!(future.await,Err(r::AsyncError::Interrupted))); }
${frames("blocked", 5)}
 let (_sender,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 { let future=r::r_timed(&mut ctx); tokio::pin!(future); once(future.as_mut()).await;
   tokio::time::sleep(std::time::Duration::from_millis(60)).await; assert!(future.await.is_ok()); }
 let (_sender,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 assert!(r::r_quiet(&mut ctx).await.is_ok());
 assert!(r::r_ordinary(&mut ctx).await.is_ok());
 assert!(r::r_deferred(&mut ctx).await.is_ok());
 assert!(r::r_semaphore(&mut ctx).await.is_ok());
 let scalar_layout={let future=r::r_scalar(&mut ctx); std::mem::size_of_val(&future)};
 let quiet_layout={let future=r::r_quiet(&mut ctx); std::mem::size_of_val(&future)};
 let cancel_layout={let future=r::r_cancelled(&mut ctx); std::mem::size_of_val(&future)};
 let layouts=[scalar_layout,quiet_layout,cancel_layout];
 assert!(layouts.iter().all(|bytes| *bytes>0 && *bytes<=2560*std::mem::size_of::<usize>()));
 ALLOCATIONS.store(0,Ordering::Relaxed); TRACK.store(true,Ordering::Relaxed);
 for _ in 0..1000 { let future=r::r_quiet(&mut ctx); std::hint::black_box(&future); drop(future); }
 TRACK.store(false,Ordering::Relaxed); let construction=ALLOCATIONS.load(Ordering::Relaxed);
 ALLOCATIONS.store(0,Ordering::Relaxed); TRACK.store(true,Ordering::Relaxed);
 for _ in 0..1000 { assert_eq!(r::r_scalar(&mut ctx).await.unwrap(),23); }
 TRACK.store(false,Ordering::Relaxed); let scalar=ALLOCATIONS.load(Ordering::Relaxed);
 ALLOCATIONS.store(0,Ordering::Relaxed); TRACK.store(true,Ordering::Relaxed);
 for _ in 0..1000 { assert!(r::r_quiet(&mut ctx).await.is_ok()); }
 TRACK.store(false,Ordering::Relaxed); let all2=ALLOCATIONS.load(Ordering::Relaxed);
 let (cancel,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 ALLOCATIONS.store(0,Ordering::Relaxed); TRACK.store(true,Ordering::Relaxed);
 { let future=r::r_blocked(&mut ctx); tokio::pin!(future); once(future.as_mut()).await;
   cancel.send(true).unwrap(); assert!(matches!(future.await,Err(r::AsyncError::Interrupted))); }
 TRACK.store(false,Ordering::Relaxed); let cancellation=ALLOCATIONS.load(Ordering::Relaxed);
 println!("construction={} scalar={} all2={} cancellation={} layouts={:?} word={}",construction,scalar,all2,cancellation,layouts,std::mem::size_of::<usize>());
 println!("latch-generated-ok");
}
`,
      );
      for (const mode of [[], ["--release"]]) {
        const result = await execute("cargo", ["run", "--offline", "--quiet", ...mode], {
          cwd: root,
          timeout: 180000,
          env: { ...process.env, CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0" },
        });
        const logs = result.stderr
          .split("\n")
          .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
          .map((line) => JSON.parse(line).message);
        expect(logs).toEqual(expectedLogs);
        expect(result.stdout).toContain("latch-generated-ok");
        const costs = result.stdout.match(
          /construction=(\d+) scalar=(\d+) all2=(\d+) cancellation=(\d+) layouts=\[([\d, ]+)\] word=(\d+)/,
        )!;
        expect(costs).not.toBeNull();
        expect(Number(costs[1])).toBe(0);
        expect(Number(costs[2])).toBe(0);
        // Two owned child-watch channels are expected; this measures the full generated
        // invocation after parent initialization, rather than only adapter-local storage.
        expect(Number(costs[3])).toBe(2000);
        expect(Number(costs[4])).toBe(FailureFrames.isNone(failureFrames) ? 0 : 1);
        process.stdout.write(
          `Latch ${failureFrames._tag} ${mode.length ? "release" : "debug"}: ${result.stdout.trim()}\n`,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  nativeTestBudget(0) * 2,
);
