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
                planned.push({ _tag: "Query", request });
                return {
                  edges: [],
                  start: { _tag: "Terminal" as const },
                  end: { _tag: "Terminal" as const },
                  entities: [],
                };
              }),
            read: (request) =>
              Effect.sync(() => {
                planned.push({ _tag: "Read", request });
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
export interface PagePlan {
  readonly reads: ReadonlyArray<PlannedRead>;
  readonly views: { readonly [name: string]: PlannedView };
}
/** A page view (M9-3 step 2b): the planned Query whose answer becomes the view's `Page`. */
export interface PlannedView {
  readonly _tag: "Query";
  readonly read: number;
}
/**
 * A page's reads and the views its R render reads from them, from each view's
 * `Data.prefetch(initial, projection)`. A view is a query projection with a flat selection; its
 * value is upstream's `Page` (`items`, `hasNext`, `hasPrevious`) of a Ready read.
 */
export const planPage = (views: {
  readonly [name: string]: Effect.Effect<unknown, unknown, RemoteClient>;
}): PagePlan => {
  const reads: Array<PlannedRead> = [];
  const planned: { [name: string]: PlannedView } = {};
  for (const [name, prefetch] of Object.entries(views)) {
    const own = planReads(prefetch);
    const query = own[0];
    if (own.length !== 1 || query?._tag !== "Query")
      throw new Error(`Remote page view "${name}" is not a single query projection`);
    planned[name] = { _tag: "Query", read: reads.length };
    reads.push(query);
  }
  return { reads, views: planned };
};
