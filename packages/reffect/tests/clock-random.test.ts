import { Cause, Clock, Effect, Exit, Random, Schedule, FileSystem, Fiber, Logger } from "effect";
import { NodeServices } from "@effect/platform-node";
import {
  CargoApi,
  Compile,
  type Computation,
  FailureFrames,
  NativeRunner,
  R,
  Reference,
  Rust,
  SourceArtifacts,
} from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { expect, expectTypeOf, test } from "vite-plus/test";

interface Script {
  readonly clock: readonly number[];
  readonly random: readonly number[];
}
const withOracleServices = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  script: Script,
  validate = true,
) =>
  Effect.gen(function* () {
    const live = yield* Clock.Clock;
    let clockIndex = 0;
    let randomIndex = 0;
    const read = (values: readonly number[], index: number, name: string): number => {
      if (index >= values.length) throw new Error(`${name} script exhausted`);
      const value = values[index];
      if (validate && !Number.isFinite(value)) throw new Error(`${name} script invalid`);
      return value;
    };
    const clock: Clock.Clock = {
      currentTimeMillis: Effect.sync(() => {
        const value = read(script.clock, clockIndex++, "clock");
        if (validate && (!Number.isInteger(value) || !Number.isSafeInteger(value)))
          throw new Error("clock script invalid");
        return value;
      }),
      currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe(),
      currentTimeNanos: live.currentTimeNanos,
      currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
      monotonicTimeNanos: live.monotonicTimeNanos,
      monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
      sleep: (duration) => live.sleep(duration),
    };
    const random: Random.Random = {
      nextDoubleUnsafe: () => {
        const value = read(script.random, randomIndex++, "random");
        if (validate && (value < 0 || value >= 1)) throw new Error("random script invalid");
        return value;
      },
      nextIntUnsafe: () => {
        throw new Error("nextInt outside admitted oracle profile");
      },
    };
    const value = yield* effect.pipe(
      Effect.provideService(Clock.Clock, clock),
      Effect.provideService(Random.Random, random),
    );
    return { value, clockIndex, randomIndex };
  });

test("official Clock observer reads and Random Boolean threshold define the oracle", async () => {
  const action = Effect.gen(function* () {
    const service = yield* Clock.Clock;
    service.currentTimeMillisUnsafe();
    service.currentTimeNanosUnsafe();
    const first = yield* Clock.currentTimeMillis;
    yield* Effect.sleep("1 millis");
    const second = yield* Clock.currentTimeMillis;
    const draws: boolean[] = [];
    for (let i = 0; i < 5; i++) draws.push(yield* Random.nextBoolean);
    return { first, second, draws };
  });
  expect(
    await Effect.runPromise(
      withOracleServices(action, {
        clock: [100, 90],
        random: [
          0,
          0.5,
          0.5 - Number.EPSILON / 2,
          0.5 + Number.EPSILON / 2,
          1 - Number.EPSILON / 2,
        ],
      }),
    ),
  ).toEqual({
    value: { first: 100, second: 90, draws: [false, false, false, true, true] },
    clockIndex: 2,
    randomIndex: 5,
  });
  const invalid = await Effect.runPromise(
    Effect.exit(withOracleServices(Random.next, { clock: [], random: [1] })),
  );
  expect(Exit.isFailure(invalid) && Cause.hasDies(invalid.cause)).toBe(true);
});

const ordered = R.fn([R.Bool], R.Number, R.Never, (branch) =>
  R.Clock.currentTimeMillis.pipe(
    R.Effect.flatMap((first) => {
      return R.Random.next.pipe(
        R.Effect.flatMap((draw) => {
          return R.Random.nextBoolean.pipe(
            R.Effect.flatMap((flag) => {
              const selected = R.Clock.currentTimeMillis.pipe(
                R.Effect.flatMap((second) =>
                  R.Random.next.pipe(
                    R.Effect.map((last) =>
                      R.Number.add(R.Number.add(first, second), R.Number.add(draw, last)),
                    ),
                  ),
                ),
              );
              const other = R.Random.next.pipe(
                R.Effect.map((last) => R.Number.add(first, R.Number.add(draw, last))),
              );
              return R.Match.bool(branch, selected, other).pipe(
                R.Effect.flatMap((subtotal) =>
                  R.Clock.currentTimeMillis.pipe(
                    R.Effect.map((lastClock) =>
                      R.Number.add(
                        R.Number.add(subtotal, lastClock),
                        R.Match.bool(flag, R.Number.literal(1), R.Number.literal(0)),
                      ),
                    ),
                  ),
                ),
              );
            }),
          );
        }),
      );
    }),
  ),
);
const repeated = R.fn([], R.Number, R.Never, () =>
  R.Clock.currentTimeMillis.pipe(
    R.Effect.andThen(R.Random.next),
    R.Effect.asVoid,
    R.Effect.repeat({ schedule: R.Schedule.recurs(2) }),
    R.Effect.andThen(R.Clock.currentTimeMillis),
    R.Effect.flatMap((time) =>
      R.Random.next.pipe(R.Effect.map((draw) => R.Number.add(time, draw))),
    ),
  ),
);
const retried = R.fn([], R.Number, R.Bool, () =>
  R.Random.nextBoolean.pipe(
    R.Effect.flatMap((ready) =>
      R.Match.bool(ready, R.Clock.currentTimeMillis, R.Effect.fail(ready)),
    ),
    R.Effect.retry({ schedule: R.Schedule.recurs(2) }),
  ),
);
const recovered = R.fn([], R.Number, R.Never, () =>
  R.Random.nextBoolean.pipe(
    R.Effect.flatMap((ready) =>
      R.Match.bool(ready, R.Clock.currentTimeMillis, R.Effect.fail(ready)),
    ),
    R.Effect.catchAll(() => R.Clock.currentTimeMillis.pipe(R.Effect.andThen(R.Random.next))),
  ),
);
const guarded = R.fn([], R.Number, R.Never, () =>
  R.Random.next.pipe(R.Effect.catchAll(() => R.Effect.succeed(R.Number.literal(99)))),
);
const clockGuarded = R.fn([], R.Number, R.Never, () =>
  R.Clock.currentTimeMillis.pipe(R.Effect.catchAll(() => R.Effect.succeed(R.Number.literal(99)))),
);
const interleaved = R.fn([], R.Number, R.Never, () =>
  R.Clock.currentTimeMillis.pipe(
    R.Effect.flatMap((first) => {
      return R.Random.next.pipe(
        R.Effect.flatMap((draw) => {
          return R.Effect.sleep(1).pipe(
            R.Effect.andThen(R.Clock.currentTimeMillis),
            R.Effect.flatMap((last) =>
              R.Random.next.pipe(
                R.Effect.map((next) =>
                  R.Number.add(R.Number.add(first, last), R.Number.add(draw, next)),
                ),
              ),
            ),
          );
        }),
      );
    }),
  ),
);
const cancelled = R.fn([], R.Unit, R.Never, () =>
  R.Clock.currentTimeMillis.pipe(
    R.Effect.andThen(R.Random.next),
    R.Effect.andThen(R.Log.info("services:started")),
    R.Effect.andThen(R.Effect.sleep(10000)),
    R.Effect.andThen(R.Random.next),
    R.Effect.asVoid,
    R.Effect.ensuring(
      R.Clock.currentTimeMillis.pipe(
        R.Effect.flatMap((time) =>
          R.Random.nextBoolean.pipe(
            R.Effect.flatMap((flag) =>
              R.Match.bool(
                flag,
                R.Log.info("services:wrong-draw"),
                R.Match.bool(
                  R.Number.eq(time, R.Number.literal(90)),
                  R.Log.info("services:cleanup"),
                  R.Log.info("services:wrong-clock"),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  ),
);
const liveClock = R.fn([], R.Number, R.Never, () => R.Clock.currentTimeMillis);
const program = R.program({
  ordered,
  repeated,
  retried,
  recovered,
  guarded,
  clockGuarded,
  interleaved,
  cancelled,
});

const officialOrdered = (branch: boolean) =>
  Effect.gen(function* () {
    const first = yield* Clock.currentTimeMillis;
    const draw = yield* Random.next;
    const flag = yield* Random.nextBoolean;
    const subtotal = branch
      ? first + (yield* Clock.currentTimeMillis) + draw + (yield* Random.next)
      : first + draw + (yield* Random.next);
    return subtotal + (yield* Clock.currentTimeMillis) + (flag ? 1 : 0);
  });
const officialRepeated = Clock.currentTimeMillis.pipe(
  Effect.andThen(Random.next),
  Effect.asVoid,
  Effect.repeat({ schedule: Schedule.recurs(2) }),
  Effect.andThen(Clock.currentTimeMillis),
  Effect.flatMap((time) => Random.next.pipe(Effect.map((draw) => time + draw))),
);
const officialRetried = Random.nextBoolean.pipe(
  Effect.flatMap((ready) => (ready ? Clock.currentTimeMillis : Effect.fail(ready))),
  Effect.retry({ schedule: Schedule.recurs(2) }),
);
const officialRecovered = Random.nextBoolean.pipe(
  Effect.flatMap((ready) => (ready ? Clock.currentTimeMillis : Effect.fail(ready))),
  Effect.catch(() => Clock.currentTimeMillis.pipe(Effect.andThen(Random.next))),
);

const compare = async <A, E>(
  actual: Effect.Effect<A, E>,
  official: Effect.Effect<A, E>,
  script: Script,
) => {
  const expected = await Effect.runPromise(withOracleServices(official, script));
  expect(await Effect.runPromise(withOracleServices(actual, script))).toEqual(expected);
};

test("service selection is explicit and follows reachable operations", async () => {
  expectTypeOf(R.Clock.currentTimeMillis).toEqualTypeOf<Computation<number, never>>();
  expectTypeOf(R.Random.next).toEqualTypeOf<Computation<number, never>>();
  expectTypeOf(R.Random.nextBoolean).toEqualTypeOf<Computation<boolean, never>>();
  const missing = await Effect.runPromise(
    Compile.run(R.program({ guarded })).pipe(
      Effect.match({
        onSuccess: () => [],
        onFailure: (error) => error.diagnostics.map((item) => item.code),
      }),
    ),
  );
  expect(missing).toContain("MISSING_RUNTIME_SERVICE");
  expect(() =>
    Compile.make(R.program({ liveClock })).pipe(
      // @ts-expect-error The selection contains modes, not a request-controlled script.
      Compile.withRuntimeServices({ random: [0.1] }),
    ),
  ).toThrow();
  const pure = await Effect.runPromise(
    Compile.make(R.program({ liveClock })).pipe(
      Compile.withRuntimeServices({ random: "ScriptedRandom" }),
      Compile.run,
    ),
  );
  expect(pure.files["src/lib.rs"]).not.toContain("RandomDriver");
  const selected = await Effect.runPromise(
    Compile.make(program).pipe(
      Compile.withTarget(Rust.tokio),
      Compile.withRuntimeServices({ clock: "InjectedMillis", random: "ScriptedRandom" }),
      Compile.run,
    ),
  );
  expect(selected.explanation.crates).toEqual(["tokio@1.53.1"]);
  expect(selected.files["src/lib.rs"]).toContain("pub struct SyncContext");
});

test("authored service reads preserve branch, repeat, retry and recovery consumption", async () => {
  for (const branch of [false, true])
    for (const threshold of [0.5, 0.5 + Number.EPSILON / 2]) {
      const script = { clock: branch ? [100, 90, 80] : [100, 80], random: [0.25, threshold, 0.75] };
      await compare(Reference.run(ordered, [branch]), officialOrdered(branch), script);
      const framed = await Effect.runPromise(
        withOracleServices(Reference.runWithFrames(ordered, [branch]), script),
      );
      expect(framed.value.exit).toEqual(
        Exit.succeed(branch ? 271 + Number(threshold > 0.5) : 181 + Number(threshold > 0.5)),
      );
    }
  await compare(Reference.run(repeated, []), officialRepeated, {
    clock: [10, 9, 8, 7],
    random: [0.1, 0.2, 0.3, 0.4],
  });
  await compare(Reference.run(retried, []), officialRetried, {
    clock: [-1],
    random: [0.5, 0.1, 0.9],
  });
  await compare(Reference.run(recovered, []), officialRecovered, {
    clock: [7],
    random: [0.1, 0.8],
  });
  expect(
    (
      await Effect.runPromise(
        withOracleServices(Reference.runWithFrames(repeated, []), {
          clock: [10, 9, 8, 7],
          random: [0.1, 0.2, 0.3, 0.4],
        }),
      )
    ).value.exit,
  ).toEqual(Exit.succeed(7.4));
  expect(
    (
      await Effect.runPromise(
        withOracleServices(Reference.runWithFrames(retried, []), {
          clock: [-1],
          random: [0.5, 0.1, 0.9],
        }),
      )
    ).value.exit,
  ).toEqual(Exit.succeed(-1));
  expect(
    (
      await Effect.runPromise(
        withOracleServices(Reference.runWithFrames(recovered, []), {
          clock: [7],
          random: [0.1, 0.8],
        }),
      )
    ).value.exit,
  ).toEqual(Exit.succeed(0.8));
});

test("direct service values preserve valid IEEE draws and signed milliseconds", async () => {
  for (const draw of [-0, 0, 0.5, 1 - Number.EPSILON / 2]) {
    const actual = await Effect.runPromise(
      withOracleServices(Reference.run(guarded, []), { clock: [], random: [draw] }),
    );
    expect(Object.is(actual.value, draw)).toBe(true);
    expect(actual.randomIndex).toBe(1);
  }
  for (const time of [-Number.MAX_SAFE_INTEGER, -0, 0, Number.MAX_SAFE_INTEGER]) {
    const actual = await Effect.runPromise(
      withOracleServices(Reference.run(clockGuarded, []), { clock: [time], random: [] }),
    );
    expect(Object.is(actual.value, time)).toBe(true);
    expect(actual.clockIndex).toBe(1);
  }
});

test("invalid and exhausted trusted scripts bypass typed recovery", async () => {
  for (const random of [[], [NaN], [Infinity], [-0.1], [1]]) {
    for (const effect of [
      Reference.run(guarded, []),
      Reference.runWithFrames(guarded, []).pipe(Effect.asVoid),
    ]) {
      const result = await Effect.runPromise(
        Effect.exit(withOracleServices(effect, { clock: [], random }, false)),
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) expect(Cause.hasDies(result.cause)).toBe(true);
    }
  }
  for (const clock of [[], [NaN], [Infinity], [0.5], [Number.MAX_SAFE_INTEGER + 1]]) {
    for (const effect of [
      Reference.run(clockGuarded, []),
      Reference.runWithFrames(clockGuarded, []).pipe(Effect.asVoid),
    ]) {
      const result = await Effect.runPromise(
        Effect.exit(withOracleServices(effect, { clock, random: [] }, false)),
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) expect(Cause.hasDies(result.cause)).toBe(true);
    }
  }
  const exhausted = await Effect.runPromise(
    Effect.exit(
      withOracleServices(Reference.run(ordered, [true]), {
        clock: [100, 90],
        random: [0.25, 0.5, 0.75],
      }),
    ),
  );
  expect(Exit.isFailure(exhausted) && Cause.hasDies(exhausted.cause)).toBe(true);
});

test("suspended invocation services remain isolated and cancellation awaits scripted cleanup", async () => {
  const oracleInterleaved = Effect.gen(function* () {
    const first = yield* Clock.currentTimeMillis;
    const draw = yield* Random.next;
    yield* Effect.sleep("1 millis");
    return first + (yield* Clock.currentTimeMillis) + draw + (yield* Random.next);
  });
  const scripts = [
    { clock: [100, 90], random: [0.25, 0.75] },
    { clock: [-5, 5], random: [0.5, 0.5] },
  ];
  const actual = await Effect.runPromise(
    Effect.all(
      scripts.map((script) => withOracleServices(Reference.run(interleaved, []), script)),
      { concurrency: 2 },
    ),
  );
  const expected = await Effect.runPromise(
    Effect.all(
      scripts.map((script) => withOracleServices(oracleInterleaved, script)),
      { concurrency: 2 },
    ),
  );
  expect(actual).toEqual(expected);
  const logs: string[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const task = yield* withOracleServices(Reference.run(cancelled, []), {
          clock: [100, 90],
          random: [0.25, 0.5],
        }).pipe(Effect.forkScoped);
        yield* Effect.sync(() => logs.includes("services:started")).pipe(
          Effect.repeat({ while: (ready) => !ready, schedule: Schedule.spaced("1 millis") }),
          Effect.timeout("2 seconds"),
        );
        yield* Fiber.interrupt(task);
        expect(Exit.hasInterrupts(yield* Fiber.await(task))).toBe(true);
      }),
    ).pipe(
      Effect.provide(Logger.layer([Logger.make((event) => logs.push(String(event.message)))])),
    ),
  );
  expect(logs).toEqual(["services:started", "services:cleanup"]);
});

const nativeProbe = `
use std::alloc::{GlobalAlloc, Layout, System};
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use reffect_generated as r;
struct Counting;
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
  unsafe fn alloc(&self, layout: Layout) -> *mut u8 { ALLOCS.fetch_add(1, Ordering::SeqCst); System.alloc(layout) }
  unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) { System.dealloc(ptr, layout) }
}
#[global_allocator] static ALLOCATOR: Counting = Counting;
fn context(clock: Vec<f64>, random: Vec<f64>) -> r::SyncContext {
  let mut ctx = r::SyncContext::new(); ctx.set_clock_script(clock); ctx.set_random_script(random); ctx
}
#[tokio::main(flavor="current_thread")]
async fn main() {
  for branch in [false, true] { for flag in [0.5, 0.5000000000000001] {
    let times = if branch { vec![100.0,90.0,80.0] } else { vec![100.0,80.0] };
    let mut ctx = context(times,vec![0.25,flag,0.75]);
    assert_eq!(r::r_ordered(&mut ctx,branch).unwrap(),if branch {271.0} else {181.0} + if flag > 0.5 {1.0} else {0.0});
  }}
  let (_repeat_sender,repeat_receiver)=tokio::sync::watch::channel(false);
  let mut ctx=r::AsyncContext::new(repeat_receiver);ctx.set_clock_script(vec![10.0,9.0,8.0,7.0]);ctx.set_random_script(vec![0.1,0.2,0.3,0.4]);
  assert_eq!(r::r_repeated(&mut ctx).await.unwrap(),7.4);
  let (_retry_sender,retry_receiver)=tokio::sync::watch::channel(false);
  let mut ctx=r::AsyncContext::new(retry_receiver);ctx.set_clock_script(vec![-1.0]);ctx.set_random_script(vec![0.5,0.1,0.9]);
  assert_eq!(r::r_retried(&mut ctx).await.unwrap(),-1.0);
  let mut ctx = context(vec![7.0],vec![0.1,0.8]);
  assert_eq!(r::r_recovered(&mut ctx).unwrap(),0.8);
  assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _=r::r_clockGuarded(&mut ctx); })).is_err());
  for draw in [-0.0f64,0.0,0.5,0.9999999999999999] {
    let mut ctx=context(vec![],vec![draw]);assert_eq!(r::r_guarded(&mut ctx).unwrap().to_bits(),draw.to_bits());
  }
  for time in [-9_007_199_254_740_991.0f64,-0.0,0.0,9_007_199_254_740_991.0] {
    let mut ctx=context(vec![time],vec![]);assert_eq!(r::r_clockGuarded(&mut ctx).unwrap().to_bits(),time.to_bits());
  }
  let mut ctx = r::SyncContext::new(); ctx.set_clock_stable(-7.0);
  assert_eq!(r::r_clockGuarded(&mut ctx).unwrap(),-7.0);
  assert_eq!(r::r_clockGuarded(&mut ctx).unwrap(),-7.0);
  let mut live = r::SyncContext::new();
  let wall = r::r_clockGuarded(&mut live).unwrap();
  assert!(wall.is_finite() && wall.fract()==0.0 && wall.abs() <= 9_007_199_254_740_991.0);
  assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let mut ctx = r::SyncContext::new(); let _ = r::r_guarded(&mut ctx); })).is_err());
  assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let mut ctx = context(vec![],vec![]); let _ = r::r_clockGuarded(&mut ctx); })).is_err());
  assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let mut ctx = context(vec![100.0,90.0],vec![0.25,0.5,0.75]); let _ = r::r_ordered(&mut ctx,true); })).is_err());
  for invalid in [f64::NAN,f64::INFINITY,-0.1,1.0] {
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let mut ctx=r::SyncContext::new(); ctx.set_random_script(vec![invalid]); })).is_err());
  }
  for invalid in [f64::NAN,f64::INFINITY,0.5,9_007_199_254_740_992.0] {
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let mut ctx=r::SyncContext::new(); ctx.set_clock_stable(invalid); })).is_err());
  }
  let (_sender_a,receiver_a)=tokio::sync::watch::channel(false);
  let (_sender_b,receiver_b)=tokio::sync::watch::channel(false);
  let mut ctx_a=r::AsyncContext::new(receiver_a);ctx_a.set_clock_script(vec![100.0,90.0]);ctx_a.set_random_script(vec![0.25,0.75]);
  let mut ctx_b=r::AsyncContext::new(receiver_b);ctx_b.set_clock_script(vec![-5.0,5.0]);ctx_b.set_random_script(vec![0.5,0.5]);
  let (a,b)=tokio::join!(r::r_interleaved(&mut ctx_a),r::r_interleaved(&mut ctx_b));
  assert_eq!(a.unwrap(),191.0);assert_eq!(b.unwrap(),1.0);
  let (sender,receiver)=tokio::sync::watch::channel(false);
  let mut ctx=r::AsyncContext::new(receiver);ctx.set_clock_script(vec![100.0,90.0]);ctx.set_random_script(vec![0.25,0.5]);
  {
    let future=r::r_cancelled(&mut ctx);tokio::pin!(future);
    std::future::poll_fn(|cx|match future.as_mut().poll(cx){std::task::Poll::Pending=>{sender.send(true).unwrap();std::task::Poll::Ready(())},_=>panic!("expected suspended invocation")}).await;
    assert!(matches!(future.await,Err(r::AsyncError::Interrupted)));
  }
  // Buffers/watch/runtime setup precede counted construction and configuration.
  let clocks=vec![100.0,80.0];let randoms=vec![0.25,0.5,0.75];
  let (_sender,receiver)=tokio::sync::watch::channel(false);
  let before=ALLOCS.load(Ordering::SeqCst);
  let mut sync=r::SyncContext::new();sync.set_clock_script(clocks);sync.set_random_script(randoms);
  let mut asynchronous=r::AsyncContext::new(receiver);
  let future_bytes={let future=r::r_interleaved(&mut asynchronous);std::mem::size_of_val(&future)};
  assert_eq!(ALLOCS.load(Ordering::SeqCst)-before,0);
  let before=ALLOCS.load(Ordering::SeqCst);
  assert_eq!(r::r_ordered(&mut sync,false).unwrap(),181.0);
  assert_eq!(ALLOCS.load(Ordering::SeqCst)-before,0);
  println!("enabled-layout:sync={},async={},future={},construction_allocations=0,scripted_sync_allocations=0",std::mem::size_of_val(&sync),std::mem::size_of_val(&asynchronous),future_bytes);
  println!("services-probe:passed");
}
`;
const baseline = R.fn([], R.Number, R.Never, () =>
  R.Effect.sleep(1).pipe(R.Effect.as(R.Number.literal(1))),
);
const baselineLogged = R.fn([], R.Unit, R.Never, () =>
  R.Log.info("baseline").pipe(R.Effect.andThen(R.Effect.sleep(1))),
);
const baselineProbe = `
use std::alloc::{GlobalAlloc,Layout,System};use std::sync::atomic::{AtomicUsize,Ordering};
struct Counting;static ALLOCS:AtomicUsize=AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {unsafe fn alloc(&self,l:Layout)->*mut u8{ALLOCS.fetch_add(1,Ordering::SeqCst);System.alloc(l)}unsafe fn dealloc(&self,p:*mut u8,l:Layout){System.dealloc(p,l)}}
#[global_allocator]static ALLOCATOR:Counting=Counting;
#[tokio::main(flavor="current_thread")]
async fn main(){let(_sender,receiver)=tokio::sync::watch::channel(false);let before=ALLOCS.load(Ordering::SeqCst);let mut ctx=reffect_generated::AsyncContext::new(receiver);let bytes={let future=reffect_generated::r_baseline(&mut ctx);std::mem::size_of_val(&future)};assert_eq!(ALLOCS.load(Ordering::SeqCst)-before,0);println!("disabled-layout:async={},future={},construction_allocations=0",std::mem::size_of_val(&ctx),bytes);}
`;

test(
  "native runtime services preserve valid invocation semantics and expose explicit host faults",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-runtime-services-" });
          const measurements: string[] = [];
          for (const frames of [FailureFrames.None, FailureFrames.Bounded]) {
            const artifact = yield* Compile.make(program).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withFailureFrames(frames),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.withRuntimeServices({ clock: "InjectedMillis", random: "ScriptedRandom" }),
              Compile.run,
            );
            expect(artifact.explanation.crates).toEqual(["tokio@1.53.1"]);
            expect(artifact.files["src/lib.rs"]).not.toMatch(/Box<dyn|Arc<.*Driver|Mutex<.*Driver/);
            const directory = yield* CargoApi.write(artifact, `${parent}/${frames._tag}`);
            yield* fs.writeFileString(`${directory}/src/main.rs`, nativeProbe);
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              const result = yield* CargoApi.run(directory, "probe", [], profile);
              expect(result.stdout).toContain("services-probe:passed");
              expect(result.stdout).toContain(
                "construction_allocations=0,scripted_sync_allocations=0",
              );
              expect(
                result.stderr
                  .split("\n")
                  .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
                  .map((line) => JSON.parse(line).message),
              ).toEqual(["services:started", "services:cleanup"]);
              measurements.push(`${frames._tag}/${profile}: ${result.stdout.trim()}`);
            }
            const disabled = yield* Compile.make(R.program({ baseline, baselineLogged })).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withFailureFrames(frames),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.run,
            );
            expect(disabled.files["src/lib.rs"]).not.toMatch(
              /ClockDriver|RandomDriver|SyncContext|Scripted/,
            );
            const baselineDirectory = yield* CargoApi.write(
              disabled,
              `${parent}/baseline-${frames._tag}`,
            );
            yield* fs.writeFileString(`${baselineDirectory}/src/main.rs`, baselineProbe);
            yield* CargoApi.build(baselineDirectory, "release");
            const measured = yield* CargoApi.run(baselineDirectory, "probe", [], "release");
            expect(measured.stdout).toContain("construction_allocations=0");
            measurements.push(`${frames._tag}/release: ${measured.stdout.trim()}`);
          }
          const live = yield* Compile.run(R.program({ liveClock }));
          expect(live.explanation.crates).toEqual([]);
          expect(live.files["src/lib.rs"]).not.toContain("SyncContext");
          const liveDirectory = yield* CargoApi.write(live, `${parent}/live`);
          yield* CargoApi.build(liveDirectory, "release");
          const result = yield* NativeRunner.run(
            live,
            liveDirectory,
            "liveClock",
            liveClock,
            [],
            "release",
          );
          expect(Exit.isSuccess(result)).toBe(true);
          if (Exit.isSuccess(result)) expect(Number.isSafeInteger(result.value)).toBe(true);
          const reportPath = process.env.REFFECT_RUNTIME_SERVICES_MEASUREMENTS;
          if (reportPath) yield* fs.writeFileString(reportPath, measurements.join("\n") + "\n");
        }),
      ).pipe(Effect.provide(NodeServices.layer), Effect.provide(Logger.layer([]))),
    );
  },
  nativeTestBudget(0) + 240000,
);

const registeredScript = {
  clock: [100, 90, 80, 70],
  random: [0.25, 0.5, 0.75, 0.9],
};
const registered = R.fn([R.Bool], R.Unit, R.Never, (interrupt) => {
  const first = R.Clock.currentTimeMillis.pipe(
    R.Effect.flatMap((time) =>
      R.Random.next.pipe(
        R.Effect.flatMap((draw) =>
          R.Match.bool(
            R.Number.eq(time, R.Number.literal(80)),
            R.Match.bool(
              R.Number.eq(draw, R.Number.literal(0.75)),
              R.Log.info("registered:first"),
              R.Log.info("registered:wrong-first-draw"),
            ),
            R.Log.info("registered:wrong-first-clock"),
          ),
        ),
      ),
    ),
  );
  const second = R.Clock.currentTimeMillis.pipe(
    R.Effect.flatMap((time) =>
      R.Random.nextBoolean.pipe(
        R.Effect.flatMap((flag) =>
          R.Match.bool(
            R.Number.eq(time, R.Number.literal(90)),
            R.Match.bool(
              flag,
              R.Log.info("registered:wrong-second-draw"),
              R.Log.info("registered:second"),
            ),
            R.Log.info("registered:wrong-second-clock"),
          ),
        ),
      ),
    ),
  );
  const body = R.Effect.addFinalizer(() => first).pipe(
    R.Effect.andThen(R.Effect.addFinalizer(() => second)),
    R.Effect.andThen(R.Clock.currentTimeMillis),
    R.Effect.andThen(R.Random.next),
    R.Effect.andThen(R.Log.info("registered:started")),
    R.Effect.andThen(R.Match.bool(interrupt, R.Effect.sleep(10000), R.Effect.void)),
  );
  return R.Effect.scoped(body).pipe(
    R.Effect.andThen(
      R.Clock.currentTimeMillis.pipe(
        R.Effect.flatMap((time) =>
          R.Random.nextBoolean.pipe(
            R.Effect.flatMap((flag) =>
              R.Match.bool(
                R.Number.eq(time, R.Number.literal(70)),
                R.Match.bool(
                  flag,
                  R.Log.info("registered:after-close"),
                  R.Log.info("registered:wrong-after-draw"),
                ),
                R.Log.info("registered:wrong-after-clock"),
              ),
            ),
          ),
        ),
      ),
    ),
  );
});
const officialRegistered = (interrupt: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const time = yield* Clock.currentTimeMillis;
          const draw = yield* Random.next;
          yield* Effect.log(
            time === 80 && draw === 0.75 ? "registered:first" : "registered:wrong-first",
          );
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const time = yield* Clock.currentTimeMillis;
          const flag = yield* Random.nextBoolean;
          yield* Effect.log(time === 90 && !flag ? "registered:second" : "registered:wrong-second");
        }),
      );
      yield* Clock.currentTimeMillis;
      yield* Random.next;
      yield* Effect.log("registered:started");
      if (interrupt) yield* Effect.sleep("10 seconds");
    }),
  ).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const time = yield* Clock.currentTimeMillis;
        const flag = yield* Random.nextBoolean;
        yield* Effect.log(
          time === 70 && flag ? "registered:after-close" : "registered:wrong-after",
        );
      }),
    ),
  );
const registeredMessages = (stderr: string) =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
    .map((line) => JSON.parse(line).message);

const runRegisteredReference = async (
  effect: Effect.Effect<unknown, unknown>,
  interrupt: boolean,
) => {
  const logs: string[] = [];
  const outcome = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        if (!interrupt)
          return yield* withOracleServices(effect, registeredScript).pipe(Effect.exit);
        const task = yield* withOracleServices(effect, registeredScript).pipe(Effect.forkScoped);
        yield* Effect.sync(() => logs.includes("registered:started")).pipe(
          Effect.repeat({ while: (ready) => !ready, schedule: Schedule.spaced("1 millis") }),
          Effect.timeout("2 seconds"),
        );
        yield* Fiber.interrupt(task);
        return yield* Fiber.await(task);
      }),
    ).pipe(
      Effect.provide(Logger.layer([Logger.make((event) => logs.push(String(event.message)))])),
    ),
  );
  return { logs, interrupted: Exit.hasInterrupts(outcome), succeeded: Exit.isSuccess(outcome) };
};

test("registered cleanup keeps invocation Clock/Random cursors through normal and interrupted Scope close", async () => {
  for (const interrupt of [false, true]) {
    const expected = await runRegisteredReference(officialRegistered(interrupt), interrupt);
    expect(expected.interrupted).toBe(interrupt);
    expect(expected.succeeded).toBe(!interrupt);
    expect(expected.logs).toEqual(
      interrupt
        ? ["registered:started", "registered:second", "registered:first"]
        : ["registered:started", "registered:second", "registered:first", "registered:after-close"],
    );
    expect(await runRegisteredReference(Reference.run(registered, [interrupt]), interrupt)).toEqual(
      expected,
    );
    const framed = Reference.runWithFrames(registered, [interrupt]).pipe(
      Effect.flatMap((result) => result.exit),
    );
    expect(await runRegisteredReference(framed, interrupt)).toEqual(expected);
  }
});

const registeredProbe = `
use std::future::Future;
use reffect_generated as r;
#[tokio::main(flavor="current_thread")]
async fn main(){
  let(_sender,receiver)=tokio::sync::watch::channel(false);
  let mut ctx=r::AsyncContext::new(receiver);
  ctx.set_clock_script(vec![100.0,90.0,80.0,70.0]);ctx.set_random_script(vec![0.25,0.5,0.75,0.9]);
  assert!(r::r_registered(&mut ctx,false).await.is_ok());
  let(sender,receiver)=tokio::sync::watch::channel(false);
  let mut ctx=r::AsyncContext::new(receiver);
  ctx.set_clock_script(vec![100.0,90.0,80.0,70.0]);ctx.set_random_script(vec![0.25,0.5,0.75,0.9]);
  {
    let future=r::r_registered(&mut ctx,true);tokio::pin!(future);
    std::future::poll_fn(|cx|match future.as_mut().poll(cx){std::task::Poll::Pending=>{sender.send(true).unwrap();std::task::Poll::Ready(())},_=>panic!("expected suspended registered Scope")}).await;
    assert!(matches!(future.await,Err(r::AsyncError::Interrupted)));
  }
  println!("registered-services:passed");
}
`;
test(
  "native registered Scope finalizers share services without changing the measured baseline artifact",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({
            prefix: "reffect-registered-services-",
          });
          for (const frames of [FailureFrames.None, FailureFrames.Bounded]) {
            const artifact = yield* Compile.make(R.program({ registered })).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withFailureFrames(frames),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.withRuntimeServices({ clock: "InjectedMillis", random: "ScriptedRandom" }),
              Compile.run,
            );
            const directory = yield* CargoApi.write(artifact, `${parent}/${frames._tag}`);
            yield* fs.writeFileString(`${directory}/src/main.rs`, registeredProbe);
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              const result = yield* CargoApi.run(directory, "probe", [], profile);
              expect(result.stdout).toContain("registered-services:passed");
              expect(registeredMessages(result.stderr)).toEqual([
                "registered:started",
                "registered:second",
                "registered:first",
                "registered:after-close",
                "registered:started",
                "registered:second",
                "registered:first",
              ]);
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer), Effect.provide(Logger.layer([]))),
    );
  },
  nativeTestBudget(0) + 120000,
);
