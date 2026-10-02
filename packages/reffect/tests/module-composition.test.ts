import { Effect, Exit, FileSystem, Logger, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
import { Rpc, RpcGroup } from "effect/rpc";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  FailureFrames,
  NativeRpc,
  NativeRunner,
  R,
  Reference,
  RpcCodecs,
  Rust,
  SourceArtifacts,
} from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const Value = R.Context.service("test/module-composition/value@1", R.U64);
const minimum = 9007199254740993n;
const range = RpcCodecs.u64Range({ minimum, maximum: minimum + 5n });
const combined = R.fn([R.U64, R.Bool], R.U64, R.Never, (value, allowed) => {
  const layer = R.Layer.effect(
    Value,
    R.Log.info("layer").pipe(R.Effect.flatMap(() => R.Effect.succeed(value))),
  );
  return R.Layer.provide(R.Layer.sequence(layer, layer), (context) =>
    R.Effect.acquireUseRelease(
      R.Log.info("acquire").pipe(
        R.Effect.flatMap(() => R.Effect.sleep(1)),
        R.Effect.flatMap(() => R.Effect.succeed(context.get(Value))),
      ),
      (resource) =>
        R.Log.info("use").pipe(
          R.Effect.flatMap(() =>
            R.Match.bool(
              allowed,
              R.Effect.succeed(R.U64.add(resource, context.get(Value))),
              R.Effect.fail(allowed),
            ),
          ),
        ),
      () => R.Log.info("release").pipe(R.Effect.flatMap(() => R.Effect.sleep(1))),
    ).pipe(
      R.Effect.catchAll(() =>
        R.Log.info("recover").pipe(R.Effect.flatMap(() => R.Effect.succeed(context.get(Value)))),
      ),
    ),
  );
});
const group = RpcGroup.make(
  Rpc.make("Combined", {
    payload: { value: range, allowed: Schema.Boolean },
    success: RpcCodecs.U64Json,
  }),
);
const messages = (stderr: string) =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
    .map((line) => JSON.parse(line).message);

test(
  "shared services, bracket cleanup and recovery compose in the constrained RPC profile",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          expect(() => Schema.decodeUnknownSync(range)((minimum - 1n).toString())).toThrow();
          const value = Schema.decodeUnknownSync(range)(minimum.toString());
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({
            prefix: "reffect-module-composition-",
          });
          for (const failureFrames of [FailureFrames.Bounded, FailureFrames.None]) {
            const rpc = yield* NativeRpc.compile(
              group,
              { Combined: NativeRpc.bind(combined, ["value", "allowed"]) },
              { failureFrames },
            );
            expect(rpc.runtime.handlerProfile).toBe("suspended-scalars");
            const artifact = yield* Compile.make(R.program({ combined })).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withFailureFrames(failureFrames),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.run,
            );
            const directory = yield* CargoApi.write(artifact, `${parent}/${failureFrames._tag}`);
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              for (const allowed of [true, false]) {
                const expectedLogs = [
                  "layer",
                  "acquire",
                  "use",
                  "release",
                  ...(allowed ? [] : ["recover"]),
                ];
                const referenceLogs: string[] = [];
                const reference = yield* Reference.run(combined, [value, allowed]).pipe(
                  Effect.provide(
                    Logger.layer([
                      Logger.make((event) => referenceLogs.push(String(event.message))),
                    ]),
                  ),
                );
                expect(reference).toBe(allowed ? value * 2n : value);
                expect(referenceLogs).toEqual(expectedLogs);
                if (FailureFrames.isNone(failureFrames)) {
                  expect(
                    yield* NativeRunner.run(
                      artifact,
                      directory,
                      "combined",
                      combined,
                      [value, allowed],
                      profile,
                    ),
                  ).toEqual(Exit.succeed(reference));
                } else {
                  const native = yield* NativeRunner.runWithFrames(
                    artifact,
                    directory,
                    "combined",
                    combined,
                    [value, allowed],
                    profile,
                  );
                  expect(native.exit).toEqual(Exit.succeed(reference));
                  expect(native.frames).toEqual([]);
                }
                const process = yield* CargoApi.run(
                  directory,
                  "combined",
                  [value, allowed],
                  profile,
                );
                expect(messages(process.stderr)).toEqual(expectedLogs);
              }
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);
