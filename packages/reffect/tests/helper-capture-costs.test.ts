import { Effect } from "effect";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";
import { R, Rust, FailureFrames, SourceArtifacts, Reference } from "../src/index.ts";
import type { Computation, Expr } from "../src/index.ts";
import { DeferredIR as D } from "../src/deferred.ts";
import { emitFunctions, lowerDeferredFunctions } from "../src/lower.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const execute = promisify(execFile);
const selected = new Map(
  Rust.std.implementations.map((implementation) => [implementation.operation.ref, implementation]),
);
const depths = [1, 4, 8, 16] as const;
const scalarWork = (depth: number, used: boolean) => {
  const build = (left: number, values: readonly Expr<bigint>[]): Computation<bigint> =>
    left > 0
      ? R.Effect.succeed(R.U64.literal(BigInt(left))).pipe(
          R.Effect.flatMap((value) => build(left - 1, [...values, value])),
        )
      : D.make(R.U64).pipe(
          R.Effect.flatMap((owner) =>
            D.succeed(
              owner,
              used
                ? values.reduce((sum, value) => R.U64.add(sum, value), R.U64.literal(0n))
                : R.U64.literal(7n),
            ).pipe(R.Effect.andThen(D.await(owner))),
          ),
        );
  return R.fn([], R.U64, R.Never, () => build(depth, []));
};
const ownerWork = (depth: number) => {
  const build = (left: number): Computation<bigint> =>
    left > 0
      ? D.make(R.Unit).pipe(R.Effect.flatMap(() => build(left - 1)))
      : D.make(R.U64).pipe(
          R.Effect.flatMap((owner) =>
            D.succeed(owner, R.U64.literal(7n)).pipe(R.Effect.andThen(D.await(owner))),
          ),
        );
  return R.fn([], R.U64, R.Never, () => build(depth));
};
const programs = Object.fromEntries([
  ...depths.map((depth) => [`unused_${depth}`, scalarWork(depth, false)] as const),
  ["used_8", scalarWork(8, true)] as const,
  ["owners_8", ownerWork(8)] as const,
  [
    "finalizer",
    R.fn([], R.U64, R.Never, () =>
      R.Effect.succeed(R.U64.literal(7n)).pipe(
        R.Effect.flatMap((value) =>
          D.make(R.U64).pipe(
            R.Effect.flatMap((owner) =>
              R.Effect.void.pipe(
                R.Effect.ensuring(D.succeed(owner, value).pipe(R.Effect.asVoid)),
                R.Effect.andThen(D.await(owner)),
              ),
            ),
          ),
        ),
      ),
    ),
  ] as const,
]);
const expected = (name: string) => (name === "used_8" ? 36n : 7n);

test("helper captures retain used values and omit unrelated lexical bindings", async () => {
  const module = lowerDeferredFunctions(R.program(programs), selected);
  for (const fn of module.functions) {
    const inputs = fn.helpers.map((helper) => helper.input.length);
    const owners = fn.helpers.map((helper) => helper.deferredOwners?.length ?? 0);
    if (fn.name.startsWith("unused_")) expect(Math.max(...inputs)).toBe(0);
    if (fn.name === "owners_8") expect(Math.max(...owners)).toBe(1);
    if (fn.name === "used_8") expect(Math.max(...inputs)).toBe(8);
  }
  for (const [name, fn] of Object.entries(programs))
    expect(await Effect.runPromise(Reference.run(fn, []))).toBe(expected(name));
});

const harness = `
use reffect_generated as r;
use std::sync::atomic::{AtomicBool,AtomicUsize,Ordering};
struct Meter;
static METER_ON:AtomicBool=AtomicBool::new(false);
static ALLOCATIONS:AtomicUsize=AtomicUsize::new(0);
#[global_allocator] static ALLOCATOR:Meter=Meter;
unsafe impl std::alloc::GlobalAlloc for Meter {
 unsafe fn alloc(&self,layout:std::alloc::Layout)->*mut u8 {
  if METER_ON.load(Ordering::Relaxed){ALLOCATIONS.fetch_add(1,Ordering::Relaxed);}
  std::alloc::System.alloc(layout)
 }
 unsafe fn dealloc(&self,pointer:*mut u8,layout:std::alloc::Layout){std::alloc::System.dealloc(pointer,layout)}
}
#[tokio::main(flavor="current_thread")]
async fn main(){
 let(_sender,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 println!("pointer={}",std::mem::size_of::<usize>());
 println!("context={}",std::mem::size_of_val(&ctx));
 ${Object.keys(programs)
   .map(
     (name) => `{
 let future=r::r_${name}(&mut ctx);
 println!("size:${name}={}",std::mem::size_of_val(&future));
 drop(future);
 ALLOCATIONS.store(0,Ordering::Relaxed);METER_ON.store(true,Ordering::Relaxed);
 for _ in 0..100{assert_eq!(r::r_${name}(&mut ctx).await.unwrap(),${expected(name)}u64);}
 METER_ON.store(false,Ordering::Relaxed);
 let allocations=ALLOCATIONS.load(Ordering::Relaxed);
 println!("allocations:${name}={}",allocations);
 assert_eq!(allocations,0,"quiet actual generated invocations include the first execution");
 }`,
   )
   .join("\n")}
}
`;

test(
  "generated quiet helper futures have bounded capture growth and allocate nothing",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "reffect-helper-captures-"));
    try {
      for (const policy of [FailureFrames.None, FailureFrames.Bounded]) {
        const root = join(directory, policy._tag);
        const emitted = emitFunctions(
          lowerDeferredFunctions(R.program(programs), selected, SourceArtifacts.None, policy),
        );
        for (const [path, content] of Object.entries(emitted.files)) {
          await mkdir(dirname(join(root, path)), { recursive: true });
          await writeFile(join(root, path), content);
        }
        await writeFile(join(root, "src/main.rs"), harness);
        for (const profile of ["debug", "release"] as const) {
          await execute(
            "cargo",
            ["build", "--offline", "--quiet", ...(profile === "release" ? ["--release"] : [])],
            {
              cwd: root,
              timeout: 120000,
              env: { ...process.env, CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0" },
            },
          );
          const { stdout } = await execute(join(root, "target", profile, "reffect_generated"), [], {
            cwd: root,
            timeout: 15000,
          });
          const numbers = new Map(
            stdout
              .trim()
              .split("\n")
              .map((line) => {
                const [key, value] = line.split("=");
                return [key!, Number(value)] as const;
              }),
          );
          const size = (depth: number) => numbers.get(`size:unused_${depth}`)!;
          const pointer = numbers.get("pointer")!;
          expect(pointer).toBeGreaterThan(0);
          expect(numbers.get("context")).toBeGreaterThan(0);
          for (const name of Object.keys(programs)) {
            expect(numbers.get(`size:${name}`)).toBeGreaterThan(0);
            expect(numbers.get(`allocations:${name}`)).toBe(0);
          }
          // Doubling lexical depth may double necessary composition states; quadratic
          // propagation of unused scalar arguments must not consume the extra slack.
          expect(size(16) - size(1)).toBeLessThanOrEqual(2 * (size(8) - size(1)) + 32 * pointer);
          console.info(
            `Helper capture costs ${policy._tag}/${profile}: ${stdout.trim().replaceAll("\n", ", ")}`,
          );
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(0) + 180000,
);
