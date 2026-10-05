import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { Compile, NESTING_LIMIT, R, Reference } from "../src/index.ts";
import type { CompileError } from "../src/index.ts";

// #29: every pass walks the IR recursively, so a deep program overflowed the stack, as a lowering
// failure or an untyped defect. It is now refused by its measured depth, before any pass runs.
const codes = (effect: Effect.Effect<unknown, CompileError>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.map(() => Array<string>()),
      Effect.catchTag("CompileError", (error) =>
        Effect.succeed(error.diagnostics.map((d) => d.code)),
      ),
    ),
  );
/** `x + x + ... + x` with `additions` additions: depth `additions + 1`, the parameter leaf included. */
const chain = (additions: number) =>
  R.fn([R.U64], R.U64, (x) => {
    let value = x;
    for (let i = 0; i < additions; i++) value = R.U64.add(value, x);
    return value;
  });
const deepBranches = R.fn([R.Bool, R.U64], R.U64, (flag, x) => {
  let value = x;
  for (let i = 0; i < 10000; i++) value = R.Match.bool(flag, R.U64.add(value, x), x);
  return value;
});
const deepEffect = R.fn([R.U64], R.U64, R.Never, (x) => {
  let effect = R.Effect.succeed(x);
  for (let i = 0; i < 10000; i++) effect = effect.pipe(R.Effect.flatMap(() => R.Effect.succeed(x)));
  return effect;
});

test("depth 10k gets a structured refusal from the compiler and the reference", async () => {
  for (const f of [deepBranches, deepEffect]) {
    expect(await codes(Compile.run(R.program({ f })))).toEqual(["NESTING_LIMIT"]);
    expect(await codes(Compile.check(R.program({ f })))).toEqual(["NESTING_LIMIT"]);
  }
  expect(await codes(Reference.run(deepBranches, [true, 1n]))).toEqual(["NESTING_LIMIT"]);
  expect(await codes(Reference.run(deepEffect, [1n]))).toEqual(["NESTING_LIMIT"]);
});

test("the limit is exact: its own depth compiles and runs, one more is refused", async () => {
  const atLimit = chain(NESTING_LIMIT - 1);
  expect(await codes(Compile.run(R.program({ f: atLimit })))).toEqual([]);
  // Wrapping arithmetic over u64: 512 * 3 does not wrap.
  expect(await Effect.runPromise(Reference.run(atLimit, [3n]))).toBe(BigInt(NESTING_LIMIT) * 3n);
  expect(await codes(Compile.run(R.program({ f: chain(NESTING_LIMIT) })))).toEqual([
    "NESTING_LIMIT",
  ]);
});

test("shared subterms are measured once, by depth rather than size", async () => {
  // 2^400 paths through 400 shared squarings: a tree walk would never finish.
  const squares = R.fn([R.U64], R.U64, (x) => {
    let value = x;
    for (let i = 0; i < 400; i++) value = R.U64.mul(value, value);
    return value;
  });
  expect(await codes(Compile.check(R.program({ f: squares })))).toEqual([]);
});
