import { expect, test } from "vite-plus/test";
import { R, Rust, SourceArtifacts, FailureFrames } from "../src/index.ts";
import { matchComputation } from "../src/effect-ir.ts";
import { LatchIR as L } from "../src/latch.ts";
import { SemaphoreIR as S } from "../src/semaphore.ts";
import { DeferredIR as D } from "../src/deferred.ts";
import { emitFunctions, lowerLatchFunctions, lowerFunctions } from "../src/lower.ts";

const selected = new Map(Rust.std.implementations.map((i) => [i.operation.ref, i]));
const work = R.fn([], R.Unit, R.Never, () =>
  L.make().pipe(
    R.Effect.flatMap((latch) =>
      R.Effect.succeed(R.U64.literal(7n)).pipe(
        R.Effect.flatMap((value) =>
          R.Effect.all(
            [
              L.whenOpen(latch, R.Effect.succeed(value).pipe(R.Effect.asVoid)),
              R.Effect.sleep(1).pipe(R.Effect.andThen(L.release(latch)), R.Effect.asVoid),
            ],
            { concurrency: "unbounded", discard: true },
          ),
        ),
      ),
    ),
  ),
);

test("private Latch lowering borrows owners and scalar captures with checked root layout", () => {
  const emitted = emitFunctions(lowerLatchFunctions(R.program({ work }), selected));
  const source = emitted.files["src/lib.rs"];
  expect(source).toContain("pub fn r_work");
  expect(source).toContain(
    "impl std::future::Future<Output = Result<(), AsyncError<std::convert::Infallible>>> + '_",
  );
  expect(source).toContain("let _layout = assert_latch_future_layout(&future);");
  expect(source).toContain("reffect_latch_future_layouts");
  expect(source).toContain("ScanTasks::<3>::new()");
  expect(source).toContain("&CohortLatch<3>");
  expect(source).toContain("latch_all2(");
  expect(source).toContain("task.await_latch(");
  expect(source).toContain("task.sleep(ctx, 1u64).await");
  expect(source).not.toContain("struct ScanSemaphore");
  expect(source).not.toContain("fn acquire(");
  const bytes = Buffer.from(source);
  expect(
    emitted.ranges.some(
      (range) =>
        range.role === "use" &&
        bytes.subarray(range.start, range.end).toString() ===
          "let _layout = assert_latch_future_layout(&future);",
    ),
  ).toBe(true);
});

test("Latch artifact and failure frame opt-outs remain independent", () => {
  const emitted = emitFunctions(
    lowerLatchFunctions(R.program({ work }), selected, SourceArtifacts.None, FailureFrames.None),
  );
  expect(emitted.ranges).toEqual([]);
  expect(emitted.files["src/lib.rs"]).not.toContain("FrameTrail");
  expect(emitted.files["src/lib.rs"]).toContain("Err(AsyncError::Interrupted) => false");
});

test("independent coordinator exports emit the borrowed task runtime once", () => {
  const source = emitFunctions(
    lowerLatchFunctions(
      R.program({
        work,
        ordinary: R.fn([], R.Unit, R.Never, () => R.Effect.sleep(1)),
        semaphore: R.fn([], R.Unit, R.Never, () =>
          S.make(1).pipe(R.Effect.flatMap((owner) => S.withPermit(owner)(R.Effect.sleep(1)))),
        ),
        deferred: R.fn([], R.Unit, R.Never, () =>
          D.make(R.Unit).pipe(
            R.Effect.flatMap((cell) =>
              D.succeed(cell, R.Unit.literal()).pipe(R.Effect.andThen(D.await(cell))),
            ),
          ),
        ),
      }),
      selected,
    ),
  ).files["src/lib.rs"];
  expect(source.match(/struct ScanTasks<const/g)).toHaveLength(1);
  expect(source.match(/struct ScanTask<'a/g)).toHaveLength(1);
  expect(source).toContain("struct ScanSemaphore");
  expect(source).toContain("struct CohortLatch");
  expect(source).toContain("struct DeferredTurns");
  expect(source).toContain("pub async fn r_ordinary");
});

test("public lowering retains the explicit Latch refusal", () => {
  expect(() => lowerFunctions(R.program({ work }), selected)).toThrow("Latch cohort scheduling");
});

test("synchronous Latch operations still return a checked context-owning future", () => {
  const sync = R.fn([], R.Bool, R.Never, () =>
    L.make(true).pipe(
      R.Effect.flatMap((owner) =>
        L.close(owner).pipe(
          R.Effect.andThen(L.open(owner)),
          R.Effect.andThen(L.release(owner)),
          R.Effect.andThen(L.isOpen(owner)),
        ),
      ),
    ),
  );
  const source = emitFunctions(lowerLatchFunctions(R.program({ sync }), selected)).files[
    "src/lib.rs"
  ];
  expect(source).toContain("pub fn r_sync(ctx: &mut AsyncContext)");
  expect(source).toContain("CohortLatch::<1>::new(true)");
  expect(source).toContain(".close()");
  expect(source).toContain(".open()");
  expect(source).toContain(".release()");
  expect(source).toContain(".is_open()");
  expect(source).toContain("if ctx.is_cancelled()");
});

test("mixed coordinator roots share one source expansion ceiling", () => {
  let branch = R.Effect.succeed(R.Unit.literal());
  for (let depth = 0; depth < 7; depth++)
    branch = matchComputation(R.Bool.literal(true), branch, branch);
  const latch = R.fn([], R.Unit, R.Never, () => L.make(true).pipe(R.Effect.flatMap(() => branch)));
  const semaphore = R.fn([], R.Unit, R.Never, () =>
    S.make(1).pipe(R.Effect.flatMap((owner) => S.withPermit(owner)(branch))),
  );
  const roots = Object.fromEntries(
    Array.from({ length: 18 }, (_, index) => [`work${index}`, index < 9 ? latch : semaphore]),
  );
  expect(() => lowerLatchFunctions(R.program(roots), selected)).toThrow("moduleComputations");
});
