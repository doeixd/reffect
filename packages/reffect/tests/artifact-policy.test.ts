import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test, vi } from "vite-plus/test";
import {
  CargoApi,
  Cargo,
  Compile,
  CompileError,
  IRType,
  SemanticRef,
  NativeRunner,
  R,
  Reference,
  Rust,
  Source,
  SourceArtifacts,
  SourceArtifactPolicy,
} from "../src/index.ts";
import { Provenance } from "../src/provenance.ts";
import { SourceWriter } from "../src/source-writer.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const file = Source.file("examples/artifact-policy.ts", "difference(a, b); shared();");
const site = Source.site(file, 0, 16, "difference");
const sum = R.fn([R.U64, R.U64], R.U64, (a, b) => {
  const shared = a.pipe(R.U64.add(b), Source.at(site));
  return shared.pipe(R.U64.mul(shared));
}).pipe(Source.named("shared sum"));
const difference = R.Effect.fn([R.U64, R.U64], R.U64, R.U64, (a, b) =>
  R.Match.bool(
    a.pipe(R.U64.lt(b)),
    R.Effect.fail(R.U64.literal(7n).pipe(Source.at(site))),
    R.Effect.succeed(a.pipe(R.U64.sub(b), Source.at(site))),
  ),
).pipe(Source.named("difference"));
const program = R.program({ sum, difference });

test("Full and None specs preserve generated code, semantic identity and independent policy", async () => {
  const base = Compile.make(program);
  const stripped = base.pipe(
    Compile.withSourceArtifacts(SourceArtifacts.None),
    Compile.withTarget(Rust.std),
  );
  expect(base.program).toBe(program);
  expect(stripped.program).toBe(program);
  expect(base.sourceArtifacts).toBe(SourceArtifacts.Full);
  expect(stripped.sourceArtifacts).toBe(SourceArtifacts.None);
  expect(Object.isFrozen(stripped)).toBe(true);
  expect(Object.isFrozen(SourceArtifacts.None)).toBe(true);
  const { mapped, off } = await Effect.runPromise(
    Effect.all(
      { mapped: base.pipe(Compile.run), off: stripped.pipe(Compile.run) },
      { concurrency: "unbounded" },
    ),
  );
  expect(mapped.sources.ranges.length).toBeGreaterThan(0);
  expect(off.files).toEqual(mapped.files);
  expect(Object.hasOwn(off, "sources")).toBe(false);
  expect(Object.hasOwn(off, "auxiliaryFiles")).toBe(false);
  expect(off.explanation.analysis.program).toBe(program);
  const ownership = await Effect.runPromise(Compile.analyzeOwnership(off.explanation));
  const lowered = await Effect.runPromise(Compile.lower(ownership, SourceArtifacts.None));
  expect(Object.hasOwn(lowered, "provenance")).toBe(false);
  expect(lowered.functions.every((fn) => fn.origin === undefined)).toBe(true);
});

test("None skips provenance, hashing, JSON serialization and UTF-8 range encoding", async () => {
  const provenance = vi.spyOn(Provenance.prototype, "origin").mockImplementation(() => {
    throw new Error("Provenance was requested");
  });
  const digest = vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(() => {
    throw new Error("Hashing was requested");
  });
  const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => {
    throw new Error("Serialization was requested");
  });
  const encoding = vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(() => {
    throw new Error("Range encoding was requested");
  });
  try {
    const artifact = await Effect.runPromise(
      Compile.make(program).pipe(Compile.withSourceArtifacts(SourceArtifacts.None), Compile.run),
    );
    expect(artifact.sourceArtifacts).toBe(SourceArtifacts.None);
    expect(provenance).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();
    expect(stringify).not.toHaveBeenCalled();
    expect(encoding).not.toHaveBeenCalled();
  } finally {
    provenance.mockRestore();
    digest.mockRestore();
    stringify.mockRestore();
    encoding.mockRestore();
  }
});

test("unmapped writer preserves text without encoding or storing ranges", () => {
  const writer = new SourceWriter("src/lib.rs", false);
  const encode = vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(() => {
    throw new Error("Unmapped writer encoded bytes");
  });
  try {
    writer.mapped("o0", "u0", () => writer.write("// 😀\r\n"));
    writer.write("pub fn f() {}\n");
    expect(writer.text).toBe("// 😀\r\npub fn f() {}\n");
    expect(writer.ranges).toEqual([]);
    expect(encode).not.toHaveBeenCalled();
  } finally {
    encode.mockRestore();
  }
});

test("policy lookalikes cannot select an unregistered artifact contract", async () => {
  const alias = Object.assign({}, SourceArtifacts.None);
  const result = await Effect.runPromise(
    Compile.make(program).pipe(
      Compile.withSourceArtifacts(alias),
      Compile.run,
      Effect.catchTag("CompileError", (error) => Effect.succeed(error)),
    ),
  );
  expect(result instanceof CompileError).toBe(true);
  if (result instanceof CompileError)
    expect(result.diagnostics.map((d) => d.code)).toContain("UNSUPPORTED_SOURCE_POLICY");
  expect(() => Object.assign(SourceArtifactPolicy, { None: SourceArtifacts.Full })).toThrow();
});

test("None diagnostics retain semantic codes and paths without collecting source locations", async () => {
  const other = R.U64.pipe(IRType.withTraits([]));
  // Use a different schema witness to cause a real representation refusal.
  const type = IRType.make(SemanticRef.type("test/unsupported"), Schema.BigInt, other.native);
  const unsupported = R.fn([type], type, (a) => a).pipe(Source.named("unsupported"));
  const named = R.program({ unsupported });
  const full = await Effect.runPromise(
    Compile.run(named).pipe(Effect.catchTag("CompileError", (e) => Effect.succeed(e))),
  );
  const none = await Effect.runPromise(
    Compile.make(named).pipe(
      Compile.withSourceArtifacts(SourceArtifacts.None),
      Compile.run,
      Effect.catchTag("CompileError", (e) => Effect.succeed(e)),
    ),
  );
  expect(full instanceof CompileError).toBe(true);
  expect(none instanceof CompileError).toBe(true);
  if (full instanceof CompileError && none instanceof CompileError) {
    expect(none.diagnostics.map((d) => [d.code, d.stage, d.path])).toEqual(
      full.diagnostics.map((d) => [d.code, d.stage, d.path]),
    );
    expect(full.diagnostics.some((d) => d.primary)).toBe(true);
    expect(none.diagnostics.every((d) => !d.primary && !d.related)).toBe(true);
  }
});

test(
  "None builds and executes both scalar and typed Result paths in debug/release",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({
            directory: ".",
            prefix: "reffect-policy-",
          });
          const spec = Compile.make(program).pipe(
            Compile.withSourceArtifacts(SourceArtifacts.None),
          );
          const built = yield* Compile.build(spec, `${parent}/crate`, "debug");
          const artifact = built.artifact;
          const directory = built.directory;
          expect(yield* fs.exists(`${directory}/reffect.sources.json`)).toBe(false);
          for (const profile of ["debug", "release"] as const) {
            yield* CargoApi.build(directory, profile);
            const pure = yield* NativeRunner.run(
              artifact,
              directory,
              "sum",
              sum,
              [R.U64.max, 2n],
              profile,
            );
            expect(Exit.isSuccess(pure) && pure.value).toBe(
              yield* Reference.run(sum, [R.U64.max, 2n]),
            );
            const success = yield* NativeRunner.run(
              artifact,
              directory,
              "difference",
              difference,
              [9n, 2n],
              profile,
            );
            expect(Exit.isSuccess(success) && success.value).toBe(7n);
            const failure = yield* NativeRunner.run(
              artifact,
              directory,
              "difference",
              difference,
              [2n, 9n],
              profile,
            );
            expect(Exit.isFailure(failure)).toBe(true);
            if (Exit.isFailure(failure)) {
              const error = Cause.findErrorOption(failure.cause);
              expect(Option.isSome(error) && error.value).toBe(7n);
            }
          }
          const faulty = yield* Compile.make(
            R.program({ bad: R.fn([], R.U64, () => R.U64.literal(7n).pipe(Source.at(site))) }),
          ).pipe(Compile.withSourceArtifacts(SourceArtifacts.None), Compile.run);
          const broken = yield* CargoApi.write(
            {
              files: {
                "Cargo.toml": faulty.files["Cargo.toml"],
                "src/main.rs": faulty.files["src/main.rs"],
                "src/lib.rs": faulty.files["src/lib.rs"].replace(
                  "pub fn r_bad() -> u64",
                  "pub fn r_bad() -> u32",
                ),
              },
            },
            `${parent}/fault`,
          );
          const error = yield* CargoApi.build(broken).pipe(
            Effect.map(() => undefined),
            Effect.catchTag("CargoError", (e) => Effect.succeed(e)),
          );
          expect(error?.stdout).toContain('"reason":"compiler-message"');
          expect(
            error?.diagnostics?.some(
              (d) => d.code === "E0308" && d.spans.some((s) => s.mapping === "missing"),
            ),
          ).toBe(true);
        }),
      ).pipe(Effect.provide(Cargo.layer), Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(1),
);
