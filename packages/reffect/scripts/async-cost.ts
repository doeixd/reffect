import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { NodeServices } from "@effect/platform-node";
import { CargoApi, Compile, FailureFrames, R, Rust, SourceArtifacts } from "../src/index.ts";

const shared = (depth: number) =>
  R.fn([R.Bool], R.Unit, R.Never, (condition) => {
    let body = R.Effect.sleep(0);
    for (let i = 0; i < depth; i++) body = R.Match.bool(condition, body, body);
    return body;
  });
const delay = R.fn([], R.Unit, R.Never, () => R.Effect.sleep(0));
const shared4 = shared(4);
const shared8 = shared(8);
const scoped = R.fn([], R.Unit, R.Never, () =>
  R.Effect.sleep(0).pipe(
    R.Effect.ensuring(R.Log.info("cleanup")),
    R.Log.annotate("owner", R.U64.literal(1n)),
    R.Log.span("scope"),
  ),
);
const bare = R.program({ delay, shared4, shared8 });
const logged = R.program({ delay, shared4, shared8, scoped });

/** Allocation probe only: no scheduler/timer/HTTP polling is included in these construction counts. */
const probe = (logging: boolean) => `
use reffect_generated::{AsyncContext, r_delay, r_shared4, r_shared8};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
struct Counting;
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 { ALLOCS.fetch_add(1, Ordering::SeqCst); System.alloc(layout) }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) { System.dealloc(ptr, layout); }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 { ALLOCS.fetch_add(1, Ordering::SeqCst); System.realloc(ptr, layout, size) }
}
#[global_allocator] static ALLOCATOR: Counting = Counting;
fn main() {
    let before = ALLOCS.load(Ordering::SeqCst);
    let (_sender, receiver) = tokio::sync::watch::channel(false);
    let watch_allocs = ALLOCS.load(Ordering::SeqCst) - before;
    let before = ALLOCS.load(Ordering::SeqCst);
    let mut ctx = AsyncContext::new(receiver);
    let context_allocs = ALLOCS.load(Ordering::SeqCst) - before;
    let before = ALLOCS.load(Ordering::SeqCst);
    let delay = { let future = r_delay(&mut ctx); std::mem::size_of_val(&future) };
    let shared4 = { let future = r_shared4(&mut ctx, true); std::mem::size_of_val(&future) };
    let shared8 = { let future = r_shared8(&mut ctx, true); std::mem::size_of_val(&future) };
    let scoped = ${logging ? "{ let future = reffect_generated::r_scoped(&mut ctx); std::mem::size_of_val(&future) }" : "0"};
    let future_allocs = ALLOCS.load(Ordering::SeqCst) - before;
    assert_eq!(context_allocs, 0);
    assert_eq!(future_allocs, 0);
    println!("{{\\"context_bytes\\":{},\\"delay_future_bytes\\":{},\\"shared4_future_bytes\\":{},\\"shared8_future_bytes\\":{},\\"scoped_future_bytes\\":{},\\"watch_allocations\\":{},\\"context_construction_allocations\\":{},\\"future_construction_allocations\\":{}}}", std::mem::size_of_val(&ctx), delay, shared4, shared8, scoped, watch_allocs, context_allocs, future_allocs);
}
`;

const results = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-async-cost-" });
      const results: unknown[] = [];
      for (const logging of [false, true]) {
        for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
          const artifact = yield* Compile.make(logging ? logged : bare).pipe(
            Compile.withTarget(Rust.tokio),
            Compile.withSourceArtifacts(SourceArtifacts.None),
            Compile.withFailureFrames(policy),
            Compile.run,
          );
          const name = `${logging ? "logging" : "bare"}-${FailureFrames.isNone(policy) ? "none" : "bounded"}`;
          const directory = yield* CargoApi.write(
            {
              files: {
                "Cargo.toml": artifact.files["Cargo.toml"],
                "src/lib.rs": artifact.files["src/lib.rs"],
                "src/main.rs": probe(logging),
              },
            },
            `${parent}/${name}`,
          );
          yield* CargoApi.build(directory, "release");
          const result = yield* CargoApi.run(directory, "probe", [], "release");
          results.push({
            profile: name,
            generated_rust_bytes: new TextEncoder().encode(artifact.files["src/lib.rs"]).length,
            helpers: artifact.files["src/lib.rs"].match(/\n(?:async )?fn h_/g)?.length ?? 0,
            crates: artifact.explanation.crates,
            measurements: JSON.parse(result.stdout),
          });
        }
      }
      return results;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
const rust = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const process = yield* ChildProcess.make("rustc", ["--version"]);
      const output = yield* Stream.mkString(Stream.decodeText(process.stdout));
      if ((yield* process.exitCode) !== 0) throw new Error("Cannot identify probe compiler");
      return output.trim();
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
const record = {
  checked: new Date().toISOString().slice(0, 10),
  target: `${process.platform}/${process.arch}`,
  rust,
  effect: "4.0.0-rc.118",
  tokio: "1.53.1",
  scope:
    "Release layout and construction allocations; futures are constructed/dropped unpolled. Watch ownership is separate; timer, logging, frame failure, task and HTTP allocations are excluded.",
  results,
};
await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      process.argv[2] ?? "docs/research/async-cost-results.json",
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
console.log(JSON.stringify(record, null, 2));
