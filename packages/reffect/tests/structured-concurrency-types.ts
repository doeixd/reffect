import { expectTypeOf } from "vite-plus/test";
import { type Computation, R } from "../src/index.ts";

export const structuredConcurrencyTypeChecks = () => {
  const options = { concurrency: "unbounded", discard: true } as const;
  expectTypeOf(R.Effect.all([R.Effect.void, R.Effect.sleep(1)], options)).toEqualTypeOf<
    Computation<void, never>
  >();
  expectTypeOf(
    R.Effect.all([R.Effect.void, R.Effect.void, R.Effect.void], { ...options, mode: "default" }),
  ).toEqualTypeOf<Computation<void, never>>();
  expectTypeOf(R.Effect.race(R.Effect.void, R.Effect.sleep(1))).toEqualTypeOf<
    Computation<void, never>
  >();
  expectTypeOf(R.Effect.void.pipe(R.Effect.race(R.Effect.sleep(1)))).toEqualTypeOf<
    Computation<void, never>
  >();
  // @ts-expect-error Static groups require at least two children.
  R.Effect.all([R.Effect.void], options);
  // @ts-expect-error Static groups have at most three children.
  R.Effect.all([R.Effect.void, R.Effect.void, R.Effect.void, R.Effect.void], options);
  const dynamic: Computation<void, never>[] = [R.Effect.void, R.Effect.void];
  // @ts-expect-error Runtime collections are outside this profile.
  R.Effect.all(dynamic, options);
  // @ts-expect-error Collected values need a separate representation contract.
  R.Effect.all([R.Effect.succeed(R.U64.literal(1n)), R.Effect.void], options);
  // @ts-expect-error Failure combination needs represented Cause.
  R.Effect.race(R.Effect.fail(R.Bool.literal(false)), R.Effect.void);
  // @ts-expect-error Numeric concurrency is not admitted.
  R.Effect.all([R.Effect.void, R.Effect.void], { concurrency: 2, discard: true });
  // @ts-expect-error Default sequential options are not admitted.
  R.Effect.all([R.Effect.void, R.Effect.void]);
  // @ts-expect-error Output collection is not admitted.
  R.Effect.all([R.Effect.void, R.Effect.void], { concurrency: "unbounded", discard: false });
  // @ts-expect-error Alternate outcome mode is not admitted.
  R.Effect.all([R.Effect.void, R.Effect.void], { ...options, mode: "result" });
  // @ts-expect-error Race options are outside the bounded contract.
  R.Effect.race(R.Effect.void, R.Effect.void, { onSelfDone: () => R.Effect.void });
};
