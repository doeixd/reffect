import { Context, Effect, FileSystem, Layer, Logger, Scope } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import {
  R,
  Compile,
  CargoApi,
  NativeRunner,
  Reference,
  Rust,
  FailureFrames,
  SourceArtifacts,
} from "../src/index.ts";
import { ContextIR } from "../src/context.ts";
import { LayerIR } from "../src/layer.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const Count = ContextIR.service("test/count@1", R.U64);
const Other = ContextIR.service("test/other@1", R.Bool);
const SameCount = ContextIR.service("test/count@1", R.U64);
const WrongCount = ContextIR.service("test/count@1", R.Bool);
const acquire = (value: bigint, label: string) =>
  R.Log.info(label).pipe(
    R.Effect.flatMap(() => R.Effect.sleep(1)),
    R.Effect.flatMap(() => R.Effect.succeed(R.U64.literal(value))),
  );
const shared = LayerIR.effect(Count, acquire(10n, "base"));
const fresh = LayerIR.fresh(shared);
const overridden = LayerIR.effect(Count, acquire(20n, "override"));
const sharedFn = R.fn([], R.U64, R.Never, () =>
  LayerIR.provide(LayerIR.sequence(shared, shared), (context) =>
    R.Effect.succeed(context.get(SameCount)),
  ),
);
const freshFn = R.fn([], R.U64, R.Never, () =>
  LayerIR.provide(LayerIR.sequence(fresh, fresh), (context) =>
    R.Effect.succeed(context.get(Count)),
  ),
);
const overrideFn = R.fn([], R.U64, R.Never, () =>
  LayerIR.provide(LayerIR.sequence(shared, overridden), (context) =>
    R.Effect.succeed(context.get(Count)),
  ),
);
const unusedFn = R.fn([], R.U64, R.Never, () =>
  LayerIR.provide(shared, () => R.Effect.succeed(R.U64.literal(0n))),
);
const program = R.program({
  shared: sharedFn,
  fresh: freshFn,
  override: overrideFn,
  unused: unusedFn,
});
const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const logs: string[] = [];
  return effect.pipe(
    Effect.provide(Logger.layer([Logger.make((event) => logs.push(String(event.message)))])),
    Effect.map((value) => ({ value, logs })),
  );
};
const EffectCount = Context.Service<bigint>("test/count@1");
const oracleAcquire = (value: bigint, label: string) =>
  Effect.logInfo(label).pipe(Effect.andThen(Effect.sleep(1)), Effect.as(value));
const officialShared = Layer.effect(EffectCount, oracleAcquire(10n, "base"));
const officialFresh = Layer.fresh(officialShared);
const officialOverride = Layer.effect(EffectCount, oracleAcquire(20n, "override"));
const oracle = (name: "shared" | "fresh" | "override" | "unused") =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const memo = yield* Layer.makeMemoMap;
      const left = yield* Layer.buildWithMemoMap(
        name === "fresh" ? officialFresh : officialShared,
        memo,
        scope,
      );
      if (name === "unused") return 0n;
      const right = yield* Layer.buildWithMemoMap(
        name === "fresh" ? officialFresh : name === "override" ? officialOverride : officialShared,
        memo,
        scope,
      );
      return Context.get(Context.merge(left, right), EffectCount);
    }),
  );
const messages = (stderr: string) =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
    .map((line) => JSON.parse(line).message);

test("lexical Context enforces available keys/witnesses and right overrides", () => {
  const context = ContextIR.empty().add(Count, R.U64.literal(1n)).add(Other, R.Bool.literal(true));
  expect(context.get(SameCount)).toBe(context.get(Count));
  const replacement = ContextIR.empty().add(Count, R.U64.literal(2n));
  expect(context.merge(replacement).get(Count)).toBe(replacement.get(Count));
  expect(() => context.merge(ContextIR.empty().add(WrongCount, R.Bool.literal(false)))).toThrow(
    "different witness",
  );
  expect(() => LayerIR.merge(shared, shared)).toThrow("concurrent merge");
  const pure = LayerIR.merge(
    LayerIR.succeed(Count, R.U64.literal(3n)),
    LayerIR.succeed(Other, R.Bool.literal(false)),
  );
  expect(LayerIR.provide(pure, (ctx) => R.Effect.succeed(ctx.get(Count))).output).toBe(R.U64);
  const typeContracts = () => {
    // @ts-expect-error Context tracks missing service keys.
    ContextIR.empty().get(Count);
    // @ts-expect-error A provided service does not admit an unrelated key.
    ContextIR.empty().add(Count, R.U64.literal(1n)).get(Other);
    // @ts-expect-error Service value must agree with its witness.
    ContextIR.empty().add(Count, R.Bool.literal(false));
    // @ts-expect-error A provider callback only exposes the services provided by its layer.
    LayerIR.provide(shared, (ctx) => R.Effect.succeed(ctx.get(Other)));
    // @ts-expect-error Acquisition output must match service witness.
    LayerIR.effect(Count, R.Effect.succeed(R.Bool.literal(false)));
    const fallible = R.Match.bool(
      R.Bool.literal(true),
      R.Effect.succeed(R.U64.literal(1n)),
      R.Effect.fail(R.Bool.literal(false)),
    );
    // @ts-expect-error Fallible acquisition is outside the bounded Layer profile.
    LayerIR.effect(Count, fallible);
  };
  void typeContracts;
});

test(
  "static Layers preserve official sharing/freshness/override and unused acquisition in native builds",
  async () => {
    const cases = [
      ["shared", sharedFn, ["base"], 10n],
      ["fresh", freshFn, ["base", "base"], 10n],
      ["override", overrideFn, ["base", "override"], 20n],
      ["unused", unusedFn, ["base"], 0n],
    ] as const;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          for (const [name, fn, logs, value] of cases) {
            const official = yield* observed(oracle(name));
            expect(official).toEqual({ value, logs });
            expect(yield* observed(Reference.run(fn, []))).toEqual(official);
            // Separate invocations must acquire again rather than retaining a global instance.
            expect(yield* observed(Reference.run(fn, []))).toEqual(official);
          }
          const pureFn = R.fn([], R.U64, R.Never, () =>
            LayerIR.provide(LayerIR.succeed(Count, R.U64.literal(3n)), (ctx) =>
              R.Effect.succeed(ctx.get(Count)),
            ),
          );
          const pureArtifact = yield* Compile.run(R.program({ pure: pureFn }));
          expect(pureArtifact.explanation.crates).toEqual([]);
          expect(pureArtifact.files["src/lib.rs"]).not.toContain("AsyncContext");
          expect(pureArtifact.files["src/lib.rs"]).not.toContain("HashMap");
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-layer-" });
          for (const failureFrames of [FailureFrames.Bounded, FailureFrames.None]) {
            const artifact = yield* Compile.make(program).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withFailureFrames(failureFrames),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.run,
            );
            expect(artifact.explanation.crates).toEqual(["tokio@1.53.1"]);
            for (const token of ["HashMap", "dyn Future", "StaticContext", "test/count@1"])
              expect(artifact.files["src/lib.rs"]).not.toContain(token);
            const directory = yield* CargoApi.write(artifact, `${parent}/${failureFrames._tag}`);
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              for (const [name, fn, logs, value] of cases) {
                const exit = yield* NativeRunner.run(artifact, directory, name, fn, [], profile);
                expect(exit).toEqual(
                  yield* Effect.exit(Reference.run(fn, []).pipe(Effect.provide(Logger.layer([])))),
                );
                const raw = yield* CargoApi.run(directory, name, [], profile);
                expect(raw.exitCode).toBe(0);
                expect(messages(raw.stderr)).toEqual(logs);
                expect(raw.stdout.trim()).toBe(`ok:u64:${value}`);
              }
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);
