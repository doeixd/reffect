import { Cause, Effect, Exit, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { expect, test } from "vite-plus/test";
import { NativeRpc, R } from "../src/index.ts";

const options = { concurrency: "unbounded", discard: true } as const;
const Group = RpcGroup.make(
  Rpc.make("Work", { payload: Schema.Undefined, success: Schema.Undefined, error: Schema.Boolean }),
);
test("RPC refuses fallible task causes before emitting a lossy protocol adapter", async () => {
  const handler = R.fn([], R.Unit, R.Bool, () =>
    R.Effect.all([R.Effect.fail(R.Bool.literal(false)), R.Effect.void], options),
  );
  const exit = await Effect.runPromise(
    NativeRpc.compile(Group, { Work: NativeRpc.bind(handler) }).pipe(Effect.exit),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const error = Cause.findErrorOption(exit.cause);
    expect(error).toMatchObject({
      value: {
        diagnostics: [{ path: "handlers", message: expect.stringContaining("compound RPC Cause") }],
      },
    });
  }
});
