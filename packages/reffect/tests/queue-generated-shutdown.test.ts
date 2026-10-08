import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Cause, Context, Effect, Exit, Logger, Queue, Scheduler } from "effect";
import { expect, test } from "vite-plus/test";
import { Compile, FailureFrames, QueueDoneType, R, Rust, SourceArtifacts } from "../src/index.ts";
import { Computation, PrivateEffectReference } from "../src/effect-ir.ts";
import type { EffectFn } from "../src/effect-ir.ts";
import { DeferredInterruptionFrames } from "../src/deferred-interruption-frames.ts";
import { QueueIR as Q } from "../src/queue.ts";
import { analyzeGeneratedQueueShutdownProfile } from "../src/queue-generated-profile.ts";
import {
  emitFunctions,
  lowerFunctions,
  lowerQueueDoneFunctions,
  lowerQueueFallibleFunctions,
  lowerQueueCleanupFunctions,
  lowerQueueShutdownFunctions,
} from "../src/lower.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const selected = new Map(Rust.std.implementations.map((item) => [item.operation.ref, item]));
const group = <A, B>(a: Computation<void, A>, b: Computation<void, B>) =>
  R.Effect.all([a, b], { concurrency: "unbounded", discard: true });
const seq = <E>(...steps: Computation<void, E>[]) =>
  steps.reduce((a, b) => a.pipe(R.Effect.andThen(b)), R.Effect.void as Computation<void, E>);
const make = (name: string) =>
  R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) => {
        const take = R.Queue.take(owner);
        const quiet = name === "quiet";
        const terminal = R.Queue.shutdown(owner).pipe(
          R.Effect.flatMap((value) =>
            quiet
              ? R.Effect.void
              : R.Match.bool(
                  value,
                  R.Log.info(`shutdown:${name}:true`),
                  R.Log.info(`shutdown:${name}:false`),
                ),
          ),
        );
        const end = R.Queue.end(owner).pipe(R.Effect.asVoid);
        const cleanup = quiet
          ? R.Effect.sleep(1)
          : seq(
              R.Log.info(`cleanup:${name}:start`),
              R.Effect.sleep(1),
              R.Log.info(`cleanup:${name}:end`),
            );
        const repeated = seq(end, terminal, take);
        const source =
          name === "done"
            ? group(repeated, R.Effect.void)
            : name === "retained"
              ? group(seq(end, take).pipe(R.Effect.ensuring(cleanup)), terminal)
              : name === "take_cleanup"
                ? group(take.pipe(R.Effect.ensuring(cleanup)), terminal)
                : quiet
                  ? group(seq(end, take).pipe(R.Effect.ensuring(cleanup)), terminal)
                  : name === "reverse"
                    ? group(terminal, take)
                    : group(take, terminal);
        return source.pipe(
          R.Effect.catch(() => (quiet ? R.Effect.void : R.Log.info(`recovered:${name}`))),
        );
      }),
    ),
  );
const functions = Object.fromEntries(
  ["eager", "reverse", "done", "take_cleanup", "retained", "quiet"].map((name) => [
    name,
    make(name),
  ]),
);
const old = {
  ordinary: R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1).pipe(
      R.Effect.flatMap((owner) =>
        group(R.Queue.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid), R.Queue.take(owner)),
      ),
    ),
  ),
  local: R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        group(
          R.Queue.take(owner).pipe(R.Effect.catch(() => R.Effect.void)),
          R.Queue.end(owner).pipe(R.Effect.asVoid),
        ),
      ),
    ),
  ),
  fallible: R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        group(R.Queue.take(owner), R.Queue.end(owner).pipe(R.Effect.asVoid)).pipe(
          R.Effect.catch(() => R.Effect.void),
        ),
      ),
    ),
  ),
};
const mixed = { ...functions, ...old };
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
    emitFunctions(lowerQueueShutdownFunctions(program, selected, artifacts, frames)).files,
  );
  return artifact;
};
const checked = (fn: EffectFn) => {
  expect(analyzeGeneratedQueueShutdownProfile(R.program({ work: fn })).has(fn)).toBe(true);
  return [];
};
const observe = async (name: string, framed: boolean, cancel = false) => {
  const fn = functions[name]!;
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
          if (cancel && message === `cleanup:${name}:start`)
            queueMicrotask(() => controller.abort());
        }),
      ]),
    ),
  );
  const frames = new DeferredInterruptionFrames();
  const computation: Effect.Effect<Exit.Exit<unknown, unknown>, unknown> = framed
    ? PrivateEffectReference.runWithFramesUnknown(
        fn,
        [],
        `functions.${name}.body`,
        () => {
          checked(fn);
          frames.claim();
          frames.prepare(fn.body, `functions.${name}.body`);
          return [];
        },
        frames.root(`functions.${name}.body`),
      ).pipe(Effect.map((value) => value.exit))
    : PrivateEffectReference.runUnknown(fn, [], () => checked(fn)).pipe(Effect.exit);
  let settledLogs: string[] | undefined;
  const outer = await Effect.runPromiseExitWith(context)(
    computation.pipe(
      Effect.onExit(() =>
        Effect.sync(() => {
          settledLogs = [...logs];
        }),
      ),
    ),
    { signal: controller.signal },
  );
  const exit = Exit.isSuccess(outer) ? outer.value : outer;
  expect(Exit.isSuccess(exit)).toBe(name === "done" || (name === "retained" && !cancel));
  let trail: readonly { path: string; kind: string }[] = frames.snapshot().frames;
  if (Exit.isFailure(exit)) {
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    const reason = exit.cause.reasons.find(Cause.isFailReason);
    expect(Boolean(reason)).toBe(cancel && name === "retained");
    if (reason && framed) {
      const domain = reason.error as unknown as {
        error: { _tag: string };
        frames: readonly { path: string; kind: string }[];
      };
      expect(domain.error._tag).toBe("Done");
      // The existing owned cleanup policy restores static boundaries which the
      // externally aborted reference wrapper cannot decorate after masked cleanup.
      trail = [
        ...domain.frames,
        { path: `functions.${name}.body.body.source.children[0]`, kind: "ensuring" },
        ...trail,
      ];
    } else if (reason) expect((reason.error as { _tag: string })._tag).toBe("Done");
  }
  expect(settledLogs).toEqual(logs);
  return { logs: settledLogs!, frames: trail.map(({ path, kind }) => ({ path, kind })) };
};

test("Shutdown selection excludes excess Offer edges and terminal cleanup", () => {
  const profiles = analyzeGeneratedQueueShutdownProfile(R.program(mixed));
  expect(profiles.size).toBe(9);
  for (const fn of Object.values(functions)) expect(profiles.get(fn)?.shutdown).toBe(true);
  for (const fn of Object.values(old)) expect(profiles.get(fn)?.shutdown).toBeUndefined();
  for (const artifacts of [SourceArtifacts.None, SourceArtifacts.Full])
    for (const frames of [FailureFrames.None, FailureFrames.Bounded])
      expect(
        emitFunctions(lowerQueueShutdownFunctions(R.program(old), selected, artifacts, frames)),
      ).toEqual(
        emitFunctions(lowerQueueCleanupFunctions(R.program(old), selected, artifacts, frames)),
      );
  const oldCleanup = R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        group(
          seq(R.Queue.end(owner).pipe(R.Effect.asVoid), R.Queue.take(owner)).pipe(
            R.Effect.ensuring(R.Effect.sleep(1)),
          ),
          R.Effect.void,
        ).pipe(R.Effect.catch(() => R.Effect.void)),
      ),
    ),
  );
  const cleanupProgram = R.program({ work: oldCleanup });
  const cleanupProfile = analyzeGeneratedQueueShutdownProfile(cleanupProgram).get(oldCleanup);
  expect(cleanupProfile?.cleanup).toBe(true);
  expect(cleanupProfile?.shutdown).toBeUndefined();
  for (const artifacts of [SourceArtifacts.None, SourceArtifacts.Full])
    for (const frames of [FailureFrames.None, FailureFrames.Bounded])
      expect(
        emitFunctions(lowerQueueShutdownFunctions(cleanupProgram, selected, artifacts, frames)),
      ).toEqual(
        emitFunctions(lowerQueueCleanupFunctions(cleanupProgram, selected, artifacts, frames)),
      );
  for (const lower of [
    lowerFunctions,
    lowerQueueDoneFunctions,
    lowerQueueFallibleFunctions,
    lowerQueueCleanupFunctions,
  ])
    expect(() => lower(R.program({ work: functions.eager! }), selected)).toThrow();
  const invalid = (kind: string) =>
    R.fn([], R.Unit, R.Never, () =>
      Q.bounded(R.Unit, 1, QueueDoneType).pipe(
        R.Effect.flatMap((owner) => {
          const take = Q.take(owner);
          const shutdown = Q.shutdown(owner).pipe(R.Effect.asVoid);
          const offer = Q.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid);
          const child =
            kind === "source_cleanup"
              ? seq(shutdown, take).pipe(R.Effect.ensuring(R.Effect.sleep(1)))
              : kind === "cleanup"
                ? take.pipe(R.Effect.ensuring(shutdown))
                : kind === "branch"
                  ? R.Match.bool(R.Bool.literal(false), seq(offer, offer, offer), take)
                  : kind === "handler"
                    ? take
                    : seq(offer, offer, offer, take);
          return (
            kind === "second_take_cleanup"
              ? group(shutdown, take.pipe(R.Effect.ensuring(R.Effect.sleep(1))))
              : kind === "second_end_cleanup"
                ? group(
                    take,
                    seq(Q.end(owner).pipe(R.Effect.asVoid), take).pipe(
                      R.Effect.ensuring(R.Effect.sleep(1)),
                    ),
                  )
                : group(child, shutdown)
          ).pipe(R.Effect.catch(() => (kind === "handler" ? offer : R.Effect.void)));
        }),
      ),
    );
  for (const kind of [
    "cleanup",
    "source_cleanup",
    "second_take_cleanup",
    "second_end_cleanup",
    "branch",
    "handler",
    "source",
  ])
    expect(
      () => analyzeGeneratedQueueShutdownProfile(R.program({ work: invalid(kind) })),
      kind,
    ).toThrow();
}, 30000);

test("owned Shutdown reference preserves interruption and repeated Done", async () => {
  for (const name of Object.keys(functions).filter((name) => name !== "quiet")) {
    const plain = await observe(name, false);
    const framed = await observe(name, true);
    expect(framed.logs).toEqual(plain.logs);
    expect(plain.logs.some((log) => log === `recovered:${name}`)).toBe(
      name === "done" || name === "retained",
    );
    if (name.includes("cleanup")) expect(plain.logs).toContain(`cleanup:${name}:end`);
  }
  for (const name of ["take_cleanup", "retained"]) {
    const result = await observe(name, true, true);
    expect(result.logs).toContain(`cleanup:${name}:end`);
    expect(result.logs).not.toContain(`recovered:${name}`);
  }
});

test("official eager terminal cleanup requires registration before peer failure", async () => {
  for (const terminal of ["Shutdown", "End"] as const) {
    const logs: string[] = [];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const queue = yield* Queue.bounded<void, Cause.Done>(1);
        const close = terminal === "Shutdown" ? Queue.shutdown(queue) : Queue.end(queue);
        const finalizer = Effect.sync(() => logs.push("start")).pipe(
          Effect.andThen(Effect.sleep(10)),
          Effect.andThen(
            Effect.sync(() => {
              logs.push("end");
              finish();
            }),
          ),
        );
        const result = yield* Effect.all(
          [
            Queue.take(queue),
            close.pipe(Effect.andThen(Queue.take(queue)), Effect.ensuring(finalizer)),
          ],
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.exit);
        return { result, logs: [...logs] };
      }),
    );
    expect(Exit.isFailure(snapshot.result)).toBe(true);
    expect(snapshot.logs).toEqual(["start"]);
    await finished;
    expect(logs).toEqual(["start", "end"]);
  }
});

const allocator = String.raw`
use std::sync::atomic::{AtomicBool,AtomicUsize,AtomicIsize,Ordering};
struct Allocator;static TRACK:AtomicBool=AtomicBool::new(false);static ALLOCATIONS:AtomicUsize=AtomicUsize::new(0);static LIVE:AtomicIsize=AtomicIsize::new(0);
unsafe impl std::alloc::GlobalAlloc for Allocator{unsafe fn alloc(&self,l:std::alloc::Layout)->*mut u8{if TRACK.load(Ordering::Relaxed){ALLOCATIONS.fetch_add(1,Ordering::Relaxed);LIVE.fetch_add(1,Ordering::Relaxed);}std::alloc::System.alloc(l)}unsafe fn dealloc(&self,p:*mut u8,l:std::alloc::Layout){if TRACK.load(Ordering::Relaxed){LIVE.fetch_sub(1,Ordering::Relaxed);}std::alloc::System.dealloc(p,l)}}
#[global_allocator]static ALLOCATOR:Allocator=Allocator;
fn begin(){LIVE.store(0,Ordering::Relaxed);ALLOCATIONS.store(0,Ordering::Relaxed);TRACK.store(true,Ordering::Relaxed);}fn end()->usize{TRACK.store(false,Ordering::Relaxed);ALLOCATIONS.load(Ordering::Relaxed)}
async fn once<F:std::future::Future>(mut f:std::pin::Pin<&mut F>){std::future::poll_fn(|cx|{assert!(f.as_mut().poll(cx).is_pending());std::task::Poll::Ready(())}).await;}
`;
const ordinaryCases = ["eager", "reverse", "done", "take_cleanup", "retained"];
const canceled = ["take_cleanup", "retained"];
const harness = (framed: boolean) => `use reffect_generated as r;${allocator}
#[tokio::main(flavor="current_thread")]async fn main(){let(_tx,rx)=tokio::sync::watch::channel(false);let mut ctx=r::AsyncContext::new(rx);
${ordinaryCases.map((name) => `{let exit=r::r_${name}(&mut ctx).await;${name === "done" || name === "retained" ? `assert!(exit.is_ok(),"Recover ${name}");` : `assert!(matches!(exit,Err(r::AsyncError::Combined(cause)) if cause.interrupted && cause.first().is_none()),"Shutdown interrupts ${name}");`}${framed ? `let(frames,omitted)=ctx.take_frames();assert_eq!(omitted,0);for frame in frames{println!("FRAME:${name}:{}",frame);}` : ""}}`).join("\n")}
assert!(r::r_ordinary(&mut ctx).await.is_ok());assert!(r::r_local(&mut ctx).await.is_ok());assert!(r::r_fallible(&mut ctx).await.is_ok());
let layouts=r::reffect_queue_future_layouts(&mut ctx);assert!(layouts.iter().all(|size|*size<=20480));
let _=r::r_quiet(&mut ctx).await;${framed ? "let _=ctx.take_frames();" : ""}
begin();for _ in 0..100{let future=r::r_quiet(&mut ctx);std::hint::black_box(&future);drop(future);}let construction=end();assert_eq!(construction,0);
begin();for _ in 0..100{assert!(r::r_quiet(&mut ctx).await.is_ok());${framed ? "let _=ctx.take_frames();" : ""}}let execution=end();assert_eq!(LIVE.load(Ordering::Relaxed),0,"Shutdown trails released");assert_eq!(execution,${framed ? 100 : 0},"Quiet Shutdown masked timer cost");
${canceled.map((name) => `{let(tx,rx)=tokio::sync::watch::channel(false);let mut ctx=r::AsyncContext::new(rx);{let future=r::r_${name}(&mut ctx);tokio::pin!(future);once(future.as_mut()).await;tx.send(true).unwrap();match future.await{Err(r::AsyncError::Combined(cause))=>{assert!(cause.interrupted);assert_eq!(cause.first(),${name === "retained" ? "Some(r::RuntimeFailure::QueueDone)" : "None"},"Retained Done after Shutdown cancellation");},_=>panic!("Cancellation bypasses recovery")}}${framed ? `let(frames,omitted)=ctx.take_frames();assert_eq!(omitted,0);for frame in frames{println!("FRAME:cancel_${name}:{}",frame);}assert!(ctx.take_frames().0.is_empty());` : ""}}`).join("\n")}
println!("COST construction={construction} execution={execution} layouts={layouts:?}");println!("queue-shutdown-ok");}
`;

test(
  "generated Shutdown matches owned causes, trails, logs and quiet costs",
  async () => {
    const expectedLogs: string[] = [];
    const expectedFrames = new Map<string, readonly { path: string; kind: string }[]>();
    for (const name of ordinaryCases) {
      const plain = await observe(name, false);
      const framed = await observe(name, true);
      expect(framed.logs).toEqual(plain.logs);
      expectedLogs.push(...plain.logs);
      expectedFrames.set(name, framed.frames);
    }
    for (const name of canceled) {
      const plain = await observe(name, false, true);
      const framed = await observe(name, true, true);
      expect(framed.logs).toEqual(plain.logs);
      expectedLogs.push(...plain.logs);
      expectedFrames.set(`cancel_${name}`, framed.frames);
    }
    const directory = await mkdtemp(join(tmpdir(), "reffect-queue-shutdown-"));
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
            `Queue Shutdown ${artifacts._tag}/${frames._tag}: Rust bytes=${Buffer.byteLength(emitted.files["src/lib.rs"]!)}\n`,
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
            expect(result.stdout).toContain("queue-shutdown-ok");
            process.stdout.write(
              `Queue Shutdown ${artifacts._tag}/${frames._tag}/${release ? "release" : "debug"}: ${result.stdout.trim()}\n`,
            );
          }
        }
      const source = (
        await publicArtifact(R.program(mixed), SourceArtifacts.None, FailureFrames.Bounded)
      ).files["src/lib.rs"]!;
      for (const [mutated, reason] of [
        [
          source.replaceAll(".shutdown_exit().await", ".end_exit().await"),
          "Shutdown interrupts eager",
        ],
        [
          source.replaceAll(
            "Err(QueueTakeFailure::Done(done)) => Err((AsyncError::Fail(done),",
            "Err(QueueTakeFailure::Done(done)) => Err((AsyncError::Interrupted,",
          ),
          "Recover done",
        ],
        [
          source.replaceAll("drop(frames);", "std::mem::forget(frames);"),
          "Shutdown trails released",
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
