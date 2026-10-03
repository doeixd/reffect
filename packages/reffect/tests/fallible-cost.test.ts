import { Effect, FileSystem } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, Compile, FailureFrames, R, Rust, SourceArtifacts } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const probe = R.fn([], R.Unit, R.U64, () =>
  R.Effect.all([R.Effect.fail(R.U64.literal(7n)), R.Effect.void], {
    concurrency: "unbounded",
    discard: true,
  }),
);
const allocationProbe = (frames: boolean) => `
use reffect_generated as r;
use std::alloc::{GlobalAlloc,Layout,System};
use std::sync::atomic::{AtomicUsize,Ordering};
static ALLOCS:AtomicUsize=AtomicUsize::new(0);
static LIVE:AtomicUsize=AtomicUsize::new(0);
struct Counting;
unsafe impl GlobalAlloc for Counting {
 unsafe fn alloc(&self,l:Layout)->*mut u8{let p=System.alloc(l);if !p.is_null(){ALLOCS.fetch_add(1,Ordering::SeqCst);LIVE.fetch_add(1,Ordering::SeqCst);}p}
 unsafe fn dealloc(&self,p:*mut u8,l:Layout){LIVE.fetch_sub(1,Ordering::SeqCst);System.dealloc(p,l)}
 unsafe fn realloc(&self,p:*mut u8,l:Layout,n:usize)->*mut u8{let p=System.realloc(p,l,n);if !p.is_null(){ALLOCS.fetch_add(1,Ordering::SeqCst);}p}
}
#[global_allocator]static A:Counting=Counting;
#[tokio::main(flavor="current_thread")]
async fn main(){
 let (_sender,receiver)=tokio::sync::watch::channel(false);
 let before=ALLOCS.load(Ordering::SeqCst);
 let mut ctx=r::AsyncContext::new(receiver);
 let context_allocations=ALLOCS.load(Ordering::SeqCst)-before;
 let context_bytes=std::mem::size_of_val(&ctx);
 let before=ALLOCS.load(Ordering::SeqCst);
 let future_bytes={let future=r::r_probe(&mut ctx);std::mem::size_of_val(&future)};
 let unpolled_allocations=ALLOCS.load(Ordering::SeqCst)-before;
 let before=ALLOCS.load(Ordering::SeqCst);
 for _ in 0..100 {
   let cause=r::RuntimeCause{interrupted:false,failures:[Some(r::RuntimeFailure::U64(7)),None,None],len:1};
   std::hint::black_box(cause);
 }
 let cause_allocations=ALLOCS.load(Ordering::SeqCst)-before;
 let before=ALLOCS.load(Ordering::SeqCst);let live=LIVE.load(Ordering::SeqCst);
 for _ in 0..100 {
   match r::r_probe(&mut ctx).await {
     Err(r::AsyncError::Combined(cause)) => {
       assert!(!cause.interrupted);assert_eq!(cause.len,1);
       assert_eq!(cause.first(),Some(r::RuntimeFailure::U64(7)));
     }
     other => panic!("Expected preserved scalar Cause, got {:?}",other),
   }
 }
 drop(ctx);
 let execution_allocations=ALLOCS.load(Ordering::SeqCst)-before;
 let retained=LIVE.load(Ordering::SeqCst) as isize-live as isize;
 assert_eq!(context_allocations,0);assert_eq!(unpolled_allocations,0);assert_eq!(cause_allocations,0);assert_eq!(retained,0);
 ${frames ? "" : 'assert_eq!(execution_allocations,200,"quiet fallible two-child execution allocates only the two child watch channels");'}
 println!("cost:context={},future={},failure={},cause={},error={},context_allocations={},unpolled_allocations={},cause_allocations={},groups=100,execution_allocations={},retained={}",context_bytes,future_bytes,std::mem::size_of::<r::RuntimeFailure>(),std::mem::size_of::<r::RuntimeCause>(),std::mem::size_of::<r::AsyncError<u64>>(),context_allocations,unpolled_allocations,cause_allocations,execution_allocations,retained);
}
`;
test(
  "fallible causes stay inline and disabled frames add no execution allocations beyond task setup",
  async () => {
    const measurements: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-fallible-cost-" });
          const infallible = R.fn([], R.Unit, R.Never, () =>
            R.Effect.all([R.Effect.void, R.Effect.void], {
              concurrency: "unbounded",
              discard: true,
            }),
          );
          const legacy = yield* Compile.make(R.program({ infallible })).pipe(
            Compile.withTarget(Rust.tokio),
            Compile.withFailureFrames(FailureFrames.None),
            Compile.withSourceArtifacts(SourceArtifacts.None),
            Compile.run,
          );
          expect(legacy.files["src/lib.rs"]).toContain(
            "pub enum AsyncError<E> { Fail(E), Interrupted }",
          );
          expect(legacy.files["src/lib.rs"]).not.toMatch(
            /RuntimeCause|RuntimeFailure|Combined|TaskFailure/,
          );
          for (const frames of [FailureFrames.None, FailureFrames.Bounded]) {
            const artifact = yield* Compile.make(R.program({ probe })).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withFailureFrames(frames),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.run,
            );
            const library = artifact.files["src/lib.rs"];
            expect(library).toContain("Combined(RuntimeCause)");
            expect(library).not.toContain("tokio::spawn");
            if (frames._tag === "None") expect(library).not.toContain("Box<FrameTrail>");
            const directory = yield* CargoApi.write(artifact, `${parent}/${frames._tag}`);
            yield* fs.writeFileString(
              `${directory}/src/main.rs`,
              allocationProbe(frames._tag !== "None"),
            );
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              const result = yield* CargoApi.run(directory, "probe", [], profile);
              expect(result.stdout).toContain("cause_allocations=0");
              expect(result.stdout).toContain("retained=0");
              measurements.push(
                `${frames._tag}/${profile}: RustBytes=${Buffer.byteLength(library)}, ${result.stdout.trim()}`,
              );
            }
          }
          const path = process.env.REFFECT_FALLIBLE_MEASUREMENTS;
          if (path) yield* fs.writeFileString(path, measurements.join("\n") + "\n");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 180000,
);
