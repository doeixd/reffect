/**
 * The showcase's storage: the todo domain's one table in SQLite, bound to the `Todo` entity with
 * foldkit-remote-drizzle, as an application would declare it for upstream's Drizzle sources.
 */
import { DatabaseSync } from "node:sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { bind } from "foldkit-remote-drizzle";
import { Todo, rows } from "../todo-remote/domain.ts";

export const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  done: integer("done", { mode: "boolean" }).notNull(),
});
export const bindings = bind({ Todo }, { Todo: { table: todos } });

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
/** The URL the native server opens, from `REFFECT_DATABASE_URL`. */
export const sqliteUrl = (file: string) => `sqlite:${file.replaceAll("\\", "/")}`;
