import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcTest } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference, type Expr } from "../src/index.ts";
import { launch } from "../src/effect-ir.ts";
import { LaunchHost } from "../src/launch-host.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const Group = RpcGroup.make(
  Rpc.make("Add", { payload: { step: NativeRpc.U64Json }, success: NativeRpc.U64Json }),
  Rpc.make("Slow", { payload: Schema.Undefined, success: Schema.Boolean }),
);

const Base = R.Context.service("test/server-base@1", R.U64);
const Flag = R.Context.service("test/server-flag@1", R.Bool);
const service = <A>(name: string, value: Expr<A>) =>
  R.Effect.logInfo(`acquire ${name}`).pipe(
    R.Effect.andThen(R.Effect.addFinalizer(() => R.Effect.logInfo(`release ${name}`))),
    R.Effect.andThen(R.Effect.succeed(value)),
  );
const layer = R.Layer.sequence(
  R.Layer.effect(Base, service("base", R.U64.literal(40n))),
  R.Layer.effect(Flag, service("flag", R.Bool.literal(true))),
);
const add = R.fn([R.U64, R.U64], R.U64, R.Never, (base, step) =>
  R.Effect.succeed(R.U64.add(base, step)),
);
const slow = R.fn([R.Bool], R.Bool, R.Never, (flag) =>
  R.Effect.logInfo("slow start").pipe(
    R.Effect.andThen(R.Effect.sleep(10000)),
    R.Effect.ensuring(R.Effect.logInfo("slow cleanup")),
    R.Effect.andThen(R.Effect.succeed(flag)),
  ),
);
const bindings = {
  Add: NativeRpc.bindServices([Base], add, ["step"]),
  Slow: NativeRpc.bindServices([Flag], slow),
};
const expectedLogs = ["acquire base", "acquire flag", "release flag", "release base"];

test("server-lifetime services acquire once and release after the server, as RpcGroup.toLayer", async () => {
  const run = <A, E>(effect: Effect.Effect<A, E, never>) => {
    const logs: string[] = [];
    return Effect.runPromise(
      effect.pipe(
        Effect.provide(Logger.layer([Logger.make((event) => logs.push(String(event.message)))])),
        Effect.map((value) => ({ value, logs })),
      ),
    );
  };
  const EBase = Context.Service<bigint>("test/server-base@1");
  const officialService = <A>(name: string, value: A) =>
    Effect.logInfo(`acquire ${name}`).pipe(
      Effect.andThen(Effect.addFinalizer(() => Effect.logInfo(`release ${name}`))),
      Effect.as(value),
    );
  const handlers = Group.toLayer(
    Effect.gen(function* () {
      const base = yield* EBase;
      const flag = yield* officialService("flag", true);
      return {
        Add: ({ step }) => Effect.succeed(base + step),
        Slow: () => Effect.succeed(flag),
      };
    }),
  ).pipe(Layer.provide(Layer.effect(EBase, officialService("base", 40n))));
  const official = await run(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(Group);
        return yield* Effect.forEach([1n, 2n, 3n], (step) => client.Add({ step }));
      }),
    ).pipe(Effect.provide(handlers)),
  );
  expect(official).toEqual({ value: [41n, 42n, 43n], logs: expectedLogs });

  const launched = R.fn([], R.Never, R.Never, () =>
    R.Layer.provide(layer, (ctx) => launch([ctx.get(Base), ctx.get(Flag)])),
  );
  const reference = await run(
    Effect.scoped(
      Effect.gen(function* () {
        const published = yield* Deferred.make<readonly unknown[]>();
        const fiber = yield* Reference.run(launched, []).pipe(
          Effect.provideService(LaunchHost, {
            publish: (values) => Deferred.succeed(published, values).pipe(Effect.asVoid),
          }),
          Effect.forkScoped,
        );
        const [base] = Schema.decodeUnknownSync(Schema.Tuple([Schema.BigInt, Schema.Boolean]))(
          yield* Deferred.await(published),
        );
        const results = yield* Effect.forEach([1n, 2n, 3n], (step) =>
          Reference.run(add, [base, step]),
        );
        yield* Fiber.interrupt(fiber);
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
        return results;
      }),
    ),
  );
  expect(reference).toEqual(official);
  // Without a host, the reference refuses rather than silently never publishing.
  expect(
    await Effect.runPromise(
      Reference.run(launched, []).pipe(Effect.exit, Effect.map(Exit.isFailure)),
    ),
  ).toBe(true);
});

test("server services are refused without a layer or with mismatched witnesses", async () => {
  const check = (options: Parameters<typeof NativeRpc.compile>[2], binding = bindings) =>
    Effect.runPromise(NativeRpc.compile(Group, binding, options).pipe(Effect.flip)).then(
      (error) => error.message,
    );
  expect(await check({})).toContain("require a NativeRpc layer");
  expect(
    await check({ layer }, { ...bindings, Add: NativeRpc.bindServices([Flag], add, ["step"]) }),
  ).toContain("Handler argument witnesses");
  const Other = R.Context.service("test/server-other@1", R.U64);
  expect(
    await check({ layer }, { ...bindings, Add: NativeRpc.bindServices([Other], add, ["step"]) }),
  ).toContain("absent");
  const plain = await Effect.runPromise(
    NativeRpc.compile(
      RpcGroup.make(
        Rpc.make("Add", { payload: { step: NativeRpc.U64Json }, success: NativeRpc.U64Json }),
      ),
      {
        Add: NativeRpc.bind(
          R.fn([R.U64], R.U64, R.Never, (step) => R.Effect.succeed(step)),
          ["step"],
        ),
      },
    ),
  );
  // Servers without a layer keep their existing runtime shape and features.
  expect(plain.runtime.services).toEqual([]);
  expect(plain.files["src/main.rs"]).not.toContain("SERVICES");
  expect(plain.files["Cargo.toml"]).not.toContain("signal");
  expect(plain.files["src/lib.rs"]).not.toContain("LaunchValues");
});

const binary = (directory: string, profile: "debug" | "release") =>
  `${directory}/target/${profile}/reffect_generated${process.platform === "win32" ? ".exe" : ""}`;
const messages = (lines: readonly string[]) =>
  lines
    .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
    .map((line) => JSON.parse(line).message as string);

const serve = (directory: string, profile: "debug" | "release") =>
  Effect.scoped(
    Effect.gen(function* () {
      const stop = yield* Deferred.make<void>();
      const slowStarted = yield* Deferred.make<void>();
      const child = yield* ChildProcess.make(
        binary(directory, profile),
        ["--port", "0", "--shutdown-on-stdin-eof"],
        { stdin: Stream.fromEffect(Deferred.await(stop)).pipe(Stream.drain) },
      );
      const stderr: string[] = [];
      const collected = yield* Stream.splitLines(Stream.decodeText(child.stderr)).pipe(
        Stream.runForEach((line) =>
          Effect.sync(() => stderr.push(line)).pipe(
            Effect.andThen(
              line.includes('"message":"slow start"')
                ? Deferred.succeed(slowStarted, undefined)
                : Effect.void,
            ),
          ),
        ),
        Effect.forkScoped,
      );
      const ready = yield* Stream.runHead(Stream.splitLines(Stream.decodeText(child.stdout))).pipe(
        Effect.timeout("10 seconds"),
      );
      if (!Option.isSome(ready)) throw new Error("Missing ready record");
      const { address } = Schema.decodeUnknownSync(
        Schema.Struct({ schema: Schema.Literal("reffect.rpc.ready@1"), address: Schema.String }),
      )(JSON.parse(ready.value));
      const client = yield* RpcClient.make(Group, { disableTracing: true }).pipe(
        Effect.provide(
          RpcClient.layerProtocolHttp({ url: `http://${address}/rpc` }).pipe(
            Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
          ),
        ),
      );
      const sums = yield* Effect.forEach(
        Array.from({ length: 8 }, (_, i) => BigInt(i)),
        (step) => client.Add({ step }),
        { concurrency: "unbounded" },
      );
      expect(sums).toEqual(Array.from({ length: 8 }, (_, i) => 40n + BigInt(i)));
      const pending = yield* client.Slow(undefined).pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(slowStarted).pipe(Effect.timeout("10 seconds"));
      yield* Deferred.succeed(stop, undefined);
      const exitCode = yield* child.exitCode.pipe(Effect.timeout("20 seconds"));
      yield* Fiber.join(collected);
      const slowExit = yield* Fiber.join(pending);
      expect(Exit.isFailure(slowExit)).toBe(true);
      return { exitCode: Number(exitCode), logs: messages(stderr) };
    }),
  );

test(
  "native server-lifetime services serve stock clients and shut down gracefully",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-server-layer-" });
          const artifact = yield* NativeRpc.compile(Group, bindings, { layer });
          expect(artifact.runtime.services).toEqual(["test/server-base@1", "test/server-flag@1"]);
          expect(artifact.files["Cargo.toml"]).toContain('"signal"');
          const directory = yield* CargoApi.write(artifact, `${parent}/ok`);
          yield* CargoApi.fetch(directory);
          for (const profile of ["debug", "release"] as const) {
            yield* CargoApi.build(directory, profile);
            const result = yield* serve(directory, profile);
            expect(result.exitCode, profile).toBe(0);
            // In-flight work is interrupted and awaited before services are released.
            expect(result.logs, profile).toEqual([
              "acquire base",
              "acquire flag",
              "slow start",
              "slow cleanup",
              "release flag",
              "release base",
            ]);
          }

          const failing = R.Layer.sequence(
            R.Layer.effect(Base, service("base", R.U64.literal(40n))),
            R.Layer.effect(
              Flag,
              R.Effect.logInfo("acquire flag").pipe(
                R.Effect.andThen(
                  R.Match.bool(
                    R.Bool.literal(false),
                    R.Effect.succeed(R.Bool.literal(true)),
                    R.Effect.fail(R.Bool.literal(false)),
                  ),
                ),
              ),
            ),
          );
          const failed = yield* NativeRpc.compile(Group, bindings, { layer: failing });
          const failedDirectory = yield* CargoApi.write(failed, `${parent}/failed`);
          yield* CargoApi.build(failedDirectory, "debug");
          const run = yield* CargoApi.run(failedDirectory, "--port", [0n], "debug").pipe(
            Effect.flip,
          );
          if (!("exitCode" in run)) throw run;
          expect(run.exitCode).toBe(1);
          expect(run.stdout).not.toContain("reffect.rpc.ready@1");
          expect(messages(run.stderr.split("\n"))).toEqual([
            "acquire base",
            "acquire flag",
            "release base",
          ]);
          expect(run.stderr).toContain('"schema":"reffect.rpc.startup@1"');
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(1) + 240000,
);
