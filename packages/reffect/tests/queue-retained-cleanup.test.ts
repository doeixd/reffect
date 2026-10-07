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

const kinds = ["done", "done-cancel", "success", "success-cancel", "owner", "control"] as const;
type Kind = (typeof kinds)[number];
const oracle = (kind: Kind) =>
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<number, Cause.Done>(1);
    const events: string[] = [];
    if (kind.startsWith("done")) yield* Queue.end(queue);
    if (kind.startsWith("success")) yield* Queue.offer(queue, 7);
    if (kind === "owner") yield* Queue.shutdown(queue);
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const child = yield* Effect.forkChild(
      Queue.take(queue).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            events.push("cleanup:start");
            started();
            yield* Effect.sleep(5);
            events.push("cleanup:end");
          }),
        ),
      ),
      { startImmediately: true },
    );
    if (kind === "control") yield* Fiber.interrupt(child);
    else if (kind.endsWith("cancel")) {
      yield* Effect.promise(() => entered);
      yield* Fiber.interrupt(child);
    }
    const exit = yield* Fiber.await(child);
    if (Exit.isSuccess(exit)) events.push(`value:${exit.value}`);
    else {
      expect(Cause.hasDies(exit.cause)).toBe(false);
      const failures = exit.cause.reasons.filter((reason) => reason._tag === "Fail");
      expect(failures.every((reason) => Cause.isDone(reason.error))).toBe(true);
      events.push(failures.length ? "exit:done" : "exit:interrupted");
    }
    return events;
  });

const harness = String.raw`
use std::cell::{Cell, RefCell};
use std::sync::atomic::{AtomicBool,AtomicUsize,Ordering};
struct Allocator;
static TRACK:AtomicBool=AtomicBool::new(false);
static ALLOCS:AtomicUsize=AtomicUsize::new(0);
unsafe impl std::alloc::GlobalAlloc for Allocator {
 unsafe fn alloc(&self,l:std::alloc::Layout)->*mut u8 {if TRACK.load(Ordering::Relaxed){ALLOCS.fetch_add(1,Ordering::Relaxed);}std::alloc::System.alloc(l)}
 unsafe fn dealloc(&self,p:*mut u8,l:std::alloc::Layout){std::alloc::System.dealloc(p,l)}
}
#[global_allocator]static A:Allocator=Allocator;
struct Log { values: RefCell<[&'static str;8]>, count: Cell<usize> }
impl Log {
 fn new()->Self{Self{values:RefCell::new(["";8]),count:Cell::new(0)}}
 fn push(&self,value:&'static str){let n=self.count.get();self.values.borrow_mut()[n]=value;self.count.set(n+1);}
 fn print(&self,kind:&str){println!("CASE:{kind}:{:?}",&self.values.borrow()[..self.count.get()]);}
}
async fn case(kind:&str,print:bool)->usize {
 let queue=BoundedQueue::<u64,1,2>::new();let bridge=QueueBridge::new();let log=Log::new();
 if kind.starts_with("done"){assert!(queue.end(&mut |_|panic!("No waiters")));}
 if kind.starts_with("success"){assert!(matches!(queue.offer(0,7),QueueResult::Ready(true)));}
 if kind=="owner"{assert!(queue.shutdown(&mut |_|panic!("No waiters")));}
 let (tx,rx)=tokio::sync::watch::channel(false);let mut root=AsyncContext::new(rx.clone());let mut child=AsyncContext::new(rx);
 let task=bridge.task(0);let calls=Cell::new(0);let outcome=Cell::new(None);
 let first=async{
  let result=task.ensuring_done(task.take_done_exit(),||{calls.set(calls.get()+1);async{
   log.push("cleanup:start");task.cleanup_sleep(&mut child,5).await;log.push("cleanup:end");
  }}).await;
  assert!(child.interruptible);outcome.set(Some(result));
 };
 let second=async{assert_eq!(calls.get(),if kind=="control"{0}else{1},"Cleanup is constructed only after source completion");if kind.ends_with("cancel")||kind=="control"{tx.send(true).unwrap();}};
 tokio::pin!(first,second);let size=std::mem::size_of_val(first.as_ref().get_ref());
 let driver=QueueDriver::new(&queue,&bridge,first.as_mut(),second.as_mut());
 let cancelled=tokio::time::timeout(std::time::Duration::from_secs(2),driver.run_hosted(&mut root)).await.expect("Cleanup must settle");
 assert_eq!(cancelled,kind.ends_with("cancel")||kind=="control");
 assert_eq!(calls.get(),1,"Cleanup factory runs exactly once");
 assert_eq!(queue.registered(),0);assert!(driver.is_done(0)&&driver.is_done(1));
 match outcome.get().expect("Child completed after cleanup") {
  Ok(7)=>log.push("value:7"),
  Err(QueueTakeFailure::Done(_))=>{assert!(kind.starts_with("done"));log.push("exit:done");}
  Err(QueueTakeFailure::OwnerInterrupted|QueueTakeFailure::ControlInterrupted)=>{assert!(!kind.starts_with("done"),"Retained Done must survive cleanup cancellation");log.push("exit:interrupted");}
  _=>panic!("Unexpected scalar outcome")
 }
 assert_eq!(log.values.borrow()[1],"cleanup:end","Cleanup precedes retained outcome");
 if kind.starts_with("done"){assert_eq!(outcome.get(),Some(Err(QueueTakeFailure::Done(QueueDone))),"Retained Done must survive cleanup cancellation");}
 if kind=="success-cancel"{assert_eq!(outcome.get(),Some(Err(QueueTakeFailure::ControlInterrupted)),"Late interruption must replace success");}
 if print{log.print(kind);}size
}
async fn quiet(rx:&tokio::sync::watch::Receiver<bool>)->usize {
 let queue=BoundedQueue::<u64,1,2>::new();let bridge=QueueBridge::new();let task=bridge.task(0);
 let mut root=AsyncContext::new(rx.clone());let mut child=AsyncContext::new(rx.clone());
 let first=async{
  let result=task.ensuring_done(async{Err::<u64,_>(QueueTakeFailure::Done(QueueDone))},||async{task.cleanup_sleep(&mut child,1).await;}).await;
  assert_eq!(result,Err(QueueTakeFailure::Done(QueueDone)));
  let stage=Cell::new(0);
  assert_eq!(task.ensuring_done(async{stage.set(1);Ok(true)},||{assert_eq!(stage.get(),1,"Source precedes cleanup factory");async{stage.set(2);}}).await,Ok(true));assert_eq!(stage.get(),2);
  assert_eq!(task.ensuring_done(async{Ok(())},||async{}).await,Ok(()));
 };
 let second=async{};tokio::pin!(first,second);let size=std::mem::size_of_val(first.as_ref().get_ref());
 let driver=QueueDriver::new(&queue,&bridge,first.as_mut(),second.as_mut());assert!(!driver.run_hosted(&mut root).await);size
}
async fn preabort(){
 let queue=BoundedQueue::<u64,1,2>::new();let bridge=QueueBridge::new();let task=bridge.task(0);let entered=Cell::new(0);
 let (_tx,rx)=tokio::sync::watch::channel(true);let mut root=AsyncContext::new(rx);
 let first=async{let _=task.ensuring_done(async{entered.set(entered.get()+1);Ok(())},||{entered.set(entered.get()+1);async{}}).await;};
 let second=async{};tokio::pin!(first,second);let driver=QueueDriver::new(&queue,&bridge,first.as_mut(),second.as_mut());
 assert!(driver.run_hosted(&mut root).await);assert_eq!(entered.get(),0,"Preabort opens neither source nor cleanup");
}
#[tokio::main(flavor="current_thread")]
async fn main(){
 let mut sizes=[0;6];for(i,kind)in ["done","done-cancel","success","success-cancel","owner","control"].iter().enumerate(){sizes[i]=case(kind,true).await;}
 preabort().await;
 let (_tx,rx)=tokio::sync::watch::channel(false);let quiet_size=quiet(&rx).await;
 TRACK.store(true,Ordering::Relaxed);for _ in 0..100{quiet(&rx).await;}TRACK.store(false,Ordering::Relaxed);
 assert_eq!(ALLOCS.load(Ordering::Relaxed),0,"Retained cleanup adds no warmed allocations");
 println!("LAYOUTS:{sizes:?}:{quiet_size}");println!("ALLOCATIONS:0");
}
`;

test("private Queue retains typed source failures through masked cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reffect-queue-retained-"));
  const run = promisify(execFile);
  const source = (runtime = queueContinuationRuntime()) =>
    `${asyncRuntime(false, false)}\n${queueBoundedRuntime()}\n${runtime}\n${queueHostRuntime()}\n${harness}`;
  try {
    await mkdir(join(directory, "src"));
    await writeFile(
      join(directory, "Cargo.toml"),
      '[package]\nname="queue-retained-probe"\nversion="0.0.0"\nedition="2021"\n[dependencies]\ntokio={version="=1.53.1",features=["rt","macros","sync","time"]}\n',
    );
    const file = join(directory, "src/main.rs");
    await writeFile(file, source());
    const execute = (release = false) =>
      run("cargo", ["run", "--offline", "--quiet", ...(release ? ["--release"] : [])], {
        cwd: directory,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      });
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
    const layout = outputs[0]!.split("\n").find((line) => line.startsWith("LAYOUTS:"))!;
    const [sizes, quiet] = layout.slice(8).split(":");
    const childSizes = JSON.parse(sizes!) as number[];
    expect(childSizes).toHaveLength(kinds.length);
    expect(childSizes.every((size) => size > 0 && size <= 1024)).toBe(true);
    expect(Number(quiet)).toBeGreaterThan(0);
    expect(Number(quiet)).toBeLessThanOrEqual(1024);
    expect(outputs[0]).toContain("ALLOCATIONS:0");
    process.stdout.write(`${layout}\n`);
    const runtime = queueContinuationRuntime();
    for (const [before, after, reason] of [
      [
        "let result = source.await;",
        "let result = source.await.map_err(|_| QueueTakeFailure::ControlInterrupted);",
        "Retained Done must survive cleanup cancellation",
      ],
      [
        "Ok(_) if self.bridge.interrupted[self.task].get()",
        "Ok(_) if false",
        "Late interruption must replace success",
      ],
    ] as const) {
      expect(runtime.split(before)).toHaveLength(2);
      await writeFile(file, source(runtime.replace(before, after)));
      await expect(execute()).rejects.toMatchObject({ stderr: expect.stringContaining(reason) });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 240000);
