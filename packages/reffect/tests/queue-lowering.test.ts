import { expect, test } from "vite-plus/test";
import { FailureFrames, R, Rust, SourceArtifacts } from "../src/index.ts";
import { QueueIR as Q } from "../src/queue.ts";
import { Expr, Operation, SemanticRef } from "../src/kernel.ts";
import { QueueDoneType, queueType } from "../src/queue-model.ts";
import { emitFunctions, lowerFunctions, lowerQueueFunctions } from "../src/lower.ts";

const selected = new Map(Rust.std.implementations.map((item) => [item.operation.ref, item]));
const work = R.fn([], R.U64, R.Never, () =>
  Q.bounded(R.U64, 1).pipe(
    R.Effect.flatMap((owner) =>
      R.Effect.succeed(R.U64.literal(7n)).pipe(
        R.Effect.flatMap((value) =>
          R.Effect.all(
            [
              Q.offer(owner, value).pipe(
                R.Effect.andThen(Q.offer(owner, R.U64.add(value, R.U64.literal(1n)))),
                R.Effect.asVoid,
              ),
              Q.take(owner).pipe(R.Effect.andThen(Q.take(owner)), R.Effect.asVoid),
            ],
            { concurrency: "unbounded", discard: true },
          ).pipe(R.Effect.as(value)),
        ),
      ),
    ),
  ),
);

test("private Queue lowering uses borrowed callbacks and scalar captures", () => {
  const emitted = emitFunctions(lowerQueueFunctions(R.program({ work }), selected));
  const source = emitted.files["src/lib.rs"]!;
  expect(source).toContain("BoundedQueue::<u64, 1, 2>::new()");
  expect(source).toContain("Option<QueueTask<'_, u64>>");
  expect(source).toContain("driver.run_hosted(ctx).await");
  expect(source).toContain("successful.iter().all");
  expect(source).toContain(".offer_exit(");
  expect(source).toContain(".take_exit(");
  expect(source).not.toContain("struct ScanTasks");
  expect(source).not.toContain("fn task_group2");
  expect(source).not.toContain("let (cancel0, receiver0)");
  expect(source).not.toContain("FrameTrail");
  const bytes = Buffer.from(source);
  expect(
    emitted.ranges.some(
      (range) =>
        range.role === "use" &&
        bytes.subarray(range.start, range.end).toString() ===
          "let _layout = assert_queue_future_layout(&future);",
    ),
  ).toBe(true);
  expect(emitted.ranges.some((range) => range.role === "definition")).toBe(true);
});

test("Queue artifact opt-out preserves runtime and refuses unproved frame policy", () => {
  const emitted = emitFunctions(
    lowerQueueFunctions(R.program({ work }), selected, SourceArtifacts.None),
  );
  expect(emitted.ranges).toEqual([]);
  expect(emitted.files["src/lib.rs"]).toContain("struct QueueDriver");
  expect(() =>
    lowerQueueFunctions(R.program({ work }), selected, SourceArtifacts.Full, FailureFrames.Bounded),
  ).toThrow(/FailureFrames.None/);
  expect(() => lowerFunctions(R.program({ work }), selected)).toThrow(/Queue/);
});

test("independent ordinary exports share context and Queue runtime once", () => {
  const source = emitFunctions(
    lowerQueueFunctions(
      R.program({ work, other: work, pure: R.fn([], R.U64, () => R.U64.literal(2n)) }),
      selected,
    ),
  ).files["src/lib.rs"]!;
  expect(source.match(/struct QueueDriver</g)).toHaveLength(1);
  expect(source.match(/pub struct AsyncContext/g)).toHaveLength(1);
  expect(source).toContain("pub fn r_pure");
  expect(source).toContain("pub fn r_other");
});

test("checked Queue selection cannot admit hidden markers in unrelated pure exports", () => {
  let calls = 0;
  const queueInput = Operation.make(
    SemanticRef.operation("test/private-lowering-queue-marker"),
    [queueType(R.Bool, R.Never)],
    R.Bool,
    () => {
      calls++;
      return true;
    },
  );
  const doneInput = Operation.make(
    SemanticRef.operation("test/private-lowering-done-marker"),
    [QueueDoneType],
    R.Bool,
    () => {
      calls++;
      return true;
    },
  );
  // @ts-expect-error malicious node hides its Queue operand
  const queueExpression = Expr.apply(queueInput);
  // @ts-expect-error malicious node hides its Done operand
  const doneExpression = Expr.apply(doneInput);
  for (const expression of [queueExpression, doneExpression]) {
    const hidden = R.fn([], R.Bool, () => expression);
    expect(() => lowerQueueFunctions(R.program({ work, hidden }), selected)).toThrow(/Queue/);
  }
  expect(calls).toBe(0);
});
