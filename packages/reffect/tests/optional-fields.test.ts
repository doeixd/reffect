import { Cause, Effect, Exit, Option, Schema, SchemaIssue, UndefinedOr } from "effect";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { R, Reference } from "../src/index.ts";
import type { Value } from "../src/index.ts";

const Point = R.Struct({ x: R.Number, y: R.Number });
const Wide = R.Struct({
  a: R.optional(R.Number),
  b: R.optionalKey(R.String),
  c: R.Bool,
  d: R.optional(Point),
});

test("optional fields mirror Schema.optional and Schema.optionalKey", () => {
  expectTypeOf<Value<typeof Wide>>().toEqualTypeOf<{
    readonly c: boolean;
    readonly a?: number | undefined;
    readonly b?: string;
    readonly d?: { readonly x: number; readonly y: number } | undefined;
  }>();
  const official = Schema.Struct({
    a: Schema.optional(Schema.Number),
    b: Schema.optionalKey(Schema.String),
    c: Schema.Boolean,
    d: Schema.optional(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
  });
  const format = SchemaIssue.makeFormatterDefault();
  const observe = (exit: Exit.Exit<unknown, Schema.SchemaError>) =>
    Exit.match(exit, {
      onSuccess: (value) => ({ value, keys: Object.keys(value as object) }),
      onFailure: (cause) =>
        Option.map(Cause.findErrorOption(cause), (error) => format(error.issue)),
    });
  for (const value of [
    { c: true },
    { c: false, a: undefined },
    { c: true, a: 1, b: "s", d: { x: 1, y: 2 } },
    { c: true, b: undefined },
    { c: true, a: "x" },
  ])
    expect(observe(Schema.decodeUnknownExit(Wide.schema)(value))).toStrictEqual(
      observe(Schema.decodeUnknownExit(official)(value)),
    );
  expect(R.UndefinedOr(R.Number)).toBe(R.UndefinedOr(R.Number));
  expect(R.Struct({ a: R.optional(R.Number) })).not.toBe(R.Struct({ a: R.optionalKey(R.Number) }));
  expect(() => R.UndefinedOr(R.Unit)).toThrow("must not admit undefined");
  expect(() => R.UndefinedOr(R.UndefinedOr(R.Number))).toThrow("must not admit undefined");
});

// Rebuilds a Wide value: `a` is mapped, `b` is omitted, `d` is passed through as UndefinedOr.
const touch = R.fn([Wide], Wide, (wide) =>
  Wide.make({
    c: R.Bool.not(R.Struct.get(wide, "c")),
    a: R.UndefinedOr.map(R.Struct.get(wide, "a"), (a) => R.Number.add(a, R.Number.literal(1))),
    d: R.Struct.get(wide, "d"),
  }),
);
const pick = R.fn([Wide], R.Number, (wide) =>
  R.Struct.get(wide, "a").pipe(
    R.UndefinedOr.match({
      onUndefined: () => R.Number.literal(-1),
      onDefined: (a) => a,
    }),
  ),
);
const fill = R.fn([R.Number], Wide, (a) =>
  Wide.make({ c: R.Bool.literal(true), a, b: R.String.literal("b") }),
);

test("the reference keeps presence, declaration order and undefined reads", async () => {
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);
  const touched = await run(Reference.run(touch, [{ c: true }]));
  expect(Object.keys(touched)).toEqual(["a", "c", "d"]);
  expect(touched).toStrictEqual({ a: undefined, c: false, d: undefined });
  expect(await run(Reference.run(touch, [{ b: "x", c: false, a: 1 }]))).toStrictEqual({
    a: 2,
    c: true,
    d: undefined,
  });
  expect(await run(Reference.run(pick, [{ c: true }]))).toBe(-1);
  expect(await run(Reference.run(pick, [{ c: true, a: undefined }]))).toBe(-1);
  expect(await run(Reference.run(pick, [{ c: true, a: 3 }]))).toBe(3);
  const filled = await run(Reference.run(fill, [2]));
  expect(Object.keys(filled)).toEqual(["a", "b", "c"]);
  // Effect's UndefinedOr functions agree with the IR on both branches.
  for (const a of [undefined, 4]) {
    const viaIR = await run(Reference.run(pick, [{ c: true, a }]));
    expect(viaIR).toBe(UndefinedOr.match(a, { onUndefined: () => -1, onDefined: (x) => x }));
    const mapped = await run(Reference.run(touch, [{ c: true, a }]));
    expect(mapped.a).toBe(UndefinedOr.map(a, (x) => x + 1));
  }
});

test("construction admits omitted optional keys only", () => {
  // @ts-expect-error required `c` is missing
  expect(() => Wide.make({ a: R.Number.literal(1) })).toThrow("every required field");
  expect(() =>
    R.fn([Wide], Wide, (w) => {
      const b = R.Struct.get(w, "b");
      // @ts-expect-error optionalKey fields take a defined value, not UndefinedOr
      return Wide.make({ c: R.Bool.literal(true), b });
    }),
  ).toThrow("every declared field");
  const effectful = {
    onUndefined: () => R.Effect.succeed(R.Bool.literal(true)),
    onDefined: () => R.Bool.literal(false),
  };
  expect(() =>
    // @ts-expect-error handlers return pure expressions in this profile
    R.fn([Wide], R.Bool, (w) => R.UndefinedOr.match(R.Struct.get(w, "a"), effectful)),
  ).toThrow("pure expressions");
});

test("NullOr shares UndefinedOr's nodes with null as its absent value (OPT-006, OPT-007)", async () => {
  const Name = R.NullOr(R.String);
  expect([null, "x", undefined].map((value) => Schema.is(Name.schema)(value))).toEqual([
    true,
    true,
    false,
  ]);
  expect(Name.id).not.toBe(R.UndefinedOr(R.String).id);
  // Through Option and back: null stays null, a string is mapped.
  const shout = R.fn([Name], Name, (name) =>
    R.Option.getOrNull(
      R.Option.map(R.Option.fromNullOr(name), (value) =>
        R.String.concat(value, R.String.literal("!")),
      ),
    ),
  );
  const run = (value: string | null) => Effect.runPromise(Reference.run(shout, [value]));
  expect(await run(null)).toBeNull();
  expect(await run("hi")).toBe("hi!");
  // Nesting would read JSON null two ways, and undefined-only operations refuse a NullOr.
  expect(() => R.NullOr(Name)).toThrow("must not admit null");
  expect(() => R.NullOr(R.Unknown)).toThrow("must not admit null");
  expect(() => R.UndefinedOr(Name)).toThrow("must not admit undefined");
  expect(() => R.NullOr(R.UndefinedOr(R.String))).toThrow("must not admit null");
  expect(() =>
    R.fn([Name], R.String, (value) =>
      R.UndefinedOr.match(value, {
        onUndefined: () => R.String.literal("none"),
        // @ts-expect-error a NullOr's present value is not its undefined-free item
        onDefined: (defined) => defined,
      }),
    ),
  ).toThrow("match requires UndefinedOr");
  expect(() => R.fn([Name], R.Option(R.String), R.Option.fromUndefinedOr)).toThrow(
    "Requires UndefinedOr",
  );
  expect(() => R.fn([R.UndefinedOr(R.String)], R.Option(R.String), R.Option.fromNullOr)).toThrow(
    "Requires NullOr",
  );
});
