import { Cause, Effect, Exit, Fiber, FileSystem, Logger, Option } from "effect";
import { TestClock } from "effect/testing";
import * as References from "effect/References";
import { NodeServices } from "@effect/platform-node";
import { spawn } from "node:child_process";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  CompileError,
  Computation,
  EffectFn,
  Expr,
  FailureFrames,
  NativeRunner,
  R,
  Reference,
  Rust,
  SourceArtifacts,
} from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const options = { concurrency: "unbounded", discard: true } as const;
const cleanup = (name: string, delay: number) =>
  R.Log.info(`${name}:cleanup:start`).pipe(
    R.Effect.andThen(R.Effect.sleep(delay)),
    R.Effect.andThen(R.Log.info(`${name}:cleanup:done`)),
  );
const scalarFailChild = <E>(name: string, error: Expr<E>, delay: number, masked = false) => {
  const body = R.Log.info(`${name}:started`).pipe(
    R.Effect.andThen(R.Effect.fail(error)),
    R.Effect.asVoid,
    R.Effect.ensuring(cleanup(name, delay)),
  );
  return masked
    ? R.Effect.acquireUseRelease(
        body,
        () => R.Effect.void,
        () => R.Effect.void,
      )
    : body;
};
const failChild = (name: string, error: bigint, delay: number, masked = false) =>
  scalarFailChild(name, R.U64.literal(error), delay, masked);
const pending = (cleanupDelay = 10) =>
  R.Log.info("pending:started").pipe(
    R.Effect.andThen(R.Effect.sleep(60000)),
    R.Effect.ensuring(cleanup("pending", cleanupDelay)),
  );
const surround = <E>(body: Computation<void, E>) =>
  body.pipe(
    R.Effect.andThen(R.Log.info("parent:continued")),
    R.Effect.ensuring(cleanup("parent", 1)),
  );
const pair = (duplicate = false) =>
  [failChild("a", 1n, 20, true), failChild("b", duplicate ? 1n : 2n, 10, true)] as const;
const allFailure = () => R.Effect.all(pair(), options);
const mixedAll = () => R.Effect.all([failChild("a", 7n, 20), pending()], options);
const mixedRace = () => R.Effect.race(failChild("a", 7n, 20), pending());
const recover = (body: Computation<void, bigint>) =>
  body.pipe(R.Effect.catchAll((error) => R.Log.info("caught", [["error", error]])));
const programs = {
  allFailure: R.fn([], R.Unit, R.U64, () => surround(allFailure())),
  allDuplicate: R.fn([], R.Unit, R.U64, () => surround(R.Effect.all(pair(true), options))),
  allThreeFailure: R.fn([], R.Unit, R.U64, () =>
    surround(R.Effect.all([...pair(), failChild("c", 3n, 5, true)], options)),
  ),
  allBoolFailure: R.fn([], R.Unit, R.Bool, () =>
    surround(
      R.Effect.all([scalarFailChild("a", R.Bool.literal(false), 20), R.Effect.void], options),
    ),
  ),
  allUnitFailure: R.fn([], R.Unit, R.Unit, () =>
    surround(R.Effect.all([scalarFailChild("a", R.Unit.literal(), 20), R.Effect.void], options)),
  ),
  raceFailure: R.fn([], R.Unit, R.U64, () => surround(R.Effect.race(...pair()))),
  raceDuplicate: R.fn([], R.Unit, R.U64, () => surround(R.Effect.race(...pair(true)))),
  allRecover: R.fn([], R.Unit, R.Never, () => surround(recover(allFailure()))),
  cancelAll: R.fn([], R.Unit, R.U64, () => surround(mixedAll())),
  cancelAllRecover: R.fn([], R.Unit, R.Never, () => surround(recover(mixedAll()))),
  cancelAllResult: R.fn([], R.Unit, R.Never, () =>
    surround(mixedAll().pipe(R.Effect.result, R.Effect.asVoid)),
  ),
  cancelRace: R.fn([], R.Unit, R.U64, () => surround(mixedRace())),
  cancelAllDrain: R.fn([], R.Unit, R.U64, () =>
    surround(R.Effect.all([failChild("a", 7n, 5), pending(20)], options)),
  ),
  cancelRaceWinner: R.fn([], R.Unit, R.U64, () =>
    surround(R.Effect.race(failChild("a", 7n, 20), R.Log.info("winner"))),
  ),
  cancelMaskedRecover: R.fn([], R.Unit, R.Never, () =>
    surround(
      R.Effect.acquireUseRelease(
        recover(allFailure()),
        () => R.Log.info("must-not-use"),
        () => R.Log.info("release"),
      ),
    ),
  ),
  immediateAll: R.fn([], R.Unit, R.U64, () =>
    R.Effect.all([R.Effect.fail(R.U64.literal(5n)).pipe(R.Effect.asVoid), pending()], options),
  ),
  raceSuccess: R.fn([], R.Unit, R.U64, () =>
    surround(R.Effect.race(failChild("a", 7n, 20), R.Log.info("winner"))),
  ),
};
type Scenario = keyof typeof programs;
const scenarios = Object.keys(programs) as Scenario[];
const cancels = (scenario: Scenario) => scenario.startsWith("cancel");

// Official programs deliberately do not interpret or inspect the R graph.
const officialCleanup = (name: string, delay: number) =>
  Effect.logInfo(`${name}:cleanup:start`).pipe(
    Effect.andThen(Effect.sleep(delay)),
    Effect.andThen(Effect.logInfo(`${name}:cleanup:done`)),
  );
const officialFail = <E>(name: string, error: E, delay: number, masked = false) => {
  const body = Effect.logInfo(`${name}:started`).pipe(
    Effect.andThen(Effect.fail(error)),
    Effect.asVoid,
    Effect.ensuring(officialCleanup(name, delay)),
  );
  return masked
    ? Effect.acquireUseRelease(
        body,
        () => Effect.void,
        () => Effect.void,
      )
    : body;
};
const officialPending = (cleanupDelay = 10) =>
  Effect.logInfo("pending:started").pipe(
    Effect.andThen(Effect.sleep(60000)),
    Effect.ensuring(officialCleanup("pending", cleanupDelay)),
  );
const officialSurround = <E>(body: Effect.Effect<void, E>) =>
  body.pipe(
    Effect.andThen(Effect.logInfo("parent:continued")),
    Effect.ensuring(officialCleanup("parent", 1)),
  );
const officialPair = (duplicate = false) =>
  [officialFail("a", 1n, 20, true), officialFail("b", duplicate ? 1n : 2n, 10, true)] as const;
const officialMixed = () => Effect.all([officialFail("a", 7n, 20), officialPending()], options);
const officialRecover = (body: Effect.Effect<void, bigint>) =>
  body.pipe(
    Effect.catch((error) => Effect.logInfo("caught").pipe(Effect.annotateLogs("error", error))),
  );
const oracles = {
  allFailure: () => officialSurround(Effect.all(officialPair(), options)),
  allDuplicate: () => officialSurround(Effect.all(officialPair(true), options)),
  allThreeFailure: () =>
    officialSurround(Effect.all([...officialPair(), officialFail("c", 3n, 5, true)], options)),
  allBoolFailure: () =>
    officialSurround(Effect.all([officialFail("a", false, 20), Effect.void], options)),
  allUnitFailure: () =>
    officialSurround(Effect.all([officialFail("a", undefined, 20), Effect.void], options)),
  raceFailure: () => officialSurround(Effect.race(...officialPair())),
  raceDuplicate: () => officialSurround(Effect.race(...officialPair(true))),
  allRecover: () => officialSurround(officialRecover(Effect.all(officialPair(), options))),
  cancelAll: () => officialSurround(officialMixed()),
  cancelAllRecover: () => officialSurround(officialRecover(officialMixed())),
  cancelAllResult: () => officialSurround(officialMixed().pipe(Effect.result, Effect.asVoid)),
  cancelRace: () => officialSurround(Effect.race(officialFail("a", 7n, 20), officialPending())),
  cancelAllDrain: () =>
    officialSurround(Effect.all([officialFail("a", 7n, 5), officialPending(20)], options)),
  cancelRaceWinner: () =>
    officialSurround(Effect.race(officialFail("a", 7n, 20), Effect.logInfo("winner"))),
  cancelMaskedRecover: () =>
    officialSurround(
      Effect.acquireUseRelease(
        officialRecover(Effect.all(officialPair(), options)),
        () => Effect.logInfo("must-not-use"),
        () => Effect.logInfo("release"),
      ),
    ),
  immediateAll: () => Effect.all([Effect.fail(5n).pipe(Effect.asVoid), officialPending()], options),
  raceSuccess: () =>
    officialSurround(Effect.race(officialFail("a", 7n, 20), Effect.logInfo("winner"))),
};
interface Observation {
  reasons: string[];
  events: string[];
  caught: string[];
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
        const caught: string[] = [];
        const logger = Logger.layer([
          Logger.make((event) => {
            events.push(String(event.message));
            if (String(event.message) === "caught") {
              // A scalar observation; log annotation storage is separate from the failure value.
              caught.push(String(event.fiber.getRef(References.CurrentLogAnnotations).error));
            }
          }),
        ]);
        const fiber = yield* body.pipe(Effect.provide(logger), Effect.forkScoped);
        yield* TestClock.adjust(0);
        if (scenario === "cancelAllDrain") yield* TestClock.adjust(6);
        if (cancels(scenario)) fiber.interruptUnsafe();
        for (const increment of [5, 5, 10, 100]) yield* TestClock.adjust(increment);
        const exit = yield* Fiber.await(fiber);
        return {
          events,
          caught,
          reasons: Exit.isSuccess(exit)
            ? ["Success"]
            : exit.cause.reasons.map((reason) => {
                if (Cause.isFailReason(reason)) return projectFailure(reason.error);
                if (Cause.isInterruptReason(reason)) return "Interrupt";
                throw new Error(`Unexpected oracle defect: ${String(reason)}`);
              }),
        };
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
const expected: Record<Scenario, string[]> = {
  allFailure: ["Fail:2", "Fail:1"],
  allDuplicate: ["Fail:1"],
  allThreeFailure: ["Fail:3", "Fail:2", "Fail:1"],
  allBoolFailure: ["Fail:false"],
  allUnitFailure: ["Fail:undefined"],
  raceFailure: ["Fail:2", "Fail:1"],
  raceDuplicate: ["Fail:1", "Fail:1"],
  allRecover: ["Success"],
  cancelAll: ["Interrupt", "Fail:7"],
  cancelAllRecover: ["Interrupt", "Fail:7"],
  cancelAllResult: ["Interrupt", "Fail:7"],
  cancelRace: ["Interrupt"],
  cancelAllDrain: ["Interrupt", "Fail:7"],
  cancelRaceWinner: ["Interrupt"],
  cancelMaskedRecover: ["Interrupt"],
  immediateAll: ["Fail:5"],
  raceSuccess: ["Success"],
};
const contract = (actual: Observation, scenario: Scenario) => {
  expect(actual.reasons).toEqual(expected[scenario]);
  expect(actual.caught).toEqual(
    ["allRecover", "cancelMaskedRecover"].includes(scenario) ? ["2"] : [],
  );
  if (scenario === "immediateAll") {
    expect(actual.events).toEqual([]);
    return;
  }
  const index = (event: string) => {
    expect(actual.events.filter((value) => value === event)).toHaveLength(1);
    return actual.events.indexOf(event);
  };
  expect(index("a:cleanup:start")).toBeLessThan(index("a:cleanup:done"));
  expect(index("a:cleanup:done")).toBeLessThan(index("parent:cleanup:start"));
  expect(index("parent:cleanup:start")).toBeLessThan(index("parent:cleanup:done"));
  if (
    [
      "allFailure",
      "allThreeFailure",
      "raceFailure",
      "allDuplicate",
      "raceDuplicate",
      "allRecover",
    ].includes(scenario)
  )
    expect(index("b:cleanup:done")).toBeLessThan(index("a:cleanup:done"));
  if (scenario === "allThreeFailure")
    expect(index("c:cleanup:done")).toBeLessThan(index("b:cleanup:done"));
  if (cancels(scenario)) expect(actual.events).not.toContain("parent:continued");
  if (scenario === "cancelAllDrain")
    expect(index("a:cleanup:done")).toBeLessThan(index("pending:cleanup:start"));
  if (
    ["cancelAll", "cancelAllRecover", "cancelAllResult", "cancelAllDrain", "cancelRace"].includes(
      scenario,
    )
  )
    expect(index("pending:cleanup:done")).toBeLessThan(index("parent:cleanup:start"));
  if (scenario === "cancelRaceWinner")
    expect(index("winner")).toBeLessThan(index("a:cleanup:done"));
  if (scenario === "cancelMaskedRecover") {
    expect(actual.events).not.toContain("must-not-use");
    expect(index("caught")).toBeLessThan(index("release"));
    expect(index("release")).toBeLessThan(index("parent:cleanup:start"));
  }
};
test("fallible task reference preserves ordered multiple causes and cancellation recovery suppression", async () => {
  for (const scenario of scenarios) {
    const oracle = await observe(oracles[scenario](), scenario);
    contract(oracle, scenario);
    const selected: EffectFn<readonly [], void, unknown> = programs[scenario];
    const plain = await observe(Reference.run(selected, []), scenario);
    const framed = await observe(
      Reference.runWithFrames(selected, []).pipe(Effect.flatMap((result) => result.exit)),
      scenario,
    );
    for (const actual of [plain, framed]) {
      contract(actual, scenario);
      expect(actual).toEqual(oracle);
    }
  }
});

test("interruption-retained recovery refuses composite payloads while legacy recovery stays admitted", async () => {
  const payload = R.Struct({ code: R.U64 });
  const mapped = (body: Computation<void, bigint>) =>
    body.pipe(R.Effect.mapError((error) => payload.make({ code: error })));
  const refused = R.fn([], R.Unit, R.Never, () =>
    mapped(allFailure()).pipe(R.Effect.catchAll(() => R.Effect.void)),
  );
  const rejected = await Effect.runPromise(
    Effect.exit(
      Compile.make(R.program({ refused })).pipe(Compile.withTarget(Rust.tokio), Compile.run),
    ),
  );
  expect(Exit.isFailure(rejected)).toBe(true);
  if (Exit.isFailure(rejected)) {
    const error = Option.getOrThrow(Cause.findErrorOption(rejected.cause));
    expect(error).toBeInstanceOf(CompileError);
    expect(error.diagnostics.some((diagnostic) => diagnostic.code === "TASK_GROUP_RECOVERY")).toBe(
      true,
    );
  }
  const legacy = R.fn([], R.Unit, R.Never, () =>
    mapped(R.Effect.fail(R.U64.literal(1n)).pipe(R.Effect.asVoid)).pipe(
      R.Effect.catchAll(() => R.Effect.void),
    ),
  );
  expect(
    await Effect.runPromise(
      Effect.exit(
        Compile.make(R.program({ legacy })).pipe(Compile.withTarget(Rust.tokio), Compile.run),
      ),
    ).then(Exit.isSuccess),
  ).toBe(true);
  const strings = R.Effect.fail(R.String.literal("owned")).pipe(R.Effect.asVoid);
  expect(() => R.Effect.all([strings, R.Effect.void], options)).toThrow();
});

const nativeProbe = `
use reffect_generated as r;
use std::future::Future;
use std::pin::Pin;
async fn once<F:Future>(mut future:Pin<&mut F>)->Option<F::Output> {
 std::future::poll_fn(|cx|std::task::Poll::Ready(match future.as_mut().poll(cx){
  std::task::Poll::Ready(output)=>Some(output),std::task::Poll::Pending=>None
 })).await
}
async fn drive<F:Future>(future:F,sender:&tokio::sync::watch::Sender<bool>,cancel:bool,drain:bool)->F::Output {
 tokio::pin!(future);
 let mut result=once(future.as_mut()).await;
 if drain {
  // Cross the timer boundary: Tokio's timer wheel rounds deadlines to milliseconds.
  assert!(result.is_none()); tokio::time::advance(std::time::Duration::from_millis(6)).await;
  result=once(future.as_mut()).await;
 }
 if cancel {
  assert!(result.is_none(),"cancellation fixture must suspend"); sender.send(true).unwrap();
  // Deliver cancellation before advancing time so loser cleanup starts at time zero.
  result=once(future.as_mut()).await;
 }
 for increment in [5,5,10,100] {
  if result.is_none() {
   tokio::time::advance(std::time::Duration::from_millis(increment)).await;
   result=once(future.as_mut()).await;
  }
 }
 match result {Some(output)=>output,None=>future.await}
}
fn observe<E:std::fmt::Debug>(result:Result<(),r::AsyncError<E>>) {
 match result {
  Ok(())=>println!("reason=Success"),
  Err(r::AsyncError::Interrupted)=>println!("reason=Interrupt"),
  Err(r::AsyncError::Fail(error))=>println!("reason=Fail:{:?}",error),
  Err(r::AsyncError::Combined(cause))=>{
   if cause.interrupted {println!("reason=Interrupt");}
   for reason in cause.failures[..cause.len].iter().flatten() {
    match reason {
     r::RuntimeFailure::Bool(value)=>println!("reason=Fail:{}",value),
     r::RuntimeFailure::U64(value)=>println!("reason=Fail:{}",value),
     r::RuntimeFailure::Unit=>println!("reason=Fail:undefined")
    }
   }
  }
 }
}
#[tokio::main(flavor="current_thread")]
async fn main(){
 tokio::time::pause();
 let scenario=std::env::args().nth(1).unwrap();
 let(sender,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 let cancel=scenario.starts_with("cancel");
 let drain=scenario=="cancelAllDrain";
 match scenario.as_str(){
 ${scenarios.map((scenario) => `"${scenario}"=>observe(drive(r::r_${scenario}(&mut ctx),&sender,cancel,drain).await),`).join("\n ")}
 _=>panic!("unknown scenario")
 }
 FRAME_PROBE
}
`;
const cliFailure = R.fn([], R.Unit, R.U64, () =>
  R.Effect.race(
    R.Effect.fail(R.U64.literal(1n)).pipe(R.Effect.asVoid),
    R.Effect.fail(R.U64.literal(2n)).pipe(R.Effect.asVoid),
  ),
);
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
      const logs = stderr
        .split("\n")
        .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
        .map((line) => JSON.parse(line) as { message: string; annotations: { error?: unknown } });
      resolve({
        reasons: stdout
          .split("\n")
          .filter((line) => line.startsWith("reason="))
          .map((line) => line.slice(7)),
        events: logs.map((event) => event.message),
        caught: logs
          .filter((event) => event.message === "caught")
          .map((event) => String(event.annotations.error)),
        frames: Number(stdout.match(/frames=(\d+)/)?.[1] ?? 0),
      });
    });
  });
test(
  "native fallible tasks retain scalar causes and await cleanup with controlled virtual time",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-fallible-" });
          for (const frames of [FailureFrames.None, FailureFrames.Bounded]) {
            const artifact = yield* Compile.make(R.program({ ...programs, cliFailure })).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withFailureFrames(frames),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.run,
            );
            const directory = yield* CargoApi.write(artifact, `${parent}/${frames._tag}`);
            yield* CargoApi.build(directory, "debug");
            const cliExit = yield* NativeRunner.run(
              artifact,
              directory,
              "cliFailure",
              cliFailure,
              [],
            );
            expect(Exit.isFailure(cliExit)).toBe(true);
            if (Exit.isFailure(cliExit)) {
              expect(
                cliExit.cause.reasons.map((reason) => {
                  if (!Cause.isFailReason(reason))
                    throw new Error("CLI lost a represented typed reason");
                  return reason.error;
                }),
              ).toEqual([1n, 2n]);
            }
            if (frames._tag === "Bounded") {
              const framed = yield* NativeRunner.runWithFrames(
                artifact,
                directory,
                "cliFailure",
                cliFailure,
                [],
              );
              expect(Exit.isFailure(framed.exit)).toBe(true);
              expect(framed.frames.length).toBeGreaterThan(0);
            }
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
