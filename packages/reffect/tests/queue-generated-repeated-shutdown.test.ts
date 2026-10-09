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

const group = <E, E2>(left: Computation<void, E>, right: Computation<void, E2>) =>
  R.Effect.all([left, right], { concurrency: "unbounded", discard: true });
const seq = <E>(...steps: Computation<void, E>[]) =>
  steps.reduce<Computation<void, E>>((a, b) => a.pipe(R.Effect.andThen(b)), R.Effect.void);
const repeated = <A>(
  name: string,
  type: IRType<A>,
  values: readonly Expr<A>[],
  check: (value: Expr<A>, index: number) => Expr<boolean>,
  closing: boolean,
  nested = false,
  capacity: 1 | 2 | 3 = 1,
) =>
  R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(type, capacity, QueueDoneType).pipe(
      R.Effect.flatMap((owner) => {
        const offers = values.map((value) => R.Queue.offer(owner, value).pipe(R.Effect.asVoid));
        const producer = seq(
          ...offers,
          R.Log.info(`${name}:resumed`),
          nested
            ? seq(
                R.Queue.take(owner).pipe(
                  R.Effect.flatMap((value) =>
                    R.Match.bool(
                      check(value, 3),
                      R.Log.info(`${name}:nested`),
                      R.Log.info("wrong-payload"),
                    ),
                  ),
                ),
                R.Queue.offer(owner, values[0]!).pipe(R.Effect.asVoid),
              )
            : R.Effect.void,
          closing
            ? seq(
                R.Queue.end(owner).pipe(R.Effect.asVoid),
                R.Queue.offer(owner, values[0]!).pipe(
                  R.Effect.flatMap((accepted) =>
                    R.Match.bool(
                      accepted,
                      R.Log.info("wrong-closing-acceptance"),
                      R.Log.info(`${name}:offer_after_end:false`),
                    ),
                  ),
                ),
              )
            : R.Effect.void,
          R.Queue.shutdown(owner).pipe(
            R.Effect.flatMap((value) =>
              R.Match.bool(value, R.Log.info(`${name}:true`), R.Log.info(`${name}:false`)),
            ),
          ),
          R.Queue.take(owner).pipe(R.Effect.asVoid),
        );
        const takes = [0, 1, 2].map((index) =>
          R.Queue.take(owner).pipe(
            R.Effect.flatMap((value) =>
              R.Match.bool(
                check(value, index),
                R.Log.info(`${name}:take${index}`),
                R.Log.info("wrong-payload"),
              ),
            ),
          ),
        );
        return group(producer, seq(...takes)).pipe(
          R.Effect.catch(() => R.Log.info(`${name}:recovered`)),
        );
      }),
    ),
  );
const quiet = R.fn([], R.Unit, R.Never, () =>
  R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
    R.Effect.flatMap((owner) => {
      const offer = () => R.Queue.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid);
      const take = () => R.Queue.take(owner).pipe(R.Effect.asVoid);
      return group(
        seq(offer(), offer(), offer(), offer()),
        seq(
          take(),
          take(),
          take(),
          R.Queue.end(owner).pipe(R.Effect.asVoid),
          R.Queue.shutdown(owner).pipe(R.Effect.asVoid),
          take(),
        ),
      ).pipe(R.Effect.catch(() => R.Effect.void));
    }),
  ),
);
const alternating = R.fn([], R.Unit, R.Never, () =>
  R.Queue.bounded(R.U64, 1, QueueDoneType).pipe(
    R.Effect.flatMap((owner) => {
      const offer = (value: bigint) =>
        R.Queue.offer(owner, R.U64.literal(value)).pipe(R.Effect.asVoid);
      const take = (expected: bigint) =>
        R.Queue.take(owner).pipe(
          R.Effect.flatMap((value) =>
            R.Match.bool(
              R.U64.eq(value, R.U64.literal(expected)),
              R.Log.info(`closing_alternating:take${expected}`),
              R.Log.info("wrong-payload"),
            ),
          ),
        );
      const first = seq(offer(1n), offer(2n), take(2n), take(3n));
      const second = seq(
        take(1n),
        offer(3n),
        offer(4n),
        R.Queue.end(owner).pipe(R.Effect.asVoid),
        R.Queue.shutdown(owner).pipe(
          R.Effect.flatMap((value) =>
            R.Match.bool(
              value,
              R.Log.info("closing_alternating:true"),
              R.Log.info("closing_alternating:false"),
            ),
          ),
        ),
        R.Queue.take(owner).pipe(R.Effect.asVoid),
      );
      return group(first, second).pipe(
        R.Effect.catch(() => R.Log.info("closing_alternating:recovered")),
      );
    }),
  ),
);
const pendingAbort = R.fn([], R.Unit, R.Never, () =>
  R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
    R.Effect.flatMap((owner) => {
      const offer = () => R.Queue.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid);
      const producer = seq(offer(), offer()).pipe(
        R.Effect.ensuring(
          seq(
            R.Log.info("pending_abort:start"),
            R.Effect.sleep(20),
            R.Log.info("pending_abort:end"),
          ),
        ),
      );
      const peer = seq(
        R.Log.info("pending_abort:peer"),
        offer(),
        R.Queue.shutdown(owner).pipe(R.Effect.asVoid),
        R.Queue.take(owner).pipe(R.Effect.asVoid),
      );
      return group(producer, peer).pipe(R.Effect.catch(() => R.Log.info("unexpected-recovery")));
    }),
  ),
);
const unitValues = [R.Unit.literal(), R.Unit.literal(), R.Unit.literal(), R.Unit.literal()];
const boolValues = [
  R.Bool.literal(true),
  R.Bool.literal(false),
  R.Bool.literal(true),
  R.Bool.literal(false),
];
const u64Values = [1n, 2n, 3n, 4n].map((value) => R.U64.literal(value));
const functions = {
  pending_abort: pendingAbort,
  open_cap2: repeated(
    "open_cap2",
    R.Bool,
    [true, false, true, false, true].map((value) => R.Bool.literal(value)),
    (value, index) => (index % 2 === 0 ? value : R.Bool.not(value)),
    false,
    false,
    2,
  ),
  closing_cap3: repeated(
    "closing_cap3",
    R.U64,
    [1n, 2n, 3n, 4n, 5n, 6n].map((value) => R.U64.literal(value)),
    (value, index) => R.U64.eq(value, R.U64.literal(BigInt(index + 1))),
    true,
    false,
    3,
  ),
  open_unit: repeated("open_unit", R.Unit, unitValues, () => R.Bool.literal(true), false),
  closing_unit: repeated("closing_unit", R.Unit, unitValues, () => R.Bool.literal(true), true),
  open_bool: repeated(
    "open_bool",
    R.Bool,
    boolValues,
    (value, index) => (index % 2 === 0 ? value : R.Bool.not(value)),
    false,
  ),
  closing_bool: repeated(
    "closing_bool",
    R.Bool,
    boolValues,
    (value, index) => (index % 2 === 0 ? value : R.Bool.not(value)),
    true,
  ),
  open_u64: repeated(
    "open_u64",
    R.U64,
    u64Values,
    (value, index) => R.U64.eq(value, R.U64.literal(BigInt(index + 1))),
    false,
  ),
  closing_u64: repeated(
    "closing_u64",
    R.U64,
    u64Values,
    (value, index) => R.U64.eq(value, R.U64.literal(BigInt(index + 1))),
    true,
  ),
  closing_nested: repeated(
    "closing_nested",
    R.U64,
    u64Values,
    (value, index) => R.U64.eq(value, R.U64.literal(BigInt(index + 1))),
    true,
    true,
  ),
  closing_alternating: alternating,
  quiet,
};
const ordinaryCases = Object.entries(functions).filter(
  ([name]) => name !== "quiet" && name !== "pending_abort",
);
const reference = async (name: string, fn: EffectFn<readonly [], void, never>) => {
  const plain = await QueueShutdownExecution.run(fn);
  const framed = await QueueShutdownExecution.runWithFrames(fn);
  const recovered = name.startsWith("closing_");
  expect(Exit.isSuccess(plain.exit)).toBe(recovered);
  if (Exit.isFailure(plain.exit)) {
    expect(Cause.hasInterrupts(plain.exit.cause)).toBe(true);
    expect(plain.exit.cause.reasons.filter(Cause.isFailReason)).toEqual([]);
  }
  expect(plain.logs).not.toContain("wrong-payload");
  expect(plain.logs).not.toContain("wrong-closing-acceptance");
  if (recovered && name !== "closing_alternating")
    expect(plain.logs).toContain(`${name}:offer_after_end:false`);
  expect(plain.logs).toContain(`${name}:true`);
  expect(plain.logs.includes(`${name}:recovered`)).toBe(recovered);
  if (name !== "closing_alternating") {
    expect(plain.logs).toContain(`${name}:take0`);
    expect(plain.logs).toContain(`${name}:take1`);
    expect(plain.logs).toContain(`${name}:take2`);
    expect(plain.logs.indexOf(`${name}:resumed`)).toBeLessThan(plain.logs.indexOf(`${name}:true`));
    expect(plain.logs.indexOf(`${name}:true`)).toBeLessThan(plain.logs.indexOf(`${name}:take2`));
    if (name === "closing_nested") expect(plain.logs).toContain(`${name}:nested`);
  }
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
// Native pure-interruption diagnostics retain only actual enclosing boundaries;
// child interruption trails are released, not inferred as a retained Done source.
const canceledPending = async () => {
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
          if (message === "pending_abort:peer") queueMicrotask(() => controller.abort());
        }),
      ]),
    ),
  );
  const frames = new DeferredInterruptionFrames();
  let settledLogs: readonly string[] = [];
  const outer = await Effect.runPromiseExitWith(context)(
    PrivateEffectReference.runWithFramesUnknown(
      pendingAbort,
      [],
      "functions.pending_abort.body",
      () => {
        expect(
          analyzeGeneratedQueueShutdownProfile(R.program({ work: pendingAbort })).has(pendingAbort),
        ).toBe(true);
        frames.claim();
        frames.prepare(pendingAbort.body, "functions.pending_abort.body");
        return [];
      },
      frames.root("functions.pending_abort.body"),
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
  if (!Exit.isFailure(outer)) throw new Error("Pending producers must be interrupted");
  const projected = PrivateEffectReference.projectFramedCause(outer.cause);
  expect(Cause.hasInterrupts(projected.cause)).toBe(true);
  expect(projected.cause.reasons.filter(Cause.isFailReason)).toEqual([]);
  expect(projected.frames).toEqual([]);
  expect(frames.snapshot().frames.map((frame) => frame.kind)).toEqual([
    "all",
    "catchAll",
    "queueScope",
    "function",
  ]);
  expect(frames.snapshot().omitted).toBe(0);
  expect(settledLogs).toEqual(["pending_abort:peer", "pending_abort:start", "pending_abort:end"]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(logs).toEqual(settledLogs);
  for (const framed of [false, true]) {
    const caller = new AbortController();
    const timer = setTimeout(() => caller.abort(), 1);
    try {
      if (framed) {
        const observed = await QueueShutdownExecution.runWithFrames(pendingAbort, {
          signal: caller.signal,
        });
        expect(observed.logs).toEqual(settledLogs);
        expect(Exit.isSuccess(observed.exit)).toBe(true);
        if (!Exit.isSuccess(observed.exit))
          throw new Error("Missing public cancellation observation");
        expect(Exit.isFailure(observed.exit.value.exit)).toBe(true);
        expect(observed.exit.value.frames).toEqual(
          frames.snapshot().frames.map((frame) => ({
            ...frame,
            path: frame.path.replace("functions.pending_abort", "functions.work"),
          })),
        );
        if (Exit.isFailure(observed.exit.value.exit)) {
          expect(Cause.hasInterrupts(observed.exit.value.exit.cause)).toBe(true);
          expect(observed.exit.value.exit.cause.reasons.filter(Cause.isFailReason)).toEqual([]);
        }
      } else {
        const observed = await QueueShutdownExecution.run(pendingAbort, { signal: caller.signal });
        expect(observed.logs).toEqual(settledLogs);
        expect(Exit.isFailure(observed.exit)).toBe(true);
        if (Exit.isFailure(observed.exit)) {
          expect(Cause.hasInterrupts(observed.exit.cause)).toBe(true);
          expect(observed.exit.cause.reasons.filter(Cause.isFailReason)).toEqual([]);
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    logs: settledLogs,
    frames: frames.snapshot().frames.map(({ path, kind }) => ({ path, kind })),
  };
};
test("repeated registration owns reference observations before native execution", async () => {
  const profiles = analyzeGeneratedQueueShutdownProfile(R.program(functions));
  expect(profiles.size).toBe(Object.keys(functions).length);
  for (const [name, fn] of Object.entries(functions)) {
    expect(profiles.get(fn)?.shutdownOfferBound).toBe(
      name === "pending_abort"
        ? 3
        : name === "open_cap2"
          ? 5
          : name === "closing_cap3"
            ? 7
            : name === "closing_nested"
              ? 6
              : name.startsWith("closing_") && name !== "closing_alternating"
                ? 5
                : 4,
    );
    expect(profiles.get(fn)?.shutdownPendingOfferBound).toBe(2);
    expect(profiles.get(fn)?.shutdownReleaseOfferBound).toBe(1);
  }
  for (const count of [0, 1, 2]) {
    const finite = R.fn([], R.Unit, R.Never, () =>
      R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
        R.Effect.flatMap((owner) => {
          const offers = Array.from({ length: count }, () =>
            R.Queue.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid),
          );
          return group(
            seq(...offers, R.Queue.take(owner).pipe(R.Effect.asVoid)),
            seq(
              R.Queue.end(owner).pipe(R.Effect.asVoid),
              R.Queue.shutdown(owner).pipe(R.Effect.asVoid),
              R.Queue.take(owner).pipe(R.Effect.asVoid),
            ),
          ).pipe(R.Effect.catch(() => R.Effect.void));
        }),
      ),
    );
    const old = analyzeGeneratedQueueShutdownProfile(R.program({ finite })).get(finite);
    expect(old).not.toHaveProperty("shutdownReleaseOfferBound");
    if (count === 2) expect(old?.shutdownPendingOfferBound).toBe(1);
    else expect(old).not.toHaveProperty("shutdownPendingOfferBound");
  }
  for (const [name, fn] of ordinaryCases) await reference(name, fn);
  await canceledPending();
});
const allocator = String.raw`
use std::sync::atomic::{AtomicBool,AtomicUsize,AtomicIsize,Ordering};
struct Allocator;static TRACK:AtomicBool=AtomicBool::new(false);static ALLOCATIONS:AtomicUsize=AtomicUsize::new(0);static LIVE:AtomicIsize=AtomicIsize::new(0);
unsafe impl std::alloc::GlobalAlloc for Allocator{unsafe fn alloc(&self,l:std::alloc::Layout)->*mut u8{if TRACK.load(Ordering::Relaxed){ALLOCATIONS.fetch_add(1,Ordering::Relaxed);LIVE.fetch_add(1,Ordering::Relaxed);}std::alloc::System.alloc(l)}unsafe fn dealloc(&self,p:*mut u8,l:std::alloc::Layout){if TRACK.load(Ordering::Relaxed){LIVE.fetch_sub(1,Ordering::Relaxed);}std::alloc::System.dealloc(p,l)}}
#[global_allocator]static ALLOCATOR:Allocator=Allocator;
fn begin(){LIVE.store(0,Ordering::Relaxed);ALLOCATIONS.store(0,Ordering::Relaxed);TRACK.store(true,Ordering::Relaxed);}fn end()->usize{TRACK.store(false,Ordering::Relaxed);ALLOCATIONS.load(Ordering::Relaxed)}
async fn once<F:std::future::Future>(mut f:std::pin::Pin<&mut F>){std::future::poll_fn(|cx|{assert!(f.as_mut().poll(cx).is_pending());std::task::Poll::Ready(())}).await;}
`;
// Quiet has one terminal Take failure; its sole Bounded trail is recovered and released.
const harness = (framed: boolean) => `use reffect_generated as r;${allocator}
#[tokio::main(flavor="current_thread")]async fn main(){let(_tx,rx)=tokio::sync::watch::channel(false);let mut ctx=r::AsyncContext::new(rx);
${ordinaryCases.map(([name]) => `{let exit=r::r_${name}(&mut ctx).await;${name.startsWith("closing_") ? `assert!(exit.is_ok(),"Closing Done recovery ${name}");` : `assert!(matches!(exit,Err(r::AsyncError::Combined(cause)) if cause.interrupted && cause.first().is_none()),"Open repeated-registration Shutdown interrupts ${name}");`}${framed ? `let(frames,omitted)=ctx.take_frames();assert_eq!(omitted,0);for frame in frames{println!("FRAME:${name}:{}",frame);}` : ""}}`).join("\n")}
let layouts=r::reffect_queue_future_layouts(&mut ctx);assert!(layouts.iter().all(|size|*size<=20480));
assert!(r::r_quiet(&mut ctx).await.is_ok());${framed ? "let _=ctx.take_frames();" : ""}
begin();for _ in 0..100{let future=r::r_quiet(&mut ctx);std::hint::black_box(&future);drop(future);}let construction=end();assert_eq!(construction,0);
begin();for _ in 0..100{assert!(r::r_quiet(&mut ctx).await.is_ok());${framed ? "let _=ctx.take_frames();" : ""}}let execution=end();assert_eq!(LIVE.load(Ordering::Relaxed),0,"Repeated registration Shutdown trails released");assert_eq!(execution,${framed ? 100 : 0},"Quiet repeated-registration Shutdown cost");
{let(tx,rx)=tokio::sync::watch::channel(false);let mut ctx=r::AsyncContext::new(rx);{let future=r::r_pending_abort(&mut ctx);tokio::pin!(future);once(future.as_mut()).await;tx.send(true).unwrap();match future.await{Err(r::AsyncError::Combined(cause))=>{assert!(cause.interrupted,"Two pending producers retain parent interruption");assert_eq!(cause.first(),None,"No fabricated Done on pending cancellation");},_=>panic!("Two pending producers cannot recover")}}${framed ? `let(frames,omitted)=ctx.take_frames();assert_eq!(omitted,0);for frame in frames{println!("FRAME:pending_abort:{}",frame);}assert!(ctx.take_frames().0.is_empty());` : ""}}
println!("COST construction={construction} execution={execution} layouts={layouts:?}");println!("queue-repeated-registration-shutdown-ok");}
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
  "repeated producer Shutdown matches pinned Effect, release ordering and quiet costs",
  async () => {
    const expectedLogs: string[] = [];
    const expectedFrames = new Map<string, readonly { path: string; kind: string }[]>();
    for (const [name, fn] of ordinaryCases) {
      const observed = await reference(name, fn);
      expectedLogs.push(...observed.logs);
      expectedFrames.set(name, observed.frames);
    }
    const canceled = await canceledPending();
    expectedLogs.push(...canceled.logs);
    expectedFrames.set("pending_abort", canceled.frames);
    const directory = await mkdtemp(
      join(tmpdir(), "reffect-queue-repeated-registration-shutdown-"),
    );
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
            `Queue repeated-registration Shutdown ${artifacts._tag}/${frames._tag}: Rust bytes=${Buffer.byteLength(emitted.files["src/lib.rs"]!)}\n`,
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
            expect(result.stdout).toContain("queue-repeated-registration-shutdown-ok");
            process.stdout.write(
              `Queue repeated-registration Shutdown ${artifacts._tag}/${frames._tag}/${release ? "release" : "debug"}: ${result.stdout.trim()}\n`,
            );
          }
        }
      const source = (
        await publicArtifact(R.program(functions), SourceArtifacts.None, FailureFrames.Bounded)
      ).files["src/lib.rs"]!;
      for (const [mutated, reason] of [
        [
          source.replaceAll(".shutdown_exit().await", ".end_exit().await"),
          "Open repeated-registration Shutdown interrupts open_cap2",
        ],
        [
          source.replaceAll(
            "Err(QueueTakeFailure::Done(done)) => Err((AsyncError::Fail(done),",
            "Err(QueueTakeFailure::Done(done)) => Err((AsyncError::Interrupted,",
          ),
          "Closing Done recovery closing_cap3",
        ],
        [
          source.replaceAll("drop(frames);", "std::mem::forget(frames);"),
          "Repeated registration Shutdown trails released",
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
  nativeTestBudget(3) + 600000,
);
