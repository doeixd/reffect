import { Cause, Effect, Exit, FileSystem, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { DeferredIR as InternalDeferred } from "../src/deferred.ts";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  DeferredExecution,
  DeferredIR,
  FailureFrames,
  NativeRunner,
  NativeRpc,
  R,
  Rust,
  SourceArtifacts,
} from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const completed = R.fn([], R.U64, R.Never, () =>
  R.Deferred.make(R.U64).pipe(
    R.Effect.flatMap((cell) =>
      cell
        .pipe(R.Deferred.succeed(R.U64.literal(7n)))
        .pipe(
          R.Effect.andThen(R.Deferred.succeed(cell, R.U64.literal(9n))),
          R.Effect.andThen(R.Deferred.await(cell)),
        ),
    ),
  ),
);
const first = R.fn([], R.Bool, R.Never, () =>
  R.Deferred.make(R.Unit).pipe(
    R.Effect.flatMap((cell) => R.Deferred.succeed(cell, R.Unit.literal())),
  ),
);
const second = R.fn([], R.Bool, R.Never, () =>
  R.Deferred.make(R.Unit).pipe(
    R.Effect.flatMap((cell) =>
      R.Deferred.succeed(cell, R.Unit.literal()).pipe(
        R.Effect.andThen(R.Deferred.succeed(cell, R.Unit.literal())),
      ),
    ),
  ),
);
const status = R.fn([], R.Bool, R.Never, () =>
  R.Deferred.make(R.Unit).pipe(R.Effect.flatMap(R.Deferred.isDone)),
);

test("public exports retain dual completion, first-wins and owned observations", async () => {
  expect(DeferredIR).toBe(R.Deferred);
  expect(Object.keys(DeferredIR).sort()).toEqual(["await", "isDone", "make", "succeed"]);
  expect((await DeferredExecution.run(completed)).exit).toEqual(Exit.succeed(7n));
  expect((await DeferredExecution.run(status)).exit).toEqual(Exit.succeed(false));
  expect((await DeferredExecution.run(first)).exit).toEqual(Exit.succeed(true));
  expect((await DeferredExecution.run(second)).exit).toEqual(Exit.succeed(false));
  const statusArtifact = await Effect.runPromise(
    Compile.make(R.program({ status })).pipe(Compile.withTarget(Rust.tokio), Compile.run),
  );
  expect(statusArtifact.explanation.crates).toContain("tokio@1.53.1");
  const cancelled = await DeferredExecution.run(completed, { signal: AbortSignal.abort() });
  expect(Exit.isFailure(cancelled.exit) && Cause.hasInterruptsOnly(cancelled.exit.cause)).toBe(
    true,
  );
  expect(cancelled.logs).toEqual([]);
});

test("public admission refuses typed completion and unverified RPC embedding", async () => {
  const typed = R.fn([], R.Unit, R.Bool, () =>
    InternalDeferred.make(R.Unit, R.Bool).pipe(
      R.Effect.flatMap((cell) =>
        InternalDeferred.fail(cell, R.Bool.literal(true)).pipe(
          R.Effect.andThen(InternalDeferred.await(cell)),
        ),
      ),
    ),
  );
  const refused = await Effect.runPromise(Compile.run(R.program({ typed })).pipe(Effect.exit));
  expect(refused).toMatchObject({
    cause: {
      reasons: [
        {
          error: {
            diagnostics: expect.arrayContaining([
              expect.objectContaining({ code: "DEFERRED_GENERATED_PROFILE" }),
            ]),
          },
        },
      ],
    },
  });
  const group = RpcGroup.make(Rpc.make("Status", { payload: {}, success: Schema.Boolean }));
  const hosted = await Effect.runPromise(
    NativeRpc.compile(group, { Status: NativeRpc.bind(status) }).pipe(Effect.exit),
  );
  expect(Exit.isFailure(hosted)).toBe(true);
  if (Exit.isFailure(hosted))
    expect(Cause.findErrorOption(hosted.cause)).toMatchObject({
      value: {
        diagnostics: [
          expect.objectContaining({ message: expect.stringContaining("standalone exports") }),
        ],
      },
    });
});

test(
  "public standalone Deferred and ordinary exports agree after native build",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-deferred-public-" });
          const program = R.program({
            completed,
            first,
            second,
            status,
            ordinary: R.fn([], R.U64, () => R.U64.literal(11n)),
          });
          for (const frames of [FailureFrames.None, FailureFrames.Bounded]) {
            const artifact = yield* Compile.make(program).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.withFailureFrames(frames),
              Compile.run,
            );
            const directory = yield* CargoApi.write(artifact, `${parent}/${frames._tag}`);
            yield* CargoApi.build(directory);
            expect(
              yield* NativeRunner.run(artifact, directory, "completed", completed, []),
            ).toEqual(Exit.succeed(7n));
            expect(yield* NativeRunner.run(artifact, directory, "first", first, [])).toEqual(
              Exit.succeed(true),
            );
            expect(yield* NativeRunner.run(artifact, directory, "second", second, [])).toEqual(
              Exit.succeed(false),
            );
            expect(yield* NativeRunner.run(artifact, directory, "status", status, [])).toEqual(
              Exit.succeed(false),
            );
            expect(
              yield* NativeRunner.run(
                artifact,
                directory,
                "ordinary",
                program.functions.ordinary,
                [],
              ),
            ).toEqual(Exit.succeed(11n));
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);
