import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { Compile, R, Source } from "../packages/reffect/src/index.ts";

// Run with: vp exec node --experimental-transform-types --expose-gc scripts/measure-source-metadata.mjs
// Separate processes keep one profile's retained objects/JIT caches out of the next.
const functionCount = 128;
const operationsPerFunction = 16;
const repetitions = 5;
const script = fileURLToPath(import.meta.url);
const heap = () => {
  if (!globalThis.gc) throw new Error("This probe requires --expose-gc");
  globalThis.gc();
  return process.memoryUsage().heapUsed;
};
const sha = (text) => createHash("sha256").update(text).digest("hex");
const bytes = (texts) =>
  Object.values(texts).reduce((sum, text) => sum + Buffer.byteLength(text), 0);

function build(annotated) {
  const prefix = "// 😀\r\n";
  const expression = "R.U64.add(value, 1n);";
  const line = expression + "\r\n";
  const text = prefix + line.repeat(operationsPerFunction);
  const file = annotated ? Source.file("src/probe.ts", text) : undefined;
  const sites = file
    ? Array.from({ length: operationsPerFunction }, (_, i) =>
        Source.site(
          file,
          prefix.length + i * line.length,
          prefix.length + i * line.length + expression.length,
          `add${i}`,
        ),
      )
    : [];
  const functions = {};
  for (let i = 0; i < functionCount; i++) {
    const fn = R.fn([R.U64], R.U64, (input) => {
      let value = input;
      for (let j = 0; j < operationsPerFunction; j++) {
        value = R.U64.add(value, R.U64.literal(1n));
        if (annotated) value = value.pipe(Source.at(sites[j]));
      }
      return value;
    });
    functions[`f${i}`] = annotated ? fn.pipe(Source.named(`f${i}`)) : fn;
  }
  return R.program(functions);
}

async function sample(profile) {
  // Warm the authoring and compilation APIs with a separate small program.
  await Effect.runPromise(
    Compile.run(R.program({ warm: R.fn([], R.U64, () => R.U64.literal(1n)) })),
  );
  const before = heap();
  const started = performance.now();
  const program = build(profile === "annotated");
  const builderMs = performance.now() - started;
  const programHeap = heap();
  const compileStarted = performance.now();
  const artifact = await Effect.runPromise(Compile.run(program));
  const compileMs = performance.now() - compileStarted;
  const artifactHeap = heap();
  // Reads after GC keep the program and artifact reachable during each sample.
  return {
    profile,
    functions: Object.keys(program.functions).length,
    builderMs,
    compileMs,
    retainedProgramBytes: programHeap - before,
    retainedProgramAndArtifactBytes: artifactHeap - before,
    generatedBytes: bytes(artifact.files),
    auxiliaryBytes: bytes(artifact.auxiliaryFiles),
    sourceSites: artifact.sources.sites.length,
    origins: artifact.sources.origins.length,
    occurrences: artifact.sources.occurrences.length,
    generatedSha256: sha(JSON.stringify(artifact.files)),
  };
}

if (process.argv[2] === "--child") {
  const profile = process.argv[3];
  if (profile !== "annotated" && profile !== "unannotated") throw new Error("Unknown profile");
  console.log(JSON.stringify(await sample(profile)));
} else {
  const samples = [];
  for (let i = 0; i < repetitions; i++) {
    for (const profile of i % 2 ? ["annotated", "unannotated"] : ["unannotated", "annotated"]) {
      const output = execFileSync(
        process.execPath,
        ["--experimental-transform-types", "--expose-gc", script, "--child", profile],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      );
      samples.push(JSON.parse(output));
    }
  }
  if (new Set(samples.map((s) => s.generatedSha256)).size !== 1)
    throw new Error("Source annotations changed generated Rust/Cargo sources");
  const medians = {};
  for (const profile of ["unannotated", "annotated"]) {
    const selected = samples.filter((s) => s.profile === profile);
    medians[profile] = {};
    for (const key of Object.keys(selected[0])) {
      if (typeof selected[0][key] !== "number") continue;
      const values = selected.map((s) => s[key]).sort((a, b) => a - b);
      medians[profile][key] = values[Math.floor(values.length / 2)];
    }
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        workload: { functionCount, operationsPerFunction, repetitions },
        generatedSourcesIdentical: true,
        medians,
        samples,
      },
      null,
      2,
    ),
  );
}
