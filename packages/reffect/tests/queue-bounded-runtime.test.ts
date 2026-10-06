import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Cause, Effect, Exit, Fiber, Option, Queue } from "effect";
import { expect, test } from "vite-plus/test";
import { queueBoundedRuntime } from "../src/queue-bounded-runtime.ts";

const kinds = [
  "drain",
  "cancel-offer",
  "cancel-take",
  "barging",
  "reentry",
  "shutdown",
  "end-shutdown",
] as const;
const oracle = (kind: string) =>
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<string, Cause.Done>(1);
    const events: string[] = [];
    const log = (event: string) =>
      Effect.sync(() => {
        events.push(event);
      });
    const take = Effect.gen(function* () {
      const exit = yield* Effect.exit(Queue.take(queue));
      if (Exit.isSuccess(exit)) yield* log(`take:${exit.value}`);
      else {
        expect(Cause.hasDies(exit.cause)).toBe(false);
        if (Cause.hasInterrupts(exit.cause)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          yield* log("take:Interrupted");
        } else {
          const error = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(error) && Cause.isDone(error.value)).toBe(true);
          yield* log("take:Done");
        }
      }
    });
    if (["drain", "cancel-offer", "shutdown", "end-shutdown"].includes(kind)) {
      yield* Queue.offer(queue, "A");
      const producer = yield* Effect.forkChild(
        Effect.gen(function* () {
          const result = yield* Queue.offer(queue, "B");
          yield* log(`offer:${result}`);
        }),
        { startImmediately: true },
      );
      if (kind === "cancel-offer") {
        yield* Fiber.interrupt(producer);
        yield* log("cancel");
      }
      if (kind === "drain" || kind === "cancel-offer" || kind === "end-shutdown") {
        yield* Queue.end(queue);
        yield* log("end");
      }
      if (kind === "shutdown" || kind === "end-shutdown") {
        yield* Queue.shutdown(queue);
        yield* log("shutdown");
        yield* take;
      } else {
        yield* take;
        if (kind === "drain") yield* take;
        yield* take;
      }
      if (kind !== "cancel-offer") yield* Fiber.join(producer);
    } else {
      let nested: Fiber.Fiber<void> | undefined;
      const waiter = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* take;
          if (kind === "reentry") {
            nested = yield* Effect.forkDetach(take, { startImmediately: true });
            yield* log("second:registered");
            yield* Queue.offer(queue, "B");
            yield* log("offered:B");
          }
        }),
        { startImmediately: true },
      );
      if (kind === "cancel-take") {
        yield* Fiber.interrupt(waiter);
        yield* log("cancel");
      }
      yield* Queue.offer(queue, "A");
      yield* log("offer:A");
      if (kind === "barging" || kind === "cancel-take") yield* take;
      if (kind === "reentry") {
        yield* Effect.sync(() => Queue.flushUnsafe(queue));
        yield* log("parent:flush");
      } else yield* Effect.yieldNow;
      if (kind === "barging") {
        yield* Queue.offer(queue, "B");
        yield* log("offer:B");
      }
      if (kind !== "cancel-take") yield* Fiber.join(waiter);
      if (nested) yield* Fiber.join(nested);
    }
    return events;
  });

const harness = String.raw`
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
struct Allocator;
static TRACK: AtomicBool = AtomicBool::new(false);
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
unsafe impl std::alloc::GlobalAlloc for Allocator {
    unsafe fn alloc(&self, l: std::alloc::Layout) -> *mut u8 {
        if TRACK.load(Ordering::Relaxed) { ALLOCS.fetch_add(1, Ordering::Relaxed); }
        unsafe { std::alloc::System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: std::alloc::Layout) { unsafe { std::alloc::System.dealloc(p,l) } }
    unsafe fn realloc(&self, p: *mut u8, l: std::alloc::Layout, n: usize) -> *mut u8 {
        if TRACK.load(Ordering::Relaxed) { ALLOCS.fetch_add(1, Ordering::Relaxed); }
        unsafe { std::alloc::System.realloc(p,l,n) }
    }
}
#[global_allocator] static ALLOCATOR: Allocator = Allocator;
fn consume(q: &BoundedQueue<&str,1,4>, events: &mut Vec<String>) {
    let result = q.take(3, &mut |event| notice(q,event,events));
    match result {
        QueueResult::Ready(QueueTake::Value(v)) => events.push(format!("take:{v}")),
        QueueResult::Ready(QueueTake::Terminal(t)) => events.push(format!("take:{t:?}")),
        QueueResult::Pending(_) => panic!("Expected available take"),
    }
}
fn notice(q: &BoundedQueue<&str,1,4>, event: QueueEvent, events: &mut Vec<String>) {
    match event.notice {
        QueueNotice::Offer(result) => events.push(format!("offer:{result}")),
        QueueNotice::Terminal(t) => events.push(format!("take:{t:?}")),
        QueueNotice::Retry => consume(q, events),
    }
}
fn scenario(kind: &str) {
    let q = BoundedQueue::<&str,1,4>::new(); let mut events = Vec::new();
    if ["drain","cancel-offer","shutdown","end-shutdown"].contains(&kind) {
        assert_eq!(q.offer(0,"A"), QueueResult::Ready(true));
        let QueueResult::Pending(ticket) = q.offer(1,"B") else { panic!() };
        if kind == "cancel-offer" { assert!(q.cancel(ticket,&mut |e| notice(&q,e,&mut events))); events.push("cancel".into()); }
        if ["drain","cancel-offer","end-shutdown"].contains(&kind) {
            assert!(q.end(&mut |e| notice(&q,e,&mut events))); events.push("end".into());
            assert_eq!(q.offer(0,"C"), QueueResult::Ready(false));
        }
        if kind == "shutdown" || kind == "end-shutdown" {
            assert!(q.shutdown(&mut |e| notice(&q,e,&mut events))); events.push("shutdown".into()); consume(&q,&mut events);
        } else { consume(&q,&mut events); if kind == "drain" { consume(&q,&mut events); } consume(&q,&mut events); }
    } else {
        let QueueResult::Pending(ticket) = q.take(0,&mut |_| panic!()) else { panic!() };
        if kind == "cancel-take" { assert!(q.cancel(ticket,&mut |_| panic!())); events.push("cancel".into()); }
        assert_eq!(q.offer(1,"A"), QueueResult::Ready(true)); events.push("offer:A".into());
        if kind == "barging" || kind == "cancel-take" { consume(&q,&mut events); }
        q.dispatch(&mut |e| {
            notice(&q,e,&mut events);
            if kind == "reentry" && e.ticket == ticket {
                assert!(matches!(q.take(0,&mut |_| panic!()),QueueResult::Pending(_)));
                events.push("second:registered".into());
                assert_eq!(q.offer(1,"B"),QueueResult::Ready(true));
                events.push("offered:B".into());
            }
        });
        if kind == "reentry" { events.push("parent:flush".into()); }
        if kind == "barging" {
            assert_eq!(q.registered(),1); assert_eq!(q.offer(1,"B"),QueueResult::Ready(true)); events.push("offer:B".into());
            q.dispatch(&mut |e| notice(&q,e,&mut events));
        }
    }
    assert_eq!(q.registered(),0); println!("CASE:{kind}:{events:?}");
}
fn edges() {
    let q = BoundedQueue::<u64,2,4>::new();
    let QueueResult::Pending(old) = q.take(0,&mut |_| panic!()) else { panic!() };
    assert!(q.cancel(old,&mut |_| panic!()));
    let QueueResult::Pending(new) = q.take(0,&mut |_| panic!()) else { panic!() };
    assert!(new>old); assert!(!q.cancel(old,&mut |_| panic!())); assert_eq!(q.registered(),1);
    // Live scan can see a registration created by a callback: first retry leaves values unconsumed.
    q.offer(1,10); let mut count=0;
    assert!(q.dispatch(&mut |e| {
        assert_eq!(e.notice,QueueNotice::Retry); count+=1;
        if count==1 {
            assert_eq!(q.take(0,&mut |_| panic!()),QueueResult::Ready(QueueTake::Value(10)));
            assert!(matches!(q.take(0,&mut |_| panic!()),QueueResult::Pending(_)));
            q.offer(1,20);
        } else { assert_eq!(q.take(0,&mut |_| panic!()),QueueResult::Ready(QueueTake::Value(20))); }
    }));
    assert_eq!(count,2); assert!(!q.cancel(new,&mut |_| panic!()));
    // Admission is irrevocable even if producer callback cancels its old ticket.
    q.offer(0,1); q.offer(0,2);
    let QueueResult::Pending(ticket)=q.offer(1,3) else { panic!() };
    assert_eq!(q.take(0,&mut |e| { assert_eq!(e.ticket,ticket); assert!(!q.cancel(ticket,&mut |_| panic!())); }),QueueResult::Ready(QueueTake::Value(1)));
    assert_eq!(q.take(0,&mut |_| panic!()),QueueResult::Ready(QueueTake::Value(2)));
    assert_eq!(q.take(0,&mut |_| panic!()),QueueResult::Ready(QueueTake::Value(3)));
    // Shutdown callback reentry safely stops capacity release. Upstream defects for this topology;
    // this is a native safety assertion, explicitly excluded from parity/admission claims.
    q.offer(0,1); q.offer(0,2); q.offer(1,3); q.offer(2,4);
    let mut order=Vec::new();
    assert_eq!(q.take(0,&mut |e| {
        order.push(e.notice);
        if e.notice==QueueNotice::Offer(true) { q.shutdown(&mut |e| order.push(e.notice)); }
    }),QueueResult::Ready(QueueTake::Value(1)));
    assert_eq!(order,vec![QueueNotice::Offer(true),QueueNotice::Offer(false)]);
    assert_eq!(q.take(0,&mut |_| panic!()),QueueResult::Ready(QueueTake::Terminal(QueueTerminal::Interrupted)));
    let q=BoundedQueue::<u64,1,4>::new();
    let QueueResult::Pending(first)=q.take(0,&mut |_| panic!()) else { panic!() };
    let QueueResult::Pending(second)=q.take(1,&mut |_| panic!()) else { panic!() };
    let mut order=Vec::new();
    q.shutdown(&mut |e| { order.push(e.task); assert!(!q.cancel(first,&mut |_| panic!())); assert!(!q.cancel(second,&mut |_| panic!())); assert_eq!(e.notice,QueueNotice::Terminal(QueueTerminal::Interrupted)); });
    assert_eq!(order,vec![0,1]); assert!(!q.shutdown(&mut |_| panic!()));
    // Producer reentry drains both buffered values, then cancellation finalizes empty Closing.
    let q=BoundedQueue::<u64,2,4>::new(); q.offer(0,1); q.offer(0,2);
    let QueueResult::Pending(b)=q.offer(1,3) else { panic!() };
    let QueueResult::Pending(c)=q.offer(2,4) else { panic!() };
    q.end(&mut |_| panic!());
    assert_eq!(q.take(0,&mut |e| {
        assert_eq!(e.ticket,b);
        assert!(!q.cancel(b,&mut |_| panic!()));
        assert!(q.cancel(c,&mut |_| panic!()));
        assert_eq!(q.take(0,&mut |_| panic!()),QueueResult::Ready(QueueTake::Value(2)));
        assert_eq!(q.take(0,&mut |_| panic!()),QueueResult::Ready(QueueTake::Value(3)));
        assert_eq!(q.take(0,&mut |_| panic!()),QueueResult::Ready(QueueTake::Terminal(QueueTerminal::Done)));
    }),QueueResult::Ready(QueueTake::Value(1)));
    // Terminal callback cannot cancel shutdown's remaining pending producer completion.
    let q=BoundedQueue::<u64,1,4>::new();
    let QueueResult::Pending(t)=q.take(0,&mut |_| panic!()) else { panic!() };
    q.offer(1,1); let QueueResult::Pending(p)=q.offer(1,2) else { panic!() };
    let mut notices=Vec::new(); q.shutdown(&mut |e| {
        notices.push(e.notice); assert!(!q.cancel(t,&mut |_| panic!())); assert!(!q.cancel(p,&mut |_| panic!()));
    });
    assert_eq!(notices,vec![QueueNotice::Terminal(QueueTerminal::Interrupted),QueueNotice::Offer(false)]);

}
fn quiet() {
    TRACK.store(true,Ordering::Relaxed);
    let q=std::hint::black_box(BoundedQueue::<u64,1,4>::new());
    for _ in 0..1000 {
        let QueueResult::Pending(ticket)=q.take(0,&mut |_| panic!()) else { panic!() };
        assert!(q.cancel(ticket,&mut |_| panic!()));
        q.offer(0,1); q.offer(1,2);
        assert_eq!(q.take(0,&mut |e| assert_eq!(e.notice,QueueNotice::Offer(true))),QueueResult::Ready(QueueTake::Value(1)));
        assert_eq!(q.take(0,&mut |_| panic!()),QueueResult::Ready(QueueTake::Value(2)));
        q.take(0,&mut |_| panic!()); q.offer(1,3);
        q.dispatch(&mut |e| { assert_eq!(e.notice,QueueNotice::Retry); assert_eq!(q.take(0,&mut |_| panic!()),QueueResult::Ready(QueueTake::Value(3))); });
    }
    assert!(q.end(&mut |_| panic!())); assert!(!q.shutdown(&mut |_| panic!()));
    TRACK.store(false,Ordering::Relaxed); assert_eq!(ALLOCS.load(Ordering::Relaxed),0);
    println!("COST:{}:{}:{}",ALLOCS.load(Ordering::Relaxed),std::mem::size_of::<BoundedQueue<u64,1,4>>(),std::mem::size_of::<[Option<QueueRegistration<u64>>;4]>());
}
fn main() { println!("LAYOUT:{}:{}:{}:{}:{}:{}",std::mem::size_of::<BoundedQueue<bool,1,4>>(),std::mem::size_of::<BoundedQueue<(),1,4>>(),std::mem::size_of::<BoundedQueue<u64,1,4>>(),std::mem::size_of::<BoundedQueue<bool,3,4>>(),std::mem::size_of::<BoundedQueue<(),3,4>>(),std::mem::size_of::<BoundedQueue<u64,3,4>>()); edges(); for kind in ["drain","cancel-offer","cancel-take","barging","reentry","shutdown","end-shutdown"] { scenario(kind); } quiet(); }
`;

test("private bounded Queue matches official lifecycle, cancellation and retry traces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reffect-queue-bounded-"));
  try {
    const source = join(directory, "main.rs");
    await writeFile(source, `${queueBoundedRuntime()}\n${harness}`);
    const outputs: string[] = [];
    for (const optimized of [false, true]) {
      const binary = join(directory, optimized ? "release" : "debug");
      await promisify(execFile)(
        "rustc",
        ["--edition=2021", ...(optimized ? ["-O"] : []), source, "-o", binary],
        { timeout: 60000 },
      );
      outputs.push((await promisify(execFile)(binary, [], { timeout: 10000 })).stdout);
    }
    expect(outputs[1]).toEqual(outputs[0]);
    for (const kind of kinds) {
      const prefix = `CASE:${kind}:`;
      const line = outputs[0]!.split("\n").find((line) => line.startsWith(prefix))!;
      expect(JSON.parse(line.slice(prefix.length)), kind).toEqual(
        await Effect.runPromise(oracle(kind)),
      );
    }
    const cost = outputs[0]!
      .split("\n")
      .find((line) => line.startsWith("COST:"))!
      .split(":")
      .slice(1)
      .map(Number);
    console.info("Queue allocations/owner/bank bytes:", cost.join("/"));
    console.info(outputs[0]!.split("\n").find((line) => line.startsWith("LAYOUT:")));
    expect(cost[0]).toBe(0);
    expect(cost.slice(1).every((size) => size > 0 && size <= 256)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180000);
