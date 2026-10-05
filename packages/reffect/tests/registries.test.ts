import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { expect, test } from "vite-plus/test";
import { IRType, R } from "../src/index.ts";
import * as HtmlIr from "../src/html-ir.ts";

setFlagsFromString("--expose-gc");
const gc: () => void = runInNewContext("gc");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Whether `ref`'s target is collected. A deref keeps its target alive until the job ends, so
 * each collection runs in a later job than the previous check. */
const collected = async (ref: WeakRef<object>) => {
  for (let i = 0; i < 20; i++) {
    await tick();
    gc();
    await tick();
    if (ref.deref() === undefined) return true;
  }
  return false;
};

// #39: process-wide registries kept every witness and codec ever authored, coupling builds.
test("interned witnesses stay shared while referenced and are released when not", async () => {
  const fields = { a: R.U64, b: R.Bool };
  const first = R.Struct(fields);
  expect(IRType.same(R.Struct({ a: R.U64, b: R.Bool }), first)).toBe(true);

  const forgotten = (() => {
    // A unique shape, its JSON codec, and an array of it: none referenced afterwards.
    const witness = R.Struct({ forgottenField: R.U64 });
    const list = R.Array(witness);
    R.fn([list], R.Unknown, (value) => R.Schema.encodeSync(R.Schema.toCodecJson(list))(value));
    return new WeakRef(witness);
  })();
  expect(await collected(forgotten)).toBe(true);
  // The referenced one is still the interned witness.
  expect(IRType.same(R.Struct(fields), first)).toBe(true);
});

test("element operations are not exported for importers to replace", () => {
  expect(Object.keys(HtmlIr)).not.toContain("elementOperations");
});
