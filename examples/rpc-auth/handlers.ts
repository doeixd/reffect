import { NativeRpc, R } from "reffect";
import { Authentication, CurrentPrincipal } from "./contract.ts";

export const whoAmI = R.fn([R.U64, R.Bool], R.U64, R.Bool, (principal, allowed) =>
  R.Log.info("handler", [["principal_arg", principal]]).pipe(
    R.Effect.flatMap(() =>
      R.Match.bool(allowed, R.Effect.succeed(principal), R.Effect.fail(allowed)),
    ),
  ),
);
export const publicHandler = R.fn([], R.U64, R.Never, () =>
  R.Log.info("public").pipe(R.Effect.flatMap(() => R.Effect.succeed(R.U64.literal(0n)))),
);
export const auth = NativeRpc.bearer(Authentication, CurrentPrincipal, {
  credentialsEnv: "REFFECT_RPC_CREDENTIALS",
});
export const bindings = {
  WhoAmI: NativeRpc.bindPrincipal(whoAmI, ["allowed"]),
  Public: NativeRpc.bind(publicHandler),
};
