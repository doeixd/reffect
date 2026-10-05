import { Cause, Context, Deferred, Effect, Exit, Fiber, Logger, Scheduler } from "effect";
import { expect, test } from "vite-plus/test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { R, FailureFrames, SourceArtifacts, Rust } from "../src/index.ts";
import type { LogicalFrame } from "../src/effect-ir.ts";
import { DeferredIR as D } from "../src/deferred.ts";
import { DeferredExecution } from "../src/deferred-execution.ts";
import { GeneratedDeferredReference } from "../src/deferred-generated-reference.ts";
import { DeferredInterruptionFrames } from "../src/deferred-interruption-frames.ts";
import { analyzeDeferredBudget, defaultDeferredBudgetContext } from "../src/deferred-budget.ts";
import { emitFunctions, lowerDeferredFunctions } from "../src/lower.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const execute = promisify(execFile);
const cleanup = R.Log.info("cleanup:start").pipe(
  R.Effect.andThen(R.Effect.sleep(1)),
  R.Effect.andThen(R.Log.info("cleanup:done")),
);
const officialCleanup = Effect.logInfo("cleanup:start").pipe(
  Effect.andThen(Effect.sleep(1)),
  Effect.andThen(Effect.logInfo("cleanup:done")),
);
const programs = {
  wait: R.fn([], R.Unit, R.Never, () => D.make(R.Unit).pipe(R.Effect.flatMap(D.await))),
  sleep: R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(R.Effect.flatMap(() => R.Effect.sleep(100))),
  ),
  wrapped: R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap((cell) =>
        R.Match.bool(
          R.Bool.literal(false),
          R.Effect.succeed(R.Unit.literal()),
          D.await(cell).pipe(
            R.Effect.map((value) => value),
            R.Effect.ensuring(cleanup),
          ),
        ),
      ),
    ),
  ),
  deep: R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap((cell) => {
        let body = D.await(cell);
        for (let i = 0; i < 40; i++) body = R.Effect.map(body, (value) => value);
        return body;
      }),
    ),
  ),
  group: R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap((cell) =>
        R.Effect.all([D.await(cell), R.Effect.sleep(100)], {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    ),
  ),
  sharedLeaf: R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap(() => {
        const sleep = R.Effect.sleep(100);
        return R.Match.bool(R.Bool.literal(false), sleep, sleep.withSource(sleep.source));
      }),
    ),
  ),
  sharedParent: R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap(() => {
        const mapped = R.Effect.sleep(100).pipe(R.Effect.map((value) => value));
        return R.Match.bool(R.Bool.literal(false), mapped, mapped.withSource(mapped.source));
      }),
    ),
  ),
  flatMapScope: R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap(() => {
        const sleep = R.Effect.sleep(100);
        return R.Match.bool(R.Bool.literal(false), sleep, R.Effect.succeed(R.Unit.literal())).pipe(
          R.Effect.andThen(sleep),
        );
      }),
    ),
  ),
  childScope: R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap(() => {
        const sleep = R.Effect.sleep(100);
        const group = R.Effect.all([sleep, R.Effect.succeed(R.Unit.literal())], {
          concurrency: "unbounded",
          discard: true,
        });
        return R.Match.bool(R.Bool.literal(false), group, sleep);
      }),
    ),
  ),
  finalizerScope: R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap(() => {
        const sleep = R.Effect.sleep(100);
        const bracket = R.Effect.succeed(R.Unit.literal()).pipe(R.Effect.ensuring(sleep));
        return R.Match.bool(R.Bool.literal(false), bracket, sleep);
      }),
    ),
  ),
  deferredScope: R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap(() => {
        const sleep = R.Effect.sleep(100);
        const nested = D.make(R.Unit).pipe(R.Effect.flatMap(() => sleep));
        return R.Match.bool(R.Bool.literal(false), nested, sleep);
      }),
    ),
  ),
  cleanup: R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap((cell) =>
        D.succeed(cell, R.Unit.literal()).pipe(
          R.Effect.andThen(D.await(cell)),
          R.Effect.ensuring(cleanup),
        ),
      ),
    ),
  ),
};
type Scenario = keyof typeof programs;
const scenarios = Object.keys(programs) as Scenario[];
const oracles = {
  wait: Deferred.make<void>().pipe(Effect.flatMap(Deferred.await)),
  sleep: Deferred.make<void>().pipe(Effect.flatMap(() => Effect.sleep(100))),
  wrapped: Deferred.make<void>().pipe(
    Effect.flatMap((cell) =>
      Deferred.await(cell).pipe(
        Effect.map((value) => value),
        Effect.ensuring(officialCleanup),
      ),
    ),
  ),
  deep: Deferred.make<void>().pipe(
    Effect.flatMap((cell) => {
      let body = Deferred.await(cell);
      for (let i = 0; i < 40; i++) body = Effect.map(body, (value) => value);
      return body;
    }),
  ),
  group: Deferred.make<void>().pipe(
    Effect.flatMap((cell) =>
      Effect.all([Deferred.await(cell), Effect.sleep(100)], {
        concurrency: "unbounded",
        discard: true,
      }),
    ),
  ),
  sharedLeaf: Deferred.make<void>().pipe(Effect.flatMap(() => Effect.sleep(100))),
  sharedParent: Deferred.make<void>().pipe(
    Effect.flatMap(() => Effect.sleep(100).pipe(Effect.map((value) => value))),
  ),
  flatMapScope: Deferred.make<void>().pipe(
    Effect.flatMap(() => Effect.void.pipe(Effect.andThen(Effect.sleep(100)))),
  ),
  childScope: Deferred.make<void>().pipe(Effect.flatMap(() => Effect.sleep(100))),
  finalizerScope: Deferred.make<void>().pipe(Effect.flatMap(() => Effect.sleep(100))),
  deferredScope: Deferred.make<void>().pipe(Effect.flatMap(() => Effect.sleep(100))),
  cleanup: Deferred.make<void>().pipe(
    Effect.flatMap((cell) =>
      Deferred.succeed(cell, undefined).pipe(
        Effect.andThen(Deferred.await(cell)),
        Effect.ensuring(officialCleanup),
      ),
    ),
  ),
};
const paths = (frames: readonly LogicalFrame[]) => frames.map(({ path, kind }) => [path, kind]);
const expected = (name: string, scenario: Scenario) => {
  const root = `functions.${name}`;
  const parent = [
    [`${root}.body`, "deferredScope"],
    [root, "function"],
  ];
  switch (scenario) {
    case "wait":
      return { frames: [[`${root}.body.body`, "deferredAwait"], ...parent], omitted: 0 };
    case "sleep":
      return { frames: [[`${root}.body.body`, "sleep"], ...parent], omitted: 0 };
    case "wrapped":
      return {
        frames: [
          [`${root}.body.body.onFalse.body.source`, "deferredAwait"],
          [`${root}.body.body.onFalse.body`, "map"],
          [`${root}.body.body.onFalse`, "ensuring"],
          [`${root}.body.body`, "match"],
          ...parent,
        ],
        omitted: 0,
      };
    case "deep":
      return {
        frames: [
          [`${root}.body.body${".source".repeat(40)}`, "deferredAwait"],
          ...Array.from({ length: 31 }, (_, index) => [
            `${root}.body.body${".source".repeat(39 - index)}`,
            "map",
          ]),
        ],
        omitted: 11,
      };
    case "group":
      return { frames: [[`${root}.body.body`, "all"], ...parent], omitted: 0 };
    case "sharedLeaf":
      return {
        frames: [[`${root}.body.body.onTrue`, "sleep"], [`${root}.body.body`, "match"], ...parent],
        omitted: 0,
      };
    case "sharedParent":
      return {
        frames: [
          [`${root}.body.body.onTrue.source`, "sleep"],
          [`${root}.body.body.onTrue`, "map"],
          [`${root}.body.body`, "match"],
          ...parent,
        ],
        omitted: 0,
      };
    case "flatMapScope":
      return {
        frames: [[`${root}.body.body.body`, "sleep"], [`${root}.body.body`, "flatMap"], ...parent],
        omitted: 0,
      };
    case "childScope":
    case "deferredScope":
      return {
        frames: [[`${root}.body.body.onFalse`, "sleep"], [`${root}.body.body`, "match"], ...parent],
        omitted: 0,
      };
    case "finalizerScope":
      return {
        frames: [
          [`${root}.body.body.onTrue.finalizer`, "sleep"],
          [`${root}.body.body`, "match"],
          ...parent,
        ],
        omitted: 0,
      };
    case "cleanup":
      return { frames: [[`${root}.body.body`, "ensuring"], ...parent], omitted: 0 };
  }
};
const expectedLogs = (scenario: Scenario) =>
  scenario === "wrapped" || scenario === "cleanup" ? ["cleanup:start", "cleanup:done"] : [];

test("standalone interruption preserves official Cause and awaited cleanup with exact bounded trails", async () => {
  for (const scenario of scenarios) {
    const logs: string[] = [];
    const context = Context.make(
      Logger.CurrentLoggers,
      new Set([Logger.make((event) => logs.push(String(event.message)))]),
    );
    const signal = new AbortController();
    const pending = Effect.runPromiseExitWith(context)(oracles[scenario], {
      signal: signal.signal,
    });
    signal.abort();
    const official = await pending;
    expect(Exit.isFailure(official) && Cause.hasInterruptsOnly(official.cause)).toBe(true);
    expect(logs).toEqual(expectedLogs(scenario));

    const controller = new AbortController();
    const result = DeferredExecution.runWithFrames(programs[scenario], {
      signal: controller.signal,
    });
    controller.abort();
    const observed = await result;
    expect(observed.logs).toEqual(logs);
    expect(Exit.isSuccess(observed.exit)).toBe(true);
    if (!Exit.isSuccess(observed.exit)) throw new Error("Missing interrupted observation");
    const framed = observed.exit.value;
    expect(Exit.isFailure(framed.exit) && Cause.hasInterruptsOnly(framed.exit.cause)).toBe(true);
    expect({ frames: paths(framed.frames), omitted: framed.omitted }).toEqual(
      expected("work", scenario),
    );
    expect(Object.isFrozen(framed.frames)).toBe(true);
  }
});

test("independent canceled invocations retain their own trails", async () => {
  const controllers = [new AbortController(), new AbortController()];
  const pending = ["wait", "sleep"].map((scenario, index) =>
    DeferredExecution.runWithFrames(programs[scenario as Scenario], {
      signal: controllers[index].signal,
    }),
  );
  controllers[1].abort();
  controllers[0].abort();
  for (const [index, observation] of (await Promise.all(pending)).entries()) {
    expect(Exit.isSuccess(observation.exit)).toBe(true);
    if (Exit.isSuccess(observation.exit))
      expect(paths(observation.exit.value.frames)).toEqual(
        expected("work", index ? "sleep" : "wait").frames,
      );
  }
});

test("scope-expanded diagnostic plans refuse before source work, while shared success stays empty", async () => {
  const success = R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap(() => {
        const value = R.Effect.succeed(R.Unit.literal());
        return R.Match.bool(R.Bool.literal(false), value, value.withSource(value.source));
      }),
    ),
  );
  expect(await DeferredExecution.runWithFrames(success)).toMatchObject({
    exit: { value: { exit: Exit.succeed(undefined), frames: [], omitted: 0 } },
    logs: [],
  });
  const expanding = R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap(() => {
        let body = R.Effect.sleep(100);
        for (let i = 0; i < 12; i++) {
          const left = R.Effect.succeed(R.Unit.literal()).pipe(R.Effect.andThen(body));
          const right = R.Effect.succeed(R.Unit.literal()).pipe(R.Effect.andThen(body));
          body = R.Match.bool(R.Bool.literal(false), left, right);
        }
        return R.Log.info("must:not:start").pipe(R.Effect.andThen(body));
      }),
    ),
  );
  expect(
    analyzeDeferredBudget(expanding, "body", defaultDeferredBudgetContext, true).admitted,
  ).toBe(true);
  const defensive = new DeferredInterruptionFrames();
  expect(() => defensive.prepare(expanding.body, "functions.work.body")).toThrowError(/4096/);
  const refused = await DeferredExecution.runWithFrames(expanding);
  expect(refused.logs).toEqual([]);
  expect(refused.exit).toMatchObject({
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
});

test("monitored Race success discards canceled loser trails and research recorders cannot be reused", async () => {
  const success = R.fn([], R.Unit, R.Never, () =>
    D.make(R.Unit).pipe(
      R.Effect.flatMap((cell) =>
        R.Effect.all(
          [
            R.Effect.race(D.await(cell).pipe(R.Effect.ensuring(cleanup)), R.Effect.sleep(1)),
            R.Effect.succeed(R.Unit.literal()),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      ),
    ),
  );
  const observed = await DeferredExecution.runWithFrames(success);
  expect(observed.logs).toEqual(["cleanup:start", "cleanup:done"]);
  expect(observed.exit).toMatchObject({
    value: { exit: Exit.succeed(undefined), frames: [], omitted: 0 },
  });

  const frames = new DeferredInterruptionFrames();
  const reusable = GeneratedDeferredReference.runWithInterruptionFrames(success, [], frames);
  expect(Exit.isSuccess(await Effect.runPromiseExit(reusable))).toBe(true);
  for (const effect of [
    reusable,
    GeneratedDeferredReference.runWithInterruptionFrames(success, [], frames),
  ]) {
    const reused = await Effect.runPromiseExit(effect);
    expect(reused).toMatchObject({
      cause: {
        reasons: [
          {
            error: {
              diagnostics: [expect.objectContaining({ code: "DEFERRED_FRAME_REUSE" })],
            },
          },
        ],
      },
    });
  }
  const absent = R.fn([], R.Unit, R.Never, () => R.Effect.succeed(R.Unit.literal()));
  expect(
    await Effect.runPromiseExit(
      GeneratedDeferredReference.runWithInterruptionFrames(
        absent,
        [],
        new DeferredInterruptionFrames(),
      ),
    ),
  ).toMatchObject({
    cause: {
      reasons: [
        {
          error: { diagnostics: [expect.objectContaining({ code: "DEFERRED_GENERATED_PROFILE" })] },
        },
      ],
    },
  });
});

test("masked interruption observers stay within their audited operation receipts", async () => {
  class BudgetProbe extends Scheduler.MixedScheduler {
    maximum = 0;
    automaticYields = 0;
    override shouldYield(fiber: Fiber.Fiber<unknown, unknown>): boolean {
      this.maximum = Math.max(this.maximum, fiber.currentOpCount);
      const yielded = super.shouldYield(fiber);
      if (yielded) this.automaticYields++;
      return yielded;
    }
  }
  for (const scenario of scenarios) {
    const budget = analyzeDeferredBudget(
      programs[scenario],
      "body",
      defaultDeferredBudgetContext,
      true,
    );
    expect(budget.admitted).toBe(true);
    const scheduler = new BudgetProbe();
    const context = Context.empty().pipe(
      Context.add(Scheduler.Scheduler, scheduler),
      Context.add(Logger.CurrentLoggers, new Set([Logger.make(() => {})])),
    );
    const frames = new DeferredInterruptionFrames();
    const fiber = Effect.runForkWith(context)(
      GeneratedDeferredReference.runWithInterruptionFrames(programs[scenario], [], frames),
    );
    expect(fiber.pollUnsafe()).toBeUndefined();
    fiber.interruptUnsafe();
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(scheduler.maximum).toBeLessThanOrEqual(budget.framed);
    expect(scheduler.automaticYields).toBe(0);
    expect({ frames: paths(frames.snapshot().frames), omitted: frames.snapshot().omitted }).toEqual(
      expected("work", scenario),
    );
  }
});

const harness = `
use reffect_generated as r;
use std::future::Future;
async fn drive<F:Future>(future:F,sender:&tokio::sync::watch::Sender<bool>)->F::Output {
 tokio::pin!(future);
 let first=std::future::poll_fn(|cx|std::task::Poll::Ready(future.as_mut().poll(cx))).await;
 assert!(first.is_pending(),"source must suspend before interruption");
 sender.send(true).unwrap();
 let ended=std::future::poll_fn(|cx|std::task::Poll::Ready(future.as_mut().poll(cx))).await;
 if let std::task::Poll::Ready(result)=ended{return result;}
 tokio::time::advance(std::time::Duration::from_millis(1000)).await;
 future.await
}
#[tokio::main(flavor="current_thread")]
async fn main() {
 tokio::time::pause();
 let scenario=std::env::args().nth(1).unwrap();
 let(sender,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 let result=match scenario.as_str(){
 ${scenarios.map((name) => `"${name}"=>drive(r::r_${name}(&mut ctx),&sender).await,`).join("\n")}
 _=>panic!("unknown scenario") };
 assert!(matches!(result,Err(r::AsyncError::Interrupted)),"{:?}",result);
 FRAME_PROBE
}
`;

test(
  "actual native interrupted trails agree exactly in debug/release with bounded/off diagnostics",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "reffect-deferred-interruption-"));
    const selected = new Map(
      Rust.std.implementations.map((implementation) => [
        implementation.operation.ref,
        implementation,
      ]),
    );
    try {
      for (const policy of [FailureFrames.None, FailureFrames.Bounded]) {
        const root = join(directory, policy._tag);
        const emitted = emitFunctions(
          lowerDeferredFunctions(R.program(programs), selected, SourceArtifacts.None, policy),
        );
        expect(emitted.files["src/lib.rs"]).toMatch(/^#!\[recursion_limit = "256"\]/);
        const queryAllowance = emitted.files["src/main.rs"].match(
          /^#!\[recursion_limit = "256"\]/,
        )?.[0];
        expect(queryAllowance).toBeDefined();
        for (const [path, contents] of Object.entries(emitted.files)) {
          await mkdir(dirname(join(root, path)), { recursive: true });
          await writeFile(join(root, path), contents);
        }
        const manifest = await readFile(join(root, "Cargo.toml"), "utf8");
        await writeFile(
          join(root, "Cargo.toml"),
          manifest.replace('"macros",', '"test-util", "macros",'),
        );
        await writeFile(
          join(root, "src/main.rs"),
          `${queryAllowance}\n${harness}`.replace(
            "FRAME_PROBE",
            policy._tag === "None"
              ? 'println!("omitted=0");'
              : 'let(frames,omitted)=ctx.take_frames(); for frame in frames {println!("frame={}",frame);} println!("omitted={}",omitted); assert!(ctx.take_frames().0.is_empty());',
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
            const frames = stdout
              .split("\n")
              .filter((line) => line.startsWith("frame="))
              .map((line) => JSON.parse(line.slice(6)) as LogicalFrame);
            expect({
              frames: paths(frames),
              omitted: Number(stdout.match(/omitted=(\d+)/)?.[1]),
            }).toEqual(
              policy._tag === "None" ? { frames: [], omitted: 0 } : expected(scenario, scenario),
            );
            const logs = stderr
              .split("\n")
              .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
              .map((line) => (JSON.parse(line) as { message: string }).message);
            expect(logs).toEqual(expectedLogs(scenario));
          }
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(0) + 180000,
);
