import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect, Fiber, Latch } from "effect";
import { expect, test } from "vite-plus/test";
import { latchCohortRuntime } from "../src/latch-cohort-runtime.ts";

const kinds = [
  "ordered",
  "close-grant",
  "release-late",
  "coalesced",
  "reentrant",
  "cancel-waiting",
  "cancel-scheduled",
  "cancel-detached",
  "cancel-reuse",
  "renew-cohort",
] as const;

const oracle = (kind: string) =>
  Effect.gen(function* () {
    const latch = yield* Latch.make();
    const events: string[] = [];
    const log = (value: string) => Effect.sync(() => events.push(value));
    const fibers: Fiber.Fiber<void>[] = [];
    let a: Fiber.Fiber<void> | undefined;
    const child = (name: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Latch.await(latch);
        yield* log(`${name}:enter`);
        if (
          name === "B" &&
          ["cancel-detached", "cancel-reuse", "renew-cohort"].includes(kind) &&
          a
        ) {
          yield* Fiber.interrupt(a);
          fibers.splice(fibers.indexOf(a), 1);
          yield* log("A:canceled");
          if (kind === "cancel-reuse" || kind === "renew-cohort") {
            fibers.push(yield* Effect.forkDetach(child("A2"), { startImmediately: true }));
            if (kind === "renew-cohort")
              fibers.push(yield* Effect.forkDetach(child("B2"), { startImmediately: true }));
            yield* Latch.release(latch);
            yield* log("B:pulse");
          }
        }
        if (name === "B" && kind === "reentrant") {
          fibers.push(yield* Effect.forkDetach(child("C"), { startImmediately: true }));
          yield* Latch.release(latch);
          yield* log("B:pulse");
        }
      });
    fibers.push(yield* Effect.forkChild(child("B"), { startImmediately: true }));
    a = yield* Effect.forkChild(child("A"), { startImmediately: true });
    fibers.push(a);
    expect(events).toEqual([]);
    if (kind === "cancel-waiting") {
      yield* Fiber.interrupt(a);
      fibers.splice(fibers.indexOf(a), 1);
      yield* log("A:canceled");
    }
    const signal = kind === "close-grant" ? Latch.open(latch) : Latch.release(latch);
    expect(yield* signal).toBe(true);
    if (kind === "close-grant") expect(yield* Latch.close(latch)).toBe(true);
    yield* log("parent:signal");
    if (kind === "cancel-scheduled") {
      yield* Fiber.interrupt(a);
      fibers.splice(fibers.indexOf(a), 1);
      yield* log("A:canceled");
    }
    if (["release-late", "coalesced"].includes(kind)) {
      fibers.push(yield* Effect.forkChild(child("C"), { startImmediately: true }));
      if (kind === "coalesced") {
        expect(yield* Latch.release(latch)).toBe(true);
        yield* log("parent:second-pulse");
      }
    }
    // A queued parent continuation follows the detached first cohort, before a new pulse's callback.
    yield* Effect.yieldNow;
    yield* log("parent:after-first");
    expect(Latch.isOpen(latch)).toBe(false);
    if (kind === "release-late") {
      expect(events).not.toContain("C:enter");
      yield* Latch.open(latch);
      yield* Latch.close(latch);
      yield* log("parent:late-open-close");
    }
    for (let i = 0; i < fibers.length; i++) yield* Fiber.join(fibers[i]!);
    return events;
  });

const harness = String.raw`
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
struct Allocator;
static TRACK: AtomicBool = AtomicBool::new(false);
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
unsafe impl std::alloc::GlobalAlloc for Allocator {
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
#[global_allocator] static ALLOCATOR: Allocator = Allocator;
fn poll<T: Future + Unpin>(future: &mut T) -> Poll<T::Output> {
    Pin::new(future).poll(&mut Context::from_waker(Waker::noop()))
}
fn scenario(kind: &str) {
    let latch = CohortLatch::<4>::new(false);
    let mut waits = [Some(latch.wait(0)), Some(latch.wait(1)), Some(latch.wait(2))];
    let mut events = Vec::new();
    let mut names = ["A", "B", "C"];
    for task in [1, 0] { assert!(poll(waits[task].as_mut().unwrap()).is_pending()); }
    if kind == "cancel-waiting" { drop(waits[0].take()); events.push("A:canceled"); }
    assert!(if kind == "close-grant" { latch.open() } else { latch.release() });
    if kind == "close-grant" { assert!(latch.close()); }
    events.push("parent:signal");
    if kind == "cancel-scheduled" { drop(waits[0].take()); events.push("A:canceled"); }
    if kind == "release-late" || kind == "coalesced" {
        assert!(poll(waits[2].as_mut().unwrap()).is_pending());
        if kind == "coalesced" { assert!(latch.release()); events.push("parent:second-pulse"); }
    }
    // Unrelated parent wake cannot deliver a grant before the cohort callback.
    for task in [1, 0] {
        if let Some(wait) = waits[task].as_mut() { assert!(poll(wait).is_pending()); }
    }
    let mut resume = |task: usize| {
        assert_eq!(poll(waits[task].as_mut().expect("Selected live lease")), Poll::Ready(()));
        drop(waits[task].take());
        events.push(match names[task] { "A" => "A:enter", "A2" => "A2:enter", "B" => "B:enter", "B2" => "B2:enter", _ => "C:enter" });
        if task == 1 && (kind == "cancel-detached" || kind == "cancel-reuse" || kind == "renew-cohort") {
            drop(waits[0].take()); events.push("A:canceled");
            if kind == "cancel-reuse" || kind == "renew-cohort" {
                names[0] = "A2"; waits[0] = Some(latch.wait(0));
                assert!(poll(waits[0].as_mut().unwrap()).is_pending());
                if kind == "renew-cohort" {
                    names[1] = "B2"; waits[1] = Some(latch.wait(1));
                    assert!(poll(waits[1].as_mut().unwrap()).is_pending());
                }
                assert!(latch.release()); events.push("B:pulse");
            }
        }
        if task == 1 && kind == "reentrant" {
            assert!(poll(waits[2].as_mut().unwrap()).is_pending());
            assert!(latch.release()); events.push("B:pulse");
        }
    };
    assert!(latch.dispatch_one(&mut resume));
    // Release the closure borrow to place the driver's first-cohort boundary in the trace.
    drop(resume);
    events.push("parent:after-first");
    assert!(!latch.is_open());
    if kind == "release-late" {
        assert!(!events.contains(&"C:enter")); assert!(!latch.has_scheduled());
        assert!(latch.open()); assert!(latch.close()); events.push("parent:late-open-close");
    }
    while latch.dispatch_one(|task| {
        assert_eq!(poll(waits[task].as_mut().unwrap()), Poll::Ready(()));
        drop(waits[task].take()); events.push(if task == 0 { "A2:enter" } else if task == 1 { "B2:enter" } else { "C:enter" });
    }) {}
    assert_eq!(latch.registered(), 0); assert!(!latch.has_scheduled());
    println!("CASE:{kind}:{events:?}");
}
fn transitions() {
    let latch = CohortLatch::<1>::new(false);
    assert!(latch.release()); // Empty pulse cannot be saved for a future await.
    let mut wait = latch.wait(0); assert!(poll(&mut wait).is_pending());
    assert!(!latch.close()); assert!(latch.open()); assert!(!latch.open());
    assert!(!latch.release()); assert!(poll(&mut wait).is_pending());
    assert!(latch.close()); assert!(!latch.close());
    assert!(latch.dispatch_one(|task| { assert_eq!(task, 0); assert_eq!(poll(&mut wait), Poll::Ready(())); }));
    assert!(!latch.dispatch_one(|_| panic!("No retained callback")));
    let open = CohortLatch::<1>::new(true);
    assert_eq!(poll(&mut open.wait(0)), Poll::Ready(())); assert_eq!(open.registered(), 0);
    // Each capacity is exercised; occupied slots are reclaimed on cancellation, not tombstoned.
    fn bound<const N: usize>() {
        let owner = CohortLatch::<N>::new(false);
        let mut waits = std::array::from_fn::<_, N, _>(|task| Some(owner.wait(task)));
        for wait in waits.iter_mut().flatten() { assert!(poll(wait).is_pending()); }
        assert_eq!(owner.registered(), N); assert!(owner.release());
        for wait in &mut waits { drop(wait.take()); }
        assert_eq!(owner.registered(), 0); assert!(!owner.dispatch_one(|_| panic!("Canceled cohort")));
    }
    bound::<1>(); bound::<2>(); bound::<3>(); bound::<4>();
    let owner = CohortLatch::<1>::new(false);
    let mut granted = Some(owner.wait(0));
    assert!(poll(granted.as_mut().unwrap()).is_pending()); assert!(owner.release());
    assert!(owner.dispatch_one(|_| { drop(granted.take()); }));
    assert_eq!(owner.registered(), 0); // Cancellation after grant but before poll frees the lease.
    let mut replacement = owner.wait(0); assert!(poll(&mut replacement).is_pending());
    assert!(!owner.dispatch_one(|_| panic!("Old grant cannot reach replacement")));
    drop(replacement); assert_eq!(owner.registered(), 0);
    let owner = CohortLatch::<2>::new(false);
    let mut old = owner.wait(1); assert!(poll(&mut old).is_pending());
    assert!(owner.release()); assert!(owner.open()); assert!(owner.close());
    let mut late = owner.wait(0); assert!(poll(&mut late).is_pending()); assert!(owner.open());
    let mut order = Vec::new();
    assert!(owner.dispatch_one(|task| {
        order.push(task);
        assert_eq!(if task == 1 { poll(&mut old) } else { poll(&mut late) }, Poll::Ready(()));
    }));
    assert_eq!(order, vec![1, 0]); assert_eq!(owner.registered(), 0);
}
fn quiet() {
    TRACK.store(true, Ordering::Relaxed);
    let latch = std::hint::black_box(CohortLatch::<4>::new(false));
    for _ in 0..1000 {
        let mut b = latch.wait(1); let mut a = latch.wait(0);
        assert!(poll(&mut b).is_pending()); assert!(poll(&mut a).is_pending());
        assert!(latch.release()); drop(a);
        let mut count = 0;
        assert!(latch.dispatch_one(|task| { assert_eq!(task, 1); assert_eq!(poll(&mut b), Poll::Ready(())); count += 1; }));
        assert_eq!(count, 1); assert_eq!(latch.registered(), 0);
        let mut late = latch.wait(0); assert!(poll(&mut late).is_pending());
        assert!(latch.open()); assert!(latch.close()); drop(late);
        assert!(!latch.dispatch_one(|_| panic!("Canceled scheduled lease")));
        assert_eq!(latch.registered(), 0);
    }
    TRACK.store(false, Ordering::Relaxed);
    assert_eq!(ALLOCATIONS.load(Ordering::Relaxed), 0);
    println!("COST:{}:{}:{}:{}", ALLOCATIONS.load(Ordering::Relaxed),
        std::mem::size_of::<CohortLatch<4>>(), std::mem::size_of::<LatchAwait<4>>(),
        std::mem::size_of::<[Option<LatchRegistration>; 4]>());
}
fn main() {
    transitions();
    for _ in 0..10 {
        for kind in ["ordered", "close-grant", "release-late", "coalesced", "reentrant",
            "cancel-waiting", "cancel-scheduled", "cancel-detached", "cancel-reuse", "renew-cohort"] { scenario(kind); }
    }
    quiet();
}
`;

test("official Latch detaches pulse cohorts in registration order", async () => {
  expect(await Effect.runPromise(oracle("ordered"))).toEqual([
    "parent:signal",
    "B:enter",
    "A:enter",
    "parent:after-first",
  ]);
  for (const kind of kinds) await Effect.runPromise(oracle(kind));
});

test("inline Latch cohorts match official grants, cancellation and reentrancy without allocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reffect-latch-cohort-"));
  try {
    const source = join(directory, "main.rs");
    await writeFile(source, `${latchCohortRuntime()}\n${harness}`);
    const outputs: string[] = [];
    for (const optimized of [false, true]) {
      const binary = join(directory, optimized ? "release" : "debug");
      await promisify(execFile)(
        "rustc",
        ["--edition=2021", ...(optimized ? ["-O"] : []), source, "-o", binary],
        {
          timeout: 60000,
        },
      );
      outputs.push((await promisify(execFile)(binary, [], { timeout: 10000 })).stdout);
    }
    expect(outputs[1]).toEqual(outputs[0]);
    for (const kind of kinds) {
      const official = await Effect.runPromise(oracle(kind));
      const prefix = `CASE:${kind}:`;
      const lines = outputs[0]!.split("\n").filter((line) => line.startsWith(prefix));
      expect(lines).toHaveLength(10);
      for (const line of lines) expect(JSON.parse(line.slice(prefix.length))).toEqual(official);
    }
    const costs = outputs[0]!
      .split("\n")
      .find((line) => line.startsWith("COST:"))!
      .split(":")
      .slice(1)
      .map(Number);
    console.info("Latch allocations/owner/await/cohort bytes:", costs.join("/"));
    expect(costs[0]).toBe(0);
    expect(costs.slice(1).every((size) => size > 0 && size <= 256)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180000);
