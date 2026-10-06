/**
 * The reference for `R.sql` (SQL-008): the statement runs through the official `SqlClient` from
 * the context, as the tagged template `sql\`...\`` would run it, and its outcome becomes the
 * plain data the R program decodes: the rows, or the `SqlError` with its classified reason.
 */
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql";

/** A reason as plain data (SQL-003): its tag and the fields Effect gives it; `cause` is not kept. */
const reasonData = (reason: SqlError.SqlError["reason"]): Record<string, unknown> => ({
  _tag: reason._tag,
  ...(reason.message === undefined ? {} : { message: reason.message }),
  ...(reason.operation === undefined ? {} : { operation: reason.operation }),
  ...("constraint" in reason ? { constraint: reason.constraint } : {}),
});

// Drivers return rows as their own objects (node:sqlite's have a null prototype).
const plainRow = (row: unknown): unknown =>
  typeof row === "object" && row !== null && !Array.isArray(row) ? { ...row } : row;

/** `{ _tag: "Success", success: rows }` or `{ _tag: "Failure", failure: SqlError data }`. */
export const sqlOutcomeReference = (
  strings: ReadonlyArray<string>,
  params: ReadonlyArray<unknown>,
): Effect.Effect<unknown> =>
  Effect.serviceOption(SqlClient.SqlClient).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.die(new Error("R.sql requires an effect/sql SqlClient in the reference")),
        onSome: (sql) =>
          sql(Object.assign([...strings], { raw: [...strings] }), ...params).pipe(
            Effect.map((rows): unknown => ({ _tag: "Success", success: rows.map(plainRow) })),
            Effect.catch((error) =>
              Effect.succeed({
                _tag: "Failure",
                failure: { _tag: "SqlError", reason: reasonData(error.reason) },
              }),
            ),
          ),
      }),
    ),
  );
