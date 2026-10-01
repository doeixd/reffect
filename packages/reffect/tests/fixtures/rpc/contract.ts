import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { R } from "../../../src/index.ts";

export const U64Json = Schema.BigIntFromString.check(
  Schema.isGreaterThanOrEqualToBigInt(0n),
  Schema.isLessThanOrEqualToBigInt(18446744073709551615n),
);

/** Wire records map to existing scalar handlers; no general native record support is implied. */
export const UnaryGroup = RpcGroup.make(
  Rpc.make("Add", {
    payload: { left: U64Json, right: U64Json },
    success: U64Json,
  }),
  Rpc.make("Guard", {
    payload: { allowed: Schema.Boolean },
    success: Schema.Boolean,
    error: Schema.Boolean,
  }),
  Rpc.make("Unit", { payload: Schema.Undefined, success: Schema.Undefined }),
);

export const unaryHandlers = {
  Add: R.fn([R.U64, R.U64], R.U64, (left, right) => left.pipe(R.U64.add(right))),
  Guard: R.fn([R.Bool], R.Bool, R.Bool, (allowed) =>
    R.Match.bool(
      allowed,
      R.Effect.succeed(R.Bool.literal(true)),
      R.Effect.fail(R.Bool.literal(false)),
    ),
  ),
  Unit: R.fn([], R.Unit, R.Never, () => R.Effect.void),
};
