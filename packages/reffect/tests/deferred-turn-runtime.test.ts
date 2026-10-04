import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { nativeTestBudget } from "./native-test-budget.ts";
import { deferredStateRuntime } from "../src/deferred-state-runtime.ts";
import { deferredTurnRuntime } from "../src/deferred-turn-runtime.ts";
import { deferredTurnOracle, deferredTurnExpected } from "./fixtures/deferred-turn-oracle.ts";

const execute = promisify(execFile);
// Kernel fixture only: this does not enable Deferred authoring or select this runtime.
const harness = String.raw`use std::{sync::Mutex, future::Future, pin::Pin, task::{Context,Poll}};
const N:usize=6;
struct Deferred(DeferredState<u64, (), N>);
impl Deferred {
 fn new()->Self { Self(DeferredState::new()) }
 async fn wait(&self,bank:&DeferredTurns<N>,task:usize)->u64 {
  self.0.wait(bank,task).await.expect("Success-only trace fixture")
 }
 fn complete<'a>(&'a self,bank:&'a DeferredTurns<N>,task:usize)->DeferredComplete<'a,u64,(),N,N> {
  self.0.complete(bank,task,Ok(7))
 }
}

async fn semantic<F:Future>(bank:&DeferredTurns<N>,task:usize,future:F)->F::Output{
 tokio::pin!(future);
 std::future::poll_fn(|cx|{let result=future.as_mut().poll(cx);if result.is_pending(){bank.suspended(task)}result}).await
}
async fn task<F:Future<Output=()>>(bank:&DeferredTurns<N>,id:usize,future:F){
 tokio::pin!(future);
 std::future::poll_fn(|cx|{bank.before_poll(id);let result=future.as_mut().poll(cx);bank.after_poll(id,result.is_ready(),cx.waker());result}).await
}
async fn group4<A,B,C,D>(bank:&DeferredTurns<N>,a:A,b:B,c:C,d:D,reverse:bool)
where A:Future<Output=()>,B:Future<Output=()>,C:Future<Output=()>,D:Future<Output=()>{
 tokio::pin!(a,b,c,d);let mut done=[false;4];
 std::future::poll_fn(|cx|{
  // Only adapter progress is retried. Real Pending needs the real executor Waker.
  for _ in 0..(2*N*N+2*N){
   bank.take_changed();
   let order=if reverse{[1,0,2,3]}else{[0,1,2,3]};
   let mut restart=false;
   for index in order{
    if done[index]||!bank.permits(index+1,|selected,ancestor|(selected==0||selected==5)&&ancestor==1){continue}
    let result=match index{0=>a.as_mut().poll(cx),1=>b.as_mut().poll(cx),2=>c.as_mut().poll(cx),_=>d.as_mut().poll(cx)};
    done[index]=result.is_ready();
    if bank.take_changed(){restart=true;break}
   }
   if done.iter().all(|x|*x){assert!(bank.priority().is_none());return Poll::Ready(())}
   if !restart{return Poll::Pending}
  }
  cx.waker().wake_by_ref();Poll::Pending
 }).await
}
fn log(trace:&Mutex<Vec<String>>,event:&str){trace.lock().unwrap().push(event.into())}
async fn scenario(yield_nested:bool,reverse:bool){
 let bank=DeferredTurns::<N>::new();let a=Deferred::new();let b=Deferred::new();let trace=Mutex::new(vec![]);
 let w1=task(&bank,1,async{a.wait(&bank,1).await;log(&trace,"w1:resumed");let won=b.complete(&bank,1).await;log(&trace,&format!("nested:{won}"));});
 let w2=task(&bank,2,async{a.wait(&bank,2).await;log(&trace,"w2:resumed")});
 let other=task(&bank,3,async{b.wait(&bank,3).await;log(&trace,"other:resumed");if yield_nested{semantic(&bank,3,tokio::task::yield_now()).await;log(&trace,"other:after-yield")}});
 let producer=task(&bank,4,async{let won=a.complete(&bank,4).await;log(&trace,&format!("producer:{won}"));assert!(!a.complete(&bank,4).await);assert_eq!(a.wait(&bank,4).await,7);});
 group4(&bank,w1,w2,other,producer,reverse).await;
 let actual=trace.into_inner().unwrap();let expected=if reverse{vec!["w2:resumed","w1:resumed","other:resumed","nested:true","producer:true"]}else if yield_nested{vec!["w1:resumed","other:resumed","nested:true","w2:resumed","producer:true","other:after-yield"]}else{vec!["w1:resumed","other:resumed","nested:true","w2:resumed","producer:true"]};assert_eq!(actual,expected);println!("CASE:{}:{actual:?}",if reverse{"reverse-nested"}else if yield_nested{"nested-waiter-yields"}else{"nested-completion"});
}
async fn cancellation(masked:bool){
 let bank=DeferredTurns::<N>::new();let a=Deferred::new();let trace=Mutex::new(vec![]);let(tx,mut rx)=tokio::sync::watch::channel(false);
 let w1=task(&bank,1,async{a.wait(&bank,1).await;log(&trace,"w1:resumed");tx.send(true).unwrap();log(&trace,"interrupt-producer");});
 let w2=task(&bank,2,async{a.wait(&bank,2).await;log(&trace,"w2:resumed")});
 let other=task(&bank,3,async{});
 let producer=task(&bank,4,async{
  // Whole broadcast remains masked, including its artificial Pending phases.
  let won=a.complete(&bank,4).await;
  if masked||!*rx.borrow(){log(&trace,&format!("producer:{won}"))}
  semantic(&bank,4,rx.changed()).await.unwrap();

  semantic(&bank,4,tokio::time::sleep(std::time::Duration::from_millis(1))).await;
  log(&trace,"producer:cleanup");
 });
 group4(&bank,w1,w2,other,producer,false).await;
 let actual=trace.into_inner().unwrap();let expected=if masked{vec!["w1:resumed","interrupt-producer","w2:resumed","producer:true","producer:cleanup"]}else{vec!["w1:resumed","interrupt-producer","w2:resumed","producer:cleanup"]};assert_eq!(actual,expected);println!("CASE:{}:{actual:?}",if masked{"interrupt-masked-producer"}else{"interrupt-producer"});
}
async fn simple(kind:&str){
 let bank=DeferredTurns::<N>::new();let a=Deferred::new();let trace=Mutex::new(vec![]);let(tx,mut rx)=tokio::sync::watch::channel(false);
 let first=task(&bank,1,async{a.wait(&bank,1).await;log(&trace,"w1:resumed");if kind=="waiter-yields"{semantic(&bank,1,tokio::task::yield_now()).await;log(&trace,"w1:after-yield")}if kind=="interrupt-next-waiter"{log(&trace,"interrupt-w2");tx.send(true).unwrap();}});
 let second=task(&bank,2,async{
  if kind=="interrupt-next-waiter"{
   let result=semantic(&bank,2,async{if *rx.borrow(){return false}tokio::select!{biased; _=rx.changed()=>false,_=a.wait(&bank,2)=>true}}).await;
   if result{log(&trace,"w2:resumed")}else{log(&trace,"w2:cleanup")}
  }else{a.wait(&bank,2).await;log(&trace,"w2:resumed")}
 });
 let third=task(&bank,3,async{});
 let producer=task(&bank,4,async{let won=a.complete(&bank,4).await;log(&trace,&format!("producer:{won}"));});
 group4(&bank,first,second,third,producer,kind=="reversed-registration").await;
 println!("CASE:{kind}:{:?}",trace.into_inner().unwrap());
}
async fn inner2<A:Future<Output=()>,B:Future<Output=()>>(bank:&DeferredTurns<N>,a:A,b:B){
 tokio::pin!(a,b);let mut done=[false;2];
 std::future::poll_fn(|cx|{
  // Root owns progress retries; this coordinator only routes to its selected descendant.
  if !done[0]&&bank.permits(5,|_,_|false){done[0]=a.as_mut().poll(cx).is_ready();}
  if !done[1]&&bank.permits(0,|_,_|false){done[1]=b.as_mut().poll(cx).is_ready();}
  if done.iter().all(|x|*x){Poll::Ready(())}else{Poll::Pending}
 }).await
}
async fn nested_driver(){
 let bank=DeferredTurns::<N>::new();let a=Deferred::new();let b=Deferred::new();let trace=Mutex::new(vec![]);
 let ancestor=task(&bank,1,inner2(&bank,
  task(&bank,5,async{a.wait(&bank,5).await;log(&trace,"w1:resumed");let won=b.complete(&bank,5).await;log(&trace,&format!("nested:{won}"));}),
  task(&bank,0,async{b.wait(&bank,0).await;log(&trace,"other:resumed");semantic(&bank,0,tokio::task::yield_now()).await;log(&trace,"other:after-yield");})
 ));
 let second=task(&bank,2,async{a.wait(&bank,2).await;log(&trace,"w2:resumed")});
 let third=task(&bank,3,async{});
 let producer=task(&bank,4,async{let won=a.complete(&bank,4).await;log(&trace,&format!("producer:{won}"));});
 group4(&bank,ancestor,second,third,producer,false).await;
 assert_eq!(trace.into_inner().unwrap(),["w1:resumed","other:resumed","nested:true","w2:resumed","producer:true","other:after-yield"]);
}
struct Count;
static ALLOCATIONS:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);
unsafe impl std::alloc::GlobalAlloc for Count{
 unsafe fn alloc(&self,layout:std::alloc::Layout)->*mut u8{ALLOCATIONS.fetch_add(1,std::sync::atomic::Ordering::SeqCst);unsafe{std::alloc::System.alloc(layout)}}
 unsafe fn dealloc(&self,pointer:*mut u8,layout:std::alloc::Layout){unsafe{std::alloc::System.dealloc(pointer,layout)}}
}
#[global_allocator]static ALLOCATOR:Count=Count;
fn acknowledgement_isolation(){
 let bank=DeferredTurns::<N>::new();let waker=std::task::Waker::noop();
 bank.request(4,1,waker);
 bank.before_poll(1);bank.after_poll(1,false,waker);
 assert_eq!(bank.priority(),Some(1));assert!(!bank.finish_request(4));
 bank.request(1,2,waker);
 bank.before_poll(2);bank.suspended(2);bank.after_poll(2,false,waker);
 assert_eq!(bank.priority(),Some(1));assert!(!bank.finish_request(4));
 assert!(bank.finish_request(1));assert_eq!(bank.priority(),Some(1));
 // The inner task's semantic flag cannot acknowledge its outer caller.
 bank.after_poll(1,false,waker);assert!(!bank.finish_request(4));
 // The same resumed caller can complete another owner without retaining a lease.
 bank.request(1,3,waker);bank.before_poll(3);bank.after_poll(3,true,waker);
 assert!(bank.finish_request(1));assert_eq!(bank.priority(),Some(1));
 bank.suspended(1);bank.after_poll(1,false,waker);
 assert_eq!(bank.priority(),Some(4));assert!(bank.finish_request(4));
 assert!(bank.priority().is_none());
 // A previous semantic Pending must be cleared before a reused task is polled.
 bank.request(4,1,waker);bank.before_poll(1);bank.after_poll(1,false,waker);
 assert_eq!(bank.priority(),Some(1));assert!(!bank.finish_request(4));
 bank.after_poll(1,true,waker);assert!(bank.finish_request(4));
 assert!(bank.state.lock().unwrap().stack.iter().all(Option::is_none));
}
fn costs(){
 let waker=std::task::Waker::noop();
 let before=ALLOCATIONS.load(std::sync::atomic::Ordering::SeqCst);
 for _ in 0..100{let bank=std::hint::black_box(DeferredTurns::<N>::new());bank.request(4,2,waker);bank.before_poll(2);bank.suspended(2);bank.after_poll(2,false,waker);assert!(bank.finish_request(4));}
 assert_eq!(ALLOCATIONS.load(std::sync::atomic::Ordering::SeqCst)-before,0);
 println!("LAYOUT:bank={},frame={}",std::mem::size_of::<DeferredTurns<N>>(),std::mem::size_of::<DeferredTurn>());
}
#[tokio::main(flavor="current_thread")]
async fn main(){
 tokio::time::timeout(std::time::Duration::from_secs(2),async{
 scenario(false,false).await;scenario(true,false).await;scenario(false,true).await;nested_driver().await;acknowledgement_isolation();costs();
 cancellation(false).await;cancellation(true).await;
 simple("reversed-registration").await;simple("waiter-yields").await;simple("interrupt-next-waiter").await;
 let bank=DeferredTurns::<N>::new();let waker=std::task::Waker::noop();
 for _ in 0..100{bank.request(4,2,waker);assert!(bank.permits(1,|selected,ancestor|selected==2&&ancestor==1));assert!(!bank.permits(3,|_,_|false));
 bank.before_poll(1);bank.after_poll(1,false,waker);assert_eq!(bank.priority(),Some(2));
 bank.before_poll(2);bank.suspended(2);bank.after_poll(2,false,waker);assert_eq!(bank.priority(),Some(4));assert!(bank.finish_request(4));assert!(bank.take_changed());assert!(!bank.take_changed());assert!(bank.state.lock().unwrap().stack.iter().all(Option::is_none));assert_eq!(bank.state.lock().unwrap().depth,0);}
 let state=Deferred::new();
 for _ in 0..100{let mut future=std::pin::pin!(state.wait(&bank,1));let mut cx=Context::from_waker(waker);assert!(future.as_mut().poll(&mut cx).is_pending());}
 assert!(state.0.state.lock().unwrap().slots.iter().all(Option::is_none));
 println!("kernel passed");
 }).await.expect("Real executor wake progress");
}
`;

test(
  "bounded turn kernel preserves nested prefixes and actual executor wake/cancellation",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "reffect-turn-kernel-"));
    try {
      await writeFile(
        join(directory, "main.rs"),
        `${deferredTurnRuntime()}
${deferredStateRuntime()}
${harness}`,
      );
      await writeFile(
        join(directory, "Cargo.toml"),
        `[package]
name = "reffect_turn_kernel"
version = "0.1.0"
edition = "2021"
[[bin]]
name = "kernel"
path = "main.rs"
[dependencies]
tokio = { version = "=1.53.1", features = ["rt", "macros", "sync", "time"] }
`,
      );
      const result = await execute("cargo", ["run", "--offline", "--quiet"], {
        cwd: directory,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0" },
      });
      const release = await execute("cargo", ["run", "--release", "--offline", "--quiet"], {
        cwd: directory,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, CARGO_INCREMENTAL: "0", CARGO_PROFILE_RELEASE_DEBUG: "0" },
      });
      expect(release.stdout).toEqual(result.stdout);
      expect(result.stdout).toContain("kernel passed");
      for (const scenario of [
        "nested-completion",
        "nested-waiter-yields",
        "interrupt-producer",
        "interrupt-masked-producer",
        "reversed-registration",
        "waiter-yields",
        "interrupt-next-waiter",
      ] as const) {
        const official = await Effect.runPromise(deferredTurnOracle(scenario));
        const line = result.stdout.split("\n").find((item) => item.startsWith(`CASE:${scenario}:`));
        expect(line).toBeDefined();
        const native = JSON.parse(line!.slice(`CASE:${scenario}:`.length));
        expect(native).toEqual(deferredTurnExpected[scenario]);
        expect(native).toEqual(official.trace);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(0) * 2,
);
