import type { Deferred } from "effect";
import { expectTypeOf } from "vite-plus/test";
import { Computation, R } from "../src/index.ts";
import { DeferredIR } from "../src/deferred.ts";

export const deferredIntegrationTypes = () => {
  expectTypeOf(DeferredIR.make(R.U64)).toEqualTypeOf<
    Computation<Deferred.Deferred<bigint, never>, never>
  >();
  R.Effect.flatMap(DeferredIR.make(R.U64, R.Bool), (cell) => {
    expectTypeOf(DeferredIR.await(cell)).toEqualTypeOf<Computation<bigint, boolean>>();
    expectTypeOf(DeferredIR.succeed(cell, R.U64.literal(7n))).toEqualTypeOf<
      Computation<boolean, never>
    >();
    expectTypeOf(DeferredIR.succeed(R.U64.literal(7n))(cell)).toEqualTypeOf<
      Computation<boolean, never>
    >();
    expectTypeOf(DeferredIR.fail(cell, R.Bool.literal(false))).toEqualTypeOf<
      Computation<boolean, never>
    >();
    expectTypeOf(DeferredIR.fail(R.Bool.literal(false))(cell)).toEqualTypeOf<
      Computation<boolean, never>
    >();
    // @ts-expect-error A Boolean value cannot complete a bigint success channel.
    DeferredIR.succeed(cell, R.Bool.literal(true));
    // @ts-expect-error A bigint value cannot complete a Boolean failure channel.
    DeferredIR.fail(cell, R.U64.literal(7n));
    // @ts-expect-error Data-last success also retains the handle's channel.
    DeferredIR.succeed(R.Bool.literal(true))(cell);
    return DeferredIR.await(cell);
  });
};
