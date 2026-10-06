import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nativeTestBudget } from "./native-test-budget.ts";
import { expect, test } from "vite-plus/test";
import { R, Rust, SourceArtifacts, FailureFrames } from "../src/index.ts";
import { SemaphoreIR as S } from "../src/semaphore.ts";
import { DeferredIR as D } from "../src/deferred.ts";
import { emitFunctions, lowerSemaphoreFunctions } from "../src/lower.ts";
import { analyzeGeneratedSemaphoreProfile } from "../src/semaphore-generated-profile.ts";

const selected = new Map(Rust.std.implementations.map((i) => [i.operation.ref, i]));
const work = R.fn([], R.Unit, R.Never, () =>
  S.make(1).pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.succeed(R.U64.literal(7n)).pipe(
        R.Effect.flatMap((value) =>
          R.Effect.all(
            [
              S.withPermit(owner)(R.Effect.sleep(1).pipe(R.Effect.ensuring(R.Effect.sleep(1)))),
              S.withPermit(owner)(R.Effect.succeed(value).pipe(R.Effect.asVoid)),
            ],
            { concurrency: "unbounded", discard: true },
          ),
        ),
      ),
    ),
  ),
);

test("Semaphore lowering borrows owner and scalar captures and marks every wait", () => {
  const program = R.program({ work });
  const profile = analyzeGeneratedSemaphoreProfile(program).get(work)!;
  const module = lowerSemaphoreFunctions(program, selected);
  const emitted = emitFunctions(module);
  const source = emitted.files["src/lib.rs"];
  expect(source).toContain("pub fn r_work");
  expect(source).toContain(
    "impl std::future::Future<Output = Result<(), AsyncError<std::convert::Infallible>>> + '_",
  );
  expect(source).toContain("let _layout = assert_semaphore_future_layout(&future);");
  expect(source).toContain("reffect_semaphore_future_layouts");
  expect(source).toContain("ScanTasks::<3>::new()");
  expect(source).toContain("&ScanSemaphore<3>");
  expect(source).toContain("scan_all2(");
  expect(source).not.toContain("scan_join2(");
  expect(source).toContain("task.acquire(");
  expect(source).toContain("task.semantic(ctx.sleep(1u64)).await");
  expect(source).toContain("; drop(permit); match result");
  expect(source).toContain("Ok(()) => true");
  expect(source).toContain("AsyncError::Interrupted, _frames)) => false");
  expect(source).toContain(`for _ in 0..${profile.driver.protocolRetries}`);
  expect(source).toContain(`scans <= ${profile.driver.scans}`);
  expect(source).toContain(`rounds <= ${profile.driver.settlementRounds}`);
  expect(source).not.toContain("scans <= 64");
  const bytes = Buffer.from(source);
  expect(
    emitted.ranges.some(
      (range) =>
        bytes.subarray(range.start, range.end).toString() ===
          "let _layout = assert_semaphore_future_layout(&future);" && range.role === "use",
    ),
  ).toBe(true);
});

test("Semaphore roots independently disable source artifacts and failure frames", () => {
  const emitted = emitFunctions(
    lowerSemaphoreFunctions(
      R.program({ work }),
      selected,
      SourceArtifacts.None,
      FailureFrames.None,
    ),
  );
  expect(emitted.ranges).toEqual([]);
  expect(emitted.files["src/lib.rs"]).not.toContain("FrameTrail");
  expect(emitted.files["src/lib.rs"]).toContain("Err(AsyncError::Interrupted) => false");
  expect(emitted.files["src/lib.rs"]).toContain("assert_semaphore_future_layout");
});

test("independent ordinary and Deferred functions retain their own module drivers", () => {
  const program = R.program({
    work,
    ordinary: R.fn([], R.Unit, R.Never, () => R.Effect.sleep(1)),
    deferred: R.fn([], R.Unit, R.Never, () =>
      D.make(R.Unit).pipe(
        R.Effect.flatMap((cell) =>
          D.succeed(cell, R.Unit.literal()).pipe(R.Effect.andThen(D.await(cell))),
        ),
      ),
    ),
  });
  const source = emitFunctions(lowerSemaphoreFunctions(program, selected)).files["src/lib.rs"];
  expect(source).toContain("pub async fn r_ordinary");
  expect(source).toContain("pub fn r_deferred");
  expect(source).toContain("assert_deferred_future_layout");
  expect(source).toContain("DeferredTurns::<1>::new()");
  expect(source).toContain("scan_all2(");
});

test("an All without acquisitions still captures the lexical driver owner", () => {
  const fn = R.fn([], R.Unit, R.Never, () =>
    S.make(1).pipe(
      R.Effect.flatMap(() =>
        R.Effect.all([R.Effect.sleep(1), R.Effect.void], {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    ),
  );
  const source = emitFunctions(lowerSemaphoreFunctions(R.program({ work: fn }), selected)).files[
    "src/lib.rs"
  ];
  expect(source).toContain("scan_all2(semaphore");
  expect(source).toContain("&ScanSemaphore<3>");
});

const execute = promisify(execFile);
test(
  "actual generated Semaphore futures contend, cancel, and retain scalar results",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "reffect-semaphore-generated-"));
    const scalar = R.fn([], R.U64, R.Never, () =>
      S.make(1).pipe(
        R.Effect.flatMap((owner) => S.withPermit(owner)(R.Effect.succeed(R.U64.literal(23n)))),
      ),
    );
    const quiet = R.fn([], R.Unit, R.Never, () =>
      S.make(1).pipe(
        R.Effect.flatMap((owner) =>
          R.Effect.all([S.withPermit(owner)(R.Effect.void), S.withPermit(owner)(R.Effect.void)], {
            concurrency: "unbounded",
            discard: true,
          }),
        ),
      ),
    );
    const cancel = R.fn([], R.Unit, R.Never, () =>
      S.make(1).pipe(
        R.Effect.flatMap((owner) =>
          R.Effect.all(
            [
              S.withPermit(owner)(
                R.Effect.sleep(100).pipe(
                  R.Effect.ensuring(
                    R.Effect.sleep(2).pipe(R.Effect.andThen(R.Log.info("masked-cleanup"))),
                  ),
                ),
              ),
              S.withPermit(owner)(R.Log.info("queued-body")),
            ],
            { concurrency: "unbounded", discard: true },
          ),
        ),
      ),
    );
    try {
      const emitted = emitFunctions(
        lowerSemaphoreFunctions(
          R.program({ work, scalar, quiet, cancel }),
          selected,
          SourceArtifacts.None,
        ),
      );
      for (const [path, contents] of Object.entries(emitted.files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), contents);
      }
      await writeFile(
        join(root, "src/main.rs"),
        `
use reffect_generated as r;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
struct Counter;
static TRACK: AtomicBool = AtomicBool::new(false);
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
unsafe impl std::alloc::GlobalAlloc for Counter {
 unsafe fn alloc(&self, layout: std::alloc::Layout) -> *mut u8 {
  if TRACK.load(Ordering::Relaxed) { ALLOCATIONS.fetch_add(1, Ordering::Relaxed); }
  unsafe { std::alloc::System.alloc(layout) }
 }
 unsafe fn dealloc(&self, ptr: *mut u8, layout: std::alloc::Layout) {
  unsafe { std::alloc::System.dealloc(ptr, layout) }
 }
 unsafe fn realloc(&self, ptr: *mut u8, layout: std::alloc::Layout, size: usize) -> *mut u8 {
  if TRACK.load(Ordering::Relaxed) { ALLOCATIONS.fetch_add(1, Ordering::Relaxed); }
  unsafe { std::alloc::System.realloc(ptr, layout, size) }
 }
}
#[global_allocator] static ALLOCATOR: Counter = Counter;
#[tokio::main(flavor="current_thread")]
async fn main() {
 let(sender,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 let future=r::r_work(&mut ctx);
 assert!(std::mem::size_of_val(&future)<=2560*std::mem::size_of::<usize>());
 drop(future);
 assert!(r::r_work(&mut ctx).await.is_ok());
 assert_eq!(r::r_scalar(&mut ctx).await.unwrap(),23);
 assert!(r::r_quiet(&mut ctx).await.is_ok());
 TRACK.store(true, Ordering::Relaxed);
 for _ in 0..1000 { assert_eq!(r::r_scalar(&mut ctx).await.unwrap(),23); }
 TRACK.store(false, Ordering::Relaxed);
 assert_eq!(ALLOCATIONS.load(Ordering::Relaxed),0);
 TRACK.store(true, Ordering::Relaxed);
 for _ in 0..1000 { assert!(r::r_quiet(&mut ctx).await.is_ok()); }
 TRACK.store(false, Ordering::Relaxed);
 assert_eq!(ALLOCATIONS.load(Ordering::Relaxed),2000);
 println!("quiet-scalar-allocations=0 quiet-all2-allocations=2");
 println!("generated-layouts={:?}", r::reffect_semaphore_future_layouts(&mut ctx));
 assert!(r::reffect_semaphore_future_layouts(&mut ctx).iter().all(|bytes|*bytes>0));
 sender.send(true).unwrap();
 assert!(matches!(r::r_work(&mut ctx).await,Err(r::AsyncError::Interrupted)));
 let(frames,_)=ctx.take_frames();
 assert_eq!(frames.len(),1);
 assert!(frames[0].contains("function"));
 let(cancel,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 {
 let future=r::r_cancel(&mut ctx);
 tokio::pin!(future);
 tokio::select! { biased;
  result=future.as_mut()=>panic!("cancel workload completed before cancellation: {:?}",result),
  _=tokio::time::sleep(std::time::Duration::from_millis(1))=>{},
 }
 cancel.send(true).unwrap();
 assert!(matches!(future.await,Err(r::AsyncError::Interrupted)));
 }
 let(frames,omitted)=ctx.take_frames();
 assert_eq!(omitted,0);
 assert_eq!(frames.len(),3);
 assert!(frames[0].contains("all"));
 assert!(frames[1].contains("semaphoreScope"));
 assert!(frames[2].contains("function"));
 println!("smoke-ok");
}
`,
      );
      for (const mode of [[], ["--release"]]) {
        const result = await execute("cargo", ["run", "--offline", "--quiet", ...mode], {
          cwd: root,
          timeout: 180000,
          env: { ...process.env, CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0" },
        });
        const logs = result.stderr
          .split("\n")
          .filter((line) => line.startsWith('{"schema":"reffect.log@1"'));
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain("masked-cleanup");
        expect(logs[0]).not.toContain("queued-body");
        expect(result.stdout).toContain("smoke-ok");
        console.info(`Semaphore ${mode.length ? "release" : "debug"} ${result.stdout.trim()}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  nativeTestBudget(0) * 2,
);
