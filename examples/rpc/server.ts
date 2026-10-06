/**
 * The native server: R handlers for the shared contract. Its default export is the compile
 * effect, so `reffect build examples/rpc/server.ts` turns it into a binary.
 */
import { NativeRpc, R } from "../../packages/reffect/src/index.ts";
import { Arithmetic } from "./contract.ts";

export const bindings = {
  // u64 arithmetic wraps exactly as the reference does.
  Add: NativeRpc.bind(
    R.fn([R.U64, R.U64], R.U64, (a, b) => a.pipe(R.U64.add(b))),
    ["left", "right"],
  ),
  // A typed failure, as Effect.fail.
  Guard: NativeRpc.bind(
    R.fn([R.Bool], R.Bool, R.Bool, (allowed) =>
      R.Match.bool(allowed, R.Effect.succeed(allowed), R.Effect.fail(allowed)),
    ),
    ["allowed"],
  ),
  // Option: the first value below the limit, if any, as a nullable result.
  FirstBelow: NativeRpc.bind(
    R.fn([R.Array(R.U64), R.U64], R.NullOr(R.U64), (values, limit) =>
      values.pipe(
        R.Array.findFirst((value) => R.U64.lt(value, limit)),
        R.Option.getOrNull,
      ),
    ),
    ["values", "limit"],
  ),
  // Result: decide the outcome as data, then match it into success or a typed failure.
  Withdraw: NativeRpc.bind(
    R.fn([R.U64, R.U64], R.U64, R.String, (balance, amount) =>
      R.Match.bool(
        R.U64.lt(balance, amount),
        R.Result.fail(R.String.literal("insufficient funds"), R.U64),
        R.Result.succeed(R.U64.sub(balance, amount), R.String),
      ).pipe(R.Result.match({ onSuccess: R.Effect.succeed, onFailure: R.Effect.fail })),
    ),
    ["balance", "amount"],
  ),
};

export default NativeRpc.compile(Arithmetic, bindings);
