import { Cause, Effect, Exit, Fiber, FileSystem, Logger } from "effect";
import { TestClock } from "effect/testing";
import { NodeServices } from "@effect/platform-node";
import { spawn } from "node:child_process";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  FailureFrames,
  R,
  Reference,
  Rust,
  SourceArtifacts,
} from "../src/index.ts";
import type { Computation, EffectFn, Expr } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const options = { concurrency: "unbounded", discard: true } as const;
const cleanup = () =>
  R.Log.info("cleanup:start").pipe(
    R.Effect.andThen(R.Effect.sleep(20)),
    R.Effect.andThen(R.Log.info("cleanup:done")),
  );
const failing = <E>(error: Expr<E>) =>
  R.Effect.fail(error).pipe(R.Effect.asVoid, R.Effect.ensuring(cleanup()));
const recover = <E>(body: Computation<void, E>) =>
  body.pipe(R.Effect.catchAll(() => R.Log.info("caught")));
const sameError = () =>
  failing(R.U64.literal(7n)).pipe(
    R.Effect.catchAll((error) =>
      R.Log.info("caught").pipe(R.Effect.andThen(R.Effect.fail(error)), R.Effect.asVoid),
    ),
  );
const all = <E>(body: Computation<void, E>) => R.Effect.all([body, R.Effect.sleep(60000)], options);
const race = <E>(body: Computation<void, E>, winner = false) =>
  R.Effect.race(body, winner ? R.Log.info("winner") : R.Effect.sleep(60000));
const programs = {
  rootNever: R.fn([], R.Unit, R.Never, () => recover(failing(R.U64.literal(7n)))),
  rootSame: R.fn([], R.Unit, R.U64, sameError),
  maskedRecover: R.fn([], R.Unit, R.Never, () =>
    R.Effect.acquireUseRelease(
      recover(failing(R.U64.literal(7n))),
      () => R.Log.info("must-not-use"),
      () => R.Log.info("release"),
    ),
  ),
  rootRetry: R.fn([], R.Unit, R.U64, () =>
    R.Effect.retry(failing(R.U64.literal(7n)), R.Schedule.recurs(2)),
  ),
  allNever: R.fn([], R.Unit, R.Never, () => all(recover(failing(R.U64.literal(7n))))),
  allSame: R.fn([], R.Unit, R.U64, () => all(sameError())),
  allBool: R.fn([], R.Unit, R.Never, () => all(recover(failing(R.Bool.literal(false))))),
  allUnit: R.fn([], R.Unit, R.Never, () => all(recover(failing(R.Unit.literal())))),
  raceNever: R.fn([], R.Unit, R.Never, () => race(recover(failing(R.U64.literal(7n))))),
  raceSame: R.fn([], R.Unit, R.U64, () => race(sameError())),
  raceWinner: R.fn([], R.Unit, R.Never, () => race(recover(failing(R.U64.literal(7n))), true)),
  cancelRaceWinner: R.fn([], R.Unit, R.Never, () =>
    race(recover(failing(R.U64.literal(7n))), true),
  ),
};
type Scenario = keyof typeof programs;
const scenarios = Object.keys(programs) as Scenario[];
const cancels = (scenario: Scenario) => scenario !== "raceWinner";

// These official programs never inspect the R graph or use its interpreter.
const officialCleanup = () =>
  Effect.logInfo("cleanup:start").pipe(
    Effect.andThen(Effect.sleep(20)),
    Effect.andThen(Effect.logInfo("cleanup:done")),
  );
const officialFail = <E>(error: E) =>
  Effect.fail(error).pipe(Effect.asVoid, Effect.ensuring(officialCleanup()));
const officialRecover = <E>(body: Effect.Effect<void, E>) =>
  body.pipe(Effect.catch(() => Effect.logInfo("caught")));
const officialSame = () =>
  officialFail(7n).pipe(
    Effect.catch((error) =>
      Effect.logInfo("caught").pipe(Effect.andThen(Effect.fail(error)), Effect.asVoid),
    ),
  );
const officialAll = <E>(body: Effect.Effect<void, E>) =>
  Effect.all([body, Effect.sleep(60000)], options);
const officialRace = <E>(body: Effect.Effect<void, E>, winner = false) =>
  Effect.race(body, winner ? Effect.logInfo("winner") : Effect.sleep(60000));
const oracles = {
  rootNever: () => officialRecover(officialFail(7n)),
  rootSame: officialSame,
  maskedRecover: () =>
    Effect.acquireUseRelease(
      officialRecover(officialFail(7n)),
      () => Effect.logInfo("must-not-use"),
      () => Effect.logInfo("release"),
    ),
  rootRetry: () => Effect.retry(officialFail(7n), { times: 2 }),
  allNever: () => officialAll(officialRecover(officialFail(7n))),
  allSame: () => officialAll(officialSame()),
  allBool: () => officialAll(officialRecover(officialFail(false))),
  allUnit: () => officialAll(officialRecover(officialFail(undefined))),
  raceNever: () => officialRace(officialRecover(officialFail(7n))),
  raceSame: () => officialRace(officialSame()),
  raceWinner: () => officialRace(officialRecover(officialFail(7n)), true),
  cancelRaceWinner: () => officialRace(officialRecover(officialFail(7n)), true),
};
interface Observation {
  reasons: string[];
  events: string[];
}
const projectFailure = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "error" in error && "frames" in error)
    return projectFailure(error.error);
  return `Fail:${String(error)}`;
};
const observe = (body: Effect.Effect<void, unknown>, scenario: Scenario): Promise<Observation> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events: string[] = [];
        const logger = Logger.layer([Logger.make((event) => events.push(String(event.message)))]);
        const fiber = yield* body.pipe(Effect.provide(logger), Effect.forkScoped);
        yield* TestClock.adjust(0);
        expect(events).toContain("cleanup:start");
        expect(events).not.toContain("cleanup:done");
        if (cancels(scenario)) fiber.interruptUnsafe();
        yield* TestClock.adjust(100);
        const exit = yield* Fiber.await(fiber);
        return {
          events,
          reasons: Exit.isSuccess(exit)
            ? ["Success"]
            : exit.cause.reasons.map((reason) => {
                if (Cause.isInterruptReason(reason)) return "Interrupt";
                if (Cause.isFailReason(reason)) return projectFailure(reason.error);
                throw new Error(`Unexpected oracle defect: ${String(reason)}`);
              }),
        };
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
const expected: Record<Scenario, string[]> = {
  rootNever: ["Fail:7"],
  rootSame: ["Fail:7"],
  rootRetry: ["Fail:7"],
  maskedRecover: ["Interrupt"],
  allNever: ["Interrupt", "Fail:7"],
  allSame: ["Interrupt", "Fail:7"],
  allBool: ["Interrupt", "Fail:false"],
  allUnit: ["Interrupt", "Fail:undefined"],
  raceNever: ["Interrupt"],
  raceSame: ["Interrupt"],
  raceWinner: ["Success"],
  cancelRaceWinner: ["Interrupt"],
};
const contract = (actual: Observation, scenario: Scenario) => {
  expect(actual.reasons).toEqual(expected[scenario]);
  if (scenario === "maskedRecover") {
    expect(actual.events).toContain("caught");
    expect(actual.events).toContain("release");
    expect(actual.events).not.toContain("must-not-use");
  } else expect(actual.events).not.toContain("caught");
  expect(actual.events.filter((event) => event === "cleanup:start")).toHaveLength(1);
  expect(actual.events.filter((event) => event === "cleanup:done")).toHaveLength(1);
  expect(actual.events.indexOf("cleanup:start")).toBeLessThan(
    actual.events.indexOf("cleanup:done"),
  );
  if (scenario.endsWith("RaceWinner") || scenario === "raceWinner")
    expect(actual.events.indexOf("winner")).toBeLessThan(actual.events.indexOf("cleanup:done"));
};
test("retained outcomes match independently authored Effect under controlled cancellation", async () => {
  for (const scenario of scenarios) {
    const oracle = await observe(oracles[scenario](), scenario);
    contract(oracle, scenario);
    const selected: EffectFn<readonly [], void, unknown> = programs[scenario];
    for (const body of [
      Reference.run(selected, []),
      Reference.runWithFrames(selected, []).pipe(Effect.flatMap((result) => result.exit)),
    ]) {
      const actual = await observe(body, scenario);
      contract(actual, scenario);
      expect(actual).toEqual(oracle);
    }
  }
});

const nativeProbe = `
use reffect_generated as r;
use std::future::Future;
use std::pin::Pin;
async fn once<F:Future>(mut future:Pin<&mut F>)->Option<F::Output>{
 std::future::poll_fn(|cx|std::task::Poll::Ready(match future.as_mut().poll(cx){
  std::task::Poll::Ready(output)=>Some(output),std::task::Poll::Pending=>None
 })).await
}
async fn drive<F:Future>(future:F,sender:&tokio::sync::watch::Sender<bool>,cancel:bool)->F::Output{
 tokio::pin!(future);
 let mut result=once(future.as_mut()).await;
 assert!(result.is_none(),"fixture must suspend in cleanup");
 if cancel{sender.send(true).unwrap();result=once(future.as_mut()).await;}
 tokio::time::advance(std::time::Duration::from_millis(100)).await;
 if result.is_none(){result=once(future.as_mut()).await;}
 match result{Some(output)=>output,None=>future.await}
}
fn observe<E:std::fmt::Debug>(result:Result<(),r::AsyncError<E>>){
 match result{
  Ok(())=>println!("reason=Success"),
  Err(r::AsyncError::Interrupted)=>println!("reason=Interrupt"),
  Err(r::AsyncError::Fail(error))=>println!("reason=Fail:{:?}",error),
  Err(r::AsyncError::Combined(cause))=>{
   if cause.interrupted{println!("reason=Interrupt");}
   for reason in cause.failures[..cause.len].iter().flatten(){match reason{
    r::RuntimeFailure::Bool(value)=>println!("reason=Fail:{}",value),
    r::RuntimeFailure::U64(value)=>println!("reason=Fail:{}",value),
    r::RuntimeFailure::Unit=>println!("reason=Fail:undefined")
   }}
  }
 }
}
#[tokio::main(flavor="current_thread")]
async fn main(){
 tokio::time::pause();
 let scenario=std::env::args().nth(1).unwrap();
 let(sender,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 let cancel=scenario!="raceWinner";
 match scenario.as_str(){
 ${scenarios.map((scenario) => `"${scenario}"=>observe(drive(r::r_${scenario}(&mut ctx),&sender,cancel).await),`).join("\n ")}
 _=>panic!("unknown scenario")
 }
 FRAME_PROBE
}
`;
const nativeObserve = (
  directory: string,
  profile: "debug" | "release",
  scenario: Scenario,
): Promise<Observation & { frames: number }> =>
  new Promise((resolve, reject) => {
    const child = spawn(`${directory}/target/${profile}/reffect_generated`, [scenario], {
      cwd: directory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`native ${scenario} timed out: ${stderr}`));
    }, 15000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`native ${scenario} exited ${code}: ${stderr}`));
      const events = stderr
        .split("\n")
        .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
        .map((line) => (JSON.parse(line) as { message: string }).message);
      resolve({
        reasons: stdout
          .split("\n")
          .filter((line) => line.startsWith("reason="))
          .map((line) => line.slice(7)),
        events,
        frames: Number(stdout.match(/frames=(\d+)/)?.[1] ?? 0),
      });
    });
  });
test(
  "native retained outcomes preserve root and task policies across build and frame profiles",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-retained-" });
          for (const frames of [FailureFrames.None, FailureFrames.Bounded]) {
            const artifact = yield* Compile.make(R.program(programs)).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withFailureFrames(frames),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.run,
            );
            const directory = yield* CargoApi.write(artifact, `${parent}/${frames._tag}`);
            const manifest = yield* fs.readFileString(`${directory}/Cargo.toml`);
            yield* fs.writeFileString(
              `${directory}/Cargo.toml`,
              manifest.replace('"macros",', '"test-util", "macros",'),
            );
            yield* fs.writeFileString(
              `${directory}/src/main.rs`,
              nativeProbe.replace(
                "FRAME_PROBE",
                frames._tag === "None"
                  ? 'println!("frames=0");'
                  : 'println!("frames={}",ctx.take_frames().0.len());',
              ),
            );
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              for (const scenario of scenarios) {
                const actual = yield* Effect.tryPromise(() =>
                  nativeObserve(directory, profile, scenario),
                );
                const oracle = yield* Effect.tryPromise(() =>
                  observe(oracles[scenario](), scenario),
                );
                contract(actual, scenario);
                const { frames: frameCount, ...semantic } = actual;
                expect(semantic).toEqual(oracle);
                if (frames._tag === "None") expect(frameCount).toBe(0);
                else if (actual.reasons[0] !== "Success") expect(frameCount).toBeGreaterThan(0);
              }
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 180000,
);
