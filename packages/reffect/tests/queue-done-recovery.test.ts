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
  "success",
  "done",
  "recovery-offer",
  "recovery-take",
  "recovery-failure",
  "owner-interrupt",
  "control-interrupt",
] as const;
type Kind = (typeof kinds)[number];
const oracle = (kind: Kind) =>
  Effect.gen(function* () {
    const owner = yield* Queue.bounded<number, Cause.Done>(1);
    const events: string[] = [];
    let handlers = 0;
    const log = (event: string) => Effect.sync(() => events.push(event));
    const source = Queue.take(owner).pipe(
      Effect.catch((done) =>
        Effect.gen(function* () {
          expect(Cause.isDone(done) && done.value === undefined).toBe(true);
          handlers++;
          yield* log("recover:done");
          if (kind === "recovery-offer") yield* log(`offer:${yield* Queue.offer(owner, 99)}`);
          if (kind === "recovery-take") return yield* Queue.take(owner);
          if (kind === "recovery-failure") return yield* Effect.fail(Cause.Done());
          return 9;
        }),
      ),
    );
    const observed = source.pipe(
      Effect.exit,
      Effect.flatMap((exit) => {
        if (Exit.isSuccess(exit)) return log(`value:${exit.value}`);
        if (Cause.hasInterruptsOnly(exit.cause)) return log("exit:owner-interrupted");
        const error = Cause.findErrorOption(exit.cause);
        expect(Cause.hasDies(exit.cause)).toBe(false);
        expect(Option.isSome(error) && Cause.isDone(error.value)).toBe(true);
        return log("exit:done");
      }),
    );
    if (kind === "success") {
      yield* Queue.offer(owner, 7);
      yield* observed;
    } else if (kind === "control-interrupt") {
      const child = yield* Effect.forkChild(source, { startImmediately: true });
      yield* Fiber.interrupt(child);
      const exit = yield* Fiber.await(child);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(owner.state._tag !== "Done" && owner.state.takers.size === 0).toBe(true);
      yield* log("exit:control-interrupted");
    } else {
      const child = yield* Effect.forkChild(observed, { startImmediately: true });
      if (kind === "owner-interrupt") yield* log(`shutdown:${yield* Queue.shutdown(owner)}`);
      else yield* log(`end:${yield* Queue.end(owner)}`);
      yield* Fiber.join(child);
    }
    expect(handlers).toBe(
      ["success", "owner-interrupt", "control-interrupt"].includes(kind) ? 0 : 1,
    );
    return events;
  });

const scalarOracle = (unit: boolean) =>
  Effect.gen(function* () {
    const events: string[] = [];
    const log = (value: string) => Effect.sync(() => events.push(value));
    if (unit) {
      const owner = yield* Queue.bounded<void, Cause.Done>(1);
      yield* Queue.offer(owner, undefined);
      yield* log(`end:${yield* Queue.end(owner)}`);
      expect(yield* Queue.take(owner)).toBeUndefined();
      yield* log("value:unit");
      const value = yield* Queue.take(owner).pipe(
        Effect.catch((done) => {
          expect(Cause.isDone(done)).toBe(true);
          return log("recover:done").pipe(Effect.asVoid);
        }),
      );
      expect(value).toBeUndefined();
      yield* log("value:unit");
    } else {
      const owner = yield* Queue.bounded<boolean, Cause.Done>(1);
      yield* Queue.offer(owner, true);
      yield* log(`end:${yield* Queue.end(owner)}`);
      expect(yield* Queue.take(owner)).toBe(true);
      yield* log("value:true");
      const value = yield* Queue.take(owner).pipe(
        Effect.catch((done) => {
          expect(Cause.isDone(done)).toBe(true);
          return log("recover:done").pipe(Effect.as(false));
        }),
      );
      expect(value).toBe(false);
      yield* log("value:false");
    }
    return events;
  });

const harness = String.raw`
use std::cell::{Cell,RefCell};
use std::sync::atomic::{AtomicBool,AtomicUsize,Ordering};
struct Allocator;
static TRACK:AtomicBool=AtomicBool::new(false);
static ALLOCS:AtomicUsize=AtomicUsize::new(0);
unsafe impl std::alloc::GlobalAlloc for Allocator {
 unsafe fn alloc(&self,l:std::alloc::Layout)->*mut u8{if TRACK.load(Ordering::Relaxed){ALLOCS.fetch_add(1,Ordering::Relaxed);}unsafe{std::alloc::System.alloc(l)}}
 unsafe fn dealloc(&self,p:*mut u8,l:std::alloc::Layout){unsafe{std::alloc::System.dealloc(p,l)}}
 unsafe fn realloc(&self,p:*mut u8,l:std::alloc::Layout,n:usize)->*mut u8{if TRACK.load(Ordering::Relaxed){ALLOCS.fetch_add(1,Ordering::Relaxed);}unsafe{std::alloc::System.realloc(p,l,n)}}
}
#[global_allocator]static ALLOCATOR:Allocator=Allocator;
struct Log{values:RefCell<[&'static str;8]>,len:Cell<usize>}
impl Log{
 fn new()->Self{Self{values:RefCell::new(["";8]),len:Cell::new(0)}}
 fn push(&self,value:&'static str){let n=self.len.get();assert!(n<8);self.values.borrow_mut()[n]=value;self.len.set(n+1);}
 fn print(&self,kind:&str){println!("CASE:{kind}:{:?}",&self.values.borrow()[..self.len.get()]);}
}
fn run_case(kind:&str,print:bool)->[usize;2]{
 let queue=BoundedQueue::<u64,1,2>::new();let bridge=QueueBridge::new();let log=Log::new();let handlers=Cell::new(0);
 if kind=="success"{assert_eq!(queue.offer(0,7),QueueResult::Ready(true));}
 let first=std::pin::pin!(async{
  let task=bridge.task(0);let trace=&log;let counter=&handlers;
  let result=queue_catch_done(task.take_done_exit(),|done:QueueDone|async move{
   assert_eq!(std::mem::size_of_val(&done),0);counter.set(counter.get()+1);trace.push("recover:done");
   if kind=="recovery-offer"{assert!(!task.offer_exit(99).await.unwrap());trace.push("offer:false");}
   if kind=="recovery-take"{return task.take_done_exit().await;}
   if kind=="recovery-failure"{return Err(QueueTakeFailure::Done(done));}
   Ok(9)
  }).await;
  match kind{
   "success"=>{assert_eq!(result.unwrap(),7);log.push("value:7");}
   "done"|"recovery-offer"=>{assert_eq!(result.expect("Typed Done must recover"),9);log.push("value:9");}
   "recovery-take"|"recovery-failure"=>{assert!(matches!(result,Err(QueueTakeFailure::Done(_))),"Recovery failure must remain Done");log.push("exit:done");}
   "owner-interrupt"=>{assert_eq!(result,Err(QueueTakeFailure::OwnerInterrupted),"Owner interruption must bypass recovery");log.push("exit:owner-interrupted");}
   "control-interrupt"=>assert_eq!(result,Err(QueueTakeFailure::ControlInterrupted),"Control interruption must bypass recovery"),
   _=>panic!("Unknown case")
  }
 });
 let second=std::pin::pin!(async{
  if kind=="success"||kind=="control-interrupt"{return;}
  if kind=="owner-interrupt"{assert!(bridge.task(1).shutdown_exit().await.unwrap());log.push("shutdown:true");}
  else{assert!(bridge.task(1).end_exit().await.unwrap());log.push("end:true");}
 });
 let sizes=[std::mem::size_of_val(first.as_ref().get_ref()),std::mem::size_of_val(second.as_ref().get_ref())];
 let driver=QueueDriver::new(&queue,&bridge,first,second);driver.pump(0);
 if kind=="control-interrupt"{assert!(driver.interrupt(0));log.push("exit:control-interrupted");assert_eq!(queue.state.lock().unwrap().life,QueueLife::Open);}
 driver.pump(1);driver.dispatch();
 assert!(driver.is_done(0)&&driver.is_done(1));assert!(!driver.interrupt_all());assert_eq!(queue.registered(),0);
 assert_eq!(handlers.get(),if matches!(kind,"success"|"owner-interrupt"|"control-interrupt"){0}else{1},"Only typed Done invokes recovery");
 if print{log.print(kind);}sizes
}
fn boolean(print:bool)->[usize;2]{
 let queue=BoundedQueue::<bool,1,2>::new();let bridge=QueueBridge::new();let log=Log::new();
 let first=std::pin::pin!(async{assert!(bridge.task(0).offer_exit(true).await.unwrap());assert!(bridge.task(0).end_exit().await.unwrap());log.push("end:true");});
 let second=std::pin::pin!(async{
  let value=queue_catch_done(bridge.task(1).take_done_exit(),|_:QueueDone|async{panic!("Success must bypass recovery")}).await.unwrap();assert!(value);log.push("value:true");
  let value=queue_catch_done(bridge.task(1).take_done_exit(),|_:QueueDone|async{log.push("recover:done");Ok(false)}).await.unwrap();assert!(!value);log.push("value:false");
 });
 let sizes=[std::mem::size_of_val(first.as_ref().get_ref()),std::mem::size_of_val(second.as_ref().get_ref())];
 let driver=QueueDriver::new(&queue,&bridge,first,second);driver.pump(0);driver.pump(1);driver.dispatch();assert!(driver.is_done(0)&&driver.is_done(1));assert_eq!(queue.registered(),0);
 if print{log.print("bool");}sizes
}
fn unit(print:bool)->[usize;2]{
 let queue=BoundedQueue::<(),1,2>::new();let bridge=QueueBridge::new();let log=Log::new();
 let first=std::pin::pin!(async{assert!(bridge.task(0).offer_exit(()).await.unwrap());assert!(bridge.task(0).end_exit().await.unwrap());log.push("end:true");});
 let second=std::pin::pin!(async{
  assert_eq!(queue_catch_done(bridge.task(1).take_done_exit(),|_:QueueDone|async{panic!("Success must bypass recovery")}).await,Ok(()));log.push("value:unit");
  assert_eq!(queue_catch_done(bridge.task(1).take_done_exit(),|_:QueueDone|async{log.push("recover:done");Ok(())}).await,Ok(()));log.push("value:unit");
 });
 let sizes=[std::mem::size_of_val(first.as_ref().get_ref()),std::mem::size_of_val(second.as_ref().get_ref())];
 let driver=QueueDriver::new(&queue,&bridge,first,second);driver.pump(0);driver.pump(1);driver.dispatch();assert!(driver.is_done(0)&&driver.is_done(1));assert_eq!(queue.registered(),0);
 if print{log.print("unit");}sizes
}
fn main(){
 assert_eq!(std::mem::size_of::<QueueDone>(),0);assert_eq!(std::mem::size_of::<QueueTakeFailure>(),1);
 let kinds=["success","done","recovery-offer","recovery-take","recovery-failure","owner-interrupt","control-interrupt"];
 let mut layouts=[[0;2];9];for(i,kind)in kinds.iter().enumerate(){layouts[i]=run_case(kind,true);}layouts[7]=boolean(true);layouts[8]=unit(true);
 println!("LAYOUTS:{layouts:?}");println!("CARRIERS:0:1");
 TRACK.store(true,Ordering::SeqCst);for _ in 0..1000{for kind in kinds{run_case(kind,false);}boolean(false);unit(false);}TRACK.store(false,Ordering::SeqCst);
 println!("ALLOCATIONS:{}",ALLOCS.load(Ordering::SeqCst));
}
`;

test("private unit Done is typed and local recovery preserves failures and interruption", async () => {
  const run = promisify(execFile);
  const directory = await mkdtemp(join(tmpdir(), "reffect-queue-done-"));
  try {
    const source = join(directory, "main.rs");
    const bounded = queueBoundedRuntime();
    const runtime = queueContinuationRuntime();
    await writeFile(source, `${bounded}\n${runtime}\n${harness}`);
    const outputs: string[] = [];
    for (const mode of [[], ["-O"]]) {
      const binary = join(directory, mode.length ? "release" : "debug");
      await run("rustc", ["--edition=2021", source, ...mode, "-o", binary], { timeout: 60000 });
      outputs.push((await run(binary, [], { timeout: 10000 })).stdout);
    }
    expect(outputs[1]).toEqual(outputs[0]);
    const trace = (output: string, kind: string) => {
      const prefix = `CASE:${kind}:`;
      const line = output.split("\n").find((item) => item.startsWith(prefix));
      expect(line, kind).toBeDefined();
      return JSON.parse(line!.slice(prefix.length));
    };
    for (const kind of kinds)
      expect(trace(outputs[0]!, kind), kind).toEqual(await Effect.runPromise(oracle(kind)));
    for (const unit of [false, true])
      expect(trace(outputs[0]!, unit ? "unit" : "bool")).toEqual(
        await Effect.runPromise(scalarOracle(unit)),
      );
    const layouts = JSON.parse(
      outputs[0]!
        .split("\n")
        .find((line) => line.startsWith("LAYOUTS:"))!
        .slice(8),
    ) as number[][];
    expect(layouts).toHaveLength(9);
    expect(
      layouts.every((pair) => pair.length === 2 && pair.every((size) => size > 0 && size <= 512)),
    ).toBe(true);
    expect(outputs[0]).toContain("CARRIERS:0:1");
    expect(outputs[0]).toContain("ALLOCATIONS:0");
    process.stdout.write(`Queue Done recovery child future bytes: ${JSON.stringify(layouts)}\n`);
    const mutations = [
      [
        runtime.replace(
          "result => result,",
          "Err(QueueTakeFailure::OwnerInterrupted) => handler(QueueDone).await, result => result,",
        ),
        "Owner interruption must bypass recovery",
      ],
      [
        runtime.replace(
          "result => result,",
          "Err(QueueTakeFailure::ControlInterrupted) => handler(QueueDone).await, result => result,",
        ),
        "Control interruption must bypass recovery",
      ],
      [
        runtime.replace(
          "Err(QueueTakeFailure::Done(QueueDone)),",
          "Err(QueueTakeFailure::OwnerInterrupted),",
        ),
        "Typed Done must recover",
      ],
      [
        runtime
          .replace("queue_catch_done<T, Source", "queue_catch_done<T: Default, Source")
          .replace("handler(done).await", "handler(done).await.or_else(|_| Ok(T::default()))"),
        "Recovery failure must remain Done",
      ],
    ] as const;
    for (const [index, [mutated, reason]] of mutations.entries()) {
      expect(mutated).not.toBe(runtime);
      await writeFile(source, `${bounded}\n${mutated}\n${harness}`);
      const binary = join(directory, `mutation-${index}`);
      await run("rustc", ["--edition=2021", source, "-o", binary], { timeout: 60000 });
      await expect(run(binary, [], { timeout: 10000 })).rejects.toMatchObject({
        stderr: expect.stringContaining(reason),
      });
    }
    await writeFile(
      source,
      `${bounded}\n${runtime}\nfn main(){
 let _future=queue_catch_done(async{Err::<u64,_>(QueueTakeFailure::Done(QueueDone))},|_:()|async{Ok(0)});
}`,
    );
    await expect(
      run("rustc", ["--edition=2021", source, "-o", join(directory, "wrong-unit")], {
        timeout: 60000,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("type mismatch in closure arguments"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180000);
