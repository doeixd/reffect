import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { RpcCodecs } from "reffect/rpc-codecs";

/** Shared unchanged by the stock client and native compiler. */
export const Arithmetic = RpcGroup.make(
  Rpc.make("Add", {
    payload: { left: RpcCodecs.U64Json, right: RpcCodecs.U64Json },
    success: RpcCodecs.U64Json,
  }),
  Rpc.make("Guard", {
    payload: { allowed: Schema.Boolean },
    success: Schema.Boolean,
    error: Schema.Boolean,
  }),
  // No match is `null` on the wire.
  Rpc.make("FirstBelow", {
    payload: { values: Schema.Array(RpcCodecs.U64Json), limit: RpcCodecs.U64Json },
    success: Schema.NullOr(RpcCodecs.U64Json),
  }),
  Rpc.make("Withdraw", {
    payload: { balance: RpcCodecs.U64Json, amount: RpcCodecs.U64Json },
    success: RpcCodecs.U64Json,
    error: Schema.String,
  }),
);
