import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";
import { deferredStateRuntime } from "../src/deferred-state-runtime.ts";
import { deferredTurnRuntime } from "../src/deferred-turn-runtime.ts";

const execute = promisify(execFile);
const harness = String.raw`
use std::{future::Future, pin::Pin, task::{Context, Poll}};
fn poll<F: Future + Unpin>(future: &mut F) -> Poll<F::Output> {
    Pin::new(future).poll(&mut Context::from_waker(std::task::Waker::noop()))
}
fn ack<const M: usize>(bank: &DeferredTurns<M>, task: usize) {
    bank.before_poll(task);
    bank.after_poll(task, true, std::task::Waker::noop());
}
fn state_cases() {
    let bank = DeferredTurns::<6>::new();
    let owner = DeferredState::<u64, bool, 3>::new();
    assert!(!owner.is_done());
    let mut canceled = owner.wait(&bank, 1);
    let mut second = owner.wait(&bank, 2);
    assert!(poll(&mut canceled).is_pending());
    assert!(poll(&mut second).is_pending());
    drop(canceled);
    let mut third = owner.wait(&bank, 3); // Reuses physical slot zero; registration remains last.
    assert!(poll(&mut third).is_pending());
    let mut complete = owner.complete(&bank, 4, Ok(7));
    assert!(poll(&mut complete).is_pending());
    assert!(owner.is_done());
    assert_eq!(bank.priority(), Some(2));
    assert!(bank.permits(2, |_, _| false));
    assert!(!bank.permits(3, |_, _| false));
    assert!(bank.take_changed());
    assert!(poll(&mut third).is_pending()); // Retained outcome cannot bypass detached ordering.
    let mut late = owner.wait(&bank, 5);
    assert_eq!(poll(&mut late), Poll::Ready(Ok(7)));
    assert_eq!(poll(&mut owner.complete(&bank, 5, Err(true))), Poll::Ready(false));
    assert_eq!(poll(&mut second), Poll::Ready(Ok(7)));
    assert!(poll(&mut complete).is_pending()); // Await result alone is not a turn acknowledgement.
    ack(&bank, 2);
    assert!(poll(&mut complete).is_pending());
    assert_eq!(bank.priority(), Some(3));
    assert_eq!(poll(&mut third), Poll::Ready(Ok(7)));
    ack(&bank, 3);
    assert_eq!(poll(&mut complete), Poll::Ready(true));
    assert_eq!(bank.priority(), None);
    assert!(owner.state.lock().unwrap().slots.iter().all(Option::is_none));

    // Cancellation of a detached but unselected registration cannot skip the following one.
    let owner = DeferredState::<(), u64, 3>::new();
    let mut first = owner.wait(&bank, 1);
    let mut canceled = owner.wait(&bank, 2);
    let mut last = owner.wait(&bank, 3);
    assert!(poll(&mut first).is_pending());
    assert!(poll(&mut canceled).is_pending());
    assert!(poll(&mut last).is_pending());
    let mut complete = owner.complete(&bank, 4, Err(19));
    assert!(poll(&mut complete).is_pending());
    drop(canceled);
    assert_eq!(poll(&mut first), Poll::Ready(Err(19)));
    ack(&bank, 1);
    assert!(poll(&mut complete).is_pending());
    assert_eq!(bank.priority(), Some(3));
    assert_eq!(poll(&mut last), Poll::Ready(Err(19)));
    ack(&bank, 3);
    assert_eq!(poll(&mut complete), Poll::Ready(true));
    assert_eq!(poll(&mut owner.wait(&bank, 5)), Poll::Ready(Err(19)));

    // A selected canceled registration still receives task-level cleanup acknowledgement.
    let owner = DeferredState::<bool, (), 1>::new();
    let mut waiter = owner.wait(&bank, 1);
    assert!(poll(&mut waiter).is_pending());
    let mut complete = owner.complete(&bank, 4, Ok(true));
    assert!(poll(&mut complete).is_pending());
    drop(waiter);
    assert!(poll(&mut complete).is_pending());
    ack(&bank, 1);
    assert_eq!(poll(&mut complete), Poll::Ready(true));

    // Pending cancellation reclaims head, middle and tail, repeatedly without an epoch counter.
    let owner = DeferredState::<(), (), 3>::new();
    for _ in 0..100 {
        let mut head = owner.wait(&bank, 1);
        let mut middle = owner.wait(&bank, 2);
        let mut tail = owner.wait(&bank, 3);
        assert!(poll(&mut head).is_pending());
        assert!(poll(&mut middle).is_pending());
        assert!(poll(&mut tail).is_pending());
        drop(middle); drop(head); drop(tail);
        let state = owner.state.lock().unwrap();
        assert!(state.slots.iter().all(Option::is_none));
        assert!(state.head.is_none() && state.tail.is_none());
    }
    // Empty cohorts, distinct typed owners, and completion before first await polling.
    assert_eq!(poll(&mut owner.complete(&bank, 4, Ok(()))), Poll::Ready(true));
    assert_eq!(poll(&mut owner.wait(&bank, 1)), Poll::Ready(Ok(())));
    let other = DeferredState::<bool, u64, 1>::new();
    assert!(!other.is_done());
    assert_eq!(poll(&mut other.complete(&bank, 4, Err(23))), Poll::Ready(true));
    assert_eq!(poll(&mut other.wait(&bank, 1)), Poll::Ready(Err(23)));
}
fn nested_case() {
    let bank = DeferredTurns::<6>::new();
    let outer = DeferredState::<u64, (), 2>::new();
    let inner = DeferredState::<bool, (), 1>::new();
    let mut first = outer.wait(&bank, 1);
    let mut second = outer.wait(&bank, 2);
    let mut nested_waiter = inner.wait(&bank, 3);
    assert!(poll(&mut first).is_pending());
    assert!(poll(&mut second).is_pending());
    assert!(poll(&mut nested_waiter).is_pending());
    let mut complete_outer = outer.complete(&bank, 4, Ok(7));
    assert!(poll(&mut complete_outer).is_pending());
    assert_eq!(poll(&mut first), Poll::Ready(Ok(7)));
    let mut complete_inner = inner.complete(&bank, 1, Ok(true));
    assert!(poll(&mut complete_inner).is_pending());
    assert_eq!(bank.priority(), Some(3));
    assert_eq!(poll(&mut nested_waiter), Poll::Ready(Ok(true)));
    ack(&bank, 3);
    assert_eq!(poll(&mut complete_inner), Poll::Ready(true));
    assert_eq!(bank.priority(), Some(1));
    // Nested adapter Pending did not acknowledge the outer waiter.
    assert!(poll(&mut complete_outer).is_pending());
    ack(&bank, 1);
    assert!(poll(&mut complete_outer).is_pending());
    assert_eq!(bank.priority(), Some(2));
    assert_eq!(poll(&mut second), Poll::Ready(Ok(7)));
    ack(&bank, 2);
    assert_eq!(poll(&mut complete_outer), Poll::Ready(true));
    assert_eq!(bank.priority(), None);
}
struct Count;
static ALLOCATIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
unsafe impl std::alloc::GlobalAlloc for Count {
    unsafe fn alloc(&self, layout: std::alloc::Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        unsafe { std::alloc::System.alloc(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: std::alloc::Layout) {
        unsafe { std::alloc::System.dealloc(pointer, layout) }
    }
}
#[global_allocator] static ALLOCATOR: Count = Count;
fn costs() {
    let before = ALLOCATIONS.load(std::sync::atomic::Ordering::SeqCst);
    for _ in 0..100 {
        let bank = std::hint::black_box(DeferredTurns::<6>::new());
        let owner = std::hint::black_box(DeferredState::<u64, bool, 4>::new());
        let mut canceled = owner.wait(&bank, 1);
        assert!(poll(&mut canceled).is_pending());
        drop(canceled);
        let mut waiter = owner.wait(&bank, 2);
        assert!(poll(&mut waiter).is_pending());
        let mut complete = owner.complete(&bank, 4, Ok(7));
        assert!(poll(&mut complete).is_pending());
        assert_eq!(poll(&mut waiter), Poll::Ready(Ok(7)));
        ack(&bank, 2);
        assert_eq!(poll(&mut complete), Poll::Ready(true));
        assert_eq!(poll(&mut owner.complete(&bank, 4, Ok(9))), Poll::Ready(false));
        assert_eq!(poll(&mut owner.wait(&bank, 1)), Poll::Ready(Ok(7)));
    }
    assert_eq!(ALLOCATIONS.load(std::sync::atomic::Ordering::SeqCst) - before, 0);
    println!("LAYOUT:owner={},wait={},complete={},registration={}",
        std::mem::size_of::<DeferredState<u64, bool, 4>>(),
        std::mem::size_of::<DeferredWait<'_, u64, bool, 4, 6>>(),
        std::mem::size_of::<DeferredComplete<'_, u64, bool, 4, 6>>(),
        std::mem::size_of::<DeferredRegistration>());
}
fn main() { state_cases(); nested_case(); costs(); println!("state passed; isolated allocations=0"); }
`;

test("inline Deferred preserves typed retention, ordered cohorts and cancellation slot ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reffect-deferred-state-"));
  try {
    const source = join(directory, "main.rs");
    await writeFile(source, `${deferredTurnRuntime()}\n${deferredStateRuntime()}\n${harness}`);
    const outputs: string[] = [];
    for (const [name, options] of [
      ["debug", []],
      ["release", ["-O"]],
    ] as const) {
      const binary = join(directory, name);
      await execute(
        "rustc",
        ["--edition=2021", "-D", "warnings", ...options, source, "-o", binary],
        {
          timeout: 30000,
        },
      );
      outputs.push((await execute(binary, [], { timeout: 10000 })).stdout);
    }
    // Compile refusal: a lexical owner cannot be replaced/dropped while a live await borrows it.
    const invalid = join(directory, "owner-escape.rs");
    await writeFile(
      invalid,
      `${deferredTurnRuntime()}\n${deferredStateRuntime()}\n${harness}
fn owner_escape() {
    let bank = DeferredTurns::<2>::new();
    let owner = DeferredState::<u64, (), 1>::new();
    let waiter = owner.wait(&bank, 1);
    drop(owner);
    std::hint::black_box(waiter);
}
`,
    );
    await expect(
      execute("rustc", ["--edition=2021", invalid, "-o", join(directory, "invalid")]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("E0505") });
    expect(outputs[0]).toEqual(outputs[1]);
    expect(outputs[0]).toContain("state passed; isolated allocations=0");
    expect(outputs[0]).toMatch(/LAYOUT:owner=\d+,wait=\d+,complete=\d+,registration=\d+/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
