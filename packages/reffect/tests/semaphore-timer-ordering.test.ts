import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Cause, Effect, Exit } from "effect";
import { expect, test } from "vite-plus/test";
import {
  Compile,
  FailureFrames,
  R,
  Rust,
  SemaphoreExecution,
  SourceArtifacts,
} from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const options = { concurrency: "unbounded", discard: true } as const;
const sleep = () => R.Effect.sleep(20);
const wave = R.fn([], R.Unit, R.Never, () =>
  R.Semaphore.make(1).pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.all(
        [
          R.Semaphore.withPermit(owner)(
            R.Log.info("holder:entered").pipe(
              R.Effect.andThen(sleep()),
              R.Effect.andThen(R.Log.info("holder:body-done")),
            ),
          ).pipe(R.Effect.andThen(R.Log.info("holder:released"))),
          R.Log.info("waiter:attempt").pipe(
            R.Effect.andThen(R.Semaphore.withPermit(owner)(R.Log.info("waiter:entered"))),
            R.Effect.andThen(R.Log.info("waiter:released")),
          ),
          sleep().pipe(
            R.Effect.andThen(R.Log.info("barger:attempt")),
            R.Effect.andThen(R.Semaphore.withPermit(owner)(R.Log.info("barger:entered"))),
            R.Effect.andThen(R.Log.info("barger:released")),
          ),
        ],
        options,
      ),
    ),
  ),
);
const reverse = R.fn([], R.Unit, R.Never, () =>
  R.Semaphore.make(1).pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.all(
        [
          sleep().pipe(
            R.Effect.andThen(R.Log.info("A:attempt")),
            R.Effect.andThen(
              R.Semaphore.withPermit(owner)(
                R.Log.info("A:entered").pipe(
                  R.Effect.andThen(sleep()),
                  R.Effect.andThen(R.Log.info("A:body-done")),
                ),
              ),
            ),
            R.Effect.andThen(R.Log.info("A:released")),
          ),
          R.Semaphore.withPermit(owner)(
            R.Log.info("B:entered").pipe(
              R.Effect.andThen(sleep()),
              R.Effect.andThen(R.Log.info("B:body-done")),
            ),
          ).pipe(
            R.Effect.andThen(R.Log.info("B:released")),
            R.Effect.andThen(sleep()),
            R.Effect.andThen(R.Log.info("B:finished")),
          ),
        ],
        options,
      ),
    ),
  ),
);
const cancelled = R.fn([], R.Unit, R.Never, () =>
  R.Semaphore.make(1).pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.all(
        [
          R.Semaphore.withPermit(owner)(
            R.Log.info("holder:entered").pipe(
              R.Effect.andThen(sleep()),
              R.Effect.ensuring(
                R.Log.info("holder:cleanup-start").pipe(
                  R.Effect.andThen(sleep()),
                  R.Effect.andThen(R.Log.info("holder:cleanup-done")),
                ),
              ),
            ),
          ),
          R.Log.info("waiter:attempt").pipe(
            R.Effect.andThen(R.Semaphore.withPermit(owner)(R.Log.info("waiter:must-not-enter"))),
            R.Effect.ensuring(
              R.Log.info("waiter:cleanup-start").pipe(
                R.Effect.andThen(sleep()),
                R.Effect.andThen(R.Log.info("waiter:cleanup-done")),
              ),
            ),
          ),
        ],
        options,
      ),
    ),
  ),
);
const late = R.fn([], R.Unit, R.Never, () =>
  R.Semaphore.make(1).pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.all(
        [
          R.Semaphore.withPermit(owner)(
            R.Log.info("late:holder").pipe(
              R.Effect.andThen(sleep()),
              R.Effect.ensuring(R.Log.info("late:holder-cleanup")),
            ),
          ),
          R.Log.info("late:waiter").pipe(
            R.Effect.andThen(R.Semaphore.withPermit(owner)(R.Log.info("late:must-not-enter"))),
            R.Effect.ensuring(R.Log.info("late:waiter-cleanup")),
          ),
          R.Log.info("late:peer").pipe(
            R.Effect.andThen(sleep()),
            R.Effect.ensuring(
              R.Log.info("late:peer-cleanup-start").pipe(
                R.Effect.andThen(sleep()),
                R.Effect.andThen(R.Log.info("late:peer-cleanup-done")),
              ),
            ),
          ),
        ],
        options,
      ),
    ),
  ),
);
const zero = R.fn([], R.Unit, R.Never, () =>
  R.Semaphore.make(1).pipe(
    R.Effect.flatMap((owner) =>
      R.Semaphore.withPermit(owner)(
        R.Log.info("zero:before").pipe(
          R.Effect.andThen(R.Effect.sleep(0)),
          R.Effect.andThen(R.Log.info("zero:after")),
          R.Effect.ensuring(R.Log.info("zero:cleanup")),
        ),
      ),
    ),
  ),
);
// Delaying the host after eager startup makes the due set deterministic; ordinary elapsed
// sleeps do not prove how multiple callbacks are ordered when a parent is polled late.
const holdHost = () => {
  const until = performance.now() + 60;
  while (performance.now() < until) {
    /* hold the oracle event loop */
  }
};
const execute = promisify(execFile);

test("owned uniform timers preserve due-wave barging and renewed registration order", async () => {
  const activeWave = SemaphoreExecution.run(wave);
  holdHost();
  const observedWave = await activeWave;
  expect(observedWave.exit).toEqual(Exit.succeed(undefined));
  expect(observedWave.logs).toEqual([
    "holder:entered",
    "waiter:attempt",
    "holder:body-done",
    "holder:released",
    "barger:attempt",
    "barger:entered",
    "barger:released",
    "waiter:entered",
    "waiter:released",
  ]);
  const activeReverse = SemaphoreExecution.run(reverse);
  holdHost();
  const observedReverse = await activeReverse;
  expect(observedReverse.logs).toEqual([
    "B:entered",
    "A:attempt",
    "B:body-done",
    "B:released",
    "A:entered",
    "B:finished",
    "A:body-done",
    "A:released",
  ]);
});

test.each([FailureFrames.None, FailureFrames.Bounded])(
  "public generated timer waves match official overdue, renewal, cleanup and zero-yield traces ($_tag)",
  async (failureFrames) => {
    const activeWave = SemaphoreExecution.run(wave);
    holdHost();
    const observedWave = await activeWave;
    const activeReverse = SemaphoreExecution.run(reverse);
    holdHost();
    const observedReverse = await activeReverse;
    const controller = new AbortController();
    const activeCancelled = SemaphoreExecution.runWithFrames(cancelled, {
      signal: controller.signal,
    });
    controller.abort();
    holdHost();
    const observedCancelled = await activeCancelled;
    expect(observedCancelled.exit).toMatchObject({
      value: {
        frames: [{ kind: "all" }, { kind: "semaphoreScope" }, { kind: "function" }],
        omitted: 0,
      },
    });
    const lateController = new AbortController();
    const activeLate = SemaphoreExecution.run(late, { signal: lateController.signal });
    lateController.abort();
    const observedLate = await activeLate;
    expect(observedLate.logs).not.toContain("late:must-not-enter");
    const zeroController = new AbortController();
    const activeZero = SemaphoreExecution.run(zero, { signal: zeroController.signal });
    zeroController.abort();
    const observedZero = await activeZero;
    expect(
      Exit.isFailure(observedZero.exit) && Cause.hasInterruptsOnly(observedZero.exit.cause),
    ).toBe(true);
    expect(observedZero.logs).toEqual(["zero:before", "zero:cleanup"]);
    const root = await mkdtemp(join(tmpdir(), "reffect-semaphore-timers-"));
    try {
      const artifact = await Effect.runPromise(
        Compile.make(R.program({ wave, reverse, cancelled, late, zero })).pipe(
          Compile.withTarget(Rust.tokio),
          Compile.withSourceArtifacts(SourceArtifacts.None),
          Compile.withFailureFrames(failureFrames),
          Compile.run,
        ),
      );
      for (const [path, contents] of Object.entries(artifact.files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        // Signal precisely at the final cancellation phase, simulating a valid concurrent
        // watch sender. The generated program and timer/scan machinery otherwise run intact.
        const parentCheck = "macro_rules! check_parent { () => {";
        if (path === "src/lib.rs") expect(contents).toContain(parentCheck);
        const prepared =
          path === "src/lib.rs"
            ? contents.replaceAll(
                parentCheck,
                `${parentCheck}\n                timer_test_cancel();`,
              ) +
              `
#[doc(hidden)]
pub static TIMER_TEST_CANCEL: std::sync::Mutex<Option<(usize,tokio::sync::watch::Sender<bool>)>> = std::sync::Mutex::new(None);
fn timer_test_cancel() {
    let mut hook = TIMER_TEST_CANCEL.lock().unwrap();
    if let Some((remaining,_)) = hook.as_mut() {
        *remaining -= 1;
        if *remaining == 0 {
            let sender = hook.take().unwrap().1;
            drop(hook);
            sender.send(true).unwrap();
        }
    }
}
pub fn timer_test_bank() {
    let bank = ScanTasks::<4>::new();
    let first = bank.register_timer(1,20);
    let second = bank.register_timer(2,20);
    let wave = bank.timer_wave([2,1,3],tokio::time::Instant::now()+std::time::Duration::from_secs(1));
    assert_eq!(wave[0].unwrap().task,1);
    assert_eq!(wave[1].unwrap().task,2);
    assert!(wave[2].is_none());
    let stale = wave[1].unwrap();
    drop(second);
    let renewed = bank.register_timer(2,20);
    assert!(!bank.grant_timer(stale));
    assert!(bank.grant_timer(wave[0].unwrap()));
    assert!(first.granted());
    assert!(!renewed.granted());
    drop(first); drop(renewed);
    assert!(bank.next_timer_deadline([1,2,3]).is_none());
    println!("timer-bank={} timer-lease={} timer-word={}",std::mem::size_of::<ScanTasks<4>>(),std::mem::size_of::<ScanTimerLease<4>>(),std::mem::size_of::<usize>());
}
`
            : contents;
        await writeFile(join(root, path), prepared);
      }
      await writeFile(
        join(root, "src/main.rs"),
        String.raw`
use reffect_generated as r;
use std::future::Future;
use std::pin::Pin;
use std::task::Poll;
async fn once<F:Future>(mut future: Pin<&mut F>) {
 std::future::poll_fn(|cx| { assert!(future.as_mut().poll(cx).is_pending()); Poll::Ready(()) }).await;
}
#[tokio::main(flavor="current_thread")]
async fn main() {
 let (_sender, receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 println!("wave");
 { let future=r::r_wave(&mut ctx); tokio::pin!(future); once(future.as_mut()).await;
   tokio::time::sleep(std::time::Duration::from_millis(60)).await;
   assert!(future.await.is_ok()); }
 println!("reverse");
 { let future=r::r_reverse(&mut ctx); tokio::pin!(future); once(future.as_mut()).await;
   tokio::time::sleep(std::time::Duration::from_millis(60)).await;
   // Hold the second wave too: its FIFO order differs from static child order.
   once(future.as_mut()).await;
   tokio::time::sleep(std::time::Duration::from_millis(60)).await;
   assert!(future.await.is_ok()); }
 println!("cancelled");
 let (cancel, receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 { let future=r::r_cancelled(&mut ctx); tokio::pin!(future); once(future.as_mut()).await;
   cancel.send(true).unwrap(); once(future.as_mut()).await;
   tokio::time::sleep(std::time::Duration::from_millis(60)).await;
   assert!(matches!(future.await, Err(r::AsyncError::Interrupted))); }
${
  FailureFrames.isNone(failureFrames)
    ? ""
    : String.raw` let (frames, omitted)=ctx.take_frames(); assert_eq!(omitted,0);
 assert_eq!(frames.len(),3);
 assert!(frames[0].contains("\"kind\":\"all\""));
 assert!(frames[1].contains("\"kind\":\"semaphoreScope\""));
 assert!(frames[2].contains("\"kind\":\"function\""));
`
}
 println!("late");
 let (cancel,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 { let future=r::r_late(&mut ctx); tokio::pin!(future); once(future.as_mut()).await;
   *r::TIMER_TEST_CANCEL.lock().unwrap()=Some((2,cancel));
   once(future.as_mut()).await;
   tokio::time::sleep(std::time::Duration::from_millis(60)).await;
   assert!(matches!(future.await,Err(r::AsyncError::Interrupted))); }
 println!("zero");
 let (cancel, receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 { let future=r::r_zero(&mut ctx); tokio::pin!(future); once(future.as_mut()).await;
   cancel.send(true).unwrap(); assert!(matches!(future.await,Err(r::AsyncError::Interrupted))); }
 r::timer_test_bank();
 println!("timer-smoke-ok");
}
`,
      );
      const expected = [
        ...observedWave.logs,
        ...observedReverse.logs,
        ...observedCancelled.logs,
        ...observedLate.logs,
        ...observedZero.logs,
      ];
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
        expect(logs).toEqual(expected);
        expect(result.stdout).toContain("timer-smoke-ok");
        const layout = result.stdout.match(/timer-bank=(\d+) timer-lease=(\d+) timer-word=(\d+)/)!;
        expect(Number(layout[1])).toBeLessThan(1024);
        expect(Number(layout[2])).toBeLessThanOrEqual(4 * Number(layout[3]));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  nativeTestBudget(0) * 2,
);
