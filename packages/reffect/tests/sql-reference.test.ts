/**
 * SQL step 1 (docs/research/sql-service.md): R programs over `R.sql` and `R.SqlSchema` run in
 * the reference through the official SQLite client, and each outcome equals the plain-data
 * projection of the same Effect program: rows, Options, decode failures, missing rows and
 * classified SqlErrors, each case on a freshly seeded database.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Option, Predicate, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { expect, test } from "vite-plus/test";
import { R, Reference } from "../src/index.ts";

const E = R.SqlSchema.Error;
const Row = R.Struct({ id: R.String, n: R.Number, note: R.NullOr(R.String) });
const RowSchema = Schema.Struct({
  id: Schema.String,
  n: Schema.Number,
  note: Schema.NullOr(Schema.String),
});
const Probe = R.Struct({ t: R.String, s: R.String });
const ProbeSchema = Schema.Struct({ t: Schema.String, s: Schema.String });
const Insert = R.Struct({ id: R.String, n: R.Number });
const InsertSchema = Schema.Struct({ id: Schema.String, n: Schema.Number });

/** One case: the R function and its arguments, and the same program in Effect. */
interface Case {
  readonly name: string;
  readonly run: Effect.Effect<unknown, unknown, never>;
  readonly effect: Effect.Effect<unknown, unknown, SqlClient.SqlClient>;
}
const cases: Case[] = [];
const add = (
  name: string,
  run: Effect.Effect<unknown, unknown, never>,
  effect: Effect.Effect<unknown, unknown, SqlClient.SqlClient>,
) => cases.push({ name, run, effect });

{
  const f = R.fn([R.String], R.Array(Row), E, (id) =>
    R.SqlSchema.findAll({
      Request: R.String,
      Result: Row,
      execute: (from) => R.sql`select * from t where id >= ${from} order by id`,
    })(id),
  );
  const effect = Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findAll({
      Request: Schema.String,
      Result: RowSchema,
      execute: (from) => sql`select * from t where id >= ${from} order by id`,
    })("a"),
  );
  add("findAll", Reference.run(f, ["a"]), effect);
}
{
  const ById = R.Struct({ id: R.Number });
  const f = R.fn([R.String], R.Array(ById), E, (id) =>
    R.SqlSchema.findAll({
      Request: R.String,
      Result: ById,
      execute: (from) => R.sql`select * from t where id >= ${from} order by id`,
    })(id),
  );
  const effect = Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({ id: Schema.Number }),
      execute: (from) => sql`select * from t where id >= ${from} order by id`,
    })("a"),
  );
  add("findAll decode failure", Reference.run(f, ["a"]), effect);
}
for (const id of ["b", "zz"]) {
  const f = R.fn([R.String], Row, E, (request) =>
    R.SqlSchema.findOne({
      Request: R.String,
      Result: Row,
      execute: (key) => R.sql`select * from t where id = ${key}`,
    })(request),
  );
  const effect = Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOne({
      Request: Schema.String,
      Result: RowSchema,
      execute: (key) => sql`select * from t where id = ${key}`,
    })(id),
  );
  add(`findOne ${id}`, Reference.run(f, [id]), effect);
}
for (const id of ["a", "zz"]) {
  const f = R.fn([R.String], R.Option(Row), E, (request) =>
    R.SqlSchema.findOneOption({
      Request: R.String,
      Result: Row,
      execute: (key) => R.sql`select * from t where id = ${key}`,
    })(request),
  );
  const effect = Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOneOption({
      Request: Schema.String,
      Result: RowSchema,
      execute: (key) => sql`select * from t where id = ${key}`,
    })(id),
  );
  add(`findOneOption ${id}`, Reference.run(f, [id]), effect);
}
for (const [id, n] of [
  ["c", 3],
  ["a", 9],
] as const) {
  // A new row, then a duplicate primary key: ConstraintError, as node:sqlite classifies it.
  const f = R.fn([Insert], R.Unit, E, (row) =>
    R.SqlSchema.void({
      Request: Insert,
      execute: (values) =>
        R.sql`insert into t (id, n) values (${R.Struct.get(values, "id")}, ${R.Struct.get(values, "n")})`,
    })(row),
  );
  const effect = Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.void({
      Request: InsertSchema,
      execute: (values) => sql`insert into t (id, n) values (${values.id}, ${values.n})`,
    })({ id, n }),
  );
  add(`insert ${id}`, Reference.run(f, [{ id, n }]), effect);
}
{
  // How each admitted parameter binds: Number as REAL, u64 and Boolean as INTEGER, null as NULL.
  const f = R.fn([R.Number, R.U64, R.Bool, R.NullOr(R.String)], R.Array(Probe), E, (n, u, b, z) =>
    R.SqlSchema.findAll({
      Request: R.Struct({}),
      Result: Probe,
      execute: () =>
        R.sql`select typeof(${n}) as t, ${n} || '' as s union all select typeof(${u}), ${u} || '' union all select typeof(${b}), ${b} || '' union all select typeof(${z}), coalesce(${z}, 'null')`,
    })(R.Struct({}).make({})),
  );
  const effect = Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findAll({
      Request: Schema.Struct({}),
      Result: ProbeSchema,
      execute: () =>
        sql`select typeof(${1}) as t, ${1} || '' as s union all select typeof(${7n}), ${7n} || '' union all select typeof(${true}), ${true} || '' union all select typeof(${null}), coalesce(${null}, 'null')`,
    })({}),
  );
  add("parameters", Reference.run(f, [1, 7n, true, null]), effect);
}
for (const [name, statement] of [
  ["syntax error", "selec 1"],
  ["missing table", "select * from nope"],
  ["integer beyond 2^53", "select 9007199254740993 as t"],
] as const) {
  const f = R.fn([], R.Array(R.Unknown), E, () =>
    statement === "selec 1"
      ? R.sql`selec 1`
      : statement === "select * from nope"
        ? R.sql`select * from nope`
        : R.sql`select 9007199254740993 as t`,
  );
  const effect = Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement));
  add(name, Reference.run(f, []), effect);
}
{
  const f = R.fn([R.U64], R.Array(R.Unknown), E, (u) => R.sql`select ${u} as t`);
  const effect = Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`select ${18446744073709551615n} as t`,
  );
  add("u64 beyond i64", Reference.run(f, [18446744073709551615n]), effect);
}

/** An Effect outcome as the plain data an R program holds. */
const plain = (value: unknown): unknown => {
  if (Option.isOption(value))
    return Option.match(value, {
      onNone: () => ({ _tag: "None" }),
      onSome: (some) => ({ _tag: "Some", value: plain(some) }),
    });
  if (Array.isArray(value)) return value.map(plain);
  if (Predicate.isObject(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
};
const plainError = (error: unknown): unknown => {
  if (Schema.isSchemaError(error)) return { _tag: "SchemaError", message: error.message };
  if (Cause.isNoSuchElementError(error)) return { _tag: "NoSuchElementError" };
  if (Predicate.isTagged(error, "SqlError") && Predicate.hasProperty(error, "reason")) {
    const reason = error.reason as { _tag: string; message?: string; operation?: string };
    return {
      _tag: "SqlError",
      reason: { _tag: reason._tag, message: reason.message, operation: reason.operation },
    };
  }
  return error;
};
const outcome = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.match(exit, {
    onSuccess: (value) => ({ success: plain(value) }),
    onFailure: (cause) =>
      Option.match(Cause.findErrorOption(cause), {
        onNone: () => ({ defect: String(cause) }),
        onSome: (error) => ({ failure: plain(plainError(error)) }),
      }),
  });

/** A fresh database file for one run. */
const fresh = () =>
  SqliteClient.layer({ filename: join(mkdtempSync(join(tmpdir(), "reffect-sql-")), "t.db") });
const seed = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all([
    sql`create table t (id text primary key not null, n integer not null, note text)`,
    sql`insert into t values ('a', 1, null), ('b', 2.5, 'x')`,
  ]),
);

test("R.sql and R.SqlSchema in the reference agree with the official SQLite client", async () => {
  for (const c of cases) {
    const run = (program: Effect.Effect<unknown, unknown, SqlClient.SqlClient>) =>
      Effect.runPromise(Effect.exit(Effect.andThen(seed, program)).pipe(Effect.provide(fresh())));
    const expected = outcome(await run(c.effect));
    const actual = outcome(await run(c.run));
    expect(actual, c.name).toStrictEqual(expected);
  }
  // The comparison covers each kind of outcome.
  const kinds = await Promise.all(
    cases.map(
      async (c) =>
        Object.keys(
          outcome(
            await Effect.runPromise(
              Effect.exit(Effect.andThen(seed, c.effect)).pipe(Effect.provide(fresh())),
            ),
          ),
        )[0],
    ),
  );
  expect(new Set(kinds)).toEqual(new Set(["success", "failure"]));
});
