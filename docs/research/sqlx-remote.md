# Milestone 5: Remote over SQL with SQLx

Status: **accepted (2026-10-03)**, not implemented. Scope: [implementation milestones §22](../implementation-milestones.md#22-milestone-5--native-query--sqlx) and [Foldkit Remote and SQL](../foldkit-remote.md#remote-drizzle-becomes-remote-sqlx-conceptually). It builds on the accepted [native RemoteServer](native-remote.md) (milestone 4), the [store design](remote-mutations.md#rm-002-refined-remotestore-as-a-service-implementation-2026-10-03) (RS-001..006) and the [milestone-1 Query adapter](foldkit-query.md).

## Sources (checked 2026-10-03)

- **SQLx** 0.9.0 (tag `v0.9.0`, crates.io 2026-05-21):
  - `rust-version = "1.94.0"`.
  - Default features `any, macros, migrate, json`.
  - `query*()` takes `impl SqlSafeStr` (`&'static str` or `AssertSqlSafe`).
  - `sqlx-sqlite` accepts `libsqlite3-sys >=0.30.1, <0.38.0`; Cargo picks 0.37.0, which bundles SQLite 3.51.3 without ICU and builds with MSVC on Windows.
  - The SQLite driver binds missing parameters as NULL.
  - `Any` panics without runtime-installed drivers and does not translate dialects.
  - The previous stable, 0.8.6, has an MSRV of about 1.78 and bundles SQLite 3.46.0.
- **SQLite** docs and a local SQLite 3.50.4 confirm:
  - `LIKE` folds ASCII only and stops at NUL;
  - `lower()` is ASCII-only without ICU;
  - BINARY collation orders by code point, which differs from JS UTF-16 code-unit order for characters around and above the surrogate range;
  - NULLs sort first in ascending order;
  - integers and reals compare exactly beyond 2^53;
  - booleans are stored as 0/1.
- **PostgreSQL 18** docs:
  - `lower()` and collation follow the locale unless `COLLATE "C"` is given;
  - NULLs sort last in ascending order;
  - `NULLS FIRST|LAST` is available;
  - `SERIALIZABLE` must be requested;
  - NUL cannot be stored in text.
- **Upstream `foldkit-remote-drizzle` 0.9.0** (main `16af177`, drizzle-orm `1.0.0-rc.4`). It depends on exactly the `foldkit-entity` 0.6.0 and `foldkit-remote`/`-server` 0.10.0 we pin, and it installs and imports on Effect 4.0.0, so it is now a devDependency. What it does:
  - `bind(entities, storage)` and `entity(name, table, …)` produce bindings (table, columns, relations of four storage shapes, counts, `visible`).
  - `compile.ts` lowers `eq`/`isNull`/`isNotNull`/`contains`; `contains` becomes `lower(col) like lower(?) escape '\'`.
  - `orderBy` must use plain fields, with the id appended as a tie-breaker.
  - Keyset paging uses the row id as cursor, re-reads the cursor row, and fetches `LIMIT size + 1`. Its predicate assumes Postgres NULL placement.
  - Reads by id use one `IN (…)` per batch, and foreign keys become ref keys.
  - It has no mutation DSL (writes are application code; `returning`/`drizzleWrites` are helpers).
  - Only SQLite is executed in its tests; Postgres is checked as SQL text.

  Details and line references are in the research notes, condensed here.

## Decisions

- **SQLX-001 — SQLite first, with the dialect explicit in the planner.**
  - All three sides run in-process on Windows with no new service: the official server through `foldkit-remote-drizzle` over `node:sqlite`, and native SQLx with bundled SQLite. That is also upstream's own test setup.
  - The planner names a dialect from the first commit, so Postgres follows as a second dialect rather than a rewrite.
  - Postgres comes second, for the showcase. It will be tested by execution (`postgresql_embedded` or Docker), not by SQL text.
- **SQLX-002 — the SQL backend mirrors the Drizzle-backed server, not the memory backend.** A native SQL server replaces a JS `RemoteServer` whose sources are `foldkit-remote-drizzle`. Its oracle is that server over the same SQLite data. Behaviour that differs between memory and SQL follows the SQL source and is registered:
  - `contains` folds ASCII only;
  - text orders by code point;
  - a cursor whose row is gone fails ("The query cursor no longer resolves to a row") instead of `locate`.

  The JS evaluator remains the reference for the expression kernel. Where upstream's SQL path disagrees with it (foldkit-plus#136, code-point order), the disagreement is upstream's and is recorded, not silently resolved.

- **SQLX-003 — storage metadata from upstream bindings, at build time.**
  - `NativeRemote` takes `foldkit-remote-drizzle` bindings and reads static metadata: table and column names, SQL types, nullability, the `id` column, and `one` relations (a foreign key on the owner).
  - Refused, with diagnostics naming the callback (they are arbitrary Drizzle SQL):
    - `visible`;
    - relation `where`/`orderBy`;
    - query-source callbacks;
    - counts with `where`.
  - `many`, inverse-one, `manyToMany` and counts follow in a later slice.
- **SQLX-004 — reads.**
  - Port `source`'s read for the admitted subset: one `SELECT id, cols FROM t WHERE id IN (…)` per chunk, with the batch limits kept.
  - A `one` foreign key becomes `Entity:id`, or null.
  - A driver failure answers `RemoteServerError("Database query failed")` and is logged, so no SQL or schema leaks.
- **SQLX-005 — queries.**
  - Compile `Query.define` bodies with the milestone-1 analysis into parameterized SQL, fixed at build time as `&'static str`. Only values are bound at request time, by declared type, and the argument count is checked by the emitter.
  - `contains` is lowered exactly as upstream lowers it.
  - `ORDER BY` uses plain fields with `id` appended.
  - Paging follows upstream: the id cursor, the cursor row re-read, `LIMIT n+1`, and `hasNext`/`hasPrevious` from the cursor and the overflow row.
  - **Nullable sort columns are refused** while compiling. Upstream's keyset predicate is wrong for them on SQLite, so admitting them would copy a bug.
  - `select` reads through the read path, as before.
- **SQLX-006 — writes and transactions.**
  - `R.RemoteStore.write(entity, id, values)` becomes an upsert of exactly the given columns: `INSERT INTO t (id, …) VALUES (…) ON CONFLICT (id) DO UPDATE SET c = excluded.c`. This matches `{ ...existing, id, ...values }` per column.
  - A ref value `Entity:id` becomes its foreign key.
  - A missing NOT NULL column on insert fails as `RemoteServerError`.
  - `remove` becomes `DELETE … WHERE id = ?`.
  - Each mutation source runs in **one transaction** (`BEGIN IMMEDIATE` on SQLite; `SERIALIZABLE` on Postgres), committed on success and rolled back on failure or interruption. That is stronger than per-statement and settles the open RS-004 question for SQL. The reference runs the same R source over a `RemoteStoreHost` built from `drizzleWrites` inside a Drizzle transaction.
- **SQLX-007 — runtime shape.**
  - The engine's read and query paths become async over a source trait that memory and SQL both implement, and `RemoteStore` becomes async.
  - A server-lifetime pool is opened at startup from an environment variable named at compile time, like bearer credentials, so no connection string is compiled in.
  - SQLx uses `default-features = false` with `runtime-tokio` and `sqlite`, and the bundled `libsqlite3-sys` is pinned exactly so the SQLite version is deterministic.

## Decided (2026-10-03, delegated by the owner)

- **SQLX-008 — SQLx 0.9.0, with the toolchain upgraded.**
  - Pin `sqlx = "=0.9.0"` (`default-features = false`) and pin the bundled `libsqlite3-sys` exactly.
  - Upgrade the local stable toolchain with `rustup update` (from 1.90.0 to at least the 1.94 MSRV). Rust is backward-compatible, and rustup can reinstall 1.90 if a regression appears; representative native suites are re-run after the upgrade.
  - 0.8.6 would avoid the upgrade but starts the milestone on the previous API line, with a migration to follow. 0.9's `SqlSafeStr` suits SQL that is fixed at build time.
- **SQLX-002 is accepted: the Drizzle-backed server governs SQL behaviour.**
  - Making SQL behave like the memory backend would need a custom UTF-16 collation and Unicode folding that upstream's own SQL path does not have, so the native server would match neither deployment exactly.
  - Every SQL-versus-evaluator difference is registered in [native divergences](../native-divergences.md) and, where it is upstream's, linked to its issue.

## Order of work

1. **Done (2026-10-03):** storage metadata and the query planner ([sql-plan.ts](../../packages/reffect/src/sql-plan.ts)).
   - `storageOf` reads `foldkit-remote-drizzle` bindings structurally:
     - the table name comes from `Symbol.for("drizzle:Name")`, so `drizzle-orm` stays build-time only;
     - each column's kind is the first word of Drizzle 1.0's `dataType`;
     - `one` relations become owner foreign keys;
     - `visible`, computed members and other relation kinds are refused.
   - `planQuery` emits fixed SQLite SQL with `?N` placeholders and a typed parameter plan, in five statements: the cursor row, forward, forward after a cursor, backward, and backward before a cursor.
   - Upstream decides a predicate compared to an _input_ boolean per request. Here it compiles to `CASE ?n WHEN 1 THEN (P) WHEN 0 THEN (NOT P) END`, which is unknown for null, as upstream is.
   - Validation runs the planned SQL on `node:sqlite` rather than comparing SQL text. It is checked against upstream's own `query` source over the same database: the full order, the backward order, and every cursor in both directions ([sql-plan.test.ts](../../packages/reffect/tests/sql-plan.test.ts), 3/3).
     - All 27 shared `foldkit-entity/conformance` cases plan, with no refusal needed, and match upstream's expected order.
     - A 23-row tie-heavy set covers equal ranks, descending terms, `_`/`%`/empty/null searches over non-ASCII names, a boolean literal, and an input-folded null check with true, false and null inputs.
2. An async source trait in the engine, with memory moved onto it (no behaviour change; the milestone 4 suites stay green).
3. SQLx reads and queries over SQLite, compared over the wire with `RemoteServer.handlers` using `foldkit-remote-drizzle` sources over a `node:sqlite` copy of the same database. Also run the shared `foldkit-entity/conformance` cases.
4. Writes and transactions through mutation sources; stock-client acceptance over SQL.
5. Postgres as a second dialect, executed.

## Acceptance

- The milestone 5 acceptance from §22: the same queries agree in the JS evaluator, Drizzle/SQLite and Rust/SQLx, with every difference registered.
- Remote Read, Query and Mutate over SQLite match the Drizzle-backed official server over the wire.
- A stock `Remote.clientLayer` session over the native SQL server equals one over the official server.
- Driver errors leak no SQL. Interrupted mutations roll back.
