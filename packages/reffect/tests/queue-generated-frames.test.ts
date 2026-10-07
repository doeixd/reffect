import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Cause, Exit } from "effect";
import { expect, test } from "vite-plus/test";
import { FailureFrames, R, Rust, SourceArtifacts } from "../src/index.ts";
import type { Computation } from "../src/effect-ir.ts";
import { QueueExecution } from "../src/queue-execution.ts";
import { QueueIR as Q } from "../src/queue.ts";
import { emitFunctions, lowerQueueFunctions } from "../src/lower.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const selected = new Map(Rust.std.implementations.map((item) => [item.operation.ref, item]));
const all = (left: Computation<void>, right: Computation<void>) =>
  R.Effect.all([left, right], { concurrency: "unbounded", discard: true });
const maps = (body: Computation<void>, depth: number) => {
  for (let i = 0; i < depth; i++) body = body.pipe(R.Effect.asVoid);
  return body;
};
const waiting = (depth = 0, wrapped = false) =>
  R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Unit, 1).pipe(
      R.Effect.flatMap((owner) => {
        const shared = Q.take(owner);
        const group = all(shared, shared);
        return wrapped ? R.Effect.void.pipe(R.Effect.andThen(maps(group, 1))) : maps(group, depth);
      }),
    ),
  );
const functions = {
  take: waiting(),
  offer: R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Unit, 1).pipe(
      R.Effect.flatMap((owner) =>
        all(
          Q.offer(owner, R.Unit.literal()).pipe(
            R.Effect.andThen(R.Log.info("full")),
            R.Effect.andThen(Q.offer(owner, R.Unit.literal())),
            R.Effect.asVoid,
          ),
          R.Effect.void,
        ),
      ),
    ),
  ),
  wrapped: waiting(0, true),
  deep: waiting(35),
  success: R.fn([], R.Unit, R.Never, () =>
    Q.bounded(R.Unit, 1).pipe(
      R.Effect.flatMap((owner) =>
        all(Q.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid), Q.take(owner)),
      ),
    ),
  ),
};
type Scenario = keyof typeof functions;
type PathKind = readonly [string, string];
// Expectations come from authored topology, independently of either evaluator/lowerer.
const expected = (name: Scenario): { frames: readonly PathKind[]; omitted: number } => {
  const base = `functions.${name}`;
  if (name === "success") return { frames: [], omitted: 0 };
  const parents: PathKind[] = [
    [`${base}.body`, "queueScope"],
    [base, "function"],
  ];
  if (name === "wrapped")
    return {
      frames: [
        [`${base}.body.body.body.source`, "all"],
        [`${base}.body.body.body`, "map"],
        [`${base}.body.body`, "flatMap"],
        ...parents,
      ],
      omitted: 0,
    };
  if (name === "deep") {
    const spine: PathKind[] = [[`${base}.body.body${".source".repeat(35)}`, "all"]];
    for (let depth = 34; depth >= 0; depth--)
      spine.push([`${base}.body.body${".source".repeat(depth)}`, "map"]);
    spine.push(...parents);
    return { frames: spine.slice(0, 32), omitted: spine.length - 32 };
  }
  return { frames: [[`${base}.body.body`, "all"], ...parents], omitted: 0 };
};

test("owned Queue interruption trails match explicit parent topology and truncate once", async () => {
  for (const [name, fn] of Object.entries(functions)) {
    const controller = new AbortController();
    const pending = QueueExecution.runWithFrames(fn, { signal: controller.signal });
    if (name !== "success") controller.abort();
    const observation = await pending;
    expect(Exit.isSuccess(observation.exit)).toBe(true);
    if (!Exit.isSuccess(observation.exit)) throw new Error("Expected framed observation");
    const framed = observation.exit.value;
    expect({
      frames: framed.frames.map(({ path, kind }) => [
        path.replace("functions.work", `functions.${name}`),
        kind,
      ]),
      omitted: framed.omitted,
    }).toEqual(expected(name as Scenario));
    expect(observation.logs).toEqual(name === "offer" ? ["full"] : []);
    if (name === "success") expect(framed.exit).toEqual(Exit.succeed(undefined));
    else
      expect(Exit.isFailure(framed.exit) && Cause.hasInterruptsOnly(framed.exit.cause)).toBe(true);
  }
});

const allocator = String.raw`
use std::sync::atomic::{AtomicBool,AtomicUsize,Ordering};
struct Allocator;
static TRACK:AtomicBool=AtomicBool::new(false);static ALLOCATIONS:AtomicUsize=AtomicUsize::new(0);
unsafe impl std::alloc::GlobalAlloc for Allocator {
 unsafe fn alloc(&self,l:std::alloc::Layout)->*mut u8{if TRACK.load(Ordering::Relaxed){ALLOCATIONS.fetch_add(1,Ordering::Relaxed);}unsafe{std::alloc::System.alloc(l)}}
 unsafe fn dealloc(&self,p:*mut u8,l:std::alloc::Layout){unsafe{std::alloc::System.dealloc(p,l)}}
 unsafe fn realloc(&self,p:*mut u8,l:std::alloc::Layout,n:usize)->*mut u8{if TRACK.load(Ordering::Relaxed){ALLOCATIONS.fetch_add(1,Ordering::Relaxed);}unsafe{std::alloc::System.realloc(p,l,n)}}
}
#[global_allocator]static ALLOCATOR:Allocator=Allocator;
fn begin(){ALLOCATIONS.store(0,Ordering::Relaxed);TRACK.store(true,Ordering::Relaxed);}
fn end()->usize{TRACK.store(false,Ordering::Relaxed);ALLOCATIONS.load(Ordering::Relaxed)}
async fn once<F:std::future::Future>(mut future:std::pin::Pin<&mut F>){std::future::poll_fn(|cx|{assert!(future.as_mut().poll(cx).is_pending());std::task::Poll::Ready(())}).await;}
async fn bounded<F:std::future::Future>(future:F)->F::Output{tokio::select!{biased;
 _=tokio::time::sleep(std::time::Duration::from_secs(2))=>panic!("Queue frame workload must settle"),result=future=>result,
}}
`;
const harness = (boundedFrames: boolean) => {
  const check = (name: Scenario, preabort = false) => {
    const observation = preabort
      ? { frames: [[`functions.${name}`, "function"]] as readonly PathKind[], omitted: 0 }
      : expected(name);
    if (!boundedFrames) return "";
    return `{
 let(frames,omitted)=ctx.take_frames();assert_eq!(omitted,${observation.omitted});
 assert_eq!(frames.len(),${observation.frames.length},"frame trail length for ${name}");
 ${observation.frames.map(([path, kind], i) => `assert!(frames[${i}].contains(${JSON.stringify(`"path":"${path}"`)}),"frame trail path for ${name}: {:?}",frames);assert!(frames[${i}].contains(${JSON.stringify(`"kind":"${kind}"`)}),"frame trail kind for ${name}: {:?}",frames);`).join("\n")}
 assert!(ctx.take_frames().0.is_empty());assert_eq!(ctx.take_frames().1,0);
 }`;
  };
  return `use reffect_generated as r;\n${allocator}
#[tokio::main(flavor="current_thread")]
async fn main(){
 ${(["take", "offer", "wrapped", "deep"] as const)
   .map(
     (name) => `{
 let(cancel,receiver)=tokio::sync::watch::channel(false);let mut ctx=r::AsyncContext::new(receiver);
 {let future=r::r_${name}(&mut ctx);tokio::pin!(future);once(future.as_mut()).await;cancel.send(true).unwrap();assert!(matches!(bounded(future).await,Err(r::AsyncError::Interrupted)));}
 ${check(name)}
 assert!(bounded(r::r_success(&mut ctx)).await.is_err());
 ${check("success", true)}
 }`,
   )
   .join("\n")}
 {
 let(cancel,receiver)=tokio::sync::watch::channel(false);let mut ctx=r::AsyncContext::new(receiver);
 {let future=r::r_take(&mut ctx);tokio::pin!(future);once(future.as_mut()).await;cancel.send(true).unwrap();assert!(matches!(bounded(future).await,Err(r::AsyncError::Interrupted)));}
 cancel.send(false).unwrap();assert!(bounded(r::r_success(&mut ctx)).await.is_ok());${check("success")}
 let layouts=r::reffect_queue_future_layouts(&mut ctx);
 begin();for _ in 0..100{let future=r::r_success(&mut ctx);std::hint::black_box(&future);drop(future);}let construction=end();
 begin();for _ in 0..100{assert!(r::r_success(&mut ctx).await.is_ok());}let execution=end();
 ${check("success")}
 let(cancel,receiver)=tokio::sync::watch::channel(false);let mut ctx=r::AsyncContext::new(receiver);
 begin();{let future=r::r_take(&mut ctx);tokio::pin!(future);once(future.as_mut()).await;cancel.send(true).unwrap();assert!(matches!(future.await,Err(r::AsyncError::Interrupted)));}let cancellation=end();
 assert_eq!((construction,execution,cancellation),(0,0,${boundedFrames ? 3 : 0}));${check("take")}
 println!("COST construction={} execution={} cancellation={} layouts={:?}",construction,execution,cancellation,layouts);
 }
 println!("queue-frames-ok");
}
`;
};

test.each([FailureFrames.None, FailureFrames.Bounded])(
  "generated Queue frames preserve interruption, bounded trails and costs ($_tag)",
  async (policy) => {
    const capture = !FailureFrames.isNone(policy);
    const directory = await mkdtemp(join(tmpdir(), "reffect-queue-frames-"));
    const run = promisify(execFile);
    const emitted = emitFunctions(
      lowerQueueFunctions(
        R.program({
          ...functions,
          ordinary: R.fn([], R.Unit, R.U64, () =>
            R.Effect.all(
              [R.Effect.fail(R.U64.literal(7n)).pipe(R.Effect.asVoid), R.Effect.sleep(1)],
              { concurrency: "unbounded", discard: true },
            ),
          ),
        }),
        selected,
        SourceArtifacts.None,
        policy,
      ),
    );
    try {
      for (const [path, contents] of Object.entries(emitted.files)) {
        await mkdir(dirname(join(directory, path)), { recursive: true });
        await writeFile(join(directory, path), contents);
      }
      const queryAllowance = emitted.files["src/main.rs"]!.match(
        /^#!\[recursion_limit = "256"\]/,
      )?.[0];
      expect(queryAllowance).toBeDefined();
      await writeFile(join(directory, "src/main.rs"), `${queryAllowance}\n${harness(capture)}`);
      const env = {
        ...process.env,
        CARGO_PROFILE_DEV_DEBUG: "0",
        CARGO_INCREMENTAL: "0",
        CARGO_BUILD_JOBS: "1",
      };
      for (const mode of [[], ["--release"]]) {
        const result = await run("cargo", ["run", "--offline", "--quiet", ...mode], {
          cwd: directory,
          timeout: 180000,
          maxBuffer: 8 * 1024 * 1024,
          env,
        });
        expect(result.stdout).toContain("queue-frames-ok");
        const logs = result.stderr
          .split("\n")
          .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
          .map((line) => JSON.parse(line).message);
        expect(logs).toEqual(["full"]);
        process.stdout.write(
          `Queue frames ${policy._tag} ${mode.length ? "release" : "debug"}: ${result.stdout.trim()}\n`,
        );
      }
      if (capture) {
        const source = emitted.files["src/lib.rs"]!;
        const marker = '"kind\\":\\"all\\"';
        expect(source).toContain(marker);
        await writeFile(
          join(directory, "src/lib.rs"),
          source.replaceAll(marker, '"kind\\":\\"map\\"'),
        );
        let failure: unknown;
        try {
          await run("cargo", ["run", "--offline", "--quiet"], {
            cwd: directory,
            timeout: 180000,
            maxBuffer: 8 * 1024 * 1024,
            env,
          });
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({ stderr: expect.stringContaining("frame trail kind") });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(360000),
);
