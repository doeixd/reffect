/**
 * Milestone 5 SQL planning (SQLX-003, SQLX-005): storage metadata read from `foldkit-remote-drizzle`
 * bindings at build time, and `Query.define` bodies compiled to fixed, dialect-explicit SQL with a
 * typed parameter plan. The lowering follows upstream `compile.ts` and the keyset paging of its
 * query source (0.9.0); only values vary per request, so every statement is `&'static str` natively.
 */
import { Match } from "effect";
import { isPredicate } from "foldkit-entity";
import type { AnyExpr, AnyQuery, OrderTerm, Predicate } from "foldkit-entity";
import { fail } from "./kernel.ts";

export type SqlDialect = "sqlite";
export type SqlKind = "string" | "number" | "boolean";

export interface SqlColumn {
  readonly field: string;
  readonly column: string;
  readonly kind: SqlKind;
  readonly nullable: boolean;
}
/** A `one` relation: the owner's foreign-key column, read back as `Target:id` refs. */
export interface SqlRelation {
  readonly field: string;
  readonly column: string;
  readonly target: string;
  readonly nullable: boolean;
}
export interface SqlStorage {
  readonly entity: string;
  readonly table: string;
  readonly id: string;
  readonly columns: ReadonlyArray<SqlColumn>;
  readonly relations: ReadonlyArray<SqlRelation>;
}

/** The parts of a Drizzle column a plan needs (`foldkit-remote-drizzle` binding columns). */
interface ColumnLike {
  readonly name: string;
  readonly dataType: string;
  readonly notNull: boolean;
}
/** The parts of an `EntityBinding` storage extraction reads; read structurally. */
export interface BindingLike {
  readonly name: string;
  readonly table: object;
  readonly columns: Readonly<Record<string, ColumnLike>>;
  readonly relations: Readonly<
    Record<string, { readonly kind: string; readonly field?: unknown; readonly entity?: unknown }>
  >;
  readonly computed?: Readonly<Record<string, unknown>>;
  readonly visible?: unknown;
}

const unsupported = (path: string, message: string) =>
  fail("SQL_UNSUPPORTED", "sql", path, message);
// `getTableName` reads this symbol; reading it directly keeps drizzle-orm a build-time-only peer.
const TableName = Symbol.for("drizzle:Name");
const KINDS: Readonly<Record<string, SqlKind>> = {
  string: "string",
  number: "number",
  boolean: "boolean",
};

// Drizzle 1.0 data types name the kind first (`number int53`, `number double`, `string`).
const kindOf = (column: ColumnLike, path: string): SqlKind => {
  const kind = KINDS[column.dataType.split(" ")[0]];
  if (!kind)
    throw unsupported(
      path,
      `Column type ${column.dataType} is outside the string/number/boolean profile`,
    );
  return kind;
};
const tableNameOf = (table: object, path: string): string => {
  const name: unknown = Reflect.get(table, TableName);
  if (typeof name !== "string" || name.length === 0)
    throw unsupported(path, "Expected a Drizzle table");
  return name;
};
const columnOf = (value: unknown): ColumnLike | undefined =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "name") === "string" &&
  typeof Reflect.get(value, "dataType") === "string" &&
  typeof Reflect.get(value, "notNull") === "boolean"
    ? (value as ColumnLike)
    : undefined;

/**
 * Static storage of one binding (SQLX-003). Callbacks are arbitrary Drizzle SQL, so `visible`,
 * computed members and relations other than an owner's `one` are refused rather than guessed.
 */
export const storageOf = (binding: BindingLike): SqlStorage => {
  const at = `storage.${binding.name}`;
  if (binding.visible !== undefined)
    throw unsupported(`${at}.visible`, "visible is a Drizzle SQL callback; it is not native yet");
  if (binding.computed && Object.keys(binding.computed).length > 0)
    throw unsupported(`${at}.computed`, "Computed members are not native yet");
  const table = tableNameOf(binding.table, `${at}.table`);
  const columns = Object.entries(binding.columns).map(([field, column]): SqlColumn => ({
    field,
    column: column.name,
    kind: kindOf(column, `${at}.${field}`),
    nullable: !column.notNull,
  }));
  const id = columns.find((column) => column.field === "id");
  if (!id || id.nullable)
    throw unsupported(`${at}.id`, "A Remote entity needs a non-null id column");
  const relations = Object.entries(binding.relations).map(([field, relation]): SqlRelation => {
    if (relation.kind !== "one")
      throw unsupported(`${at}.${field}`, `${relation.kind} relations are not native yet`);
    // The foreign key is the column itself, or its key on the table.
    const column =
      columnOf(relation.field) ??
      (typeof relation.field === "string"
        ? columnOf(Reflect.get(binding.table, relation.field))
        : undefined);
    const target: unknown =
      typeof relation.entity === "object" && relation.entity !== null
        ? Reflect.get(relation.entity, "name")
        : undefined;
    if (!column || typeof target !== "string")
      throw unsupported(`${at}.${field}`, "Expected a foreign-key column and a target entity");
    return { field, column: column.name, target, nullable: !column.notNull };
  });
  return { entity: binding.name, table, id: id.column, columns, relations };
};

/** A statement parameter, bound per request in placeholder order. */
export type SqlParam =
  | { readonly _tag: "Input"; readonly key: string }
  | { readonly _tag: "Literal"; readonly value: string | number | boolean | null }
  /** `%escaped%` built at bind time from a search value, as upstream's `escapeLike` does. */
  | { readonly _tag: "Pattern"; readonly search: SqlParam }
  /** The cursor row's value for order term `index` (keyset). */
  | { readonly _tag: "Cursor"; readonly index: number }
  | { readonly _tag: "CursorId" }
  | { readonly _tag: "Limit" };
export interface SqlStatement {
  readonly sql: string;
  readonly params: ReadonlyArray<SqlParam>;
}
export interface SqlOrder {
  readonly column: string;
  readonly direction: "asc" | "desc";
  readonly kind: SqlKind;
}
export interface QueryPlan {
  readonly dialect: SqlDialect;
  readonly query: string;
  readonly entity: string;
  readonly order: ReadonlyArray<SqlOrder>;
  /** The cursor row's ordering tuple, under the same base `where`. */
  readonly cursorRow: SqlStatement;
  readonly forward: SqlStatement;
  readonly forwardAfter: SqlStatement;
  readonly backward: SqlStatement;
  readonly backwardBefore: SqlStatement;
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Collects parameters for one statement, numbering placeholders `?1`, `?2`, … (SQLite). */
class Params {
  readonly list: SqlParam[] = [];
  add(param: SqlParam): string {
    this.list.push(param);
    return `?${this.list.length}`;
  }
}

/**
 * Compile a `Query.define` body against its entity's storage (SQLX-005). The lowering is
 * upstream's: `eq` (a predicate compared to a literal boolean folds to it or its negation, flipping
 * a `Null` instead of negating), `isNull`/`isNotNull`, and `contains` as
 * `lower(x) like lower(%escaped%) escape '\'`. Ordering is plain fields with the id appended.
 */
export const planQuery = (
  name: string,
  body: AnyQuery,
  storage: SqlStorage,
  dialect: SqlDialect = "sqlite",
): QueryPlan => {
  const at = `queries.${name}`;
  if (body.entity.name !== storage.entity)
    throw unsupported(
      at,
      `The body reads ${body.entity.name}, but the storage is ${storage.entity}`,
    );
  const columnFor = (key: string, path: string): SqlColumn => {
    const column = storage.columns.find((candidate) => candidate.field === key);
    if (!column) throw unsupported(path, `${storage.entity}.${key} has no column`);
    return column;
  };
  const operand = (expr: AnyExpr, params: Params, path: string): string =>
    Match.value(expr).pipe(
      Match.tagsExhaustive({
        Field: (field) => {
          if (field.owner.name !== storage.entity)
            throw unsupported(path, `The body reads ${field.owner.name}.${field.key}`);
          return quote(columnFor(field.key, path).column);
        },
        Literal: (literal) => {
          const value: unknown = literal.value;
          if (value !== null && !["string", "number", "boolean"].includes(typeof value))
            throw unsupported(path, "Literals are strings, numbers, booleans or null");
          if (typeof value === "number" && !Number.isFinite(value))
            throw unsupported(path, "Number literals are finite");
          return params.add({ _tag: "Literal", value: value as string | number | boolean | null });
        },
        Input: (input) => params.add({ _tag: "Input", key: input.key }),
      }),
    );
  const predicate = (node: Predicate, params: Params, path: string): string =>
    Match.value(node).pipe(
      Match.tagsExhaustive({
        Eq: (eq) => {
          const [asked, against] = isPredicate(eq.left)
            ? [eq.left, eq.right]
            : isPredicate(eq.right)
              ? [eq.right, eq.left]
              : [undefined, undefined];
          if (asked !== undefined && against !== undefined) {
            if (isPredicate(against) || against._tag === "Field")
              throw unsupported(
                path,
                "A predicate is compared with a boolean, not a column or predicate",
              );
            // Upstream folds per request: true is the predicate, false its negation (a `Null`
            // flips instead of negating), anything else an equality that is unknown.
            const negated = () =>
              Match.value(asked).pipe(
                Match.tag("Null", (isNull) =>
                  predicate({ ...isNull, present: !isNull.present }, params, path),
                ),
                Match.orElse((other) => `NOT (${predicate(other, params, path)})`),
              );
            if (against._tag === "Literal") {
              if (typeof against.value !== "boolean")
                throw unsupported(path, "A predicate is compared with a boolean");
              return against.value ? predicate(asked, params, path) : negated();
            }
            const value = params.add({ _tag: "Input", key: against.key });
            return `CASE ${value} WHEN 1 THEN (${predicate(asked, params, path)}) WHEN 0 THEN (${negated()}) END`;
          }
          if (isPredicate(eq.left) || isPredicate(eq.right))
            throw unsupported(path, "Comparing two predicates is not native yet");
          return `${operand(eq.left as AnyExpr, params, `${path}.left`)} = ${operand(eq.right as AnyExpr, params, `${path}.right`)}`;
        },
        Null: (isNull) =>
          `${operand(isNull.operand, params, `${path}.operand`)} IS ${isNull.present ? "NOT NULL" : "NULL"}`,
        Contains: (contains) => {
          if (isPredicate(contains.search)) throw unsupported(path, "A search is a scalar");
          const search = contains.search;
          const source: SqlParam = Match.value(search).pipe(
            Match.tagsExhaustive({
              Literal: (literal): SqlParam => {
                if (literal.value !== null && typeof literal.value !== "string")
                  throw unsupported(path, "A search is text");
                return { _tag: "Literal", value: literal.value as string | null };
              },
              Input: (input): SqlParam => ({ _tag: "Input", key: input.key }),
              Field: (): SqlParam => {
                throw unsupported(path, "Searching for a column's value is not native yet");
              },
            }),
          );
          const value = operand(contains.value, params, `${path}.value`);
          return `lower(${value}) LIKE lower(${params.add({ _tag: "Pattern", search: source })}) ESCAPE '\\'`;
        },
      }),
    );
  const order: SqlOrder[] = body.orderBy.map((term: OrderTerm, i) => {
    const path = `${at}.orderBy[${i}]`;
    if (term.expr._tag !== "Field") throw unsupported(path, "Ordering is by plain fields");
    if (term.expr.owner.name !== storage.entity)
      throw unsupported(path, `The body orders by ${term.expr.owner.name}.${term.expr.key}`);
    const column = columnFor(term.expr.key, path);
    // Upstream's keyset predicate assumes Postgres NULL placement, which SQLite does not use.
    if (column.nullable)
      throw unsupported(
        path,
        `Ordering by nullable ${storage.entity}.${column.field} is not native yet`,
      );
    return { column: column.column, direction: term.direction, kind: column.kind };
  });
  if (order.length === 0)
    throw unsupported(at, "A connection pages on a stable order; give the body one");
  if (!order.some((term) => term.column === storage.id))
    order.push({ column: storage.id, direction: "asc", kind: "string" });

  const where = (params: Params): string[] =>
    body.where.map((node, i) => predicate(node, params, `${at}.where[${i}]`));
  const from = `FROM ${quote(storage.table)}`;
  const conditions = (parts: string[]) =>
    parts.length ? ` WHERE ${parts.map((part) => `(${part})`).join(" AND ")}` : "";
  const keyset = (traversal: "forward" | "backward", params: Params): string =>
    order
      .map((term, i) => {
        const equalities = order
          .slice(0, i)
          .map(
            (previous, j) =>
              `${quote(previous.column)} = ${params.add({ _tag: "Cursor", index: j })}`,
          );
        const after = (term.direction === "asc") === (traversal === "forward") ? ">" : "<";
        const branch = `${quote(term.column)} ${after} ${params.add({ _tag: "Cursor", index: i })}`;
        return `(${[...equalities, branch].join(" AND ")})`;
      })
      .join(" OR ");
  const orderBy = (traversal: "forward" | "backward") =>
    ` ORDER BY ${order
      .map(
        (term) =>
          `${quote(term.column)} ${(term.direction === "asc") === (traversal === "forward") ? "ASC" : "DESC"}`,
      )
      .join(", ")}`;
  const page = (traversal: "forward" | "backward", cursor: boolean): SqlStatement => {
    const params = new Params();
    const parts = where(params);
    if (cursor) parts.push(keyset(traversal, params));
    const sql = `SELECT ${quote(storage.id)} ${from}${conditions(parts)}${orderBy(traversal)} LIMIT ${params.add({ _tag: "Limit" })}`;
    return { sql, params: params.list };
  };
  const cursorRow = (() => {
    const params = new Params();
    const parts = where(params);
    parts.push(`${quote(storage.id)} = ${params.add({ _tag: "CursorId" })}`);
    return {
      sql: `SELECT ${order.map((term) => quote(term.column)).join(", ")} ${from}${conditions(parts)} LIMIT 1`,
      params: params.list,
    };
  })();
  return {
    dialect,
    query: name,
    entity: storage.entity,
    order,
    cursorRow,
    forward: page("forward", false),
    forwardAfter: page("forward", true),
    backward: page("backward", false),
    backwardBefore: page("backward", true),
  };
};

/** Upstream's `escapeLike`: `\`, `%` and `_` are escaped with a backslash. */
export const likePattern = (search: string): string =>
  `%${search.replace(/[\\%_]/g, (found) => `\\${found}`)}%`;
