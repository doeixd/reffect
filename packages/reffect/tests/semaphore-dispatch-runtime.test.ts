import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Deferred, Effect, Fiber, Semaphore } from "effect";
import { expect, test } from "vite-plus/test";
import { semaphoreDispatchRuntime } from "../src/semaphore-dispatch-runtime.ts";
import { semaphoreNativeRuntime } from "../src/semaphore-native-runtime.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const kinds = [
  "ordered",
  "barge",
  "reentrant",
  "cancel-before-scan",
  "live-add",
  "cancel-and-requeue",
  "capacity-two",
];
const oracle = (kind: string) =>
  Effect.gen(function* () {
    const events: string[] = [];
    const log = (event: string) => Effect.sync(() => events.push(event));
    const owner = yield* Semaphore.make(kind === "capacity-two" ? 2 : 1);
    const gate = yield* Deferred.make<void>();
    const fibers: Fiber.Fiber<void>[] = [];
    let a: Fiber.Fiber<void> | undefined;
    const child = (name: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* owner.withPermit(
          Effect.gen(function* () {
            yield* log(`${name}:enter`);
            if (kind === "live-add" && name === "B") {
              fibers.push(yield* Effect.forkDetach(child("C"), { startImmediately: true }));
            }
            if (kind === "cancel-and-requeue" && name === "B" && a) {
              yield* Fiber.interrupt(a);
              fibers.splice(fibers.indexOf(a), 1);
              yield* log("A:canceled");
              fibers.push(yield* Effect.forkDetach(child("A"), { startImmediately: true }));
            }
            if (kind === "capacity-two") yield* Deferred.await(gate);
            yield* log(`${name}:exit`);
          }),
        );
        if (kind === "reentrant" && name === "B") {
          yield* log("B:after-release");
          yield* owner.withPermit(log("B:barge"));
          yield* log("B:after-barge");
        }
      });
    const register = Effect.gen(function* () {
      const b = yield* Effect.forkChild(child("B"), { startImmediately: true });
      fibers.push(b);
      a = yield* Effect.forkChild(child("A"), { startImmediately: true });
      fibers.push(a);
      if (kind === "cancel-and-requeue") {
        fibers.push(yield* Effect.forkChild(child("C"), { startImmediately: true }));
      }
      expect(events).toEqual([]);
      if (kind === "cancel-before-scan") {
        yield* Fiber.interrupt(b);
        fibers.shift();
        yield* log("B:canceled");
      }
      yield* log("holder:exit");
    });
    yield* owner.withPermit(
      kind === "capacity-two"
        ? owner.withPermit(register).pipe(Effect.andThen(log("holder:after-first")))
        : register,
    );
    yield* log("holder:after-release");
    if (kind === "barge") {
      yield* owner.withPermit(log("holder:barge"));
      yield* log("holder:after-barge");
    }
    if (kind === "capacity-two") {
      yield* Effect.yieldNow;
      expect(events.slice(-2)).toEqual(["B:enter", "A:enter"]);
      yield* Deferred.succeed(gate, undefined);
    }
    // Live additions append to this array during the selected callback.
    for (let i = 0; i < fibers.length; i++) yield* Fiber.join(fibers[i]!);
    return events;
  });

const harness = String.raw`
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
fn ready<T>(poll: Poll<T>) -> T { match poll { Poll::Ready(value) => value, Poll::Pending => panic!("Expected ready") } }
fn scenario(kind: &str) {
    let capacity = if kind == "capacity-two" { 2 } else { 1 };
    let owner = ScanSemaphore::<4>::new(capacity);
    let mut cx = Context::from_waker(Waker::noop());
    let held = ready(Pin::new(&mut owner.acquire(3)).poll(&mut cx));
    let extra = if capacity == 2 { Some(ready(Pin::new(&mut owner.acquire(3)).poll(&mut cx))) } else { None };
    let mut events = Vec::new();
    // Static task order A,B,C differs from registration order B,A,C.
    let mut waits = [Some(owner.acquire(0)), Some(owner.acquire(1)), Some(owner.acquire(2))];
    for task in [1, 0] { assert!(Pin::new(waits[task].as_mut().unwrap()).poll(&mut cx).is_pending()); }
    if kind == "cancel-and-requeue" { assert!(Pin::new(waits[2].as_mut().unwrap()).poll(&mut cx).is_pending()); }
    assert_eq!(owner.waiting(), if kind == "cancel-and-requeue" { 3 } else { 2 });
    if kind == "cancel-before-scan" { drop(waits[1].take()); events.push("B:canceled"); }
    events.push("holder:exit");
    if let Some(extra) = extra { drop(extra); events.push("holder:after-first"); }
    drop(held); events.push("holder:after-release");
    // Ordinary parent re-polls cannot select a still-registered observer.
    for task in [0, 1] {
        if let Some(wait) = waits[task].as_mut() { assert!(Pin::new(wait).poll(&mut cx).is_pending()); }
    }
    if kind == "barge" {
        let permit = ready(Pin::new(&mut owner.acquire(3)).poll(&mut cx));
        events.push("holder:barge"); drop(permit); events.push("holder:after-barge");
    }
    let mut retained = [None, None, None];
    let mut scan = 0; let mut first_scan = Vec::new();
    while {
      let dispatched = owner.dispatch_one(|task| {
        if scan == 0 { first_scan.push(task); }
        let permit = ready(Pin::new(waits[task].as_mut().unwrap()).poll(&mut cx));
        drop(waits[task].take());
        events.push(["A:enter", "B:enter", "C:enter"][task]);
        if kind == "live-add" && task == 1 {
            assert!(Pin::new(waits[2].as_mut().unwrap()).poll(&mut cx).is_pending());
        }
        if kind == "cancel-and-requeue" && task == 1 {
            drop(waits[0].take()); events.push("A:canceled");
            waits[0] = Some(owner.acquire(0));
            assert!(Pin::new(waits[0].as_mut().unwrap()).poll(&mut cx).is_pending());
        }
        if kind == "capacity-two" { retained[task] = Some(permit); return; }
        events.push(["A:exit", "B:exit", "C:exit"][task]); drop(permit);
        if kind == "reentrant" && task == 1 {
            events.push("B:after-release");
            let barged = ready(Pin::new(&mut owner.acquire(1)).poll(&mut cx));
            events.push("B:barge"); drop(barged); events.push("B:after-barge");
        }
      });
      if dispatched { scan += 1; }
      dispatched
    } {}
    if kind == "live-add" { assert_eq!(first_scan, vec![1, 0, 2]); }
    if kind == "cancel-and-requeue" { assert_eq!(first_scan, vec![1, 2, 0]); }
    if capacity == 2 {
        assert_eq!(owner.available(), 0);
        for task in [1, 0] {
            events.push(["A:exit", "B:exit"][task]); drop(retained[task].take());
        }
    }
    assert_eq!(owner.available(), capacity); assert_eq!(owner.waiting(), 0);
    println!("CASE:{kind}:{events:?}");
}
fn quiet() {
    TRACK.store(true, Ordering::Relaxed);
    for _ in 0..1000 {
        let owner = std::hint::black_box(ScanSemaphore::<4>::new(1));
        let mut cx = Context::from_waker(Waker::noop());
        let held = ready(Pin::new(&mut owner.acquire(3)).poll(&mut cx));
        let mut b = owner.acquire(1); let mut a = owner.acquire(0);
        assert!(Pin::new(&mut b).poll(&mut cx).is_pending());
        assert!(Pin::new(&mut a).poll(&mut cx).is_pending());
        drop(held);
        let mut count = 0;
        while owner.dispatch_one(|task| {
            let permit = ready(if task == 1 { Pin::new(&mut b).poll(&mut cx) } else { Pin::new(&mut a).poll(&mut cx) });
            std::hint::black_box(&permit); count += 1; drop(permit);
        }) {}
        assert_eq!(count, 2); assert_eq!(owner.available(), 1); assert_eq!(owner.waiting(), 0);
    }
    TRACK.store(false, Ordering::Relaxed);
    assert_eq!(ALLOCATIONS.load(Ordering::Relaxed), 0);
    println!("COST:{}:{}:{}:{}", ALLOCATIONS.load(Ordering::Relaxed),
        std::mem::size_of::<ScanSemaphore<4>>(), std::mem::size_of::<ScanAcquire<4>>(), std::mem::size_of::<ScanPermit<4>>());
}
async fn wake_all_counterexample() {
    let owner = ExperimentalSemaphore::<3>::new(1);
    let mut cx = Context::from_waker(Waker::noop());
    let held = ready(Pin::new(&mut owner.acquire()).poll(&mut cx));
    let mut b = owner.acquire(); let mut a = owner.acquire();
    assert!(Pin::new(&mut b).poll(&mut cx).is_pending());
    assert!(Pin::new(&mut a).poll(&mut cx).is_pending());
    drop(held);
    tokio::task::yield_now().await;
    // Same parent Waker, reversed static polling order: queued A overtakes B.
    let a_permit = ready(Pin::new(&mut a).poll(&mut cx));
    let mut events = vec!["holder:exit", "holder:after-release", "A:enter", "A:exit"];
    drop(a_permit);
    let b_permit = ready(Pin::new(&mut b).poll(&mut cx));
    events.extend(["B:enter", "B:exit"]); drop(b_permit);
    assert_eq!(owner.available(), 1); assert_eq!(owner.waiting(), 0);
    println!("COUNTEREXAMPLE:{events:?}");
}
#[tokio::main(flavor="current_thread")]
async fn main() {
    for _ in 0..10 {
        for kind in ["ordered", "barge", "reentrant", "cancel-before-scan", "live-add", "cancel-and-requeue", "capacity-two"] { scenario(kind); }
    }
    quiet(); wake_all_counterexample().await;
}
`;

test(
  "private inline scans preserve live waiter order, reentrancy and quiet allocation costs",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "reffect-semaphore-scan-"));
    try {
      await writeFile(
        join(directory, "main.rs"),
        `${semaphoreDispatchRuntime()}\n${semaphoreNativeRuntime()}\n${harness}`,
      );
      await writeFile(
        join(directory, "Cargo.toml"),
        `[package]\nname="reffect_semaphore_scan"\nversion="0.1.0"\nedition="2021"\n[[bin]]\nname="scan"\npath="main.rs"\n[dependencies]\ntokio={version="=1.53.1",features=["rt","macros","sync","time"]}\n`,
      );
      const options = {
        cwd: directory,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0" },
      };
      const debug = await promisify(execFile)("cargo", ["run", "--offline", "--quiet"], options);
      const release = await promisify(execFile)(
        "cargo",
        ["run", "--release", "--offline", "--quiet"],
        options,
      );
      expect(release.stdout).toEqual(debug.stdout);
      for (const kind of kinds) {
        const official = await Effect.runPromise(oracle(kind));
        const prefix = `CASE:${kind}:`;
        const lines = debug.stdout.split("\n").filter((line) => line.startsWith(prefix));
        expect(lines).toHaveLength(10);
        for (const line of lines) expect(JSON.parse(line.slice(prefix.length))).toEqual(official);
      }
      const counterexample = debug.stdout
        .split("\n")
        .find((line) => line.startsWith("COUNTEREXAMPLE:"))!;
      const raw = JSON.parse(counterexample.slice("COUNTEREXAMPLE:".length));
      expect(raw).not.toEqual(await Effect.runPromise(oracle("ordered")));
      expect(raw.slice(2, 4)).toEqual(["A:enter", "A:exit"]);
      const costs = debug.stdout
        .split("\n")
        .find((line) => line.startsWith("COST:"))!
        .split(":")
        .slice(1)
        .map(Number);
      console.info("Semaphore scan allocations/owner/acquire/permit:", costs.join("/"));
      expect(costs[0]).toBe(0);
      expect(costs.slice(1).every((size) => size > 0 && size <= 256)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(0) * 2,
);
