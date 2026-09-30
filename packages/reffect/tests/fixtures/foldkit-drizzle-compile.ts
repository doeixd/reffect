// Test-only upstream snapshot at f98f4d5cbaebb7aecf2ec636dd198fae01db5b1c.
/* oxlint-disable typescript/no-redundant-type-constituents -- Preserve upstream declarations. */
// Only the cursor type import is replaced; see FOLDKIT-LICENSE and research/foldkit-query.md.
/**
 * Compiles a query's body — the source-neutral `Expr` value a
 * `Query.define` carries — into the Drizzle `where` and `orderBy` this
 * package already runs.
 *
 * The body says what the query means; this says what that means *here*. A
 * binding knows which column holds which field, so nothing in the body names a
 * table, and the same body can be compiled by something else entirely.
 *
 * What this does not do is decide what a principal may see. A compiled `where`
 * is conjoined with the binding's own `visible` rule by the caller, exactly as
 * a hand-written one is: a query body is the application's question, never its
 * authorization.
 */
import { eq, isNotNull, isNull, not, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { Query, isPredicate } from "foldkit-entity";
import type {
  AnyExpr,
  AnyQuery,
  EqPredicate,
  OrderTerm as ExprOrderTerm,
  Operandish,
  Operation,
  Predicate,
} from "foldkit-entity";
interface OrderTerm {
  readonly column: AnyColumn;
  readonly direction: "asc" | "desc";
}

/** What a binding has to offer to be compiled against: a column per field key. */
export interface CompileTarget {
  readonly columns: Record<string, AnyColumn>;
}

export class QueryCompileError extends Error {
  constructor(message: string) {
    super(`[foldkit-remote-drizzle] ${message}`);
    this.name = "QueryCompileError";
  }
}

const columnFor = (target: CompileTarget, key: string, query: string): AnyColumn => {
  const column = target.columns[key];
  if (column === undefined) {
    throw new QueryCompileError(
      `query "${query}" reads the field "${key}", which the binding has no column for`,
    );
  }
  return column;
};

/**
 * The value an operand contributes. A field is a column; a literal is itself;
 * an input is whatever this request was given, read by the key the placeholder
 * was built with.
 */
const operand = (
  node: AnyExpr,
  target: CompileTarget,
  input: Readonly<Record<string, unknown>>,
  query: string,
): AnyColumn | unknown => {
  switch (node._tag) {
    case "Field":
      return columnFor(target, node.key, query);
    case "Literal":
      return node.value;
    case "Input":
      return input[node.key];
  }
};

/** A predicate used as a value: `(archived_at is not null) = ?` compares one. */
const side = (
  node: Operandish,
  target: CompileTarget,
  input: Readonly<Record<string, unknown>>,
  query: string,
): AnyColumn | SQL | unknown =>
  isPredicate(node) ? predicate(node, target, input, query) : operand(node, target, input, query);

/** `%` and `_` are wildcards, so text searched for has to say it means them literally. */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (found) => `\\${found}`);

/**
 * `eq(somePredicate, aBoolean)` asked directly: the predicate when the boolean
 * is true, and its negation when false. `undefined` when this comparison is not
 * of that shape, which leaves it to ordinary equality.
 *
 * A `Null` negates by flipping which answer absence gives, so the SQL stays
 * `is null` / `is not null` rather than `not (… is not null)`.
 */
const truthComparison = (
  node: EqPredicate,
  target: CompileTarget,
  input: Readonly<Record<string, unknown>>,
  query: string,
): SQL | undefined => {
  const [asked, against] = isPredicate(node.left)
    ? [node.left, node.right]
    : isPredicate(node.right)
      ? [node.right, node.left]
      : [undefined, undefined];
  if (asked === undefined || against === undefined || isPredicate(against)) return undefined;
  const value = operand(against, target, input, query);
  if (typeof value !== "boolean") return undefined;
  if (value) return predicate(asked, target, input, query);
  if (asked._tag === "Null") {
    return predicate({ ...asked, present: !asked.present }, target, input, query);
  }
  return not(predicate(asked, target, input, query));
};

const predicate = (
  node: Predicate,
  target: CompileTarget,
  input: Readonly<Record<string, unknown>>,
  query: string,
): SQL => {
  switch (node._tag) {
    case "Eq": {
      // A predicate compared to a boolean is that predicate, or its negation.
      // The value is known here — this runs per request, with the input in
      // hand — so it is settled now rather than sent to the database as a
      // boolean parameter, which dialects disagree about even having. The SQL
      // is then exactly what a hand-written `archived ? isNotNull : isNull`
      // produced, which is the point.
      const asked = truthComparison(node, target, input, query);
      if (asked !== undefined) return asked;
      const left = side(node.left, target, input, query);
      const right = side(node.right, target, input, query);
      // Drizzle's `eq` wants a column or expression on the left; a body may
      // compare either way round, and equality does not care. Normalising keeps
      // the generated SQL the shape a binding would have been written in.
      return isPredicate(node.left) || node.left._tag === "Field"
        ? eq(left as AnyColumn, right)
        : eq(right as AnyColumn, left);
    }
    case "Null": {
      const column = operand(node.operand, target, input, query) as AnyColumn;
      return node.present ? isNotNull(column) : isNull(column);
    }
    case "Contains": {
      const column = operand(node.value, target, input, query) as AnyColumn;
      const search = side(node.search, target, input, query);
      // Preserve unknown under a surrounding boolean comparison or negation.
      if (search === null) return sql`null`;
      if (typeof search !== "string") {
        throw new QueryCompileError(`query "${query}" searches for something that is not text`);
      }
      // Folded on both sides rather than left to `like`, which is
      // case-insensitive in SQLite and case-sensitive in Postgres: a query body
      // that means two things by dialect is the thing this package exists to
      // stop. `lower` is ASCII-only in SQLite without ICU, which is the limit
      // `Expr.contains` documents.
      return sql`lower(${column}) like lower(${`%${escapeLike(search)}%`}) escape '\\'`;
    }
  }
};

/**
 * The operations this compiler turns into SQL. Declared rather than implied by
 * which cases `predicate` happens to handle, so a body needing something else
 * is refused with a name instead of falling through.
 */
export const supported: ReadonlyArray<Operation> = ["eq", "isNull", "isNotNull", "contains"];

/**
 * Every field the body reads has a column here, and every operation it needs is
 * one this compiler runs. Checked once, when the source is registered, so a
 * server that starts is a server whose queries can be answered — rather than
 * one that fails on whichever request first runs this query. Ordering is
 * checked by compiling it, which happens at registration for the same reason.
 */
export const checkFields = (body: AnyQuery, target: CompileTarget, query: string): void => {
  const missing = Query.unsupported(body, supported);
  if (missing.length > 0) {
    throw new QueryCompileError(
      `query "${query}" needs ${missing.join(", ")}, which this compiler does not run`,
    );
  }
  for (const field of Query.dependencies(body).fields) columnFor(target, field.key, query);
};

/**
 * The body's predicates, as the SQL fragments this request needs. Each is
 * separate: the caller conjoins them with whatever else applies, so a body
 * cannot escape the binding's visibility rule by being one big expression.
 */
export const compileWhere = (
  body: AnyQuery,
  target: CompileTarget,
  input: Readonly<Record<string, unknown>>,
  query: string,
): ReadonlyArray<SQL> => body.where.map((node) => predicate(node, target, input, query));

/** The body's ordering, as this package's order terms. */
export const compileOrderBy = (
  body: AnyQuery,
  target: CompileTarget,
  query: string,
): ReadonlyArray<OrderTerm> =>
  body.orderBy.map((term: ExprOrderTerm) => {
    if (term.expr._tag !== "Field") {
      throw new QueryCompileError(
        `query "${query}" orders by something that is not a field, which this compiler cannot run yet`,
      );
    }
    return { column: columnFor(target, term.expr.key, query), direction: term.direction };
  });
