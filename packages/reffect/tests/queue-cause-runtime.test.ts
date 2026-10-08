import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Cause, Effect, Exit, Fiber, Queue } from "effect";
import { expect, test } from "vite-plus/test";
import { asyncRuntime } from "../src/async-runtime.ts";
import { causeRuntime } from "../src/cause-runtime.ts";
import { frameTrailRuntime } from "../src/frame-runtime.ts";
import { queueBoundedRuntime } from "../src/queue-bounded-runtime.ts";
import { queueCauseRuntime } from "../src/queue-cause-runtime.ts";
import { queueContinuationRuntime } from "../src/queue-continuation-runtime.ts";
import { queueHostRuntime } from "../src/queue-host-runtime.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const kinds = [
  "done",
  "compound",
  "parent-cleanup",
  "induced",
  "success",
  "interrupted",
  "handler-cancel",
] as const;
type Kind = (typeof kinds)[number];
const normalized = (exit: Exit.Exit<void, Cause.Done>) => {
  if (Exit.isSuccess(exit)) return { interrupted: false, failures: 0 };
  expect(Cause.hasDies(exit.cause)).toBe(false);
  const failures = exit.cause.reasons.filter((reason) => reason._tag === "Fail");
  expect(failures.every((reason) => Cause.isDone(reason.error))).toBe(true);
  return { interrupted: Cause.hasInterrupts(exit.cause), failures: failures.length };
};
const oracle = (kind: Kind) =>
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<number, Cause.Done>(1);
    const events: string[] = [];
    let calls = 0;
    let before: ReturnType<typeof normalized> | undefined;
    const log = (event: string) =>
      Effect.sync(() => {
        events.push(event);
      });
    const cleanup = log("cleanup:start").pipe(
      Effect.andThen(Effect.sleep(5)),
      Effect.andThen(log("cleanup:end")),
    );
    const take = Queue.take(queue).pipe(Effect.asVoid);
    let signal!: () => void;
    const entered = new Promise<void>((resolve) => {
      signal = resolve;
    });
    let children: readonly Effect.Effect<void, Cause.Done>[];
    switch (kind) {
      case "done":
      case "handler-cancel":
        children = [take, Queue.end(queue).pipe(Effect.asVoid)];
        break;
      case "compound":
        children = [
          take,
          Effect.fail(Cause.Done()).pipe(
            Effect.ensuring(
              Effect.sleep(1).pipe(Effect.andThen(Queue.shutdown(queue)), Effect.andThen(cleanup)),
            ),
          ),
        ];
        break;
      case "parent-cleanup":
        children = [
          Effect.fail(Cause.Done()).pipe(Effect.ensuring(cleanup)),
          Effect.sync(signal).pipe(Effect.andThen(take)),
        ];
        break;
      case "induced":
        children = [take.pipe(Effect.ensuring(cleanup)), Effect.fail(Cause.Done())];
        break;
      case "success":
        children = [Effect.void, Effect.void];
        break;
      case "interrupted":
        children = [take, take];
        break;
    }
    const workload = Effect.all(children, { concurrency: "unbounded", discard: true }).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          before = normalized(exit);
        }),
      ),
      Effect.catch(() =>
        Effect.withFiber((fiber) =>
          Effect.sync(() => {
            calls++;
            events.push("recover");
            if (kind === "handler-cancel") fiber.interruptUnsafe(fiber.id);
          }),
        ),
      ),
    );
    const fiber = yield* Effect.forkChild(workload, { startImmediately: true });
    if (kind === "parent-cleanup") {
      yield* Effect.promise(() => entered);
      yield* Fiber.interrupt(fiber);
    }
    if (kind === "interrupted") yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    expect(before).toBeDefined();
    return { events, calls, before, after: normalized(exit) };
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
}
async fn case(kind:&str)->[usize;4]{
 let queue=BoundedQueue::<u64,1,2>::new();let bridge=QueueBridge::new();let log=Log::new();
 let(tx,rx)=tokio::sync::watch::channel(false);let mut root=AsyncContext::new(rx.clone());let mut ctx0=AsyncContext::new(rx.clone());let mut ctx1=AsyncContext::new(rx);
 let task0=bridge.task(0);let task1=bridge.task(1);
 let first=async{match kind{
  "done"|"handler-cancel"|"compound"=>task0.take_done_exit().await.map(|_|()),
  "parent-cleanup"=>task0.ensuring_done(async{Err::<(),_>(QueueTakeFailure::Done(QueueDone))},||async{log.push("cleanup:start");task0.cleanup_sleep(&mut ctx0,5).await;log.push("cleanup:end");}).await,
  "induced"=>task0.ensuring_done(task0.take_done_exit(),||async{log.push("cleanup:start");task0.cleanup_sleep(&mut ctx0,5).await;log.push("cleanup:end");}).await.map(|_|()),
  "interrupted"=>task0.take_done_exit().await.map(|_|()),
  "success"=>Ok(()),_=>panic!("Unknown case")
 }};
 let second=async{match kind{
  "done"|"handler-cancel"=>task1.end_exit().await.map_err(|_|QueueTakeFailure::ControlInterrupted).map(|_|()),
  "compound"=>task1.ensuring_done(async{Err::<(),_>(QueueTakeFailure::Done(QueueDone))},||async{task1.cleanup_sleep(&mut ctx1,1).await;task1.cleanup_shutdown().await;log.push("cleanup:start");task1.cleanup_sleep(&mut ctx1,5).await;log.push("cleanup:end");}).await,
  "parent-cleanup"|"interrupted"=>{tx.send(true).unwrap();task1.take_done_exit().await.map(|_|())},
  "induced"=>Err(QueueTakeFailure::Done(QueueDone)),"success"=>Ok(()),_=>panic!("Unknown case")
 }};
 tokio::pin!(first,second);let child_sizes=[std::mem::size_of_val(first.as_ref().get_ref()),std::mem::size_of_val(second.as_ref().get_ref())];
 let driver=QueueDriver::new(&queue,&bridge,first.as_mut(),second.as_mut());let driver_size=std::mem::size_of_val(&driver);
 let hosted=driver.run_hosted(&mut root);let host_size=std::mem::size_of_val(&hosted);
 let cancelled=tokio::time::timeout(std::time::Duration::from_secs(2),hosted).await.expect("Cause waits for cleanup settlement");
 let before=driver.all_cause(cancelled);
 assert_eq!(before.first(),if kind=="success"||kind=="interrupted"{None}else{Some(RuntimeFailure::QueueDone)},"Done must not become Unit");
 assert_eq!(before.len,if kind=="success"||kind=="interrupted"{0}else{1});
 assert_eq!(before.interrupted,kind=="compound"||kind=="parent-cleanup"||kind=="interrupted","Initial interruption must survive later Done");
 let before_interrupted=before.interrupted;let before_len=before.len;let calls=Cell::new(0);
 let after=queue_recover_all_done(&root,before,|_|{calls.set(calls.get()+1);log.push("recover");if kind=="handler-cancel"{tx.send(true).unwrap();}});
 assert_eq!(calls.get(),if kind=="success"||kind=="interrupted"||kind=="parent-cleanup"{0}else{1},"Canceled recovery must bypass handler; cause interruption alone must not");
 assert_eq!(after.len,if kind=="parent-cleanup"{1}else{0},"Handled Done must be cleared");
 assert_eq!(after.interrupted,kind=="parent-cleanup"||kind=="interrupted"||kind=="handler-cancel","Recovery reflects actual invocation cancellation");
 assert_eq!(queue.registered(),0);
 println!("CASE:{kind}:{{\"events\":{:?},\"calls\":{},\"before\":{{\"interrupted\":{},\"failures\":{}}},\"after\":{{\"interrupted\":{},\"failures\":{}}}}}",&log.values.borrow()[..log.count.get()],calls.get(),before_interrupted,before_len,after.interrupted,after.len);
 [child_sizes[0],child_sizes[1],driver_size,host_size]
}
async fn quiet(rx:&tokio::sync::watch::Receiver<bool>){
 let queue=BoundedQueue::<(),1,2>::new();let bridge=QueueBridge::new();let mut root=AsyncContext::new(rx.clone());let calls=Cell::new(0);
 let first=std::pin::pin!(async{bridge.task(0).take_done_exit().await.map(|_|())});let second=std::pin::pin!(async{bridge.task(1).end_exit().await.map_err(|_|QueueTakeFailure::ControlInterrupted).map(|_|())});
 let driver=QueueDriver::new(&queue,&bridge,first,second);let cancelled=driver.run_hosted(&mut root).await;
 let after=queue_recover_all_done(&root,driver.all_cause(cancelled),|_|calls.set(calls.get()+1));assert_eq!(calls.get(),1);assert!(!after.interrupted&&after.len==0);
}
fn invalid_causes(){
 let(_tx,rx)=tokio::sync::watch::channel(false);let root=AsyncContext::new(rx);let calls=Cell::new(0);
 for error in [RuntimeFailure::Unit,RuntimeFailure::Bool(true),RuntimeFailure::U64(1),RuntimeFailure::QueueDone]{
  let mut cause=RuntimeCause::empty();cause.push(error,false);if error==RuntimeFailure::QueueDone{cause.push(error,false);}
  let refusal=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||queue_recover_all_done(&root,cause,|_|calls.set(1))));assert!(refusal.is_err(),"Foreign/multiple causes must refuse");
 }
 for (len,first) in [(1,None),(0,Some(RuntimeFailure::QueueDone))]{
  let cause=RuntimeCause{interrupted:false,failures:[first,None,None],len};
  assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||queue_recover_all_done(&root,cause,|_|calls.set(1)))).is_err(),"Malformed cause must refuse");
 }
 assert_eq!(calls.get(),0);
 let mut cause=RuntimeCause::empty();cause.push(RuntimeFailure::QueueDone,true);cause.push(RuntimeFailure::QueueDone,true);assert_eq!(cause.len,1);cause.write_scalar();
 let mut unit=RuntimeCause::empty();unit.push(RuntimeFailure::Unit,true);unit.write_scalar();
}
#[tokio::main(flavor="current_thread")]
async fn main(){
 for kind in ["done","compound","parent-cleanup","induced","success","interrupted","handler-cancel"]{let sizes=case(kind).await;println!("LAYOUT:{kind}:{sizes:?}");}
 invalid_causes();let(_tx,rx)=tokio::sync::watch::channel(false);quiet(&rx).await;
 ALLOCS.store(0,Ordering::Relaxed);TRACK.store(true,Ordering::Relaxed);for _ in 0..100{quiet(&rx).await;}TRACK.store(false,Ordering::Relaxed);assert_eq!(ALLOCS.load(Ordering::Relaxed),0,"Cause projection and recovery add no warmed allocations");
 println!("COST:0");println!("CARRIER:{:?}",[std::mem::size_of::<RuntimeFailure>(),std::mem::size_of::<RuntimeCause>()]);
}
`;

test(
  "private Queue causes preserve Done and guard recovery by invocation cancellation",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "reffect-queue-cause-"));
    const run = promisify(execFile);
    const core = queueContinuationRuntime(true);
    const adapter = queueCauseRuntime();
    const source = (frames: boolean, runtime = core, bridge = adapter) =>
      `${asyncRuntime(false, false)}\n${frames ? `const MAX_LOGICAL_FRAMES: usize = 8;\n${frameTrailRuntime}` : ""}\n${causeRuntime(frames, true)}\n${queueBoundedRuntime()}\n${runtime}\n${queueHostRuntime(true)}\n${bridge}\n${harness}`;
    try {
      await mkdir(join(directory, "src"));
      await writeFile(
        join(directory, "Cargo.toml"),
        '[package]\nname="queue-cause-probe"\nversion="0.0.0"\nedition="2021"\n[dependencies]\ntokio={version="=1.53.1",features=["rt","macros","sync","time"]}\n',
      );
      const file = join(directory, "src/main.rs");
      const execute = (release = false) =>
        run("cargo", ["run", "--offline", "--quiet", ...(release ? ["--release"] : [])], {
          cwd: directory,
          timeout: 120000,
          maxBuffer: 4 * 1024 * 1024,
        });
      const outputs: string[] = [];
      for (const frames of [false, true]) {
        await writeFile(file, source(frames));
        for (const release of [false, true]) outputs.push((await execute(release)).stdout);
      }
      for (const output of outputs) expect(output).toBe(outputs[0]);
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
        const sizes = JSON.parse(line.slice(line.lastIndexOf(":") + 1)) as number[];
        expect(sizes).toHaveLength(4);
        expect(sizes.every((size) => size > 0 && size <= 1024)).toBe(true);
      }
      expect(outputs[0]).toContain("cause:done\ncause:unit\nCOST:0");
      process.stdout.write(
        outputs[0]!
          .split("\n")
          .filter((line) => /^(LAYOUT|COST|CARRIER):/.test(line))
          .join("\n") + "\n",
      );
      const baseline = `${causeRuntime(false)}\nfn main(){println!("CARRIER:{:?}",[std::mem::size_of::<RuntimeFailure>(),std::mem::size_of::<RuntimeCause>()]);}`;
      await writeFile(file, baseline);
      expect((await execute()).stdout.trim()).toBe(
        outputs[0]!.split("\n").find((line) => line.startsWith("CARRIER:")),
      );
      for (const [component, before, after, reason] of [
        [
          "adapter",
          "cause.push(RuntimeFailure::QueueDone, true)",
          "cause.push(RuntimeFailure::Unit, true)",
          "Done must not become Unit",
        ],
        [
          "core",
          "self.terminal_interrupted.set(true);",
          "self.terminal_interrupted.set(false);",
          "Initial interruption must survive later Done",
        ],
        ["adapter", " || context.is_cancelled()", "", "Canceled recovery must bypass handler"],
        [
          "adapter",
          "recovered.interrupted = context.is_cancelled();",
          "recovered.interrupted = false;",
          "Recovery reflects actual invocation cancellation",
        ],
      ] as const) {
        const original = component === "core" ? core : adapter;
        expect(original.split(before)).toHaveLength(2);
        await writeFile(
          file,
          source(
            false,
            component === "core" ? core.replace(before, after) : core,
            component === "adapter" ? adapter.replace(before, after) : adapter,
          ),
        );
        await expect(execute()).rejects.toMatchObject({ stderr: expect.stringContaining(reason) });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(5) + 120000,
);
