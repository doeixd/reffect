import { Cause, Deferred, Effect, Exit, Fiber, Logger } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vite-plus/test";
import { R, Reference, FailureFrames, SourceArtifacts, Compile, Rust } from "../src/index.ts";
import type { EffectFn } from "../src/index.ts";
import { DeferredIR as D } from "../src/deferred.ts";
import { emitFunctions, lowerDeferredFunctions } from "../src/lower.ts";
import { GeneratedDeferredReference } from "../src/deferred-generated-reference.ts";
import { DeferredInterruptionFrames } from "../src/deferred-interruption-frames.ts";
import { analyzeGeneratedDeferredProfile } from "../src/deferred-generated-profile.ts";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nativeTestBudget } from "./native-test-budget.ts";
const execute = promisify(execFile);
const selected = new Map(
  Rust.std.implementations.map((implementation) => [implementation.operation.ref, implementation]),
);

const options = { concurrency: "unbounded", discard: true } as const;
const rCleanup = (name: string) =>
  R.Log.info(`${name}:cleanup:start`).pipe(
    R.Effect.andThen(R.Effect.sleep(20)),
    R.Effect.andThen(R.Log.info(`${name}:cleanup:done`)),
  );
const officialCleanup = (name: string) =>
  Effect.logInfo(`${name}:cleanup:start`).pipe(
    Effect.andThen(Effect.sleep(20)),
    Effect.andThen(Effect.logInfo(`${name}:cleanup:done`)),
  );
const ordered = <A>(children: readonly [A, A, A], producerFirst: boolean): readonly [A, A, A] =>
  producerFirst ? [children[2], children[0], children[1]] : children;
const isolated = (prefix: string, producerFirst = false) =>
  D.make(R.U64).pipe(
    R.Effect.flatMap((main) =>
      D.make(R.Unit).pipe(
        R.Effect.flatMap((signal) =>
          R.Effect.all(
            ordered(
              [
                R.Effect.race(
                  R.Log.info(`${prefix}:loser:start`).pipe(
                    R.Effect.andThen(D.await(main)),
                    R.Effect.andThen(R.Log.info(`${prefix}:loser:unexpected`)),
                    R.Effect.ensuring(
                      rCleanup(`${prefix}:loser`).pipe(
                        R.Effect.andThen(D.succeed(signal, R.Unit.literal())),
                        R.Effect.asVoid,
                      ),
                    ),
                  ),
                  R.Log.info(`${prefix}:winner:start`).pipe(
                    R.Effect.andThen(R.Effect.sleep(10)),
                    R.Effect.andThen(R.Log.info(`${prefix}:winner:done`)),
                  ),
                ).pipe(R.Effect.andThen(R.Log.info(`${prefix}:race:return`))),
                R.Log.info(`${prefix}:survivor:start`).pipe(
                  R.Effect.andThen(D.await(main)),
                  R.Effect.andThen(R.Log.info(`${prefix}:survivor:prefix`)),
                ),
                R.Log.info(`${prefix}:producer:start`).pipe(
                  R.Effect.andThen(D.await(signal)),
                  R.Effect.andThen(D.succeed(main, R.U64.literal(7n))),
                  R.Effect.flatMap((first) =>
                    R.Match.bool(
                      first,
                      R.Log.info(`${prefix}:first:true`),
                      R.Log.info(`${prefix}:first:false`),
                    ),
                  ),
                  R.Effect.andThen(D.succeed(main, R.U64.literal(9n))),
                  R.Effect.flatMap((last) =>
                    R.Match.bool(
                      last,
                      R.Log.info(`${prefix}:second:true`),
                      R.Log.info(`${prefix}:second:false`),
                    ),
                  ),
                  R.Effect.andThen(D.await(main)),
                  R.Effect.flatMap((value) =>
                    R.Match.bool(
                      R.U64.eq(value, R.U64.literal(7n)),
                      R.Log.info(`${prefix}:retained:true`),
                      R.Log.info(`${prefix}:retained:false`),
                    ),
                  ),
                ),
              ],
              producerFirst,
            ),
            options,
          ),
        ),
      ),
    ),
  );
const officialIsolated = (prefix: string, producerFirst = false) =>
  Effect.gen(function* () {
    const main = yield* Deferred.make<bigint>();
    const signal = yield* Deferred.make<void>();
    yield* Effect.all(
      ordered(
        [
          Effect.race(
            Effect.logInfo(`${prefix}:loser:start`).pipe(
              Effect.andThen(Deferred.await(main)),
              Effect.andThen(Effect.logInfo(`${prefix}:loser:unexpected`)),
              Effect.ensuring(
                officialCleanup(`${prefix}:loser`).pipe(
                  Effect.andThen(Deferred.succeed(signal, undefined)),
                  Effect.asVoid,
                ),
              ),
            ),
            Effect.logInfo(`${prefix}:winner:start`).pipe(
              Effect.andThen(Effect.sleep(10)),
              Effect.andThen(Effect.logInfo(`${prefix}:winner:done`)),
            ),
          ).pipe(Effect.andThen(Effect.logInfo(`${prefix}:race:return`))),
          Effect.logInfo(`${prefix}:survivor:start`).pipe(
            Effect.andThen(Deferred.await(main)),
            Effect.andThen(Effect.logInfo(`${prefix}:survivor:prefix`)),
          ),
          Effect.logInfo(`${prefix}:producer:start`).pipe(
            Effect.andThen(Deferred.await(signal)),
            Effect.andThen(Deferred.succeed(main, 7n)),
            Effect.flatMap((first) => Effect.logInfo(`${prefix}:first:${first}`)),
            Effect.andThen(Deferred.succeed(main, 9n)),
            Effect.flatMap((last) => Effect.logInfo(`${prefix}:second:${last}`)),
            Effect.andThen(Deferred.await(main)),
            Effect.flatMap((value) => Effect.logInfo(`${prefix}:retained:${value === 7n}`)),
          ),
        ],
        producerFirst,
      ),
      options,
    );
  });
const pending = () =>
  D.make(R.Unit).pipe(
    R.Effect.flatMap((main) =>
      R.Effect.all(
        [
          R.Effect.race(
            ...(["inner1", "inner2"].map((name) =>
              R.Log.info(`${name}:start`).pipe(
                R.Effect.andThen(D.await(main)),
                R.Effect.ensuring(rCleanup(name)),
              ),
            ) as [ReturnType<typeof rCleanup>, ReturnType<typeof rCleanup>]),
          ),
          R.Log.info("outer:start").pipe(
            R.Effect.andThen(D.await(main)),
            R.Effect.ensuring(rCleanup("outer")),
          ),
        ],
        options,
      ),
    ),
  );
const officialPending = () =>
  Effect.gen(function* () {
    const main = yield* Deferred.make<void>();
    yield* Effect.all(
      [
        Effect.race(
          ...(["inner1", "inner2"].map((name) =>
            Effect.logInfo(`${name}:start`).pipe(
              Effect.andThen(Deferred.await(main)),
              Effect.ensuring(officialCleanup(name)),
            ),
          ) as [Effect.Effect<void>, Effect.Effect<void>]),
        ),
        Effect.logInfo("outer:start").pipe(
          Effect.andThen(Deferred.await(main)),
          Effect.ensuring(officialCleanup("outer")),
        ),
      ],
      options,
    );
  });
const reusedGroup = (prefix: string) =>
  R.Effect.all(
    [
      R.Effect.race(
        R.Log.info(`${prefix}:loser:start`).pipe(
          R.Effect.andThen(R.Effect.sleep(100)),
          R.Effect.ensuring(rCleanup(`${prefix}:loser`)),
        ),
        R.Log.info(`${prefix}:winner:start`).pipe(
          R.Effect.andThen(R.Effect.sleep(10)),
          R.Effect.andThen(R.Log.info(`${prefix}:winner:done`)),
        ),
      ).pipe(R.Effect.andThen(R.Log.info(`${prefix}:race:return`))),
      R.Log.info(`${prefix}:peer`),
      R.Log.info(`${prefix}:marker`),
    ],
    options,
  );
const officialReusedGroup = (prefix: string) =>
  Effect.all(
    [
      Effect.race(
        Effect.logInfo(`${prefix}:loser:start`).pipe(
          Effect.andThen(Effect.sleep(100)),
          Effect.ensuring(officialCleanup(`${prefix}:loser`)),
        ),
        Effect.logInfo(`${prefix}:winner:start`).pipe(
          Effect.andThen(Effect.sleep(10)),
          Effect.andThen(Effect.logInfo(`${prefix}:winner:done`)),
        ),
      ).pipe(Effect.andThen(Effect.logInfo(`${prefix}:race:return`))),
      Effect.logInfo(`${prefix}:peer`),
      Effect.logInfo(`${prefix}:marker`),
    ],
    options,
  );
const programs = {
  isolated: R.fn([], R.Unit, R.Never, () => isolated("one")),
  producerFirst: R.fn([], R.Unit, R.Never, () => isolated("first", true)),
  reuse: R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap((cell) =>
        reusedGroup("one").pipe(
          R.Effect.andThen(reusedGroup("two")),
          R.Effect.andThen(D.succeed(cell, R.Unit.literal())),
          R.Effect.andThen(D.await(cell)),
        ),
      ),
    ),
  ),
  cancel: R.fn([], R.Unit, R.Never, pending),
};
type Scenario = keyof typeof programs;
const oracles = {
  isolated: () => officialIsolated("one"),
  producerFirst: () => officialIsolated("first", true),
  reuse: () =>
    Effect.gen(function* () {
      const cell = yield* Deferred.make<void>();
      yield* officialReusedGroup("one");
      yield* officialReusedGroup("two");
      yield* Deferred.succeed(cell, undefined);
      yield* Deferred.await(cell);
    }),
  cancel: officialPending,
};
interface Observation {
  events: string[];
  result: string;
}
const observe = (body: Effect.Effect<unknown, unknown>, cancel: boolean): Promise<Observation> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events: string[] = [];
        const logger = Logger.layer([Logger.make((event) => events.push(String(event.message)))]);
        const fiber = yield* body.pipe(Effect.provide(logger), Effect.forkScoped);
        yield* TestClock.adjust(0);
        if (cancel) {
          expect(events).toEqual(["inner1:start", "inner2:start", "outer:start"]);
          fiber.interruptUnsafe();
        }
        yield* TestClock.adjust(100);
        const exit = yield* Fiber.await(fiber);
        return {
          events,
          result: Exit.isSuccess(exit)
            ? String(exit.value)
            : Cause.hasInterrupts(exit.cause)
              ? "Interrupted"
              : "Failure",
        };
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
const isolationEvents = (prefix: string) =>
  [
    "loser:start",
    "winner:start",
    "survivor:start",
    "producer:start",
    "winner:done",
    "loser:cleanup:start",
    "loser:cleanup:done",
    "survivor:prefix",
    "first:true",
    "second:false",
    "retained:true",
    "race:return",
  ].map((event) => `${prefix}:${event}`);
const reuseEvents = (prefix: string) =>
  [
    "loser:start",
    "winner:start",
    "peer",
    "marker",
    "winner:done",
    "loser:cleanup:start",
    "loser:cleanup:done",
    "race:return",
  ].map((event) => `${prefix}:${event}`);
const expected: Record<Scenario, Observation> = {
  isolated: { events: isolationEvents("one"), result: "undefined" },
  producerFirst: {
    events: [
      "first:producer:start",
      "first:loser:start",
      "first:winner:start",
      "first:survivor:start",
      ...isolationEvents("first").slice(4),
    ],
    result: "undefined",
  },
  reuse: { events: [...reuseEvents("one"), ...reuseEvents("two")], result: "undefined" },
  cancel: {
    events: [
      "inner1:start",
      "inner2:start",
      "outer:start",
      "inner1:cleanup:start",
      "inner2:cleanup:start",
      "outer:cleanup:start",
      "inner1:cleanup:done",
      "inner2:cleanup:done",
      "outer:cleanup:done",
    ],
    result: "Interrupted",
  },
};
test("nested Deferred fixtures match independent official and both references", async () => {
  for (const scenario of Object.keys(programs) as Scenario[]) {
    const official = await observe(oracles[scenario](), scenario === "cancel");
    expect(official).toEqual(expected[scenario]);
    const fn: EffectFn<readonly [], unknown, never> = programs[scenario];

    for (const body of [
      GeneratedDeferredReference.run(fn, []),
      GeneratedDeferredReference.runWithFrames(fn, []).pipe(
        Effect.flatMap((result) => result.exit),
      ),
    ])
      expect(await observe(body, scenario === "cancel")).toEqual(expected[scenario]);
    const frames = new DeferredInterruptionFrames();
    expect(
      await observe(
        GeneratedDeferredReference.runWithInterruptionFrames(
          fn,
          [],
          frames,
          `functions.${scenario}.body`,
        ).pipe(Effect.flatMap((result) => result.exit)),
        scenario === "cancel",
      ),
    ).toEqual(expected[scenario]);
    expect(frames.snapshot()).toEqual(
      scenario === "cancel"
        ? {
            frames: [
              { path: "functions.cancel.body.body", kind: "all" },
              { path: "functions.cancel.body", kind: "deferredScope" },
              { path: "functions.cancel", kind: "function" },
            ],
            omitted: 0,
          }
        : { frames: [], omitted: 0 },
    );
  }
});

const scenarios = Object.keys(programs) as Scenario[];
const harness = `
use reffect_generated as r;
use std::future::Future;
use std::pin::Pin;
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
async fn once<F:Future>(mut future:Pin<&mut F>)->Option<F::Output>{
 std::future::poll_fn(|cx|std::task::Poll::Ready(match future.as_mut().poll(cx){
  std::task::Poll::Ready(output)=>Some(output),std::task::Poll::Pending=>None
 })).await
}
async fn drive<F:Future>(future:F,sender:&tokio::sync::watch::Sender<bool>,cancel:bool)->F::Output{
 println!("future-size={}",std::mem::size_of_val(&future));
 tokio::pin!(future);
 ALLOCATIONS.store(0,Ordering::Relaxed);METER_ON.store(true,Ordering::Relaxed);
 let mut result=once(future.as_mut()).await;
 if cancel{assert!(result.is_none(),"waiters must be pending before cancellation");sender.send(true).unwrap();result=once(future.as_mut()).await;}
 tokio::time::advance(std::time::Duration::from_millis(100)).await;
 let output=match result{Some(output)=>output,None=>future.await};
 METER_ON.store(false,Ordering::Relaxed);println!("invocation-allocations={}",ALLOCATIONS.load(Ordering::Relaxed));
 output
}
fn report<A:std::fmt::Debug>(result:Result<A,r::AsyncError<std::convert::Infallible>>){
 match result{Ok(value)=>println!("result={:?}",value),Err(r::AsyncError::Interrupted)=>println!("result=Interrupted"),other=>panic!("Unexpected result: {:?}",other)}
}
#[tokio::main(flavor="current_thread")]
async fn main(){
 tokio::time::pause();
 println!("pointer-size={}",std::mem::size_of::<usize>());
 let scenario=std::env::args().nth(1).unwrap();
 let(sender,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 println!("context-size={}",std::mem::size_of_val(&ctx));
 match scenario.as_str(){
 ${scenarios.map((name) => `"${name}"=>report(drive(r::r_${name}(&mut ctx),&sender,${name === "cancel"}).await),`).join("\n")}
 _=>panic!("unknown scenario")
 }
 FRAME_PROBE
}
`;

test("ordinary reference still refuses private nested topology", async () => {
  const exit = await Effect.runPromise(Reference.run(programs.isolated, []).pipe(Effect.exit));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit))
    expect(Cause.findErrorOption(exit.cause)).toMatchObject({
      value: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "NESTED_TASK_GROUP" }),
        ]),
      },
    });
});
test("public native compilation still refuses private nested Deferred", async () => {
  const exit = await Effect.runPromise(
    Compile.make(R.program({ isolated: programs.isolated })).pipe(
      Compile.withTarget(Rust.tokio),
      Compile.run,
      Effect.exit,
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit))
    expect(Cause.findErrorOption(exit.cause)).toMatchObject({
      value: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: expect.stringMatching(/^(NESTED_TASK_GROUP|DEFERRED_NATIVE_INTEGRATION)$/),
          }),
        ]),
      },
    });
});
test(
  "actual generated nested Race drains independent and parent cancellation",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "reffect-deferred-nested-"));
    try {
      for (const policy of [FailureFrames.None, FailureFrames.Bounded]) {
        const root = join(directory, policy._tag);
        const profiles = analyzeGeneratedDeferredProfile(R.program(programs));
        expect(profiles.get(programs.isolated)?.taskCapacity).toBe(6);
        expect(profiles.get(programs.reuse)?.taskCapacity).toBe(6);
        expect(profiles.get(programs.producerFirst)?.taskCapacity).toBe(6);
        expect(profiles.get(programs.cancel)?.taskCapacity).toBe(5);
        console.info(
          `Nested Deferred capacities: isolated=${profiles.get(programs.isolated)?.taskCapacity}, reuse=${profiles.get(programs.reuse)?.taskCapacity}, cancel=${profiles.get(programs.cancel)?.taskCapacity}`,
        );
        const emitted = emitFunctions(
          lowerDeferredFunctions(R.program(programs), selected, SourceArtifacts.None, policy),
        );
        for (const [path, content] of Object.entries(emitted.files)) {
          await mkdir(dirname(join(root, path)), { recursive: true });
          await writeFile(join(root, path), content);
        }
        const manifest = await readFile(join(root, "Cargo.toml"), "utf8");
        await writeFile(
          join(root, "Cargo.toml"),
          manifest.replace('"macros",', '"test-util", "macros",'),
        );
        await writeFile(
          join(root, "src/main.rs"),
          harness.replace(
            "FRAME_PROBE",
            policy._tag === "None"
              ? 'println!("frames=0");'
              : 'let(frames,omitted)=ctx.take_frames(); for frame in &frames {println!("frame={}",frame);} println!("frames={}",frames.len()); println!("omitted={}",omitted);',
          ),
        );
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
          for (const scenario of scenarios) {
            const { stdout, stderr } = await execute(
              join(root, "target", profile, "reffect_generated"),
              [scenario],
              { cwd: root, timeout: 15000 },
            );
            const events = stderr
              .split("\n")
              .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
              .map((line) => (JSON.parse(line) as { message: string }).message);
            const rawResult = stdout.match(/^result=(.+)$/m)?.[1];
            expect({ events, result: rawResult === "()" ? "undefined" : rawResult }).toEqual(
              expected[scenario],
            );
            const futureSize = Number(stdout.match(/future-size=(\d+)/)?.[1]);
            const pointerSize = Number(stdout.match(/pointer-size=(\d+)/)?.[1]);
            expect(pointerSize).toBeGreaterThan(0);
            expect(futureSize).toBeGreaterThan(0);
            // These verified nested fixtures need inline child states, not repeated
            // owned copies at every group boundary. This is a regression budget,
            // rather than an ABI or a bound for arbitrary authored graphs.
            expect(futureSize).toBeLessThanOrEqual(2560 * pointerSize);
            expect(Number(stdout.match(/context-size=(\d+)/)?.[1])).toBeGreaterThan(0);
            const allocations = Number(stdout.match(/invocation-allocations=(\d+)/)?.[1]);
            expect(Number.isSafeInteger(allocations)).toBe(true);
            console.info(
              `Nested Deferred costs ${policy._tag}/${profile}/${scenario}: ${stdout
                .split("\n")
                .filter((line) => /^(future-size|context-size|invocation-allocations)=/.test(line))
                .join(", ")}`,
            );
            const frames = Number(stdout.match(/frames=(\d+)/)?.[1]);
            if (policy._tag === "None") expect(frames).toBe(0);
            else {
              const trail = stdout
                .split("\n")
                .filter((line) => line.startsWith("frame="))
                .map(
                  (line) =>
                    JSON.parse(line.slice(6)) as { readonly path: string; readonly kind: string },
                )
                .map(({ path, kind }) => ({ path, kind }));
              expect({
                frames: trail,
                omitted: Number(stdout.match(/omitted=(\d+)/)?.[1]),
              }).toEqual(
                scenario === "cancel"
                  ? {
                      frames: [
                        { path: "functions.cancel.body.body", kind: "all" },
                        { path: "functions.cancel.body", kind: "deferredScope" },
                        { path: "functions.cancel", kind: "function" },
                      ],
                      omitted: 0,
                    }
                  : { frames: [], omitted: 0 },
              );
            }
          }
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(0) + 180000,
);
