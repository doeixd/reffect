import { Effect, FileSystem, Option } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  Expr,
  NativeRunner,
  R,
  Reference,
  SourceArtifacts,
} from "../src/index.ts";
import { OptionIR as O, type OptionValue } from "../src/option.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const choose = (present: Expr<boolean>, value: Expr<bigint>) =>
  R.Match.bool(present, O.some(value), O.none(R.U64));
const increment = R.fn([R.Bool, R.U64], R.U64, (present, value) =>
  choose(present, value).pipe(
    O.map((n) => R.U64.add(n, R.U64.literal(1n))),
    O.getOrElse(() => R.U64.literal(99n)),
  ),
);
const chained = R.fn([R.Bool, R.Bool, R.U64], R.U64, (first, second, value) =>
  O.flatMap(choose(first, value), (n) => choose(second, R.U64.add(n, R.U64.literal(2n)))).pipe(
    O.getOrElse(() => R.U64.literal(99n)),
  ),
);
const filtered = R.fn([R.Bool, R.U64], R.Bool, (present, value) =>
  O.filter(choose(present, value), (n) => R.U64.lt(n, R.U64.literal(4n))).pipe(O.isSome),
);
const exists = R.fn([R.Bool, R.U64], R.Bool, (present, value) =>
  choose(present, value).pipe(O.exists((n) => R.U64.eq(n, R.U64.literal(3n)))),
);
const fallback = R.fn([R.Bool, R.U64], R.U64, (present, value) =>
  O.orElse(choose(present, value), () => O.some(R.U64.literal(8n))).pipe(
    O.match({ onNone: () => R.U64.literal(99n), onSome: (n) => n }),
  ),
);
const left = R.fn([R.Bool, R.Bool, R.U64], R.U64, (first, second, value) =>
  choose(first, value).pipe(
    O.zipLeft(choose(second, R.U64.literal(7n))),
    O.getOrElse(() => R.U64.literal(99n)),
  ),
);
const right = R.fn([R.Bool, R.Bool, R.U64], R.U64, (first, second, value) =>
  O.zipRight(choose(first, value), choose(second, R.U64.literal(7n))).pipe(
    O.getOrElse(() => R.U64.literal(99n)),
  ),
);
const tapped = R.fn([R.Bool, R.Bool, R.U64], R.U64, (first, second, value) =>
  O.tap(choose(first, value), (n) => choose(second, R.U64.add(n, R.U64.literal(1n)))).pipe(
    O.getOrElse(() => R.U64.literal(99n)),
  ),
);
const nested = R.fn([R.Bool, R.Bool, R.U64], R.U64, (outer, inner, value) =>
  O.flatten(R.Match.bool(outer, O.some(choose(inner, value)), O.none(O(R.U64)))).pipe(
    O.getOrElse(() => R.U64.literal(99n)),
  ),
);
const unitPresence = R.fn([R.Bool, R.U64], R.Bool, (present, value) =>
  O.asVoid(choose(present, value)).pipe(O.isSome),
);
const converted = R.fn([R.Bool, R.U64], R.U64, (present, value) =>
  O.fromUndefinedOr(O.getOrUndefined(choose(present, value))).pipe(
    O.getOrElse(() => R.U64.literal(99n)),
  ),
);
const stringReuse = R.fn([R.Bool, R.String], R.String, (present, value) =>
  O.zipLeft(R.Match.bool(present, O.some(value), O.none(R.String)), O.some(value)).pipe(
    O.getOrElse(() => R.String.literal("missing")),
  ),
);
const lazyOverflow = R.fn([R.Bool], R.U64, (present) =>
  O.map(choose(present, R.U64.literal(18446744073709551615n)), (n) =>
    R.U64.add(n, R.U64.literal(1n)),
  ).pipe(O.getOrElse(() => R.U64.literal(0n))),
);
const program = R.program({
  increment,
  chained,
  filtered,
  exists,
  fallback,
  left,
  right,
  tapped,
  nested,
  unitPresence,
  converted,
  stringReuse,
  lazyOverflow,
});
const official = (present: boolean, value: bigint) =>
  present ? Option.some(value) : Option.none<bigint>();
const or99 = Option.getOrElse(() => 99n);

test("Option witnesses and authoring enforce a structural bounded profile", () => {
  expect(O(R.U64)).toBe(O(R.U64));
  expectTypeOf(O.some(R.U64.literal(1n))).toEqualTypeOf<Expr<OptionValue<bigint>>>();
  expectTypeOf(O.none(R.Bool)).toEqualTypeOf<Expr<OptionValue<boolean>>>();
  expect(O(R.Unit)).not.toBe(O(R.U64));
  expect(() =>
    R.fn([R.Bool], R.Bool, (present) => {
      // @ts-expect-error fallback must share the payload type
      return O.getOrElse(O.some(present), () => R.U64.literal(0n));
    }),
  ).toThrow("same witness");
  expect(() => {
    // @ts-expect-error flatMap requires an Option-valued callback
    return O.flatMap(O.some(R.Bool.literal(true)), (n) => n);
  }).toThrow("Option witness");
  expect(() => O.getOrUndefined(O.some(R.literal(R.Unit, undefined)))).toThrow(
    "must not admit undefined",
  );
  expect(() => O.getOrUndefined(O.some(O.none(R.U64)))).not.toThrow();
  let authored = 0;
  O.map(O.none(R.U64), (value) => {
    authored++;
    return value;
  });
  expect(authored).toBe(1);
});

test("Option combinators agree with pinned Effect on absence, nesting and Unit", async () => {
  for (const present of [false, true])
    for (const value of [0n, 3n, 8n]) {
      const option = official(present, value);
      expect(await Effect.runPromise(Reference.run(increment, [present, value]))).toBe(
        or99(Option.map(option, (n) => n + 1n)),
      );
      expect(await Effect.runPromise(Reference.run(filtered, [present, value]))).toBe(
        Option.isSome(Option.filter(option, (n) => n < 4n)),
      );
      expect(await Effect.runPromise(Reference.run(exists, [present, value]))).toBe(
        Option.exists(option, (n) => n === 3n),
      );
      expect(await Effect.runPromise(Reference.run(fallback, [present, value]))).toBe(
        or99(Option.orElse(option, () => Option.some(8n))),
      );
      expect(await Effect.runPromise(Reference.run(unitPresence, [present, value]))).toBe(
        Option.isSome(Option.asVoid(option)),
      );
      expect(await Effect.runPromise(Reference.run(converted, [present, value]))).toBe(
        or99(Option.fromUndefinedOr(Option.getOrUndefined(option))),
      );
      for (const second of [false, true]) {
        const other = official(second, 7n);
        expect(await Effect.runPromise(Reference.run(chained, [present, second, value]))).toBe(
          or99(Option.flatMap(option, (n) => official(second, n + 2n))),
        );
        expect(await Effect.runPromise(Reference.run(left, [present, second, value]))).toBe(
          or99(Option.zipLeft(option, other)),
        );
        expect(await Effect.runPromise(Reference.run(right, [present, second, value]))).toBe(
          or99(Option.zipRight(option, other)),
        );
        expect(await Effect.runPromise(Reference.run(tapped, [present, second, value]))).toBe(
          or99(Option.tap(option, (n) => official(second, n + 1n))),
        );
        expect(await Effect.runPromise(Reference.run(nested, [present, second, value]))).toBe(
          or99(Option.flatten(present ? Option.some(official(second, value)) : Option.none())),
        );
      }
    }
  expect(await Effect.runPromise(Reference.run(lazyOverflow, [false]))).toBe(0n);
  expect(await Effect.runPromise(Reference.run(stringReuse, [true, "🚀"]))).toBe("🚀");
  expect(await Effect.runPromise(Reference.run(stringReuse, [false, "🚀"]))).toBe("missing");
});

test(
  "specialized Option enums agree natively without new dependencies",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-option-" });
          const artifact = yield* Compile.make(program).pipe(
            Compile.withSourceArtifacts(SourceArtifacts.None),
            Compile.run,
          );
          expect(artifact.explanation.crates).toEqual([]);
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          for (const profile of ["debug", "release"] as const) {
            yield* CargoApi.build(directory, profile);
            for (const present of [false, true])
              for (const second of [false, true]) {
                const value = 3n;
                for (const [name, fn] of Object.entries({ chained, left, right, tapped, nested }))
                  expect(
                    yield* NativeRunner.run(
                      artifact,
                      directory,
                      name,
                      fn,
                      [present, second, value],
                      profile,
                    ),
                  ).toEqual(yield* Effect.exit(Reference.run(fn, [present, second, value])));
                for (const [name, fn] of Object.entries({ increment, fallback, converted }))
                  expect(
                    yield* NativeRunner.run(
                      artifact,
                      directory,
                      name,
                      fn,
                      [present, value],
                      profile,
                    ),
                  ).toEqual(yield* Effect.exit(Reference.run(fn, [present, value])));
                for (const [name, fn] of Object.entries({ filtered, exists, unitPresence }))
                  expect(
                    yield* NativeRunner.run(
                      artifact,
                      directory,
                      name,
                      fn,
                      [present, value],
                      profile,
                    ),
                  ).toEqual(yield* Effect.exit(Reference.run(fn, [present, value])));
                expect(
                  yield* NativeRunner.run(
                    artifact,
                    directory,
                    "stringReuse",
                    stringReuse,
                    [present, "🚀"],
                    profile,
                  ),
                ).toEqual(yield* Effect.exit(Reference.run(stringReuse, [present, "🚀"])));
              }
            expect(
              yield* NativeRunner.run(
                artifact,
                directory,
                "lazyOverflow",
                lazyOverflow,
                [false],
                profile,
              ),
            ).toEqual(yield* Effect.exit(Reference.run(lazyOverflow, [false])));
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 180000,
);
