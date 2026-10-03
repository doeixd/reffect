import { Duration, Effect, Option } from "effect";
import { expect, test } from "vite-plus/test";
import { DurationIR, checkedMilliseconds } from "../src/duration.ts";
import type { DurationInput } from "../src/duration.ts";
import { Compile, R, Reference, Rust } from "../src/index.ts";

const inputs: readonly DurationInput[] = [
  0,
  -0,
  NaN,
  0.0000005,
  -0.0000005,
  -3,
  Infinity,
  -Infinity,
  1000001n,
  -1000001n,
  "1.5 seconds",
  "-0.5 nanos",
  "Infinity",
  "-Infinity",
  [2, 500000000],
  [NaN, 1],
  { seconds: 1, nanoseconds: 500 },
  Duration.minutes(1),
];

test("authoring Duration preserves pinned conversion, arithmetic and pipeability", () => {
  for (const input of inputs) {
    const actual = DurationIR.fromInputUnsafe(input);
    const expected = Duration.fromInputUnsafe(input);
    expect(DurationIR.toMillis(actual)).toBe(Duration.toMillis(expected));
    expect(DurationIR.toNanos(actual)).toEqual(Duration.toNanos(expected));
    expect(DurationIR.toHrTime(actual)).toEqual(Duration.toHrTime(expected));
    expect(DurationIR.format(actual)).toBe(Duration.format(expected));
    expect(DurationIR.isFinite(actual)).toBe(Duration.isFinite(expected));
    expect(DurationIR.isNegative(actual)).toBe(Duration.isNegative(expected));
    expect(DurationIR.isPositive(actual)).toBe(Duration.isPositive(expected));
  }
  const duration = DurationIR.nanos(1000001n).pipe(
    DurationIR.sum(DurationIR.micros(1000n)),
    DurationIR.times(3),
    DurationIR.subtract(DurationIR.millis(1)),
  );
  expect(DurationIR.toNanosUnsafe(duration)).toBe(5000003n);
  expect(DurationIR.divide(DurationIR.seconds(1), 0)).toEqual(
    Duration.divide(Duration.seconds(1), 0),
  );
  expect(DurationIR.toNanos(DurationIR.infinity)).toEqual(Option.none());
  expect(() => DurationIR.toNanosUnsafe(DurationIR.negativeInfinity)).toThrow();
  expect(Option.isNone(DurationIR.fromInput("1e3 seconds"))).toBe(true);
  expect(DurationIR.toNanosUnsafe(DurationIR.fromInputUnsafe("-0.5 nanos"))).toBe(-1n);
  expect(DurationIR.equals(DurationIR.seconds(1), DurationIR.millis(1000))).toBe(true);
  expect(DurationIR.seconds(1).pipe(DurationIR.isLessThan(DurationIR.seconds(2)))).toBe(true);
});

test("timing normalization admits exact bounded milliseconds and rejects lossy delays", () => {
  for (const input of [
    "1 second",
    { seconds: 1 },
    [1, 0],
    1000000000n,
    DurationIR.seconds(1),
  ] as const)
    expect(checkedMilliseconds(input, "sleep")).toBe(1000);
  expect(checkedMilliseconds(DurationIR.nanos(60000000000n), "sleep")).toBe(60000);
  expect(checkedMilliseconds(0, "sleep")).toBe(0);
  expect(checkedMilliseconds(-0, "sleep")).toBe(0);
  expect(checkedMilliseconds(DurationIR.millis(NaN), "sleep")).toBe(0);
  for (const input of [
    NaN,
    Infinity,
    -Infinity,
    -1,
    0.5,
    60001,
    1n,
    -1n,
    60000000001n,
    DurationIR.infinity,
    DurationIR.negativeInfinity,
    { milliseconds: 1, nanoseconds: 1 },
  ]) {
    expect(() => checkedMilliseconds(input, "sleep")).toThrow(
      "Delay requires 0–60000 integral milliseconds",
    );
  }
  expect(() => checkedMilliseconds(0, "schedule", 1)).toThrow(
    "Delay requires 1–60000 integral milliseconds",
  );
  try {
    checkedMilliseconds(0.1, "schedule", 1);
  } catch (error) {
    expect(error).toMatchObject({
      _tag: "CompileError",
      diagnostics: [{ code: "INVALID_DELAY", stage: "authoring", path: "schedule" }],
    });
  }
});

test("Duration configuration erases into existing Sleep and Schedule plans", async () => {
  const fn = R.fn([], R.Unit, R.Never, () =>
    R.Effect.sleep(R.Duration.micros(1000n)).pipe(
      R.Effect.andThen(
        R.Effect.repeat(R.Effect.sleep(0), {
          schedule: R.Schedule.spaced(R.Duration.seconds(0.001)),
          times: 1,
        }),
      ),
    ),
  );
  for (const input of [NaN, -1, Infinity, -Infinity, 0.5, 60001, R.Duration.nanos(1n)])
    expect(() => R.Effect.sleep(input)).toThrow("Delay requires 0–60000 integral milliseconds");
  expect(() => R.Effect.sleep("1e3 seconds")).toThrow();
  expect(() => R.Effect.sleep(R.Duration.millis(NaN))).not.toThrow();
  // Existing Schedule conversion intentionally keeps its own raw-NaN policy.
  expect(R.Schedule.exponential(NaN).plan).toEqual({
    _tag: "Exponential",
    milliseconds: 0,
    factor: 2,
  });
  expect(() => R.Schedule.spaced(NaN)).toThrow();
  expect(await Effect.runPromise(Reference.run(fn, []))).toBeUndefined();
  const artifact = await Effect.runPromise(Compile.run(R.program({ fn }), Rust.tokio));
  expect(artifact.files["src/lib.rs"]).not.toContain("struct Duration");
  expect(artifact.files["src/lib.rs"]).not.toContain("enum Duration");
  expect(artifact.files["Cargo.toml"]).not.toContain("duration");
});
