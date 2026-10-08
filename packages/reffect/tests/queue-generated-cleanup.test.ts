import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Cause, Context, Effect, Exit, Logger, Queue, Scheduler } from "effect";
import { expect, test } from "vite-plus/test";
import {
  Compile,
  FailureFrames,
  QueueCleanupExecution,
  QueueDoneType,
  R,
  Rust,
  SourceArtifacts,
} from "../src/index.ts";
import { Computation, PrivateEffectReference } from "../src/effect-ir.ts";
import type { EffectFn } from "../src/effect-ir.ts";
import { DeferredInterruptionFrames } from "../src/deferred-interruption-frames.ts";
import { QueueIR as Q } from "../src/queue.ts";
import { analyzeGeneratedQueueCleanupProfile } from "../src/queue-generated-profile.ts";
import {
  emitFunctions,
  lowerFunctions,
  lowerQueueDoneFunctions,
  lowerQueueFallibleFunctions,
  lowerQueueCleanupFunctions,
} from "../src/lower.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const selected = new Map(Rust.std.implementations.map((item) => [item.operation.ref, item]));
const group = <E, E2>(a: Computation<void, E>, b: Computation<void, E2>) =>
  R.Effect.all([a, b], { concurrency: "unbounded", discard: true });
const seq = <E>(...steps: Computation<void, E>[]) =>
  steps.reduce((a, b) => a.pipe(R.Effect.andThen(b)), R.Effect.void as Computation<void, E>);
const make = (kind: string) =>
  R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) => {
        const take = R.Queue.take(owner);
        const end = R.Queue.end(owner).pipe(R.Effect.asVoid);
        const finalizer =
          kind === "quiet"
            ? R.Effect.sleep(1)
            : seq(
                R.Log.info(`cleanup:${kind}:start`),
                R.Effect.sleep(1),
                R.Log.info(`cleanup:${kind}:end`),
              );
        const completed = seq(end, take).pipe(R.Effect.ensuring(finalizer));
        const source =
          kind === "success"
            ? group(
                R.Effect.void.pipe(R.Effect.ensuring(finalizer)),
                seq(R.Queue.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid), end, take),
              )
            : kind === "successful_cancel"
              ? group(R.Effect.void.pipe(R.Effect.ensuring(finalizer)), take)
              : kind === "blocked"
                ? group(take.pipe(R.Effect.ensuring(finalizer)), R.Effect.void)
                : kind === "unopened"
                  ? group(seq(end, take), R.Effect.void.pipe(R.Effect.ensuring(finalizer)))
                  : kind === "sticky" || kind === "retained_peer"
                    ? group(R.Effect.void.pipe(R.Effect.ensuring(finalizer)), seq(end, take))
                    : kind === "shared"
                      ? group(
                          take.pipe(R.Effect.ensuring(finalizer)),
                          R.Effect.void.pipe(R.Effect.ensuring(finalizer)),
                        )
                      : group(completed, R.Effect.void);
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
    "success",
    "done",
    "unopened",
    "sticky",
    "shared",
    "quiet",
    "retained",
    "retained_peer",
    "successful_cancel",
    "blocked",
  ].map((kind) => [kind, make(kind)]),
);
const mixed = {
  ...functions,
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
  old_fallible: R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        group(R.Queue.take(owner), R.Queue.end(owner).pipe(R.Effect.asVoid)).pipe(
          R.Effect.catch(() => R.Effect.void),
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
    emitFunctions(lowerQueueCleanupFunctions(program, selected, artifacts, frames)).files,
  );
  return artifact;
};
const checked = (fn: EffectFn) => {
  expect(analyzeGeneratedQueueCleanupProfile(R.program({ work: fn })).has(fn)).toBe(true);
  return [];
};
const observe = async (name: string, framed: boolean, cancel = false) => {
  const fn = functions[name]!;
  const logs: string[] = [];
  let logsAtExit: string[] | undefined;
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
  const computation: Effect.Effect<Exit.Exit<void, unknown>, unknown> = framed
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
  const pending = Effect.runPromiseExitWith(context)(
    computation.pipe(
      Effect.onExit(() =>
        Effect.sync(() => {
          logsAtExit = [...logs];
        }),
      ),
    ),
    { signal: controller.signal },
  );
  if (cancel && (name === "blocked" || name === "shared")) queueMicrotask(() => controller.abort());
  const outer = await pending;
  const exit = Exit.isSuccess(outer) ? outer.value : outer;
  if (cancel) {
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    }
  } else expect(Exit.isSuccess(exit)).toBe(true);
  let trail: readonly { readonly path: string; readonly kind: string }[] = frames.snapshot().frames;
  if (cancel && (name === "retained" || name === "retained_peer") && Exit.isFailure(exit)) {
    const retained = exit.cause.reasons.find(Cause.isFailReason);
    expect(retained, "Actual parent cancellation retains Done").toBeDefined();
    const reason = retained?.error as unknown as { _tag: string; error?: { _tag: string } };
    expect(framed ? reason.error?._tag : reason._tag).toBe("Done");
    if (framed) {
      const domain = retained?.error as unknown as {
        frames: readonly { path: string; kind: string }[];
      };
      expect(domain.frames.map((frame) => frame.kind)).toEqual(["queueTake", "flatMap"]);
      // External cancellation interrupts the reference's framed wrapper before its
      // post-mask mapError handlers run. Preserve the observed source prefix and
      // normalize the statically owned restoration boundaries to native policy.
      trail = [
        ...domain.frames,
        ...(name === "retained"
          ? [{ path: `functions.${name}.body.body.source.children[0]`, kind: "ensuring" }]
          : []),
        ...trail,
      ];
    }
  }
  if (framed && cancel && name === "retained_peer")
    expect(trail.map((frame) => frame.kind)).toEqual([
      "queueTake",
      "flatMap",
      "all",
      "catchAll",
      "queueScope",
      "function",
    ]);
  expect(
    logsAtExit,
    "Function exit captures cleanup before outer child-scope retirement",
  ).toBeDefined();
  expect(logs, "Outer scope must not append cleanup after function exit").toEqual(logsAtExit);
  return { logs: logsAtExit!, frames: trail };
};

test("public cleanup is admitted only through its checked Queue profile", async () => {
  expect(analyzeGeneratedQueueCleanupProfile(R.program(mixed)).size).toBe(13);
  const old = R.program({
    ordinary: mixed.ordinary,
    local: mixed.local,
    old_fallible: mixed.old_fallible,
  });
  for (const artifacts of [SourceArtifacts.None, SourceArtifacts.Full])
    for (const frames of [FailureFrames.None, FailureFrames.Bounded])
      expect(emitFunctions(lowerQueueCleanupFunctions(old, selected, artifacts, frames))).toEqual(
        emitFunctions(lowerQueueFallibleFunctions(old, selected, artifacts, frames)),
      );
  for (const artifacts of [SourceArtifacts.None, SourceArtifacts.Full])
    for (const frames of [FailureFrames.None, FailureFrames.Bounded])
      await publicArtifact(R.program(mixed), artifacts, frames);
  for (const lower of [lowerFunctions, lowerQueueDoneFunctions, lowerQueueFallibleFunctions])
    expect(() => lower(R.program({ work: functions.done! }), selected)).toThrow();
  const invalid = (cleanup: Computation<void>, nested = false, sourceSleep = false) =>
    R.fn([], R.Unit, R.Never, () =>
      Q.bounded(R.Unit, 1, QueueDoneType).pipe(
        R.Effect.flatMap((owner) => {
          const take = Q.take(owner);
          const source = sourceSleep ? seq(R.Effect.sleep(1), take) : take;
          const child = source.pipe(R.Effect.ensuring(cleanup));
          return group(
            nested ? child.pipe(R.Effect.ensuring(R.Effect.void)) : child,
            Q.end(owner).pipe(R.Effect.asVoid),
          ).pipe(R.Effect.catch(() => R.Effect.void));
        }),
      ),
    );
  for (const fn of [
    invalid(R.Effect.void, true),
    invalid(R.Effect.void, false, true),
    invalid(R.Effect.sleep(0)),
    invalid(Computation.make(R.Unit, R.Never, { _tag: "Sleep", milliseconds: 60001 })),
  ])
    expect(() => analyzeGeneratedQueueCleanupProfile(R.program({ work: fn }))).toThrow();
  const queueCleanup = R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap((owner) =>
        group(
          Q.take(owner).pipe(R.Effect.ensuring(Q.end(owner).pipe(R.Effect.asVoid))),
          Q.end(owner).pipe(R.Effect.asVoid),
        ).pipe(R.Effect.catch(() => R.Effect.void)),
      ),
    ),
  );
  expect(() => analyzeGeneratedQueueCleanupProfile(R.program({ work: queueCleanup }))).toThrow();
  for (const terminalSource of [false, true]) {
    const eagerCleanup = R.fn([], R.Unit, R.Never, () =>
      Q.bounded(R.Unit, 1, QueueDoneType).pipe(
        R.Effect.flatMap((owner) => {
          const take = Q.take(owner);
          const end = Q.end(owner).pipe(R.Effect.asVoid);
          const producer = seq(
            Q.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid),
            Q.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid),
            end,
            take,
            take,
          );
          return group(
            terminalSource ? take : producer,
            (terminalSource ? seq(end, take) : take).pipe(R.Effect.ensuring(R.Effect.sleep(1))),
          ).pipe(R.Effect.catch(() => R.Effect.void));
        }),
      ),
    );
    expect(() => analyzeGeneratedQueueCleanupProfile(R.program({ work: eagerCleanup }))).toThrow();
  }
}, 30000);

test("official eager peer failure can return All before unregistered cleanup settles", async () => {
  const logs: string[] = [];
  let completed!: () => void;
  const cleanupCompleted = new Promise<void>((resolve) => {
    completed = resolve;
  });
  const atAll = await Effect.runPromise(
    Effect.gen(function* () {
      const queue = yield* Queue.bounded<void, Cause.Done>(1);
      const log = (message: string) =>
        Effect.sync(() => {
          logs.push(message);
          if (message === "end") completed();
        });
      const take = Queue.take(queue);
      const cleanup = log("start").pipe(
        Effect.andThen(Effect.sleep(1)),
        Effect.andThen(log("end")),
      );
      const producer = Queue.offer(queue, undefined).pipe(
        Effect.andThen(Queue.offer(queue, undefined)),
        Effect.andThen(Queue.end(queue)),
        Effect.andThen(take),
        Effect.andThen(take),
      );
      const exit = yield* Effect.exit(
        Effect.all([producer, take.pipe(Effect.ensuring(cleanup))], {
          concurrency: "unbounded",
          discard: true,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterrupts(exit.cause)).toBe(false);
        const failures = exit.cause.reasons.filter(Cause.isFailReason);
        expect(failures).toHaveLength(1);
        expect(failures[0]!.error._tag).toBe("Done");
      }
      return [...logs];
    }),
  );
  expect(atAll, "All returns while the eager child is absent from its observer set").toEqual([
    "start",
  ]);
  await cleanupCompleted;
  expect(
    logs,
    "A mutable log alias hides premature All settlement when cleanup later runs",
  ).toEqual(["start", "end"]);
});

test("owned Queue cleanup reference settles masked cancellation", async () => {
  let sibling: Exit.Exit<void, never> | undefined;
  const official = await Effect.runPromise(
    Effect.gen(function* () {
      const queue = yield* Queue.bounded<void, Cause.Done>(1);
      return yield* Effect.all(
        [
          Effect.void.pipe(
            Effect.ensuring(Effect.sleep(1)),
            Effect.onExit((exit) =>
              Effect.sync(() => {
                sibling = exit;
              }),
            ),
          ),
          Queue.end(queue).pipe(Effect.andThen(Queue.take(queue))),
        ],
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.exit);
    }),
  );
  expect(
    sibling && Exit.isFailure(sibling) && Cause.hasInterruptsOnly(sibling.cause),
    "Registered successful sibling is interrupted after masked cleanup",
  ).toBe(true);
  expect(Exit.isFailure(official)).toBe(true);
  for (const name of ["success", "done", "unopened", "sticky"]) {
    const observed = await observe(name, true);
    expect(observed.frames).toEqual([]);
    const plain = await QueueCleanupExecution.run(functions[name]!);
    expect(plain.exit).toEqual(Exit.succeed(undefined));
    expect(plain.logs).toEqual(observed.logs);
    expect(Object.isFrozen(plain.logs)).toBe(true);
    const framed = await QueueCleanupExecution.runWithFrames(functions[name]!);
    expect(framed.exit).toEqual(
      Exit.succeed({ exit: Exit.succeed(undefined), frames: [], omitted: 0 }),
    );
    expect(framed.logs).toEqual(observed.logs);
    expect(Object.isFrozen(framed.logs)).toBe(true);
  }
  for (const name of ["retained", "retained_peer", "successful_cancel", "blocked", "shared"]) {
    const observed = await observe(name, true, true);
    checkCancellationLogs(name, observed.logs);
    expect(observed.frames.length).toBeGreaterThan(0);
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
const successful = ["success", "done", "unopened", "sticky"];
const canceled = ["retained", "retained_peer", "successful_cancel", "blocked", "shared"];
const checkCancellationLogs = (name: string, logs: readonly string[]) => {
  if (name === "shared") {
    expect(logs).toHaveLength(4);
    expect(logs.filter((message) => message === `cleanup:${name}:start`)).toHaveLength(2);
    expect(logs.filter((message) => message === `cleanup:${name}:end`)).toHaveLength(2);
  } else expect(logs).toEqual([`cleanup:${name}:start`, `cleanup:${name}:end`]);
};
const harness = (framed: boolean) => `use reffect_generated as r;${allocator}
#[tokio::main(flavor="current_thread")]async fn main(){
 let(_tx,rx)=tokio::sync::watch::channel(false);let mut ctx=r::AsyncContext::new(rx);
 ${successful.map((name) => `assert!(r::r_${name}(&mut ctx).await.is_ok(),"Recover ${name}");`).join("\n")}
 assert!(r::r_ordinary(&mut ctx).await.is_ok());assert!(r::r_local(&mut ctx).await.is_ok());assert!(r::r_old_fallible(&mut ctx).await.is_ok());
 let layouts=r::reffect_queue_future_layouts(&mut ctx);assert!(layouts.iter().all(|size|*size<=20480));
 assert!(r::r_quiet(&mut ctx).await.is_ok());
 begin();for _ in 0..100{let future=r::r_quiet(&mut ctx);std::hint::black_box(&future);drop(future);}let construction=end();assert_eq!(construction,0);
 begin();for _ in 0..100{assert!(r::r_quiet(&mut ctx).await.is_ok());}let execution=end();assert_eq!(LIVE.load(Ordering::Relaxed),0,"Cleanup releases handled trails");assert_eq!(execution,${framed ? 100 : 0},"Quiet masked timer cost");
 ${canceled.map((name) => `{let(tx,rx)=tokio::sync::watch::channel(false);let mut ctx=r::AsyncContext::new(rx);{let future=r::r_${name}(&mut ctx);tokio::pin!(future);once(future.as_mut()).await;tx.send(true).unwrap();match future.await{Err(r::AsyncError::Combined(cause))=>{assert!(cause.interrupted,"Parent cancellation survives cleanup ${name}");assert_eq!(cause.first(),${name === "retained" || name === "retained_peer" ? "Some(r::RuntimeFailure::QueueDone)" : "None"},"Retained source outcome ${name}");},_=>panic!("Cancellation bypasses recovery ${name}")}}${framed ? `let(frames,omitted)=ctx.take_frames();assert_eq!(omitted,0);for frame in frames{println!("FRAME:${name}:{}",frame);}assert!(ctx.take_frames().0.is_empty());` : ""}}`).join("\n")}
 println!("COST construction={construction} execution={execution} layouts={layouts:?}");println!("queue-cleanup-ok");}
`;

test(
  "generated Queue cleanup matches owned Effect cancellation, trails and costs",
  async () => {
    const expectedLogs: string[] = [];
    const expectedFrames = new Map<
      string,
      readonly { readonly path: string; readonly kind: string }[]
    >();
    for (const name of successful) {
      const plain = await observe(name, false);
      const framed = await observe(name, true);
      expect(framed.logs).toEqual(plain.logs);
      expect(framed.frames).toEqual([]);
      expectedLogs.push(...plain.logs);
    }
    for (const name of canceled) {
      const plain = await observe(name, false, true);
      const framed = await observe(name, true, true);
      expect(framed.logs).toEqual(plain.logs);
      checkCancellationLogs(name, plain.logs);
      expectedLogs.push(...plain.logs);
      expectedFrames.set(
        name,
        framed.frames.map(({ path, kind }) => ({ path, kind })),
      );
    }
    const directory = await mkdtemp(join(tmpdir(), "reffect-queue-cleanup-"));
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
            `Queue cleanup ${artifacts._tag}/${frames._tag}: Rust bytes=${Buffer.byteLength(emitted.files["src/lib.rs"]!)}\n`,
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
            for (const name of canceled) {
              const prefix = `FRAME:${name}:`;
              const trail = result.stdout
                .split("\n")
                .filter((line) => line.startsWith(prefix))
                .map((line) => {
                  const { path, kind } = JSON.parse(line.slice(prefix.length)) as {
                    path: string;
                    kind: string;
                  };
                  return { path, kind };
                });
              expect(trail, name).toEqual(
                FailureFrames.isNone(frames) ? [] : expectedFrames.get(name),
              );
            }
            expect(result.stdout).toContain("queue-cleanup-ok");
            process.stdout.write(
              `Queue cleanup ${artifacts._tag}/${frames._tag}/${release ? "release" : "debug"}: ${result.stdout.trim()}\n`,
            );
          }
        }
      const source = (await publicArtifact(R.program(mixed))).files["src/lib.rs"]!;
      const boundary = "let cause = driver.all_cause(interrupted);";
      const audited = source.replaceAll(
        boundary,
        `${boundary}if bridge.interrupted[0].get() { assert_ne!(driver.outcomes[0].get(), Some(Ok(())), "Sticky child cancellation survives cleanup"); }`,
      );
      expect(audited).not.toBe(source);
      await writeFile(join(directory, "src/lib.rs"), audited);
      await writeFile(
        join(directory, "src/main.rs"),
        `#![recursion_limit="256"]\n${harness(true)}`,
      );
      await execute();
      for (const [mutated, reason] of [
        [
          audited.replaceAll(
            "let saved_interruptible = ctx.interruptible; ctx.interruptible = false; let cleanup =",
            "let saved_interruptible = ctx.interruptible; let cleanup =",
          ),
          "Non-failing masked finalizer returned an error",
        ],
        [
          audited.replaceAll(
            ' || { let task = queue_task.expect("Checked Queue cleanup task"); task.bridge.interrupted[task.task].get() }',
            "",
          ),
          "Sticky child cancellation survives cleanup",
        ],
        [
          audited.replaceAll(
            "Err(QueueTakeFailure::Done(done)) => Err((AsyncError::Fail(done),",
            "Err(QueueTakeFailure::Done(done)) => Err((AsyncError::Interrupted,",
          ),
          "Recover done",
        ],
        [
          audited.replaceAll("drop(frames);", "std::mem::forget(frames);"),
          "Cleanup releases handled trails",
        ],
      ] as const) {
        expect(mutated).not.toBe(audited);
        await writeFile(join(directory, "src/lib.rs"), mutated);
        await expect(execute()).rejects.toMatchObject({ stderr: expect.stringContaining(reason) });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  // Eight fresh configurations plus four failing binaries exceeded seven minutes
  // on the shared runner; each Cargo invocation still has its own 180s limit.
  nativeTestBudget(4) + 480000,
);
