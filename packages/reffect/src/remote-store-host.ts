/** The reference's Remote memory store (RS-002): tests provide upstream `MemoryStore`. */
import { Context } from "effect";

/** The store operations the reference needs, as upstream `MemoryStore` defines them. */
export interface RemoteStoreApi {
  readonly write: (entity: string, id: string, values: Readonly<Record<string, unknown>>) => void;
  readonly remove: (entity: string, id: string) => void;
}
export class RemoteStoreHost extends Context.Service<RemoteStoreHost, RemoteStoreApi>()(
  "reffect/RemoteStoreHost",
) {}
