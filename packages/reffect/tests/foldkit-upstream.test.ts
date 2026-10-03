import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { Entity, Expr, Query, dependenciesOf, evaluate } from "foldkit-entity";
import { and, getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { compileWhere } from "foldkit-remote-drizzle";
import { expect, test } from "vite-plus/test";

// Upstream behaviour reffect relies on, fixed in foldkit-plus 0.14.0 after reffect reported it
// (docs/research/foldkit-plus-issues.md). Each test failed against the previous release.
const Item = Entity.define("Item", Schema.Struct({ id: Schema.String, text: Schema.String }));

test("foldkit-plus#136: containment folds ASCII in evaluate as in SQLite, and refuses NUL", () => {
  const table = sqliteTable("items", { id: text("id"), text: text("text") });
  const query = Query.from(Item).pipe(
    Query.where(Expr.contains(Item.fields.text, Expr.input("search", Schema.String))),
  );
  const rows = [
    { id: "unicode", text: "Élan" },
    { id: "ascii", text: "ELAN" },
  ];
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("create table items (id text, text text)");
    for (const row of rows) sqlite.prepare("insert into items values (?, ?)").run(row.id, row.text);
    const db = drizzle({ client: sqlite });
    for (const [search, expected] of [
      ["é", []],
      ["Él", ["unicode"]],
      ["lan", ["unicode", "ascii"]],
    ] as const) {
      expect(
        evaluate(query, { search }, rows).map((r) => r.id),
        search,
      ).toEqual(expected);
      const found = db
        .select()
        .from(table)
        .where(
          and(
            ...compileWhere(query, { columns: getTableColumns(table) }, { search }, "IssueRepro"),
          ),
        )
        .all();
      expect(
        found.map((r) => r.id),
        search,
      ).toEqual(expected);
    }
    expect(() => evaluate(query, { search: "a\0b" }, rows)).toThrow("NUL");
    expect(() =>
      compileWhere(query, { columns: getTableColumns(table) }, { search: "a\0b" }, "IssueRepro"),
    ).toThrow("NUL");
  } finally {
    sqlite.close();
  }
});

test("foldkit-plus#137: a shared expression graph is walked once per node", () => {
  // 2^40 paths through 40 shared nodes: a walk per path would never finish.
  const root = Array.from({ length: 40 }).reduce<ReturnType<typeof Expr.eq>>(
    (n) => Expr.eq(n, n),
    Expr.eq(Item.fields.id, "a"),
  );
  const query = Query.from(Item).pipe(Query.where(root));
  expect(Query.dependencies(query).operations).toEqual(["eq"]);
});

test("foldkit-plus#138: Query predicates are frozen as they are built", () => {
  const predicate = Expr.eq(Item.fields.id, "a");
  const query = Query.from(Item).pipe(Query.where(predicate));
  const rows = [{ id: "a" }, { id: "b" }];
  expect(Object.isFrozen(predicate)).toBe(true);
  expect(() => Object.assign(predicate, { right: Expr.literal("b") })).toThrow(TypeError);
  expect(evaluate(query, {}, rows)).toEqual([rows[0]]);
});

test("foldkit-plus#139: dependency reports keep same-name Entities apart", () => {
  const OtherItem = Entity.define("Item", Schema.Struct({ id: Schema.String }));
  expect(Item.identity.token).not.toBe(OtherItem.identity.token);
  expect(
    dependenciesOf(Expr.field(Item.fields.id), Expr.field(OtherItem.fields.id)).fields,
  ).toHaveLength(2);
});
