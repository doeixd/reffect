import { Cause, Effect, Exit, FileSystem, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
import { Rpc, RpcGroup } from "effect/rpc";
import { expect, test } from "vite-plus/test";
import {
  Capabilities,
  CargoApi,
  Compile,
  CompileError,
  FailureFrames,
  NativeRpc,
  NativeRunner,
  Plan,
  QueueDoneType,
  QueueExecution,
  QueueIR,
  R,
  Rust,
  SourceArtifacts,
  SyncEffects,
} from "../src/index.ts";
import type { Computation, EffectFn } from "../src/effect-ir.ts";
import { Expr, Operation, EqU64, SemanticRef } from "../src/kernel.ts";
import { QueueIR as ResearchQueue } from "../src/queue.ts";
import { queueType } from "../src/queue-model.ts";
import { generatedDeferredGrowthLimits } from "../src/deferred-growth.ts";
import { lowerFunctions } from "../src/lower.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const all = (left: Computation<void>, right: Computation<void>) =>
  R.Effect.all([left, right], { concurrency: "unbounded", discard: true });
const sequence = (items: readonly Computation<void>[]) =>
  items.reduce((body, item) => body.pipe(R.Effect.andThen(item)), R.Effect.void);
const transfer = (capacity: number) =>
  R.fn([], R.U64, R.Never, () =>
    R.Queue.bounded(R.U64, capacity).pipe(
      R.Effect.flatMap((owner) =>
        R.Effect.succeed(R.U64.literal(7n)).pipe(
          R.Effect.flatMap((captured) =>
            all(
              sequence(
                [0n, 1n, 2n].map((index) =>
                  owner.pipe(
                    R.Queue.offer(R.U64.add(captured, R.U64.literal(index))),
                    R.Effect.asVoid,
                  ),
                ),
              ),
              sequence(
                [0n, 1n, 2n].map((index) =>
                  R.Queue.take(owner).pipe(
                    R.Effect.flatMap((value) =>
                      R.Match.bool(
                        R.U64.eq(value, R.U64.add(captured, R.U64.literal(index))),
                        R.Log.info(`take:${index}`),
                        R.Log.info("wrong"),
                      ),
                    ),
                  ),
                ),
              ),
            ).pipe(R.Effect.as(captured)),
          ),
        ),
      ),
    ),
  );
const boolean = R.fn([], R.Bool, R.Never, () =>
  R.Queue.make(R.Bool, { capacity: 1, strategy: "suspend" }).pipe(
    R.Effect.flatMap((owner) =>
      all(
        R.Queue.offer(owner, R.Bool.literal(true)).pipe(R.Effect.asVoid),
        R.Queue.take(owner).pipe(
          R.Effect.flatMap((value) => R.Match.bool(value, R.Log.info("true"), R.Log.info("wrong"))),
        ),
      ).pipe(R.Effect.as(R.Bool.literal(true))),
    ),
  ),
);
const unit = R.fn([], R.Unit, R.Never, () =>
  R.Queue.make(R.Unit, { capacity: 1 }).pipe(
    R.Effect.flatMap((owner) =>
      all(R.Queue.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid), R.Queue.take(owner)),
    ),
  ),
);
const blocked = R.fn([], R.Unit, R.Never, () =>
  R.Queue.bounded(R.Unit, 1).pipe(
    R.Effect.flatMap((owner) => all(R.Queue.take(owner), R.Queue.take(owner))),
  ),
);
const idle = R.fn([], R.Unit, R.Never, () =>
  R.Queue.bounded(R.Bool, 1).pipe(R.Effect.flatMap(() => all(R.Effect.void, R.Effect.void))),
);
const diagnostics = (exit: Exit.Exit<unknown, CompileError>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.flatMap((reason) =>
        Cause.isFailReason(reason) ? reason.error.diagnostics : [],
      )
    : [];
const compile = (work: EffectFn) =>
  Effect.runPromise(
    Compile.make(R.program({ work })).pipe(
      Compile.withTarget(Rust.tokio),
      Compile.run,
      Effect.exit,
    ),
  );

test("public Queue exposes the bounded Never facade with both offer forms and owned observations", async () => {
  expect(QueueIR).toBe(R.Queue);
  expect(Object.isFrozen(QueueIR)).toBe(true);
  expect(Object.keys(QueueIR).sort()).toEqual([
    "bounded",
    "end",
    "make",
    "offer",
    "shutdown",
    "take",
  ]);
  for (const capacity of [1, 2, 3]) {
    const observation = await QueueExecution.run(transfer(capacity));
    expect(observation.exit).toEqual(Exit.succeed(7n));
    expect(observation.logs).toEqual(["take:0", "take:1", "take:2"]);
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.logs)).toBe(true);
  }
  expect((await QueueExecution.run(boolean)).exit).toEqual(Exit.succeed(true));
  expect((await QueueExecution.run(unit)).exit).toEqual(Exit.succeed(undefined));
  expect((await QueueExecution.runWithFrames(unit)).exit).toEqual(
    Exit.succeed({ exit: Exit.succeed(undefined), frames: [], omitted: 0 }),
  );
  const before = await QueueExecution.runWithFrames(blocked, { signal: AbortSignal.abort() });
  expect(Exit.isFailure(before.exit) && Cause.hasInterruptsOnly(before.exit.cause)).toBe(true);
  expect(before.logs).toEqual([]);
  const controller = new AbortController();
  const pending = QueueExecution.runWithFrames(blocked, { signal: controller.signal });
  controller.abort();
  const observed = await pending;
  expect(Exit.isSuccess(observed.exit)).toBe(true);
  if (Exit.isSuccess(observed.exit)) {
    const framed = observed.exit.value;
    expect(Exit.isFailure(framed.exit) && Cause.hasInterruptsOnly(framed.exit.cause)).toBe(true);
    expect(framed.frames.map(({ kind }) => kind)).toEqual(["all", "queueScope", "function"]);
  }
  // Compile-time contracts are checked without evaluating unsupported authoring.
  const contracts = () => {
    QueueIR.bounded(R.U64, 1, QueueDoneType);
    // @ts-expect-error Scalar failures are outside the public Queue profile.
    QueueIR.bounded(R.U64, 1, R.Bool);
    // @ts-expect-error An explicit Done error parameter requires its witness.
    QueueIR.bounded<bigint, Cause.Done<void>>(R.U64, 1);
    // Building Shutdown does not bypass its checked offer-free native admission.
    void QueueIR.shutdown;
    void R.Queue.end;
    // @ts-expect-error Only the suspend strategy is supported.
    R.Queue.make(R.U64, { capacity: 1, strategy: "sliding" });
    R.Queue.bounded(R.Bool, 1).pipe(
      R.Effect.flatMap((owner) => {
        // @ts-expect-error offer infers the owner's payload witness.
        R.Queue.offer(owner, R.U64.literal(1n));
        // @ts-expect-error curried offer preserves its value type at the owner call.
        owner.pipe(R.Queue.offer(R.U64.literal(1n)));
        return R.Effect.void;
      }),
    );
  };
  void contracts;
});

test("public Queue stages report owned payloads, async capability and independent policies", async () => {
  const std = await Effect.runPromise(
    Compile.make(R.program({ idle })).pipe(Compile.withTarget(Rust.std), Compile.run, Effect.exit),
  );
  expect(diagnostics(std)).toContainEqual(
    expect.objectContaining({
      code: "UNSUPPORTED_CAPABILITY",
      path: Capabilities.AsyncResult.id,
    }),
  );
  const analysis = await Effect.runPromise(Compile.derive(R.program({ idle })));
  expect(analysis.types).toContain(R.Bool);
  expect(analysis.capabilities).toContain(Capabilities.Bool);
  expect(analysis.capabilities).toContain(Capabilities.AsyncResult);
  for (const frames of [FailureFrames.None, FailureFrames.Bounded]) {
    for (const artifacts of [SourceArtifacts.Full, SourceArtifacts.None]) {
      const artifact = await Effect.runPromise(
        Compile.make(R.program({ transfer: transfer(1), boolean, unit })).pipe(
          Compile.withTarget(Rust.tokio),
          Compile.withFailureFrames(frames),
          Compile.withSourceArtifacts(artifacts),
          Compile.run,
        ),
      );
      expect(artifact.explanation.crates).toContain("tokio@1.53.1");
      expect(artifact.explanation.analysis.effects).toContain(SyncEffects.QueueMake);
      expect(artifact.files["src/lib.rs"]).toContain("assert_queue_future_layout");
      expect(artifact.files["src/lib.rs"]!.includes("FrameTrail")).toBe(
        frames === FailureFrames.Bounded,
      );
      expect(artifact.files["src/lib.rs"]).toContain("QueueDriver::new");
    }
  }
});

test("public Queue retains specific structural, growth, reference and budget refusals", async () => {
  const root = (build: (owner: Expr<import("effect").Queue.Queue<bigint>>) => Computation<void>) =>
    R.fn([], R.Unit, R.Never, () => R.Queue.bounded(R.U64, 1).pipe(R.Effect.flatMap(build)));
  const pair = (owner: Expr<import("effect").Queue.Queue<bigint>>) =>
    all(
      R.Queue.offer(owner, R.U64.literal(1n)).pipe(R.Effect.asVoid),
      R.Queue.take(owner).pipe(R.Effect.asVoid),
    );
  let calls = 0;
  const alias = Operation.make(EqU64.ref, [R.U64, R.U64], R.Bool, () => {
    calls++;
    return true;
  });
  const fixtures = [
    [root(() => R.Log.info("unopened")), "QUEUE_STRUCTURAL_PROFILE"],
    [
      root((owner) => R.Match.bool(R.Bool.literal(true), pair(owner), R.Effect.void)),
      "QUEUE_STRUCTURAL_PROFILE",
    ],
    [root((owner) => pair(owner).pipe(R.Effect.andThen(pair(owner)))), "QUEUE_STRUCTURAL_PROFILE"],
    [root((owner) => all(pair(owner), R.Effect.void)), "NESTED_TASK_GROUP"],
    [
      root((owner) => R.Effect.race(R.Queue.take(owner).pipe(R.Effect.asVoid), R.Effect.void)),
      "QUEUE_STRUCTURAL_PROFILE",
    ],
    [
      root((owner) => R.Queue.take(owner).pipe(R.Effect.asVoid, R.Effect.andThen(pair(owner)))),
      "QUEUE_STRUCTURAL_PROFILE",
    ],
    [
      root((owner) => all(ResearchQueue.shutdown(owner).pipe(R.Effect.asVoid), R.Effect.void)),
      "QUEUE_STRUCTURAL_PROFILE",
    ],
    [
      root((owner) => all(R.Effect.sleep(1), R.Queue.take(owner).pipe(R.Effect.asVoid))),
      "QUEUE_STRUCTURAL_PROFILE",
    ],
    [
      root((owner) => pair(owner).pipe(R.Effect.ensuring(R.Effect.void))),
      "QUEUE_STRUCTURAL_PROFILE",
    ],
    [
      root(() =>
        R.Semaphore.make(1).pipe(R.Effect.flatMap(() => all(R.Effect.void, R.Effect.void))),
      ),
      "QUEUE_GROWTH_UNACCOUNTED",
    ],
    [
      root((owner) =>
        all(
          R.Queue.offer(owner, R.U64.literal(1n)).pipe(R.Effect.asVoid),
          R.Effect.succeed(Expr.apply(alias, R.U64.literal(1n), R.U64.literal(1n))).pipe(
            R.Effect.asVoid,
          ),
        ),
      ),
      "QUEUE_REFERENCE_CONTEXT",
    ],
    [
      root((owner) =>
        all(
          R.Match.bool(
            R.Bool.literal(true),
            R.Queue.offer(owner, R.U64.literal(1n)).pipe(R.Effect.asVoid),
            R.Log.info("x".repeat(generatedDeferredGrowthLimits.textBytes + 1)),
          ),
          R.Effect.void,
        ),
      ),
      "QUEUE_GENERATED_GROWTH",
    ],
    [
      root((owner) =>
        all(
          sequence(
            Array.from({ length: 10 }, () =>
              R.Queue.offer(owner, R.U64.literal(1n)).pipe(R.Effect.asVoid),
            ),
          ),
          sequence(Array.from({ length: 10 }, () => R.Queue.take(owner).pipe(R.Effect.asVoid))),
        ),
      ),
      "QUEUE_BUDGET_EXCEEDED",
    ],
  ] as const;
  for (const [fn, code] of fixtures) {
    const compiled = await compile(fn);
    const observed = await QueueExecution.run(fn);
    expect(observed.logs).toEqual([]);
    for (const result of [compiled, observed.exit])
      expect(diagnostics(result)).toContainEqual(expect.objectContaining({ code, stage: "check" }));
  }
  expect(calls).toBe(0);
  const selected = new Map(Rust.tokio.implementations.map((item) => [item.operation.ref, item]));
  expect(() => lowerFunctions(R.program({ unit }), selected)).toThrow(/Queue/);
});

test("a valid Queue export cannot hide unrelated pure Queue/Done operation markers", async () => {
  let calls = 0;
  for (const [index, type] of [queueType(R.Bool, R.Never), QueueDoneType].entries()) {
    const operation = Operation.make(
      SemanticRef.operation(`test/public-queue-hidden-${index}`),
      [type],
      R.Bool,
      () => {
        calls++;
        return true;
      },
    );
    // @ts-expect-error adversarial operation intentionally omits its marker operand.
    const expression = Expr.apply(operation);
    const hidden = R.fn([], R.Bool, () => expression);
    const result = await Effect.runPromise(
      Compile.make(R.program({ unit, hidden })).pipe(
        Compile.withTarget(Rust.tokio),
        Compile.run,
        Effect.exit,
      ),
    );
    expect(diagnostics(result)).toContainEqual(
      expect.objectContaining({ code: "QUEUE_NATIVE_UNSUPPORTED" }),
    );
  }
  expect(calls).toBe(0);
});

test("public Queue plans cannot bypass checked topology or conceal resource and host limits", async () => {
  const checked = await Effect.runPromise(
    Compile.derive(R.program({ unit })).pipe(
      Effect.flatMap((analysis) => Compile.plan(analysis, Rust.tokio)),
    ),
  );
  const invalid = R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1).pipe(R.Effect.flatMap(() => R.Log.info("unopened"))),
  );
  const overBudget = R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1).pipe(
      R.Effect.flatMap((owner) =>
        all(
          sequence(
            Array.from({ length: 10 }, () =>
              R.Queue.offer(owner, R.Unit.literal()).pipe(R.Effect.asVoid),
            ),
          ),
          sequence(Array.from({ length: 10 }, () => R.Queue.take(owner))),
        ),
      ),
    ),
  );
  for (const [work, code] of [
    [invalid, "QUEUE_STRUCTURAL_PROFILE"],
    [overBudget, "QUEUE_BUDGET_EXCEEDED"],
  ] as const) {
    const forged = Plan.make(
      { ...checked.analysis, program: R.program({ work }) },
      checked.target,
      checked.selections,
      checked.crates,
    );
    const rejected = await Effect.runPromise(Compile.verify(forged).pipe(Effect.exit));
    expect(diagnostics(rejected)).toContainEqual(expect.objectContaining({ code }));
  }
  const ordinary = await Effect.runPromise(
    Compile.derive(R.program({ ordinary: R.fn([], R.Unit, () => R.Unit.literal()) })),
  );
  const spoofed = await Effect.runPromise(
    Compile.plan({ ...ordinary, effects: [SyncEffects.QueueMake] }, Rust.tokio).pipe(Effect.exit),
  );
  expect(diagnostics(spoofed)).toContainEqual(
    expect.objectContaining({ code: "QUEUE_NATIVE_INTEGRATION" }),
  );
  const input = R.fn([R.U64], R.Unit, R.Never, () => unit.body);
  expect(diagnostics(await compile(input))).toContainEqual(
    expect.objectContaining({ code: "QUEUE_STRUCTURAL_PROFILE" }),
  );
  const done = R.fn([], R.Unit, R.Never, () =>
    R.Queue.bounded(R.Unit, 1, QueueDoneType).pipe(
      R.Effect.flatMap(() => all(R.Effect.void, R.Effect.void)),
    ),
  );
  expect(Exit.isSuccess(await compile(done))).toBe(true);
  expect((await QueueExecution.run(done)).exit).toEqual(Exit.succeed(undefined));
  expect((await Effect.runPromise(Compile.derive(R.program({ done })))).types).toContain(
    QueueDoneType,
  );
  const group = RpcGroup.make(Rpc.make("Value", { payload: {}, success: Schema.Boolean }));
  const rpc = await Effect.runPromise(
    NativeRpc.compile(group, { Value: NativeRpc.bind(boolean) }).pipe(Effect.exit),
  );
  expect(diagnostics(rpc)).toContainEqual(
    expect.objectContaining({
      message: expect.stringContaining("Queue is admitted only for standalone exports"),
    }),
  );
});

test(
  "public Queue artifacts build and run with independent coordinators under both frame policies",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-queue-public-" });
          const queues = { pressure1: transfer(1), pressure2: transfer(2), pressure3: transfer(3) };
          const program = R.program({
            ...queues,
            boolean,
            unit,
            idle,
            services: R.fn([], R.Number, R.Never, () =>
              R.Effect.sleep(1).pipe(
                R.Effect.andThen(R.Clock.currentTimeMillis),
                R.Effect.flatMap((clock) =>
                  R.Random.next.pipe(R.Effect.map((draw) => R.Number.add(clock, draw))),
                ),
              ),
            ),
            ordinary: R.fn([], R.U64, () => R.U64.literal(11n)),
            deferred: R.fn([], R.U64, R.Never, () =>
              R.Deferred.make(R.U64).pipe(
                R.Effect.flatMap((cell) =>
                  R.Deferred.succeed(cell, R.U64.literal(13n)).pipe(
                    R.Effect.andThen(R.Deferred.await(cell)),
                  ),
                ),
              ),
            ),
            semaphore: R.fn([], R.U64, R.Never, () =>
              R.Semaphore.make(1).pipe(
                R.Effect.flatMap((owner) =>
                  R.Semaphore.withPermit(owner)(R.Effect.succeed(R.U64.literal(17n))),
                ),
              ),
            ),
            latch: R.fn([], R.U64, R.Never, () =>
              R.Latch.make(true).pipe(
                R.Effect.flatMap((owner) =>
                  R.Latch.whenOpen(owner, R.Effect.succeed(R.U64.literal(19n))),
                ),
              ),
            ),
          });
          for (const frames of [FailureFrames.None, FailureFrames.Bounded]) {
            const artifact = yield* Compile.make(program).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.withFailureFrames(frames),
              Compile.withRuntimeServices({ clock: "InjectedMillis", random: "ScriptedRandom" }),
              Compile.run,
            );
            const source = artifact.files["src/lib.rs"]!;
            for (const marker of [
              "pub struct AsyncContext",
              "struct QueueDriver<",
              "struct DeferredTurns<",
              "struct ScanTasks<const",
              "struct CohortLatch",
              "struct ScanSemaphore",
            ])
              expect(source.split(marker)).toHaveLength(2);
            expect(source).toContain("set_clock_script");
            expect(source).toContain("set_random_script");
            const directory = yield* CargoApi.write(artifact, `${parent}/${frames._tag}`);
            yield* CargoApi.build(directory);
            for (const name of ["pressure1", "pressure2", "pressure3"] as const) {
              const fn = queues[name];
              expect(yield* NativeRunner.run(artifact, directory, name, fn, [])).toEqual(
                (yield* Effect.promise(() => QueueExecution.run(fn))).exit,
              );
            }
            expect(yield* NativeRunner.run(artifact, directory, "boolean", boolean, [])).toEqual(
              Exit.succeed(true),
            );
            expect(yield* NativeRunner.run(artifact, directory, "unit", unit, [])).toEqual(
              Exit.succeed(undefined),
            );
            expect(yield* NativeRunner.run(artifact, directory, "idle", idle, [])).toEqual(
              Exit.succeed(undefined),
            );
            for (const [name, value] of [
              ["ordinary", 11n],
              ["deferred", 13n],
              ["semaphore", 17n],
              ["latch", 19n],
            ] as const)
              expect(
                yield* NativeRunner.run(artifact, directory, name, program.functions[name], []),
              ).toEqual(Exit.succeed(value));
            const queryAllowance = artifact.files["src/main.rs"]!.match(
              /^#!\[recursion_limit = "256"\]/,
            )?.[0];
            expect(queryAllowance).toBeDefined();
            yield* fs.writeFileString(
              `${directory}/src/main.rs`,
              `${queryAllowance}\n
use reffect_generated as r;
#[tokio::main(flavor="current_thread")]
async fn main(){
 let(_parent,receiver)=tokio::sync::watch::channel(false);
 let mut ctx=r::AsyncContext::new(receiver);
 ctx.set_clock_script(vec![123.0]);ctx.set_random_script(vec![0.25]);
 assert_eq!(r::r_services(&mut ctx).await.unwrap(),123.25);
 assert!(r::r_unit(&mut ctx).await.is_ok());
 println!("queue-services-ok");
}`,
            );
            yield* CargoApi.build(directory);
            expect((yield* CargoApi.run(directory, "probe", [])).stdout).toContain(
              "queue-services-ok",
            );
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
