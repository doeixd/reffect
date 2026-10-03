import { expectTypeOf } from "vite-plus/test";
import { type Computation, R } from "../src/index.ts";

export const fallibleConcurrencyTypeChecks = () => {
  const options = { concurrency: "unbounded", discard: true } as const;
  const failure = R.Effect.fail(R.U64.literal(1n)).pipe(R.Effect.asVoid);
  expectTypeOf(R.Effect.all([failure, R.Effect.void], options)).toEqualTypeOf<
    Computation<void, bigint>
  >();
  expectTypeOf(R.Effect.all([failure, failure, failure], options)).toEqualTypeOf<
    Computation<void, bigint>
  >();
  expectTypeOf(R.Effect.race(failure, R.Effect.void)).toEqualTypeOf<Computation<void, bigint>>();
  expectTypeOf(failure.pipe(R.Effect.race(R.Effect.void))).toEqualTypeOf<
    Computation<void, bigint>
  >();
  expectTypeOf(
    R.Effect.all([failure, R.Effect.void], options).pipe(R.Effect.catchAll(() => R.Effect.void)),
  ).toEqualTypeOf<Computation<void, never>>();
  // @ts-expect-error Collected success values remain outside the discarded Unit profile.
  R.Effect.all([R.Effect.succeed(R.U64.literal(1n)), failure], options);
  // @ts-expect-error Exposed winner fibers remain outside the represented ownership profile.
  R.Effect.race(failure, R.Effect.void, { onWinner: () => {} });
};
