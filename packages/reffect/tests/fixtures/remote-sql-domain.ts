/**
 * The SQLite Remote domain shared by the milestone 5 tests: Drizzle tables, Foldkit entities and
 * their foldkit-remote-drizzle bindings, two Query.define bodies, and seeded rows.
 */
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Entity, Expr, Order, Relation } from "foldkit-entity";
import { Query, Remote } from "foldkit-remote";
import { bind } from "foldkit-remote-drizzle";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("display_name").notNull(),
  email: text("email"),
});
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  rank: integer("rank").notNull(),
  done: integer("done", { mode: "boolean" }).notNull(),
  note: text("note"),
  ownerId: text("owner_id"),
});
export const UserBase = Entity.define(
  "User",
  Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.NullOr(Schema.String) }),
);
export const ProjectBase = Entity.define(
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
export const domainEntities = Entity.relate(
  { User: UserBase, Project: ProjectBase },
  { Project: { owner: Relation.one(UserBase, { optional: true }) } },
);
export const { Project } = domainEntities;
export const bound = bind(domainEntities, {
  User: { table: users },
  Project: { table: projects, relations: { owner: { field: projects.ownerId } } },
});
export const ByStatus = Query.define("ByStatus", { status: Schema.String }, ({ input }) =>
  Query.from(Project).pipe(
    Query.where(Expr.eq(Project.fields.status, input.status)),
    Query.orderBy(Order.desc(Project.fields.rank), Order.asc(Project.fields.name)),
  ),
);
export const Search = Query.define("Search", { term: Schema.String }, ({ input }) =>
  Query.from(Project).pipe(
    Query.where(Expr.contains(Project.fields.name, input.term)),
    Query.orderBy(Order.asc(Project.fields.name)),
  ),
);
export const domain = Remote.define({
  entities: [domainEntities.User, Project],
  queries: [ByStatus, Search],
});

export const seed = (file: string) => {
  const db = new DatabaseSync(file);
  db.exec(`
    create table users (id text primary key not null, display_name text not null, email text);
    create table projects (id text primary key not null, name text not null, status text not null,
      rank integer not null, done integer not null, note text, owner_id text);
  `);
  for (const [id, name, email] of [
    ["u1", "Ada", "ada@example.test"],
    ["u2", "Grace", null],
    ["u3", "Édith", "e@example.test"],
  ] as const)
    db.prepare("insert into users values (?, ?, ?)").run(id, name, email);
  const names = ["Apollo", "borealis", "Ceres", "apollo", "Éclipse", "a_b", "50%", "Zeta"];
  for (let i = 0; i < 14; i++)
    db.prepare("insert into projects values (?, ?, ?, ?, ?, ?, ?)").run(
      `p${String(i).padStart(2, "0")}`,
      names[i % names.length],
      ["active", "draft"][i % 2],
      i % 3,
      i % 4 === 0 ? 1 : 0,
      i % 5 === 0 ? null : `note ${i}`,
      i % 6 === 5 ? null : `u${(i % 3) + 1}`,
    );
  return db;
};
