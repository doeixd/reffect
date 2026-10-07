import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Cause, Effect, Exit, Fiber, Option, Queue } from "effect";
import { expect, test } from "vite-plus/test";
import { queueBoundedRuntime } from "../src/queue-bounded-runtime.ts";
import { queueContinuationRuntime } from "../src/queue-continuation-runtime.ts";

const kinds = ["empty", "drain", "closing-shutdown", "open-shutdown"] as const;
const oracle = (kind: (typeof kinds)[number]) =>
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<number, Cause.Done>(1);
    const events: string[] = [];
    const log = (event: string) => Effect.sync(() => events.push(event));
    const consume = Effect.gen(function* () {
      const exit = yield* Effect.exit(Queue.take(queue));
      if (Exit.isSuccess(exit)) yield* log(`take:${exit.value}`);
      else if (Cause.hasInterruptsOnly(exit.cause)) yield* log("owner:interrupted");
      else {
        expect(Cause.hasDies(exit.cause)).toBe(false);
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && Cause.isDone(error.value)).toBe(true);
        yield* log("owner:done");
      }
    });
    if (kind === "empty") {
      const consumer = yield* Effect.forkChild(consume, { startImmediately: true });
      yield* log(`end:${yield* Queue.end(queue)}`);
      yield* log(`end-again:${yield* Queue.end(queue)}`);
      yield* log(`shutdown:${yield* Queue.shutdown(queue)}`);
      yield* log(`offer:${yield* Queue.offer(queue, 1)}`);
      yield* consume;
      yield* Fiber.join(consumer);
    } else if (kind === "drain") {
      const producer = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* log(`offer:1:${yield* Queue.offer(queue, 1)}`);
          yield* log(`offer:2:${yield* Queue.offer(queue, 2)}`);
          yield* log(`end:${yield* Queue.end(queue)}`);
          yield* log(`end-again:${yield* Queue.end(queue)}`);
        }),
        { startImmediately: true },
      );
      yield* consume;
      yield* consume;
      yield* consume;
      yield* Fiber.join(producer);
    } else {
      expect(yield* Queue.offer(queue, 1)).toBe(true);
      const producer = yield* Effect.forkChild(
        Queue.offer(queue, 2).pipe(Effect.flatMap((accepted) => log(`producer:${accepted}`))),
        { startImmediately: true },
      );
      if (kind === "closing-shutdown") yield* log(`end:${yield* Queue.end(queue)}`);
      yield* log(`shutdown:${yield* Queue.shutdown(queue)}`);
      yield* consume;
      yield* log(`shutdown-again:${yield* Queue.shutdown(queue)}`);
      yield* Fiber.join(producer);
    }
    return events;
  });

const harness = String.raw`
use std::cell::{Cell, RefCell};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
struct Allocator;
static TRACK: AtomicBool = AtomicBool::new(false);
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
unsafe impl std::alloc::GlobalAlloc for Allocator {
 unsafe fn alloc(&self,l:std::alloc::Layout)->*mut u8 {
  if TRACK.load(Ordering::Relaxed){ALLOCS.fetch_add(1,Ordering::Relaxed);}
  unsafe{std::alloc::System.alloc(l)}
 }
 unsafe fn dealloc(&self,p:*mut u8,l:std::alloc::Layout){unsafe{std::alloc::System.dealloc(p,l)}}
 unsafe fn realloc(&self,p:*mut u8,l:std::alloc::Layout,n:usize)->*mut u8 {
  if TRACK.load(Ordering::Relaxed){ALLOCS.fetch_add(1,Ordering::Relaxed);}
  unsafe{std::alloc::System.realloc(p,l,n)}
 }
}
#[global_allocator] static ALLOCATOR: Allocator=Allocator;
struct Log { values:RefCell<[&'static str;16]>, len:Cell<usize> }
impl Log {
 fn new()->Self{Self{values:RefCell::new(["";16]),len:Cell::new(0)}}
 fn push(&self,value:&'static str){let n=self.len.get();assert!(n<16);self.values.borrow_mut()[n]=value;self.len.set(n+1);}
 fn print(&self,kind:&str){println!("CASE:{kind}:{:?}",&self.values.borrow()[..self.len.get()]);}
}
async fn consume(task:QueueTask<'_,u64>,log:&Log){
 match task.take_exit().await.expect("Take owner outcome must differ from control cancellation") {
  QueueTake::Value(1)=>log.push("take:1"),QueueTake::Value(2)=>log.push("take:2"),
  QueueTake::Terminal(QueueTerminal::Done)=>log.push("owner:done"),
  QueueTake::Terminal(QueueTerminal::Interrupted)=>log.push("owner:interrupted"),_=>panic!("Unexpected value")
 }
}
fn empty(print:bool)->[usize;2]{
 let queue=BoundedQueue::<u64,1,2>::new();let bridge=QueueBridge::new();let log=Log::new();
 let first=std::pin::pin!(consume(bridge.task(0),&log));
 let second=std::pin::pin!(async {
  assert!(bridge.task(1).end_exit().await.unwrap());log.push("end:true");
  assert!(!bridge.task(1).end_exit().await.unwrap());log.push("end-again:false");
  assert!(!bridge.task(1).shutdown_exit().await.unwrap());log.push("shutdown:false");
  assert!(!bridge.task(1).offer_exit(1).await.unwrap());log.push("offer:false");
  consume(bridge.task(1),&log).await;
 });
 let sizes=[std::mem::size_of_val(first.as_ref().get_ref()),std::mem::size_of_val(second.as_ref().get_ref())];
 let driver=QueueDriver::new(&queue,&bridge,first,second);
 assert_eq!(driver.pump(0),QueueBoundary::Waiting);driver.pump(1);
 assert_eq!(log.values.borrow()[0],"owner:done","Terminal peer must finish before end returns");
 assert!(driver.is_done(0)&&driver.is_done(1));assert!(!driver.interrupt_all());assert_eq!(queue.registered(),0);
 if print{log.print("empty");}sizes
}
fn drain(print:bool)->[usize;2]{
 let queue=BoundedQueue::<u64,1,2>::new();let bridge=QueueBridge::new();let log=Log::new();
 let first=std::pin::pin!(async {
  assert!(bridge.task(0).offer_exit(1).await.unwrap());log.push("offer:1:true");
  assert!(bridge.task(0).offer_exit(2).await.unwrap());log.push("offer:2:true");
  assert!(bridge.task(0).end_exit().await.unwrap());log.push("end:true");
  assert!(!bridge.task(0).end_exit().await.unwrap());log.push("end-again:false");
 });
 let second=std::pin::pin!(async {for _ in 0..3{consume(bridge.task(1),&log).await;}});
 let sizes=[std::mem::size_of_val(first.as_ref().get_ref()),std::mem::size_of_val(second.as_ref().get_ref())];
 let driver=QueueDriver::new(&queue,&bridge,first,second);driver.pump(0);driver.pump(1);driver.dispatch();
 assert!(driver.is_done(0)&&driver.is_done(1));assert!(!driver.interrupt_all());assert_eq!(queue.registered(),0);
 if print{log.print("drain");}sizes
}
fn shutdown(closing:bool,print:bool)->[usize;2]{
 let queue=BoundedQueue::<u64,1,2>::new();let bridge=QueueBridge::new();let log=Log::new();
 assert_eq!(queue.offer(0,1),QueueResult::Ready(true));
 let first=std::pin::pin!(async {
  assert!(!bridge.task(0).offer_exit(2).await.unwrap());log.push("producer:false");
 });
 let second=std::pin::pin!(async {
  if closing{assert!(bridge.task(1).end_exit().await.unwrap());log.push("end:true");}
  assert!(bridge.task(1).shutdown_exit().await.unwrap());log.push("shutdown:true");
  consume(bridge.task(1),&log).await;
  assert!(!bridge.task(1).shutdown_exit().await.unwrap());log.push("shutdown-again:false");
 });
 let sizes=[std::mem::size_of_val(first.as_ref().get_ref()),std::mem::size_of_val(second.as_ref().get_ref())];
 let driver=QueueDriver::new(&queue,&bridge,first,second);driver.pump(0);driver.pump(1);
 assert!(driver.is_done(0)&&driver.is_done(1));assert_eq!(queue.registered(),0);
 if print{log.print(if closing{"closing-shutdown"}else{"open-shutdown"});}sizes
}
fn canceled(masked:bool)->[usize;2]{
 let queue=BoundedQueue::<u64,1,2>::new();let bridge=QueueBridge::new();
 assert_eq!(queue.offer(0,1),QueueResult::Ready(true));
 let first=std::pin::pin!(async {
  assert!(bridge.task(0).offer_exit(2).await.is_err());
  assert!(bridge.task(0).end_exit().await.is_err(),"Canceled end must remain control interruption");
  assert!(bridge.task(0).shutdown_exit().await.is_err(),"Canceled shutdown must remain control interruption");
  assert!(bridge.slots.borrow().iter().all(|slot|slot.phase==QueueRequestPhase::Idle),"Canceled terminal request must not post");
  let state=queue.state.lock().unwrap();assert_eq!(state.life,QueueLife::Open);assert_eq!(state.len,1);assert_eq!(state.terminal,QueueTerminal::Done);drop(state);
  if masked{assert!(bridge.task(0).cleanup_shutdown().await);}
 });
 let second=std::pin::pin!(async {
  if masked{assert!(matches!(bridge.task(1).take_exit().await,Ok(QueueTake::Terminal(QueueTerminal::Interrupted))));}
  else {
   assert!(matches!(bridge.task(1).take_exit().await,Ok(QueueTake::Value(1))));
   assert!(bridge.task(1).end_exit().await.unwrap());
   assert!(matches!(bridge.task(1).take_exit().await,Ok(QueueTake::Terminal(QueueTerminal::Done))));
  }
 });
 let sizes=[std::mem::size_of_val(first.as_ref().get_ref()),std::mem::size_of_val(second.as_ref().get_ref())];
 let driver=QueueDriver::new(&queue,&bridge,first,second);assert_eq!(driver.pump(0),QueueBoundary::Waiting);
 assert!(driver.interrupt(0));assert!(!driver.interrupt(0));driver.pump(1);
 assert!(driver.is_done(0)&&driver.is_done(1));assert_eq!(queue.registered(),0);sizes
}
fn main(){
 let sizes=[empty(true),drain(true),shutdown(true,true),shutdown(false,true),canceled(false),canceled(true)];
 println!("LAYOUTS:{sizes:?}");
 TRACK.store(true,Ordering::SeqCst);
 for _ in 0..1000{empty(false);drain(false);shutdown(true,false);shutdown(false,false);canceled(false);canceled(true);}
 TRACK.store(false,Ordering::SeqCst);println!("ALLOCATIONS:{}",ALLOCS.load(Ordering::SeqCst));
}
`;

test("private terminal control preserves Done, shutdown and cancellation without allocation", async () => {
  const run = promisify(execFile);
  const directory = await mkdtemp(join(tmpdir(), "reffect-queue-terminal-"));
  try {
    const source = join(directory, "main.rs");
    const runtime = queueContinuationRuntime();
    const bounded = queueBoundedRuntime();
    await writeFile(source, `${bounded}\n${runtime}\n${harness}`);
    const outputs: string[] = [];
    for (const mode of [[], ["-O"]]) {
      const binary = join(directory, mode.length ? "release" : "debug");
      await run("rustc", ["--edition=2021", source, ...mode, "-o", binary], { timeout: 60000 });
      outputs.push((await run(binary, [], { timeout: 10000 })).stdout);
    }
    expect(outputs[1]).toEqual(outputs[0]);
    for (const kind of kinds) {
      const prefix = `CASE:${kind}:`;
      const line = outputs[0]!.split("\n").find((item) => item.startsWith(prefix));
      expect(line, kind).toBeDefined();
      expect(JSON.parse(line!.slice(prefix.length)), kind).toEqual(
        await Effect.runPromise(oracle(kind)),
      );
    }
    const layouts = JSON.parse(
      outputs[0]!
        .split("\n")
        .find((line) => line.startsWith("LAYOUTS:"))!
        .slice(8),
    ) as number[][];
    expect(layouts).toHaveLength(6);
    expect(layouts.flat().every((size) => size > 0 && size <= 512)).toBe(true);
    expect(outputs[0]).toContain("ALLOCATIONS:0");
    process.stdout.write(`Queue terminal child future bytes: ${JSON.stringify(layouts)}\n`);
    const mutations = [
      [
        runtime,
        runtime.replace(
          /async fn end_exit([\s\S]*?)QueueResponse::Interrupted => Err\(QueueInterrupted\)/,
          "async fn end_exit$1QueueResponse::Interrupted => Ok(false)",
        ),
        "Canceled end must remain control interruption",
      ],
      [
        runtime,
        runtime.replace(
          /async fn shutdown_exit([\s\S]*?)QueueResponse::Interrupted => Err\(QueueInterrupted\)/,
          "async fn shutdown_exit$1QueueResponse::Interrupted => Ok(false)",
        ),
        "Canceled shutdown must remain control interruption",
      ],
      [
        bounded,
        bounded.replace(
          "if s.life == QueueLife::Open { s.terminal = QueueTerminal::Interrupted; }",
          "s.terminal = QueueTerminal::Interrupted;",
        ),
        "closing-shutdown",
      ],
      [
        runtime,
        runtime.replace("self.pump_with_waker(event.task, waker);", "/* delayed peer */"),
        "Terminal peer must finish before end returns",
      ],
    ] as const;
    for (const [index, [original, mutated, reason]] of mutations.entries()) {
      expect(mutated).not.toBe(original);
      await writeFile(
        source,
        `${original === bounded ? mutated : bounded}\n${original === runtime ? mutated : runtime}\n${harness}`,
      );
      const binary = join(directory, `mutation-${index}`);
      await run("rustc", ["--edition=2021", source, "-o", binary], { timeout: 60000 });
      if (reason === "closing-shutdown") {
        const changed = (await run(binary, [], { timeout: 10000 })).stdout;
        const prefix = "CASE:closing-shutdown:";
        const line = changed.split("\n").find((item) => item.startsWith(prefix))!;
        expect(JSON.parse(line.slice(prefix.length))).not.toEqual(
          await Effect.runPromise(oracle("closing-shutdown")),
        );
      } else {
        await expect(run(binary, [], { timeout: 10000 })).rejects.toMatchObject({
          stderr: expect.stringContaining(reason),
        });
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180000);
