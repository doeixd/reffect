import { Match } from "effect";
import { Expr, Fn, CompileError, fail } from "./kernel.ts";
import type { Diagnostic, Program } from "./kernel.ts";
import { Computation, EffectFn } from "./effect-ir.ts";
import type { SourceFile, SourceSite, SourceLocation } from "./source.ts";

type Authored = Expr<unknown> | Computation<unknown, unknown> | Fn | EffectFn;
export interface OriginRecord {
  readonly id: string;
  readonly kind: string;
  readonly names: readonly string[];
  readonly definitions: readonly string[];
  readonly parents: readonly string[];
}
export interface OccurrenceRecord {
  readonly id: string;
  readonly path: string;
  readonly origin: string;
  readonly parent?: string;
  readonly use?: string;
  readonly definition?: string;
  readonly name?: string;
}
export interface ProvenanceSnapshot {
  readonly files: readonly { readonly id: string; readonly snapshot: SourceFile }[];
  readonly sites: readonly {
    readonly id: string;
    readonly file: string;
    readonly location: SourceLocation;
  }[];
  readonly origins: readonly OriginRecord[];
  readonly occurrences: readonly OccurrenceRecord[];
}
interface MutableOrigin {
  id: string;
  kind: string;
  names: string[];
  definitions: string[];
  parents: string[];
}
const identity = (value: Authored) =>
  value instanceof Fn || value instanceof EffectFn ? value.binder : value.node;
const edge = (name: string, value: Authored): readonly [string, Authored] => [name, value];
const children = (value: Authored): readonly (readonly [string, Authored])[] => {
  if (value instanceof Fn || value instanceof EffectFn) return [["body", value.body]];
  return Match.value(value.node).pipe(
    Match.tagsExhaustive({
      Parameter: () => [],
      Literal: () => [],
      Apply: (n) => n.args.map((arg, index) => [`args[${index}]`, arg] as const),
      Match: (n) => [
        edge("condition", n.condition),
        edge("onTrue", n.onTrue),
        edge("onFalse", n.onFalse),
      ],
      Log: (n) => n.attributes.map(([, value], index) => [`attributes[${index}]`, value] as const),
      Annotate: (n) => [edge("value", n.value), edge("body", n.body)],
      CatchAll: (n) => [edge("source", n.source), edge("body", n.body)],
      AcquireUseRelease: (n) => [
        edge("acquire", n.acquire),
        edge("use", n.use),
        edge("release", n.release),
      ],
      Sleep: () => [],
      Ensuring: (n) => [edge("body", n.body), edge("finalizer", n.finalizer)],
      Span: (n) => [edge("body", n.body)],
      Succeed: (n) => [edge("value", n.value)],
      Fail: (n) => [edge("error", n.error)],
      Map: (n) => [edge("source", n.source), edge("body", n.body)],
      FlatMap: (n) => [edge("source", n.source), edge("body", n.body)],
    }),
  );
};

/** One origin per semantic node; one occurrence per retained graph edge, not per expanded DAG path. */
export class Provenance {
  private readonly originsByNode = new Map<object | symbol, MutableOrigin>();
  private readonly occurrencesByPath = new Map<string, OccurrenceRecord>();
  private readonly filesBySnapshot = new Map<string, string>();
  private readonly filesByObject = new WeakMap<SourceFile, string>();
  private readonly sitesByObject = new WeakMap<SourceSite, string>();
  private readonly sitesByKey = new Map<string, string>();
  private readonly semanticOrigins = new Map<string, Set<string>>();
  readonly files: { readonly id: string; readonly snapshot: SourceFile }[] = [];
  readonly sites: {
    readonly id: string;
    readonly file: string;
    readonly location: SourceLocation;
  }[] = [];
  private readonly originValues: MutableOrigin[] = [];

  constructor(program: Program) {
    const seen = new Set<object | symbol>();
    const walk = (value: Authored, path: string, parent?: OccurrenceRecord) => {
      if (this.occurrencesByPath.size >= 100000)
        throw fail("PROVENANCE_LIMIT", "lower", path, "Provenance graph exceeds 100000 edges");
      const origin = this.origin(value);
      const use = value.source.use ? this.site(value.source.use) : undefined;
      const occurrence = Object.freeze({
        id: `u${this.occurrencesByPath.size}`,
        path,
        origin,
        ...(parent === undefined ? {} : { parent: parent.id }),
        ...(use === undefined ? {} : { use }),
        ...(value.source.definition ? { definition: this.site(value.source.definition) } : {}),
        ...(value.source.name ? { name: value.source.name } : {}),
      });
      this.occurrencesByPath.set(path, occurrence);
      if (parent) {
        const parents = this.originValues[Number(origin.slice(1))].parents;
        if (!parents.includes(parent.origin)) parents.push(parent.origin);
      }
      if (value instanceof Expr)
        Match.value(value.node).pipe(
          Match.tags({
            Apply: (n) => {
              const found =
                this.semanticOrigins.get(`operation:${n.operation.id}`) ?? new Set<string>();
              found.add(origin);
              this.semanticOrigins.set(`operation:${n.operation.id}`, found);
            },
          }),
          Match.orElse(() => {}),
        );
      const types =
        value instanceof Expr
          ? [value.type]
          : value instanceof Computation
            ? [value.output, value.error]
            : value instanceof EffectFn
              ? [...value.input, value.output, value.error]
              : [...value.input, value.output];
      for (const type of types) {
        const found = this.semanticOrigins.get(`type:${type.id}`) ?? new Set<string>();
        found.add(origin);
        this.semanticOrigins.set(`type:${type.id}`, found);
      }
      const key = identity(value);
      if (seen.has(key)) return;
      seen.add(key);
      for (const [edge, child] of children(value)) walk(child, `${path}.${edge}`, occurrence);
    };
    for (const [name, value] of Object.entries(program.functions)) {
      seen.clear();
      walk(value, `functions.${name}`);
    }
  }
  private site(site: SourceSite): string {
    const known = this.sitesByObject.get(site);
    if (known !== undefined) return known;
    let file = this.filesByObject.get(site.file);
    const fileKey =
      file === undefined ? JSON.stringify([site.file.path, site.file.text]) : undefined;
    if (file === undefined) file = this.filesBySnapshot.get(fileKey!);
    if (file === undefined) {
      file = `f${this.files.length}`;
      this.filesBySnapshot.set(fileKey!, file);
      this.files.push({ id: file, snapshot: site.file });
    }
    this.filesByObject.set(site.file, file);
    const key = JSON.stringify([file, site.start, site.end, site.name]);
    let id = this.sitesByKey.get(key);
    if (id === undefined) {
      id = `s${this.sites.length}`;
      this.sitesByKey.set(key, id);
      this.sites.push({ id, file, location: site.location() });
    }
    this.sitesByObject.set(site, id);
    return id;
  }
  origin(value: Authored): string {
    const key = identity(value);
    let origin = this.originsByNode.get(key);
    if (!origin) {
      origin = {
        id: `o${this.originValues.length}`,
        kind:
          value instanceof Fn
            ? "Function"
            : value instanceof EffectFn
              ? "EffectFunction"
              : value.node._tag,
        names: [],
        definitions: [],
        parents: [],
      };
      this.originsByNode.set(key, origin);
      this.originValues.push(origin);
    }
    if (value.source.name && !origin.names.includes(value.source.name))
      origin.names.push(value.source.name);
    if (value.source.definition) {
      const site = this.site(value.source.definition);
      if (!origin.definitions.includes(site)) origin.definitions.push(site);
    }
    return origin.id;
  }
  use(path: string): string | undefined {
    return this.occurrencesByPath.get(path)?.id;
  }
  get origins(): readonly OriginRecord[] {
    return this.originValues.map((origin) =>
      Object.freeze({
        ...origin,
        names: Object.freeze([...origin.names]),
        definitions: Object.freeze([...origin.definitions]),
        parents: Object.freeze([...origin.parents]),
      }),
    );
  }
  get occurrences(): readonly OccurrenceRecord[] {
    return [...this.occurrencesByPath.values()];
  }
  snapshot(): ProvenanceSnapshot {
    return Object.freeze({
      files: Object.freeze(this.files.map((file) => Object.freeze({ ...file }))),
      sites: Object.freeze(this.sites.map((site) => Object.freeze({ ...site }))),
      origins: Object.freeze(this.origins),
      occurrences: Object.freeze(this.occurrences),
    });
  }
  diagnostic(diagnostic: Diagnostic): Diagnostic {
    const candidates = this.occurrences
      .filter((use) => diagnostic.path === use.path || diagnostic.path.startsWith(`${use.path}.`))
      .sort((a, b) => b.path.length - a.path.length);
    if (!candidates.length) {
      const kind = diagnostic.code === "UNSUPPORTED_REPRESENTATION" ? "type" : "operation";
      const origins = this.semanticOrigins.get(`${kind}:${diagnostic.path}`);
      if (origins) candidates.push(...this.occurrences.filter((use) => origins.has(use.origin)));
    }
    const locations: SourceLocation[] = [];
    const add = (location: SourceLocation) => {
      if (!locations.some((l) => JSON.stringify(l) === JSON.stringify(location)))
        locations.push(location);
    };
    for (const candidate of candidates) {
      let current: OccurrenceRecord | undefined = candidate;
      let contextual = false;
      const visited = new Set<string>();
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        const origin = this.originValues[Number(current.origin.slice(1))];
        const ids = [
          ...(current.use ? [current.use] : []),
          ...(current.definition ? [current.definition] : []),
          ...origin.definitions,
        ];
        for (const id of ids) {
          const location = this.sites.find((s) => s.id === id)!.location;
          add(contextual ? { ...location, precision: "context" } : location);
        }
        if (current.name) add({ name: current.name, precision: "named" });
        for (const name of origin.names) add({ name, precision: "named" });
        current = current.parent
          ? this.occurrences.find((o) => o.id === current!.parent)
          : undefined;
        contextual = true;
      }
    }
    return locations.length
      ? { ...diagnostic, primary: locations[0], related: locations.slice(1) }
      : diagnostic;
  }
}
export const locateCompileError = (program: Program, error: CompileError): CompileError => {
  try {
    const provenance = new Provenance(program);
    return new CompileError({
      message: error.message,
      diagnostics: error.diagnostics.map((diagnostic) => provenance.diagnostic(diagnostic)),
    });
  } catch {
    // Location enrichment must never hide the original semantic diagnostic.
    return error;
  }
};
