import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect, Latch } from "effect";
import { expect, test } from "vite-plus/test";
import { asyncRuntime } from "../src/async-runtime.ts";
import { latchAllRuntime } from "../src/latch-all-runtime.ts";
import { latchCohortRuntime } from "../src/latch-cohort-runtime.ts";
import { semaphoreTaskRuntime } from "../src/semaphore-task-runtime.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const harness = String.raw`
use std::task::{Context, Poll, Waker};
use std::future::Future;
use std::sync::Mutex;
fn log(events: &Mutex<Vec<&'static str>>, event: &'static str) { events.lock().unwrap().push(event); }
fn ready<F: Future<Output=bool>>(future: std::pin::Pin<&mut F>) -> bool {
    let mut cx = Context::from_waker(Waker::noop());
    match future.poll(&mut cx) { Poll::Ready(value) => value, Poll::Pending => panic!("Expected settled Latch All") }
}
fn pending<F: Future>(future: std::pin::Pin<&mut F>) {
    assert!(future.poll(&mut Context::from_waker(Waker::noop())).is_pending());
}
fn snapshot() {
    let owner = CohortLatch::<4>::new(false); let bank = ScanTasks::<4>::new(); let events = Mutex::new(Vec::new());
    let (ac, ar) = tokio::sync::watch::channel(false); let (bc, br) = tokio::sync::watch::channel(false);
    let (cc, _cr) = tokio::sync::watch::channel(false); let (_pc, pr) = tokio::sync::watch::channel(false);
    let a = async {
        let task = ScanTask::new(&bank, 1); let mut ctx = AsyncContext::new(ar);
        task.await_latch(&owner, &mut ctx).await.unwrap(); log(&events, "A1");
        task.await_latch(&owner, &mut ctx).await.unwrap(); log(&events, "A2"); true
    };
    let b = async {
        let mut ctx = AsyncContext::new(br); ScanTask::new(&bank, 2).await_latch(&owner, &mut ctx).await.unwrap();
        log(&events, "B1"); assert!(owner.release()); true
    };
    let c = async { assert!(owner.release()); assert!(!owner.close()); log(&events, "C:signal"); true };
    tokio::pin!(a, b, c);
    let group = latch_all3(&owner, &bank, [1, 2, 3], a.as_mut(), b.as_mut(), c.as_mut(), [ac, bc, cc], pr);
    tokio::pin!(group); assert!(ready(group.as_mut())); assert_eq!(owner.registered(), 0); assert!(!owner.has_scheduled());
    println!("SNAPSHOT:{:?}", events.lock().unwrap());
}
async fn timer_wave() {
    let owner = CohortLatch::<4>::new(false); let bank = ScanTasks::<4>::new(); let events = Mutex::new(Vec::new());
    let (ac, ar) = tokio::sync::watch::channel(false); let (bc, br) = tokio::sync::watch::channel(false);
    let (cc, cr) = tokio::sync::watch::channel(false); let (_pc, pr) = tokio::sync::watch::channel(false);
    let a = async {
        let mut ctx = AsyncContext::new(ar); ScanTask::new(&bank, 1).sleep::<std::convert::Infallible>(&mut ctx, 20).await.unwrap();
        log(&events, "T1"); assert!(owner.release()); true
    };
    let b = async {
        let mut ctx = AsyncContext::new(br); ScanTask::new(&bank, 2).await_latch(&owner, &mut ctx).await.unwrap(); log(&events, "B"); true
    };
    let c = async {
        let mut ctx = AsyncContext::new(cr); ScanTask::new(&bank, 3).sleep::<std::convert::Infallible>(&mut ctx, 20).await.unwrap();
        log(&events, "T2"); true
    };
    tokio::pin!(a, b, c);
    let group = latch_all3(&owner, &bank, [1, 2, 3], a.as_mut(), b.as_mut(), c.as_mut(), [ac, bc, cc], pr);
    tokio::pin!(group); pending(group.as_mut()); tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    assert!(ready(group.as_mut())); assert_eq!(owner.registered(), 0);
    println!("TIMER:{:?}", events.lock().unwrap());
}
fn idle_child_cancellation() {
    let owner = CohortLatch::<4>::new(false); let bank = ScanTasks::<4>::new(); let events = Mutex::new(Vec::new());
    let (ac, ar) = tokio::sync::watch::channel(false); let (bc, br) = tokio::sync::watch::channel(false);
    let external = ac.clone(); let (_pc, pr) = tokio::sync::watch::channel(false);
    let a = async {
        let mut ctx = AsyncContext::new(ar);
        assert!(ScanTask::new(&bank, 1).await_latch(&owner, &mut ctx).await.is_err());
        log(&events, "A:cleanup"); false
    };
    let b = async {
        let mut ctx = AsyncContext::new(br);
        assert!(ScanTask::new(&bank, 2).await_latch(&owner, &mut ctx).await.is_err());
        log(&events, "B:cleanup"); false
    };
    tokio::pin!(a, b);
    let group = latch_all2(&owner, &bank, [1, 2], a.as_mut(), b.as_mut(), [ac, bc], pr);
    tokio::pin!(group); pending(group.as_mut()); assert_eq!(owner.registered(), 2);
    external.send(true).unwrap(); assert!(!ready(group.as_mut()));
    assert_eq!(owner.registered(), 0); assert!(!owner.has_scheduled());
    assert_eq!(*events.lock().unwrap(), vec!["A:cleanup", "B:cleanup"]);
    println!("IDLE-CHILD:passed");
}
async fn cancellation(child_only: bool) {
    let owner = CohortLatch::<4>::new(false); let bank = ScanTasks::<4>::new(); let events = Mutex::new(Vec::new());
    let (ac, ar) = tokio::sync::watch::channel(false); let (bc, br) = tokio::sync::watch::channel(false);
    let (pc, pr) = tokio::sync::watch::channel(false);
    let external = if child_only { ac.clone() } else { pc.clone() };
    let a = async {
        let mut ctx = AsyncContext::new(ar); let task = ScanTask::new(&bank, 1);
        assert!(task.await_latch(&owner, &mut ctx).await.is_err()); log(&events, "A:cleanup-start");
        ctx.interruptible = false; task.sleep::<std::convert::Infallible>(&mut ctx, 20).await.unwrap();
        log(&events, "A:cleanup-end"); false
    };
    let b = async {
        let mut ctx = AsyncContext::new(br); let task = ScanTask::new(&bank, 2);
        assert!(task.await_latch(&owner, &mut ctx).await.is_err()); assert!(owner.release()); log(&events, "B:cleanup"); false
    };
    tokio::pin!(a, b);
    let group = latch_all2(&owner, &bank, [1, 2], a.as_mut(), b.as_mut(), [ac, bc], pr);
    tokio::pin!(group); pending(group.as_mut()); assert_eq!(owner.registered(), 2);
    external.send(true).unwrap(); pending(group.as_mut());
    assert_eq!(owner.registered(), if child_only { 1 } else { 0 }); assert!(!owner.has_scheduled());
    if child_only { assert_eq!(*events.lock().unwrap(), vec!["A:cleanup-start"]); }
    else { assert_eq!(*events.lock().unwrap(), vec!["A:cleanup-start", "B:cleanup"]); }
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    assert!(!ready(group.as_mut())); println!("CANCEL-{child_only}:{:?}", events.lock().unwrap());
}
#[tokio::main(flavor="current_thread")]
async fn main() { snapshot(); timer_wave().await; idle_child_cancellation(); cancellation(false).await; cancellation(true).await; }
`;

test("coordinator selection preserves Semaphore defaults and omits unused owner types", () => {
  const latch = semaphoreTaskRuntime({ protocolRetries: 1, scans: 1 }, true, "latch");
  expect(latch).toContain("async fn await_latch");
  expect(latch).not.toContain("ScanSemaphore");
  expect(latch).not.toContain("ScanPermit");
  expect(latch).not.toContain("async fn scan_join");
  expect(semaphoreTaskRuntime()).not.toContain("CohortLatch");
  const both = semaphoreTaskRuntime({ protocolRetries: 1, scans: 1 }, true, "both");
  expect(both).toContain("async fn acquire");
  expect(both).toContain("async fn await_latch");
});

test(
  "private generated Latch All detaches cohorts, completes due timers first and awaits cancellation cleanup",
  async () => {
    const official = await Effect.runPromise(
      Effect.gen(function* () {
        const owner = yield* Latch.make(false);
        const events: string[] = [];
        const log = (event: string) => Effect.sync(() => events.push(event));
        yield* Effect.all(
          [
            owner.await.pipe(
              Effect.andThen(log("A1")),
              Effect.andThen(owner.await),
              Effect.andThen(log("A2")),
            ),
            owner.await.pipe(Effect.andThen(log("B1")), Effect.andThen(owner.release)),
            owner.release.pipe(Effect.andThen(owner.close), Effect.andThen(log("C:signal"))),
          ],
          { concurrency: "unbounded" },
        );
        return events;
      }),
    );
    const directory = await mkdtemp(join(tmpdir(), "reffect-latch-all-"));
    try {
      await writeFile(
        join(directory, "main.rs"),
        [
          asyncRuntime(false, false),
          latchCohortRuntime(),
          semaphoreTaskRuntime(
            { protocolRetries: 1, scans: 32, timerRegistrations: 32 },
            true,
            "latch",
          ),
          latchAllRuntime({ cohorts: 32, settlementRounds: 3 }),
          harness,
        ].join("\n"),
      );
      await writeFile(
        join(directory, "Cargo.toml"),
        '[package]\nname="reffect_latch_all"\nversion="0.1.0"\nedition="2021"\n[[bin]]\nname="all"\npath="main.rs"\n[dependencies]\ntokio={version="=1.53.1",features=["rt","macros","sync","time"]}\n',
      );
      const execute = promisify(execFile);
      const options = {
        cwd: directory,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0" },
      };
      const debug = await execute("cargo", ["run", "--offline", "--quiet"], options);
      const release = await execute("cargo", ["run", "--release", "--offline", "--quiet"], options);
      expect(release.stdout).toEqual(debug.stdout);
      const snapshot = debug.stdout.split("\n").find((line) => line.startsWith("SNAPSHOT:"));
      expect(JSON.parse(snapshot!.slice("SNAPSHOT:".length))).toEqual(official);
      expect(debug.stdout).toContain('TIMER:["T1", "T2", "B"]');
      expect(debug.stdout).toContain("IDLE-CHILD:passed");
      expect(debug.stdout).toContain(
        'CANCEL-false:["A:cleanup-start", "B:cleanup", "A:cleanup-end"]',
      );
      expect(debug.stdout).toContain(
        'CANCEL-true:["A:cleanup-start", "A:cleanup-end", "B:cleanup"]',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(0) * 2,
);
