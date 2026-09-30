import { Effect, Exit, FileSystem, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import {
  AddU64,
  Cargo,
  CargoApi,
  Compile,
  CompileError,
  Compiler,
  Law,
  Operation,
  R,
  Reference,
  Rust,
  Evidence,
  EvidencePolicy,
  IRType,
  Native,
  Plan,
  SemanticRef,
  Target,
  Capabilities,
  apply,
} from "../src/index.ts";
import type { Expr, OperationRef } from "../src/index.ts";

const add = R.fn([R.U64, R.U64], R.U64, (a, b) => a.pipe(R.U64.add(b)));
const sub = R.fn([R.U64, R.U64], R.U64, (a, b) => R.U64.sub(a, b));
const mul = R.fn([R.U64, R.U64], R.U64, (a, b) => R.U64.mul(a, b));
const nested = R.fn([R.U64, R.U64], R.U64, (a, b) => {
  const sum = a.pipe(R.U64.add(b));
  return sum.pipe(R.U64.mul(sum), R.U64.sub(R.U64.literal(1n)));
});
const constant = R.fn([], R.U64, () => R.U64.literal(R.U64.max));
const identity = R.fn([R.U64], R.U64, (a) => a);
const program = R.program({ add, sub, mul, nested, constant, identity });

const diagnostics = (effect: Effect.Effect<unknown, CompileError>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.map(() => Array<string>()),
      Effect.catchTag("CompileError", (error) =>
        Effect.succeed(error.diagnostics.map((d) => d.code)),
      ),
    ),
  );

test("reference and generated Rust agree at numeric boundaries in fresh debug and release crates", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const compiler = yield* Compiler;
      const cargo = yield* Cargo;
      const artifact = yield* compiler.run(program);
      expect(artifact.explanation.crates).toEqual([]);
      expect(artifact.explanation.analysis.operations.map((o) => o.id)).toEqual([
        "reffect/u64.add.wrap@1",
        "reffect/u64.mul.wrap@1",
        "reffect/u64.sub.wrap@1",
      ]);
      expect(artifact.stages).toEqual([
        "check",
        "derive",
        "normalize",
        "plan",
        "verify",
        "optimize",
        "ownership",
        "lower",
        "emit",
      ]);
      const pairs: readonly (readonly [bigint, bigint])[] = [
        [0n, 0n],
        [R.U64.max, 1n],
        [0n, 1n],
        [R.U64.max, R.U64.max],
        [9007199254740993n, 123456789n],
      ];
      const cases: { name: string; args: readonly bigint[]; expected: bigint }[] = [];
      for (const [name, f] of Object.entries({ add, sub, mul, nested })) {
        for (const pair of pairs)
          cases.push({ name, args: pair, expected: yield* Reference.run(f, pair) });
      }
      cases.push({ name: "constant", args: [], expected: yield* Reference.run(constant, []) });
      cases.push({
        name: "identity",
        args: [R.U64.max],
        expected: yield* Reference.run(identity, [R.U64.max]),
      });
      const results = yield* cargo.validate(artifact, cases, ".");
      expect(results).toHaveLength(46);
      expect(results.every((r) => r.exitCode === 0)).toBe(true);
    }).pipe(
      Effect.provide(Compiler.layer),
      Effect.provide(Cargo.layer),
      Effect.provide(NodeServices.layer),
    ),
  );
}, 120000);

test("builders produce immutable IR and exact bigint arithmetic", async () => {
  expect(Object.isFrozen(add)).toBe(true);
  expect(Object.isFrozen(add.body)).toBe(true);
  expect(Object.isFrozen(add.body.node)).toBe(true);
  expect(Object.isFrozen(AddU64.input)).toBe(true);
  expect(await Effect.runPromise(Reference.run(add, [R.U64.max, 1n]))).toBe(0n);
  expect(await Effect.runPromise(Reference.run(sub, [0n, 1n]))).toBe(R.U64.max);
  expect(() => R.U64.literal(-1n)).toThrow();
  expect(() => R.U64.literal(R.U64.max + 1n)).toThrow();
  expect(await diagnostics(Reference.run(add, [-1n, 1n]))).toContain("INVALID_INPUT");
  expect(await diagnostics(Reference.runUnknown(add, [1n]))).toContain("ARITY_MISMATCH");
});

test("checks reject escaped binders, mismatched witnesses and invalid program declarations", async () => {
  let escaped: Expr<bigint> = R.U64.literal(0n);
  R.fn([R.U64], R.U64, (a) => {
    escaped = a;
    return a;
  });
  const bad = R.fn([], R.U64, () => escaped);
  expect(await diagnostics(Compile.check(R.program({ bad })))).toContain("FOREIGN_PARAMETER");
  const other = IRType.make(SemanticRef.type("test/other-u64"), R.U64.schema, Native.U64);
  const wrong = R.fn([other], R.U64, (a) => R.U64.add(a, R.U64.literal(1n)));
  expect(await diagnostics(Compile.check(R.program({ wrong })))).toContain("TYPE_MISMATCH");
  expect(await diagnostics(Compile.check(R.program({ "bad-name": add })))).toContain(
    "INVALID_NAME",
  );
  expect(await diagnostics(Compile.check(R.program({})))).toContain("EMPTY_PROGRAM");
});

const makeAdd = <const Ref extends OperationRef>(ref: Ref) =>
  Operation.make(ref, [R.U64, R.U64], R.U64, AddU64.reference).pipe(
    Operation.withCapabilities([Capabilities.U64]),
  );

test("planning refuses missing support, spoofed identity, effects, and unchecked native representations", async () => {
  const custom = makeAdd(SemanticRef.operation("custom/add"));
  const f = R.fn([R.U64, R.U64], R.U64, (a, b) => apply(custom, a, b));
  expect(await diagnostics(Compile.run(R.program({ f })))).toContain("UNSUPPORTED_OPERATION");
  const spoof = makeAdd(AddU64.ref);
  const spoofed = R.fn([R.U64, R.U64], R.U64, (a, b) => apply(spoof, a, b));
  expect(await diagnostics(Compile.run(R.program({ spoofed })))).toContain("UNSUPPORTED_OPERATION");
  const effectful = makeAdd(SemanticRef.operation("custom/effect")).pipe(
    Operation.withEffects([SemanticRef.effect("clock")]),
  );
  const impure = R.fn([R.U64, R.U64], R.U64, (a, b) => apply(effectful, a, b));
  expect(await diagnostics(Compile.check(R.program({ impure })))).toContain("EFFECT_IN_EXPR");
  const unchecked = IRType.make(SemanticRef.type("test/unchecked-u64"), Schema.BigInt, Native.U64);
  const uncheckedFn = R.fn([unchecked], unchecked, (a) => a);
  expect(await diagnostics(Compile.run(R.program({ uncheckedFn })))).toContain(
    "UNSUPPORTED_REPRESENTATION",
  );
  expect(
    await diagnostics(Compile.run(program, Rust.std.pipe(Target.withCapabilities([])))),
  ).toContain("UNSUPPORTED_OPERATION");
});

test("verification rejects stale or altered implementation selections", async () => {
  const plan = await Effect.runPromise(Compile.explain(program));
  expect(await diagnostics(Compile.verify(plan.pipe(Plan.withSelections([]))))).toContain(
    "INVALID_PLAN",
  );
  expect(await diagnostics(Compile.verify(plan.pipe(Plan.withCrates(["tokio"]))))).toContain(
    "INVALID_PLAN",
  );
  const artifact = await Effect.runPromise(Compile.run(program));
  expect((await Effect.runPromise(Compile.run(program))).files).toEqual(artifact.files);
  expect(artifact.files["Cargo.toml"]).not.toContain("dependencies");
});

test("law evidence is subject-indexed and claims cannot authorize rewrites", () => {
  expect(AddU64.laws.length).toBeGreaterThan(0);
  expect(Law.permits(AddU64.laws[0], AddU64.ref, EvidencePolicy.Tested)).toBe(false);
  const tested = Law.commutative(AddU64.ref, Evidence.tested("fixture"));
  expect(Law.permits(tested, AddU64.ref, EvidencePolicy.Tested)).toBe(true);
  expect(
    Law.permits(tested, SemanticRef.operation("another/operation"), EvidencePolicy.Tested),
  ).toBe(false);
  expect(Law.permits(tested, AddU64.ref, EvidencePolicy.Proven)).toBe(false);
});

test("factory pipelines preserve semantic witnesses and refuse same-ID reference aliases", async () => {
  const annotated = R.U64.pipe(IRType.withTraits([]));
  const f = R.fn([annotated], annotated, (a) => a);
  expect(await Effect.runPromise(R.program({ f }).pipe(Compile.run))).toHaveProperty("files");
  const alias = SemanticRef.capability(Capabilities.U64.id);
  expect(
    await diagnostics(Compile.run(program, Rust.std.pipe(Target.withCapabilities([alias])))),
  ).toContain("UNSUPPORTED_OPERATION");
  const aliasLaw = Law.commutative(SemanticRef.operation(AddU64.ref.id), Evidence.claim("fixture"));
  const op = makeAdd(AddU64.ref).pipe(Operation.withLaws([aliasLaw]));
  const invalid = R.fn([R.U64, R.U64], R.U64, (a, b) => apply(op, a, b));
  expect(await diagnostics(Compile.check(R.program({ invalid })))).toContain("INVALID_LAW");
});

test("emission refuses to overwrite an existing output directory", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({
          directory: ".",
          prefix: "reffect-existing-",
        });
        yield* fs.writeFileString(`${dir}/keep.txt`, "user work");
        const artifact = yield* Compile.run(program);
        const exit = yield* Effect.exit(CargoApi.write(artifact, dir));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* fs.readFileString(`${dir}/keep.txt`)).toBe("user work");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

test("public build stage emits, builds and executes an artifact, and preserves native failures", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const parent = yield* fs.makeTempDirectoryScoped({
          directory: ".",
          prefix: "reffect-build-",
        });
        const built = yield* Compile.build(program, `${parent}/output`, "debug");
        expect(built.stages.at(-1)).toBe("build");
        expect(built.process.exitCode).toBe(0);
        const result = yield* CargoApi.run(built.directory, "add", [R.U64.max, 1n]);
        expect(result.stdout.trim()).toBe("0");
        const invalid = yield* CargoApi.run(built.directory, "add", [-1n, 0n]).pipe(
          Effect.map(() => undefined),
          Effect.catchTag("CargoError", (error) => Effect.succeed(error)),
        );
        expect(invalid?.exitCode).not.toBe(0);
        expect(invalid?.stderr).toContain("invalid u64");
      }),
    ).pipe(Effect.provide(Cargo.layer), Effect.provide(NodeServices.layer)),
  );
}, 120000);
