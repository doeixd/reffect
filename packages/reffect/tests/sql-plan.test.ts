import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import type { Layer } from "effect";
import { drizzle as drizzleSqlite } from "drizzle-orm/node-sqlite";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import {
  boolean as pgBoolean,
  integer as pgInteger,
  pgTable,
  real as pgReal,
  text as pgText,
} from "drizzle-orm/pg-core";
import { Entity, Expr, Order } from "foldkit-entity";
import type { AnyQuery } from "foldkit-entity";
import { Query } from "foldkit-remote";
import { cases, Subject, rows as subjectRows } from "foldkit-entity/conformance";
import { bind, databaseLayer, entity, query } from "foldkit-remote-drizzle";
import type { DrizzleDatabase } from "foldkit-remote-drizzle";
import type pg from "pg";
import { expect, test } from "vite-plus/test";
import { likePattern, planQuery, storageOf } from "../src/sql-plan.ts";
import type { QueryPlan, SqlDialect, SqlParam, SqlStatement } from "../src/sql-plan.ts";
import { postgresServer, postgresUnavailable } from "./fixtures/postgres.ts";

// SQLX-005, SQLX-009: the planned SQL, run on each dialect, against upstream's own Drizzle query
// source over the same database: the full order, then every cursor both ways.
type Row = Readonly<Record<string, unknown>>;
interface Context {
  readonly input: Row;
  readonly cursor?: ReadonlyArray<unknown>;
  readonly cursorId?: string;
}
/** A seeded database that runs planned statements with parameters bound as its JS driver does. */
interface Database {
  readonly execute: (statement: SqlStatement, context: Context) => Promise<ReadonlyArray<Row>>;
  readonly layer: Layer.Layer<DrizzleDatabase>;
}
const paramValues = (dialect: SqlDialect, statement: SqlStatement, context: Context) => {
  // node:sqlite has no boolean; node-postgres sends one as text that Postgres reads as boolean.
  const sqlValue = (value: unknown) =>
    typeof value === "boolean" && dialect === "sqlite" ? (value ? 1 : 0) : value;
  const value = (param: SqlParam): unknown => {
    switch (param._tag) {
      case "Input":
        return sqlValue(context.input[param.key] ?? null);
      case "Literal":
        return sqlValue(param.value);
      case "Pattern": {
        const search = value(param.search);
        return typeof search === "string" ? likePattern(search) : null;
      }
      case "Cursor":
        return sqlValue(context.cursor?.[param.index] ?? null);
      case "CursorId":
        return context.cursorId ?? null;
      case "Limit":
        return 1000;
    }
  };
  return statement.params.map(value);
};
interface Table {
  readonly name: string;
  readonly ddl: { readonly sqlite: string; readonly postgres: string };
  readonly rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>;
}
const sqliteDatabase = (table: Table): Database => {
  const db = new DatabaseSync(":memory:");
  db.exec(table.ddl.sqlite);
  for (const row of table.rows)
    db.prepare(`insert into ${table.name} values (${row.map(() => "?").join(", ")})`).run(
      ...row.map((value) => (typeof value === "boolean" ? Number(value) : value)),
    );
  return {
    execute: async (statement, context) =>
      db
        .prepare(statement.sql)
        .all(
          ...(paramValues("sqlite", statement, context) as Array<string | number | null>),
        ) as ReadonlyArray<Row>,
    layer: databaseLayer(drizzleSqlite({ client: db })),
  };
};
const postgresDatabase = async (pool: pg.Pool, table: Table): Promise<Database> => {
  await pool.query(table.ddl.postgres);
  for (const row of table.rows)
    await pool.query(
      `insert into ${table.name} values (${row.map((_, i) => `$${i + 1}`).join(", ")})`,
      [...row],
    );
  return {
    execute: async (statement, context) =>
      (await pool.query(statement.sql, paramValues("postgres", statement, context))).rows,
    layer: databaseLayer(drizzlePostgres({ client: pool })),
  };
};
/** Runs `body` with a database of `table` in the dialect; a Postgres container lives for the call. */
const withDatabase = (
  dialect: SqlDialect,
  table: Table,
  body: (db: Database) => Promise<void>,
): Promise<void> =>
  dialect === "sqlite"
    ? body(sqliteDatabase(table))
    : Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const server = yield* postgresServer;
            const pool = yield* server.database(table.name);
            const db = yield* Effect.promise(() => postgresDatabase(pool, table));
            yield* Effect.promise(() => body(db));
          }),
        ),
      );
const ids = (rows: ReadonlyArray<Row>) => rows.map((row) => String(row.id));

/** The planned order and every keyset page, compared with upstream's query source. */
const agree = async (
  db: Database,
  plan: QueryPlan,
  source: ReturnType<typeof query>,
  input: Row,
  label: string,
) => {
  const upstream = (window: Record<string, unknown>) =>
    Effect.runPromise(
      source.run({ input, window, principal: undefined } as never).pipe(Effect.provide(db.layer)),
    ).then((page) => page.edges.map((edge: { readonly id: string }) => edge.id));
  const full = ids(await db.execute(plan.forward, { input }));
  expect(full, `${label} forward`).toEqual(await upstream({ first: 100 }));
  expect(
    [...ids(await db.execute(plan.backward, { input }))].reverse(),
    `${label} backward`,
  ).toEqual(await upstream({ last: 100 }));
  for (const id of full) {
    const cursorRow = (await db.execute(plan.cursorRow, { input, cursorId: id }))[0];
    const cursor = plan.order.map((term) => cursorRow[term.column]);
    expect(
      ids(await db.execute(plan.forwardAfter, { input, cursor })),
      `${label} after ${id}`,
    ).toEqual(await upstream({ first: 100, after: id }));
    expect(
      [...ids(await db.execute(plan.backwardBefore, { input, cursor }))].reverse(),
      `${label} before ${id}`,
    ).toEqual(await upstream({ last: 100, before: id }));
  }
  return full;
};

const postgresFolding = new Set([
  "contains folds ASCII letters only: an accented capital does not match its lowercase",
]);
const dialects = [
  { dialect: "sqlite" as const, unavailable: undefined },
  { dialect: "postgres" as const, unavailable: postgresUnavailable },
];
// Starting a container dominates the Postgres runs.
const budget = 180000;

const subjects: Table = {
  name: "subjects",
  ddl: {
    sqlite:
      "create table subjects (id text primary key not null, label text not null, rank integer not null, tag text, at text not null)",
    postgres:
      "create table subjects (id text primary key not null, label text not null, rank integer not null, tag text, at text not null)",
  },
  rows: subjectRows.map((row) => [row.id, row.label, row.rank, row.tag, row.at]),
};
const subjectTables = {
  sqlite: sqliteTable("subjects", {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    rank: integer("rank").notNull(),
    tag: text("tag"),
    at: text("at").notNull(),
  }),
  postgres: pgTable("subjects", {
    id: pgText("id").primaryKey(),
    label: pgText("label").notNull(),
    rank: pgInteger("rank").notNull(),
    tag: pgText("tag"),
    at: pgText("at").notNull(),
  }),
};

for (const { dialect, unavailable } of dialects)
  test.skipIf(unavailable !== undefined)(
    `the shared Query conformance cases agree with upstream's Drizzle source over ${dialect}`,
    () =>
      withDatabase(dialect, subjects, async (db) => {
        // As upstream's own conformance test binds it.
        const binding = entity("Subject", subjectTables[dialect]);
        const storage = storageOf(binding, dialect);
        const refused: string[] = [];
        let compared = 0;
        for (const testCase of cases) {
          let plan: QueryPlan;
          try {
            plan = planQuery(testCase.what, testCase.body as AnyQuery, storage, dialect);
          } catch (error) {
            refused.push(`${testCase.what}: ${(error as Error).message}`);
            continue;
          }
          const descriptor = {
            ...Query.make(testCase.what, { Input: {}, Result: Query.connection(Subject) }),
            body: testCase.body,
          };
          const source = query(descriptor, { entity: binding });
          const full = await agree(db, plan, source, testCase.input as Row, testCase.what);
          // Upstream's Postgres SQL folds `contains` with `lower()`, by the database collation,
          // while its evaluator folds ASCII only (foldkit-entity 0.7.0). Native follows the
          // Drizzle source (SQLX-002); this fails once upstream makes the two agree.
          if (dialect === "postgres" && postgresFolding.has(testCase.what))
            expect(full, testCase.what).not.toEqual(testCase.expected);
          else expect(full, testCase.what).toEqual(testCase.expected);
          compared++;
        }
        // Every shared case is inside the profile: its inputs are already wire-shaped primitives.
        expect(refused).toEqual([]);
        expect(compared).toBe(cases.length);
      }),
    budget,
  );

// Many ties, so the appended id and the keyset carry the order.
const projectTables = {
  sqlite: sqliteTable("projects", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    status: text("status").notNull(),
    rank: integer("rank").notNull(),
    done: integer("done", { mode: "boolean" }).notNull(),
    note: text("note"),
  }),
  postgres: pgTable("projects", {
    id: pgText("id").primaryKey(),
    name: pgText("name").notNull(),
    status: pgText("status").notNull(),
    rank: pgInteger("rank").notNull(),
    done: pgBoolean("done").notNull(),
    note: pgText("note"),
  }),
};
const Project = Entity.define(
  "Project",
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    status: Schema.String,
    rank: Schema.Number,
    done: Schema.Boolean,
    note: Schema.NullOr(Schema.String),
  }),
);
const projectBindings = {
  sqlite: bind({ Project }, { Project: { table: projectTables.sqlite } }).Project,
  postgres: bind({ Project }, { Project: { table: projectTables.postgres } }).Project,
};
const projects: Table = {
  name: "projects",
  ddl: {
    sqlite:
      "create table projects (id text primary key not null, name text not null, status text not null, rank integer not null, done integer not null, note text)",
    postgres:
      "create table projects (id text primary key not null, name text not null, status text not null, rank integer not null, done boolean not null, note text)",
  },
  rows: Array.from({ length: 23 }, (_, i) => [
    `p${String(i).padStart(2, "0")}`,
    ["Apollo", "borealis", "Ceres", "apollo", "Éclipse", "a_b", "50%"][i % 7],
    ["active", "draft", "archived"][i % 3],
    i % 4,
    i % 5 === 0,
    i % 6 === 0 ? null : `note ${i}`,
  ]),
};

for (const { dialect, unavailable } of dialects)
  test.skipIf(unavailable !== undefined)(
    `ties, both directions, booleans, searches and null checks agree with upstream over ${dialect}`,
    () =>
      withDatabase(dialect, projects, async (db) => {
        const binding = projectBindings[dialect];
        const storage = storageOf(binding, dialect);
        const status = Expr.input("status", Schema.String);
        const search = Expr.input("search", Schema.String);
        const open = Expr.input("open", Schema.Boolean);
        const bodies: ReadonlyArray<readonly [string, AnyQuery, ReadonlyArray<Row>]> = [
          [
            "rank then id",
            Query.from(Project).pipe(Query.orderBy(Order.asc(Project.fields.rank))),
            [{}],
          ],
          [
            "status, rank descending, name",
            Query.from(Project).pipe(
              Query.where(Expr.eq(Project.fields.status, status)),
              Query.orderBy(Order.desc(Project.fields.rank), Order.asc(Project.fields.name)),
            ),
            [{ status: "active" }, { status: "draft" }, { status: "missing" }],
          ],
          [
            "search by name",
            Query.from(Project).pipe(
              Query.where(Expr.contains(Project.fields.name, search)),
              Query.orderBy(Order.asc(Project.fields.name)),
            ),
            [
              { search: "APOLLO" },
              { search: "éCLIPSE" },
              { search: "_" },
              { search: "%" },
              { search: "" },
              { search: null },
            ],
          ],
          [
            "done literal and a note check folded by an input",
            Query.from(Project).pipe(
              Query.where(
                Expr.eq(Project.fields.done, true),
                Expr.eq(Expr.isNull(Project.fields.note), open),
              ),
              Query.orderBy(Order.desc(Project.fields.name)),
            ),
            [{ open: true }, { open: false }, { open: null }],
          ],
        ];
        const found = new Map<string, ReadonlyArray<string>>();
        for (const [label, body, inputs] of bodies) {
          const plan = planQuery(label, body, storage, dialect);
          const descriptor = {
            ...Query.make(label, { Input: {}, Result: Query.connection(Project) }),
            body,
          };
          const source = query(descriptor, { entity: binding });
          for (const input of inputs) {
            const key = `${label} ${JSON.stringify(input)}`;
            found.set(key, await agree(db, plan, source, input, key));
          }
        }
        // The paths are really reached: folding, wildcards as text, and a non-ASCII search, which
        // only Postgres folds (SQLX-013).
        expect(found.get('search by name {"search":"APOLLO"}')).toHaveLength(7);
        expect(found.get('search by name {"search":"_"}')).toEqual(["p05", "p12", "p19"]);
        expect(found.get('search by name {"search":null}')).toEqual([]);
        expect(found.get('search by name {"search":"éCLIPSE"}')).toEqual(
          dialect === "postgres" ? ["p04", "p11", "p18"] : [],
        );
        const folded = (open: unknown) =>
          found.get(`done literal and a note check folded by an input ${JSON.stringify({ open })}`);
        expect(folded(true)).toEqual(["p00"]);
        expect(folded(false)).toHaveLength(4);
        expect(folded(null)).toEqual([]);
      }),
    budget,
  );

test("storage and bodies outside the native profile are refused while compiling", () => {
  const binding = projectBindings.sqlite;
  const nullableOrder = Query.from(Project).pipe(Query.orderBy(Order.asc(Project.fields.note)));
  expect(() => planQuery("nullable", nullableOrder, storageOf(binding))).toThrow(
    "Ordering by nullable Project.note",
  );
  const unordered = Query.from(Project);
  expect(() => planQuery("unordered", unordered, storageOf(binding))).toThrow("stable order");
  const hidden = entity("Hidden", projectTables.sqlite, { visible: () => undefined });
  expect(() => storageOf(hidden)).toThrow("visible");
  // Each dialect admits its own column types only (SQLX-010).
  expect(() => storageOf(projectBindings.postgres)).toThrow("outside the sqlite");
  expect(() => storageOf(binding, "postgres")).toThrow("outside the postgres");
  const floats = pgTable("floats", { id: pgText("id").primaryKey(), x: pgReal("x") });
  expect(() => storageOf(entity("Floats", floats), "postgres")).toThrow("PgReal");
});
