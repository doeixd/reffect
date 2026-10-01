import { Effect, Schema } from "effect";
import type { ProvenanceSnapshot } from "./provenance.ts";
import { SourceLocation, safeRelativePath } from "./source.ts";

const Natural = Schema.Number.check(Schema.makeFilter((n) => Number.isSafeInteger(n) && n >= 0));
const Origin = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  names: Schema.Array(Schema.String),
  definitions: Schema.Array(Schema.String),
  parents: Schema.Array(Schema.String),
});
const Occurrence = Schema.Struct({
  id: Schema.String,
  edge: Schema.String,
  origin: Schema.String,
  parent: Schema.optionalKey(Schema.String),
  use: Schema.optionalKey(Schema.String),
  definition: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});
export const GeneratedRange = Schema.Struct({
  file: Schema.String,
  start: Natural,
  end: Natural,
  origin: Schema.String,
  occurrence: Schema.optionalKey(Schema.String),
  role: Schema.Literals(["definition", "use"]),
});
export type GeneratedRange = typeof GeneratedRange.Type;
export const SourceMap = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  format: Schema.Literal("reffect.sources"),
  build: Schema.String,
  unmapped: Schema.Literal("gaps"),
  files: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      path: Schema.String,
      digest: Schema.String,
      length: Natural,
    }),
  ),
  sites: Schema.Array(
    Schema.Struct({ id: Schema.String, file: Schema.String, location: SourceLocation }),
  ),
  origins: Schema.Array(Origin),
  occurrences: Schema.Array(Occurrence),
  generated: Schema.Array(
    Schema.Struct({ file: Schema.String, digest: Schema.String, bytes: Natural }),
  ),
  ranges: Schema.Array(GeneratedRange),
  passes: Schema.Array(Schema.String),
});
export type SourceMap = typeof SourceMap.Type;
export const SourceManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  compiler: Schema.Literal("reffect@0.0.0"),
  target: Schema.Literal("rust/std@1"),
  build: Schema.String,
  sources: Schema.Struct({ file: Schema.Literal("reffect.sources.json"), digest: Schema.String }),
  generated: SourceMap.fields.generated,
  sourceContents: Schema.Literal("omitted"),
});
export type SourceManifest = typeof SourceManifest.Type;
export class SourceMapError extends Schema.TaggedError<SourceMapError>()("SourceMapError", {
  message: Schema.String,
}) {}
const maxMapBytes = 16 * 1024 * 1024;
const maxRecords = 100000;
const digest = (text: string) =>
  Effect.tryPromise({
    try: async () =>
      Array.from(
        new Uint8Array(
          await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join(""),
    catch: (cause) =>
      new SourceMapError({ message: `Cannot hash source artifact: ${String(cause)}` }),
  });
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
};
const freeze = <A>(value: A): A => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const validate = (table: SourceMap): SourceMap => {
  const invalid = (message: string): never => {
    throw new SourceMapError({ message });
  };
  const index = <A extends { readonly id: string }>(items: readonly A[]) => {
    const map = new Map(items.map((item) => [item.id, item]));
    if (items.length > maxRecords || map.size !== items.length)
      invalid("Duplicate IDs or too many source records");
    return map;
  };
  const files = index(table.files),
    sites = index(table.sites),
    origins = index(table.origins),
    uses = index(table.occurrences);
  const generated = new Map(table.generated.map((file) => [file.file, file]));
  if (
    generated.size !== table.generated.length ||
    table.generated.length > maxRecords ||
    table.ranges.length > maxRecords
  )
    invalid("Duplicate generated files or too many generated records");
  if (!/^[a-f0-9]{64}$/.test(table.build)) invalid("Invalid build digest");
  for (const file of [...table.files, ...table.generated]) {
    const path = "path" in file ? file.path : file.file;
    if (!safeRelativePath(path) || !/^[a-f0-9]{64}$/.test(file.digest))
      invalid("Invalid source path or digest");
  }
  for (const site of table.sites) {
    const file = files.get(site.file),
      l = site.location;
    if (
      !file ||
      l.file !== file.path ||
      l.digest !== file.digest ||
      l.precision !== "explicit" ||
      l.start === undefined ||
      l.end === undefined ||
      !Number.isSafeInteger(l.start) ||
      !Number.isSafeInteger(l.end) ||
      l.start < 0 ||
      l.end < l.start ||
      l.end > file.length ||
      (l.line !== undefined && l.endLine !== undefined && l.endLine < l.line) ||
      (l.line === l.endLine &&
        l.column !== undefined &&
        l.endColumn !== undefined &&
        l.endColumn < l.column) ||
      [l.line, l.column, l.endLine, l.endColumn].some(
        (n) => n === undefined || !Number.isSafeInteger(n) || n < 1,
      )
    )
      invalid("Invalid authored source range/reference");
  }
  for (const origin of table.origins)
    if (
      origin.definitions.some((id) => !sites.has(id)) ||
      origin.parents.some((id) => !origins.has(id))
    )
      invalid("Unknown origin/site reference");
  for (const use of table.occurrences)
    if (
      !origins.has(use.origin) ||
      (use.parent !== undefined && !uses.has(use.parent)) ||
      (use.use !== undefined && !sites.has(use.use)) ||
      (use.definition !== undefined && !sites.has(use.definition))
    )
      invalid("Unknown occurrence reference");
  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  const queue: string[] = [];
  let references = 0;
  for (const origin of table.origins) {
    references += origin.parents.length + origin.definitions.length + origin.names.length;
    if (references > maxRecords) invalid("Too many origin references");
    remaining.set(origin.id, origin.parents.length);
    if (!origin.parents.length) queue.push(origin.id);
    for (const parent of origin.parents) {
      const children = dependents.get(parent) ?? [];
      children.push(origin.id);
      dependents.set(parent, children);
    }
  }
  for (let i = 0; i < queue.length; i++)
    for (const child of dependents.get(queue[i]) ?? []) {
      const left = remaining.get(child)! - 1;
      remaining.set(child, left);
      if (left === 0) queue.push(child);
    }
  if (queue.length !== table.origins.length) invalid("Cyclic origin ancestry");
  // A linear parent chain check detects cycles without expanding shared origin ancestry.
  const done = new Set<string>();
  for (const use of table.occurrences) {
    const active = new Set<string>();
    let current: typeof use | undefined = use;
    while (current && !done.has(current.id)) {
      if (active.has(current.id)) invalid("Cyclic occurrence ancestry");
      active.add(current.id);
      current = current.parent ? uses.get(current.parent) : undefined;
    }
    active.forEach((id) => done.add(id));
  }
  for (const range of table.ranges) {
    const file = generated.get(range.file),
      use = range.occurrence ? uses.get(range.occurrence) : undefined;
    if (
      !file ||
      range.start >= range.end ||
      range.end > file.bytes ||
      !origins.has(range.origin) ||
      (range.occurrence !== undefined && (!use || use.origin !== range.origin))
    )
      invalid("Invalid generated range/reference");
  }
  return freeze(table);
};
const checked = (input: unknown) =>
  Effect.try({
    try: () => validate(Schema.decodeUnknownSync(SourceMap)(input)),
    catch: (cause) =>
      cause instanceof SourceMapError
        ? cause
        : new SourceMapError({ message: `Invalid source map: ${String(cause)}` }),
  });
const decode = (json: string) =>
  Effect.gen(function* () {
    if (new TextEncoder().encode(json).length > maxMapBytes)
      return yield* new SourceMapError({ message: "Source map exceeds size limit" });
    const value = yield* Effect.try({
      try: () => JSON.parse(json) as unknown,
      catch: () => new SourceMapError({ message: "Malformed source map JSON" }),
    });
    const table = yield* checked(value);
    const { build, ...payload } = table;
    if ((yield* digest(canonical(payload))) !== build)
      return yield* new SourceMapError({ message: "Source map build digest mismatch" });
    return table;
  });
const create = (
  provenance: ProvenanceSnapshot,
  files: Readonly<Record<string, string>>,
  ranges: readonly GeneratedRange[],
) =>
  Effect.gen(function* () {
    const sourceFiles = yield* Effect.forEach(provenance.files, (file) =>
      digest(file.snapshot.text).pipe(
        Effect.map((hash) => ({
          id: file.id,
          path: file.snapshot.path,
          digest: hash,
          length: file.snapshot.text.length,
        })),
      ),
    );
    const sourceById = new Map(sourceFiles.map((file) => [file.id, file]));
    const generated = yield* Effect.forEach(Object.entries(files), ([file, text]) =>
      digest(text).pipe(
        Effect.map((hash) => ({
          file,
          digest: hash,
          bytes: new TextEncoder().encode(text).length,
        })),
      ),
    );
    const usesById = new Map(provenance.occurrences.map((use) => [use.id, use]));
    const occurrences = provenance.occurrences.map(({ path, ...use }) => ({
      ...use,
      edge: use.parent ? path.slice(usesById.get(use.parent)!.path.length + 1) : path,
    }));
    const payload = {
      schemaVersion: 1 as const,
      format: "reffect.sources" as const,
      unmapped: "gaps" as const,
      files: sourceFiles,
      sites: provenance.sites.map((site) => ({
        id: site.id,
        file: site.file,
        location: { ...site.location, digest: sourceById.get(site.file)!.digest },
      })),
      origins: provenance.origins,
      occurrences,
      generated,
      ranges,
      passes: ["lower", "emit"],
    };
    const build = yield* digest(canonical(payload));
    const table = yield* checked({ ...payload, build });
    const json = JSON.stringify(table, null, 2) + "\n";
    if (new TextEncoder().encode(json).length > maxMapBytes)
      return yield* new SourceMapError({ message: "Source map exceeds size limit" });
    const manifest: SourceManifest = freeze({
      schemaVersion: 1,
      compiler: "reffect@0.0.0",
      target: "rust/std@1",
      build,
      sources: { file: "reffect.sources.json", digest: yield* digest(json) },
      generated,
      sourceContents: "omitted",
    });
    return Object.freeze({
      table,
      manifest,
      auxiliaryFiles: Object.freeze({
        "reffect.sources.json": json,
        "reffect.build.json": JSON.stringify(manifest, null, 2) + "\n",
      }),
    });
  });

export interface SourceResolution {
  readonly status: "mapped" | "unmapped" | "stale" | "missing" | "invalid";
  readonly primary?: SourceLocation;
  readonly related: readonly SourceLocation[];
  readonly range?: GeneratedRange;
}
const resolver = (input: SourceMap, texts: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const table = yield* checked(input);
    const { build, ...payload } = table;
    if ((yield* digest(canonical(payload))) !== build)
      return yield* new SourceMapError({ message: "Source map build digest mismatch" });
    const statuses = new Map<string, "ready" | "missing" | "stale">();
    for (const generated of table.generated) {
      const text = Object.hasOwn(texts, generated.file) ? texts[generated.file] : undefined;
      statuses.set(
        generated.file,
        text === undefined
          ? "missing"
          : (yield* digest(text)) === generated.digest
            ? "ready"
            : "stale",
      );
    }
    const sites = new Map(table.sites.map((site) => [site.id, site.location]));
    const origins = new Map(table.origins.map((origin) => [origin.id, origin]));
    const uses = new Map(table.occurrences.map((use) => [use.id, use]));
    const byteCounts = new Map(table.generated.map((file) => [file.file, file.bytes]));
    const byFile = new Map<string, GeneratedRange[]>();
    for (const range of table.ranges) {
      const ranges = byFile.get(range.file) ?? [];
      ranges.push(range);
      byFile.set(range.file, ranges);
    }
    return (file: string, start: number, end: number = start): SourceResolution => {
      const status = statuses.get(file) ?? "missing";
      if (status !== "ready") return { status, related: [] };
      if (
        ![start, end].every((n) => Number.isSafeInteger(n) && n >= 0) ||
        end < start ||
        end > byteCounts.get(file)!
      )
        return { status: "invalid", related: [] };
      const range = byFile
        .get(file)
        ?.filter((r) => r.start <= start && start < r.end && end <= r.end)
        .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
      if (!range) return { status: "unmapped", related: [] };
      const locations: SourceLocation[] = [];
      const add = (location: SourceLocation) => {
        if (!locations.some((other) => JSON.stringify(other) === JSON.stringify(location)))
          locations.push(location);
      };
      const visited = new Set<string>();
      const queue = [{ id: range.origin, context: false }];
      const occurrence = range.occurrence ? uses.get(range.occurrence) : undefined;
      if (range.role === "use" && occurrence?.use) add(sites.get(occurrence.use)!);
      if (occurrence?.definition) add(sites.get(occurrence.definition)!);
      if (occurrence?.name) add({ name: occurrence.name, precision: "named" });
      const own = origins.get(range.origin)!;
      for (const site of own.definitions) add(sites.get(site)!);
      for (const name of own.names) add({ name, precision: "named" });
      const ancestorVisits = new Set<string>();
      let ancestor = occurrence?.parent ? uses.get(occurrence.parent) : undefined;
      while (ancestor && !ancestorVisits.has(ancestor.id)) {
        ancestorVisits.add(ancestor.id);
        if (ancestor.definition) add({ ...sites.get(ancestor.definition)!, precision: "context" });
        if (ancestor.name) add({ name: ancestor.name, precision: "named" });
        ancestor = ancestor.parent ? uses.get(ancestor.parent) : undefined;
      }
      for (let i = 0; i < queue.length; i++) {
        const entry = queue[i];
        if (visited.has(entry.id)) continue;
        visited.add(entry.id);
        const origin = origins.get(entry.id)!;
        for (const site of origin.definitions) {
          const location = sites.get(site)!;
          add(entry.context ? { ...location, precision: "context" } : location);
        }
        for (const name of origin.names) add({ name, precision: "named" });
        for (const parent of origin.parents) queue.push({ id: parent, context: true });
      }
      return locations.length
        ? { status: "mapped", primary: locations[0], related: locations.slice(1), range }
        : { status: "unmapped", related: [], range };
    };
  });
const verifyManifest = (json: string, sourceJson: string, table: SourceMap) =>
  Effect.gen(function* () {
    if (new TextEncoder().encode(json).length > maxMapBytes)
      return yield* new SourceMapError({ message: "Build manifest exceeds size limit" });
    const manifest = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(SourceManifest)(JSON.parse(json)),
      catch: () => new SourceMapError({ message: "Malformed build manifest" }),
    });
    if (
      manifest.build !== table.build ||
      manifest.sources.digest !== (yield* digest(sourceJson)) ||
      canonical(manifest.generated) !== canonical(table.generated)
    )
      return yield* new SourceMapError({ message: "Source map does not match build manifest" });
    return freeze(manifest);
  });

/** Authoritative range artifacts and digest-checked offline lookup; no network fetching. */
export const SourceMaps = Object.freeze({ create, decode, resolver, digest, verifyManifest });
