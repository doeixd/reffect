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

const kinds = [
  "eager",
  "reverse",
  "unopened",
  "parked",
  "waiter",
  "cleanup",
  "completed",
  "parent-cleanup",
  "duplicate",
  "success",
  "interrupted",
  "release",
  "release-reverse",
] as const;
type Kind = (typeof kinds)[number];
const oracle = (kind: Kind) =>
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<number, Cause.Done>(1);
    const events: string[] = [];
    const log = (event: string) =>
      Effect.sync(() => {
        events.push(event);
      });
    const consumer = Queue.take(queue).pipe(Effect.asVoid);
    const producer = Queue.end(queue).pipe(Effect.flatMap((ended) => log(`end:${ended}`)));
    const failingProducer = Queue.offer(queue, 1).pipe(
      Effect.andThen(Queue.offer(queue, 2)),
      Effect.andThen(Effect.fail(Cause.Done())),
    );
    const loggedConsumer = Queue.take(queue).pipe(Effect.flatMap((value) => log(`take:${value}`)));
    const cleanup = Effect.gen(function* () {
      yield* log("cleanup:start");
      yield* Effect.sleep(5);
      yield* log("cleanup:end");
    });
    let signal!: () => void;
    const entered = new Promise<void>((resolve) => {
      signal = resolve;
    });
    let children: readonly Effect.Effect<void, Cause.Done>[];
    switch (kind) {
      case "release":
        children = [loggedConsumer, failingProducer];
        break;
      case "release-reverse":
        children = [failingProducer, loggedConsumer];
        break;
      case "eager":
        children = [consumer, producer];
        break;
      case "reverse":
        children = [producer, consumer];
        break;
      case "unopened":
        yield* Queue.end(queue);
        children = [consumer, log("unopened:entered")];
        break;
      case "parked":
        children = [
          consumer,
          Effect.uninterruptible(Effect.sleep(5)).pipe(Effect.andThen(producer)),
        ];
        break;
      case "waiter":
        children = [
          consumer.pipe(Effect.ensuring(log("waiter:cleanup"))),
          Effect.fail(Cause.Done()),
        ];
        break;
      case "cleanup":
        children = [consumer.pipe(Effect.ensuring(cleanup)), Effect.fail(Cause.Done())];
        break;
      case "completed":
        children = [log("first:done"), Effect.fail(Cause.Done())];
        break;
      case "parent-cleanup":
        children = [
          Effect.fail(Cause.Done()).pipe(Effect.ensuring(cleanup)),
          Effect.sync(signal).pipe(Effect.andThen(consumer)),
        ];
        break;
      case "duplicate":
        children = [
          Effect.fail(Cause.Done()).pipe(Effect.ensuring(cleanup)),
          Effect.fail(Cause.Done()),
        ];
        break;
      case "success":
        children = [log("first:done"), log("second:done")];
        break;
      case "interrupted":
        children = [
          consumer.pipe(Effect.ensuring(log("first:cleanup"))),
          consumer.pipe(Effect.ensuring(log("second:cleanup"))),
        ];
        break;
    }
    const group = yield* Effect.forkChild(
      Effect.all(children, { concurrency: "unbounded", discard: true }),
      { startImmediately: true },
    );
    if (kind === "parent-cleanup") {
      yield* Effect.promise(() => entered);
      yield* Fiber.interrupt(group);
    }
    if (kind === "interrupted") yield* Fiber.interrupt(group);
    const exit = yield* Fiber.await(group);
    let outcome = "success";
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(false);
      const failures = exit.cause.reasons.filter((reason) => reason._tag === "Fail");
      expect(
        failures.every((reason) => Cause.isDone(reason.error) && reason.error.value === undefined),
      ).toBe(true);
      expect(failures.length).toBe(kind === "interrupted" ? 0 : 1);
      outcome = failures.length ? "done" : "interrupted";
    }
    if (queue.state._tag !== "Done") expect(queue.state.takers.size).toBe(0);
    if (kind.startsWith("release")) {
      expect(queue.state._tag).toBe("Open");
      expect(yield* Queue.size(queue)).toBe(1);
      expect(yield* Queue.take(queue)).toBe(2);
    }
    return { events, outcome };
  });

const harness = String.raw`
use std::cell::{Cell,RefCell};
use std::sync::atomic::{AtomicBool,AtomicUsize,Ordering};
struct Allocator;
static TRACK:AtomicBool=AtomicBool::new(false);static ALLOCS:AtomicUsize=AtomicUsize::new(0);
unsafe impl std::alloc::GlobalAlloc for Allocator{
 unsafe fn alloc(&self,l:std::alloc::Layout)->*mut u8{if TRACK.load(Ordering::Relaxed){ALLOCS.fetch_add(1,Ordering::Relaxed);}std::alloc::System.alloc(l)}
 unsafe fn dealloc(&self,p:*mut u8,l:std::alloc::Layout){std::alloc::System.dealloc(p,l)}
}
#[global_allocator]static A:Allocator=Allocator;
struct Log{values:RefCell<[&'static str;8]>,count:Cell<usize>}
impl Log{
 fn new()->Self{Self{values:RefCell::new(["";8]),count:Cell::new(0)}}
 fn push(&self,value:&'static str){let n=self.count.get();self.values.borrow_mut()[n]=value;self.count.set(n+1);}
 fn print(&self,kind:&str,outcome:&str){println!("CASE:{kind}:{{\"events\":{:?},\"outcome\":\"{outcome}\"}}",&self.values.borrow()[..self.count.get()]);}
}
fn category(result:Result<(),QueueTakeFailure>)->&'static str{match result{Ok(())=>"success",Err(QueueTakeFailure::Done(_))=>"done",Err(_)=>"interrupted"}}
async fn case(kind:&str)->[usize;4]{
 let queue=BoundedQueue::<u64,1,2>::new();let bridge=QueueBridge::new();let log=Log::new();
 if kind=="unopened"{queue.end(&mut |_|panic!("No waiters"));}
 let(tx,rx)=tokio::sync::watch::channel(false);let mut root=AsyncContext::new(rx.clone());let mut ctx0=AsyncContext::new(rx.clone());let mut ctx1=AsyncContext::new(rx);
 let task0=bridge.task(0);let task1=bridge.task(1);
 let first=async{
  match kind{
   "release"=>{assert_eq!(task0.take_done_exit().await?,1);log.push("take:1");Ok(())},
   "release-reverse"=>{assert!(task0.offer_exit(1).await.map_err(|_|QueueTakeFailure::ControlInterrupted)?);assert!(task0.offer_exit(2).await.map_err(|_|QueueTakeFailure::ControlInterrupted)?);Err(QueueTakeFailure::Done(QueueDone))},
   "eager"|"parked"|"unopened"=>task0.take_done_exit().await.map(|_|()),
   "reverse"=>{task0.end_exit().await.map_err(|_|QueueTakeFailure::ControlInterrupted)?;log.push("end:true");Ok(())},
   "waiter"=>task0.ensuring_done(task0.take_done_exit(),||async{log.push("waiter:cleanup");}).await.map(|_|()),
   "cleanup"=>task0.ensuring_done(task0.take_done_exit(),||async{log.push("cleanup:start");task0.cleanup_sleep(&mut ctx0,5).await;log.push("cleanup:end");}).await.map(|_|()),
   "parent-cleanup"|"duplicate"=>task0.ensuring_done(async{Err::<(),_>(QueueTakeFailure::Done(QueueDone))},||async{log.push("cleanup:start");task0.cleanup_sleep(&mut ctx0,5).await;log.push("cleanup:end");}).await,
   "completed"|"success"=>{log.push("first:done");Ok(())},
   "interrupted"=>task0.ensuring_done(task0.take_done_exit(),||async{log.push("first:cleanup");}).await.map(|_|()),
   _=>panic!("Unknown case")
  }
 };
 let second=async{
  match kind{
   "release"=>{assert!(task1.offer_exit(1).await.map_err(|_|QueueTakeFailure::ControlInterrupted)?);assert!(task1.offer_exit(2).await.map_err(|_|QueueTakeFailure::ControlInterrupted)?);Err(QueueTakeFailure::Done(QueueDone))},
   "release-reverse"=>{assert_eq!(task1.take_done_exit().await?,1);log.push("take:1");Ok(())},
   "eager"|"parked"=>{if kind=="parked"{task1.cleanup_sleep(&mut ctx1,5).await;}task1.end_exit().await.map_err(|_|QueueTakeFailure::ControlInterrupted)?;log.push("end:true");Ok(())},
   "reverse"=>task1.take_done_exit().await.map(|_|()),
   "unopened"=>{log.push("unopened:entered");Ok(())},
   "waiter"|"cleanup"|"completed"|"duplicate"=>Err(QueueTakeFailure::Done(QueueDone)),
   "parent-cleanup"=>{tx.send(true).unwrap();task1.take_done_exit().await.map(|_|())},
   "success"=>{log.push("second:done");Ok(())},
   "interrupted"=>{tx.send(true).unwrap();task1.ensuring_done(task1.take_done_exit(),||async{log.push("second:cleanup");}).await.map(|_|())},
   _=>panic!("Unknown case")
  }
 };
 tokio::pin!(first,second);let child_sizes=[std::mem::size_of_val(first.as_ref().get_ref()),std::mem::size_of_val(second.as_ref().get_ref())];
 let driver=QueueDriver::new(&queue,&bridge,first.as_mut(),second.as_mut());let driver_size=std::mem::size_of_val(&driver);
 let hosted=driver.run_hosted(&mut root);let host_size=std::mem::size_of_val(&hosted);
 let cancelled=tokio::time::timeout(std::time::Duration::from_secs(2),hosted).await.expect("Fallible All must await settlement");
 let result=driver.all_exit(cancelled);let outcome=category(result);
 assert_eq!(outcome,if kind=="success"{"success"}else if kind=="interrupted"{"interrupted"}else{"done"},"All must retain typed Done over interruption");
 assert_eq!(queue.registered(),0,"Failed All retires waiters");assert!(driver.is_done(0)&&driver.is_done(1));
 if kind=="parked"{assert_eq!(log.count.get(),0,"Registered End continuation must be interrupted");}
 if kind=="eager"{assert_eq!(log.count.get(),1,"Eager End continuation must survive");}
 if kind=="unopened"{assert_eq!(log.count.get(),0,"Unopened sibling must stay unopened");}
 if kind=="completed"{assert_eq!(driver.outcomes[0].get(),Some(Ok(())),"Completed peer is preserved");assert!(!bridge.interrupted[0].get());}
 if kind.starts_with("release"){let state=queue.state.lock().unwrap();assert_eq!(state.life,QueueLife::Open);assert_eq!(state.len,1);assert_eq!(state.ring[0],Some(2),"Offer side effects survive sibling interruption");assert_eq!(log.count.get(),if kind=="release"{0}else{1},"Take continuation respects startup membership");}
 log.print(kind,outcome);[child_sizes[0],child_sizes[1],driver_size,host_size]
}
async fn quiet(rx:&tokio::sync::watch::Receiver<bool>,sleeping:bool)->[usize;4]{
 let queue=BoundedQueue::<u64,1,2>::new();let bridge=QueueBridge::new();let mut root=AsyncContext::new(rx.clone());let mut child=AsyncContext::new(rx.clone());
 let first=async{bridge.task(0).take_done_exit().await.map(|_|())};
 let second=async{if sleeping{bridge.task(1).cleanup_sleep(&mut child,1).await;}bridge.task(1).end_exit().await.map_err(|_|QueueTakeFailure::ControlInterrupted)?;Ok(())};
 tokio::pin!(first,second);let sizes=[std::mem::size_of_val(first.as_ref().get_ref()),std::mem::size_of_val(second.as_ref().get_ref())];
 let driver=QueueDriver::new(&queue,&bridge,first.as_mut(),second.as_mut());let driver_size=std::mem::size_of_val(&driver);let hosted=driver.run_hosted(&mut root);let host_size=std::mem::size_of_val(&hosted);
 let cancelled=hosted.await;assert_eq!(driver.all_exit(cancelled),Err(QueueTakeFailure::Done(QueueDone)));assert_eq!(queue.registered(),0);[sizes[0],sizes[1],driver_size,host_size]
}
fn synchronous(){
 let queue=BoundedQueue::<(),1,2>::new();let bridge=QueueBridge::new();let calls=Cell::new(0);
 let first=std::pin::pin!(async{Err(QueueTakeFailure::Done(QueueDone))});let second=std::pin::pin!(async{calls.set(1);Ok(())});
 let driver=QueueDriver::new(&queue,&bridge,first,second);driver.start();assert_eq!(calls.get(),0);assert_eq!(driver.all_exit(false),Err(QueueTakeFailure::Done(QueueDone)));
}
fn abandonment_refused(){
 let queue=BoundedQueue::<u64,1,2>::new();let bridge=QueueBridge::new();
 let first=std::pin::pin!(async{bridge.task(0).take_done_exit().await.map(|_|())});let second=std::pin::pin!(async{Ok(())});
 let driver=QueueDriver::new(&queue,&bridge,first,second);driver.pump(0);driver.cancel(0);driver.cancel(1);
 let refusal=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||driver.all_exit(true)));
 assert!(refusal.is_err(),"Abandoned entered child is not settled");
 driver.close();let closed=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||driver.all_exit(true)));assert!(closed.is_err(),"Closed driver cannot report All outcome");
}
async fn preabort(){
 let queue=BoundedQueue::<bool,1,2>::new();let bridge=QueueBridge::new();let calls=Cell::new(0);let(_tx,rx)=tokio::sync::watch::channel(true);let mut root=AsyncContext::new(rx);
 let first=async{calls.set(calls.get()+1);Ok(())};let second=async{calls.set(calls.get()+1);Ok(())};tokio::pin!(first,second);
 let driver=QueueDriver::new(&queue,&bridge,first.as_mut(),second.as_mut());let cancelled=driver.run_hosted(&mut root).await;
 assert_eq!(calls.get(),0);assert_eq!(driver.all_exit(cancelled),Err(QueueTakeFailure::ControlInterrupted));
}
async fn masked_root_refused(){
 let queue=BoundedQueue::<u64,1,2>::new();let bridge=QueueBridge::new();let calls=Cell::new(0);let(_tx,rx)=tokio::sync::watch::channel(false);let mut root=AsyncContext::new(rx);root.interruptible=false;
 let first=async{calls.set(calls.get()+1);Ok(())};let second=async{calls.set(calls.get()+1);Ok(())};tokio::pin!(first,second);
 let driver=QueueDriver::new(&queue,&bridge,first.as_mut(),second.as_mut());let hosted=driver.run_hosted(&mut root);tokio::pin!(hosted);
 let refusal=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{let mut cx=std::task::Context::from_waker(std::task::Waker::noop());std::future::Future::poll(hosted.as_mut(),&mut cx)}));
 assert!(refusal.is_err(),"Unrepresentable inherited root mask must refuse");assert_eq!(calls.get(),0);assert_eq!(driver.steps.get(),0);
}
#[tokio::main(flavor="current_thread")]
async fn main(){
 for kind in ["eager","reverse","unopened","parked","waiter","cleanup","completed","parent-cleanup","duplicate","success","interrupted","release","release-reverse"]{let sizes=case(kind).await;println!("LAYOUT:{kind}:{sizes:?}");}
 synchronous();abandonment_refused();preabort().await;masked_root_refused().await;
 let(_tx,rx)=tokio::sync::watch::channel(false);quiet(&rx,true).await;
 for sleeping in [false,true]{ALLOCS.store(0,Ordering::Relaxed);TRACK.store(true,Ordering::Relaxed);let mut sizes=[0;4];for _ in 0..100{sizes=quiet(&rx,sleeping).await;}TRACK.store(false,Ordering::Relaxed);assert_eq!(ALLOCS.load(Ordering::Relaxed),0,"Fallible borrowed All adds no warmed allocations");println!("COST:{sleeping}:0:{sizes:?}");}
}
`;

test(
  "private fallible Queue All retains Done and preserves eager versus registered callbacks",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "reffect-queue-all-"));
    const run = promisify(execFile);
    const core = queueContinuationRuntime(true);
    const source = (runtime = core) =>
      `${asyncRuntime(false, false)}\n${queueBoundedRuntime()}\n${runtime}\n${queueHostRuntime(true)}\n${harness}`;
    try {
      await mkdir(join(directory, "src"));
      await writeFile(
        join(directory, "Cargo.toml"),
        '[package]\nname="queue-all-probe"\nversion="0.0.0"\nedition="2021"\n[dependencies]\ntokio={version="=1.53.1",features=["rt","macros","sync","time"]}\n',
      );
      const file = join(directory, "src/main.rs");
      const execute = (release = false) =>
        run("cargo", ["run", "--offline", "--quiet", ...(release ? ["--release"] : [])], {
          cwd: directory,
          timeout: 120000,
          maxBuffer: 4 * 1024 * 1024,
        });
      await writeFile(file, source());
      const outputs: string[] = [];
      for (const release of [false, true]) outputs.push((await execute(release)).stdout);
      expect(outputs[1]).toEqual(outputs[0]);
      for (const kind of kinds) {
        const prefix = `CASE:${kind}:`;
        const line = outputs[0]!.split("\n").find((value) => value.startsWith(prefix));
        expect(line).toBeDefined();
        expect(JSON.parse(line!.slice(prefix.length)), kind).toEqual(
          await Effect.runPromise(oracle(kind)),
        );
      }
      const layouts = outputs[0]!.split("\n").filter((line) => line.startsWith("LAYOUT:"));
      expect(layouts).toHaveLength(kinds.length);
      for (const line of layouts) {
        const values = JSON.parse(line.slice(line.lastIndexOf(":") + 1)) as number[];
        expect(values).toHaveLength(4);
        expect(values.every((value) => value > 0 && value <= 2048)).toBe(true);
      }
      expect(outputs[0]).toContain("COST:false:0:");
      expect(outputs[0]).toContain("COST:true:0:");
      process.stdout.write(
        outputs[0]!
          .split("\n")
          .filter((line) => line.startsWith("LAYOUT:") || line.startsWith("COST:"))
          .join("\n") + "\n",
      );
      for (const [before, after, reason] of [
        [
          "let processing = self.bridge.slots.borrow()[peer].phase == QueueRequestPhase::Processing;",
          "let processing = false;",
          "Interrupt only a Queue-waiting child",
        ],
        [
          "self.terminal.set(Some(error));",
          "self.terminal.set(Some(QueueTakeFailure::ControlInterrupted));",
          "All must retain typed Done over interruption",
        ],
        [
          "members: std::array::from_fn(|_| std::cell::Cell::new(false))",
          "members: std::array::from_fn(|_| std::cell::Cell::new(true))",
          "Eager End continuation must survive",
        ],
        [
          "if !this.masked && this.task.bridge.interrupted[this.task.task].get() { return std::task::Poll::Ready(QueueResponse::Interrupted); }",
          "if false { return std::task::Poll::Ready(QueueResponse::Interrupted); }",
          "Registered End continuation must be interrupted",
        ],
      ] as const) {
        expect(core.split(before)).toHaveLength(2);
        await writeFile(file, source(core.replace(before, after)));
        await expect(execute()).rejects.toMatchObject({ stderr: expect.stringContaining(reason) });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(4) + 120000,
);
