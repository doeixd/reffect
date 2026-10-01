import { Cause, Effect, Exit, FileSystem } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  CompileError,
  Computation,
  NativeRunner,
  Operation,
  Plan,
  R,
  Reference,
  SemanticRef,
  Target,
  Rust,
  Capabilities,
  apply,
} from "../src/index.ts";

const observe = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.match(exit, {
    onSuccess: (value) => ({ success: value }),
    onFailure: (cause) => ({ failure: Cause.squash(cause) }),
  });

const branch = R.fn([R.U64, R.U64], R.U64, R.U64, (a, b) =>
  R.Match.bool(R.U64.lt(a, b), R.Effect.succeed(R.U64.sub(b, a)), R.Effect.fail(a)),
);
const nested = R.fn([R.U64], R.U64, R.U64, (a) =>
  R.Effect.succeed(a).pipe(
    R.Effect.flatMap((outer) =>
      R.Effect.succeed(R.U64.literal(2n)).pipe(R.Effect.map((inner) => R.U64.add(outer, inner))),
    ),
    R.Effect.map((value) => R.U64.mul(value, a)),
  ),
);
const stop = R.fn([R.U64], R.U64, R.U64, (a) =>
  R.Effect.fail(a).pipe(R.Effect.flatMap(() => R.Effect.fail(R.U64.literal(99n)))),
);
const failed = R.fn([], R.U64, R.Bool, () => R.Effect.fail(R.Bool.literal(false)));
const bool = R.fn([R.Bool], R.Bool, (a) => R.Bool.not(a));
const selected = R.fn([R.Bool], R.U64, (a) =>
  R.Match.bool(a, R.U64.literal(3n), R.U64.literal(7n)),
);
const successOnly = R.Effect.fn([R.U64], R.U64, R.Never, (a) => R.Effect.succeed(a));
const failureOnly = R.Effect.fn([], R.Never, R.U64, () => R.Effect.fail(R.U64.literal(1n)));
const decision = R.fn([R.U64, R.U64], R.Bool, R.U64, (a, b) =>
  R.Match.bool(
    R.U64.eq(a, b),
    R.Effect.succeed(R.Bool.eq(R.Bool.literal(true), R.Bool.literal(false))),
    R.Effect.fail(b),
  ),
);
const sharedPure = R.fn([R.Bool], R.U64, (condition) => {
  let value = R.U64.literal(6n);
  for (let i = 0; i < 32; i++) value = R.Match.bool(condition, value, value);
  return value;
});
const sharedEffect = R.fn([R.Bool], R.U64, R.Never, (condition) => {
  let value = R.Effect.succeed(R.U64.literal(8n));
  for (let i = 0; i < 32; i++) value = R.Match.bool(condition, value, value);
  return value;
});
const program = R.program({
  decision,
  sharedPure,
  sharedEffect,
  branch,
  nested,
  stop,
  failed,
  bool,
  selected,
  successOnly,
  failureOnly,
});

test("official Effect and native Result agree in fresh debug and release builds", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const artifact = yield* Compile.run(program);
        const fs = yield* FileSystem.FileSystem;
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-effect-" });
        const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
        expect(artifact.explanation.crates).toEqual([]);
        expect(artifact.explanation.runtime).toBe(Rust.syncResult);
        expect(artifact.explanation.analysis.effects).toHaveLength(5);
        for (const profile of ["debug", "release"] as const) {
          yield* CargoApi.build(directory, profile);
          for (const args of [
            [0n, 1n],
            [1n, 1n],
            [R.U64.max, 0n],
            [0n, R.U64.max],
          ] as const) {
            expect(
              observe(
                yield* NativeRunner.run(artifact, directory, "branch", branch, args, profile),
              ),
            ).toEqual(observe(yield* Effect.exit(Reference.run(branch, args))));
          }
          for (const args of [
            [1n, 1n],
            [0n, R.U64.max],
          ] as const) {
            expect(
              observe(
                yield* NativeRunner.run(artifact, directory, "decision", decision, args, profile),
              ),
            ).toEqual(observe(yield* Effect.exit(Reference.run(decision, args))));
          }
          for (const input of [0n, 5n, R.U64.max]) {
            expect(
              yield* NativeRunner.run(artifact, directory, "nested", nested, [input], profile),
            ).toEqual(yield* Effect.exit(Reference.run(nested, [input])));
            expect(
              yield* NativeRunner.run(artifact, directory, "stop", stop, [input], profile),
            ).toEqual(Exit.fail(input));
            expect(
              yield* NativeRunner.run(
                artifact,
                directory,
                "successOnly",
                successOnly,
                [input],
                profile,
              ),
            ).toEqual(Exit.succeed(input));
          }
          for (const input of [true, false]) {
            expect(
              yield* NativeRunner.run(
                artifact,
                directory,
                "sharedPure",
                sharedPure,
                [input],
                profile,
              ),
            ).toEqual(Exit.succeed(6n));
            expect(
              yield* NativeRunner.run(
                artifact,
                directory,
                "sharedEffect",
                sharedEffect,
                [input],
                profile,
              ),
            ).toEqual(Exit.succeed(8n));
            expect(
              yield* NativeRunner.run(artifact, directory, "bool", bool, [input], profile),
            ).toEqual(Exit.succeed(!input));
            expect(
              yield* NativeRunner.run(artifact, directory, "selected", selected, [input], profile),
            ).toEqual(yield* Effect.exit(Reference.run(selected, [input])));
          }
          expect(
            yield* NativeRunner.run(artifact, directory, "failed", failed, [], profile),
          ).toEqual(Exit.fail(false));
          expect(
            yield* NativeRunner.run(artifact, directory, "failureOnly", failureOnly, [], profile),
          ).toEqual(Exit.fail(1n));
          expect((yield* CargoApi.run(directory, "failed", [], profile)).exitCode).toBe(0);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}, 120_000);

const codes = (effect: Effect.Effect<unknown, CompileError>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.map(() => Array<string>()),
      Effect.catchTag("CompileError", (error) =>
        Effect.succeed(error.diagnostics.map((d) => d.code)),
      ),
    ),
  );
test("continuation binders are lexical and function channels are checked", async () => {
  let escaped = R.U64.literal(0n);
  R.Effect.succeed(R.U64.literal(1n)).pipe(
    R.Effect.map((value) => {
      escaped = value;
      return value;
    }),
  );
  const invalid = R.fn([], R.U64, R.Never, () => R.Effect.succeed(escaped));
  expect(await codes(Compile.run(R.program({ invalid })))).toContain("FOREIGN_PARAMETER");
  const forged = R.fn([], R.U64, R.U64, () =>
    Computation.make(R.U64, R.U64, { _tag: "Succeed", value: R.U64.literal(1n) }),
  );
  expect(await codes(Compile.run(R.program({ forged })))).toContain("TYPE_MISMATCH");
  expect(() =>
    R.Match.bool(
      R.Bool.literal(true),
      R.Effect.fail(R.Bool.literal(true)),
      R.Effect.fail(R.U64.literal(1n)),
    ),
  ).toThrow("explicit union representation");
});

test("builders run once and reference branches and failures skip unused work", async () => {
  let builds = 0;
  let executions = 0;
  const trap = Operation.make(SemanticRef.operation("test/trap"), [], R.U64, () => {
    executions++;
    throw new Error("trap");
  });
  const safe = R.fn([], R.U64, R.U64, () => {
    builds++;
    return R.Match.bool(
      R.Bool.literal(true),
      R.Effect.succeed(R.U64.literal(4n)),
      R.Effect.succeed(apply(trap)),
    );
  });
  const short = R.fn([], R.U64, R.U64, () =>
    R.Effect.fail(R.U64.literal(8n)).pipe(R.Effect.map(() => apply(trap))),
  );
  expect(await Effect.runPromise(Reference.run(safe, []))).toBe(4n);
  expect(observe(await Effect.runPromise(Effect.exit(Reference.run(short, []))))).toEqual({
    failure: 8n,
  });
  expect(builds).toBe(1);
  expect(executions).toBe(0);
  expect(await codes(Compile.run(R.program({ safe })))).toContain("UNSUPPORTED_OPERATION");
});

test("shared branch graphs lower linearly and literal types still require capabilities", async () => {
  const sharedAt = (depth: number) =>
    R.fn([R.Bool], R.U64, R.Never, (condition) => {
      let value = R.Effect.succeed(R.U64.literal(2n));
      for (let i = 0; i < depth; i++) value = R.Match.bool(condition, value, value);
      return value;
    });
  // Frame literals embed paths that grow with nesting depth, so byte growth on
  // pathological nesting is roughly quadratic; node sharing itself stays linear.
  const lowerAt = (depth: number) =>
    Effect.runPromise(
      Compile.explain(R.program({ shared: sharedAt(depth) })).pipe(
        Effect.flatMap(Compile.analyzeOwnership),
        Effect.flatMap((ownership) => Compile.lower(ownership)),
      ),
    );
  const [smallModule, bigModule] = await Promise.all([lowerAt(16), lowerAt(128)]);
  expect(bigModule.functions[0].helpers.length).toBeLessThan(
    smallModule.functions[0].helpers.length * 10,
  );
  const small = await Effect.runPromise(Compile.run(R.program({ shared: sharedAt(16) })));
  const big = await Effect.runPromise(Compile.run(R.program({ shared: sharedAt(128) })));
  expect(big.files["src/lib.rs"].length).toBeLessThan(small.files["src/lib.rs"].length * 32);
  const target = Target.make(Rust.std.ref, Rust.std.implementations).pipe(
    Target.withCapabilities([Capabilities.U64]),
  );
  expect(
    await codes(
      Compile.run(R.program({ identity: R.fn([R.Bool], R.Bool, (value) => value) }), target),
    ),
  ).toContain("UNSUPPORTED_CAPABILITY");
});

test("canonical Boolean/Never witnesses are immutable and empty graphs still verify the target", async () => {
  for (const type of [R.Bool, R.Never]) {
    expect(Object.isFrozen(type.schema)).toBe(true);
    expect(Object.isFrozen(type.schema.ast)).toBe(true);
    expect(Reflect.set(type.schema.ast, "checks", [])).toBe(false);
  }
  const target = Target.make(SemanticRef.target("test/unsupported"), []).pipe(
    Target.withCapabilities([Capabilities.U64]),
  );
  const constant = R.fn([], R.U64, () => R.U64.literal(1n));
  expect(await codes(Compile.run(R.program({ constant }), target))).toContain("UNSUPPORTED_TARGET");
  expect(await codes(Reference.runUnknown(bool, [1n]))).toContain("INVALID_INPUT");
  const artifact = await Effect.runPromise(Compile.run(R.program({ successOnly })));
  const analysis = artifact.explanation.analysis;
  const stale = Plan.make(
    {
      program: analysis.program,
      operations: analysis.operations,
      capabilities: analysis.capabilities,
      effects: [],
      requirements: analysis.requirements,
      types: analysis.types,
    },
    artifact.explanation.target,
    artifact.explanation.selections,
    artifact.explanation.crates,
  );
  expect(await codes(Compile.verify(stale))).toContain("INVALID_PLAN");
});

test("native runner rejects malformed output and mismatched artifact functions", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const artifact = yield* Compile.run(R.program({ successOnly }));
        const fs = yield* FileSystem.FileSystem;
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-output-" });
        const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
        const mismatch = yield* NativeRunner.run(artifact, directory, "successOnly", branch, [
          0n,
          1n,
        ]).pipe(
          Effect.map(() => Array<string>()),
          Effect.catchTag("CompileError", (error) =>
            Effect.succeed(error.diagnostics.map((d) => d.code)),
          ),
        );
        expect(mismatch).toContain("INVALID_INPUT");
        for (const output of ["ok:u64:18446744073709551616", "err:u64:1", "ok:bool:true"]) {
          yield* fs.writeFileString(
            `${directory}/src/main.rs`,
            `fn main() { println!("${output}"); }`,
          );
          const invalid = yield* NativeRunner.run(artifact, directory, "successOnly", successOnly, [
            0n,
          ]).pipe(
            Effect.map(() => Array<string>()),
            Effect.catchTag("CompileError", (error) =>
              Effect.succeed(error.diagnostics.map((d) => d.code)),
            ),
          );
          expect(invalid).toContain("INVALID_NATIVE_OUTPUT");
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}, 120_000);
