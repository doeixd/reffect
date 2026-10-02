import { NativeRpc, R } from "reffect";
import { Authentication, CurrentPrincipal } from "../rpc-auth/contract.ts";

const cleanup = (name: string) =>
  R.Log.info(`${name}:start`).pipe(
    R.Effect.flatMap(() => R.Effect.sleep(30)),
    R.Effect.flatMap(() => R.Log.info(`${name}:done`)),
  );
export const whoAmI = R.fn([R.U64, R.Bool], R.U64, R.Bool, (principal, allowed) =>
  R.Log.info("started").pipe(
    R.Effect.flatMap(() => R.Effect.sleep(250)),
    R.Effect.flatMap(() => R.Log.info("after")),
    R.Effect.flatMap(() =>
      R.Match.bool(allowed, R.Effect.succeed(principal), R.Effect.fail(allowed)),
    ),
    R.Effect.ensuring(cleanup("inner")),
    R.Effect.ensuring(cleanup("outer")),
    R.Log.annotate("owner", principal),
    R.Log.span("handler"),
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
