/** The reference's Remote memory store (RS-002): tests provide upstream `MemoryStore`. */
import { Context } from "effect";
import type { Effect } from "effect";

/**
 * The store operations the reference needs, as upstream `MemoryStore` defines them. An operation
 * may return an Effect, for a store whose driver is asynchronous (SQLX-016); its failure is a
 * defect, as a native store failure aborts the mutation.
 */
export interface RemoteStoreApi {
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
