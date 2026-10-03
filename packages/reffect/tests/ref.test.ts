import { Effect, Exit, FileSystem, Logger, Ref, Fiber, Schedule, Cause, Option } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  FailureFrames,
  NativeRunner,
  R,
  Reference,
  Rust,
  Source,
  SourceArtifacts,
  Operation,
  SemanticRef,
  Expr,
  CompileError,
} from "../src/index.ts";
import { RefIR } from "../src/ref.ts";
import { refType } from "../src/ref-model.ts";
import { Computation } from "../src/effect-ir.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const plus = R.U64.literal(1n);
const pair = R.Struct({ previous: R.U64, current: R.U64 });
const counter = R.fn([R.U64], pair, R.Never, (initial) =>
  R.Effect.flatMap(RefIR.make(initial), (cell) =>
    RefIR.update(cell, (value) => R.U64.add(value, plus)).pipe(
      R.Effect.andThen(R.Effect.sleep(1)),
      R.Effect.andThen(RefIR.modify(cell, (value) => [value, R.U64.add(value, R.U64.literal(2n))])),
      R.Effect.flatMap((previous) =>
        RefIR.get(cell).pipe(R.Effect.map((current) => pair.make({ previous, current }))),
      ),
    ),
  ),
);
const projectedCounter = R.flow(
  counter,
  R.fn([pair], R.U64, (value) =>
    R.U64.add(
      R.U64.mul(R.Struct.get(value, "previous"), R.U64.literal(10n)),
      R.Struct.get(value, "current"),
    ),
  ),
);
const sequential = R.fn([], R.U64, R.Never, () =>
  R.Effect.flatMap(RefIR.make(R.U64.literal(0n)), (cell) =>
    R.Effect.forEach(
      R.Array.make(plus, R.U64.literal(2n), R.U64.literal(3n)),
      (value) => RefIR.update(cell, (old) => R.U64.add(old, value)),
      { discard: true },
    ).pipe(R.Effect.andThen(RefIR.get(cell))),
  ),
);
const recovered = R.fn([], R.U64, R.Never, () =>
  R.Effect.flatMap(RefIR.make(plus), (cell) =>
    RefIR.set(cell, R.U64.literal(7n)).pipe(
      R.Effect.andThen(R.Effect.fail(R.Bool.literal(false))),
      R.Effect.catchAll(() => RefIR.get(cell)),
    ),
  ),
);
const boolean = R.fn([], R.Bool, R.Never, () =>
  R.Effect.flatMap(RefIR.make(R.Bool.literal(false)), (cell) =>
    RefIR.update(cell, R.Bool.not).pipe(R.Effect.andThen(RefIR.get(cell))),
  ),
);
const failed = R.fn([], R.U64, R.Bool, () =>
  R.Effect.flatMap(RefIR.make(plus), (cell) =>
    RefIR.set(cell, R.U64.literal(2n)).pipe(R.Effect.andThen(R.Effect.fail(R.Bool.literal(false)))),
  ),
);
const reuseMake = RefIR.make(plus);
const reset = R.fn([], R.U64, R.Never, () =>
  R.Effect.flatMap(reuseMake, (first) =>
    RefIR.set(first, R.U64.literal(9n)).pipe(
      R.Effect.andThen(R.Effect.flatMap(reuseMake, (second) => RefIR.get(second))),
      R.Effect.flatMap((fresh) =>
        RefIR.get(first).pipe(R.Effect.map((old) => R.U64.add(fresh, old))),
      ),
    ),
  ),
);
const RefCount = R.Context.service("test/ref/count", reuseMake.output);
const countLayer = R.Layer.effect(RefCount, reuseMake);
const layered = R.fn([], R.U64, R.Never, () =>
  R.Layer.provide(R.Layer.sequence(countLayer, countLayer), (context) => {
    const cell = context.get(RefCount);
    return RefIR.update(cell, (value) => R.U64.add(value, plus)).pipe(
      R.Effect.andThen(RefIR.get(cell)),
    );
  }),
);
const unit = R.fn([], R.Unit, R.Never, () =>
  R.Effect.flatMap(RefIR.make(R.Unit.literal()), (cell) =>
    RefIR.set(cell, R.Unit.literal()).pipe(R.Effect.andThen(RefIR.get(cell))),
  ),
);
const cancel = R.fn([], R.Unit, R.Never, () =>
  R.Effect.flatMap(RefIR.make(plus), (cell) =>
    RefIR.update(cell, (value) => R.U64.add(value, plus)).pipe(
      R.Effect.andThen(R.Log.info("ref:suspend")),
      R.Effect.andThen(R.Effect.sleep(10000)),
      R.Effect.ensuring(R.Log.info("ref:cleanup")),
    ),
  ),
);
const program = R.program({
  counter: projectedCounter,
  sequential,
  recovered,
  boolean,
  failed,
  reset,
  layered,
  unit,
  cancel,
});
const oracle = (initial: bigint) =>
  Effect.gen(function* () {
    const cell = yield* Ref.make(initial);
    yield* Ref.update(cell, (value) => value + 1n);
    yield* Effect.sleep(1);
    const previous = yield* Ref.modify(cell, (value) => [value, value + 2n]);
    return { previous, current: yield* Ref.get(cell) };
  });
const diagnostics = (body: Computation<unknown, unknown>) =>
  Effect.runPromise(
    Compile.run(
      R.program({ invalid: R.fn([], body.output, body.error, () => body) }),
      Rust.tokio,
    ).pipe(
      Effect.match({
        onSuccess: () => [],
        onFailure: (error) => error.diagnostics.map((item) => item.code),
      }),
    ),
  );

test("lexical Ref refuses escaping handles, stale binders and delayed captures", async () => {
  const escaping = R.Effect.flatMap(RefIR.make(plus), R.Effect.succeed);
  expect(await diagnostics(escaping)).toContain("RESOURCE_ESCAPE");
  expect(await diagnostics(RefIR.make(plus))).toContain("RESOURCE_ESCAPE");
  const alias = R.Effect.flatMap(RefIR.make(plus), (cell) =>
    R.Effect.succeed(cell).pipe(R.Effect.flatMap(RefIR.get)),
  );
  expect(await diagnostics(alias)).toContain("RESOURCE_ESCAPE");
  const embedded = R.Effect.flatMap(RefIR.make(plus), (cell) => {
    const envelope = R.Struct({ cell: cell.type });
    return R.Effect.succeed(envelope.make({ cell })).pipe(R.Effect.asVoid);
  });
  expect(await diagnostics(embedded)).toContain("RESOURCE_ESCAPE");
  const forged = Computation.make(R.U64, R.Never, {
    _tag: "RefGet",
    binder: Symbol("foreign"),
    content: R.U64,
  });
  expect(await diagnostics(forged)).toContain("RESOURCE_ESCAPE");
  const delayed = R.Effect.flatMap(RefIR.make(plus), (cell) =>
    R.Effect.scoped(
      R.Effect.addFinalizer(() =>
        RefIR.get(cell).pipe(R.Effect.asVoid, R.Effect.withLogSpan("hidden")),
      ).pipe(R.Effect.andThen(R.Effect.void)),
    ),
  );
  expect(await diagnostics(delayed)).toContain("RESOURCE_ESCAPE");
  expect(() => RefIR.make(R.String.literal("heap"))).toThrow("Bool, U64 or Unit");
  expect(() =>
    R.Effect.flatMap(RefIR.make(plus), (cell) =>
      RefIR.modify(
        cell,
        // @ts-expect-error A Boolean cannot replace u64 state.
        (value) => [value, R.Bool.literal(false)],
      ),
    ),
  ).toThrow("matching next-value");
  const broken = Operation.make(
    SemanticRef.operation("test/ref-snapshot-defect@1"),
    [],
    R.U64,
    () => {
      throw new Error("snapshot defect");
    },
  );
  const defective = R.fn([], R.U64, R.Never, () =>
    R.Effect.flatMap(RefIR.make(plus), (cell) =>
      RefIR.modify(cell, (value) => [Expr.apply(broken), value]).pipe(
        R.Effect.catchAll(() => R.Effect.succeed(plus)),
      ),
    ),
  );
  for (const action of [
    Reference.run(defective, []).pipe(Effect.asVoid),
    Reference.runWithFrames(defective, []).pipe(Effect.asVoid),
  ]) {
    const result = await Effect.runPromise(Effect.exit(action));
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result))
      expect(Option.getOrUndefined(Cause.findErrorOption(result.cause))).toBeInstanceOf(
        CompileError,
      );
  }
  const handleWitness = refType(R.U64);
  const publicHandle = R.fn([handleWitness], R.Unit, R.Never, () => R.Effect.void);
  expect(
    await Effect.runPromise(
      Compile.run(R.program({ publicHandle })).pipe(
        Effect.match({
          onSuccess: () => [],
          onFailure: (error) => error.diagnostics.map((item) => item.code),
        }),
      ),
    ),
  ).toContain("RESOURCE_ESCAPE");
  const purePublicHandle = R.fn([handleWitness], R.Unit, () => R.Unit.literal());
  const cell = Ref.makeUnsafe(0n);
  const publicAttempts = [
    Reference.run(publicHandle, [cell]),
    Reference.run(purePublicHandle, [cell]),
    Reference.runWithFrames(publicHandle, [cell]),
    Reference.runWithFrames(purePublicHandle, [cell]),
  ];
  for (const attempt of publicAttempts)
    expect(
      await Effect.runPromise(
        attempt.pipe(
          Effect.match({
            onSuccess: () => [],
            onFailure: (error) => error.diagnostics.map((item) => item.code),
          }),
        ),
      ),
    ).toContain("RESOURCE_ESCAPE");
});

test(
  "Ref official, interpreted and native cells preserve sharing, isolation and ordered writes",
  async () => {
    const layouts: string[] = [];
    for (const initial of [0n, 9007199254740993n]) {
      expect(await Effect.runPromise(Reference.run(counter, [initial]))).toEqual(
        await Effect.runPromise(oracle(initial)),
      );
    }
    expect(
      await Effect.runPromise(
        Effect.all([Reference.run(counter, [0n]), Reference.run(counter, [100n])], {
          concurrency: 2,
        }),
      ),
    ).toEqual([
      { previous: 1n, current: 3n },
      { previous: 101n, current: 103n },
    ]);
    const parallelOracle = await Effect.runPromise(
      Effect.all([oracle(0n), oracle(100n)], { concurrency: 2 }),
    );
    expect(parallelOracle).toEqual([
      { previous: 1n, current: 3n },
      { previous: 101n, current: 103n },
    ]);
    const allocation = RefIR.make(plus).pipe(
      Source.at(Source.site(Source.file("ref-allocation.ts", "Ref.make"), 0, 8)),
      Source.named("counter allocation"),
    );
    const sourced = R.fn([], R.U64, R.Never, () => R.Effect.flatMap(allocation, RefIR.get));
    const mappedArtifact = await Effect.runPromise(Compile.run(R.program({ sourced })));
    expect(mappedArtifact.sources.files.some((file) => file.path === "ref-allocation.ts")).toBe(
      true,
    );
    expect(
      mappedArtifact.sources.origins.some((origin) => origin.names.includes("counter allocation")),
    ).toBe(true);
    const syncArtifact = await Effect.runPromise(
      Compile.run(R.program({ sequential, recovered, reset, layered, unit, boolean })),
    );
    expect(syncArtifact.files["Cargo.toml"]).not.toContain("tokio");
    const referenceLogs: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Reference.run(cancel, []).pipe(Effect.forkScoped);
          yield* Effect.sync(() => referenceLogs.includes("ref:suspend")).pipe(
            Effect.repeat({ while: (ready) => !ready, schedule: Schedule.spaced("1 millis") }),
            Effect.timeout("3 seconds"),
          );
          yield* Fiber.interrupt(fiber);
          expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
        }),
      ).pipe(
        Effect.provide(
          Logger.layer([Logger.make((event) => referenceLogs.push(String(event.message)))]),
        ),
      ),
    );
    expect(referenceLogs).toEqual(["ref:suspend", "ref:cleanup"]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({
            directory: ".",
            prefix: "reffect-ref-",
          });
          yield* fs.writeFileString(`${parent}/input.txt`, "abc");
          const inputPath = yield* fs.realPath(`${parent}/input.txt`);
          const fileCounter = R.fn([], R.U64, R.Bool, () =>
            R.File.scoped(
              inputPath,
              (file) =>
                file.size.pipe(
                  R.Effect.flatMap((size) =>
                    R.Effect.flatMap(RefIR.make(size), (cell) =>
                      RefIR.update(cell, (value) => R.U64.add(value, plus)).pipe(
                        R.Effect.andThen(R.Effect.sleep(1)),
                        R.Effect.andThen(RefIR.get(cell)),
                      ),
                    ),
                  ),
                ),
              R.Log.info("file:closed"),
            ),
          );
          const nativeProgram = R.program({ ...program.functions, fileCounter });
          expect(yield* Reference.run(fileCounter, [])).toBe(4n);
          for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
            const artifact = yield* Compile.make(nativeProgram).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withFailureFrames(policy),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.run,
            );
            expect(artifact.files["src/lib.rs"]).toContain("&mut u64");
            expect(artifact.files["src/lib.rs"]).not.toMatch(
              /Rc<|Arc<|Mutex<|RefCell<u64>|\*mut |Box<dyn/,
            );
            const directory = yield* CargoApi.write(artifact, `${parent}/${policy._tag}`);
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              for (const initial of [0n, 9007199254740993n])
                expect(
                  yield* NativeRunner.run(
                    artifact,
                    directory,
                    "counter",
                    projectedCounter,
                    [initial],
                    profile,
                  ),
                ).toEqual(Exit.succeed((initial + 1n) * 10n + initial + 3n));
              for (const [name, fn, expected] of [
                ["sequential", sequential, 6n],
                ["recovered", recovered, 7n],
                ["reset", reset, 10n],
                ["layered", layered, 2n],
              ] as const) {
                expect(yield* Reference.run(fn, [])).toBe(expected);
                expect(yield* NativeRunner.run(artifact, directory, name, fn, [], profile)).toEqual(
                  Exit.succeed(expected),
                );
              }
              expect(
                yield* NativeRunner.run(artifact, directory, "boolean", boolean, [], profile),
              ).toEqual(Exit.succeed(true));
              expect(
                yield* NativeRunner.run(artifact, directory, "unit", unit, [], profile),
              ).toEqual(Exit.succeed(undefined));
              expect(
                yield* NativeRunner.run(
                  artifact,
                  directory,
                  "fileCounter",
                  fileCounter,
                  [],
                  profile,
                ),
              ).toEqual(Exit.succeed(4n));
              if (!FailureFrames.isNone(policy)) {
                const native = yield* NativeRunner.runWithFrames(
                  artifact,
                  directory,
                  "failed",
                  failed,
                  [],
                  profile,
                );
                const reference = yield* Reference.runWithFrames(failed, [], "functions.failed");
                expect(native.frames.map((frame) => frame.kind)).toEqual(
                  reference.frames.map((frame) => frame.kind),
                );
              }
            }
            const probe = `
use std::alloc::{GlobalAlloc, Layout, System};
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
struct Counting;
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 { ALLOCS.fetch_add(1, Ordering::SeqCst); System.alloc(layout) }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) { System.dealloc(ptr, layout) }
}
#[global_allocator] static ALLOCATOR: Counting = Counting;
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let (_sender, receiver) = tokio::sync::watch::channel(false);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    let before = ALLOCS.load(Ordering::SeqCst);
    let counter_bytes = { let future = reffect_generated::r_counter(&mut ctx, 0); std::mem::size_of_val(&future) };
    let cancel_bytes = { let future = reffect_generated::r_cancel(&mut ctx); std::mem::size_of_val(&future) };
    assert_eq!(ALLOCS.load(Ordering::SeqCst) - before, 0);
    let before = ALLOCS.load(Ordering::SeqCst);
    for _ in 0..1000 { assert_eq!(reffect_generated::r_sequential().unwrap(), 6); }
    assert_eq!(ALLOCS.load(Ordering::SeqCst) - before, 0);
    println!("ref-layout:context={},counter={},cancel={},sync_allocations=0", std::mem::size_of_val(&ctx), counter_bytes, cancel_bytes);
    let (_sender_a, receiver_a) = tokio::sync::watch::channel(false);
    let (_sender_b, receiver_b) = tokio::sync::watch::channel(false);
    let mut ctx_a = reffect_generated::AsyncContext::new(receiver_a);
    let mut ctx_b = reffect_generated::AsyncContext::new(receiver_b);
    let (a, b) = tokio::join!(reffect_generated::r_counter(&mut ctx_a, 0), reffect_generated::r_counter(&mut ctx_b, 100));
    assert_eq!(a.unwrap(), 13); assert_eq!(b.unwrap(), 1113);
    let (sender, receiver) = tokio::sync::watch::channel(false);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    {
        let future = reffect_generated::r_cancel(&mut ctx);
        tokio::pin!(future);
        std::future::poll_fn(|cx| match future.as_mut().poll(cx) {
            std::task::Poll::Pending => { sender.send(true).unwrap(); std::task::Poll::Ready(()) },
            _ => panic!("expected suspension with live Ref cell"),
        }).await;
        assert!(matches!(future.await, Err(reffect_generated::AsyncError::Interrupted)));
    }
    let (sender, receiver) = tokio::sync::watch::channel(false);
    sender.send(true).unwrap();
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    assert!(matches!(reffect_generated::r_cancel(&mut ctx).await, Err(reffect_generated::AsyncError::Interrupted)));
    println!("ref-probe:passed");
}
`;
            yield* fs.writeFileString(`${directory}/src/main.rs`, probe);
            yield* CargoApi.build(directory, "release");
            const result = yield* CargoApi.run(directory, "probe", [], "release");
            expect(result.stdout).toContain("sync_allocations=0");
            expect(result.stdout).toContain("ref-probe:passed");
            expect(
              result.stderr
                .split("\n")
                .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
                .map((line) => JSON.parse(line).message),
            ).toEqual(referenceLogs);
            layouts.push(`${policy._tag}: ${result.stdout.trim()}`);
            // Optional scratch output lets external tooling retain layout evidence after scoped cleanup.
            const probeOutput = process.env.REFFECT_REF_PROBE_OUTPUT;
            if (probeOutput) yield* fs.writeFileString(probeOutput, layouts.join("\n"));
            yield* fs.writeFileString(`${directory}/src/main.rs`, artifact.files["src/main.rs"]);
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer), Effect.provide(Logger.layer([]))),
    );
    console.info(layouts.join("\n"));
  },
  nativeTestBudget(0) + 120000,
);
