import { NodeServices } from "@effect/platform-node";
import { SourceWriter, joinFragments, mapFragment, textFragment } from "../src/source-writer.ts";
import { Effect, FileSystem, Exit } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { nativeTestBudget } from "./native-test-budget.ts";
import {
  NativeRunner,
  CargoApi,
  Compile,
  CompileError,
  R,
  Reference,
  Source,
  SourceMaps,
} from "../src/index.ts";

const failure = (effect: Effect.Effect<unknown, CompileError>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.map(() => undefined),
      Effect.catchTag("CompileError", (error) => Effect.succeed(error)),
    ),
  );

test("source annotations preserve node/binder identity, inference and callback counts", async () => {
  let calls = 0;
  const file = Source.file("examples/source.ts", "add(a, b); use();");
  const definition = Source.site(file, 0, 9, "addition");
  const use = Source.site(file, 11, 16, "invocation");
  const original = R.fn([R.U64, R.U64], R.U64, (a, b) => {
    calls++;
    return R.U64.add(a, b).pipe(Source.at(definition));
  });
  const annotated = original.pipe(Source.named("sum"), Source.at(definition));
  const used = original.body.pipe(Source.use(use));
  expect(annotated.binder).toBe(original.binder);
  expect(annotated.body).toBe(original.body);
  expect(used.node).toBe(original.body.node);
  expect(original.source).toEqual({});
  expect(original.body.source.use).toBeUndefined();
  expect(used.source.definition).toBe(definition);
  expect(used.source.use).toBe(use);
  expect(Object.isFrozen(used)).toBe(true);
  expect(Object.isFrozen(used.source)).toBe(true);
  expect(Object.isFrozen(definition)).toBe(true);
  expect(await Effect.runPromise(Reference.run(annotated, [2n, 3n]))).toBe(5n);
  const effect = R.fn([R.U64], R.U64, R.U64, (value) => {
    calls++;
    return R.Effect.succeed(value).pipe(Source.at(definition));
  }).pipe(Source.named("effect"), Source.use(use));
  expect(await Effect.runPromise(Reference.run(effect, [7n]))).toBe(7n);
  await Effect.runPromise(Compile.run(R.program({ annotated, effect })));
  expect(calls).toBe(2);
});

test("source ranges retain exact CRLF, BOM, astral and combining UTF-16 positions", () => {
  const file = Source.file("src/unicode.ts", "\ufeff// 😀\r\n😀e\u0301; call();\r\n");
  // Independently counted: BOM + comment + surrogate pair + CRLF = 8 units.
  const site = Source.site(file, 14, 20, "call");
  expect(site.location()).toEqual({
    file: "src/unicode.ts",
    start: 14,
    end: 20,
    line: 2,
    column: 7,
    endLine: 2,
    endColumn: 13,
    name: "call",
    precision: "explicit",
  });
  expect(() => Source.site(file, 5, 6)).toThrow();
  expect(() => Source.site(file, -1, 2)).toThrow();
  expect(() => Source.site(file, 5, 100)).toThrow();
  expect(() => Source.site(file, 10, 9)).toThrow();
  expect(() => Source.file("../private.ts", "")).toThrow();
  expect(() => Source.file("C:\\private.ts", "")).toThrow();
  expect(() => Source.file("/private.ts", "")).toThrow();
  expect(() => Source.file("src/lone.ts", "\ud800")).toThrow();
  expect(() => Source.site(file, 0, 7)).toThrow();
  const separators = Source.file("src/lines.ts", "a\u2028b\u2029c");
  expect(Source.site(separators, 4, 5).location()).toMatchObject({ line: 3, column: 1 });
});

test("compiler diagnostics expose explicit use and related definition sites", async () => {
  const file = Source.file("src/bad.ts", "escaped; definition; use;");
  const definition = Source.site(file, 9, 19, "definition");
  const use = Source.site(file, 21, 24, "use");
  let escaped = R.U64.literal(0n);
  R.fn([R.U64], R.U64, (value) => {
    escaped = value.pipe(Source.at(definition));
    return value;
  });
  const bad = R.fn([], R.U64, () => escaped.pipe(Source.use(use)));
  const error = await failure(Compile.check(R.program({ bad })));
  expect(error?.diagnostics[0].code).toBe("FOREIGN_PARAMETER");
  expect(error?.diagnostics[0].primary).toEqual(use.location());
  expect(error?.diagnostics[0].related).toContainEqual(definition.location());
  const named = bad.pipe(Source.named("bad callback"));
  expect((await failure(Compile.run(R.program({ named }))))?.diagnostics[0].related).toContainEqual(
    { name: "bad callback", precision: "named" },
  );
});

test("shared helpers retain separate use sites and mapped definition ranges", async () => {
  const file = Source.file("src/shared.ts", "shared(); left(); right();");
  const definition = Source.site(file, 0, 8, "shared");
  const left = Source.site(file, 10, 16, "left");
  const right = Source.site(file, 18, 25, "right");
  const f = R.fn([R.Bool, R.U64], R.U64, R.U64, (condition, value) => {
    const shared = R.Effect.succeed(value).pipe(Source.at(definition));
    return R.Match.bool(condition, shared.pipe(Source.use(left)), shared.pipe(Source.use(right)));
  });
  const artifact = await Effect.runPromise(Compile.run(R.program({ choose: f })));
  const resolve = await Effect.runPromise(SourceMaps.resolver(artifact.sources, artifact.files));
  const lib = artifact.files["src/lib.rs"];
  // Match root h_0 references one shared h_1 twice, with independently known use locations.
  expect((lib.match(/fn h_choose_1\(/g) ?? []).length).toBe(1);
  const first = lib.indexOf("h_choose_1(p0, p1)", lib.indexOf("{ if"));
  const second = lib.indexOf("h_choose_1(p0, p1)", first + 1);
  const one = resolve("src/lib.rs", first, first + 17);
  const two = resolve("src/lib.rs", second, second + 17);
  expect(one.primary?.name).toBe("left");
  expect(two.primary?.name).toBe("right");
  expect(one.related.some((l) => l.name === "shared")).toBe(true);
  const header = lib.indexOf("fn h_choose_1(") + 3;
  expect(resolve("src/lib.rs", header, header + 10).primary?.name).toBe("shared");
  expect(resolve("src/lib.rs", 0).status).toBe("unmapped");
  expect(resolve("src/main.rs", 0).status).toBe("unmapped");
  expect(resolve("src/lib.rs", lib.length).status).toBe("unmapped");
  expect(resolve("src/lib.rs", -1).status).toBe("invalid");
  expect(resolve("src/lib.rs", 0, lib.length + 1).status).toBe("invalid");
  const changed = await Effect.runPromise(
    SourceMaps.resolver(artifact.sources, {
      ...artifact.files,
      "src/lib.rs": lib + "// modified\n",
    }),
  );
  expect(changed("src/lib.rs", first).status).toBe("stale");
  const missing = await Effect.runPromise(SourceMaps.resolver(artifact.sources, {}));
  expect(missing("src/lib.rs", first).status).toBe("missing");
  const repeat = await Effect.runPromise(Compile.run(R.program({ choose: f })));
  expect(repeat.files).toEqual(artifact.files);
  expect(repeat.auxiliaryFiles).toEqual(artifact.auxiliaryFiles);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const parent = yield* fs.makeTempDirectoryScoped({
          directory: ".",
          prefix: "reffect-sites-",
        });
        const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
        const metadataCopy = f.pipe(Source.named("same semantic function"));
        for (const profile of ["debug", "release"] as const) {
          yield* CargoApi.build(directory, profile);
          for (const condition of [true, false]) {
            const expected = yield* Reference.run(f, [condition, 7n]);
            const native = yield* NativeRunner.run(
              artifact,
              directory,
              "choose",
              metadataCopy,
              [condition, 7n],
              profile,
            );
            expect(native).toEqual(Exit.succeed(expected));
          }
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  expect(JSON.stringify(artifact.sources)).not.toContain(file.text);
  expect(artifact.auxiliaryFiles?.["reffect.build.json"]).toContain('"sourceContents": "omitted"');
}, 120000);

test("range writer counts UTF-8 and respects unmapped boundaries", () => {
  const writer = new SourceWriter("src/lib.rs");
  writer.write("// 😀\r\n"); // 9 UTF-8 bytes; 7 UTF-16 units.
  writer.mapped("o0", undefined, () => writer.write("é"));
  writer.write(";\n");
  expect(writer.ranges).toEqual([
    { file: "src/lib.rs", start: 9, end: 11, origin: "o0", role: "definition" },
  ]);
  expect(new TextEncoder().encode(writer.text).length).toBe(13);
  expect(() => writer.write("\ud83d")).toThrow();
});

test("mapped fragments shift authored ranges through composition", () => {
  const inner = mapFragment("shared", "use", textFragment("call()"), "use");
  expect(inner.ranges).toEqual([
    { start: 0, end: 6, origin: "shared", occurrence: "use", role: "use" },
  ]);
  // An absent origin leaves the fragment unmapped, like SourceWriter.mapped.
  expect(mapFragment(undefined, undefined, textFragment("plain")).ranges).toEqual([]);
  // Empty writes record nothing, matching SourceWriter.mapped.
  expect(mapFragment("o0", undefined, textFragment("")).ranges).toEqual([]);

  const outer = joinFragments([
    "fn f() { ",
    inner,
    " + ",
    mapFragment("o0", undefined, textFragment("x"), "definition"),
    " }",
  ]);
  expect(outer.text).toBe("fn f() { call() + x }");
  expect(outer.ranges).toEqual([
    { start: 9, end: 15, origin: "shared", occurrence: "use", role: "use" },
    { start: 18, end: 19, origin: "o0", role: "definition" },
  ]);

  const writer = new SourceWriter("src/lib.rs");
  writer.writeFragment(joinFragments(["<", outer, ">"]));
  expect(writer.text).toBe("<fn f() { call() + x }>");
  expect(writer.ranges).toEqual([
    { file: "src/lib.rs", start: 10, end: 16, origin: "shared", occurrence: "use", role: "use" },
    { file: "src/lib.rs", start: 19, end: 20, origin: "o0", role: "definition" },
  ]);

  // Off-by-one on multibyte text: ranges are UTF-8 byte offsets, not UTF-16.
  const utf8 = joinFragments(["\u00e9", mapFragment("o0", undefined, textFragment("z"))]);
  expect(utf8.ranges).toEqual([{ start: 2, end: 3, origin: "o0", role: "definition" }]);

  // Range tracking off: text is written, no coordinates recorded, no encoding.
  const off = new SourceWriter("src/lib.rs", false);
  const spy = vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(() => {
    throw new Error("Range encoding was requested");
  });
  try {
    off.writeFragment(outer);
  } finally {
    spy.mockRestore();
  }
  expect(off.text).toBe(outer.text);
  expect(off.ranges).toEqual([]);
});

test("maps reject malformed references, cycles, unsafe paths and unsupported versions", async () => {
  const artifact = await Effect.runPromise(
    Compile.run(R.program({ constant: R.fn([], R.U64, () => R.U64.literal(1n)) })),
  );
  const error = (input: unknown) =>
    Effect.runPromise(
      SourceMaps.decode(JSON.stringify(input)).pipe(
        Effect.map(() => false),
        Effect.catchTag("SourceMapError", () => Effect.succeed(true)),
      ),
    );
  expect(await error({ ...artifact.sources, schemaVersion: 2 })).toBe(true);
  expect(
    await error({
      ...artifact.sources,
      origins: artifact.sources.origins.map((origin) => ({ ...origin, parents: [origin.id] })),
    }),
  ).toBe(true);
  expect(
    await error({
      ...artifact.sources,
      origins: [{ id: "o0", kind: "Literal", names: [], definitions: ["missing"], parents: [] }],
    }),
  ).toBe(true);
  expect(
    await error({
      ...artifact.sources,
      generated: [{ file: "../outside.rs", digest: "0".repeat(64), bytes: 1 }],
    }),
  ).toBe(true);
  expect(
    await error({
      ...artifact.sources,
      occurrences: artifact.sources.occurrences.map((use) => ({ ...use, parent: use.id })),
    }),
  ).toBe(true);
  expect(
    await error({
      ...artifact.sources,
      ranges: [{ file: "src/lib.rs", start: 0, end: 9999999, origin: "o0", role: "definition" }],
    }),
  ).toBe(true);
});

test(
  "Cargo maps real rustc errors and preserves raw diagnostics through stale/missing maps",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({
            directory: ".",
            prefix: "reffect-source-",
          });
          const file = Source.file("src/native-fault.ts", "// 😀\r\n7n");
          const site = Source.site(file, 7, 9, "seven");
          const bad = R.fn([], R.U64, () => R.U64.literal(7n).pipe(Source.at(site))).pipe(
            Source.named("broken fixture"),
          );
          const artifact = yield* Compile.run(R.program({ bad }));
          const module = yield* Compile.lower(
            yield* Compile.analyzeOwnership(artifact.explanation),
          );
          // Same-length, deliberately invalid backend result type: span offsets stay unchanged.
          const files = {
            ...artifact.files,
            "src/lib.rs": artifact.files["src/lib.rs"].replace(
              "pub fn r_bad() -> u64",
              "pub fn r_bad() -> u32",
            ),
          };
          expect(files["src/lib.rs"]).not.toBe(artifact.files["src/lib.rs"]);
          const sources = yield* SourceMaps.create(
            module.provenance,
            files,
            artifact.sources.ranges,
          );
          const directory = yield* CargoApi.write(
            { files, auxiliaryFiles: sources.auxiliaryFiles },
            `${parent}/output`,
          );
          expect(yield* fs.readFileString(`${directory}/reffect.sources.json`)).toBe(
            sources.auxiliaryFiles["reffect.sources.json"],
          );
          const buildError = () =>
            CargoApi.build(directory).pipe(
              Effect.map(() => undefined),
              Effect.catchTag("CargoError", (error) => Effect.succeed(error)),
            );
          const error = yield* buildError();
          expect(error?.exitCode).not.toBe(0);
          expect(error?.command).toContain("--message-format=json");
          expect(error?.stdout).toContain('"reason":"compiler-message"');
          const mismatch = error?.diagnostics?.find((diagnostic) => diagnostic.code === "E0308");
          expect(mismatch).toBeDefined();
          expect(mismatch?.raw).toMatchObject({
            code: { code: "E0308" },
            children: expect.any(Array),
          });
          const primary = mismatch?.spans.find((span) => span.primary && span.mapping === "mapped");
          expect(primary?.authored).toMatchObject({
            file: "src/native-fault.ts",
            name: "seven",
            line: 2,
            column: 1,
            start: 7,
            end: 9,
            precision: "explicit",
          });
          expect(primary?.related).toContainEqual({ name: "broken fixture", precision: "named" });
          yield* fs.writeFileString(
            `${directory}/src/lib.rs`,
            files["src/lib.rs"] + "// changed\n",
          );
          const stale = yield* buildError();
          expect(
            stale?.diagnostics
              ?.find((d) => d.code === "E0308")
              ?.spans.some((s) => s.mapping === "stale"),
          ).toBe(true);
          yield* fs.writeFileString(`${directory}/reffect.sources.json`, "{broken");
          const invalid = yield* buildError();
          expect(
            invalid?.diagnostics
              ?.find((d) => d.code === "E0308")
              ?.spans.some((s) => s.mapping === "invalid"),
          ).toBe(true);
          yield* fs.remove(`${directory}/reffect.sources.json`);
          const missing = yield* buildError();
          expect(
            missing?.diagnostics
              ?.find((d) => d.code === "E0308")
              ?.spans.some((s) => s.mapping === "missing"),
          ).toBe(true);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(4),
);

test("auxiliary artifact paths are validated before output creation", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const parent = yield* fs.makeTempDirectoryScoped({
          directory: ".",
          prefix: "reffect-paths-",
        });
        const artifact = yield* Compile.run(
          R.program({ constant: R.fn([], R.U64, () => R.U64.literal(1n)) }),
        );
        for (const name of ["../escape", "SRC/LIB.RS", "src/lib.rs/nested", "/absolute"]) {
          const outcome = yield* Effect.exit(
            CargoApi.write(
              { files: artifact.files, auxiliaryFiles: { [name]: "bad" } },
              `${parent}/output`,
            ),
          );
          expect(Exit.isFailure(outcome)).toBe(true);
          expect(yield* fs.exists(`${parent}/output`)).toBe(false);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

test("function aliases retain distinct source contexts and immutable lowered provenance", async () => {
  const file = Source.file("src/aliases.ts", "first; second;");
  const first = Source.site(file, 0, 5, "first");
  const second = Source.site(file, 7, 13, "second");
  const base = R.fn([], R.U64, () => R.U64.literal(1n));
  const artifact = await Effect.runPromise(
    Compile.run(
      R.program({
        first: base.pipe(Source.at(first)),
        second: base.pipe(Source.at(second)),
      }),
    ),
  );
  const module = await Effect.runPromise(
    Compile.lower(await Effect.runPromise(Compile.analyzeOwnership(artifact.explanation))),
  );
  expect(Object.isFrozen(module.provenance)).toBe(true);
  expect(Object.isFrozen(module.provenance.origins)).toBe(true);
  expect(Object.isFrozen(module.provenance.occurrences)).toBe(true);
  const lookup = await Effect.runPromise(SourceMaps.resolver(artifact.sources, artifact.files));
  const code = artifact.files["src/lib.rs"];
  const firstName = code.indexOf("r_first");
  const secondName = code.indexOf("r_second");
  expect(lookup("src/lib.rs", firstName, firstName + 7).primary?.name).toBe("first");
  expect(lookup("src/lib.rs", secondName, secondName + 8).primary?.name).toBe("second");
  const secondValue = code.indexOf("1u64", secondName);
  expect(lookup("src/lib.rs", secondValue, secondValue + 4).primary).toMatchObject({
    name: "second",
    precision: "context",
  });
});

test("source-aware shared DAG metadata remains bounded and source identities are revision-specific", async () => {
  const build = (depth: number) =>
    R.fn([R.Bool], R.Bool, (condition) => {
      let current = condition;
      for (let i = 0; i < depth; i++) current = R.Match.bool(condition, current, current);
      return current;
    });
  const small = await Effect.runPromise(Compile.run(R.program({ shared: build(16) })));
  const large = await Effect.runPromise(Compile.run(R.program({ shared: build(128) })));
  expect(large.sources.occurrences.length).toBeLessThan(512);
  expect(large.sources.ranges.length).toBeLessThan(2048);
  expect(large.auxiliaryFiles?.["reffect.sources.json"].length).toBeLessThan(
    small.auxiliaryFiles["reffect.sources.json"].length * 10,
  );
  const one = Source.file("src/revision.ts", "1n");
  const two = Source.file("src/revision.ts", "2n");
  const revision = await Effect.runPromise(
    Compile.run(
      R.program({
        one: R.fn([], R.U64, () => R.U64.literal(1n).pipe(Source.at(Source.site(one, 0, 2)))),
        two: R.fn([], R.U64, () => R.U64.literal(2n).pipe(Source.at(Source.site(two, 0, 2)))),
      }),
    ),
  );
  expect(revision.sources.files.map((file) => file.path)).toEqual([
    "src/revision.ts",
    "src/revision.ts",
  ]);
  expect(revision.sources.files[0].digest).not.toBe(revision.sources.files[1].digest);
  const digestMismatch = await Effect.runPromise(
    SourceMaps.decode(JSON.stringify({ ...revision.sources, build: "0".repeat(64) })).pipe(
      Effect.map(() => false),
      Effect.catchTag("SourceMapError", () => Effect.succeed(true)),
    ),
  );
  expect(digestMismatch).toBe(true);
});
