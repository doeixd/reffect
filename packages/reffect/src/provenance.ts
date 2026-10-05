import { Match } from "effect";
import { streamExpressions, streamFinalizers } from "./stream-ir.ts";
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
  /** The parents already listed: a shared node gains one per use, so a scan was quadratic. */
  parentSet: Set<string>;
}
const identity = (value: Authored) =>
  value instanceof Fn || value instanceof EffectFn ? value.binder : value.node;
const edge = (name: string, value: Authored): readonly [string, Authored] => [name, value];
type Edges = readonly (readonly [string, Authored])[];
/**
 * Built once with Match.type: a matcher made per node by Match.value was a measurable share of
 * mapped emission (#32).
 */
const nodeChildren = Match.type<
  Expr<unknown>["node"] | Computation<unknown, unknown>["node"]
>().pipe(
  Match.tagsExhaustive({
    Parameter: () => [],
    Literal: () => [],
    Apply: (n) => n.args.map((arg, index) => [`args[${index}]`, arg] as const),
    Match: (n) => [
      edge("condition", n.condition),
      edge("onTrue", n.onTrue),
      edge("onFalse", n.onFalse),
    ],
    Make: (n) =>
      n.fields.flatMap((field, index) =>
        field === undefined ? [] : [[`fields[${index}]`, field] as const],
      ),
    Get: (n) => [edge("value", n.value)],
    MatchUndefined: (n) => [
      edge("value", n.value),
      edge("onDefined", n.onDefined),
      edge("onUndefined", n.onUndefined),
    ],
    Defined: (n) => [edge("value", n.value)],
    Undefined: () => [],
    RecordQuery: (n) =>
      n.key ? [edge("value", n.value), edge("key", n.key)] : [edge("value", n.value)],
    ArrayMake: (n) => n.elements.map((element, index) => [`elements[${index}]`, element] as const),
    ArrayLength: (n) => [edge("value", n.value)],
    ArrayLoop: (n) => [
      edge("source", n.source),
      ...Match.value(n.op).pipe(
        Match.tag("Reduce", (reduce) => [edge("init", reduce.init)]),
        Match.orElse(() => []),
      ),
      edge("body", n.body),
    ],
    ForEach: (n) => [edge("source", n.source), edge("body", n.body)],
    MatchTags: (n) => [
      edge("value", n.value),
      ...n.cases.map((c, index) => [`cases[${index}]`, c.body] as const),
    ],
    Log: (n) => n.attributes.map(([, value], index) => [`attributes[${index}]`, value] as const),
    Annotate: (n) => [edge("value", n.value), edge("body", n.body)],
    CatchAll: (n) => [edge("source", n.source), edge("body", n.body)],
    Scope: (n) => [edge("body", n.body)],
    AddFinalizer: (n) => [edge("finalizer", n.finalizer)],
    AcquireRelease: (n) => [edge("acquire", n.acquire), edge("release", n.release)],
    RegisteredFile: (n) => [edge("body", n.body), edge("afterClose", n.afterClose)],
    AcquireUseRelease: (n) => [
      edge("acquire", n.acquire),
      edge("use", n.use),
      edge("release", n.release),
    ],
    FileScope: (n) => [edge("body", n.body), edge("afterClose", n.afterClose)],
    DeferredMake: () => [],
    DeferredScope: (n) => [edge("body", n.body)],
    DeferredAwait: () => [],
    DeferredComplete: (n) => [edge("value", n.value)],
    DeferredIsDone: () => [],
    RefMake: (n) => [edge("initial", n.initial)],
    RefScope: (n) => [edge("initial", n.initial), edge("body", n.body)],
    RefGet: () => [],
    RefModify: (n) => [edge("result", n.result), edge("next", n.next)],
    TaskGroup: (n) => n.children.map((child, index) => edge(`children[${index}]`, child)),
    ClockReadMillis: () => [],
    RandomDraw: () => [],
    FileSize: () => [],
    Sleep: () => [],
    Launch: (n) => n.values.map((value, index) => edge(`values.${index}`, value)),
    RemoteStore: (n) =>
      n.values ? [edge("id", n.id), edge("values", n.values)] : [edge("id", n.id)],
    Repeat: (n) => [edge("body", n.body)],
    Retry: (n) => [edge("body", n.body)],
    Ensuring: (n) => [edge("body", n.body), edge("finalizer", n.finalizer)],
    Span: (n) => [edge("body", n.body)],
    Succeed: (n) => [edge("value", n.value)],
    StreamRunCollect: (n) =>
      streamExpressions(n.stream)
        .map(({ expr, path }) => edge(path, expr))
        .concat(streamFinalizers(n.stream).map(({ finalizer, path }) => edge(path, finalizer))),
    StreamEmit: (n) =>
      streamExpressions(n.stream)
        .map(({ expr, path }) => edge(path, expr))
        .concat(streamFinalizers(n.stream).map(({ finalizer, path }) => edge(path, finalizer)))
        .concat([edge("encoded", n.encoded)]),
    Fail: (n) => [edge("error", n.error)],
    Map: (n) => [edge("source", n.source), edge("body", n.body)],
    FlatMap: (n) => [edge("source", n.source), edge("body", n.body)],
  }),
);
const appliedOperation = Match.type<Expr<unknown>["node"]>().pipe(
  Match.tag("Apply", (n): string | undefined => n.operation.id),
  Match.orElse(() => undefined),
);
const children = (value: Authored): Edges =>
  value instanceof Fn || value instanceof EffectFn
    ? [["body", value.body]]
    : nodeChildren(value.node);

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
        const owner = this.originValues[Number(origin.slice(1))];
        if (!owner.parentSet.has(parent.origin)) {
          owner.parentSet.add(parent.origin);
          owner.parents.push(parent.origin);
        }
      }
      const operation = value instanceof Expr ? appliedOperation(value.node) : undefined;
      if (operation !== undefined) {
        const found = this.semanticOrigins.get(`operation:${operation}`) ?? new Set<string>();
        found.add(origin);
        this.semanticOrigins.set(`operation:${operation}`, found);
      }
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
        parentSet: new Set(),
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
    return this.originValues.map(({ parentSet: _parentSet, ...origin }) =>
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
