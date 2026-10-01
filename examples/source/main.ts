import { Effect, Exit, FileSystem } from "effect";
import { NodeServices } from "@effect/platform-node";
import {
  CargoApi,
  Compile,
  NativeRunner,
  R,
  Reference,
  Source,
  SourceMaps,
} from "../../packages/reffect/src/index.ts";

// The caller supplies the exact source snapshot; automatic AST annotation is a later adapter.
const file = Source.file("examples/source/authored.ts", "// 😀\r\nR.U64.add(a, b)");
const site = Source.site(file, 7, 22, "sum");
const sum = R.fn([R.U64, R.U64], R.U64, (a, b) => R.U64.add(a, b).pipe(Source.at(site))).pipe(
  Source.named("sum"),
);
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const artifact = yield* Compile.run(R.program({ sum }));
      const lookup = yield* SourceMaps.resolver(artifact.sources, artifact.files);
      const generated = artifact.files["src/lib.rs"];
      const index = generated.indexOf("wrapping_add");
      const byte = new TextEncoder().encode(generated.slice(0, index)).length;
      const resolution = lookup("src/lib.rs", byte, byte + "wrapping_add".length);
      if (resolution.status !== "mapped" || resolution.primary?.name !== "sum")
        throw new Error("Generated arithmetic did not retain its authored origin");
      yield* Effect.sync(() => console.log(resolution.primary));
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-source-example-" });
      const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
      const expected = yield* Reference.run(sum, [R.U64.max, 1n]);
      for (const profile of ["debug", "release"] as const) {
        yield* CargoApi.build(directory, profile);
        const native = yield* NativeRunner.run(
          artifact,
          directory,
          "sum",
          sum,
          [R.U64.max, 1n],
          profile,
        );
        if (!Exit.isSuccess(native) || native.value !== expected)
          throw new Error("Native/reference result differs");
        yield* Effect.sync(() => console.log(`${profile}: ${native.value}`));
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
