import { DatabaseSync } from "node:sqlite";
import { Cause, Effect, Exit, FileSystem, Option, Schema, SchemaGetter } from "effect";
import { NodeServices } from "@effect/platform-node";
import { Entity, Expr, Order, Query, evaluate } from "foldkit-entity";
import type { AnyQuery, Predicate, Row } from "foldkit-entity";
import { cases, rows } from "foldkit-entity/conformance";
import { and, asc, desc, getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { expect, test } from "vite-plus/test";
import { CargoApi, Compile, CompileError, Foldkit } from "../src/index.ts";
import type { FoldkitArtifact } from "../src/index.ts";
import { compileOrderBy, compileWhere } from "foldkit-remote-drizzle";
import { nativeTestBudget } from "./native-test-budget.ts";

const table = sqliteTable("conformance_rows", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  rank: integer("rank").notNull(),
  tag: text("tag"),
  at: text("at").notNull(),
});

test("all published Foldkit cases agree in evaluate, upstream Drizzle/SQLite and fresh Rust debug/release", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    "create table conformance_rows (id text primary key, label text not null, rank integer not null, tag text, at text not null)",
  );
  const insert = sqlite.prepare("insert into conformance_rows values (?, ?, ?, ?, ?)");
  for (const row of rows) insert.run(row.id, row.label, row.rank, row.tag, row.at);
  const db = drizzle({ client: sqlite });
  const target = { columns: getTableColumns(table) };
  try {
    const queries = Object.fromEntries(cases.map((c, i) => [`case${i}`, c.body]));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const artifact = yield* Compile.fromFoldkitQuery(queries);
          expect(artifact.explanation.every((q) => q.crates.length === 0)).toBe(true);
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-foldkit-" });
          yield* CargoApi.write(artifact, `${dir}/crate`);
          for (const profile of ["debug", "release"] as const) {
            yield* CargoApi.build(`${dir}/crate`, profile);
            for (const [i, c] of cases.entries()) {
              expect(
                evaluate(c.body, c.input, rows).map((r) => r.id),
                c.what,
              ).toEqual(c.expected);
              const terms = compileOrderBy(c.body, target, c.what);
              const sqlRows = db
                .select({ id: table.id })
                .from(table)
                .where(and(...compileWhere(c.body, target, c.input, c.what)))
                .orderBy(
                  ...terms.map((t) => (t.direction === "asc" ? asc(t.column) : desc(t.column))),
                )
                .all();
              expect(
                sqlRows.map((r) => r.id),
                `SQLite: ${c.what}`,
              ).toEqual(c.expected);
              const native = yield* Foldkit.run(
                artifact,
                `${dir}/crate`,
                `case${i}`,
                c.input,
                rows,
                profile,
              );
              expect(
                native.map((r) => r.id),
                `${profile}: ${c.what}`,
              ).toEqual(c.expected);
              expect(native.every((r) => rows.includes(r))).toBe(true);
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  } finally {
    sqlite.close();
  }
}, 120000);

const Item = Entity.define(
  "Item",
  Schema.Struct({
    id: Schema.String,
    text: Schema.String,
    rank: Schema.Number,
    active: Schema.Boolean,
  }),
);
const from = Query.from(Item);
const testRows = [
  { id: "a", text: "\u{10000}", rank: 2, active: true, extra: { keep: true } },
  { id: "b", text: "\ue000", rank: -0, active: false, extra: { keep: true } },
  { id: "c", text: "\ud800", rank: 2, active: true, extra: { keep: true } },
  { id: "d", text: 'a\n\0"\\', rank: -0, active: false, extra: { keep: true } },
];
const nullishRows = [
  { id: "a", text: null, rank: 1, active: false },
  { id: "b", rank: 2, active: true },
];
const shared = Expr.eq(Item.fields.active, true);
const testQueries = {
  stable: from.pipe(Query.orderBy(Order.asc(Item.fields.rank))),
  text: from.pipe(Query.orderBy(Order.asc(Item.fields.text))),
  booleans: from.pipe(Query.orderBy(Order.desc(Item.fields.active))),
  equality: from.pipe(Query.where(Expr.eq(Item.fields.text, Expr.input("text", Schema.String)))),
  absent: from.pipe(Query.where(Expr.isNull(Item.fields.text))),
  unknown: from.pipe(
    Query.where(Expr.eq(Expr.eq(Item.fields.text, Expr.input("text", Schema.String)), false)),
  ),
  number: from.pipe(Query.where(Expr.eq(Item.fields.rank, Expr.input("rank", Schema.Number)))),
  empty: from,
  contains: from.pipe(
    Query.where(Expr.contains(Item.fields.text, Expr.input("text", Schema.String))),
  ),
  shortCircuit: from.pipe(
    Query.where(Expr.eq(Item.fields.active, false), Expr.contains(Item.fields.text, "x")),
  ),
  shared: from.pipe(Query.where(Expr.eq(shared, shared))),
};

test(
  "dynamic rows preserve primitive and UTF-16 semantics, stable ordering and unknown propagation",
  async () => {
    const literal = Expr.literal("a");
    const snapshot = from.pipe(Query.where(Expr.eq(Item.fields.id, literal)));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queries = Object.fromEntries(
            Object.entries(testQueries).concat([["snapshot", snapshot]]),
          );
          const artifact = yield* Foldkit.compile(queries);
          // Nodes are frozen as they are built (foldkit-plus#138), so the compiled snapshot cannot drift.
          expect(Object.isFrozen(literal)).toBe(true);
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-foldkit-edge-" });
          const crate = `${dir}/crate`;
          yield* CargoApi.write(artifact, crate);
          for (const profile of ["debug", "release"] as const) {
            yield* CargoApi.build(crate, profile);
            for (const name of ["stable", "text", "booleans", "empty", "shared"] as const) {
              const actual = yield* Foldkit.run(artifact, crate, name, {}, testRows, profile);
              expect(actual).toEqual(evaluate(testQueries[name], {}, testRows));
              expect(actual.every((r) => testRows.includes(r))).toBe(true);
            }
            for (const text of testRows.map((r) => r.text)) {
              const input = { text };
              expect(
                yield* Foldkit.run(artifact, crate, "equality", input, testRows, profile),
              ).toEqual(evaluate(testQueries.equality, input, testRows));
            }
            for (const rank of [NaN, Infinity, -Infinity, -0, Number.MAX_VALUE, Number.MIN_VALUE]) {
              const values = [
                { id: "x", rank },
                { id: "y", rank: 0 },
              ];
              expect(
                yield* Foldkit.run(artifact, crate, "number", { rank }, values, profile),
              ).toEqual(evaluate(testQueries.number, { rank }, values));
            }
            expect(yield* Foldkit.run(artifact, crate, "absent", {}, nullishRows, profile)).toEqual(
              nullishRows,
            );
            expect(
              yield* Foldkit.run(artifact, crate, "unknown", {}, nullishRows, profile),
            ).toEqual([]);
            expect(yield* Foldkit.run(artifact, crate, "stable", {}, [], profile)).toEqual([]);
            expect(yield* Foldkit.run(artifact, crate, "snapshot", {}, testRows, profile)).toEqual([
              testRows[0],
            ]);
            const unrelated = {
              text: "a",
              get extra() {
                throw new Error("Unreachable cell must not be read");
              },
            };
            const preserved = yield* Foldkit.run(
              artifact,
              crate,
              "equality",
              { text: "a" },
              [unrelated],
              profile,
            );
            expect(preserved).toHaveLength(1);
            expect(preserved[0]).toBe(unrelated);
            // The first predicate rejects the row before the unsupported containment is evaluated.
            expect(
              yield* Foldkit.run(artifact, crate, "shortCircuit", {}, [testRows[0]], profile),
            ).toEqual([]);
            const wildcardRows = [{ text: "100%_\\cotton" }];
            for (const text of ["%", "_", "\\", "", "COTTON"]) {
              expect(
                yield* Foldkit.run(artifact, crate, "contains", { text }, wildcardRows, profile),
              ).toEqual(wildcardRows);
            }
          }
          // foldkit-entity 0.7.0 folds ASCII letters only and refuses NUL (foldkit-plus#136); native
          // answers and refuses exactly as evaluate does.
          const accented = [{ text: "Élan" }, { text: "ascii" }];
          for (const text of ["é", "É", "élan", "Él", "LAN"])
            expect(yield* Foldkit.run(artifact, crate, "contains", { text }, accented)).toEqual(
              evaluate(testQueries.contains, { text }, accented),
            );
          const refusal = (run: () => unknown) => {
            try {
              run();
            } catch (error) {
              // The native runner prints the message in Rust's Debug form, a quoted string.
              return JSON.stringify(error instanceof Error ? error.message : String(error));
            }
            throw new Error("evaluate did not refuse");
          };
          for (const [input, rows] of [
            [{ text: "\0" }, [{ text: "ascii" }]],
            [{ text: "a" }, [{ text: "a\0b" }]],
          ] as const) {
            const exit = yield* Effect.exit(Foldkit.run(artifact, crate, "contains", input, rows));
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit))
              expect(String(exit.cause)).toContain(
                refusal(() => evaluate(testQueries.contains, input, rows)),
              );
          }
          // The refusal names the first null key in row order, as upstream now does (#142).
          const nullRank = [{ rank: 1 }, { rank: null }, { rank: 2 }];
          const orderExit = yield* Effect.exit(
            Foldkit.run(artifact, crate, "stable", {}, nullRank),
          );
          expect(Exit.isFailure(orderExit)).toBe(true);
          if (Exit.isFailure(orderExit))
            expect(String(orderExit.cause)).toContain(
              refusal(() => evaluate(testQueries.stable, {}, nullRank)),
            );
          const nonfinite = yield* Effect.exit(
            Foldkit.run(artifact, crate, "stable", {}, [{ rank: NaN }, { rank: 1 }]),
          );
          expect(Exit.isFailure(nonfinite)).toBe(true);
          const inputExit = yield* Effect.exit(
            Foldkit.run(artifact, crate, "number", { rank: "1" }, []),
          );
          expect(Exit.isFailure(inputExit)).toBe(true);
          if (Exit.isFailure(inputExit)) {
            const error = Cause.findErrorOption(inputExit.cause);
            expect(
              Option.isSome(error) &&
                error.value instanceof CompileError &&
                error.value.diagnostics.some((d) => d.code === "INVALID_INPUT"),
            ).toBe(true);
          }
          const unknownQuery = yield* Effect.exit(
            Foldkit.run(artifact, crate, "noSuchQuery", {}, []),
          );
          expect(Exit.isFailure(unknownQuery)).toBe(true);
          const malformed = yield* Effect.exit(
            CargoApi.runInput(crate, "stable", "reffect-query-v1\n1\n"),
          );
          expect(Exit.isFailure(malformed)).toBe(true);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(5),
);

const codes = (queries: Readonly<Record<string, AnyQuery>>) =>
  Effect.runPromise(
    Foldkit.compile(queries).pipe(
      Effect.map(() => Array<string>()),
      Effect.catchTag("CompileError", (e) => Effect.succeed(e.diagnostics.map((d) => d.code))),
    ),
  );

const inputCodes = (artifact: FoldkitArtifact, name: string, input: Row, values: readonly Row[]) =>
  Effect.runPromise(
    Foldkit.run(artifact, "/unused", name, input, values).pipe(
      Effect.map(() => Array<string>()),
      Effect.catchTag("CompileError", (error) =>
        Effect.succeed(error.diagnostics.map((d) => d.code)),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );

test("reachable inherited cells and accessors are refused before native execution", async () => {
  const prototype = Entity.define("Prototype", Schema.Struct({ toString: Schema.String }));
  const inherited = Query.from(prototype).pipe(Query.where(Expr.isNull(prototype.fields.toString)));
  const inheritedArtifact = await Effect.runPromise(Foldkit.compile({ inherited }));
  // Ordinary reference lookup sees Object.prototype.toString, not an absent/null cell.
  expect(evaluate(inherited, {}, [{}])).toEqual([]);
  expect(await inputCodes(inheritedArtifact, "inherited", {}, [{}])).toContain("UNSUPPORTED_DATA");
  const artifact = await Effect.runPromise(Foldkit.compile({ equality: testQueries.equality }));
  let reads = 0;
  const getter = () => {
    reads++;
    return "a";
  };
  const accessor: Row = Object.defineProperty({}, "text", { enumerable: true, get: getter });
  expect(await inputCodes(artifact, "equality", { text: "a" }, [accessor])).toContain(
    "UNSUPPORTED_DATA",
  );
  expect(await inputCodes(artifact, "equality", accessor, [{ text: "a" }])).toContain(
    "UNSUPPORTED_DATA",
  );
  expect(reads).toBe(0);
});

test("compilation refuses unsupported representations, foreign identities, invalid binders and decoded literals", async () => {
  expect(await codes({})).toContain("EMPTY_PROGRAM");
  expect(await codes({ "bad-name": from })).toContain("INVALID_NAME");
  expect(
    await codes({
      inputOrder: from.pipe(Query.orderBy(Order.asc(Expr.input("x", Schema.Number)))),
    }),
  ).toContain("UNSUPPORTED_ORDERING");
  const Opaque = Entity.define(
    "Opaque",
    Schema.Struct({ id: Schema.String, data: Schema.Struct({ x: Schema.Number }) }),
  );
  expect(
    await codes({ object: Query.from(Opaque).pipe(Query.where(Expr.isNull(Opaque.fields.data))) }),
  ).toContain("UNSUPPORTED_REPRESENTATION");
  const Unknown = Entity.define(
    "Unknown",
    Schema.Struct({ id: Schema.String, data: Schema.Unknown }),
  );
  expect(
    await codes({
      unknown: Query.from(Unknown).pipe(Query.where(Expr.isNull(Unknown.fields.data))),
    }),
  ).toContain("UNSUPPORTED_REPRESENTATION");
  const Big = Entity.define("Big", Schema.Struct({ id: Schema.String, value: Schema.BigInt }));
  expect(
    await codes({ bigint: Query.from(Big).pipe(Query.where(Expr.eq(Big.fields.value, 1n))) }),
  ).toContain("UNSUPPORTED_REPRESENTATION");
  const date = Schema.Date.pipe(
    Schema.encodeTo(Schema.String, {
      decode: SchemaGetter.transform((s: string) => new Date(s)),
      encode: SchemaGetter.transform((d: Date) => d.toISOString()),
    }),
  );
  const Dated = Entity.define("Dated", Schema.Struct({ id: Schema.String, at: date }));
  expect(
    await codes({
      decoded: Query.from(Dated).pipe(Query.where(Expr.eq(Dated.fields.at, new Date()))),
    }),
  ).toContain("UNSUPPORTED_REPRESENTATION");
  // Upstream freezes nodes and checks ownership in Query.where (foldkit-plus#138), so malformed
  // bodies are built as altered copies, bypassing it; reffect's own checks must still refuse them.
  const altered = <A extends object>(node: A, change: object) => Object.assign({ ...node }, change);
  const withWhere = (...where: ReadonlyArray<Predicate>) => ({ ...from, where });
  const impostor = Entity.define("Item", Schema.Struct({ id: Schema.String }));
  const foreign = withWhere(
    altered(Expr.eq(Item.fields.id, "a"), { left: Expr.field(impostor.fields.id) }),
  );
  expect(await codes({ foreign })).toContain("FOREIGN_FIELD");
  const conflicting = from.pipe(
    Query.where(
      Expr.eq(Item.fields.rank, Expr.input("x", Schema.Number)),
      Expr.eq(Item.fields.text, Expr.input("x", Schema.String)),
    ),
  );
  expect(await codes({ conflicting })).toContain("INPUT_WITNESS_MISMATCH");
  const spoofed = withWhere(
    altered(Expr.isNull(Item.fields.rank), {
      operand: altered(Expr.field(Item.fields.rank), { schema: Schema.String }),
    }),
  );
  expect(await codes({ spoofed })).toContain("FIELD_WITNESS_MISMATCH");
  const loop = altered(Expr.eq(Item.fields.active, true), {});
  Object.assign(loop, { right: loop });
  expect(await codes({ cyclic: withWhere(loop) })).toContain("CYCLIC_IR");
  const malformed = withWhere(altered(Expr.isNull(Item.fields.id), { present: "false" }));
  expect(await codes({ malformed })).toContain("INVALID_IR");
  const invalidContains = withWhere(
    altered(Expr.contains(Item.fields.text, "x"), { value: Expr.field(Item.fields.rank) }),
  );
  expect(await codes({ invalidContains })).toContain("UNSUPPORTED_CONTAINMENT");
});

test("shared Query expression DAGs compile once per node", async () => {
  const queryAt = (depth: number) => {
    const root = Array.from({ length: depth }, (_, i) => i).reduce(
      (predicate) => Expr.eq(predicate, predicate),
      Expr.eq(Item.fields.active, true),
    );
    // Query.where's upstream ownership walk itself expands shared graphs. Keep this
    // compiler regression independent of that builder bug without changing the IR shape.
    const query: AnyQuery = Object.defineProperty(Object.create(from), "where", {
      value: Object.freeze([root]),
    });
    return query;
  };
  const small = await Effect.runPromise(Foldkit.compile({ Shared: queryAt(16) }));
  const deep = await Effect.runPromise(Foldkit.compile({ Shared: queryAt(128) }));
  expect(deep.files["src/lib.rs"].length).toBeLessThan(small.files["src/lib.rs"].length * 8);
  expect(deep.explanation[0].operations).toEqual(["eq"]);
});

test("native bridge checks decoded input without weakening the encoded schema profile", async () => {
  const encodedCase = cases.find((c) => Object.hasOwn(c.input, "at"));
  if (!encodedCase) throw new Error("Published timestamp conformance fixture is missing");
  const artifact = await Effect.runPromise(Foldkit.compile({ timestamp: encodedCase.body }));
  const exit = await Effect.runPromise(
    Effect.exit(Foldkit.run(artifact, "/unused", "timestamp", { at: new Date() }, [])).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const error = Cause.findErrorOption(exit.cause);
    expect(
      Option.isSome(error) &&
        error.value instanceof CompileError &&
        error.value.diagnostics.some((d) => d.code === "UNSUPPORTED_REPRESENTATION"),
    ).toBe(true);
  }
  expect(artifact.explanation.every(Object.isFrozen)).toBe(true);
});
