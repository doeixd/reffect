import { Effect, Record as EffectRecord } from "effect";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { R, Reference } from "../src/index.ts";
import type { Value } from "../src/index.ts";

const Counts = R.Record(R.String, R.Number);
const summary = R.fn(
  [Counts, R.String],
  R.Struct({ keys: R.Array(R.String), values: R.Array(R.Number), size: R.Number, has: R.Bool }),
  (counts, key) =>
    R.Struct({
      keys: R.Array(R.String),
      values: R.Array(R.Number),
      size: R.Number,
      has: R.Bool,
    }).make({
      keys: R.Record.keys(counts),
      values: R.Record.values(counts),
      size: R.Record.size(counts),
      has: counts.pipe(R.Record.has(key)),
    }),
);

test("records mirror effect/Record in JS key order", async () => {
  expectTypeOf<Value<typeof Counts>>().toEqualTypeOf<{ readonly [key: string]: number }>();
  expect(R.Record(R.String, R.Number)).toBe(Counts);
  const samples: ReadonlyArray<Readonly<Record<string, number>>> = [
    {},
    { z: 1, a: 2, "10": 3, "2": 4, "-1": 5, "01": 6, "4294967295": 7, "4294967294": 8 },
    JSON.parse('{"__proto__":1,"a":2}'),
  ];
  for (const record of samples)
    for (const key of ["a", "2", "__proto__", "missing", "toString"]) {
      const result = await Effect.runPromise(Reference.run(summary, [record, key]));
      expect(result).toStrictEqual({
        keys: EffectRecord.keys(record),
        values: EffectRecord.values(record),
        size: EffectRecord.size(record),
        has: EffectRecord.has(record, key),
      });
    }
  // @ts-expect-error records take R.String keys
  expect(() => R.Record(R.U64, R.Number)).toThrow("R.String keys");
});
