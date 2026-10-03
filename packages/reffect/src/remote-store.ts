/**
 * The Remote memory store as R effects (RS-001): `write` and `remove` mirror upstream
 * `MemoryStore`. The reference reaches the store through `RemoteStoreHost`, which tests give
 * `RemoteServer.memory(...)`'s own store; natively the server passes its store through the
 * execution context (RS-003).
 */
import { Computation, EffectIR, remoteStore, remoteStoreGet } from "./effect-ir.ts";
import { Expr, IRType, StringType, UnknownType, fail, structLayout } from "./kernel.ts";
import { OptionIR } from "./option.ts";
import { ArrayIR } from "./records.ts";
import type { OptionValue } from "./option.ts";
import { UndefinedOr } from "./records.ts";
import { SchemaIR } from "./schema-json.ts";
export {
  LiveHubHost,
  RemoteStoreHost,
  memoryStoreApi,
  type LiveHubApi,
  type LiveRef,
  type RemoteStoreApi,
  type StoredRow,
} from "./remote-store-host.ts";

const entityName = (entity: string, at: string): string => {
  if (entity.length === 0)
    throw fail("INVALID_ENTITY", "authoring", at, "Entity names are nonempty");
  return entity;
};
export const RemoteStoreIR = Object.freeze({
  /**
   * The stored row with this ID, as the wire holds it (RS-007), read where the mutation runs: in
   * its transaction on SQL. Decode it with `Schema.decodeUnknownOption(Schema.toCodecJson(W))`.
   */
  get: (entity: string, id: Expr<string>): Computation<OptionValue<unknown>, never> =>
    EffectIR.map(
      remoteStoreGet(
        entityName(entity, "RemoteStore.get"),
        checkedId(id, "RemoteStore.get"),
        UndefinedOr(UnknownType),
      ),
      (row) => OptionIR.fromUndefinedOr(row),
    ),
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

/** A row reference with a static entity, as `LiveHub.changed`/`deleted` take it. */
export interface LiveRowRef {
  readonly entity: string;
  readonly id: Expr<string>;
}
const StringArray = ArrayIR(StringType);
/**
 * Signals for upstream's `LiveHub` (LIVE-001), run where a mutation changes data. Natively the
 * server's hub re-reads the row for each subscriber; on the memory backend the signal applies
 * when it runs (LIVE-003). Requires `NativeRemote.compile(..., { live: true })`.
 */
export const LiveHubIR = Object.freeze({
  /** `hub.changed(ref, fields)`: subscribers selecting any of `fields` receive them, re-read. */
  changed: (
    ref: LiveRowRef,
    fields: ReadonlyArray<string> | Expr<ReadonlyArray<string>>,
  ): Computation<void, never> => {
    const names =
      fields instanceof Expr
        ? fields
        : Expr.arrayMake(
            StringArray,
            fields.map((field) => Expr.literal(StringType, field)),
          );
    if (!IRType.same(names.type, StringArray))
      throw fail("TYPE_MISMATCH", "authoring", "LiveHub.changed", "Fields are an Array<String>");
    return remoteStore(
      "Changed",
      entityName(ref.entity, "LiveHub.changed"),
      checkedId(ref.id, "LiveHub.changed"),
      names,
    );
  },
  /** `hub.deleted(ref)`: subscribers selecting the row receive `EntityDeleted`. */
  deleted: (ref: LiveRowRef): Computation<void, never> =>
    remoteStore(
      "Deleted",
      entityName(ref.entity, "LiveHub.deleted"),
      checkedId(ref.id, "LiveHub.deleted"),
      undefined,
    ),
});
