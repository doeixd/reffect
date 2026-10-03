/** The reference's Remote memory store (RS-002): tests provide upstream `MemoryStore`. */
import { Context } from "effect";
import type { Effect } from "effect";

/**
 * The store operations the reference needs, as upstream `MemoryStore` defines them, plus `get`,
 * the row lookup `memory` itself uses (RS-007). An operation may return an Effect, for a store
 * whose driver is asynchronous (SQLX-016); its failure is a defect, as a native store failure
 * aborts the mutation.
 */
/** A stored row as the wire holds it, or undefined for an absent ID. */
export type StoredRow = Readonly<Record<string, unknown>> | undefined;
export interface RemoteStoreApi {
  /** The stored row with this ID, or undefined. */
  readonly get: (entity: string, id: string) => StoredRow | Effect.Effect<StoredRow>;
  readonly write: (
    entity: string,
    id: string,
    values: Readonly<Record<string, unknown>>,
  ) => void | Effect.Effect<void>;
  readonly remove: (entity: string, id: string) => void | Effect.Effect<void>;
}
export class RemoteStoreHost extends Context.Service<RemoteStoreHost, RemoteStoreApi>()(
  "reffect/RemoteStoreHost",
) {}

/** A row reference, as upstream's `LiveHub` takes it. */
export interface LiveRef {
  readonly entity: string;
  readonly id: string;
}
/**
 * The reference's live hub (LIVE-001): upstream `RemoteServer.liveHub(entities)` itself, whose
 * `changed`/`deleted` the oracle server's subscribers observe. A failure is a defect.
 */
export interface LiveHubApi {
  readonly changed: (ref: LiveRef, fields: ReadonlyArray<string>) => Effect.Effect<void, unknown>;
  readonly deleted: (ref: LiveRef) => Effect.Effect<void, unknown>;
}
export class LiveHubHost extends Context.Service<LiveHubHost, LiveHubApi>()(
  "reffect/LiveHubHost",
) {}

/**
 * A `RemoteStoreApi` over upstream's `MemoryStore`, whose rows are looked up as `memory` reads
 * them: by `String(row.id)`, in insertion order.
 */
export const memoryStoreApi = (store: {
  readonly rows: (entity: string) => ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly write: RemoteStoreApi["write"];
  readonly remove: RemoteStoreApi["remove"];
}): RemoteStoreApi => ({
  get: (entity, id) => store.rows(entity).find((row) => String(row.id) === id),
  write: (entity, id, values) => store.write(entity, id, values),
  remove: (entity, id) => store.remove(entity, id),
});
