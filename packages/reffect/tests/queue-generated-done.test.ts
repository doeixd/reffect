import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Cause, Context, Effect, Exit, Logger, Scheduler } from "effect";
import { expect, test } from "vite-plus/test";
import { FailureFrames, R, Rust, SourceArtifacts } from "../src/index.ts";
import { PrivateEffectReference } from "../src/effect-ir.ts";
import type { Computation } from "../src/effect-ir.ts";
import { DeferredInterruptionFrames } from "../src/deferred-interruption-frames.ts";
import { QueueIR as Q } from "../src/queue.ts";
import { Expr, Operation, SemanticRef } from "../src/kernel.ts";
import { QueueDoneType } from "../src/queue-model.ts";
import {
  analyzeGeneratedQueueDoneProfile,
  analyzeGeneratedQueueProfile,
} from "../src/queue-generated-profile.ts";
import {
  emitFunctions,
  lowerFunctions,
  lowerQueueDoneFunctions,
  lowerQueueFunctions,
} from "../src/lower.ts";
import { QueueExecution } from "../src/queue-execution.ts";

const selected = new Map(Rust.std.implementations.map((item) => [item.operation.ref, item]));
const all = (a: Computation<void>, b: Computation<void>) =>
  R.Effect.all([a, b], { concurrency: "unbounded", discard: true });
const seq = (...steps: Computation<void>[]) =>
  steps.reduce((body, next) => body.pipe(R.Effect.andThen(next)), R.Effect.void);
const empty = (logging: boolean) =>
  R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.U64, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        all(
          Q.take(owner).pipe(
            R.Effect.asVoid,
            R.Effect.catch(() => (logging ? R.Log.info("recovered") : R.Effect.void)),
          ),
          Q.end(owner).pipe(R.Effect.andThen(logging ? R.Log.info("ended") : R.Effect.void)),
        ),
      ),
    ),
  );
const functions = {
  empty: empty(true),
  drain: R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.U64, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        all(
          seq(
            Q.offer(owner, R.U64.literal(7n)).pipe(R.Effect.asVoid),
            Q.end(owner).pipe(R.Effect.andThen(R.Log.info("drain-ended"))),
          ),
          Q.take(owner).pipe(
            R.Effect.catch(() => R.Effect.succeed(R.U64.literal(99n))),
            R.Effect.flatMap((value) =>
              R.Match.bool(
                R.U64.eq(value, R.U64.literal(7n)),
                R.Log.info("value:7"),
                R.Log.info("wrong-value"),
              ),
            ),
            R.Effect.andThen(
              Q.take(owner).pipe(
                R.Effect.asVoid,
                R.Effect.catch(() => R.Log.info("drain-recovered")),
              ),
            ),
          ),
        ),
      ),
    ),
  ),
  nested: R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        all(
          Q.take(owner).pipe(
            R.Effect.catch(() =>
              Q.take(owner).pipe(R.Effect.catch(() => R.Log.info("nested-recovered"))),
            ),
          ),
          Q.end(owner).pipe(R.Effect.andThen(R.Log.info("nested-ended"))),
        ),
      ),
    ),
  ),
  closed: R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Bool, 3, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        all(
          Q.take(owner).pipe(
            R.Effect.asVoid,
            R.Effect.catch(() =>
              Q.offer(owner, R.Bool.literal(true)).pipe(
                R.Effect.flatMap((value) =>
                  R.Match.bool(value, R.Log.info("wrong-offer"), R.Log.info("closed-offer")),
                ),
              ),
            ),
          ),
          Q.end(owner).pipe(
            R.Effect.andThen(Q.end(owner)),
            R.Effect.flatMap((value) =>
              R.Match.bool(value, R.Log.info("wrong-end"), R.Log.info("repeat-end")),
            ),
          ),
        ),
      ),
    ),
  ),
  boolean: R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Bool, 2, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        all(
          Q.offer(owner, R.Bool.literal(true)).pipe(
            R.Effect.andThen(Q.end(owner)),
            R.Effect.asVoid,
          ),
          Q.take(owner).pipe(
            R.Effect.catch(() => R.Effect.succeed(R.Bool.literal(false))),
            R.Effect.flatMap((value) =>
              R.Match.bool(value, R.Log.info("value:true"), R.Log.info("wrong-bool")),
            ),
            R.Effect.andThen(
              Q.take(owner).pipe(
                R.Effect.catch(() => R.Effect.succeed(R.Bool.literal(true))),
                R.Effect.flatMap((value) =>
                  R.Match.bool(
                    value,
                    R.Log.info("bool-recovered:true"),
                    R.Log.info("wrong-bool-recovery"),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  ),
  blocked: R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        all(
          Q.take(owner).pipe(R.Effect.catch(() => R.Log.info("wrong-interrupt-recovery"))),
          R.Effect.void,
        ),
      ),
    ),
  ),
  quiet: empty(false),
  plain: R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1).pipe(
      R.Effect.flatMap((owner) =>
        all(R.Queue.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid), R.Queue.take(owner)),
      ),
    ),
  ),
};
const mixed = {
  ...functions,
  ordinary: R.fn([], R.Unit, R.U64, () =>
    R.Effect.all([R.Effect.fail(R.U64.literal(7n)).pipe(R.Effect.asVoid), R.Effect.sleep(1)], {
      concurrency: "unbounded",
      discard: true,
    }),
  ),
  deferred: R.fn([], R.Unit, R.Never, () =>
    R.Deferred.make(R.Unit).pipe(
      R.Effect.flatMap((cell) =>
        all(
          R.Deferred.succeed(cell, R.Unit.literal()).pipe(R.Effect.asVoid),
          R.Deferred.await(cell),
        ),
      ),
    ),
  ),
};
const observe = async (name: keyof typeof functions, framed: boolean, cancelled = false) => {
  const fn = functions[name];
  const logs: string[] = [];
  const context = Context.empty().pipe(
    Context.add(Scheduler.Scheduler, new Scheduler.MixedScheduler()),
    Context.add(Scheduler.MaxOpsBeforeYield, 2048),
    Context.add(Scheduler.PreventSchedulerYield, false),
    Context.add(
      Logger.CurrentLoggers,
      new Set([Logger.make((event) => logs.push(String(event.message)))]),
    ),
  );
  const controller = new AbortController();
  const frames = new DeferredInterruptionFrames();
  const pending = framed
    ? Effect.runPromiseExitWith(context)(
        PrivateEffectReference.runWithFramesUnknown(
          fn,
          [],
          `functions.${name}.body`,
          () => {
            frames.claim();
            frames.prepare(fn.body, `functions.${name}.body`);
            return [];
          },
          frames.root(`functions.${name}.body`),
        ).pipe(Effect.map((value) => value.exit)),
        { signal: controller.signal },
      )
    : Effect.runPromiseExitWith(context)(
        PrivateEffectReference.runUnknown(fn, [], () => []).pipe(Effect.exit),
        { signal: controller.signal },
      );
  if (cancelled) controller.abort();
  const outer = await pending;
  const inner = Exit.isSuccess(outer) ? outer.value : outer;
  if (cancelled) expect(Exit.isFailure(inner) && Cause.hasInterruptsOnly(inner.cause)).toBe(true);
  else {
    if (Exit.isFailure(outer))
      throw new Error(`${name}/${framed}: ${String(Cause.squash(outer.cause))}`);
    expect(Exit.isSuccess(inner)).toBe(true);
  }
  return { logs, frames: frames.snapshot() };
};

test("Done selection is private, child-local, canonical and End-only", async () => {
  const profile = analyzeGeneratedQueueDoneProfile(R.program(mixed));
  expect(profile.get(functions.empty)?.completion).toBe("End");
  expect(profile.get(functions.plain)?.completion).toBe("None");
  for (const lower of [lowerFunctions, lowerQueueFunctions])
    expect(() => lower(R.program({ empty: functions.empty }), selected)).toThrow();
  expect(() => analyzeGeneratedQueueProfile(R.program({ empty: functions.empty }))).toThrow();
  expect(Exit.isFailure((await QueueExecution.run(functions.empty)).exit)).toBe(true);
  const escaping = R.fn([], R.Unit, QueueDoneType, () =>
    Q.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        R.Effect.all([Q.end(owner).pipe(R.Effect.asVoid), Q.take(owner)], {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    ),
  );
  const shutdown = R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        all(
          Q.shutdown(owner).pipe(R.Effect.asVoid),
          Q.take(owner).pipe(R.Effect.catch(() => R.Effect.void)),
        ),
      ),
    ),
  );
  const consumed = R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        all(
          Q.end(owner).pipe(R.Effect.asVoid),
          Q.take(owner).pipe(
            R.Effect.catch((done) => R.Effect.succeed(done).pipe(R.Effect.asVoid)),
          ),
        ),
      ),
    ),
  );
  const hidden = Operation.make(
    SemanticRef.operation("test/private-done-hidden-input"),
    [QueueDoneType],
    R.Bool,
    () => {
      throw new Error("must not run");
    },
  );
  // @ts-expect-error forged operation retains a forbidden signature despite omitted operands
  const hiddenExpression = Expr.apply(hidden);
  const hiddenFn = R.fn([], R.Bool, () => hiddenExpression);
  expect(() => lowerQueueDoneFunctions(R.program({ ...mixed, hiddenFn }), selected)).toThrow();
  for (const fn of [escaping, shutdown, consumed])
    expect(() => lowerQueueDoneFunctions(R.program({ work: fn }), selected)).toThrow();
});

const allocator = String.raw`
use std::sync::atomic::{AtomicBool,AtomicUsize,AtomicIsize,Ordering};
struct Allocator;static TRACK:AtomicBool=AtomicBool::new(false);static ALLOCATIONS:AtomicUsize=AtomicUsize::new(0);static LIVE:AtomicIsize=AtomicIsize::new(0);
unsafe impl std::alloc::GlobalAlloc for Allocator {
 unsafe fn alloc(&self,l:std::alloc::Layout)->*mut u8{if TRACK.load(Ordering::Relaxed){ALLOCATIONS.fetch_add(1,Ordering::Relaxed);LIVE.fetch_add(1,Ordering::Relaxed);}unsafe{std::alloc::System.alloc(l)}}
 unsafe fn dealloc(&self,p:*mut u8,l:std::alloc::Layout){if TRACK.load(Ordering::Relaxed){LIVE.fetch_sub(1,Ordering::Relaxed);}unsafe{std::alloc::System.dealloc(p,l)}}
 unsafe fn realloc(&self,p:*mut u8,l:std::alloc::Layout,n:usize)->*mut u8{if TRACK.load(Ordering::Relaxed){ALLOCATIONS.fetch_add(1,Ordering::Relaxed);}unsafe{std::alloc::System.realloc(p,l,n)}}
}
#[global_allocator]static ALLOCATOR:Allocator=Allocator;
fn begin(){LIVE.store(0,Ordering::Relaxed);ALLOCATIONS.store(0,Ordering::Relaxed);TRACK.store(true,Ordering::Relaxed);}
fn end()->usize{TRACK.store(false,Ordering::Relaxed);ALLOCATIONS.load(Ordering::Relaxed)}
async fn once<F:std::future::Future>(mut f:std::pin::Pin<&mut F>){std::future::poll_fn(|cx|{assert!(f.as_mut().poll(cx).is_pending());std::task::Poll::Ready(())}).await;}
`;
const harness = (framed: boolean) => `use reffect_generated as r;\n${allocator}
#[tokio::main(flavor="current_thread")]
async fn main(){
 let(_parent,receiver)=tokio::sync::watch::channel(false);let mut ctx=r::AsyncContext::new(receiver);
 ${["empty", "drain", "nested", "closed", "boolean", "quiet", "plain", "deferred"].map((name) => `assert!(r::r_${name}(&mut ctx).await.is_ok());`).join("\n")}
 ${framed ? 'assert!(ctx.take_frames().0.is_empty(),"Handled Done frames must disappear");' : ""}
 let layouts=r::reffect_queue_future_layouts(&mut ctx);assert!(layouts.iter().all(|bytes|*bytes<=20480));
 begin();for _ in 0..100{let f=r::r_quiet(&mut ctx);std::hint::black_box(&f);drop(f);}let construction=end();
 begin();for _ in 0..100{assert!(r::r_quiet(&mut ctx).await.is_ok());}let execution=end();assert_eq!(LIVE.load(Ordering::Relaxed),0,"Handled Done trails must be released");
 assert_eq!(construction,0);assert_eq!(execution,${framed ? 100 : 0},"Quiet recovered Done allocation cost");
 ${framed ? 'assert!(ctx.take_frames().0.is_empty(),"Quiet handled frames must disappear");' : ""}
 let(sender,receiver)=tokio::sync::watch::channel(false);let mut blocked=r::AsyncContext::new(receiver);
 {let f=r::r_blocked(&mut blocked);tokio::pin!(f);once(f.as_mut()).await;sender.send(true).unwrap();assert!(matches!(f.await,Err(r::AsyncError::Interrupted)));}
 ${framed ? 'let(frames,omitted)=blocked.take_frames();assert_eq!(omitted,0);assert_eq!(frames.len(),3);for(frame,kind)in frames.iter().zip(["all","queueScope","function"]){assert!(frame.contains(&format!("\\\"kind\\\":\\\"{}\\\"",kind)));}assert!(blocked.take_frames().0.is_empty());' : ""}
 println!("COST construction={} execution={} layouts={:?}",construction,execution,layouts);println!("queue-done-generated-ok");
}
`;

test("private generated Done agrees with official traces, frame reset and native costs", async () => {
  const expectedLogs: string[] = [];
  for (const name of ["empty", "drain", "nested", "closed", "boolean", "quiet", "plain"] as const) {
    const plain = await observe(name, false);
    const framed = await observe(name, true);
    expect(framed.logs).toEqual(plain.logs);
    expect(framed.frames.frames).toEqual([]);
    expectedLogs.push(...plain.logs);
  }
  expect(expectedLogs.slice(0, 2)).toEqual(["recovered", "ended"]);
  for (const framed of [false, true])
    expect((await observe("blocked", framed, true)).logs).toEqual([]);
  const directory = await mkdtemp(join(tmpdir(), "reffect-queue-done-generated-"));
  const run = promisify(execFile);
  try {
    for (const artifacts of [SourceArtifacts.None, SourceArtifacts.Full])
      for (const frames of [FailureFrames.None, FailureFrames.Bounded]) {
        const emitted = emitFunctions(
          lowerQueueDoneFunctions(R.program(mixed), selected, artifacts, frames),
        );
        expect(Buffer.byteLength(emitted.files["src/lib.rs"]!)).toBeLessThanOrEqual(2097152);
        expect(emitted.files["src/lib.rs"]).not.toContain("__reffect_queue_done_unit");
        if (SourceArtifacts.isNone(artifacts)) expect(emitted.ranges).toEqual([]);
        else expect(emitted.ranges.length).toBeGreaterThan(0);
        for (const [path, text] of Object.entries(emitted.files)) {
          await mkdir(dirname(join(directory, path)), { recursive: true });
          await writeFile(join(directory, path), text);
        }
        await writeFile(
          join(directory, "src/main.rs"),
          `#![recursion_limit = "256"]\n${harness(!FailureFrames.isNone(frames))}`,
        );
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
          expect(result.stdout).toContain("queue-done-generated-ok");
          process.stdout.write(
            `Queue Done ${artifacts._tag}/${frames._tag}/${mode.length ? "release" : "debug"}: ${result.stdout.trim()}\n`,
          );
        }
      }
    const source = emitFunctions(
      lowerQueueDoneFunctions(
        R.program(mixed),
        selected,
        SourceArtifacts.None,
        FailureFrames.Bounded,
      ),
    ).files["src/lib.rs"]!;
    const mutations = [
      [
        source.replaceAll(
          "Err(QueueTakeFailure::Done(done)) => Err((AsyncError::Fail(done),",
          "Err(QueueTakeFailure::Done(done)) => Err((AsyncError::Interrupted,",
        ),
        "r::r_empty",
      ],
      [
        source.replaceAll("drop(handled_frames);", "std::mem::forget(handled_frames);"),
        "Handled Done trails must be released",
      ],
    ] as const;
    for (const [mutated, reason] of mutations) {
      expect(mutated).not.toBe(source);
      await writeFile(join(directory, "src/lib.rs"), mutated);
      await writeFile(
        join(directory, "src/main.rs"),
        `#![recursion_limit = "256"]\n${harness(true)}`,
      );
      await expect(
        run("cargo", ["run", "--offline", "--quiet"], {
          cwd: directory,
          timeout: 180000,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            CARGO_PROFILE_DEV_DEBUG: "0",
            CARGO_INCREMENTAL: "0",
            CARGO_BUILD_JOBS: "1",
          },
        }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining(reason) });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 300000);
