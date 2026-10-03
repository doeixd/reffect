/**
 * One seeded database of the SQL Remote domain, in either dialect: the URL the native server
 * opens, the Drizzle layer upstream's sources read through, and the oracle's transactions, whose
 * store applies MemoryStore semantics in SQL (SQLX-006, SQLX-016).
 */
import { Effect, FileSystem } from "effect";
import type { Layer, Scope } from "effect";
import { drizzle as drizzleSqlite } from "drizzle-orm/node-sqlite";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { databaseLayer } from "foldkit-remote-drizzle";
import type { DrizzleDatabase } from "foldkit-remote-drizzle";
import type { RemoteStoreApi, SqlDialect } from "../../src/index.ts";
import { bound, pgBound, schemaSql, seed, seedProjects, seedUsers } from "./remote-sql-domain.ts";
import { postgresServer, postgresUnavailable } from "./postgres.ts";

/** One mutation's transaction on the oracle's connection. */
export interface OracleTransaction {
  readonly store: RemoteStoreApi;
  readonly commit: Effect.Effect<void>;
  readonly rollback: Effect.Effect<void>;
}
export interface SqlDatabase {
  readonly dialect: SqlDialect;
  /** The URL for the native server's `REFFECT_DATABASE_URL`. */
  readonly url: string;
  /** The same database, read-only where the dialect can say so in its URL. */
  readonly readOnlyUrl: string;
  readonly layer: Layer.Layer<DrizzleDatabase>;
  readonly begin: Effect.Effect<OracleTransaction>;
}
export interface SqlBackend {
  readonly dialect: SqlDialect;
  readonly bindings: typeof bound | typeof pgBound;
  /** Why this backend cannot run here, if it cannot. */
  readonly unavailable: string | undefined;
  /** Opens seeded databases by name, for as long as the scope lasts. */
  readonly databases: Effect.Effect<
    (name: string) => Effect.Effect<SqlDatabase, never, Scope.Scope>,
    never,
    Scope.Scope | FileSystem.FileSystem
  >;
}

/**
 * MemoryStore.write/remove over SQL: update the given columns of an existing row or insert a new
 * one, with a ref's target id in the foreign key; a failed statement dies, as a native one aborts.
 */
const sqlStore = (
  dialect: SqlDialect,
  bindings: typeof bound | typeof pgBound,
  run: (sql: string, params: ReadonlyArray<unknown>) => Effect.Effect<number>,
): RemoteStoreApi => {
  const at = (n: number) => `${dialect === "postgres" ? "$" : "?"}${n}`;
  const tableOf = (entity: string) => (entity === "Project" ? "projects" : "users");
  const columnOf = (entity: string, field: string): string => {
    const binding = entity === "Project" ? bindings.Project : bindings.User;
    const column = Object.entries(binding.columns).find(([key]) => key === field)?.[1];
    if (column !== undefined) return column.name;
    if (entity === "Project" && field === "owner") return "owner_id";
    throw new Error(`No column for ${field}`);
  };
  const stored = (field: string, value: unknown): string | number | boolean | null => {
    if (field === "owner" && typeof value === "string") return value.slice(value.indexOf(":") + 1);
    if (typeof value === "boolean") return dialect === "postgres" ? value : Number(value);
    if (typeof value === "string" || typeof value === "number" || value === null) return value;
    throw new Error(`Unexpected value for ${field}`);
  };
  return {
    write: (entity, id, values) =>
      Effect.gen(function* () {
        const entries = Object.entries(values).filter(([field]) => field !== "id");
        const columns = entries.map(([field]) => `"${columnOf(entity, field)}"`);
        const params = entries.map(([field, value]) => stored(field, value));
        const sets = columns.length
          ? columns.map((column, i) => `${column} = ${at(i + 2)}`).join(", ")
          : "id = id";
        const updated = yield* run(
          `update ${tableOf(entity)} set ${sets} where id = ${at(1)}`,
          columns.length ? [id, ...params] : [id],
        );
        if (updated === 0)
          yield* run(
            `insert into ${tableOf(entity)} (id${columns.map((column) => `, ${column}`).join("")}) values (${[id, ...params].map((_, i) => at(i + 1)).join(", ")})`,
            [id, ...params],
          );
      }),
    remove: (entity, id) =>
      run(`delete from ${tableOf(entity)} where id = ${at(1)}`, [id]).pipe(Effect.asVoid),
  };
};

export const sqliteBackend: SqlBackend = {
  dialect: "sqlite",
  bindings: bound,
  unavailable: undefined,
  databases: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs
      .makeTempDirectoryScoped({ prefix: "reffect-sql-" })
      .pipe(Effect.orDie);
    return (name: string) =>
      Effect.gen(function* () {
        const file = `${directory}/${name}.db`;
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => seed(file)),
          (db) => Effect.sync(() => db.close()),
        );
        const exec = (sql: string) => Effect.sync(() => db.exec(sql));
        const run = (sql: string, params: ReadonlyArray<unknown>) =>
          Effect.sync(() =>
            Number(
              db.prepare(sql).run(...params.map((param) => param as string | number | null))
                .changes,
            ),
          );
        const url = `sqlite:${file.replaceAll("\\", "/")}`;
        return {
          dialect: "sqlite" as const,
          url,
          readOnlyUrl: `${url}?mode=ro`,
          layer: databaseLayer(drizzleSqlite({ client: db })),
          begin: exec("BEGIN IMMEDIATE").pipe(
            Effect.as({
              store: sqlStore("sqlite", bound, run),
              commit: exec("COMMIT"),
              rollback: exec("ROLLBACK"),
            }),
          ),
        } satisfies SqlDatabase;
      });
  }),
};

export const postgresBackend: SqlBackend = {
  dialect: "postgres",
  bindings: pgBound,
  unavailable: postgresUnavailable,
  databases: Effect.gen(function* () {
    const server = yield* postgresServer;
    return (name: string) =>
      Effect.gen(function* () {
        const pool = yield* server.database(name);
        yield* Effect.promise(async () => {
          await pool.query(schemaSql.postgres);
          for (const row of seedUsers)
            await pool.query("insert into users values ($1, $2, $3)", [...row]);
          for (const row of seedProjects)
            await pool.query("insert into projects values ($1, $2, $3, $4, $5, $6, $7)", [...row]);
        });
        const begin = Effect.promise(async () => {
          const client = await pool.connect();
          await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
          const end = (statement: string) =>
            Effect.promise(async () => {
              try {
                await client.query(statement);
              } finally {
                client.release();
              }
            });
          return {
            store: sqlStore("postgres", pgBound, (sql, params) =>
              Effect.promise(() => client.query(sql, [...params])).pipe(
                Effect.map((result) => result.rowCount ?? 0),
              ),
            ),
            commit: end("COMMIT"),
            rollback: end("ROLLBACK"),
          };
        });
        return {
          dialect: "postgres" as const,
          url: server.url(name),
          readOnlyUrl: server.url(name),
          layer: databaseLayer(drizzlePostgres({ client: pool })),
          begin,
        } satisfies SqlDatabase;
      });
  }),
};

export const sqlBackends: ReadonlyArray<SqlBackend> = [sqliteBackend, postgresBackend];
