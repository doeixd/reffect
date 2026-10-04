import { Cause, Deferred, Effect, Exit, Fiber, Logger } from "effect";
import { TestClock } from "effect/testing";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";
import { FailureFrames, R, Reference, SourceArtifacts } from "../src/index.ts";
import type { EffectFn } from "../src/index.ts";
import { DeferredIR } from "../src/deferred.ts";
import { emitFunctions, lowerDeferredFunctions } from "../src/lower.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const execute = promisify(execFile);
const options = { concurrency: "unbounded", discard: true } as const;
const cleanup = (name: string) =>
  R.Log.info(`${name}:cleanup:start`).pipe(
    R.Effect.andThen(R.Effect.sleep(20)),
    R.Effect.andThen(R.Log.info(`${name}:cleanup:done`)),
  );
const programs = {
  retained: R.fn([], R.U64, R.Never, () =>
    R.Effect.flatMap(DeferredIR.make(R.U64), (cell) =>
      DeferredIR.succeed(cell, R.U64.literal(7n)).pipe(
        R.Effect.flatMap((first) =>
          R.Match.bool(first, R.Log.info("first:true"), R.Log.info("first:false")),
        ),
        R.Effect.andThen(DeferredIR.succeed(cell, R.U64.literal(9n))),
        R.Effect.flatMap((second) =>
          R.Match.bool(second, R.Log.info("second:true"), R.Log.info("second:false")),
        ),
        R.Effect.andThen(DeferredIR.await(cell)),
      ),
    ),
  ),
  bool: R.fn([], R.Bool, R.Never, () =>
    R.Effect.flatMap(DeferredIR.make(R.Bool), (cell) =>
      DeferredIR.succeed(cell, R.Bool.literal(true)).pipe(R.Effect.andThen(DeferredIR.await(cell))),
    ),
  ),
  unit: R.fn([], R.Unit, R.Never, () =>
    R.Effect.flatMap(DeferredIR.make(R.Unit), (cell) =>
      DeferredIR.succeed(cell, R.Unit.literal()).pipe(R.Effect.andThen(DeferredIR.await(cell))),
    ),
  ),
  ordered: R.fn([], R.Unit, R.Never, () =>
    R.Effect.flatMap(DeferredIR.make(R.U64), (cell) =>
      R.Effect.all(
        [
          DeferredIR.await(cell).pipe(
            R.Effect.andThen(R.Log.info("w1:prefix")),
            R.Effect.andThen(R.Effect.sleep(20)),
            R.Effect.andThen(R.Log.info("w1:after-timer")),
          ),
          DeferredIR.await(cell).pipe(R.Effect.andThen(R.Log.info("w2:prefix"))),
          DeferredIR.succeed(cell, R.U64.literal(7n)).pipe(
            R.Effect.andThen(R.Log.info("producer:after-complete")),
          ),
        ],
        options,
      ),
    ),
  ),
  cancel: R.fn([], R.Unit, R.Never, () =>
    R.Effect.flatMap(DeferredIR.make(R.Unit), (cell) =>
      R.Effect.all(
        [
          R.Log.info("w1:start").pipe(
            R.Effect.andThen(DeferredIR.await(cell)),
            R.Effect.ensuring(cleanup("w1")),
          ),
          R.Log.info("w2:start").pipe(
            R.Effect.andThen(DeferredIR.await(cell)),
            R.Effect.ensuring(cleanup("w2")),
          ),
        ],
        options,
      ),
    ),
  ),
};
type Scenario = keyof typeof programs;
const scenarios = Object.keys(programs) as Scenario[];
// Independently authored official effects do not inspect or interpret R graphs.
const oracles = {
  retained: () =>
    Effect.gen(function* () {
      const cell = yield* Deferred.make<bigint>();
      yield* Effect.logInfo((yield* Deferred.succeed(cell, 7n)) ? "first:true" : "first:false");
      yield* Effect.logInfo((yield* Deferred.succeed(cell, 9n)) ? "second:true" : "second:false");
      return yield* Deferred.await(cell);
    }),
  bool: () =>
    Effect.gen(function* () {
      const cell = yield* Deferred.make<boolean>();
      yield* Deferred.succeed(cell, true);
      return yield* Deferred.await(cell);
    }),
  unit: () =>
    Effect.gen(function* () {
      const cell = yield* Deferred.make<void>();
      yield* Deferred.succeed(cell, undefined);
      return yield* Deferred.await(cell);
    }),
  ordered: () =>
    Effect.gen(function* () {
      const cell = yield* Deferred.make<bigint>();
      yield* Effect.all(
        [
          Deferred.await(cell).pipe(
            Effect.andThen(Effect.logInfo("w1:prefix")),
            Effect.andThen(Effect.sleep(20)),
            Effect.andThen(Effect.logInfo("w1:after-timer")),
          ),
          Deferred.await(cell).pipe(Effect.andThen(Effect.logInfo("w2:prefix"))),
          Deferred.succeed(cell, 7n).pipe(
            Effect.andThen(Effect.logInfo("producer:after-complete")),
          ),
        ],
        options,
      );
    }),
  cancel: () =>
    Effect.gen(function* () {
      const cell = yield* Deferred.make<void>();
      yield* Effect.all(
        ["w1", "w2"].map((name) =>
          Effect.logInfo(`${name}:start`).pipe(
            Effect.andThen(Deferred.await(cell)),
            Effect.ensuring(
              Effect.logInfo(`${name}:cleanup:start`).pipe(
                Effect.andThen(Effect.sleep(20)),
                Effect.andThen(Effect.logInfo(`${name}:cleanup:done`)),
              ),
            ),
          ),
        ),
        options,
      );
    }),
};
interface Observation {
  events: string[];
  result: string;
}
const observe = (body: Effect.Effect<unknown, unknown>, cancel: boolean): Promise<Observation> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events: string[] = [];
        const logger = Logger.layer([Logger.make((event) => events.push(String(event.message)))]);
        const fiber = yield* body.pipe(Effect.provide(logger), Effect.forkScoped);
        yield* TestClock.adjust(0);
        if (cancel) {
          expect(events).toEqual(["w1:start", "w2:start"]);
          fiber.interruptUnsafe();
        }
        yield* TestClock.adjust(100);
        const exit = yield* Fiber.await(fiber);
        return {
          events,
          result: Exit.isSuccess(exit)
            ? String(exit.value)
            : Cause.hasInterrupts(exit.cause)
              ? "Interrupted"
              : "Failure",
        };
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
const expected: Record<Scenario, Observation> = {
  retained: { events: ["first:true", "second:false"], result: "7" },
  bool: { events: [], result: "true" },
  unit: { events: [], result: "undefined" },
  ordered: {
    events: ["w1:prefix", "w2:prefix", "producer:after-complete", "w1:after-timer"],
    result: "undefined",
  },
  cancel: {
    events: [
      "w1:start",
      "w2:start",
      "w1:cleanup:start",
      "w2:cleanup:start",
      "w1:cleanup:done",
      "w2:cleanup:done",
    ],
    result: "Interrupted",
  },
};

test("generated-profile Deferred fixtures match independent official and both references", async () => {
  for (const scenario of scenarios) {
    expect(await observe(oracles[scenario](), scenario === "cancel")).toEqual(expected[scenario]);
    const fn: EffectFn<readonly [], unknown, never> = programs[scenario];
    for (const body of [
      Reference.run(fn, []),
      Reference.runWithFrames(fn, []).pipe(Effect.flatMap((result) => result.exit)),
    ])
      expect(await observe(body, scenario === "cancel")).toEqual(expected[scenario]);
  }
});

const harness = `
use reffect_generated as r;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool,AtomicUsize,Ordering};
struct Meter;
static METER_ON:AtomicBool=AtomicBool::new(false);
static ALLOCATIONS:AtomicUsize=AtomicUsize::new(0);
#[global_allocator] static ALLOCATOR:Meter=Meter;
unsafe impl std::alloc::GlobalAlloc for Meter {
 unsafe fn alloc(&self,layout:std::alloc::Layout)->*mut u8 {
  if METER_ON.load(Ordering::Relaxed){ALLOCATIONS.fetch_add(1,Ordering::Relaxed);}
  std::alloc::System.alloc(layout)
 }
 unsafe fn dealloc(&self,pointer:*mut u8,layout:std::alloc::Layout){std::alloc::System.dealloc(pointer,layout)}
}
async fn once<F:Future>(mut future:Pin<&mut F>)->Option<F::Output>{
 std::future::poll_fn(|cx|std::task::Poll::Ready(match future.as_mut().poll(cx){
  std::task::Poll::Ready(output)=>Some(output),std::task::Poll::Pending=>None
 })).await
}
async fn drive<F:Future>(future:F,sender:&tokio::sync::watch::Sender<bool>,cancel:bool)->F::Output{
 println!("future-size={}",std::mem::size_of_val(&future));
 tokio::pin!(future);
 ALLOCATIONS.store(0,Ordering::Relaxed);METER_ON.store(true,Ordering::Relaxed);
 let mut result=once(future.as_mut()).await;
 if cancel{assert!(result.is_none(),"waiters must be pending before cancellation");sender.send(true).unwrap();result=once(future.as_mut()).await;}
 tokio::time::advance(std::time::Duration::from_millis(100)).await;
 let output=match result{Some(output)=>output,None=>future.await};
 METER_ON.store(false,Ordering::Relaxed);println!("invocation-allocations={}",ALLOCATIONS.load(Ordering::Relaxed));
 output
}
fn report<A:std::fmt::Debug>(result:Result<A,r::AsyncError<std::convert::Infallible>>){
 match result{Ok(value)=>println!("result={:?}",value),Err(r::AsyncError::Interrupted)=>println!("result=Interrupted"),other=>panic!("Unexpected result: {:?}",other)}
}
#[tokio::main(flavor="current_thread")]
async fn main(){
 tokio::time::pause();
 let scenario=std::env::args().nth(1).unwrap();
 let(sender,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 if scenario=="cost-bool"{
  let baseline=r::r_bool(&mut ctx);
  println!("bool-future-size={}",std::mem::size_of_val(&baseline));
  drop(baseline);
  ALLOCATIONS.store(0,Ordering::Relaxed);METER_ON.store(true,Ordering::Relaxed);
  for _ in 0..100{assert_eq!(r::r_bool(&mut ctx).await.unwrap(),true);}
  METER_ON.store(false,Ordering::Relaxed);
  let count=ALLOCATIONS.load(Ordering::Relaxed);
  println!("bool-100-allocations={}",count);
  assert_eq!(count,0,"quiet sequential generated owner invocations must allocate nothing");
  return;
 }
 println!("context-size={}",std::mem::size_of_val(&ctx));
 match scenario.as_str(){
 ${scenarios.map((name) => `"${name}"=>report(drive(r::r_${name}(&mut ctx),&sender,${name === "cancel"}).await),`).join("\n")}
 _=>panic!("unknown scenario")
 }
 FRAME_PROBE
}
`;

test(
  "actual generated Deferred owners and helpers preserve native debug/release and frame policies",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "reffect-deferred-generated-"));
    try {
      for (const policy of [FailureFrames.None, FailureFrames.Bounded]) {
        const root = join(directory, policy._tag);
        const emitted = emitFunctions(
          lowerDeferredFunctions(R.program(programs), new Map(), SourceArtifacts.None, policy),
        );
        for (const [path, content] of Object.entries(emitted.files)) {
          await mkdir(dirname(join(root, path)), { recursive: true });
          await writeFile(join(root, path), content);
        }
        const manifest = await readFile(join(root, "Cargo.toml"), "utf8");
        await writeFile(
          join(root, "Cargo.toml"),
          manifest.replace('"macros",', '"test-util", "macros",'),
        );
        await writeFile(
          join(root, "src/main.rs"),
          harness.replace(
            "FRAME_PROBE",
            policy._tag === "None"
              ? 'println!("frames=0");'
              : 'println!("frames={}",ctx.take_frames().0.len());',
          ),
        );
        for (const profile of ["debug", "release"] as const) {
          await execute(
            "cargo",
            ["build", "--offline", "--quiet", ...(profile === "release" ? ["--release"] : [])],
            {
              cwd: root,
              timeout: 120000,
              env: { ...process.env, CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0" },
            },
          );
          const measured = await execute(
            join(root, "target", profile, "reffect_generated"),
            ["cost-bool"],
            { cwd: root, timeout: 15000 },
          );
          expect(Number(measured.stdout.match(/bool-100-allocations=(\d+)/)?.[1])).toBe(0);
          console.info(
            `Deferred quiet costs ${policy._tag}/${profile}: ${measured.stdout.trim().replaceAll("\n", ", ")}`,
          );
          for (const scenario of scenarios) {
            const { stdout, stderr } = await execute(
              join(root, "target", profile, "reffect_generated"),
              [scenario],
              { cwd: root, timeout: 15000 },
            );
            const events = stderr
              .split("\n")
              .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
              .map((line) => (JSON.parse(line) as { message: string }).message);
            const rawResult = stdout.match(/^result=(.+)$/m)?.[1];
            expect({ events, result: rawResult === "()" ? "undefined" : rawResult }).toEqual(
              expected[scenario],
            );
            expect(Number(stdout.match(/future-size=(\d+)/)?.[1])).toBeGreaterThan(0);
            expect(Number(stdout.match(/context-size=(\d+)/)?.[1])).toBeGreaterThan(0);
            const allocations = Number(stdout.match(/invocation-allocations=(\d+)/)?.[1]);
            expect(Number.isSafeInteger(allocations)).toBe(true);
            console.info(
              `Deferred costs ${policy._tag}/${profile}/${scenario}: ${stdout
                .split("\n")
                .filter((line) => /^(future-size|context-size|invocation-allocations)=/.test(line))
                .join(", ")}`,
            );
            const frames = Number(stdout.match(/frames=(\d+)/)?.[1]);
            if (policy._tag === "None") expect(frames).toBe(0);
            else if (scenario === "cancel") expect(frames).toBeGreaterThan(0);
          }
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(0) + 180000,
);
