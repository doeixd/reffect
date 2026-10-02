import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { RpcCodecs } from "../../packages/reffect/src/rpc-codecs.ts";

export const Files = RpcGroup.make(
  Rpc.make("Size", {
    payload: { wait: Schema.Boolean },
    success: RpcCodecs.U64Json,
    error: Schema.Boolean,
  }),
);
