import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Cause, Context, Effect, Exit, Logger, Scheduler } from "effect";
import { expect, test } from "vite-plus/test";
import {
  Compile,
  FailureFrames,
  QueueDoneType,
  QueueShutdownExecution,
  R,
  Rust,
  SourceArtifacts,
} from "../src/index.ts";
import { Computation, PrivateEffectReference } from "../src/effect-ir.ts";
import type { FailureFramePolicy } from "../src/index.ts";
import type { EffectFn } from "../src/effect-ir.ts";
import type { Expr, IRType } from "../src/kernel.ts";
import { DeferredInterruptionFrames } from "../src/deferred-interruption-frames.ts";
import { analyzeGeneratedQueueShutdownProfile } from "../src/queue-generated-profile.ts";
import { emitFunctions, lowerQueueShutdownFunctions } from "../src/lower.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const group = <A, B>(a: Computation<void, A>, b: Computation<void, B>) =>
  R.Effect.all([a, b], { concurrency: "unbounded", discard: true });
const seq = <E>(...steps: Computation<void, E>[]) =>
  steps.reduce<Computation<void, E>>((a, b) => a.pipe(R.Effect.andThen(b)), R.Effect.void);
const make = <A>(
  name: string,
  type: IRType<A>,
  values: readonly Expr<A>[],
  closing: boolean,
  quiet = false,
) =>
  R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(type, 3, QueueDoneType).pipe(
      R.Effect.flatMap((owner) => {
        const offers = values.map((value) => R.Queue.offer(owner, value).pipe(R.Effect.asVoid));
        const terminal = R.Queue.shutdown(owner).pipe(
          R.Effect.flatMap((value) =>
            quiet
              ? R.Effect.void
              : R.Match.bool(value, R.Log.info(`${name}:true`), R.Log.info(`${name}:false`)),
          ),
        );
        // All offers complete before either terminal. Occupancy is still three at End,
        // so Closing is observed here rather than an already-empty Done queue.
        const child = seq(
          ...offers,
          closing ? R.Queue.end(owner).pipe(R.Effect.asVoid) : R.Effect.void,
          terminal,
          terminal,
          R.Queue.take(owner).pipe(R.Effect.asVoid),
        );
        return group(child, R.Effect.void).pipe(
          R.Effect.catch(() => (quiet ? R.Effect.void : R.Log.info(`${name}:recovered`))),
        );
      }),
    ),
  );
const retainedPeer = R.fn([], R.Unit, R.Never, () =>
  R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
    R.Effect.flatMap((owner) => {
      const prepared = seq(
        R.Queue.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid),
        R.Queue.end(owner).pipe(R.Effect.asVoid),
      ).pipe(
        R.Effect.ensuring(
          seq(
            R.Log.info("retained_peer:start"),
            R.Effect.sleep(20),
            R.Log.info("retained_peer:end"),
          ),
        ),
      );
      const shutdown = R.Queue.shutdown(owner).pipe(
        R.Effect.flatMap((value) =>
          R.Match.bool(value, R.Log.info("retained_peer:true"), R.Log.info("retained_peer:false")),
        ),
      );
      return group(prepared, seq(shutdown, R.Queue.take(owner))).pipe(
        R.Effect.catch(() => R.Log.info("retained_peer:recovered")),
      );
    }),
  ),
);
const functions = {
  retained_peer: retainedPeer,
  open_unit: make(
    "open_unit",
    R.Unit,
    [R.Unit.literal(), R.Unit.literal(), R.Unit.literal()],
    false,
  ),
  closing_unit: make(
    "closing_unit",
    R.Unit,
    [R.Unit.literal(), R.Unit.literal(), R.Unit.literal()],
    true,
  ),
  open_bool: make(
    "open_bool",
    R.Bool,
    [R.Bool.literal(true), R.Bool.literal(false), R.Bool.literal(true)],
    false,
  ),
  closing_bool: make(
    "closing_bool",
    R.Bool,
    [R.Bool.literal(true), R.Bool.literal(false), R.Bool.literal(true)],
    true,
  ),
  open_u64: make(
    "open_u64",
    R.U64,
    [R.U64.literal(1n), R.U64.literal(2n), R.U64.literal(3n)],
    false,
  ),
  closing_u64: make(
    "closing_u64",
    R.U64,
    [R.U64.literal(1n), R.U64.literal(2n), R.U64.literal(3n)],
    true,
  ),
  quiet: make("quiet", R.Unit, [R.Unit.literal(), R.Unit.literal(), R.Unit.literal()], true, true),
};
const ordinaryCases = Object.entries(functions).filter(([name]) => name !== "quiet");
const reference = async (name: string, fn: EffectFn<readonly [], void, never>) => {
  const plain = await QueueShutdownExecution.run(fn);
  const framed = await QueueShutdownExecution.runWithFrames(fn);
  const recovered = name.startsWith("closing_") || name === "retained_peer";
  expect(Exit.isSuccess(plain.exit)).toBe(recovered);
  if (Exit.isFailure(plain.exit)) {
    expect(Cause.hasInterrupts(plain.exit.cause)).toBe(true);
    expect(plain.exit.cause.reasons.filter(Cause.isFailReason)).toEqual([]);
  }
  expect(plain.logs).toEqual(
    name === "retained_peer"
      ? [
          "retained_peer:start",
          "retained_peer:true",
          "retained_peer:end",
          "retained_peer:recovered",
        ]
      : [`${name}:true`, `${name}:false`, ...(recovered ? [`${name}:recovered`] : [])],
  );
  expect(framed.logs).toEqual(plain.logs);
  expect(Exit.isSuccess(framed.exit)).toBe(true);
  if (!Exit.isSuccess(framed.exit)) throw new Error("Missing framed observation");
  expect(Exit.isSuccess(framed.exit.value.exit)).toBe(recovered);
  // Public eager interruption has no returned source frames. Native diagnostics
  // retain the separately recorded enclosing boundaries, as in the old matrix.
  if (!recovered) {
    expect(framed.exit.value.frames).toEqual([]);
    const frames = new DeferredInterruptionFrames();
    const context = Context.empty().pipe(
      Context.add(Scheduler.Scheduler, new Scheduler.MixedScheduler()),
      Context.add(Scheduler.MaxOpsBeforeYield, 2048),
      Context.add(Scheduler.PreventSchedulerYield, false),
      Context.add(Logger.CurrentLoggers, new Set([Logger.make(() => {})])),
    );
    const observed = await Effect.runPromiseExitWith(context)(
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
      ),
    );
    expect(Exit.isSuccess(observed) && Exit.isFailure(observed.value.exit)).toBe(true);
    expect(frames.snapshot().frames.map(({ kind }) => kind)).toEqual([
      "all",
      "catchAll",
      "queueScope",
      "function",
    ]);
    expect(frames.snapshot().omitted).toBe(0);
    return {
      logs: plain.logs,
      frames: frames.snapshot().frames.map(({ path, kind }) => ({ path, kind })),
    };
  }
  expect(framed.exit.value.frames).toEqual([]);
  return { logs: plain.logs, frames: [] };
};
// This adapter deliberately compares native restoration policy separately from
// public recorded-only frames: append recorded root parents to the actual failing
// second child's source prefix, without adding the unrelated first-child Ensuring.
const canceledPeerNativePolicy = async () => {
  const name = "retained_peer";
  const logs: string[] = [];
  const controller = new AbortController();
  const context = Context.empty().pipe(
    Context.add(Scheduler.Scheduler, new Scheduler.MixedScheduler()),
    Context.add(Scheduler.MaxOpsBeforeYield, 2048),
    Context.add(Scheduler.PreventSchedulerYield, false),
    Context.add(
      Logger.CurrentLoggers,
      new Set([
        Logger.make((event) => {
          const message = String(event.message);
          logs.push(message);
          if (message === "retained_peer:start") queueMicrotask(() => controller.abort());
        }),
      ]),
    ),
  );
  const frames = new DeferredInterruptionFrames();
  let settledLogs: readonly string[] = [];
  const outer = await Effect.runPromiseExitWith(context)(
    PrivateEffectReference.runWithFramesUnknown(
      retainedPeer,
      [],
      `functions.${name}.body`,
      () => {
        expect(
          analyzeGeneratedQueueShutdownProfile(R.program({ work: retainedPeer })).has(retainedPeer),
        ).toBe(true);
        frames.claim();
        frames.prepare(retainedPeer.body, `functions.${name}.body`);
        return [];
      },
      frames.root(`functions.${name}.body`),
    ).pipe(
      Effect.onExit(() =>
        Effect.sync(() => {
          settledLogs = [...logs];
        }),
      ),
    ),
    { signal: controller.signal },
  );
  expect(Exit.isFailure(outer)).toBe(true);
  if (!Exit.isFailure(outer)) throw new Error("Cancellation bypasses recovery");
  const projected = PrivateEffectReference.projectFramedCause(outer.cause);
  expect(Cause.hasInterrupts(projected.cause)).toBe(true);
  const failures = projected.cause.reasons.filter(Cause.isFailReason);
  expect(failures).toHaveLength(1);
  expect(Cause.isDone(failures[0]!.error)).toBe(true);
  expect(projected.frames.map((frame) => frame.kind)).toEqual(["queueTake", "flatMap"]);
  const nativeFrames = [...projected.frames, ...frames.snapshot().frames].map(({ path, kind }) => ({
    path,
    kind,
  }));
  expect(nativeFrames.some((frame) => frame.kind === "ensuring")).toBe(false);
  expect(settledLogs).toEqual(["retained_peer:start", "retained_peer:true", "retained_peer:end"]);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(logs).toEqual(settledLogs);
  return { logs: settledLogs, frames: nativeFrames };
};
test("buffered scalar shutdown owns reference observations before native execution", async () => {
  const profiles = analyzeGeneratedQueueShutdownProfile(R.program(functions));
  expect(profiles.size).toBe(Object.keys(functions).length);
  for (const [name, fn] of Object.entries(functions))
    expect(profiles.get(fn)?.shutdownOfferBound).toBe(name === "retained_peer" ? 1 : 3);
  for (const [name, fn] of ordinaryCases) await reference(name, fn);
  await canceledPeerNativePolicy();
});

const allocator = String.raw`
use std::sync::atomic::{AtomicBool,AtomicUsize,AtomicIsize,Ordering};
struct Allocator;static TRACK:AtomicBool=AtomicBool::new(false);static ALLOCATIONS:AtomicUsize=AtomicUsize::new(0);static LIVE:AtomicIsize=AtomicIsize::new(0);
unsafe impl std::alloc::GlobalAlloc for Allocator{unsafe fn alloc(&self,l:std::alloc::Layout)->*mut u8{if TRACK.load(Ordering::Relaxed){ALLOCATIONS.fetch_add(1,Ordering::Relaxed);LIVE.fetch_add(1,Ordering::Relaxed);}std::alloc::System.alloc(l)}unsafe fn dealloc(&self,p:*mut u8,l:std::alloc::Layout){if TRACK.load(Ordering::Relaxed){LIVE.fetch_sub(1,Ordering::Relaxed);}std::alloc::System.dealloc(p,l)}}
#[global_allocator]static ALLOCATOR:Allocator=Allocator;
fn begin(){LIVE.store(0,Ordering::Relaxed);ALLOCATIONS.store(0,Ordering::Relaxed);TRACK.store(true,Ordering::Relaxed);}fn end()->usize{TRACK.store(false,Ordering::Relaxed);ALLOCATIONS.load(Ordering::Relaxed)}
async fn once<F:std::future::Future>(mut f:std::pin::Pin<&mut F>){std::future::poll_fn(|cx|{assert!(f.as_mut().poll(cx).is_pending());std::task::Poll::Ready(())}).await;}
`;
const harness = (framed: boolean) => `use reffect_generated as r;${allocator}
#[tokio::main(flavor="current_thread")]async fn main(){let(_tx,rx)=tokio::sync::watch::channel(false);let mut ctx=r::AsyncContext::new(rx);
${ordinaryCases.map(([name]) => `{let exit=r::r_${name}(&mut ctx).await;${name.startsWith("closing_") || name === "retained_peer" ? `assert!(exit.is_ok(),"Closing Done recovery ${name}");` : `assert!(matches!(exit,Err(r::AsyncError::Combined(cause)) if cause.interrupted && cause.first().is_none()),"Open buffered Shutdown interrupts ${name}");`}${framed ? `let(frames,omitted)=ctx.take_frames();assert_eq!(omitted,0);for frame in frames{println!("FRAME:${name}:{}",frame);}` : ""}}`).join("\n")}
let layouts=r::reffect_queue_future_layouts(&mut ctx);assert!(layouts.iter().all(|size|*size<=20480));
assert!(r::r_quiet(&mut ctx).await.is_ok());${framed ? "let _=ctx.take_frames();" : ""}
begin();for _ in 0..100{let future=r::r_quiet(&mut ctx);std::hint::black_box(&future);drop(future);}let construction=end();assert_eq!(construction,0);
begin();for _ in 0..100{assert!(r::r_quiet(&mut ctx).await.is_ok());${framed ? "let _=ctx.take_frames();" : ""}}let execution=end();assert_eq!(LIVE.load(Ordering::Relaxed),0,"Buffered Shutdown trails released");assert_eq!(execution,${framed ? 100 : 0},"Quiet buffered Shutdown cost");
{let(tx,rx)=tokio::sync::watch::channel(false);let mut ctx=r::AsyncContext::new(rx);{let future=r::r_retained_peer(&mut ctx);tokio::pin!(future);once(future.as_mut()).await;tx.send(true).unwrap();match future.await{Err(r::AsyncError::Combined(cause))=>{assert!(cause.interrupted,"Parent cancellation survives buffered cleanup");assert_eq!(cause.first(),Some(r::RuntimeFailure::QueueDone),"Buffered peer retains Done");},_=>panic!("Cancellation bypasses buffered recovery")}}${framed ? `let(frames,omitted)=ctx.take_frames();assert_eq!(omitted,0);for frame in frames{println!("FRAME:cancel_retained_peer:{}",frame);}assert!(ctx.take_frames().0.is_empty());` : ""}}
println!("COST construction={construction} execution={execution} layouts={layouts:?}");println!("queue-buffered-shutdown-ok");}
`;
const selected = new Map(Rust.std.implementations.map((item) => [item.operation.ref, item]));
const publicArtifact = async (
  program: ReturnType<typeof R.program>,
  artifacts: typeof SourceArtifacts.None | typeof SourceArtifacts.Full,
  frames: FailureFramePolicy,
) => {
  const emitted = await Effect.runPromise(
    Compile.make(program).pipe(
      Compile.withTarget(Rust.tokio),
      Compile.withSourceArtifacts(artifacts),
      Compile.withFailureFrames(frames),
      Compile.run,
    ),
  );
  expect(emitted.files).toEqual(
    emitFunctions(lowerQueueShutdownFunctions(program, selected, artifacts, frames)).files,
  );
  return emitted;
};
test(
  "buffered Shutdown matches pinned Effect across scalar buffers, Closing and quiet costs",
  async () => {
    const expectedLogs: string[] = [];
    const expectedFrames = new Map<string, readonly { path: string; kind: string }[]>();
    for (const [name, fn] of ordinaryCases) {
      const observed = await reference(name, fn);
      expectedLogs.push(...observed.logs);
      expectedFrames.set(name, observed.frames);
    }
    const canceledPeer = await canceledPeerNativePolicy();
    expectedLogs.push(...canceledPeer.logs);
    expectedFrames.set("cancel_retained_peer", canceledPeer.frames);
    const directory = await mkdtemp(join(tmpdir(), "reffect-queue-buffered-shutdown-"));
    const run = promisify(execFile);
    const execute = (release = false) =>
      run("cargo", ["run", "--offline", "--quiet", ...(release ? ["--release"] : [])], {
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
    try {
      for (const artifacts of [SourceArtifacts.None, SourceArtifacts.Full])
        for (const frames of [FailureFrames.None, FailureFrames.Bounded]) {
          const emitted = await publicArtifact(R.program(functions), artifacts, frames);
          expect(Buffer.byteLength(emitted.files["src/lib.rs"]!)).toBeLessThanOrEqual(2097152);
          process.stdout.write(
            `Queue buffered Shutdown ${artifacts._tag}/${frames._tag}: Rust bytes=${Buffer.byteLength(emitted.files["src/lib.rs"]!)}\n`,
          );
          if (SourceArtifacts.isNone(emitted.sourceArtifacts))
            expect("sources" in emitted).toBe(false);
          else expect(emitted.sources?.ranges.length).toBeGreaterThan(0);
          for (const [path, text] of Object.entries(emitted.files)) {
            await mkdir(dirname(join(directory, path)), { recursive: true });
            await writeFile(join(directory, path), text);
          }
          await writeFile(
            join(directory, "src/main.rs"),
            `#![recursion_limit="256"]\n${harness(!FailureFrames.isNone(frames))}`,
          );
          for (const release of [false, true]) {
            const result = await execute(release);
            const logs = result.stderr
              .split("\n")
              .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
              .map((line) => JSON.parse(line).message);
            expect(logs).toEqual(expectedLogs);
            for (const [name, expected] of expectedFrames) {
              const prefix = `FRAME:${name}:`;
              const actual = result.stdout
                .split("\n")
                .filter((line) => line.startsWith(prefix))
                .map((line) => {
                  const { path, kind } = JSON.parse(line.slice(prefix.length)) as {
                    path: string;
                    kind: string;
                  };
                  return { path, kind };
                });
              expect(actual, name).toEqual(FailureFrames.isNone(frames) ? [] : expected);
            }
            expect(result.stdout).toContain("queue-buffered-shutdown-ok");
            process.stdout.write(
              `Queue buffered Shutdown ${artifacts._tag}/${frames._tag}/${release ? "release" : "debug"}: ${result.stdout.trim()}\n`,
            );
          }
        }
      const source = (
        await publicArtifact(R.program(functions), SourceArtifacts.None, FailureFrames.Bounded)
      ).files["src/lib.rs"]!;
      for (const [mutated, reason] of [
        [
          source.replaceAll(".shutdown_exit().await", ".end_exit().await"),
          "Open buffered Shutdown interrupts open_unit",
        ],
        [
          source.replaceAll(
            "Err(QueueTakeFailure::Done(done)) => Err((AsyncError::Fail(done),",
            "Err(QueueTakeFailure::Done(done)) => Err((AsyncError::Interrupted,",
          ),
          "Closing Done recovery retained_peer",
        ],
        [
          source.replaceAll("drop(frames);", "std::mem::forget(frames);"),
          "Buffered Shutdown trails released",
        ],
      ] as const) {
        expect(mutated).not.toBe(source);
        await writeFile(join(directory, "src/lib.rs"), mutated);
        await writeFile(
          join(directory, "src/main.rs"),
          `#![recursion_limit="256"]\n${harness(true)}`,
        );
        await expect(execute()).rejects.toMatchObject({ stderr: expect.stringContaining(reason) });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(3) + 480000,
);
