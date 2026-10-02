import { flow as effectFlow } from "effect";
import { expectTypeOf } from "vite-plus/test";
import { Computation, EffectFn, Expr, Fn, R, flow } from "../src/index.ts";

// Checked by strict TypeScript; never executed.
export const flowTypeChecks = () => {
  const one = R.fn([R.U64], R.U64, (x) => R.U64.add(x, R.U64.literal(1n)));
  const double = R.fn([R.U64], R.U64, (x) => R.U64.mul(x, R.U64.literal(2n)));
  expectTypeOf(flow(one, double)).toEqualTypeOf<Fn<readonly [typeof R.U64], bigint>>();
  expectTypeOf(flow(one, double, one)).toEqualTypeOf<Fn<readonly [typeof R.U64], bigint>>();
  expectTypeOf(flow(one)).toEqualTypeOf<typeof one>();
  const multi = R.fn([R.U64, R.Bool], R.U64, (a, _b) => a);
  expectTypeOf(flow(multi, double)).toEqualTypeOf<
    Fn<readonly [typeof R.U64, typeof R.Bool], bigint>
  >();
  const failing = R.fn([R.U64], R.U64, R.Bool, (x) =>
    R.Match.bool(
      R.U64.eq(x, R.U64.literal(0n)),
      R.Effect.fail(R.Bool.literal(true)),
      R.Effect.succeed(x),
    ),
  );
  expectTypeOf(flow(failing, double)).toEqualTypeOf<
    EffectFn<readonly [typeof R.U64], bigint, boolean>
  >();
  const pureThenEffect = R.flow(one, failing);
  expectTypeOf(pureThenEffect).toEqualTypeOf<EffectFn<readonly [typeof R.U64], bigint, boolean>>();
  // @ts-expect-error composes only Fn/EffectFn, not plain functions
  flow((x: number) => x + 1);
  // Witness and arity mismatches are refused at runtime (see flow.test.ts), not encoded in FlowResult.
  flow(
    one,
    R.fn([R.Bool], R.U64, (_x) => R.U64.literal(0n)),
  );
  flow(
    one,
    R.fn([R.U64, R.U64], R.U64, (a, _b) => a),
  );
  // plain Effect flow still composes builder functions with full inference
  const builder = effectFlow(
    (x: Expr<bigint>) => R.U64.add(x, R.U64.literal(1n)),
    (x) => R.U64.mul(x, R.U64.literal(2n)),
  );
  expectTypeOf(builder).toEqualTypeOf<(x: Expr<bigint>) => Expr<bigint>>();
  const effectBuilder = effectFlow(
    (x: Expr<bigint>) => R.Effect.succeed(x),
    (c) => R.Effect.asVoid(c),
  );
  expectTypeOf(effectBuilder).toEqualTypeOf<(x: Expr<bigint>) => Computation<void, never>>();
};
