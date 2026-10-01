import { Context, Schema } from "effect";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";
import { RpcCodecs } from "reffect/rpc-codecs";

export class CurrentPrincipal extends Context.Service<CurrentPrincipal, bigint>()(
  "reffect/example/CurrentPrincipal",
) {}
export class Authentication extends RpcMiddleware.Service<
  Authentication,
  { provides: CurrentPrincipal }
>()("reffect/example/Authentication", { error: Schema.Literal("Unauthorized") }) {}

export const Authenticated = RpcGroup.make(
  Rpc.make("WhoAmI", {
    payload: { allowed: Schema.Boolean },
    success: RpcCodecs.U64Json,
    error: Schema.Boolean,
  }).middleware(Authentication),
  Rpc.make("Public", { payload: Schema.Undefined, success: RpcCodecs.U64Json }),
);
