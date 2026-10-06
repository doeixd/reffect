import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Deferred, Effect, Exit, Fiber, Semaphore } from "effect";
import { expect, test } from "vite-plus/test";
import { asyncRuntime } from "../src/async-runtime.ts";
import { semaphoreDispatchRuntime } from "../src/semaphore-dispatch-runtime.ts";
import { semaphoreTaskRuntime } from "../src/semaphore-task-runtime.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const kinds = ["ordered", "barge", "reentrant", "queued-cancel", "holder-cancel", "parent-cleanup"];
const oracle = (kind: string) =>
  Effect.gen(function* () {
    const events: string[] = [];
    const log = (message: string) =>
      Effect.sync(() => {
        events.push(message);
      });
    const owner = yield* Semaphore.make(1);
    const startA = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const finishB = yield* Deferred.make<void>();
    const cleanup = yield* Deferred.make<void>();
    const setup = yield* Deferred.make<void>();
    let c: Fiber.Fiber<void> | undefined;
    let b: Fiber.Fiber<void> | undefined;
    const parent = yield* Effect.forkChild(
      Effect.gen(function* () {
        c = yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* owner.withPermit(
              Effect.gen(function* () {
                yield* log("holder:enter");
                yield* Deferred.await(release);
                yield* log("holder:exit");
              }).pipe(
                Effect.ensuring(
                  kind === "holder-cancel" || kind === "parent-cleanup"
                    ? log("holder:cleanup-start").pipe(
                        Effect.andThen(Deferred.await(cleanup)),
                        Effect.andThen(log("holder:cleanup-end")),
                      )
                    : Effect.void,
                ),
              ),
            );
            yield* log("holder:after-release");
            if (kind === "barge") {
              yield* owner.withPermit(log("holder:barge"));
              yield* log("holder:after-barge");
            }
          }),
          { startImmediately: true },
        );
        const a = yield* Effect.forkChild(
          Deferred.await(startA).pipe(
            Effect.andThen(log("A:attempt")),
            Effect.andThen(owner.withPermit(log("A:enter").pipe(Effect.andThen(log("A:exit"))))),
          ),
          { startImmediately: true },
        );
        b = yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* log("B:attempt");
            yield* owner.withPermit(
              log("B:enter").pipe(
                Effect.andThen(Deferred.await(finishB)),
                Effect.andThen(log("B:exit")),
              ),
            );
            if (kind === "reentrant") {
              yield* log("B:after-release");
              yield* owner.withPermit(log("B:barge"));
              yield* log("B:after-barge");
            }
          }).pipe(Effect.ensuring(log("B:cleanup"))),
          { startImmediately: true },
        );
        yield* Deferred.succeed(setup, undefined);
        const exits = yield* Effect.all([Fiber.await(c), Fiber.await(a), Fiber.await(b)]);
        return exits.map((exit) => Exit.isSuccess(exit));
      }),
      { startImmediately: true },
    );
    yield* Deferred.await(setup);
    expect(events).toEqual(["holder:enter", "B:attempt"]);
    yield* Deferred.succeed(startA, undefined);
    expect(events.at(-1)).toBe("A:attempt");
    if (kind === "queued-cancel" && b) {
      yield* Fiber.interrupt(b);
      yield* log("B:canceled");
    }
    if ((kind === "holder-cancel" || kind === "parent-cleanup") && c) {
      yield* Effect.forkChild(Fiber.interrupt(c), { startImmediately: true });
      yield* Effect.yieldNow;
      expect(events.at(-1)).toBe("holder:cleanup-start");
      if (kind === "parent-cleanup") {
        yield* Effect.forkChild(Fiber.interrupt(parent), { startImmediately: true });
        yield* Effect.yieldNow;
      }
      expect(events).not.toContain("A:enter");
      expect(events).not.toContain("B:enter");
      yield* Deferred.succeed(cleanup, undefined);
    } else {
      yield* Deferred.succeed(release, undefined);
    }
    if (kind !== "parent-cleanup" && kind !== "queued-cancel") {
      yield* Effect.yieldNow;
      expect(events).toContain("B:enter");
      expect(events).not.toContain("A:enter");
      yield* Deferred.succeed(finishB, undefined);
    }
    const result = yield* Fiber.await(parent);
    return {
      events,
      interrupted: Exit.isFailure(result),
      results: Exit.isSuccess(result) ? result.value : undefined,
    };
  });

const harness = String.raw`
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};
use std::sync::{Mutex, atomic::{AtomicBool, AtomicUsize, Ordering}};
struct Counter;
static TRACK: AtomicBool = AtomicBool::new(false);
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
unsafe impl std::alloc::GlobalAlloc for Counter {
    unsafe fn alloc(&self, layout: std::alloc::Layout) -> *mut u8 {
        if TRACK.load(Ordering::Relaxed) { ALLOCATIONS.fetch_add(1, Ordering::Relaxed); }
        unsafe { std::alloc::System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: std::alloc::Layout) {
        unsafe { std::alloc::System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: std::alloc::Layout, size: usize) -> *mut u8 {
        if TRACK.load(Ordering::Relaxed) { ALLOCATIONS.fetch_add(1, Ordering::Relaxed); }
        unsafe { std::alloc::System.realloc(ptr, layout, size) }
    }
}
#[global_allocator] static ALLOCATOR: Counter = Counter;
#[derive(Default)] struct Gate { open: AtomicBool, waker: Mutex<Option<Waker>> }
impl Gate {
    fn open(&self) {
        self.open.store(true, Ordering::SeqCst);
        if let Some(waker) = self.waker.lock().unwrap().take() { waker.wake(); }
    }
    async fn wait(&self) {
        std::future::poll_fn(|cx| {
            let mut waker = self.waker.lock().unwrap();
            if self.open.load(Ordering::SeqCst) { Poll::Ready(()) }
            else { *waker = Some(cx.waker().clone()); Poll::Pending }
        }).await
    }
}
#[derive(Default)] struct Gates { a: Gate, release: Gate, b: Gate, cleanup: Gate }
fn log(events: &Mutex<Vec<&'static str>>, message: &'static str) { events.lock().unwrap().push(message); }
async fn wait(task: ScanTask<'_, 4>, ctx: &mut AsyncContext, gate: &Gate) -> bool {
    task.semantic(async {
        tokio::select! {
            biased;
            _ = ctx.cancellation.changed() => false,
            _ = gate.wait() => true,
        }
    }).await
}
async fn holder(task: ScanTask<'_, 4>, owner: &ScanSemaphore<4>, mut ctx: AsyncContext,
    gates: &Gates, events: &Mutex<Vec<&'static str>>, kind: &str) -> bool {
    let Ok(permit) = task.acquire(owner, &mut ctx).await else { return false; };
    log(events, "holder:enter");
    let success = wait(task, &mut ctx, &gates.release).await;
    if success { log(events, "holder:exit"); }
    if kind == "holder-cancel" || kind == "parent-cleanup" {
        let previous = ctx.interruptible; ctx.interruptible = false;
        log(events, "holder:cleanup-start");
        task.semantic(gates.cleanup.wait()).await;
        log(events, "holder:cleanup-end");
        ctx.interruptible = previous;
    }
    drop(permit);
    if !success || ctx.is_cancelled() { return false; }
    log(events, "holder:after-release");
    if kind == "barge" {
        let permit = task.acquire(owner, &mut ctx).await.unwrap();
        log(events, "holder:barge"); drop(permit); log(events, "holder:after-barge");
    }
    true
}
async fn a(task: ScanTask<'_, 4>, owner: &ScanSemaphore<4>, mut ctx: AsyncContext,
    gates: &Gates, events: &Mutex<Vec<&'static str>>) -> bool {
    if !wait(task, &mut ctx, &gates.a).await { return false; }
    log(events, "A:attempt");
    let Ok(permit) = task.acquire(owner, &mut ctx).await else { return false; };
    log(events, "A:enter"); log(events, "A:exit"); drop(permit); true
}
async fn b(task: ScanTask<'_, 4>, owner: &ScanSemaphore<4>, mut ctx: AsyncContext,
    gates: &Gates, events: &Mutex<Vec<&'static str>>, kind: &str) -> bool {
    if ctx.is_cancelled() { return false; }
    log(events, "B:attempt");
    let success = if let Ok(permit) = task.acquire(owner, &mut ctx).await {
        log(events, "B:enter");
        let success = wait(task, &mut ctx, &gates.b).await;
        if success { log(events, "B:exit"); }
        drop(permit);
        if success && kind == "reentrant" {
            log(events, "B:after-release");
            let permit = task.acquire(owner, &mut ctx).await.unwrap();
            log(events, "B:barge"); drop(permit); log(events, "B:after-barge");
        }
        success
    } else { false };
    log(events, "B:cleanup"); success
}
fn pending<F: Future>(future: Pin<&mut F>, cx: &mut Context<'_>) { assert!(future.poll(cx).is_pending()); }
fn scenario(kind: &str) {
    let owner = ScanSemaphore::<4>::new(1); let bank = ScanTasks::<4>::new();
    let gates = Gates::default(); let events = Mutex::new(Vec::new());
    let (cc, cr) = tokio::sync::watch::channel(false);
    let (ac, ar) = tokio::sync::watch::channel(false);
    let (bc, br) = tokio::sync::watch::channel(false);
    let (pc, pr) = tokio::sync::watch::channel(false);
    let c = holder(ScanTask::new(&bank, 0), &owner, AsyncContext::new(cr), &gates, &events, kind);
    let a = a(ScanTask::new(&bank, 1), &owner, AsyncContext::new(ar), &gates, &events);
    let b = b(ScanTask::new(&bank, 2), &owner, AsyncContext::new(br), &gates, &events, kind);
    tokio::pin!(c, a, b);
    let children = scan_join3(&owner, &bank, [0, 1, 2], c.as_mut(), a.as_mut(), b.as_mut());
    let group = scan_with_parent(children, pr, [cc.clone(), ac, bc.clone()]);
    tokio::pin!(group); let mut cx = Context::from_waker(Waker::noop());
    if kind == "pre-aborted" {
        pc.send(true).unwrap();
        assert!(matches!(group.as_mut().poll(&mut cx), Poll::Ready(((false, false, false), true))));
        assert!(events.lock().unwrap().is_empty());
        assert_eq!(owner.available(), 1); assert_eq!(owner.waiting(), 0);
        println!("PREABORT:passed"); return;
    }
    pending(group.as_mut(), &mut cx); assert_eq!(owner.waiting(), 1);
    gates.a.open(); pending(group.as_mut(), &mut cx); assert_eq!(owner.waiting(), 2);
    if kind == "queued-cancel" {
        bc.send(true).unwrap(); pending(group.as_mut(), &mut cx);
        assert_eq!(owner.waiting(), 1); log(&events, "B:canceled");
    }
    if kind == "holder-cancel" || kind == "parent-cleanup" {
        cc.send(true).unwrap(); pending(group.as_mut(), &mut cx);
        assert_eq!(owner.available(), 0); assert_eq!(owner.waiting(), 2);
        if kind == "parent-cleanup" {
            pc.send(true).unwrap(); pending(group.as_mut(), &mut cx);
            assert_eq!(owner.available(), 0); assert_eq!(owner.waiting(), 0);
        }
        gates.cleanup.open();
    } else { gates.release.open(); }
    let result = if kind == "parent-cleanup" || kind == "queued-cancel" {
        match group.as_mut().poll(&mut cx) { Poll::Ready(value) => value, Poll::Pending => panic!("Expected completed group") }
    } else {
        pending(group.as_mut(), &mut cx);
        assert_eq!(owner.available(), 0); assert_eq!(owner.waiting(), 1);
        assert!(!events.lock().unwrap().contains(&"A:enter"));
        gates.b.open();
        match group.as_mut().poll(&mut cx) { Poll::Ready(value) => value, Poll::Pending => panic!("Expected completed group") }
    };
    assert_eq!(owner.available(), 1); assert_eq!(owner.waiting(), 0);
    let (results, interrupted) = result;
    let results = if interrupted { "null".to_owned() } else { format!("[{},{},{}]", results.0, results.1, results.2) };
    println!("CASE:{kind}:{{\"events\":{:?},\"interrupted\":{interrupted},\"results\":{results}}}", events.lock().unwrap());
}
struct Retry { yielded: bool }
impl Future for Retry {
    type Output = ();
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.yielded { Poll::Ready(()) } else { self.yielded = true; cx.waker().wake_by_ref(); Poll::Pending }
    }
}
fn protocol_retry() {
    let owner = ScanSemaphore::<4>::new(1); let bank = ScanTasks::<4>::new();
    let events = Mutex::new(Vec::new()); let gate = Gate::default();
    let held = {
        let mut acquire = owner.acquire(3); let mut cx = Context::from_waker(Waker::noop());
        match Pin::new(&mut acquire).poll(&mut cx) { Poll::Ready(permit) => permit, _ => panic!() }
    };
    let b = async {
        let permit = ScanTask::new(&bank, 1).semantic(owner.acquire(1)).await;
        log(&events, "B:enter"); drop(permit);
        Retry { yielded: false }.await; log(&events, "B:tail");
    };
    let a = async {
        let permit = ScanTask::new(&bank, 0).semantic(owner.acquire(0)).await;
        log(&events, "A:enter"); drop(permit);
    };
    let delay = async { ScanTask::new(&bank, 0).semantic(gate.wait()).await; a.await; };
    tokio::pin!(b, delay);
    let joined = scan_join2(&owner, &bank, [1, 0], b.as_mut(), delay.as_mut());
    tokio::pin!(joined); let mut cx = Context::from_waker(Waker::noop());
    pending(joined.as_mut(), &mut cx); gate.open(); pending(joined.as_mut(), &mut cx);
    drop(held);
    assert!(joined.as_mut().poll(&mut cx).is_ready());
    assert_eq!(*events.lock().unwrap(), vec!["B:enter", "B:tail", "A:enter"]);
    println!("PROTOCOL:passed");
}
fn selected_cancel() {
    let owner = ScanSemaphore::<4>::new(1); let bank = ScanTasks::<4>::new();
    let (cancel, rx) = tokio::sync::watch::channel(false);
    let mut ctx = AsyncContext::new(rx); let task = ScanTask::new(&bank, 0);
    let mut cx = Context::from_waker(Waker::noop());
    let held = match Pin::new(&mut owner.acquire(3)).poll(&mut cx) { Poll::Ready(permit) => permit, _ => panic!() };
    let acquire = task.acquire(&owner, &mut ctx); tokio::pin!(acquire);
    bank.before_poll(0); pending(acquire.as_mut(), &mut cx); drop(held);
    assert!(owner.dispatch_one(|selected| {
        assert_eq!(selected, 0); cancel.send(true).unwrap();
        assert!(matches!(acquire.as_mut().poll(&mut cx), Poll::Ready(Err(AsyncError::Interrupted))));
    }));
    assert_eq!(owner.available(), 1); assert_eq!(owner.waiting(), 0);
    println!("SELECTED:passed");
}
fn quiet() {
    let mut driver_size = 0; let mut child_size = 0;
    TRACK.store(true, Ordering::Relaxed);
    for _ in 0..1000 {
        let owner = std::hint::black_box(ScanSemaphore::<4>::new(1)); let bank = ScanTasks::<4>::new();
        let mut cx = Context::from_waker(Waker::noop());
        let held = match Pin::new(&mut owner.acquire(3)).poll(&mut cx) { Poll::Ready(permit) => permit, _ => panic!() };
        let a = async { let permit = ScanTask::new(&bank, 0).semantic(owner.acquire(0)).await; std::hint::black_box(&permit); drop(permit); };
        let b = async { let permit = ScanTask::new(&bank, 1).semantic(owner.acquire(1)).await; std::hint::black_box(&permit); drop(permit); };
        child_size = std::mem::size_of_val(&a);
        tokio::pin!(a, b);
        let joined = scan_join2(&owner, &bank, [0, 1], a.as_mut(), b.as_mut());
        driver_size = std::mem::size_of_val(&joined);
        tokio::pin!(joined);
        pending(joined.as_mut(), &mut cx); assert_eq!(owner.waiting(), 2);
        drop(held); assert!(joined.as_mut().poll(&mut cx).is_ready());
        assert_eq!(owner.available(), 1); assert_eq!(owner.waiting(), 0);
    }
    TRACK.store(false, Ordering::Relaxed);
    assert_eq!(ALLOCATIONS.load(Ordering::Relaxed), 0);
    println!("COST:{}:{}:{}:{}", ALLOCATIONS.load(Ordering::Relaxed), driver_size, child_size, std::mem::size_of::<ScanTasks<4>>());
}
#[tokio::main(flavor="current_thread")]
async fn main() {
    for _ in 0..10 {
        for kind in ["ordered", "barge", "reentrant", "queued-cancel", "holder-cancel", "parent-cleanup"] { scenario(kind); }
    }
    protocol_retry(); selected_cancel(); scenario("pre-aborted"); quiet();
}
`;

test(
  "private real-future Semaphore driver preserves suspended ownership and cooperative cleanup",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "reffect-semaphore-tasks-"));
    try {
      await writeFile(
        join(directory, "main.rs"),
        [
          asyncRuntime(false, false),
          semaphoreDispatchRuntime(),
          semaphoreTaskRuntime(),
          harness,
        ].join("\n"),
      );
      await writeFile(
        join(directory, "Cargo.toml"),
        `[package]\nname="reffect_semaphore_tasks"\nversion="0.1.0"\nedition="2021"\n[[bin]]\nname="tasks"\npath="main.rs"\n[dependencies]\ntokio={version="=1.53.1",features=["rt","macros","sync","time"]}\n`,
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
      for (const kind of kinds) {
        const official = await Effect.runPromise(oracle(kind));
        const prefix = `CASE:${kind}:`;
        const lines = debug.stdout.split("\n").filter((line) => line.startsWith(prefix));
        expect(lines).toHaveLength(10);
        for (const line of lines)
          expect(JSON.parse(line.slice(prefix.length))).toEqual({
            ...official,
            results: official.results ?? null,
          });
      }
      expect(debug.stdout).toContain("PROTOCOL:passed");
      expect(debug.stdout).toContain("SELECTED:passed");
      expect(debug.stdout).toContain("PREABORT:passed");
      for (const stdout of [debug.stdout, release.stdout]) {
        const costs = stdout
          .split("\n")
          .find((line) => line.startsWith("COST:"))!
          .split(":")
          .slice(1)
          .map(Number);
        expect(costs[0]).toBe(0);
        expect(costs.slice(1).every((size) => size > 0 && size <= 2048)).toBe(true);
        console.info("Semaphore driver allocations/driver/child/bank:", costs.join("/"));
      }
      const abortedEvents: string[] = [];
      const aborted = await Effect.runPromiseExit(
        Effect.gen(function* () {
          yield* Effect.interrupt;
          const owner = yield* Semaphore.make(1);
          yield* Effect.all(
            [0, 1, 2].map(() =>
              owner.withPermit(
                Effect.sync(() => {
                  abortedEvents.push("entered");
                }),
              ),
            ),
            { concurrency: "unbounded" },
          );
        }),
      );
      expect(Exit.isFailure(aborted)).toBe(true);
      expect(abortedEvents).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(0) * 2,
);
