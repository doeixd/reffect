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
};

export default NativeRpc.compile(Arithmetic, bindings);
