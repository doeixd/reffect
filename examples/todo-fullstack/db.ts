/**
 * The showcase's storage: the todo domain's one table, bound to the `Todo` entity with
 * foldkit-remote-drizzle as an application would declare it for upstream's Drizzle sources, in
 * SQLite or in Postgres.
 */
import { DatabaseSync } from "node:sqlite";
import { boolean as pgBoolean, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { bind } from "foldkit-remote-drizzle";
import pg from "pg";
import { Todo, rows } from "../todo-remote/domain.ts";

export type Dialect = "sqlite" | "postgres";

export const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  done: integer("done", { mode: "boolean" }).notNull(),
});
export const pgTodos = pgTable("todos", {
  id: pgText("id").primaryKey(),
  title: pgText("title").notNull(),
  done: pgBoolean("done").notNull(),
});
export const bindings = bind({ Todo }, { Todo: { table: todos } });
export const pgBindings = bind({ Todo }, { Todo: { table: pgTodos } });

/** A fresh database at `file` holding the domain's seed rows. */
export const seed = (file: string) => {
  const db = new DatabaseSync(file);
  db.exec(
    "create table todos (id text primary key not null, title text not null, done integer not null)",
  );
  const insert = db.prepare("insert into todos values (?, ?, ?)");
  for (const row of rows.Todo) insert.run(row.id, row.title, row.done ? 1 : 0);
  db.close();
};
/**
 * The todos table in the Postgres database at `url`, seeded with the domain's rows when it is
 * new; an existing table and its rows are kept.
 */
export const seedPostgres = async (url: string) => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      "create table if not exists todos (id text primary key not null, title text not null, done boolean not null)",
    );
    const { rows: existing } = await client.query("select count(*)::int as count from todos");
    if (existing[0]?.count === 0)
      for (const row of rows.Todo)
        await client.query("insert into todos values ($1, $2, $3)", [row.id, row.title, row.done]);
  } finally {
    await client.end();
  }
};
/** The URL the native server opens, from `REFFECT_DATABASE_URL`. */
export const sqliteUrl = (file: string) => `sqlite:${file.replaceAll("\\", "/")}`;
