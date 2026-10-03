import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import { drizzle } from "drizzle-orm/node-sqlite";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { Entity, Expr, Order } from "foldkit-entity";
import type { AnyQuery } from "foldkit-entity";
import { Query } from "foldkit-remote";
import { cases, Subject, rows as subjectRows } from "foldkit-entity/conformance";
import { bind, databaseLayer, entity, query } from "foldkit-remote-drizzle";
import { expect, test } from "vite-plus/test";
import { likePattern, planQuery, storageOf } from "../src/sql-plan.ts";
import type { QueryPlan, SqlParam, SqlStatement } from "../src/sql-plan.ts";

// SQLX-005: the planned SQL, run on node:sqlite, against upstream's own Drizzle query source over
// the same database: the full order, then every cursor both ways.
type Row = Readonly<Record<string, unknown>>;
type Value = string | number | null;
const sqlValue = (value: unknown): Value =>
  typeof value === "boolean" ? (value ? 1 : 0) : (value as Value);

const execute = (
  db: DatabaseSync,
  statement: SqlStatement,
  context: {
    readonly input: Row;
    readonly cursor?: ReadonlyArray<unknown>;
    readonly cursorId?: string;
  },
): ReadonlyArray<Row> => {
  const value = (param: SqlParam): Value => {
    switch (param._tag) {
      case "Input":
        return sqlValue(context.input[param.key] ?? null);
      case "Literal":
        return sqlValue(param.value);
      case "Pattern": {
        const search = value(param.search);
        return search === null ? null : likePattern(String(search));
      }
      case "Cursor":
        return sqlValue(context.cursor?.[param.index] ?? null);
      case "CursorId":
        return context.cursorId ?? null;
      case "Limit":
        return 1000;
    }
  };
  return db.prepare(statement.sql).all(...statement.params.map(value)) as ReadonlyArray<Row>;
};
const ids = (rows: ReadonlyArray<Row>) => rows.map((row) => String(row.id));

/** The planned order and every keyset page, compared with upstream's query source. */
const agree = async (
  db: DatabaseSync,
  plan: QueryPlan,
  source: ReturnType<typeof query>,
  input: Row,
  label: string,
) => {
  const upstream = (window: Record<string, unknown>) =>
    Effect.runPromise(
      source
        .run({ input, window, principal: undefined } as never)
        .pipe(Effect.provide(databaseLayer(drizzle({ client: db })))),
    ).then((page) => page.edges.map((edge: { readonly id: string }) => edge.id));
  const full = ids(execute(db, plan.forward, { input }));
  expect(full, `${label} forward`).toEqual(await upstream({ first: 100 }));
  expect([...ids(execute(db, plan.backward, { input }))].reverse(), `${label} backward`).toEqual(
    await upstream({ last: 100 }),
  );
  for (const id of full) {
    const cursorRow = execute(db, plan.cursorRow, { input, cursorId: id })[0];
    const cursor = plan.order.map((term) => cursorRow[term.column]);
    expect(ids(execute(db, plan.forwardAfter, { input, cursor })), `${label} after ${id}`).toEqual(
      await upstream({ first: 100, after: id }),
    );
    expect(
      [...ids(execute(db, plan.backwardBefore, { input, cursor }))].reverse(),
      `${label} before ${id}`,
    ).toEqual(await upstream({ last: 100, before: id }));
  }
  return full;
};

test("the shared Query conformance cases agree with upstream's Drizzle source over SQLite", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "create table subjects (id text primary key not null, label text not null, rank integer not null, tag text, at text not null)",
  );
  for (const row of subjectRows)
    db.prepare("insert into subjects values (?, ?, ?, ?, ?)").run(
      row.id,
      row.label,
      row.rank,
      row.tag,
      row.at,
    );
  const subjects = sqliteTable("subjects", {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    rank: integer("rank").notNull(),
    tag: text("tag"),
    at: text("at").notNull(),
  });
  // As upstream's own conformance test binds it.
  const binding = entity("Subject", subjects);
  const storage = storageOf(binding);
  const refused: string[] = [];
  let compared = 0;
  for (const testCase of cases) {
    let plan: QueryPlan;
    try {
      plan = planQuery(testCase.what, testCase.body as AnyQuery, storage);
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
    expect(full, testCase.what).toEqual(testCase.expected);
    compared++;
  }
  // Every shared case is inside the profile: its inputs are already wire-shaped primitives.
  expect(refused).toEqual([]);
  expect(compared).toBe(cases.length);
});

// Many ties, so the appended id and the keyset carry the order.
const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  rank: integer("rank").notNull(),
  done: integer("done", { mode: "boolean" }).notNull(),
  note: text("note"),
});
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
const { Project: projectBinding } = bind({ Project }, { Project: { table: projects } });
const projectRows = Array.from({ length: 23 }, (_, i) => ({
  id: `p${String(i).padStart(2, "0")}`,
  name: ["Apollo", "borealis", "Ceres", "apollo", "Éclipse", "a_b", "50%"][i % 7],
  status: ["active", "draft", "archived"][i % 3],
  rank: i % 4,
  done: i % 5 === 0,
  note: i % 6 === 0 ? null : `note ${i}`,
}));

test("ties, both directions, booleans, searches and null checks agree with upstream", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "create table projects (id text primary key not null, name text not null, status text not null, rank integer not null, done integer not null, note text)",
  );
  for (const row of projectRows)
    db.prepare("insert into projects values (?, ?, ?, ?, ?, ?)").run(
      row.id,
      row.name,
      row.status,
      row.rank,
      row.done ? 1 : 0,
      row.note,
    );
  const storage = storageOf(projectBinding);
  const status = Expr.input("status", Schema.String);
  const search = Expr.input("search", Schema.String);
  const open = Expr.input("open", Schema.Boolean);
  const bodies: ReadonlyArray<readonly [string, AnyQuery, ReadonlyArray<Row>]> = [
    ["rank then id", Query.from(Project).pipe(Query.orderBy(Order.asc(Project.fields.rank))), [{}]],
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
      [{ search: "APOLLO" }, { search: "_" }, { search: "%" }, { search: "" }, { search: null }],
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
  for (const [label, body, inputs] of bodies) {
    const plan = planQuery(label, body, storage);
    const descriptor = {
      ...Query.make(label, { Input: {}, Result: Query.connection(Project) }),
      body,
    };
    const source = query(descriptor, { entity: projectBinding });
    for (const input of inputs)
      await agree(db, plan, source, input, `${label} ${JSON.stringify(input)}`);
  }
});

test("storage and bodies outside the native profile are refused while compiling", () => {
  const nullableOrder = Query.from(Project).pipe(Query.orderBy(Order.asc(Project.fields.note)));
  expect(() => planQuery("nullable", nullableOrder, storageOf(projectBinding))).toThrow(
    "Ordering by nullable Project.note",
  );
  const unordered = Query.from(Project);
  expect(() => planQuery("unordered", unordered, storageOf(projectBinding))).toThrow(
    "stable order",
  );
  const hidden = entity("Hidden", projects, { visible: () => undefined });
  expect(() => storageOf(hidden)).toThrow("visible");
});
