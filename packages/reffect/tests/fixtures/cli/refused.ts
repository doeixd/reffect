// A `reffect check` entry the compiler refuses: a batch limit must be a positive integer.
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { NativeRpc, R } from "../../../src/index.ts";

const Group = RpcGroup.make(
  Rpc.make("Echo", { payload: { text: Schema.String }, success: Schema.String }),
);
export default NativeRpc.compile(
  Group,
  {
    Echo: NativeRpc.bind(
      R.fn([R.String], R.String, (text) => text),
      ["text"],
    ),
  },
  { limits: { batch: 0 } },
);
