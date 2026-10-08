import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Cause, Context, Effect, Exit, Logger, Scheduler } from "effect";
import { expect, test } from "vite-plus/test";
import { FailureFrames, R, Rust, SourceArtifacts } from "../src/index.ts";
import { PrivateEffectReference } from "../src/effect-ir.ts";
import type { Computation, EffectFn } from "../src/effect-ir.ts";
import { DeferredInterruptionFrames } from "../src/deferred-interruption-frames.ts";
import { QueueIR as Q } from "../src/queue.ts";
import { QueueDoneType } from "../src/queue-model.ts";
import { analyzeGeneratedQueueFallibleProfile } from "../src/queue-generated-profile.ts";
import {
  emitFunctions,
  lowerQueueDoneFunctions,
  lowerQueueFallibleFunctions,
  lowerQueueFunctions,
} from "../src/lower.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const selected = new Map(Rust.std.implementations.map((item) => [item.operation.ref, item]));
const all = <E, E2>(first: Computation<void, E>, second: Computation<void, E2>) =>
  R.Effect.all([first, second], { concurrency: "unbounded", discard: true });
const ordinary = (logging: boolean, blocked = false) =>
  R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.U64, 1).pipe(
      R.Effect.flatMap((owner) => {
        const take = R.Queue.take(owner).pipe(
          R.Effect.flatMap((value) =>
            logging
              ? R.Match.bool(
                  R.U64.eq(value, R.U64.literal(7n)),
                  R.Log.info("ordinary:7"),
                  R.Log.info("wrong-payload"),
                )
              : R.Effect.void,
          ),
        );
        return all(
          take,
          blocked ? R.Effect.void : R.Queue.offer(owner, R.U64.literal(7n)).pipe(R.Effect.asVoid),
        );
      }),
    ),
  );
const completion = (rootRecovery: boolean, logging: boolean, blocked = false) =>
  R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.U64, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) => {
        const take = Q.take(owner).pipe(R.Effect.asVoid);
        const handler = logging
          ? R.Log.info(rootRecovery ? "all:recovered" : "local:recovered")
          : R.Effect.void;
        const end = blocked
          ? R.Effect.void
          : Q.end(owner).pipe(
              R.Effect.andThen(
                logging ? R.Log.info(rootRecovery ? "all:ended" : "local:ended") : R.Effect.void,
              ),
              R.Effect.asVoid,
            );
        return rootRecovery
          ? all(take, end).pipe(R.Effect.catch(() => handler))
          : all(take.pipe(R.Effect.catch(() => handler)), end);
      }),
    ),
  );
const plain = {
  ordinary: ordinary(true),
  ordinary_quiet: ordinary(false),
  ordinary_blocked: ordinary(false, true),
};
const local = {
  local: completion(false, true),
  local_quiet: completion(false, false),
  local_blocked: completion(false, false, true),
};
const fallible = {
  fallible: completion(true, true),
  fallible_quiet: completion(true, false),
  fallible_blocked: completion(true, false, true),
};
const functions = { ...plain, ...local, ...fallible };
const observe = async (name: string, fn: EffectFn, framed: boolean, cancelled = false) => {
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
  const frames = new DeferredInterruptionFrames();
  const checker = () => {
    expect(analyzeGeneratedQueueFallibleProfile(R.program({ [name]: fn })).size).toBe(1);
    return [];
  };
  const controller = new AbortController();
  const pending = framed
    ? Effect.runPromiseExitWith(context)(
        PrivateEffectReference.runWithFramesUnknown(
          fn,
          [],
          `functions.${name}.body`,
          () => {
            checker();
            frames.claim();
            frames.prepare(fn.body, `functions.${name}.body`);
            return [];
          },
          frames.root(`functions.${name}.body`),
        ).pipe(Effect.map((result) => result.exit)),
        { signal: controller.signal },
      )
    : Effect.runPromiseExitWith(context)(
        PrivateEffectReference.runUnknown(fn, [], checker).pipe(Effect.exit),
        { signal: controller.signal },
      );
  if (cancelled) controller.abort();
  const outer = await pending;
  const exit = Exit.isSuccess(outer) ? outer.value : outer;
  expect(
    cancelled ? Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) : Exit.isSuccess(exit),
  ).toBe(true);
  return { logs, frames: frames.snapshot().frames.map(({ path, kind }) => ({ path, kind })) };
};
const allocator = String.raw`
use std::sync::atomic::{AtomicBool,AtomicUsize,AtomicIsize,Ordering};
struct Allocator;static TRACK:AtomicBool=AtomicBool::new(false);static ALLOCATIONS:AtomicUsize=AtomicUsize::new(0);static LIVE:AtomicIsize=AtomicIsize::new(0);
unsafe impl std::alloc::GlobalAlloc for Allocator{
 unsafe fn alloc(&self,l:std::alloc::Layout)->*mut u8{if TRACK.load(Ordering::Relaxed){ALLOCATIONS.fetch_add(1,Ordering::Relaxed);LIVE.fetch_add(1,Ordering::Relaxed);}std::alloc::System.alloc(l)}
 unsafe fn dealloc(&self,p:*mut u8,l:std::alloc::Layout){if TRACK.load(Ordering::Relaxed){LIVE.fetch_sub(1,Ordering::Relaxed);}std::alloc::System.dealloc(p,l)}
}
#[global_allocator]static ALLOCATOR:Allocator=Allocator;
fn begin(){LIVE.store(0,Ordering::Relaxed);ALLOCATIONS.store(0,Ordering::Relaxed);TRACK.store(true,Ordering::Relaxed);}
fn end()->usize{TRACK.store(false,Ordering::Relaxed);ALLOCATIONS.load(Ordering::Relaxed)}
async fn once<F:std::future::Future>(mut f:std::pin::Pin<&mut F>){std::future::poll_fn(|cx|{assert!(f.as_mut().poll(cx).is_pending());std::task::Poll::Ready(())}).await;}
`;
const harness = (framed: boolean) => `use reffect_generated as r;\n${allocator}
#[tokio::main(flavor="current_thread")]
async fn main(){
 let(_tx,rx)=tokio::sync::watch::channel(false);let mut ctx=r::AsyncContext::new(rx);
 assert!(r::r_ordinary(&mut ctx).await.is_ok());assert!(r::r_local(&mut ctx).await.is_ok());assert!(r::r_fallible(&mut ctx).await.is_ok());
 let mixed=r::reffect_queue_future_layouts(&mut ctx);
 let(_tx,rx)=tokio::sync::watch::channel(false);let mut p=r::plain::AsyncContext::new(rx);
 let(_tx,rx)=tokio::sync::watch::channel(false);let mut l=r::local::AsyncContext::new(rx);
 let(_tx,rx)=tokio::sync::watch::channel(false);let mut a=r::fallible::AsyncContext::new(rx);
 let separate=[r::plain::reffect_queue_future_layouts(&mut p),r::local::reffect_queue_future_layouts(&mut l),r::fallible::reffect_queue_future_layouts(&mut a)].concat();
 assert_eq!(mixed.as_slice(),separate.as_slice(),"Coexports preserve actual returned root layouts");assert!(mixed.iter().all(|bytes|*bytes<=20480));assert_eq!(r::driver_layouts(),[72,80]);
 assert!(r::plain::r_ordinary(&mut p).await.is_ok());assert!(r::local::r_local(&mut l).await.is_ok());assert!(r::fallible::r_fallible(&mut a).await.is_ok());
 ${["ordinary", "local", "fallible"].map((name) => `begin();for _ in 0..100{let f=r::r_${name}_quiet(&mut ctx);std::hint::black_box(&f);drop(f);}assert_eq!(end(),0,"${name} construction");assert!(r::r_${name}_quiet(&mut ctx).await.is_ok());begin();for _ in 0..100{assert!(r::r_${name}_quiet(&mut ctx).await.is_ok());}let count=end();assert_eq!(count,${name === "ordinary" || !framed ? 0 : 100},"${name} execution");assert_eq!(LIVE.load(Ordering::Relaxed),0,"${name} releases handled trails");println!("COST ${name}={count}");`).join("\n")}
 ${framed ? 'assert!(ctx.take_frames().0.is_empty(),"Handled failures clear invocation trails");' : ""}
 ${["ordinary", "local", "fallible"].map((name) => `{let(tx,rx)=tokio::sync::watch::channel(false);let mut blocked=r::AsyncContext::new(rx);{let f=r::r_${name}_blocked(&mut blocked);tokio::pin!(f);once(f.as_mut()).await;tx.send(true).unwrap();${name === "fallible" ? 'match f.await{Err(r::AsyncError::Combined(cause))=>assert!(cause.interrupted&&cause.first().is_none()),_=>panic!("Fallible cancellation bypasses recovery")}' : "assert!(matches!(f.await,Err(r::AsyncError::Interrupted)));"}}${framed ? `let(frames,omitted)=blocked.take_frames();assert_eq!(omitted,0);for frame in frames{println!("FRAME ${name}:{}",frame);}assert!(blocked.take_frames().0.is_empty());` : ""}}`).join("\n")}
 println!("LAYOUT {mixed:?}");println!("queue-coexist-ok");
}
`;

// These helpers are compiled inside the generated library, where private runtime receipts are visible.
const layouts = `
pub fn driver_layouts()->[usize;2]{[
 std::mem::size_of::<QueueDriver<'static,u64,1,std::future::Ready<()>,std::future::Ready<()>>>(),
 std::mem::size_of::<FallibleQueueDriver<'static,u64,1,std::future::Ready<Result<(),QueueTakeFailure>>,std::future::Ready<Result<(),QueueTakeFailure>>>>()
]}
`;

test("Queue single-family emission stays identical through the mixed selector", () => {
  for (const artifacts of [SourceArtifacts.None, SourceArtifacts.Full])
    for (const frames of [FailureFrames.None, FailureFrames.Bounded])
      for (const [functions, lower] of [
        [plain, lowerQueueFunctions],
        [local, lowerQueueDoneFunctions],
      ] as const) {
        const old = emitFunctions(lower(R.program(functions), selected, artifacts, frames));
        const next = emitFunctions(
          lowerQueueFallibleFunctions(R.program(functions), selected, artifacts, frames),
        );
        expect(next).toEqual(old);
      }
  for (const lower of [lowerQueueFunctions, lowerQueueDoneFunctions])
    expect(() => lower(R.program(functions), selected)).toThrow();
});

test(
  "mixed Queue families preserve official traces, layouts, cancellation and costs",
  async () => {
    const expectedLogs: string[] = [];
    const expectedFrames = new Map<string, readonly { path: string; kind: string }[]>();
    for (const name of ["ordinary", "local", "fallible"] as const) {
      const plain = await observe(name, functions[name], false);
      const framed = await observe(name, functions[name], true);
      expect(framed.logs).toEqual(plain.logs);
      expect(framed.frames).toEqual([]);
      expectedLogs.push(...plain.logs);
      const blockedName = `${name}_blocked` as const;
      expect((await observe(blockedName, functions[blockedName], false, true)).logs).toEqual([]);
      const blocked = await observe(blockedName, functions[blockedName], true, true);
      expect(blocked.logs).toEqual([]);
      expectedFrames.set(name, blocked.frames);
    }
    const directory = await mkdtemp(join(tmpdir(), "reffect-queue-coexist-"));
    const run = promisify(execFile);
    const execute = (release = false, check = false) =>
      run(
        "cargo",
        [check ? "check" : "run", "--offline", "--quiet", ...(release ? ["--release"] : [])],
        {
          cwd: directory,
          timeout: 180000,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            CARGO_PROFILE_DEV_DEBUG: "0",
            CARGO_INCREMENTAL: "0",
            CARGO_BUILD_JOBS: "1",
          },
        },
      );
    try {
      for (const artifacts of [SourceArtifacts.None, SourceArtifacts.Full])
        for (const frames of [FailureFrames.None, FailureFrames.Bounded]) {
          const emitted = emitFunctions(
            lowerQueueFallibleFunctions(R.program(functions), selected, artifacts, frames),
          );
          const source = emitted.files["src/lib.rs"]!;
          expect(Buffer.byteLength(source)).toBeLessThanOrEqual(2097152);
          expect(source).toContain("struct QueueDriver<");
          expect(source).toContain("struct FallibleQueueDriver<");
          expect(
            SourceArtifacts.isNone(artifacts)
              ? emitted.ranges.length === 0
              : emitted.ranges.length > 0,
          ).toBe(true);
          for (const [path, text] of Object.entries(emitted.files)) {
            await mkdir(dirname(join(directory, path)), { recursive: true });
            await writeFile(join(directory, path), text);
          }
          for (const [name, functions, lower] of [
            ["plain", plain, lowerQueueFunctions],
            ["local", local, lowerQueueDoneFunctions],
            ["fallible", fallible, lowerQueueFallibleFunctions],
          ] as const) {
            const separate = emitFunctions(
              lower(R.program(functions), selected, artifacts, frames),
            );
            // Module embedding changes only the crate-level rustc recursion allowance.
            await writeFile(
              join(directory, `src/${name}.rs`),
              separate.files["src/lib.rs"]!.replace('#![recursion_limit = "256"]\n\n', ""),
            );
          }
          const library = `${source}\npub mod plain;pub mod local;pub mod fallible;\n${layouts}`;
          await writeFile(join(directory, "src/lib.rs"), library);
          await writeFile(join(directory, "src/main.rs"), harness(!FailureFrames.isNone(frames)));
          for (const release of [false, true]) {
            const result = await execute(release);
            const logs = result.stderr
              .split("\n")
              .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
              .map((line) => JSON.parse(line).message);
            expect(logs).toEqual(expectedLogs.concat(expectedLogs));
            for (const name of ["ordinary", "local", "fallible"]) {
              const actual = result.stdout
                .split("\n")
                .filter((line) => line.startsWith(`FRAME ${name}:`))
                .map((line) => {
                  const value = JSON.parse(line.slice(`FRAME ${name}:`.length)) as {
                    path: string;
                    kind: string;
                  };
                  return { path: value.path, kind: value.kind };
                });
              expect(actual).toEqual(FailureFrames.isNone(frames) ? [] : expectedFrames.get(name));
            }
            expect(result.stdout).toContain("queue-coexist-ok");
            process.stdout.write(
              `Queue coexist ${artifacts._tag}/${frames._tag}/${release ? "release" : "debug"}: Rust bytes=${Buffer.byteLength(source)} ${result.stdout.trim()}\n`,
            );
          }
          // Sticky-cancellation request families cannot be crossed, even though their scalar payloads agree.
          if (SourceArtifacts.isNone(artifacts) && FailureFrames.isNone(frames)) {
            await writeFile(
              join(directory, "src/lib.rs"),
              `${library}\nfn crossed(task:FallibleQueueTask<'_,u64>){fn ordinary(_:QueueTask<'_,u64>){}ordinary(task);}`,
            );
            await expect(execute(false, true)).rejects.toMatchObject({
              stderr: expect.stringContaining("mismatched types"),
            });
            await writeFile(join(directory, "src/lib.rs"), library);
          }
        }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(1) + 300000,
);
