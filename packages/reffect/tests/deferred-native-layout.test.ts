import { Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { R, Rust, FailureFrames, SourceArtifacts } from "../src/index.ts";
import type { Computation } from "../src/index.ts";
import { DeferredIR as D } from "../src/deferred.ts";
import { analyzeGeneratedDeferredProfile } from "../src/deferred-generated-profile.ts";
import { analyzeGeneratedDeferredGrowth } from "../src/deferred-growth.ts";
import { analyzeDeferredBudget, defaultDeferredBudgetContext } from "../src/deferred-budget.ts";
import { generatedDeferredFutureLayoutPointers } from "../src/deferred-layout.ts";
import { emitFunctions, lowerDeferredFunctions, lowerFunctions } from "../src/lower.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const execute = promisify(execFile);
const LogMessage = Schema.Struct({ message: Schema.String });
const selected = new Map(Rust.std.implementations.map((i) => [i.operation.ref, i]));
const small = R.fn([], R.Unit, R.Never, () =>
  R.Log.info("layout:source").pipe(
    R.Effect.andThen(
      D.make(R.Unit).pipe(
        R.Effect.flatMap((cell) =>
          D.succeed(cell, R.Unit.literal()).pipe(R.Effect.andThen(D.await(cell))),
        ),
      ),
    ),
    R.Effect.ensuring(R.Log.info("layout:cleanup")),
  ),
);
const oversized = R.fn([], R.Unit, R.Never, () =>
  D.make(R.Unit).pipe(
    R.Effect.flatMap((cell) => {
      let waiter: Computation<void> = D.await(cell);
      for (let i = 0; i < 40; i++) waiter = waiter.pipe(R.Effect.map((v) => v));
      return R.Effect.all([R.Effect.race(waiter, R.Effect.void), waiter, waiter], {
        concurrency: "unbounded",
        discard: true,
      });
    }),
  ),
);

test("native layout limits add a distinct build gate to structurally admitted graphs", () => {
  expect(analyzeGeneratedDeferredProfile(R.program({ work: oversized })).has(oversized)).toBe(true);
  expect(analyzeGeneratedDeferredGrowth(oversized).computationDepth).toBe(50);
  expect(analyzeDeferredBudget(oversized, "body", defaultDeferredBudgetContext, true).framed).toBe(
    1136,
  );
  const ordinary = R.program({
    pure: R.fn([], R.Unit, () => R.Unit.literal()),
    delay: R.fn([], R.Unit, R.Never, () => R.Effect.sleep(1)),
  });
  const source = emitFunctions(lowerFunctions(ordinary, selected)).files["src/lib.rs"];
  expect(source).not.toContain("assert_deferred_future_layout");
  expect(source).not.toContain("reffect_deferred_future_layouts");
  expect(source).toContain("pub async fn r_delay");
});

test("wrapped Deferred roots preserve UTF-8 mapped bodies and attribute layout calls", () => {
  const mapping = R.fn([], R.Unit, R.Never, () =>
    R.Log.info("layout:😀").pipe(R.Effect.andThen(small.body)),
  );
  const module = lowerDeferredFunctions(
    R.program({ work: mapping }),
    selected,
    SourceArtifacts.Full,
  );
  const emitted = emitFunctions(module);
  expect(emitted.files["src/main.rs"]).not.toContain("reffect_deferred_future_layouts");
  const source = Buffer.from(emitted.files["src/lib.rs"]);
  expect(source.toString("utf8")).toContain("😀");
  const ranges = emitted.ranges;
  const mapped = ranges.map((r) => ({
    ...r,
    text: source.subarray(r.start, r.end).toString("utf8"),
  }));
  expect(
    mapped.some(
      (r) =>
        r.text === "let _layout = assert_deferred_future_layout(&future);" &&
        r.origin === module.functions[0].origin &&
        r.role === "use",
    ),
  ).toBe(true);
  expect(mapped.some((r) => r.text.includes("h_work_") && r.occurrence !== undefined)).toBe(true);
  for (const range of ranges) {
    expect(range.start).toBeLessThan(range.end);
    expect(range.end).toBeLessThanOrEqual(source.length);
    expect(source.subarray(range.start, range.end).toString("utf8")).not.toContain("\uFFFD");
  }
  const none = emitFunctions(
    lowerDeferredFunctions(
      R.program({ work: small }),
      selected,
      SourceArtifacts.None,
      FailureFrames.None,
    ),
  );
  expect(none.ranges).toEqual([]);
  expect(none.files["src/lib.rs"]).toContain("REFFECT_DEFERRED_FUTURE_LAYOUT");
});

const fixture = (extra: number) => `
struct LayoutFixture([u8; ${generatedDeferredFutureLayoutPointers} * std::mem::size_of::<usize>() + ${extra}]);
impl std::future::Future for LayoutFixture {
 type Output=();
 fn poll(self:std::pin::Pin<&mut Self>,_:&mut std::task::Context<'_>)->std::task::Poll<()> {std::task::Poll::Pending}
}
// Export deliberately never called: code generation must still check this constructor.
pub fn layout_fixture() -> impl std::future::Future<Output=()> {
 let future=LayoutFixture([0;${generatedDeferredFutureLayoutPointers} * std::mem::size_of::<usize>() + ${extra}]);
 let _layout = assert_deferred_future_layout(&future);
 future
}
`;
const harness = (bounded: boolean) => `#![recursion_limit="256"]
use reffect_generated as r;
use std::sync::atomic::{AtomicBool,AtomicUsize,Ordering};
struct Meter;
static METER_ON:AtomicBool=AtomicBool::new(false);
static ALLOCATIONS:AtomicUsize=AtomicUsize::new(0);
#[global_allocator] static ALLOCATOR:Meter=Meter;
unsafe impl std::alloc::GlobalAlloc for Meter {
 unsafe fn alloc(&self,layout:std::alloc::Layout)->*mut u8 {
  if METER_ON.load(Ordering::Relaxed) {ALLOCATIONS.fetch_add(1,Ordering::Relaxed);}
  std::alloc::System.alloc(layout)
 }
 unsafe fn dealloc(&self,pointer:*mut u8,layout:std::alloc::Layout) {std::alloc::System.dealloc(pointer,layout)}
}
#[tokio::main(flavor="current_thread")]
async fn main() {
 let(sender,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 ${bounded ? "r::seed_frames(&mut ctx);" : ""}
 ALLOCATIONS.store(0,Ordering::Relaxed);METER_ON.store(true,Ordering::Relaxed);
 let future=r::r_work(&mut ctx);
 assert!(std::mem::size_of_val(&future)<=${generatedDeferredFutureLayoutPointers}*std::mem::size_of::<usize>());
 drop(future);
 METER_ON.store(false,Ordering::Relaxed);
 assert_eq!(ALLOCATIONS.load(Ordering::Relaxed),0);
 ${bounded ? 'assert_eq!(ctx.take_frames(),(vec!["sentinel"],0));' : ""}
 sender.send(true).unwrap();
 ${bounded ? "r::seed_frames(&mut ctx);" : ""}
 drop(r::r_work(&mut ctx));
 ${bounded ? 'assert_eq!(ctx.take_frames(),(vec!["sentinel"],0));' : ""}
 assert!(matches!(r::r_work(&mut ctx).await,Err(r::AsyncError::Interrupted)));
 sender.send(false).unwrap();
 let mut ctx=r::AsyncContext::new(sender.subscribe());
 assert!(r::r_work(&mut ctx).await.is_ok());
 println!("inert=0");
}
`;

test(
  "native exact-root layout rejects excess storage while construction and drop stay inert",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "reffect-deferred-layout-"));
    try {
      for (const policy of [FailureFrames.None, FailureFrames.Bounded]) {
        const root = join(directory, policy._tag);
        const bounded = policy._tag === "Bounded";
        const emitted = emitFunctions(
          lowerDeferredFunctions(
            R.program({ work: small, again: small }),
            selected,
            SourceArtifacts.None,
            policy,
          ),
        );
        for (const [path, contents] of Object.entries(emitted.files)) {
          await mkdir(dirname(join(root, path)), { recursive: true });
          await writeFile(join(root, path), contents);
        }
        const seed = bounded
          ? '\npub fn seed_frames(ctx:&mut AsyncContext) {ctx.frames=Some(FrameTrail::new("sentinel"));}\n'
          : "";
        const library = emitted.files["src/lib.rs"] + seed;
        await writeFile(join(root, "src/lib.rs"), library + fixture(0));
        await writeFile(join(root, "src/main.rs"), harness(bounded));
        const cargo = (args: readonly string[]) =>
          execute("cargo", [...args, "--offline", "--quiet"], {
            cwd: root,
            timeout: 180000,
            env: { ...process.env, CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0" },
          });
        const rejects = async (profile: "debug" | "release") => {
          let failure = "";
          try {
            await cargo(["build", "--lib", ...(profile === "release" ? ["--release"] : [])]);
          } catch (error) {
            failure = String(error);
          }
          process.stdout.write(
            `layout refusal ${policy._tag}/${profile}: ${failure ? "failed" : "unexpected success"}\n`,
          );
          expect(failure).toContain("E0080");
          expect(failure).toContain("REFFECT_DEFERRED_FUTURE_LAYOUT");
        };
        for (const profile of ["debug", "release"] as const) {
          await cargo(["build", ...(profile === "release" ? ["--release"] : [])]);
          const run = await execute(join(root, "target", profile, "reffect_generated"), [], {
            cwd: root,
            timeout: 15000,
          });
          expect(run.stdout.trim()).toBe("inert=0");
          const messages = run.stderr
            .trim()
            .split("\n")
            .map((line) => Schema.decodeUnknownSync(LogMessage)(JSON.parse(line)).message);
          expect(messages).toEqual(["layout:source", "layout:cleanup"]);
        }
        process.stdout.write(`layout exact-boundary ${policy._tag}\n`);
        await writeFile(join(root, "src/lib.rs"), library + fixture(1));
        // Type checking accepts the oversized concrete future; native codegen must reject it.
        await cargo(["check", "--lib"]);
        await rejects("debug");
        await rejects("release");
        process.stdout.write(`layout actual-root ${policy._tag}\n`);
        const excess = emitFunctions(
          lowerDeferredFunctions(
            R.program({ work: oversized }),
            selected,
            SourceArtifacts.None,
            policy,
          ),
        ).files["src/lib.rs"];
        await writeFile(join(root, "src/lib.rs"), excess);
        await writeFile(join(root, "src/main.rs"), "fn main(){}\n");
        await cargo(["check", "--lib"]);
        await rejects("debug");
        await rejects("release");
        // Prove the real authored workload is otherwise buildable with this toolchain/profile.
        await writeFile(
          join(root, "src/lib.rs"),
          excess.replace(
            `assert!(std::mem::size_of::<F>() <= ${generatedDeferredFutureLayoutPointers} * std::mem::size_of::<usize>(), "REFFECT_DEFERRED_FUTURE_LAYOUT");`,
            "",
          ),
        );
        await cargo(["build", "--lib"]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(0) + 300000,
);
