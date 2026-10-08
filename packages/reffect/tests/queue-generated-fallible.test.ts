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
  QueueAllExecution,
  QueueDoneType,
  R,
  Rust,
  SourceArtifacts,
} from "../src/index.ts";
import { checkEffectFunction, PrivateEffectReference } from "../src/effect-ir.ts";
import type { Computation, EffectFn } from "../src/effect-ir.ts";
import { DeferredInterruptionFrames } from "../src/deferred-interruption-frames.ts";
import { QueueIR as Q } from "../src/queue.ts";
import { Expr, Operation, SemanticRef } from "../src/kernel.ts";
import { analyzeGeneratedQueueFallibleProfile } from "../src/queue-generated-profile.ts";
import {
  emitFunctions,
  lowerFunctions,
  lowerQueueDoneFunctions,
  lowerQueueFallibleFunctions,
  lowerQueueFunctions,
} from "../src/lower.ts";
import { QueueExecution } from "../src/queue-execution.ts";
import { generatedDeferredGrowthLimits } from "../src/deferred-growth.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const selected = new Map(Rust.std.implementations.map((item) => [item.operation.ref, item]));
const group = <E, E2>(a: Computation<void, E>, b: Computation<void, E2>) =>
  R.Effect.all([a, b], { concurrency: "unbounded", discard: true });
const seq = <E>(...steps: Computation<void, E>[]) =>
  steps.reduce(
    (body, next) => body.pipe(R.Effect.andThen(next)),
    R.Effect.void as Computation<void, E>,
  );
const make = (kind: string) =>
  R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.U64, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) => {
        const take = R.Queue.take(owner).pipe(R.Effect.asVoid);
        const end = R.Queue.end(owner).pipe(R.Effect.asVoid);
        const logEnd = end.pipe(R.Effect.andThen(R.Log.info("ended")));
        const producer = seq(
          R.Queue.offer(owner, R.U64.literal(1n)).pipe(R.Effect.asVoid),
          R.Queue.offer(owner, R.U64.literal(2n)).pipe(R.Effect.asVoid),
          end,
          take,
          take,
        );
        const consumer = R.Queue.take(owner).pipe(
          R.Effect.flatMap((value) =>
            R.Match.bool(
              R.U64.eq(value, R.U64.literal(1n)),
              R.Log.info("take:1"),
              R.Log.info("wrong-take"),
            ),
          ),
        );
        const shared = seq(end, take);
        const source =
          kind === "reverse"
            ? group(logEnd, take)
            : kind === "success"
              ? group(
                  seq(R.Queue.offer(owner, R.U64.literal(7n)).pipe(R.Effect.asVoid), logEnd),
                  take,
                )
              : kind === "second"
                ? group(
                    seq(R.Queue.offer(owner, R.U64.literal(7n)).pipe(R.Effect.asVoid), logEnd),
                    seq(take, take),
                  )
                : kind === "unopened"
                  ? group(shared, R.Log.info("wrong-unopened"))
                  : kind === "shared"
                    ? group(shared, shared)
                    : kind === "release"
                      ? group(consumer, producer)
                      : kind === "release-reverse"
                        ? group(producer, consumer)
                        : kind === "blocked"
                          ? group(take, R.Effect.void)
                          : group(take, kind === "quiet" ? end : logEnd);
        return source.pipe(
          R.Effect.catch(() =>
            kind === "quiet" ? R.Effect.void : R.Log.info(`recovered:${kind}`),
          ),
        );
      }),
    ),
  );
const functions = Object.fromEntries(
  [
    "empty",
    "reverse",
    "success",
    "second",
    "unopened",
    "shared",
    "release",
    "release-reverse",
    "quiet",
    "blocked",
  ].map((kind) => [kind.replaceAll("-", "_"), make(kind)]),
);
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
        group(
          R.Deferred.succeed(cell, R.Unit.literal()).pipe(R.Effect.asVoid),
          R.Deferred.await(cell),
        ),
      ),
    ),
  ),
};
const publicArtifact = async (
  program: ReturnType<typeof R.program>,
  artifacts: typeof SourceArtifacts.None | typeof SourceArtifacts.Full = SourceArtifacts.None,
  frames: typeof FailureFrames.None = FailureFrames.Bounded,
) => {
  const artifact = await Effect.runPromise(
    Compile.make(program).pipe(
      Compile.withTarget(Rust.tokio),
      Compile.withSourceArtifacts(artifacts),
      Compile.withFailureFrames(frames),
      Compile.run,
    ),
  );
  expect(artifact.files).toEqual(
    emitFunctions(lowerQueueFallibleFunctions(program, selected, artifacts, frames)).files,
  );
  return artifact;
};
const checkedReference = (fn: EffectFn) => {
  const profiles = analyzeGeneratedQueueFallibleProfile(R.program({ work: fn }));
  expect(profiles.get(fn)?.fallibleAll).toBe(true);
  return [];
};
const observe = async (name: string, framed: boolean, cancelled = false) => {
  const fn = functions[name]!;
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
  const controller = new AbortController();
  const pending: Promise<Exit.Exit<Exit.Exit<unknown, unknown>, unknown>> = framed
    ? Effect.runPromiseExitWith(context)(
        PrivateEffectReference.runWithFramesUnknown(
          fn,
          [],
          `functions.${name}.body`,
          () => {
            checkedReference(fn);
            frames.claim();
            frames.prepare(fn.body, `functions.${name}.body`);
            return [];
          },
          frames.root(`functions.${name}.body`),
        ).pipe(Effect.map((value) => value.exit)),
        { signal: controller.signal },
      )
    : Effect.runPromiseExitWith(context)(
        PrivateEffectReference.runUnknown(fn, [], () => checkedReference(fn)).pipe(Effect.exit),
        { signal: controller.signal },
      );
  if (cancelled) controller.abort();
  const outer = await pending;
  const exit = Exit.isSuccess(outer) ? outer.value : outer;
  if (cancelled) expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  else {
    expect(Exit.isSuccess(outer), name).toBe(true);
    expect(Exit.isSuccess(exit), name).toBe(true);
  }
  return { logs, frames: frames.snapshot() };
};

test("fallible Queue selection discharges only a checked root Done recovery", async () => {
  expect(analyzeGeneratedQueueFallibleProfile(R.program(mixed)).size).toBe(10);
  expect(
    checkEffectFunction(functions.empty!, "functions.empty").some(
      (issue) => issue.code === "TASK_GROUP_RECOVERY",
    ),
  ).toBe(true);
  for (const lower of [lowerFunctions, lowerQueueFunctions, lowerQueueDoneFunctions])
    expect(() => lower(R.program({ work: functions.empty! }), selected)).toThrow();
  expect(Exit.isFailure((await QueueExecution.run(functions.empty!)).exit)).toBe(true);
  const unsupported = (handler: Computation<void>, shutdown = false) =>
    R.fn([], R.Unit, R.Never, () =>
      Q.bounded(R.Unit, 1, QueueDoneType).pipe(
        R.Effect.flatMap((owner) =>
          group(
            Q.take(owner),
            (shutdown ? Q.shutdown(owner) : Q.end(owner)).pipe(R.Effect.asVoid),
          ).pipe(R.Effect.catch(() => handler)),
        ),
      ),
    );
  const childRecovery = R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        group(
          Q.take(owner).pipe(R.Effect.catch(() => R.Effect.void)),
          Q.end(owner).pipe(R.Effect.asVoid),
        ),
      ),
    ),
  );
  const consumed = R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        group(Q.take(owner), Q.end(owner).pipe(R.Effect.asVoid)).pipe(
          R.Effect.catch((done) => R.Effect.succeed(done).pipe(R.Effect.asVoid)),
        ),
      ),
    ),
  );
  const cleanup = R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        group(
          Q.take(owner).pipe(R.Effect.ensuring(R.Effect.void)),
          Q.end(owner).pipe(R.Effect.asVoid),
        ).pipe(R.Effect.catch(() => R.Effect.void)),
      ),
    ),
  );
  const nested = unsupported(group(R.Effect.void, R.Effect.void));
  const conditional = R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        R.Match.bool(
          R.Bool.literal(true),
          group(Q.take(owner), Q.end(owner).pipe(R.Effect.asVoid)),
          group(Q.take(owner), Q.end(owner).pipe(R.Effect.asVoid)),
        ).pipe(R.Effect.catch(() => R.Effect.void)),
      ),
    ),
  );
  const escaping = R.fn([], R.Unit, QueueDoneType, () =>
    Q.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) => group(Q.take(owner), Q.end(owner).pipe(R.Effect.asVoid))),
    ),
  );
  const fallibleHandler = R.fn([], R.Unit, R.U64, () =>
    Q.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        group(Q.take(owner), Q.end(owner).pipe(R.Effect.asVoid)).pipe(
          R.Effect.catch(() => R.Effect.fail(R.U64.literal(1n)).pipe(R.Effect.asVoid)),
        ),
      ),
    ),
  );
  for (const fn of [
    unsupported(R.Effect.sleep(1)),
    unsupported(R.Effect.void, true),
    consumed,
    cleanup,
    nested,
    conditional,
    escaping,
    fallibleHandler,
  ])
    expect(() => lowerQueueFallibleFunctions(R.program({ work: fn }), selected)).toThrow();
  const publicQueue = R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1).pipe(
      R.Effect.flatMap((owner) =>
        group(R.Queue.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid), R.Queue.take(owner)),
      ),
    ),
  );
  const coexports = R.program({ work: functions.empty!, publicQueue, childRecovery });
  expect(analyzeGeneratedQueueFallibleProfile(coexports).size).toBe(3);
  expect(() => lowerQueueFallibleFunctions(coexports, selected)).not.toThrow();
  const receipts = analyzeGeneratedQueueFallibleProfile(coexports);
  const tripleSize = [...receipts.values()].reduce(
    (sum, profile) => sum + profile.bounds.computationOccurrences,
    0,
  );
  const repeats = Math.floor(generatedDeferredGrowthLimits.moduleComputations / tripleSize) + 1;
  const oversized = Object.fromEntries(
    Array.from({ length: repeats }, (_, index) =>
      Object.entries(coexports.functions).map(([name, fn]) => [`${name}_${index}`, fn]),
    ).flat(),
  );
  expect(() => analyzeGeneratedQueueFallibleProfile(R.program(oversized))).toThrow(
    /moduleComputations/,
  );
  const hidden = Operation.make(
    SemanticRef.operation("test/queue-fallible-hidden"),
    [QueueDoneType],
    R.Bool,
    () => false,
  );
  // @ts-expect-error missing operand must retain the forbidden operation channel
  const hiddenExpression = Expr.apply(hidden);
  expect(() =>
    lowerQueueFallibleFunctions(
      R.program({ work: functions.empty!, hidden: R.fn([], R.Bool, () => hiddenExpression) }),
      selected,
    ),
  ).toThrow();
});

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
const names = Object.keys(functions).filter((name) => name !== "blocked");
const harness = (framed: boolean) => `use reffect_generated as r;\n${allocator}
#[tokio::main(flavor="current_thread")]
async fn main(){
 let(_parent,receiver)=tokio::sync::watch::channel(false);let mut ctx=r::AsyncContext::new(receiver);
 ${names.map((name) => `assert!(r::r_${name}(&mut ctx).await.is_ok(),"Recovered All ${name}");`).join("\n")}
 assert!(r::r_deferred(&mut ctx).await.is_ok());
 assert!(matches!(r::r_ordinary(&mut ctx).await,Err(r::AsyncError::Combined(_))));
 ${framed ? 'assert!(r::r_success(&mut ctx).await.is_ok());assert!(ctx.take_frames().0.is_empty(),"Successful All must clear stale trail");' : ""}
 let layouts=r::reffect_queue_future_layouts(&mut ctx);assert!(layouts.iter().all(|bytes|*bytes<=20480));
 begin();for _ in 0..100{let future=r::r_quiet(&mut ctx);std::hint::black_box(&future);drop(future);}let construction=end();assert_eq!(construction,0);
 begin();for _ in 0..100{assert!(r::r_quiet(&mut ctx).await.is_ok());}let execution=end();assert_eq!(LIVE.load(Ordering::Relaxed),0,"Handled group trails must be released");assert_eq!(execution,${framed ? 100 : 0},"Quiet group Done allocation cost");
 ${framed ? 'assert!(ctx.take_frames().0.is_empty(),"Recovered All clears child trails");' : ""}
 let(sender,receiver)=tokio::sync::watch::channel(false);let mut blocked=r::AsyncContext::new(receiver);
 {let future=r::r_blocked(&mut blocked);tokio::pin!(future);once(future.as_mut()).await;sender.send(true).unwrap();match future.await{Err(r::AsyncError::Combined(cause))=>assert!(cause.interrupted&&cause.first().is_none(),"Blocked All bypasses Done recovery"),_=>panic!("Blocked All bypasses Done recovery")}}
 ${framed ? 'let(frames,omitted)=blocked.take_frames();assert_eq!(omitted,0);assert_eq!(frames.len(),4);for(frame,kind)in frames.iter().zip(["all","catchAll","queueScope","function"]){assert!(frame.contains(&format!("\\\"kind\\\":\\\"{}\\\"",kind)));}for frame in &frames{println!("FRAME:{}",frame);}assert!(blocked.take_frames().0.is_empty());' : ""}
 let(_sender,receiver)=tokio::sync::watch::channel(true);let mut aborted=r::AsyncContext::new(receiver);assert!(matches!(r::r_empty(&mut aborted).await,Err(r::AsyncError::Interrupted)));
 println!("COST construction={construction} execution={execution} layouts={layouts:?}");println!("queue-fallible-generated-ok");
}
`;

test(
  "generated fallible Queue All matches official ordering, frames and costs",
  async () => {
    const expectedLogs: string[] = [];
    for (const name of names) {
      const plain = await observe(name, false);
      const framed = await observe(name, true);
      expect(framed.logs).toEqual(plain.logs);
      expect(framed.frames.frames).toEqual([]);
      const owned = await QueueAllExecution.run(functions[name]!);
      expect(owned.exit).toEqual(Exit.succeed(undefined));
      expect(owned.logs).toEqual(plain.logs);
      expect(Object.isFrozen(owned.logs)).toBe(true);
      const ownedFramed = await QueueAllExecution.runWithFrames(functions[name]!);
      expect(ownedFramed.exit).toEqual(
        Exit.succeed({ exit: Exit.succeed(undefined), frames: [], omitted: 0 }),
      );
      expect(ownedFramed.logs).toEqual(framed.logs);
      expectedLogs.push(...plain.logs);
    }
    let expectedFrames: readonly { readonly path: string; readonly kind: string }[] = [];
    for (const framed of [false, true]) {
      const blocked = await observe("blocked", framed, true);
      expect(blocked.logs).toEqual([]);
      if (framed) {
        expectedFrames = blocked.frames.frames;
        expect(blocked.frames.frames.map((frame) => frame.kind)).toEqual([
          "all",
          "catchAll",
          "queueScope",
          "function",
        ]);
      }
    }
    const directory = await mkdtemp(join(tmpdir(), "reffect-queue-fallible-generated-"));
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
          const emitted = await publicArtifact(R.program(mixed), artifacts, frames);
          expect(Buffer.byteLength(emitted.files["src/lib.rs"]!)).toBeLessThanOrEqual(2097152);
          process.stdout.write(
            `Queue All ${artifacts._tag}/${frames._tag}: Rust bytes=${Buffer.byteLength(emitted.files["src/lib.rs"]!)}\n`,
          );
          expect(emitted.files["src/lib.rs"]).not.toContain("__reffect_queue_done_unit");
          expect("sources" in emitted).toBe(!SourceArtifacts.isNone(artifacts));
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
            expect(logs).toEqual(
              FailureFrames.isNone(frames) ? expectedLogs : expectedLogs.concat("ended"),
            );
            const trails = result.stdout
              .split("\n")
              .filter((line) => line.startsWith("FRAME:"))
              .map((line) => {
                const value = JSON.parse(line.slice(6)) as { path: string; kind: string };
                return { path: value.path, kind: value.kind };
              });
            expect(trails).toEqual(FailureFrames.isNone(frames) ? [] : expectedFrames);
            expect(result.stdout).toContain("queue-fallible-generated-ok");
            process.stdout.write(
              `Queue All ${artifacts._tag}/${frames._tag}/${release ? "release" : "debug"}: ${result.stdout.trim()}\n`,
            );
          }
        }
      const source = (await publicArtifact(R.program(mixed))).files["src/lib.rs"]!;
      for (const [mutated, reason] of [
        [
          source.replaceAll(
            "Err(QueueTakeFailure::Done(done)) => Err((AsyncError::Fail(done),",
            "Err(QueueTakeFailure::Done(done)) => Err((AsyncError::Interrupted,",
          ),
          "Recovered All empty",
        ],
        [
          source.replaceAll("drop(frames);", "std::mem::forget(frames);"),
          "Handled group trails must be released",
        ],
      ] as const) {
        expect(mutated).not.toBe(source);
        await writeFile(join(directory, "src/lib.rs"), mutated);
        await expect(execute()).rejects.toMatchObject({ stderr: expect.stringContaining(reason) });
      }
      const guarded = (
        await publicArtifact(
          R.program({ quiet: functions.quiet! }),
          SourceArtifacts.None,
          FailureFrames.None,
        )
      ).files["src/lib.rs"]!;
      expect(guarded).not.toContain("structured_all2_fallible");
      const boundary = "let cause = driver.all_cause(interrupted);";
      expect(guarded.split(boundary)).toHaveLength(2);
      const lateCancel = guarded.replace(
        boundary,
        `${boundary}let (_cancel, receiver) = tokio::sync::watch::channel(true);ctx.cancellation = receiver;`,
      );
      await writeFile(
        join(directory, "src/main.rs"),
        `use reffect_generated as r;#[tokio::main(flavor="current_thread")]async fn main(){let(_tx,rx)=tokio::sync::watch::channel(false);let mut ctx=r::AsyncContext::new(rx);match r::r_quiet(&mut ctx).await{Err(r::AsyncError::Combined(cause))=>assert_eq!(cause.first(),Some(r::RuntimeFailure::QueueDone)),_=>panic!("Canceled All recovery retains Done")}}`,
      );
      await writeFile(join(directory, "src/lib.rs"), lateCancel);
      await execute();
      const mutated = lateCancel.replaceAll(
        "if ctx.is_cancelled() || cause.first().is_none()",
        "if cause.first().is_none()",
      );
      expect(mutated).not.toBe(lateCancel);
      await writeFile(join(directory, "src/lib.rs"), mutated);
      await expect(execute()).rejects.toMatchObject({
        stderr: expect.stringContaining("Canceled All recovery retains Done"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(3) + 480000,
);

test(
  "canceled generated All retains and consumes the selected Done child trail",
  async () => {
    const emitted = await publicArtifact(R.program({ quiet: functions.quiet! }));
    const source = emitted.files["src/lib.rs"]!;
    const boundary = "let cause = driver.all_cause(interrupted);";
    expect(source.split(boundary)).toHaveLength(2);
    // The admitted shape has no await here; injection isolates retention from host scheduling.
    const canceled = source.replace(
      boundary,
      `${boundary}let (_cancel, receiver) = tokio::sync::watch::channel(true);ctx.cancellation = receiver;`,
    );
    const main = String.raw`use reffect_generated as r;
#[tokio::main(flavor="current_thread")]
async fn main(){
 let(_tx,rx)=tokio::sync::watch::channel(false);let mut ctx=r::AsyncContext::new(rx);
 match r::r_quiet(&mut ctx).await{Err(r::AsyncError::Combined(cause))=>assert_eq!(cause.first(),Some(r::RuntimeFailure::QueueDone)),_=>panic!("Canceled recovery retains Done")}
 let(frames,omitted)=ctx.take_frames();assert_eq!(omitted,0);assert_eq!(frames.len(),6,"Retained Done keeps its child trail");
 for frame in frames{println!("FRAME:{}",frame);}assert!(ctx.take_frames().0.is_empty(),"Trail observation consumes invocation state");
}`;
    const expected = [
      { path: "functions.quiet.body.body.source.children[0].source", kind: "queueTake" },
      { path: "functions.quiet.body.body.source.children[0]", kind: "map" },
      { path: "functions.quiet.body.body.source", kind: "all" },
      { path: "functions.quiet.body.body", kind: "catchAll" },
      { path: "functions.quiet.body", kind: "queueScope" },
      { path: "functions.quiet", kind: "function" },
    ];
    const directory = await mkdtemp(join(tmpdir(), "reffect-queue-all-trail-"));
    const run = promisify(execFile);
    const execute = (release = false) =>
      run("cargo", ["run", "--offline", "--quiet", ...(release ? ["--release"] : [])], {
        cwd: directory,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          CARGO_PROFILE_DEV_DEBUG: "0",
          CARGO_INCREMENTAL: "0",
          CARGO_BUILD_JOBS: "1",
        },
      });
    try {
      for (const [path, text] of Object.entries(emitted.files)) {
        await mkdir(dirname(join(directory, path)), { recursive: true });
        await writeFile(join(directory, path), text);
      }
      await writeFile(join(directory, "src/lib.rs"), canceled);
      await writeFile(join(directory, "src/main.rs"), main);
      for (const release of [false, true]) {
        const output = (await execute(release)).stdout;
        const frames = output
          .split("\n")
          .filter((line) => line.startsWith("FRAME:"))
          .map((line) => {
            const value = JSON.parse(line.slice(6)) as { path: string; kind: string };
            return { path: value.path, kind: value.kind };
          });
        expect(frames).toEqual(expected);
      }
      const before = "Some(mut frames) => { frames.push(";
      expect(canceled.split(before)).toHaveLength(2);
      await writeFile(
        join(directory, "src/lib.rs"),
        canceled.replace(before, "Some(mut frames) => { frames.len = 0; frames.push("),
      );
      await expect(execute()).rejects.toMatchObject({
        stderr: expect.stringContaining("Retained Done keeps its child trail"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(1) + 480000,
);
