import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Cause, Effect, Exit, Fiber, Queue } from "effect";
import { expect, test } from "vite-plus/test";
import { asyncRuntime } from "../src/async-runtime.ts";
import { queueBoundedRuntime } from "../src/queue-bounded-runtime.ts";
import { queueContinuationRuntime } from "../src/queue-continuation-runtime.ts";
import { queueHostRuntime } from "../src/queue-host-runtime.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const oracle = (sleeping: boolean) =>
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<string>(1);
    const events: string[] = [];
    const log = (value: string) =>
      Effect.sync(() => {
        events.push(value);
      });
    const first = yield* Effect.forkChild(
      Effect.ensuring(
        Queue.take(queue),
        Effect.gen(function* () {
          yield* log("first:cleanup:start");
          if (sleeping) {
            yield* Effect.sleep(15);
            yield* log("first:cleanup:awake");
          }
          yield* log(`shutdown:${yield* Queue.shutdown(queue)}`);
          yield* log("first:cleanup:end");
        }),
      ),
      { startImmediately: true },
    );
    const second = yield* Effect.forkChild(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Queue.offer(queue, "A");
          yield* log("producer:A");
          yield* log(`producer:B:${yield* Queue.offer(queue, "B")}`);
        }),
        log("second:cleanup"),
      ),
      { startImmediately: true },
    );
    yield* Fiber.interruptAll([first, second]);
    yield* log("parent:settled");
    return events;
  });
const lateOracle = Effect.gen(function* () {
  const events: string[] = [];
  const log = (value: string) =>
    Effect.sync(() => {
      events.push(value);
    });
  const first = yield* Effect.forkChild(
    Effect.ensuring(
      log("body:A"),
      Effect.gen(function* () {
        yield* log("cleanup:start");
        yield* Effect.sleep(15);
        yield* log("cleanup:awake");
        yield* log("cleanup:end");
      }),
    ),
    { startImmediately: true },
  );
  yield* log("parent:cancel-request");
  yield* Fiber.interruptAll([first]);
  yield* log("parent:settled");
  const exit = yield* Fiber.await(first);
  yield* log(`child:interrupted:${Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)}`);
  return events;
});

const callbackOracle = Effect.gen(function* () {
  const queue = yield* Queue.bounded<string>(1);
  const events: string[] = [];
  const log = (value: string) =>
    Effect.sync(() => {
      events.push(value);
    });
  const producer = yield* Effect.forkChild(
    Effect.ensuring(
      Effect.gen(function* () {
        yield* Queue.offer(queue, "A");
        yield* log("producer:A");
        yield* Queue.offer(queue, "B");
        yield* log("producer:B");
      }),
      Effect.gen(function* () {
        yield* log("cleanup:start");
        yield* Effect.sleep(15);
        yield* log("cleanup:awake");
        yield* log(`shutdown:${yield* Queue.shutdown(queue)}`);
        yield* log("cleanup:end");
      }),
    ),
    { startImmediately: true },
  );
  const consumer = yield* Effect.forkChild(
    Effect.gen(function* () {
      yield* log(`consumer:${yield* Queue.take(queue)}`);
    }),
    { startImmediately: true },
  );
  yield* Fiber.join(producer);
  yield* Fiber.join(consumer);
  yield* log("parent:settled");
  return events;
});

const harness = String.raw`
use std::cell::RefCell;
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

fn log(events: &RefCell<Vec<String>>, value: impl Into<String>) { events.borrow_mut().push(value.into()); }
async fn ordered(sleeping: bool, disconnected: bool) {
    let queue = BoundedQueue::<u64, 1, 2>::new(); let bridge = QueueBridge::new();
    let events = RefCell::new(Vec::new()); let task0 = bridge.task(0); let task1 = bridge.task(1);
    let (sender, rx) = tokio::sync::watch::channel(false);
    let sender = RefCell::new(Some(sender));
    let mut root = AsyncContext::new(rx.clone()); let mut child = AsyncContext::new(rx);
    let first = async {
        assert_eq!(task0.take_exit().await, Err(QueueInterrupted));
        log(&events, "first:cleanup:start");
        if sleeping { task0.cleanup_sleep(&mut child, 15).await; assert!(child.interruptible); log(&events, "first:cleanup:awake"); }
        log(&events, format!("shutdown:{}", task0.cleanup_shutdown().await));
        log(&events, "first:cleanup:end");
    };
    let second = async {
        assert_eq!(task1.offer_exit(1).await, Ok(true)); log(&events, "producer:A");
        if disconnected { sender.borrow_mut().take(); }
        else { sender.borrow().as_ref().unwrap().send(true).unwrap(); }
        match task1.offer_exit(2).await {
            Ok(value) => log(&events, format!("producer:B:{}", value)), Err(_) => {}
        }
        log(&events, "second:cleanup");
    };
    println!("CHILD_FUTURES:{}:{}", std::mem::size_of_val(&first), std::mem::size_of_val(&second));
    tokio::pin!(first, second);
    let driver = QueueDriver::new(&queue, &bridge, first.as_mut(), second.as_mut());
    println!("HOST_DRIVER:{}", std::mem::size_of_val(&driver));
    let hosted = driver.run_hosted(&mut root);
    println!("HOST_FUTURE:{}", std::mem::size_of_val(&hosted));
    assert!(tokio::select! { biased;
        _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => panic!("Hosted cleanup must wake and settle"),
        interrupted = hosted => interrupted,
    });
    log(&events, "parent:settled");
    assert!(driver.is_done(0) && driver.is_done(1), "Hosted return must await both cleanup futures"); assert_eq!(queue.registered(), 0);
    println!("CASE:{}:{:?}", if disconnected { "disconnected" } else if sleeping { "sleeping" } else { "sync" }, events.borrow());
}
async fn late() {
    let queue = BoundedQueue::<u64, 1, 2>::new(); let bridge = QueueBridge::new();
    let events = RefCell::new(Vec::new()); let task = bridge.task(0);
    let (sender, rx) = tokio::sync::watch::channel(false);
    let mut root = AsyncContext::new(rx.clone()); let mut child = AsyncContext::new(rx);
    let first = async {
        log(&events, "body:A"); log(&events, "cleanup:start");
        log(&events, "parent:cancel-request"); sender.send(true).unwrap();
        task.cleanup_sleep(&mut child, 15).await; assert!(child.interruptible);
        log(&events, "cleanup:awake"); log(&events, "cleanup:end");
    };
    let second = async {};
    tokio::pin!(first, second);
    let driver = QueueDriver::new(&queue, &bridge, first.as_mut(), second.as_mut());
    assert!(tokio::time::timeout(std::time::Duration::from_secs(2), driver.run_hosted(&mut root)).await.expect("Late cleanup must settle"));
    log(&events, "parent:settled"); log(&events, format!("child:interrupted:{}", bridge.interrupted[0].get()));
    println!("CASE:late:{:?}", events.borrow());
}
async fn callback_sleep() {
    let queue = BoundedQueue::<u64,1,2>::new(); let bridge = QueueBridge::new();
    let events = RefCell::new(Vec::new()); let task0=bridge.task(0); let task1=bridge.task(1);
    let (_sender,rx)=tokio::sync::watch::channel(false); let mut root=AsyncContext::new(rx.clone()); let mut child=AsyncContext::new(rx);
    let producer=async {
        assert_eq!(task0.offer_exit(1).await,Ok(true)); log(&events,"producer:A");
        assert_eq!(task0.offer_exit(2).await,Ok(true)); log(&events,"producer:B");
        log(&events,"cleanup:start"); task0.cleanup_sleep(&mut child,15).await; log(&events,"cleanup:awake");
        log(&events,format!("shutdown:{}",task0.cleanup_shutdown().await)); log(&events,"cleanup:end");
    };
    let consumer=async { assert_eq!(task1.take_exit().await,Ok(QueueTake::Value(1))); log(&events,"consumer:A"); };
    tokio::pin!(producer,consumer); let driver=QueueDriver::new(&queue,&bridge,producer.as_mut(),consumer.as_mut());
    assert!(!tokio::select! { biased;
        _=tokio::time::sleep(std::time::Duration::from_secs(2))=>panic!("Callback cleanup must wake and settle"),
        interrupted=driver.run_hosted(&mut root)=>interrupted,
    });
    log(&events,"parent:settled"); println!("CASE:callback:{:?}",events.borrow());
}
async fn safety() {
    for disconnected in [false, true] {
        let queue = BoundedQueue::<u64, 1, 2>::new(); let bridge = QueueBridge::new();
        let entered = std::cell::Cell::new(0); let (tx, rx) = tokio::sync::watch::channel(false);
        if disconnected { drop(tx); } else { tx.send(true).unwrap(); }
        let mut ctx = AsyncContext::new(rx);
        let first = async { entered.set(entered.get()+1); }; let second = async { entered.set(entered.get()+1); };
        tokio::pin!(first, second); let driver = QueueDriver::new(&queue, &bridge, first.as_mut(), second.as_mut());
        assert!(driver.run_hosted(&mut ctx).await); assert_eq!(entered.get(), 0, "Preabort must not open children");
    }
    for masked in [false, true] {
        let queue = BoundedQueue::<u64, 1, 2>::new(); let bridge = QueueBridge::new();
        let (tx, rx) = tokio::sync::watch::channel(false); let mut ctx = AsyncContext::new(rx.clone());
        ctx.interruptible = !masked; let mut child = AsyncContext::new(rx); let task = bridge.task(0);
        let finished = std::cell::Cell::new(false);
        let first = async { task.cleanup_sleep(&mut child, 15).await; assert!(child.interruptible); finished.set(true); };
        let second = async { tx.send(masked).unwrap(); };
        tokio::pin!(first, second); let driver = QueueDriver::new(&queue, &bridge, first.as_mut(), second.as_mut());
        assert!(!tokio::time::timeout(std::time::Duration::from_secs(2), driver.run_hosted(&mut ctx)).await.expect("False update/masked root must settle"));
        assert!(finished.get());
    }
    for previous in [false,true] {
        let bridge=QueueBridge::<u64>::new(); let task=bridge.task(0);
        let (_tx,rx)=tokio::sync::watch::channel(false); let mut context=AsyncContext::new(rx); context.interruptible=previous;
        std::future::poll_fn(|cx| {
            { let mut sleep=std::pin::pin!(task.cleanup_sleep(&mut context,15));
              assert!(std::future::Future::poll(sleep.as_mut(),cx).is_pending()); }
            assert_eq!(context.interruptible,previous,"Dropping child cleanup must restore saved mask");
            std::task::Poll::Ready(())
        }).await;
    }
    println!("LAYOUT:{}:{}:{}", std::mem::size_of::<QueueBridge<u64>>(), std::mem::size_of::<AsyncContext>(), std::mem::size_of::<QueueTask<'_,u64>>());
}
async fn quiet_once(rx: &tokio::sync::watch::Receiver<bool>, sleeping: bool) {
    let queue = BoundedQueue::<u64,1,2>::new(); let bridge = QueueBridge::new();
    let mut root = AsyncContext::new(rx.clone()); let mut child = AsyncContext::new(rx.clone());
    let task = bridge.task(0);
    let first = async { if sleeping { task.cleanup_sleep(&mut child, 1).await; } };
    let second = async {};
    tokio::pin!(first, second);
    let driver = QueueDriver::new(&queue, &bridge, first.as_mut(), second.as_mut());
    assert!(!driver.run_hosted(&mut root).await);
}
async fn costs() {
    let (_tx, rx) = tokio::sync::watch::channel(false);
    quiet_once(&rx,true).await;
    for sleeping in [false,true] {
        ALLOCS.store(0, Ordering::Relaxed); TRACK.store(true,Ordering::Relaxed);
        for _ in 0..1000 { quiet_once(&rx,sleeping).await; }
        TRACK.store(false,Ordering::Relaxed);
        println!("COST:{}:{}", sleeping, ALLOCS.load(Ordering::Relaxed));
        assert_eq!(ALLOCS.load(Ordering::Relaxed),0,"Warmed borrowed host must add no allocations");
    }
}
#[tokio::main(flavor="current_thread")]
async fn main() { ordered(true, false).await; ordered(false, false).await; ordered(true, true).await; late().await; callback_sleep().await; safety().await; costs().await; }
`;

test(
  "borrowed Queue host awaits masked cleanup and matches official cancellation ordering",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "reffect-queue-host-"));
    const run = promisify(execFile);
    const source = (core = queueContinuationRuntime(), host = queueHostRuntime()) =>
      `${asyncRuntime(false, false)}\n${queueBoundedRuntime()}\n${core}\n${host}\n${harness}`;
    try {
      await mkdir(join(directory, "src"));
      await writeFile(
        join(directory, "Cargo.toml"),
        '[package]\nname="queue-host-probe"\nversion="0.0.0"\nedition="2021"\n[dependencies]\ntokio={version="=1.53.1",features=["rt","macros","sync","time"]}\n',
      );
      await writeFile(join(directory, "src/main.rs"), source());
      const outputs: string[] = [];
      for (const release of [false, true]) {
        outputs.push(
          (
            await run("cargo", ["run", "--offline", "--quiet", ...(release ? ["--release"] : [])], {
              cwd: directory,
              timeout: 120000,
              maxBuffer: 4 * 1024 * 1024,
            })
          ).stdout,
        );
      }
      const cases = (output: string) =>
        output.split("\n").filter((line) => line.startsWith("CASE:"));
      expect(cases(outputs[1]!)).toEqual(cases(outputs[0]!));
      for (const [kind, expected] of [
        ["sleeping", await Effect.runPromise(oracle(true))],
        ["sync", await Effect.runPromise(oracle(false))],
        ["late", await Effect.runPromise(lateOracle)],
        ["callback", await Effect.runPromise(callbackOracle)],
      ] as const) {
        const prefix = `CASE:${kind}:`;
        const line = outputs[0]!.split("\n").find((value) => value.startsWith(prefix));
        expect(line, kind).toBeDefined();
        expect(JSON.parse(line!.slice(prefix.length)), kind).toEqual(expected);
      }
      console.info(
        outputs[0]!
          .split("\n")
          .filter(
            (line) =>
              line.startsWith("HOST_FUTURE:") ||
              line.startsWith("LAYOUT:") ||
              line.startsWith("HOST_DRIVER:") ||
              line.startsWith("CHILD_FUTURES:") ||
              line.startsWith("COST:"),
          )
          .join("\n"),
      );
      const wake = "std::task::Context::from_waker(waker)";
      expect(queueContinuationRuntime().split(wake)).toHaveLength(2);
      await writeFile(
        join(directory, "src/main.rs"),
        source(
          queueContinuationRuntime().replace(
            wake,
            "std::task::Context::from_waker(std::task::Waker::noop())",
          ),
        ),
      );
      let failure: unknown;
      try {
        await run("cargo", ["run", "--offline", "--quiet"], {
          cwd: directory,
          timeout: 120000,
          maxBuffer: 4 * 1024 * 1024,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        stderr: expect.stringContaining("Hosted cleanup must wake and settle"),
      });
      const settled = "if self.is_done(0) && self.is_done(1) {";
      expect(queueHostRuntime().split(settled)).toHaveLength(2);
      await writeFile(
        join(directory, "src/main.rs"),
        source(
          queueContinuationRuntime(),
          queueHostRuntime().replace(
            settled,
            "if interrupted || (self.is_done(0) && self.is_done(1)) {",
          ),
        ),
      );
      let abandoned: unknown;
      try {
        await run("cargo", ["run", "--offline", "--quiet"], {
          cwd: directory,
          timeout: 120000,
          maxBuffer: 4 * 1024 * 1024,
        });
      } catch (error) {
        abandoned = error;
      }
      expect(abandoned).toMatchObject({
        stderr: expect.stringContaining("Hosted return must await both cleanup futures"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(360000),
);
