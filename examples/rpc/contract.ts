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
);
