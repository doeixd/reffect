/**
 * The Remote memory store as R effects (RS-001): `write` and `remove` mirror upstream
 * `MemoryStore`. The reference reaches the store through `RemoteStoreHost`, which tests give
 * `RemoteServer.memory(...)`'s own store; natively the server passes its store through the
 * execution context (RS-003).
 */
import { Computation, remoteStore } from "./effect-ir.ts";
import { Expr, IRType, StringType, fail, structLayout } from "./kernel.ts";
import { SchemaIR } from "./schema-json.ts";
export { RemoteStoreHost, type RemoteStoreApi } from "./remote-store-host.ts";

const entityName = (entity: string, at: string): string => {
  if (entity.length === 0)
    throw fail("INVALID_ENTITY", "authoring", at, "Entity names are nonempty");
  return entity;
};
export const RemoteStoreIR = Object.freeze({
  /**
   * `store.write(entity, id, values)`: the row becomes `{ ...existing, id, ...values }`. `values`
   * is a Struct of the entity's wire-shaped fields, stored as its JSON encoding (RM-006).
   */
  write: <A>(entity: string, id: Expr<string>, values: Expr<A>): Computation<void, never> => {
    const layout = structLayout(values.type);
    if (!layout || layout.tag !== undefined)
      throw fail(
        "TYPE_MISMATCH",
        "authoring",
        "RemoteStore.write",
        "Values must be a plain Struct of the entity's wire-shaped fields",
      );
    return remoteStore(
      "Write",
      entityName(entity, "RemoteStore.write"),
      checkedId(id, "RemoteStore.write"),
      SchemaIR.encodeSync(SchemaIR.toCodecJson(values.type))(values),
    );
  },
  /** `store.remove(entity, id)`; removing an absent row changes nothing. */
  remove: (entity: string, id: Expr<string>): Computation<void, never> =>
    remoteStore(
      "Remove",
      entityName(entity, "RemoteStore.remove"),
      checkedId(id, "RemoteStore.remove"),
      undefined,
    ),
});
const checkedId = (id: Expr<string>, at: string): Expr<string> => {
  if (!IRType.same(id.type, StringType))
    throw fail("TYPE_MISMATCH", "authoring", at, "Row IDs are Strings");
  return id;
};
