import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Logger, Ref } from "effect";
import { CurrentLogAnnotations, CurrentLogSpans } from "effect/References";
import { NodeServices } from "@effect/platform-node";
import { spawn } from "node:child_process";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  Computation,
  FailureFrames,
  R,
  Reference,
  Rust,
  SourceArtifacts,
  Source,
} from "../src/index.ts";
import { launch } from "../src/effect-ir.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const options = { concurrency: "unbounded", discard: true } as const;
interface RecordEvent {
  message: string;
  annotations: Record<string, unknown>;
  spans: string[];
}
interface Observation {
  succeeded: boolean;
  interrupted: boolean;
  records: RecordEvent[];
}
const cleanup = (name: string) =>
  R.Log.info(`${name}:start`).pipe(
    R.Effect.andThen(R.Effect.sleep(5)),
    R.Effect.andThen(R.Log.info(`${name}:done`)),
  );
const officialCleanup = (name: string) =>
  Effect.logInfo(`${name}:start`).pipe(
    Effect.andThen(Effect.sleep(5)),
    Effect.andThen(Effect.logInfo(`${name}:done`)),
  );
const child = (name: string, delay: number) =>
  R.Effect.addFinalizer(() => cleanup(`${name}:first`)).pipe(
    R.Effect.andThen(R.Effect.addFinalizer(() => cleanup(`${name}:second`))),
    R.Effect.andThen(R.Log.info(`${name}:started`)),
    R.Effect.andThen(R.Effect.sleep(delay)),
    R.Effect.andThen(R.Log.info(`${name}:completed`)),
    R.Effect.scoped,
    R.Effect.annotateLogs("child", R.U64.literal(name === "a" ? 1n : 2n)),
  );
const officialChild = (name: string, delay: number) =>
  Effect.addFinalizer(() => officialCleanup(`${name}:first`)).pipe(
    Effect.andThen(Effect.addFinalizer(() => officialCleanup(`${name}:second`))),
    Effect.andThen(Effect.logInfo(`${name}:started`)),
    Effect.andThen(Effect.sleep(delay)),
    Effect.andThen(Effect.logInfo(`${name}:completed`)),
    Effect.scoped,
    Effect.annotateLogs("child", name === "a" ? "1" : "2"),
  );
const surround = (body: Computation<void, never>) =>
  body.pipe(
    R.Effect.andThen(R.Log.info("parent:continued")),
    R.Effect.ensuring(cleanup("parent:cleanup")),
    R.Effect.annotateLogs("parent", R.U64.literal(7n)),
    R.Effect.withLogSpan("parent-span"),
  );
const officialSurround = (body: Effect.Effect<void>) =>
  body.pipe(
    Effect.andThen(Effect.logInfo("parent:continued")),
    Effect.ensuring(officialCleanup("parent:cleanup")),
    Effect.annotateLogs("parent", "7"),
    Effect.withLogSpan("parent-span"),
  );
const masked = (body: Computation<void, never>) =>
  surround(
    R.Effect.acquireUseRelease(
      body,
      () => R.Log.info("must-not-use"),
      () => R.Log.info("release"),
    ),
  );
const officialMasked = (body: Effect.Effect<void>) =>
  officialSurround(
    Effect.acquireUseRelease(
      body,
      () => Effect.logInfo("must-not-use"),
      () => Effect.logInfo("release"),
    ),
  );
const programs = {
  cancelMaskedAll: R.fn([], R.Unit, R.Never, () =>
    masked(R.Effect.all([child("a", 5), child("b", 5)], options)),
  ),
  cancelMaskedRace: R.fn([], R.Unit, R.Never, () =>
    masked(R.Effect.race(child("a", 60000), R.Log.info("winner"))),
  ),
  all: R.fn([], R.Unit, R.Never, () =>
    surround(
      R.Effect.all(
        [
          child("a", 1),
          child("b", 1),
          R.Ref.make(R.U64.literal(9n)).pipe(
            R.Effect.flatMap((cell) =>
              R.Ref.get(cell).pipe(
                R.Effect.flatMap((value) => R.Log.info("third", [["local", value]])),
              ),
            ),
          ),
        ],
        options,
      ),
    ),
  ),
  race: R.fn([], R.Unit, R.Never, () =>
    surround(R.Effect.race(child("a", 60000), R.Log.info("winner"))),
  ),
  cancelAll: R.fn([], R.Unit, R.Never, () =>
    surround(R.Effect.all([child("a", 60000), child("b", 60000)], options)),
  ),
  cancelRace: R.fn([], R.Unit, R.Never, () =>
    surround(child("a", 60000).pipe(R.Effect.race(R.Log.info("winner")))),
  ),
  immediate: R.fn([], R.Unit, R.Never, () =>
    R.Effect.race(R.Log.info("immediate"), R.Log.info("must-not-start")),
  ),
};
const oracles = {
  cancelMaskedAll: () =>
    officialMasked(Effect.all([officialChild("a", 5), officialChild("b", 5)], options)),
  cancelMaskedRace: () =>
    officialMasked(Effect.race(officialChild("a", 60000), Effect.logInfo("winner"))),
  all: () =>
    officialSurround(
      Effect.all(
        [
          officialChild("a", 1),
          officialChild("b", 1),
          Effect.gen(function* () {
            const cell = yield* Ref.make(9n);
            const value = yield* Ref.get(cell);
            yield* Effect.logInfo("third").pipe(Effect.annotateLogs("local", String(value)));
          }),
        ],
        options,
      ),
    ),
  race: () => officialSurround(Effect.race(officialChild("a", 60000), Effect.logInfo("winner"))),
  cancelAll: () =>
    officialSurround(Effect.all([officialChild("a", 60000), officialChild("b", 60000)], options)),
  cancelRace: () =>
    officialSurround(officialChild("a", 60000).pipe(Effect.race(Effect.logInfo("winner")))),
  immediate: () => Effect.race(Effect.logInfo("immediate"), Effect.logInfo("must-not-start")),
};
type Scenario = keyof typeof programs;
const gates: Partial<Record<Scenario, readonly string[]>> = {
  cancelAll: ["a:started", "b:started"],
  cancelMaskedAll: ["a:started", "b:started"],
  cancelMaskedRace: ["a:second:start"],
  cancelRace: ["a:second:start"],
};
const observe = <E>(body: Effect.Effect<void, E>, scenario: Scenario): Promise<Observation> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>();
        const records: RecordEvent[] = [];
        const logger = Logger.layer([
          Logger.make((event) => {
            records.push({
              message: String(event.message),
              annotations: Object.fromEntries(
                Object.entries(event.fiber.getRef(CurrentLogAnnotations)).map(([key, value]) => [
                  key,
                  typeof value === "bigint" ? String(value) : value,
                ]),
              ),
              spans: event.fiber.getRef(CurrentLogSpans).map(([label]) => label),
            });
            if (
              gates[scenario]?.every((message) =>
                records.some((record) => record.message === message),
              )
            )
              Deferred.doneUnsafe(reached, Effect.void);
          }),
        ]);
        const fiber = yield* body.pipe(Effect.provide(logger), Effect.forkScoped);
        if (gates[scenario]) {
          yield* Deferred.await(reached).pipe(Effect.timeout("5 seconds"));
          yield* Fiber.interrupt(fiber);
        }
        const exit = yield* Fiber.await(fiber);
        return {
          succeeded: Exit.isSuccess(exit),
          interrupted: Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause),
          records,
        };
      }),
    ),
  );
const messages = (observation: Observation) => observation.records.map((record) => record.message);
const ordered = (logs: readonly string[], before: string, after: string) => {
  expect(logs.filter((value) => value === before)).toHaveLength(1);
  expect(logs.filter((value) => value === after)).toHaveLength(1);
  expect(logs.indexOf(before)).toBeLessThan(logs.indexOf(after));
};
const assertContract = (observation: Observation, scenario: Scenario) => {
  const logs = messages(observation);
  expect(observation.interrupted).toBe(!!gates[scenario]);
  expect(observation.succeeded).toBe(!gates[scenario]);
  if (scenario === "immediate") {
    expect(logs).toEqual(["immediate"]);
    return;
  }
  const names =
    scenario === "all" || scenario === "cancelAll" || scenario === "cancelMaskedAll"
      ? ["a", "b"]
      : ["a"];
  for (const name of names) {
    ordered(logs, `${name}:started`, `${name}:second:start`);
    ordered(logs, `${name}:second:start`, `${name}:second:done`);
    ordered(logs, `${name}:second:done`, `${name}:first:start`);
    ordered(logs, `${name}:first:start`, `${name}:first:done`);
    ordered(logs, `${name}:first:done`, "parent:cleanup:start");
    if (scenario === "all" || scenario === "cancelMaskedAll")
      ordered(logs, `${name}:completed`, `${name}:second:start`);
    else expect(logs).not.toContain(`${name}:completed`);
  }
  ordered(logs, "parent:cleanup:start", "parent:cleanup:done");
  if (gates[scenario]) expect(logs).not.toContain("parent:continued");
  else for (const name of names) ordered(logs, `${name}:first:done`, "parent:continued");
  if (scenario === "race" || scenario === "cancelRace" || scenario === "cancelMaskedRace")
    ordered(logs, "winner", "a:second:start");
  if (scenario.startsWith("cancelMasked")) {
    expect(logs).not.toContain("must-not-use");
    for (const name of names) ordered(logs, `${name}:first:done`, "release");
    ordered(logs, "release", "parent:cleanup:start");
  }
  for (const event of observation.records) {
    expect(event.annotations.parent).toBe("7");
    expect(event.spans).toEqual(["parent-span"]);
    if (event.message.startsWith("a:")) expect(event.annotations.child).toBe("1");
    else if (event.message.startsWith("b:")) expect(event.annotations.child).toBe("2");
    else expect(event.annotations).not.toHaveProperty("child");
  }
};
const canonical = (observation: Observation) => ({
  succeeded: observation.succeeded,
  interrupted: observation.interrupted,
  records: [...observation.records].sort((a, b) => a.message.localeCompare(b.message)),
});
test("structured children independently suspend, drain LIFO cleanup and isolate inherited log context", async () => {
  for (const scenario of Object.keys(programs) as Scenario[]) {
    const oracle = await observe(oracles[scenario](), scenario);
    assertContract(oracle, scenario);
    const plain = await observe(Reference.run(programs[scenario], []), scenario);
    const framed = await observe(
      Reference.runWithFrames(programs[scenario], []).pipe(Effect.flatMap((result) => result.exit)),
      scenario,
    );
    for (const actual of [plain, framed]) {
      assertContract(actual, scenario);
      expect(canonical(actual)).toEqual(canonical(oracle));
    }
  }
});

const nativeProbe = `
use reffect_generated as r;
use std::io::Read;
use std::future::Future;
async fn cancel_pending<F:Future>(future:F,sender:tokio::sync::watch::Sender<bool>)->F::Output {
 tokio::pin!(future);
 // The parent first Pending follows input-order child admission, and for Race
 // its immediate winner, then the loser's masked cleanup suspension.
 std::future::poll_fn(|cx|match future.as_mut().poll(cx){
  std::task::Poll::Pending=>{sender.send(true).unwrap();std::task::Poll::Ready(())},
  _=>panic!("expected suspended task-group parent")
 }).await;
 future.await
}
#[tokio::main(flavor="current_thread")]
async fn main() {
 let scenario=std::env::args().nth(1).unwrap();
 let(sender,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 let result=if scenario=="cancelRace" {
  cancel_pending(r::r_cancelRace(&mut ctx),sender).await
 } else if scenario=="cancelMaskedAll" {
  cancel_pending(r::r_cancelMaskedAll(&mut ctx),sender).await
 } else if scenario=="cancelMaskedRace" {
  cancel_pending(r::r_cancelMaskedRace(&mut ctx),sender).await
 } else {
  if scenario=="cancelAll" {
   std::thread::spawn(move||{let mut byte=[0];std::io::stdin().read_exact(&mut byte).unwrap();sender.send(true).unwrap();});
  }
  match scenario.as_str(){
   "all"=>r::r_all(&mut ctx).await,"race"=>r::r_race(&mut ctx).await,
   "cancelAll"=>r::r_cancelAll(&mut ctx).await,
   "immediate"=>r::r_immediate(&mut ctx).await,_=>panic!("unknown scenario")}
 };
 println!("succeeded={},interrupted={}",result.is_ok(),matches!(result,Err(r::AsyncError::Interrupted)));
}
`;
const nativeObserve = (
  directory: string,
  profile: "debug" | "release",
  scenario: Scenario,
): Promise<Observation> =>
  new Promise((resolve, reject) => {
    const childProcess = spawn(
      "cargo",
      [
        "run",
        "--offline",
        "--quiet",
        ...(profile === "release" ? ["--release"] : []),
        "--",
        scenario,
      ],
      { cwd: directory, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let partial = "";
    let sent = false;
    const records: RecordEvent[] = [];
    const timeout = setTimeout(() => {
      childProcess.kill();
      reject(new Error(`native ${scenario} timeout: ${stderr}`));
    }, 15000);
    childProcess.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    childProcess.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      partial += String(chunk);
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith('{"schema":"reffect.log@1"')) continue;
        const event = JSON.parse(line);
        records.push({
          message: event.message,
          annotations: event.annotations,
          spans: event.spans.map((span: { label: string }) => span.label),
        });
      }
      if (
        scenario !== "cancelRace" &&
        !scenario.startsWith("cancelMasked") &&
        !sent &&
        gates[scenario]?.every((message) => records.some((record) => record.message === message))
      ) {
        sent = true;
        childProcess.stdin.write("x");
      }
    });
    childProcess.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    childProcess.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`native ${scenario} exited ${code}: ${stderr}`));
      else
        resolve({
          succeeded: stdout.includes("succeeded=true"),
          interrupted: stdout.includes("interrupted=true"),
          records,
        });
    });
  });
test(
  "native task groups await children on race and cancellation in debug/release with both frame policies",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-taskgroups-" });
          for (const frames of [FailureFrames.None, FailureFrames.Bounded]) {
            const artifact = yield* Compile.make(R.program(programs)).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withFailureFrames(frames),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.run,
            );
            const directory = yield* CargoApi.write(artifact, `${parent}/${frames._tag}`);
            yield* fs.writeFileString(`${directory}/src/main.rs`, nativeProbe);
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              for (const scenario of Object.keys(programs) as Scenario[]) {
                const actual = yield* Effect.tryPromise(() =>
                  nativeObserve(directory, profile, scenario),
                );
                assertContract(actual, scenario);
                const oracle = yield* Effect.tryPromise(() =>
                  observe(oracles[scenario](), scenario),
                );
                expect(canonical(actual)).toEqual(canonical(oracle));
              }
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 180000,
);

const compileBody = (body: Computation<void, never>) =>
  Compile.make(R.program({ main: R.fn([], R.Unit, R.Never, () => body) })).pipe(
    Compile.withTarget(Rust.tokio),
    Compile.run,
  );
test("task-group admission refuses unrepresented ownership, outcomes and host services", async () => {
  const group = (body: Computation<void, never>) => R.Effect.all([body, R.Effect.void], options);
  const refused = [
    group(group(R.Effect.void)),
    R.Effect.void.pipe(R.Effect.ensuring(group(R.Effect.void))),
    group(R.Random.next.pipe(R.Effect.asVoid)),
    group(R.Effect.addFinalizer(() => R.Effect.void)).pipe(R.Effect.scoped),
    R.Ref.make(R.U64.literal(1n)).pipe(
      R.Effect.flatMap((cell) => group(R.Ref.get(cell).pipe(R.Effect.asVoid))),
    ),
    group(launch([]).pipe(R.Effect.asVoid)),
    R.File.scoped("must-not-open", (handle) =>
      group(
        handle.size.pipe(
          R.Effect.catchAll(() => R.Effect.succeed(R.U64.literal(0n))),
          R.Effect.asVoid,
        ),
      ),
    ).pipe(R.Effect.catchAll(() => R.Effect.void)),
    group(R.Effect.void.pipe(R.Effect.ensuring(R.Random.next.pipe(R.Effect.asVoid)))),
    Computation.make(R.Unit, R.Never, {
      _tag: "TaskGroup",
      mode: "All",
      children: [R.Effect.void],
    }),
    Computation.make(R.Unit, R.Never, {
      _tag: "TaskGroup",
      mode: "Race",
      children: [
        R.Effect.succeed(R.U64.literal(1n)) as unknown as Computation<void, never>,
        R.Effect.void,
      ],
    }),
    Computation.make(R.Unit, R.Never, {
      _tag: "TaskGroup",
      mode: "All",
      children: [
        R.Effect.fail(R.Bool.literal(false)) as unknown as Computation<void, never>,
        R.Effect.void,
      ],
    }),
  ];
  for (const body of refused)
    expect(await Effect.runPromise(compileBody(body).pipe(Effect.isFailure))).toBe(true);
  expect(
    await Effect.runPromise(
      compileBody(group(R.Clock.currentTimeMillis.pipe(R.Effect.asVoid))).pipe(Effect.isSuccess),
    ),
  ).toBe(true);
  const clockProgram = R.program({
    main: R.fn([], R.Unit, R.Never, () => group(R.Clock.currentTimeMillis.pipe(R.Effect.asVoid))),
  });
  expect(
    await Effect.runPromise(
      Compile.make(clockProgram).pipe(
        Compile.withTarget(Rust.tokio),
        Compile.withRuntimeServices({ clock: "InjectedMillis" }),
        Compile.run,
        Effect.isFailure,
      ),
    ),
  ).toBe(true);
  for (const invalid of [
    { concurrency: 2, discard: true },
    { concurrency: "unbounded", discard: false },
    { ...options, mode: "result" },
    { ...options, unexpected: true },
  ]) {
    // Deliberately cross an untyped authoring boundary; runtime validation must still reject it.
    expect(() => R.Effect.all([R.Effect.void, R.Effect.void], invalid as typeof options)).toThrow();
  }
});

const allocationProbe = (group: boolean) => `
use reffect_generated as r;
use std::alloc::{GlobalAlloc,Layout,System};
use std::sync::atomic::{AtomicUsize,Ordering};
static ALLOCS:AtomicUsize=AtomicUsize::new(0);
static LIVE:AtomicUsize=AtomicUsize::new(0);
struct Counting;
unsafe impl GlobalAlloc for Counting {
 unsafe fn alloc(&self,l:Layout)->*mut u8{let p=System.alloc(l);if !p.is_null(){ALLOCS.fetch_add(1,Ordering::SeqCst);LIVE.fetch_add(1,Ordering::SeqCst);}p}
 unsafe fn dealloc(&self,p:*mut u8,l:Layout){LIVE.fetch_sub(1,Ordering::SeqCst);System.dealloc(p,l)}
 unsafe fn realloc(&self,p:*mut u8,l:Layout,n:usize)->*mut u8{let result=System.realloc(p,l,n);if !result.is_null(){ALLOCS.fetch_add(1,Ordering::SeqCst);}result}
}
#[global_allocator]static A:Counting=Counting;
#[tokio::main(flavor="current_thread")]
async fn main(){
 let(_sender,receiver)=tokio::sync::watch::channel(false);
 let before=ALLOCS.load(Ordering::SeqCst);
 let mut ctx=r::AsyncContext::new(receiver);
 let context_allocations=ALLOCS.load(Ordering::SeqCst)-before;
 let before=ALLOCS.load(Ordering::SeqCst);
 let bytes={let future=r::r_probe(&mut ctx);std::mem::size_of_val(&future)};
 let construction_allocations=ALLOCS.load(Ordering::SeqCst)-before;
 let before=ALLOCS.load(Ordering::SeqCst);let live=LIVE.load(Ordering::SeqCst);
 ${group ? "for _ in 0..100{assert!(r::r_probe(&mut ctx).await.is_ok());}" : ""}
 let setup_allocations=ALLOCS.load(Ordering::SeqCst)-before;
 let retained=LIVE.load(Ordering::SeqCst) as isize-live as isize;
 assert_eq!(context_allocations,0);assert_eq!(construction_allocations,0);assert_eq!(retained,0);
 ${group ? 'assert!(setup_allocations>=200,"two child watch tokens per group are included");' : ""}
 println!("cost:context={},future={},context_allocations={},unpolled_allocations={},groups=${group ? "100" : "0"},setup_allocations={},retained={}",std::mem::size_of_val(&ctx),bytes,context_allocations,construction_allocations,setup_allocations,retained);
}
`;
test(
  "unreachable task scaffolding is erased and group watch setup allocations are measured",
  async () => {
    const measurements: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-taskgroup-cost-" });
          for (const frames of [FailureFrames.None, FailureFrames.Bounded]) {
            for (const group of [false, true]) {
              const probe = R.fn([], R.Unit, R.Never, () =>
                group ? R.Effect.all([R.Effect.void, R.Effect.void], options) : R.Effect.sleep(1),
              );
              const artifact = yield* Compile.make(R.program({ probe })).pipe(
                Compile.withTarget(Rust.tokio),
                Compile.withFailureFrames(frames),
                Compile.withSourceArtifacts(SourceArtifacts.None),
                Compile.run,
              );
              const library = artifact.files["src/lib.rs"];
              if (!group) expect(library).not.toMatch(/task_group[23]|child_context|tokio::spawn/);
              expect(library).not.toContain("tokio::spawn");
              if (frames === FailureFrames.None) expect(library).not.toContain("Box<FrameTrail>");
              const directory = yield* CargoApi.write(
                artifact,
                `${parent}/${frames._tag}-${group}`,
              );
              yield* fs.writeFileString(`${directory}/src/main.rs`, allocationProbe(group));
              for (const profile of ["debug", "release"] as const) {
                yield* CargoApi.build(directory, profile);
                const result = yield* CargoApi.run(directory, "probe", [], profile);
                expect(result.stdout).toContain("unpolled_allocations=0");
                measurements.push(
                  `${frames._tag}/${profile}/${group ? "group" : "baseline"}: RustBytes=${Buffer.byteLength(library)}, ${result.stdout.trim()}`,
                );
              }
            }
          }
          const path = process.env.REFFECT_TASKGROUP_MEASUREMENTS;
          if (path) yield* fs.writeFileString(path, measurements.join("\n") + "\n");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 180000,
);

test("task-group provenance retains child occurrences independently of frame policy", async () => {
  const file = Source.file("task-group.ts", "all(first, second)");
  const first = R.Log.info("first").pipe(Source.at(Source.site(file, 4, 9)));
  const second = R.Effect.sleep(1).pipe(Source.at(Source.site(file, 11, 17)));
  const main = R.fn([], R.Unit, R.Never, () =>
    R.Effect.all([first, second], options).pipe(Source.at(Source.site(file, 0, 18))),
  );
  const base = Compile.make(R.program({ main })).pipe(
    Compile.withTarget(Rust.tokio),
    Compile.withFailureFrames(FailureFrames.None),
  );
  const mapped = await Effect.runPromise(base.pipe(Compile.run));
  const stripped = await Effect.runPromise(
    base.pipe(Compile.withSourceArtifacts(SourceArtifacts.None), Compile.run),
  );
  const origin = mapped.sources.origins.find((value) => value.kind === "TaskGroup");
  expect(origin?.definitions).toHaveLength(1);
  const groupOccurrence = mapped.sources.occurrences.find((value) => value.origin === origin?.id);
  expect(groupOccurrence).toBeDefined();
  expect(
    mapped.sources.occurrences
      .filter((value) => value.parent === groupOccurrence?.id)
      .map((value) => value.edge),
  ).toEqual(["children[0]", "children[1]"]);
  expect(mapped.sources.ranges.some((value) => value.origin === origin?.id)).toBe(true);
  expect(stripped.files).toEqual(mapped.files);
  expect(Object.hasOwn(stripped, "sources")).toBe(false);
});
