/**
 * Resuming a server render's Remote data in the browser (milestone 9, M9-2).
 *
 * The server runs `Data.satisfy` while {@link record} keeps every protocol exchange it makes. The
 * exchanges travel in the page's Flags, and the client's `init` runs the same `Data.satisfy` over
 * {@link replay}, so the first render reads what the server rendered and plans no fetch. The browser
 * keeps upstream's own reducer and Model; only versioned wire data crosses.
 *
 * Browser-safe: it imports only effect and foldkit-remote.
 */
import { Effect, Layer, Schema, Stream } from "effect";
import type { Fn, IRType } from "./kernel.ts";
import { Reference } from "./reference.ts";
import {
  QueryRequest,
  QueryResult,
  ReadBatch,
  ReadBatchResult,
  RemoteClient,
  RemoteLiveError,
  RemoteMutationError,
  RemoteQueryError,
  RemoteReadError,
  stableStringify,
} from "foldkit-remote";

/** One request a Remote client made and the server's answer to it. */
export const RemoteExchange = Schema.Union([
  Schema.TaggedStruct("Query", { request: QueryRequest, answer: QueryResult }),
  Schema.TaggedStruct("Read", { request: ReadBatch, answer: ReadBatchResult }),
]);
export type RemoteExchange = typeof RemoteExchange.Type;

/** What a resumed page carries: the clock `Data.satisfy` ran with, and its exchanges in order. */
export const RemoteResume = Schema.Struct({
  now: Schema.Number,
  exchanges: Schema.Array(RemoteExchange),
});
export type RemoteResume = typeof RemoteResume.Type;

// Requests are matched by their encoded wire form, so a Flags round trip does not change the key.
const queryKey = (request: typeof QueryRequest.Type) =>
  stableStringify(Schema.encodeSync(QueryRequest)(request));
const readKey = (request: typeof ReadBatch.Type) =>
  stableStringify(Schema.encodeSync(ReadBatch)(request));

/**
 * Runs `effect` against the provided `RemoteClient` and returns its result with the Query and Read
 * exchanges it made, in order. Mutations and live streams pass through unrecorded.
 */
export const record = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<readonly [A, ReadonlyArray<RemoteExchange>], E, R | RemoteClient> =>
  Effect.gen(function* () {
    const client = yield* RemoteClient;
    const exchanges: Array<RemoteExchange> = [];
    const result = yield* effect.pipe(
      Effect.provideService(RemoteClient, {
        ...client,
        query: (request) =>
          client
            .query(request)
            .pipe(
              Effect.tap((answer) =>
                Effect.sync(() => exchanges.push({ _tag: "Query", request, answer })),
              ),
            ),
        read: (request) =>
          client
            .read(request)
            .pipe(
              Effect.tap((answer) =>
                Effect.sync(() => exchanges.push({ _tag: "Read", request, answer })),
              ),
            ),
      }),
    );
    return [result, exchanges] as const;
  });

/**
 * A `RemoteClient` answering only from recorded exchanges, synchronously, so `Effect.runSync` can
 * run `Data.satisfy` inside `init`. A request that was not recorded fails with the operation's
 * typed error, which `init` may recover from by starting empty. Provide it directly: the coalescing
 * of `Remote.clientLayer` would make the run asynchronous.
 */
export const replay = (exchanges: ReadonlyArray<RemoteExchange>): Layer.Layer<RemoteClient> => {
  const queries = new Map<string, typeof QueryResult.Type>();
  const reads = new Map<string, typeof ReadBatchResult.Type>();
  for (const exchange of exchanges)
    if (exchange._tag === "Query") queries.set(queryKey(exchange.request), exchange.answer);
    else reads.set(readKey(exchange.request), exchange.answer);
  const unrecorded = "Remote resume: the request was not recorded by the server render";
  return Layer.succeed(RemoteClient, {
    query: (request) => {
      const answer = queries.get(queryKey(request));
      return answer === undefined
        ? Effect.fail(new RemoteQueryError({ message: unrecorded }))
        : Effect.succeed(answer);
    },
    read: (request) => {
      const answer = reads.get(readKey(request));
      return answer === undefined
        ? Effect.fail(new RemoteReadError({ message: unrecorded }))
        : Effect.succeed(answer);
    },
    mutate: () =>
      Effect.fail(new RemoteMutationError({ message: "Remote resume: replay does not mutate" })),
    live: () => Stream.fail(new RemoteLiveError({ message: "Remote resume: replay is not live" })),
  });
};

/** A request a page's reads make, planned while compiling (M9-3 step 2a), as wire JSON. */
export const PlannedRead = Schema.Union([
  Schema.TaggedStruct("Query", { request: QueryRequest }),
  Schema.TaggedStruct("Read", { request: ReadBatch }),
]);
export type PlannedRead = typeof PlannedRead.Type;

/**
 * The requests `effect` (a page's `Data.satisfy`) makes, in order, planned without data: every
 * query answers an empty page and every read nothing, which upstream settles as missing. This is
 * the first pass only. A read that appears only once another has answered (a relation, or a
 * Surface waiting on another's data) is not planned, so declared reads must not depend on data;
 * the browser's replay then fails with its typed error rather than fetching.
 */
const planReads = <A, E>(effect: Effect.Effect<A, E, RemoteClient>): ReadonlyArray<PlannedRead> => {
  const planned: Array<PlannedRead> = [];
  Effect.runSync(
    Effect.exit(
      effect.pipe(
        Effect.provide(
          Layer.succeed(RemoteClient, {
            query: (request) =>
              Effect.sync(() => {
                // In the schema's key order, as the page's Flags encode it (RemoteResume).
                planned.push({ _tag: "Query", request: Schema.encodeSync(QueryRequest)(request) });
                return {
                  edges: [],
                  start: { _tag: "Terminal" as const },
                  end: { _tag: "Terminal" as const },
                  entities: [],
                };
              }),
            read: (request) =>
              Effect.sync(() => {
                planned.push({ _tag: "Read", request: Schema.encodeSync(ReadBatch)(request) });
                return { entities: [], settled: [] };
              }),
            mutate: () =>
              Effect.fail(new RemoteMutationError({ message: "Planning reads does not mutate" })),
            live: () => Stream.fail(new RemoteLiveError({ message: "Planning reads is not live" })),
          }),
        ),
      ),
    ),
  );
  return planned;
};

/**
 * What a NativeRemote page reads (#13): its planned requests, and the views the render reads
 * from them by index. `planPage` builds one; a hand-written plan is the same plain data.
 */
export interface PagePlan<V extends PlannedViews = PlannedViews> {
  readonly reads: ReadonlyArray<PlannedRead>;
  readonly views: V;
}
/**
 * A page view (M9-3 step 2b): the planned Query whose answer becomes the view's `Page`, and the
 * projection's selection schema, which decodes each item as upstream's `decodeRow` does (#6).
 */
export interface PlannedQueryView<Item extends Schema.Top = Schema.Top> {
  readonly _tag: "Query";
  readonly read: number;
  readonly item: Item;
  /**
   * For a view whose query input comes from the page URL: the pure R function computing it from
   * the page's resolved URL. The planned request's `input` is then a template the host fills.
   */
  readonly input?: Fn<readonly [IRType<string>], unknown>;
}
/**
 * A get view (docs/research/ssr-data.md, "Gets as page views"): the planned Read of one entity,
 * whose answer becomes the view's `R.Remote.Data` (Ready or NotFound), decoded by `item`.
 */
export interface PlannedGetView<Item extends Schema.Top = Schema.Top> {
  readonly _tag: "Get";
  readonly read: number;
  readonly item: Item;
  /** For an id that comes from the page URL: the pure R function computing it from the URL. */
  readonly id?: Fn<readonly [IRType<string>], string>;
}
export type PlannedView<Item extends Schema.Top = Schema.Top> =
  | PlannedQueryView<Item>
  | PlannedGetView<Item>;
export type PlannedViews = { readonly [name: string]: PlannedView };
/** A query projection a page view reads: upstream's `QueryProjection`, by what a plan needs. */
export interface PageProjection {
  readonly selection: { readonly schema: Schema.Top };
}
/**
 * A view whose query input comes from the page URL: `input` derives it (with `R.Url`), and
 * `projection` builds the view's query projection from it, as the app's own code would.
 */
export interface TemplatedView<I, P extends PageProjection> {
  readonly input: Fn<readonly [IRType<string>], I>;
  readonly projection: (input: I) => P;
}
interface TemplatedEntry {
  readonly input: Fn<readonly [IRType<string>], unknown>;
  readonly projection: (input: never) => PageProjection;
}
/**
 * A view of one entity: upstream's `Data.get(get, id)`, with the selection itself so the plan can
 * decode it. `id` is constant, or a pure R function of the page URL (with `R.Url`).
 */
export interface GetView<S extends PageSelection = PageSelection> {
  readonly get: S;
  readonly id: string | Fn<readonly [IRType<string>], string>;
}
/** An entity selection, by what a plan needs: `Entity.select`'s schema. */
export interface PageSelection {
  readonly schema: Schema.Top;
}
type ViewEntry = PageProjection | TemplatedEntry | GetView;
/** A templated view's projection must accept what its input returns. */
type CheckedViews<V> = {
  readonly [K in keyof V]: V[K] extends { readonly input: Fn<readonly [IRType<string>], infer I> }
    ? { readonly input: V[K]["input"]; readonly projection: (input: I) => PageProjection }
    : V[K];
};
/** The query projection a view entry reads; a get view reads none. */
type ProjectionOf<E> = E extends GetView
  ? never
  : E extends { readonly projection: (input: never) => infer P }
    ? P
    : E;
type ItemOf<E> = E extends GetView
  ? E["get"]["schema"]
  : ProjectionOf<E> extends PageProjection
    ? ProjectionOf<E>["selection"]["schema"]
    : never;
type PlannedOf<E> = E extends GetView ? PlannedGetView<ItemOf<E>> : PlannedQueryView<ItemOf<E>>;
const isTemplated = (entry: ViewEntry): entry is TemplatedEntry => "projection" in entry;
const isGet = (entry: ViewEntry): entry is GetView => "get" in entry;
/**
 * A page's reads and the views its R render reads from them: each view's
 * `data.prefetch(initial, projection)`, planned, with the projection's selection schema. A query
 * view is a query projection with a flat selection; its value is upstream's `Page` (`items`,
 * `hasNext`, `hasPrevious`) of a Ready read, its items decoded by that schema. A get view
 * (`{ get: select, id }`) reads one entity; its value is `R.Remote.Data`, Ready or NotFound.
 *
 * A templated view (or id) is planned on its function evaluated by the reference at `origin`'s
 * root (default `http://localhost/`); natively the page fills its request from the request's URL.
 */
export const planPage = <M, const V extends { readonly [name: string]: ViewEntry }>(
  data: {
    /**
     * Upstream's `Data.prefetch`, generic over each projection's value; views of different
     * selections are each its own projection, so none narrows the others.
     */
    prefetch(model: M, projection: never): Effect.Effect<unknown, unknown, RemoteClient>;
    /** Upstream's `Data.get`; the selection is checked against the domain when planned. */
    get(selection: never, id: string): unknown;
  },
  initial: M,
  views: V & CheckedViews<V>,
  options: { readonly origin?: string } = {},
): PagePlan<{ readonly [K in keyof V]: PlannedOf<V[K]> }> => {
  const sample = new URL("/", options.origin ?? "http://localhost").href;
  const reads: Array<PlannedRead> = [];
  const planned: { [name: string]: PlannedView } = {};
  for (const [name, entry] of Object.entries(views) as Array<[string, ViewEntry]>) {
    if (isGet(entry)) {
      const id =
        typeof entry.id === "string" ? entry.id : Effect.runSync(Reference.run(entry.id, [sample]));
      const own = planReads(data.prefetch(initial, data.get(entry.get as never, id) as never));
      const read = own[0];
      if (own.length !== 1 || read?._tag !== "Read" || read.request.requests.length !== 1)
        throw new Error(`Remote page view "${name}" is not a single entity read`);
      planned[name] = {
        _tag: "Get",
        read: reads.length,
        item: entry.get.schema,
        ...(typeof entry.id === "string" ? {} : { id: entry.id }),
      };
      reads.push(read);
      continue;
    }
    const projection = isTemplated(entry)
      ? entry.projection(Effect.runSync(Reference.run(entry.input, [sample])) as never)
      : entry;
    const own = planReads(data.prefetch(initial, projection as never));
    const query = own[0];
    if (own.length !== 1 || query?._tag !== "Query")
      throw new Error(`Remote page view "${name}" is not a single query projection`);
    planned[name] = {
      _tag: "Query",
      read: reads.length,
      item: projection.selection.schema,
      ...(isTemplated(entry) ? { input: entry.input } : {}),
    };
    reads.push(query);
  }
  return {
    reads,
    views: planned as { readonly [K in keyof V]: PlannedOf<V[K]> },
  };
};
