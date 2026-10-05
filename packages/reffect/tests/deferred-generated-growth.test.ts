import { Cause, Deferred, Effect, Exit } from "effect";
import { expect, test } from "vite-plus/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { R, Rust, FailureFrames, SourceArtifacts } from "../src/index.ts";
import type { Computation } from "../src/index.ts";
import { DeferredIR as D } from "../src/deferred.ts";
import { DeferredExecution } from "../src/deferred-execution.ts";
import { analyzeGeneratedDeferredProfile } from "../src/deferred-generated-profile.ts";
import { analyzeDeferredBudget, defaultDeferredBudgetContext } from "../src/deferred-budget.ts";
import {
  analyzeGeneratedDeferredGrowth,
  checkGeneratedDeferredRustBytes,
} from "../src/deferred-growth.ts";
import { emitFunctions, lowerDeferredFunctions, lowerFunctions } from "../src/lower.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const execute = promisify(execFile);
const selected = new Map(Rust.std.implementations.map((i) => [i.operation.ref, i]));
const maps = (count: number, source: Computation<void>) => {
  let body = source;
  for (let i = 0; i < count; i++) body = body.pipe(R.Effect.map((value) => value));
  return body;
};
const chain = (count: number) =>
  R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(R.Effect.flatMap((cell) => maps(count, D.await(cell)))),
  );
const branching = (depth: number) =>
  R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap(() => {
        let body = R.Effect.void;
        for (let i = 0; i < depth; i++) {
          const left = R.Effect.succeed(R.Unit.literal()).pipe(R.Effect.andThen(body));
          const right = R.Effect.succeed(R.Unit.literal()).pipe(R.Effect.andThen(body));
          body = R.Match.bool(R.Bool.literal(false), left, right);
        }
        return body;
      }),
    ),
  );
const scalar = (value: ReturnType<typeof R.Bool.literal>) =>
  R.fn([], R.Bool, R.Never, () =>
    D.make(R.Unit).pipe(R.Effect.flatMap(() => R.Effect.succeed(value))),
  );

test("private growth refuses admitted query-depth and dormant-branch failures before work", async () => {
  for (const work of [chain(70), branching(10)]) {
    expect(analyzeDeferredBudget(work, "body", defaultDeferredBudgetContext, true).admitted).toBe(
      true,
    );
    expect(() => analyzeGeneratedDeferredProfile(R.program({ work }))).toThrowError(
      /must not exceed/,
    );
    expect(() => lowerDeferredFunctions(R.program({ work }), selected)).toThrowError(
      /must not exceed/,
    );
    for (const run of [DeferredExecution.run, DeferredExecution.runWithFrames]) {
      const result = await run(work);
      expect(result.logs).toEqual([]);
      expect(result.exit).toMatchObject({
        cause: {
          reasons: [
            {
              error: {
                diagnostics: [expect.objectContaining({ code: "DEFERRED_GENERATED_GROWTH" })],
              },
            },
          ],
        },
      });
    }
  }
  const logged = R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap(() =>
        R.Log.info("must:not:start").pipe(R.Effect.andThen(branching(10).body)),
      ),
    ),
  );
  expect((await DeferredExecution.run(logged)).logs).toEqual([]);
});

test("extremely deep input refuses before topology and owned reference recursion", async () => {
  const work = chain(4096);
  expect(() => analyzeGeneratedDeferredProfile(R.program({ work }))).toThrowError(/IR nesting/);
  const observed = await DeferredExecution.runWithFrames(work);
  expect(observed.logs).toEqual([]);
  expect(observed.exit).toMatchObject({
    cause: {
      reasons: [{ error: { diagnostics: [expect.objectContaining({ code: "NESTING_LIMIT" })] } }],
    },
  });
});

test("inclusive depth and full expanded occurrence limits charge shared branches", () => {
  expect(analyzeGeneratedDeferredGrowth(chain(48))).toMatchObject({
    computationDepth: 50,
    computationOccurrences: 50,
  });
  expect(() => analyzeGeneratedDeferredGrowth(chain(49))).toThrowError(/computationDepth/);
  const shared = () => {
    let body = R.Effect.void;
    for (let i = 0; i < 8; i++) body = R.Match.bool(R.Bool.literal(false), body, body);
    return R.fn([], R.Unit, R.Never, () => D.make(R.Unit).pipe(R.Effect.flatMap(() => body)));
  };
  expect(analyzeGeneratedDeferredGrowth(shared())).toMatchObject({ computationOccurrences: 512 });
  const value = shared();
  const bigger = R.fn([], R.Unit, R.Never, () => value.body.pipe(R.Effect.map((v) => v)));
  expect(() => analyzeGeneratedDeferredGrowth(bigger)).toThrowError(/computationOccurrences/);
});

test("expression receipts charge repeated edges and protect independent depth limits", () => {
  let depth = R.Bool.literal(true);
  for (let i = 0; i < 63; i++) depth = R.Bool.not(depth);
  expect(analyzeGeneratedDeferredGrowth(scalar(depth)).expressionDepth).toBe(64);
  expect(() => analyzeGeneratedDeferredGrowth(scalar(R.Bool.not(depth)))).toThrowError(
    /expressionDepth/,
  );
  let shared = R.Bool.literal(true);
  for (let i = 0; i < 11; i++) shared = R.Bool.eq(shared, shared);
  const exact = scalar(R.Bool.not(shared));
  expect(analyzeGeneratedDeferredGrowth(exact).expressionOccurrences).toBe(4096);
  expect(() => analyzeGeneratedDeferredGrowth(scalar(R.Bool.not(R.Bool.not(shared))))).toThrowError(
    /expressionOccurrences/,
  );
});

test("UTF-8 text receipts count literal bytes and reject oversized log payloads", () => {
  const bytes = "😀".repeat(16384);
  const work = scalar(R.String.includes(R.String.literal(bytes), R.String.literal("")));
  expect(analyzeGeneratedDeferredGrowth(work).textBytes).toBe(65536);
  expect(() =>
    analyzeGeneratedDeferredGrowth(
      scalar(R.String.includes(R.String.literal(bytes + "x"), R.String.literal(""))),
    ),
  ).toThrowError(/textBytes/);
  const log = R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(R.Effect.flatMap(() => R.Log.info(bytes + "x"))),
  );
  expect(() => analyzeGeneratedDeferredProfile(R.program({ log }))).toThrowError(/textBytes/);
});

test("module growth aggregates exported occurrences even for one shared function", () => {
  let body = R.Effect.void;
  for (let i = 0; i < 8; i++) body = R.Match.bool(R.Bool.literal(false), body, body);
  const work = R.fn([], R.Unit, R.Never, () => D.make(R.Unit).pipe(R.Effect.flatMap(() => body)));
  const exports = (count: number) =>
    R.program(Object.fromEntries(Array.from({ length: count }, (_, i) => [`work${i}`, work])));
  expect(analyzeGeneratedDeferredProfile(exports(8)).has(work)).toBe(true);
  expect(() => analyzeGeneratedDeferredProfile(exports(9))).toThrowError(/moduleComputations/);
  let expr = R.Bool.literal(true);
  for (let i = 0; i < 11; i++) expr = R.Bool.eq(expr, expr);
  const pure = scalar(R.Bool.not(expr));
  const expressions = (count: number) =>
    R.program(Object.fromEntries(Array.from({ length: count }, (_, i) => [`work${i}`, pure])));
  expect(analyzeGeneratedDeferredProfile(expressions(8)).has(pure)).toBe(true);
  expect(() => analyzeGeneratedDeferredProfile(expressions(9))).toThrowError(/moduleExpressions/);
  const log = R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(R.Effect.flatMap(() => R.Log.info("x".repeat(65536)))),
  );
  const text = (count: number) =>
    R.program(Object.fromEntries(Array.from({ length: count }, (_, i) => [`work${i}`, log])));
  expect(analyzeGeneratedDeferredProfile(text(4)).has(log)).toBe(true);
  expect(() => analyzeGeneratedDeferredProfile(text(5))).toThrowError(/moduleTextBytes/);
});

test("private scalar receipt explicitly refuses compound expression layouts", () => {
  const record = R.Struct({ ready: R.Bool });
  const work = scalar(R.Struct.get(record.make({ ready: R.Bool.literal(true) }), "ready"));
  expect(() => analyzeGeneratedDeferredProfile(R.program({ work }))).toThrowError(
    /scalar growth receipt/,
  );
});

test("actual emitted Rust cap covers mixed crates and preserves ordinary emission", () => {
  const log = R.fn([], R.Unit, R.Never, () => R.Log.info("x".repeat(2097152)));
  const ordinary = R.program({ log });
  expect(
    emitFunctions(lowerFunctions(ordinary, selected, SourceArtifacts.None, FailureFrames.None))
      .files["src/lib.rs"].length,
  ).toBeGreaterThan(2097152);
  for (const frames of [FailureFrames.None, FailureFrames.Bounded])
    for (const artifacts of [SourceArtifacts.None, SourceArtifacts.Full])
      expect(() =>
        emitFunctions(
          lowerDeferredFunctions(R.program({ log, work: chain(1) }), selected, artifacts, frames),
        ),
      ).toThrowError(/rustBytes/);
  expect(() =>
    checkGeneratedDeferredRustBytes({
      "src/lib.rs": "😀".repeat(524288),
      "other.json": "x".repeat(2097153),
    }),
  ).not.toThrow();
  expect(() =>
    checkGeneratedDeferredRustBytes({ "src/lib.rs": "😀".repeat(524288), "src/main.rs": "x" }),
  ).toThrowError(/rustBytes/);
});

const programs = {
  depth: chain(48),
  branch: R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap((cell) => {
        let body = D.succeed(cell, R.Unit.literal()).pipe(R.Effect.asVoid);
        for (let index = 0; index < 6; index++) {
          const left = R.Effect.succeed(R.Unit.literal()).pipe(R.Effect.andThen(body));
          const right = R.Effect.succeed(R.Unit.literal()).pipe(R.Effect.andThen(body));
          body = R.Match.bool(R.Bool.literal(false), left, right);
        }
        return body;
      }),
    ),
  ),
  group: R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap((cell) =>
        R.Effect.all(
          [
            R.Effect.race(maps(40, D.await(cell)), R.Effect.void),
            D.succeed(cell, R.Unit.literal()).pipe(R.Effect.asVoid),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      ),
    ),
  ),
};

test("boundary programs retain independent official outcomes and weighted driver depth", async () => {
  expect(analyzeGeneratedDeferredGrowth(programs.group).computationDepth).toBe(50);
  expect(analyzeGeneratedDeferredGrowth(programs.branch).computationOccurrences).toBe(444);
  const branch = await DeferredExecution.run(programs.branch);
  expect(branch.exit).toEqual(
    await Effect.runPromiseExit(
      Deferred.make<void>().pipe(
        Effect.flatMap((cell) => Deferred.succeed(cell, undefined).pipe(Effect.asVoid)),
      ),
    ),
  );
  const official = Deferred.make<void>().pipe(
    Effect.flatMap((cell) => {
      let waiter = Deferred.await(cell);
      for (let i = 0; i < 40; i++) waiter = waiter.pipe(Effect.map((v) => v));
      return Effect.all(
        [Effect.race(waiter, Effect.void), Deferred.succeed(cell, undefined).pipe(Effect.asVoid)],
        { concurrency: "unbounded", discard: true },
      );
    }),
  );
  expect((await DeferredExecution.run(programs.group)).exit).toEqual(
    await Effect.runPromiseExit(official),
  );
  const controller = new AbortController();
  const pending = DeferredExecution.runWithFrames(programs.depth, { signal: controller.signal });
  controller.abort();
  const outcome = await pending;
  expect(Exit.isSuccess(outcome.exit)).toBe(true);
  if (Exit.isSuccess(outcome.exit)) {
    expect(
      Exit.isFailure(outcome.exit.value.exit) &&
        Cause.hasInterruptsOnly(outcome.exit.value.exit.cause),
    ).toBe(true);
    expect(outcome.exit.value.frames).toHaveLength(32);
    expect(outcome.exit.value.omitted).toBe(19);
  }
});

const harness = `
use reffect_generated as r;
use std::future::Future;
async fn cancel<F:Future>(future:F,sender:&tokio::sync::watch::Sender<bool>)->F::Output {
 tokio::pin!(future);
 let first=std::future::poll_fn(|cx|std::task::Poll::Ready(future.as_mut().poll(cx))).await;
 assert!(first.is_pending());sender.send(true).unwrap();future.await
}
#[tokio::main(flavor="current_thread")]
async fn main(){
 let(sender,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 let pointer=std::mem::size_of::<usize>();
 {let f=r::r_depth(&mut ctx);let bytes=std::mem::size_of_val(&f);println!("depth={}",bytes);assert!(bytes<=2560*pointer);assert!(matches!(cancel(f,&sender).await,Err(r::AsyncError::Interrupted)));}
 FRAME_PROBE
 sender.send(false).unwrap();
 {let f=r::r_branch(&mut ctx);let bytes=std::mem::size_of_val(&f);println!("branch={}",bytes);assert!(bytes<=2560*pointer);assert!(f.await.is_ok());}
 {let f=r::r_group(&mut ctx);let bytes=std::mem::size_of_val(&f);println!("group={}",bytes);assert!(bytes<=2560*pointer);assert!(f.await.is_ok());}
}
`;

test(
  "actual generated growth boundaries compile and run in every native frame/build policy",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "reffect-deferred-growth-"));
    try {
      for (const policy of [FailureFrames.None, FailureFrames.Bounded]) {
        const root = join(directory, policy._tag);
        const emitted = emitFunctions(
          lowerDeferredFunctions(R.program(programs), selected, SourceArtifacts.None, policy),
        );
        for (const [path, contents] of Object.entries(emitted.files)) {
          await mkdir(dirname(join(root, path)), { recursive: true });
          await writeFile(join(root, path), contents);
        }
        const allowance = emitted.files["src/main.rs"].match(/^#!\[recursion_limit = "256"\]/)?.[0];
        expect(allowance).toBeDefined();
        await writeFile(
          join(root, "src/main.rs"),
          `${allowance}\n${harness}`.replace(
            "FRAME_PROBE",
            policy._tag === "None"
              ? ""
              : "let(frames,omitted)=ctx.take_frames();assert_eq!(frames.len(),32);assert_eq!(omitted,19);",
          ),
        );
        for (const profile of ["debug", "release"] as const) {
          await execute(
            "cargo",
            ["build", "--offline", "--quiet", ...(profile === "release" ? ["--release"] : [])],
            {
              cwd: root,
              timeout: 180000,
              env: { ...process.env, CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0" },
            },
          );
          const { stdout } = await execute(join(root, "target", profile, "reffect_generated"), [], {
            cwd: root,
            timeout: 15000,
          });
          expect(stdout).toMatch(/depth=\d+\nbranch=\d+\ngroup=\d+/);
          process.stdout.write(`growth ${policy._tag}/${profile}: ${stdout}`);
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(0) + 300000,
);
