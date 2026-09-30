import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { Entity, Expr, Query, dependenciesOf, evaluate } from "foldkit-entity";
import { and, getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { expect, test } from "vite-plus/test";
import { compileWhere } from "./fixtures/foldkit-drizzle-compile.ts";

const Item = Entity.define("Item", Schema.Struct({ id: Schema.String, text: Schema.String }));

test("recorded upstream bug: Unicode folding and embedded NUL containment disagree with SQLite", () => {
  const table = sqliteTable("items", { id: text("id"), text: text("text") });
  const query = Query.from(Item).pipe(
    Query.where(Expr.contains(Item.fields.text, Expr.input("search", Schema.String))),
  );
  const rows = [
    { id: "unicode", text: "É" },
    { id: "nul", text: "a\0b" },
  ];
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("create table items (id text, text text)");
    for (const row of rows) sqlite.prepare("insert into items values (?, ?)").run(row.id, row.text);
    const db = drizzle({ client: sqlite });
    for (const [search, id] of [
      ["é", "unicode"],
      ["b", "nul"],
    ]) {
      expect(evaluate(query, { search }, rows).map((r) => r.id)).toEqual([id]);
      const found = db
        .select()
        .from(table)
        .where(
          and(
            ...compileWhere(query, { columns: getTableColumns(table) }, { search }, "IssueRepro"),
          ),
        )
        .all();
      expect(found).toEqual([]);
    }
  } finally {
    sqlite.close();
  }
});

test("recorded upstream bug: ownership and dependencies expand a shared expression graph", () => {
  const leaf = Expr.eq(Item.fields.id, "a");
  let visits = 0;
  Object.defineProperty(leaf, "_tag", {
    get: () => {
      visits++;
      return "Eq";
    },
  });
  const root = Array.from({ length: 12 }, (_, i) => i).reduce((n) => Expr.eq(n, n), leaf);
  visits = 0;
  const query = Query.from(Item).pipe(Query.where(root));
  expect(visits).toBe(4096);
  visits = 0;
  expect(Query.dependencies(query).operations).toEqual(["eq"]);
  expect(visits).toBe(4096);
});

test("recorded upstream gap: existing Query predicates remain mutable", () => {
  const predicate = Expr.eq(Item.fields.id, "a");
  const query = Query.from(Item).pipe(Query.where(predicate));
  const rows = [{ id: "a" }, { id: "b" }];
  expect(evaluate(query, {}, rows)).toEqual([rows[0]]);
  expect(Object.isFrozen(predicate)).toBe(false);
  Object.assign(predicate, { right: Expr.literal("b") });
  expect(evaluate(query, {}, rows)).toEqual([rows[1]]);
});

test("recorded upstream limitation: display dependency reports conflate same-name identities", () => {
  const OtherItem = Entity.define("Item", Schema.Struct({ id: Schema.String }));
  expect(Item.identity.token).not.toBe(OtherItem.identity.token);
  expect(
    dependenciesOf(Expr.field(Item.fields.id), Expr.field(OtherItem.fields.id)).fields,
  ).toEqual([{ entity: "Item", key: "id" }]);
});
