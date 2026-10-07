import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Cause, Effect, Exit, Fiber, Option, Queue } from "effect";
import { expect, test } from "vite-plus/test";
import { queueBoundedRuntime } from "../src/queue-bounded-runtime.ts";
import { queueContinuationRuntime } from "../src/queue-continuation-runtime.ts";

const kinds = [
  "pressure",
  "barging",
  "closing",
  "shutdown",
  "cancel-offer",
  "cancel-take",
] as const;
const oracle = (kind: (typeof kinds)[number]) =>
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<number, Cause.Done>(1);
    const events: string[] = [];
    const log = (event: string) =>
      Effect.sync(() => {
        events.push(event);
      });
    const consume = Effect.gen(function* () {
      const exit = yield* Effect.exit(Queue.take(queue));
      if (Exit.isSuccess(exit)) yield* log(`c:${exit.value}`);
      else {
        expect(Cause.hasDies(exit.cause)).toBe(false);
        if (Cause.hasInterruptsOnly(exit.cause)) yield* log("interrupted");
        else {
          const error = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(error) && Cause.isDone(error.value)).toBe(true);
          yield* log("done");
        }
      }
    });
    if (kind === "pressure") {
      const producer = yield* Effect.forkChild(
        Effect.gen(function* () {
          for (let value = 1; value <= 4; value++) {
            expect(yield* Queue.offer(queue, value)).toBe(true);
            yield* log(`p:${value}`);
          }
          expect(yield* Queue.end(queue)).toBe(true);
          yield* log("end");
        }),
        { startImmediately: true },
      );
      const consumer = yield* Effect.forkChild(
        Effect.gen(function* () {
          for (let count = 0; count < 5; count++) yield* consume;
        }),
        { startImmediately: true },
      );
      yield* Fiber.join(producer);
      yield* Fiber.join(consumer);
    } else if (kind === "barging") {
      const waiter = yield* Effect.forkChild(consume, { startImmediately: true });
      expect(yield* Queue.offer(queue, 1)).toBe(true);
      yield* log("offer:1");
      const stolen = yield* Queue.take(queue);
      expect(stolen).toBe(1);
      yield* log("barge:1");
      yield* Effect.sync(() => Queue.flushUnsafe(queue));
      yield* log("retry");
      expect(yield* Queue.offer(queue, 2)).toBe(true);
      yield* log("seed:2");
      yield* Effect.sync(() => Queue.flushUnsafe(queue));
      yield* Fiber.join(waiter);
    } else if (kind === "cancel-take") {
      const waiter = yield* Effect.forkChild(consume, { startImmediately: true });
      yield* Fiber.interrupt(waiter);
      yield* log("cancel");
      expect(yield* Queue.offer(queue, 1)).toBe(true);
      yield* log("offer:1");
      yield* consume;
      expect(yield* Queue.end(queue)).toBe(true);
      yield* log("end");
      yield* consume;
    } else {
      const producer = yield* Effect.forkChild(
        Effect.gen(function* () {
          expect(yield* Queue.offer(queue, 1)).toBe(true);
          yield* log("p:1");
          const accepted = yield* Queue.offer(queue, 2);
          yield* log(accepted ? "p:2" : "p:false");
          if (kind === "closing") {
            expect(yield* Queue.offer(queue, 3)).toBe(false);
            yield* log("p:refused");
          }
        }),
        { startImmediately: true },
      );
      if (kind === "cancel-offer") {
        yield* Fiber.interrupt(producer);
        yield* log("cancel");
        yield* consume;
        expect(yield* Queue.end(queue)).toBe(true);
        yield* log("end");
        yield* consume;
      } else if (kind === "shutdown") {
        expect(yield* Queue.shutdown(queue)).toBe(true);
        yield* log("shutdown");
        yield* consume;
        yield* Fiber.join(producer);
      } else {
        expect(yield* Queue.end(queue)).toBe(true);
        yield* log("end");
        yield* consume;
        yield* consume;
        yield* consume;
        yield* Fiber.join(producer);
      }
    }
    return events;
  });

const ownershipOracle = async (closing: boolean) => {
  const events: string[] = [];
  const log = (event: string) =>
    Effect.sync(() => {
      events.push(event);
    });
  const queue = await Effect.runPromise(
    Effect.gen(function* () {
      const owner = yield* Queue.bounded<number, Cause.Done>(1);
      yield* Effect.forkChild(Queue.take(owner).pipe(Effect.andThen(log("unexpected:take"))), {
        startImmediately: true,
      });
      yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Queue.offer(owner, 1);
          yield* log("p:1");
          yield* Queue.offer(owner, 2);
          yield* log("unexpected:offer");
        }),
        { startImmediately: true },
      );
      if (closing) {
        yield* Queue.end(owner);
        yield* log("end");
      }
      yield* log("root:return");
      return owner;
    }),
  );
  expect(await Effect.runPromise(Queue.take(queue))).toBe(1);
  events.push("c:1");
  if (!closing) {
    expect(await Effect.runPromise(Queue.end(queue))).toBe(true);
    events.push("end");
  }
  const exit = await Effect.runPromise(Effect.exit(Queue.take(queue)));
  expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true);
  if (Exit.isFailure(exit)) {
    const error = Cause.findErrorOption(exit.cause);
    expect(Option.isSome(error) && Cause.isDone(error.value)).toBe(true);
  }
  events.push("done");
  return events;
};

const harness = String.raw`
use std::cell::{Cell, RefCell};
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
struct Log { values: RefCell<[&'static str; 32]>, len: Cell<usize> }
impl Log {
    fn new() -> Self { Self { values: RefCell::new(["";32]), len: Cell::new(0) } }
    fn push(&self, value: &'static str) {
        let n = self.len.get(); assert!(n < 32, "Fixed trace capacity");
        self.values.borrow_mut()[n] = value; self.len.set(n+1);
    }
    fn last(&self) -> &'static str { self.values.borrow()[self.len.get()-1] }
    fn print(&self, kind: &str) { println!("CASE:{kind}:{:?}", &self.values.borrow()[..self.len.get()]); }
}
fn producer_label(v:u64) -> &'static str { match v { 1=>"p:1",2=>"p:2",3=>"p:3",4=>"p:4",_=>panic!() } }
fn consumer_label(v:u64) -> &'static str { match v { 1=>"c:1",2=>"c:2",3=>"c:3",4=>"c:4",_=>panic!() } }
async fn consume(task: QueueTask<'_,u64>, log: &Log) {
    match task.take().await {
        QueueTake::Value(v) => log.push(consumer_label(v)),
        QueueTake::Terminal(QueueTerminal::Done) => log.push("done"),
        QueueTake::Terminal(QueueTerminal::Interrupted) => log.push("interrupted"),
    }
}
async fn producer(task: QueueTask<'_,u64>, log: &Log) {
    for value in 1..=4 { assert!(task.offer(value).await); log.push(producer_label(value)); }
    assert!(task.end().await); log.push("end");
}
async fn consumer(task: QueueTask<'_,u64>, log: &Log) {
    for count in 0..4 {
        let QueueTake::Value(value) = task.take().await else { panic!("Expected buffered value") };
        assert_eq!(value,count+1);
        if value==1 { assert_eq!(log.last(),"p:2","producer continuation must precede consumer"); }
        if value==2 { assert_eq!(log.last(),"p:3","repeated producer continuation must precede consumer"); }
        log.push(consumer_label(value));
    }
    assert_eq!(task.take().await,QueueTake::Terminal(QueueTerminal::Done)); log.push("done");
}
fn pressure(print:bool) -> (usize,usize,usize,usize,usize) {
    let queue = std::hint::black_box(BoundedQueue::<u64,1,2>::new());
    let bridge = QueueBridge::new(); let log = Log::new();
    let first = std::pin::pin!(producer(bridge.task(0),&log));
    let second = std::pin::pin!(consumer(bridge.task(1),&log));
    let producer_bytes = std::mem::size_of_val(first.as_ref().get_ref());
    let consumer_bytes = std::mem::size_of_val(second.as_ref().get_ref());
    let driver = QueueDriver::new(&queue,&bridge,first,second);
    let sizes=(std::mem::size_of_val(&queue),std::mem::size_of_val(&bridge),
        std::mem::size_of_val(&driver),producer_bytes,consumer_bytes);
    driver.start();
    assert!(driver.is_done(0) && driver.is_done(1),"Both ordinary child futures must finish");
    assert_eq!(queue.registered(),0);
    assert_eq!(driver.pump(0),QueueBoundary::Complete); assert_eq!(driver.pump(1),QueueBoundary::Complete);
    assert!(!driver.cancel(0)); assert!(!driver.cancel(1));
    if print { log.print("pressure"); } sizes
}
fn barging() {
    let queue=BoundedQueue::<u64,1,2>::new(); let bridge=QueueBridge::new(); let log=Log::new();
    let first=std::pin::pin!(consume(bridge.task(0),&log));
    let second=std::pin::pin!(async {
        assert!(bridge.task(1).offer(1).await); log.push("offer:1");
        assert_eq!(bridge.task(1).take().await,QueueTake::Value(1)); log.push("barge:1");
    });
    let driver=QueueDriver::new(&queue,&bridge,first,second);
    assert_eq!(driver.pump(0),QueueBoundary::Waiting);
    let old=bridge.slots.borrow()[0].ticket.unwrap();
    driver.route(QueueEvent { task:0,ticket:old+1,notice:QueueNotice::Retry });
    assert_eq!(bridge.slots.borrow()[0].ticket,Some(old));
    assert_eq!(driver.pump(1),QueueBoundary::Complete);
    assert!(driver.dispatch());
    let new=bridge.slots.borrow()[0].ticket.unwrap(); assert_eq!(new,old,"Empty scheduled pass must retain waiter ticket");
    assert_eq!(queue.registered(),1); assert!(!driver.is_done(0)); log.push("retry");
    driver.route(QueueEvent { task:0,ticket:old+1,notice:QueueNotice::Retry });
    assert_eq!(bridge.slots.borrow()[0].ticket,Some(new));
    assert_eq!(queue.offer(1,2),QueueResult::Ready(true)); log.push("seed:2");
    driver.dispatch(); assert!(driver.is_done(0)); assert_eq!(queue.registered(),0);
    log.print("barging");
}
// Local receipt injection, not an official scheduling trace: remove the selected
// owner entry, then deliver its retry while empty to exercise replacement safety.
fn forced_retry() {
    let queue=BoundedQueue::<u64,1,2>::new(); let bridge=QueueBridge::new(); let log=Log::new();
    let first=std::pin::pin!(consume(bridge.task(0),&log));
    let second=std::pin::pin!(async {});
    let driver=QueueDriver::new(&queue,&bridge,first,second);
    driver.pump(0); let old=bridge.slots.borrow()[0].ticket.unwrap();
    assert!(queue.cancel(old,&mut |_| panic!("Unexpected terminal callback")));
    driver.route(QueueEvent {task:0,ticket:old,notice:QueueNotice::Retry});
    let new=bridge.slots.borrow()[0].ticket.unwrap(); assert!(new>old);
    driver.route(QueueEvent {task:0,ticket:old,notice:QueueNotice::Retry});
    assert_eq!(bridge.slots.borrow()[0].ticket,Some(new)); assert_eq!(queue.registered(),1);
    assert_eq!(queue.offer(1,2),QueueResult::Ready(true)); driver.dispatch();
    assert!(driver.is_done(0)); assert_eq!(queue.registered(),0);
}
fn terminal(kind:&str) {
    let queue=BoundedQueue::<u64,1,2>::new(); let bridge=QueueBridge::new(); let log=Log::new();
    let first=std::pin::pin!(async {
        assert!(bridge.task(0).offer(1).await); log.push("p:1");
        let accepted=bridge.task(0).offer(2).await; log.push(if accepted {"p:2"} else {"p:false"});
        if kind=="closing" { assert!(!bridge.task(0).offer(3).await); log.push("p:refused"); }
    });
    let second=std::pin::pin!(async {
        if kind=="shutdown" {
            assert!(bridge.task(1).shutdown().await); log.push("shutdown");
            consume(bridge.task(1),&log).await;
        } else {
            if kind=="closing" { assert!(bridge.task(1).end().await); log.push("end"); }
            consume(bridge.task(1),&log).await;
            if kind=="cancel-offer" { assert!(bridge.task(1).end().await); log.push("end"); }
            else { consume(bridge.task(1),&log).await; }
            consume(bridge.task(1),&log).await;
        }
    });
    let driver=QueueDriver::new(&queue,&bridge,first,second);
    assert_eq!(driver.pump(0),QueueBoundary::Waiting);
    if kind=="cancel-offer" { assert!(driver.cancel(0)); log.push("cancel"); assert!(!driver.cancel(0)); }
    driver.pump(1); driver.dispatch();
    assert!(driver.is_done(0)&&driver.is_done(1)); assert_eq!(queue.registered(),0); log.print(kind);
}
fn cancel_take() {
    let queue=BoundedQueue::<u64,1,2>::new(); let bridge=QueueBridge::new(); let log=Log::new();
    let first=std::pin::pin!(consume(bridge.task(0),&log));
    let second=std::pin::pin!(async {
        assert!(bridge.task(1).offer(1).await); log.push("offer:1"); consume(bridge.task(1),&log).await;
        assert!(bridge.task(1).end().await); log.push("end"); consume(bridge.task(1),&log).await;
    });
    let driver=QueueDriver::new(&queue,&bridge,first,second);
    driver.pump(0); let old=bridge.slots.borrow()[0].ticket.unwrap();
    assert!(driver.cancel(0)); log.push("cancel");
    driver.route(QueueEvent {task:0,ticket:old,notice:QueueNotice::Retry});
    assert_eq!(queue.registered(),0); driver.pump(1);
    assert!(driver.is_done(0)&&driver.is_done(1)); assert_eq!(queue.registered(),0); log.print("cancel-take");
}
fn scoped_retirement(closing:bool, explicit:bool, print:bool) {
    let queue=BoundedQueue::<u64,1,2>::new(); let bridge=QueueBridge::new(); let log=Log::new();
    {
        let first=std::pin::pin!(async { bridge.task(0).take().await; log.push("unexpected:take"); });
        let second=std::pin::pin!(async {
            assert!(bridge.task(1).offer(1).await); log.push("p:1");
            bridge.task(1).offer(2).await; log.push("unexpected:offer");
        });
        let driver=QueueDriver::new(&queue,&bridge,first,second);
        driver.pump(0); driver.pump(1); assert_eq!(queue.registered(),2);
        if closing { assert!(queue.end(&mut |_| panic!("Premature terminal notice"))); log.push("end"); }
        log.push("root:return");
        if explicit { assert!(driver.close()); assert!(!driver.close()); assert!(!driver.cancel(0)); }
    }
    assert_eq!(queue.registered(),0,"Scoped Queue driver must retire registrations");
    assert!(bridge.closed.get());
    assert_eq!(queue.state.lock().unwrap().life,if closing {QueueLife::Closing} else {QueueLife::Open});
    assert_eq!(queue.take(0,&mut |_| panic!()),QueueResult::Ready(QueueTake::Value(1))); log.push("c:1");
    if !closing { assert!(queue.end(&mut |_| panic!())); log.push("end"); }
    assert_eq!(queue.take(0,&mut |_| panic!()),QueueResult::Ready(QueueTake::Terminal(QueueTerminal::Done))); log.push("done");
    if print { log.print(if closing {"owned-closing"} else {"owned-open"}); }
}
fn retirement_edges() {
    // A bank borrow cannot make Drop panic or prevent owner cleanup.
    let queue=BoundedQueue::<u64,1,2>::new(); let bridge=QueueBridge::new();
    let mut first=std::pin::pin!(async { bridge.task(0).take().await; });
    let second=std::pin::pin!(async {});
    let driver=QueueDriver::new(&queue,&bridge,first.as_mut(),second);
    driver.pump(0); let borrow=bridge.slots.borrow_mut(); drop(driver);
    assert!(bridge.closed.get()); assert_eq!(queue.registered(),0); drop(borrow);
    let rejected=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut cx=std::task::Context::from_waker(std::task::Waker::noop());
        std::future::Future::poll(first.as_mut(),&mut cx)
    }));
    assert!(rejected.is_err(),"Closed request must reject repoll");
    let rejected=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let next=std::pin::pin!(async {}); let peer=std::pin::pin!(async {});
        QueueDriver::new(&queue,&bridge,next,peer);
    }));
    assert!(rejected.is_err(),"Closed bridge must reject a new driver");
    // Overlapping empty owners must be refused without poisoning the first lease.
    let queue=BoundedQueue::<u64,1,2>::new(); let bridge=QueueBridge::new(); let other=QueueBridge::new();
    let first=std::pin::pin!(async { bridge.task(0).take().await; }); let second=std::pin::pin!(async {});
    let driver=QueueDriver::new(&queue,&bridge,first,second);
    let rejected=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let first=std::pin::pin!(async {}); let second=std::pin::pin!(async {});
        QueueDriver::new(&queue,&other,first,second);
    }));
    assert!(rejected.is_err()); assert!(!queue.state.is_poisoned()); assert!(!other.installed.get());
    let rejected=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let first=std::pin::pin!(async {}); let second=std::pin::pin!(async {});
        QueueDriver::new(&queue,&bridge,first,second);
    }));
    assert!(rejected.is_err()); driver.pump(0); assert!(driver.close());
    let first=std::pin::pin!(async { other.task(0).take().await; }); let second=std::pin::pin!(async {});
    let replacement=QueueDriver::new(&queue,&other,first,second); replacement.pump(0);
    assert_eq!(queue.offer(1,2),QueueResult::Ready(true));
    assert!(!driver.dispatch(),"Closed dispatcher must not consume replacement notifications"); driver.start();
    assert_eq!(queue.registered(),1); assert!(!replacement.is_done(0));
    drop(driver); assert_eq!(queue.registered(),1,"Old close must not retire replacement driver");
    assert!(replacement.dispatch()); assert!(replacement.is_done(0));
    drop(replacement); assert_eq!(queue.registered(),0);
    // An active flag retained after child-poll panic cannot make Drop panic.
    let queue=BoundedQueue::<u64,1,2>::new(); let bridge=QueueBridge::new();
    let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let first=std::pin::pin!(async { bridge.task(0).take().await; });
        let second=std::pin::pin!(async { panic!("Expected child panic"); });
        let driver=QueueDriver::new(&queue,&bridge,first,second); driver.pump(0); driver.pump(1);
    }));
    assert!(result.is_err()); assert!(bridge.closed.get()); assert_eq!(queue.registered(),0);
    // Poison and a missing publication receipt must not cause a second panic in Drop.
    let queue=BoundedQueue::<u64,1,2>::new(); let bridge=QueueBridge::new();
    let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let first=std::pin::pin!(async { bridge.task(0).take().await; });
        let second=std::pin::pin!(async {}); let driver=QueueDriver::new(&queue,&bridge,first,second);
        driver.pump(0); bridge.slots.borrow_mut()[0].ticket=None;
        let _locked=queue.state.lock().unwrap(); panic!("Expected owner poison");
    }));
    assert!(result.is_err()); assert!(bridge.closed.get());
    assert!(queue.state.lock().unwrap_or_else(|p|p.into_inner()).bank.iter().all(Option::is_none));
}
fn foreign() {
    let queue=BoundedQueue::<u64,1,2>::new(); let bridge=QueueBridge::new();
    let first=std::pin::pin!(std::future::pending::<()>()); let second=std::pin::pin!(async {});
    QueueDriver::new(&queue,&bridge,first,second).pump(0);
}
fn quiet() {
    ALLOCS.store(0,Ordering::Relaxed); TRACK.store(true,Ordering::Relaxed);
    let mut sizes=(0,0,0,0,0);
    for _ in 0..1000 { sizes=pressure(false); scoped_retirement(false,false,false); scoped_retirement(true,true,false); }
    TRACK.store(false,Ordering::Relaxed);
    let allocations=ALLOCS.load(Ordering::Relaxed); assert_eq!(allocations,0);
    println!("COST:{allocations}:{}:{}:{}:{}:{}",sizes.0,sizes.1,sizes.2,sizes.3,sizes.4);
}
fn main() {
    if std::env::args().nth(1).as_deref()==Some("foreign") { foreign(); return; }
    pressure(true); barging(); forced_retry(); for kind in ["closing","shutdown","cancel-offer"] { terminal(kind); }
    cancel_take(); scoped_retirement(false,false,true); scoped_retirement(true,true,true); retirement_edges(); quiet();
}
`;

const run = promisify(execFile);
test("borrowed ordinary Queue futures preserve official synchronous continuations in debug and release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reffect-queue-continuation-"));
  try {
    const source = join(directory, "main.rs");
    const runtime = queueContinuationRuntime();
    await writeFile(source, `${queueBoundedRuntime()}\n${runtime}\n${harness}`);
    const outputs: string[] = [];
    for (const optimized of [false, true]) {
      const binary = join(directory, optimized ? "release" : "debug");
      await run("rustc", ["--edition=2021", ...(optimized ? ["-O"] : []), source, "-o", binary], {
        timeout: 60000,
      });
      outputs.push((await run(binary, [], { timeout: 10000 })).stdout);
      let refusal: unknown;
      try {
        await run(binary, ["foreign"], { timeout: 10000 });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toMatchObject({
        stderr: expect.stringContaining("Foreign Pending is unsupported"),
      });
    }
    expect(outputs[1]).toEqual(outputs[0]);
    for (const kind of kinds) {
      const prefix = `CASE:${kind}:`;
      const line = outputs[0]!.split("\n").find((line) => line.startsWith(prefix));
      expect(line, kind).toBeDefined();
      expect(JSON.parse(line!.slice(prefix.length)), kind).toEqual(
        await Effect.runPromise(oracle(kind)),
      );
    }
    for (const closing of [false, true]) {
      const kind = closing ? "owned-closing" : "owned-open";
      const prefix = `CASE:${kind}:`;
      const line = outputs[0]!.split("\n").find((line) => line.startsWith(prefix));
      expect(line, kind).toBeDefined();
      expect(JSON.parse(line!.slice(prefix.length)), kind).toEqual(await ownershipOracle(closing));
    }
    const cost = outputs[0]!
      .split("\n")
      .find((line) => line.startsWith("COST:"))!
      .split(":")
      .slice(1)
      .map(Number);
    console.info(
      "Queue bridge allocations/owner/bank/borrowed driver/producer/consumer bytes:",
      cost.join("/"),
    );
    expect(cost[0]).toBe(0);
    expect(cost).toHaveLength(6);
    expect(cost.slice(1).every((size) => size > 0 && size <= 1024)).toBe(true);
    const mutation = "self.pump(event.task);";
    expect(runtime.split(mutation)).toHaveLength(2);
    await writeFile(
      source,
      `${queueBoundedRuntime()}\n${runtime.replace(mutation, "/* mutation: delayed producer continuation */")}\n${harness}`,
    );
    const mutated = join(directory, "delayed-producer");
    await run("rustc", ["--edition=2021", source, "-o", mutated], { timeout: 60000 });
    let rejection: unknown;
    try {
      await run(mutated, [], { timeout: 10000 });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({
      stderr: expect.stringContaining("producer continuation must precede consumer"),
    });
    const scopedDrop = "fn drop(&mut self) { self.retire(); }";
    expect(runtime.split(scopedDrop)).toHaveLength(2);
    await writeFile(
      source,
      `${queueBoundedRuntime()}\n${runtime.replace(scopedDrop, "fn drop(&mut self) {}")}\n${harness}`,
    );
    const leaked = join(directory, "missing-retirement");
    await run("rustc", ["--edition=2021", source, "-o", leaked], { timeout: 60000 });
    let leak: unknown;
    try {
      await run(leaked, [], { timeout: 10000 });
    } catch (error) {
      leak = error;
    }
    expect(leak).toMatchObject({
      stderr: expect.stringContaining("Scoped Queue driver must retire registrations"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180000);
