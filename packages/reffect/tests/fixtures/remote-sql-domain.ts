/**
 * The SQL Remote domain shared by the milestone 5 tests: Foldkit entities, two Query.define bodies,
 * the same tables for SQLite and Postgres with their foldkit-remote-drizzle bindings, and seed rows.
 */
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  boolean as pgBoolean,
  integer as pgInteger,
  pgTable,
  text as pgText,
} from "drizzle-orm/pg-core";
import { Entity, Expr, Order, Relation } from "foldkit-entity";
import { Query, Remote } from "foldkit-remote";
import { bind } from "foldkit-remote-drizzle";

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
export const bound = bind(domainEntities, {
  User: { table: users },
  Project: { table: projects, relations: { owner: { field: projects.ownerId } } },
});

const pgUsers = pgTable("users", {
  id: pgText("id").primaryKey(),
  name: pgText("display_name").notNull(),
  email: pgText("email"),
});
const pgProjects = pgTable("projects", {
  id: pgText("id").primaryKey(),
  name: pgText("name").notNull(),
  status: pgText("status").notNull(),
  rank: pgInteger("rank").notNull(),
  done: pgBoolean("done").notNull(),
  note: pgText("note"),
  ownerId: pgText("owner_id"),
});
export const pgBound = bind(domainEntities, {
  User: { table: pgUsers },
  Project: { table: pgProjects, relations: { owner: { field: pgProjects.ownerId } } },
});

/** The tables, in each dialect's types. */
export const schemaSql = {
  sqlite: `
    create table users (id text primary key not null, display_name text not null, email text);
    create table projects (id text primary key not null, name text not null, status text not null,
      rank integer not null, done integer not null, note text, owner_id text);`,
  postgres: `
    create table users (id text primary key not null, display_name text not null, email text);
    create table projects (id text primary key not null, name text not null, status text not null,
      rank integer not null, done boolean not null, note text, owner_id text);`,
} as const;
export const seedUsers = [
  ["u1", "Ada", "ada@example.test"],
  ["u2", "Grace", null],
  ["u3", "Édith", "e@example.test"],
] as const;
const names = ["Apollo", "borealis", "Ceres", "apollo", "Éclipse", "a_b", "50%", "Zeta"];
/** `[id, name, status, rank, done, note, owner_id]` */
export const seedProjects = Array.from(
  { length: 14 },
  (_, i) =>
    [
      `p${String(i).padStart(2, "0")}`,
      names[i % names.length],
      ["active", "draft"][i % 2],
      i % 3,
      i % 4 === 0,
      i % 5 === 0 ? null : `note ${i}`,
      i % 6 === 5 ? null : `u${(i % 3) + 1}`,
    ] as const,
);

export const seed = (file: string) => {
  const db = new DatabaseSync(file);
  db.exec(schemaSql.sqlite);
  for (const row of seedUsers) db.prepare("insert into users values (?, ?, ?)").run(...row);
  for (const [id, name, status, rank, done, note, owner] of seedProjects)
    db.prepare("insert into projects values (?, ?, ?, ?, ?, ?, ?)").run(
      id,
      name,
      status,
      rank,
      done ? 1 : 0,
      note,
      owner,
    );
  return db;
};
