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
  - `R.RemoteStore.write(entity, id, values)` writes exactly the given columns: `UPDATE t SET … WHERE id = ?`, then `INSERT (id, …)` only if no row was updated. This matches `{ ...existing, id, ...values }` per column. _Revised 2026-10-03:_ the first design was an upsert (`INSERT … ON CONFLICT DO UPDATE`), but SQLite checks NOT NULL on the inserted row before `ON CONFLICT`, so an upsert cannot update some columns of an existing row with other NOT NULL columns. Both the native server and the oracle failed the same way, and the test's path assertions caught it.
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
2. **Done (2026-10-03):** the async `Source` trait.
   - The engine's `read_helper`, `read` and `query` are generic async functions over `Source`, which has `has_source`, async `read`, `check_query` (unknown query, then input, in upstream's order) and async `page` (one page of ids and its boundaries).
   - The engine keeps everything upstream's handlers own: limits, grouping, authorization, settling, relations and `select`. A source failure becomes `RemoteReadError(message)`, as in `readHelper`.
   - `Memory` implements `Source` with ready futures, so no lock is held across an await, and owns its query definitions.
   - `Authorize` is `Sync`, and `NativeRemote` servers are always asynchronous (`RpcRuntime.asynchronous`).
   - No behaviour change: remote-read, -query, -mutate, -auth, -acceptance and -wire pass (6 files, 15 tests), and the todo example still equals upstream.
3. **Done (2026-10-03):** SQLx reads and queries over SQLite.
   - `NativeRemote.compile(…, { sql: { bindings, databaseUrlEnv } })`, as an alternative to `rows`, emits a `remote_sql::Sql` source ([sql-runtime.ts](../../packages/reffect/src/sql-runtime.ts)) with SQLx 0.9.0, bundled SQLite 3.51.3 and a lazy server-lifetime pool from the named environment variable.
   - **Reads** mirror upstream `source`:
     - `select id, cols from t where t.id in (?1…)` per chunk; the placeholder list is generated text holding no data (`AssertSqlSafe`), and the shape is upstream's, so SQLite returns rows in the same order.
     - Values are decoded by storage class, because SQLx's SQLite decoder will not read an INTEGER as `f64`. Booleans are 0/1; JS number text applies.
     - A foreign key becomes `Target:id` or null. A window on a `one` relation fails as upstream does.
     - Every driver error is logged and answered as `Database query failed`.
     - Undeclared fields are withheld through the new `Source::declares`, as `allowedFields` does.
   - **Pages** run the planned statements and port `shapeWindow` (default 20, max 100, fallback for a non-integer size), the window-conflict refusal, the cursor-row re-read ("The query cursor no longer resolves to a row"), `LIMIT n+1`, `buildPage` and `toQueryPage`.
   - Integral numbers from inputs bind as integers, as the JS driver does. The probe showed an INTEGER 2 never matches a TEXT id.
   - **Validation:** [remote-sql.test.ts](../../packages/reffect/tests/remote-sql.test.ts) passes, with 23 wire steps against `RemoteServer.handlers` using upstream `source`/`query` over `node:sqlite` and the native server reading the same file read-only. Parsed JSON and raw key order match.
     - Reads: a relation through its foreign key, a mixed-order batch with a missing id, nulls, undeclared fields, the id field, a singular-relation window, an unknown entity.
     - Queries: default, first, after, last, before, a cursor outside the query, a gone cursor, first plus last, first 0, a fractional size, `select` through the owner, ASCII-folded and wildcard-escaped searches, wrong input, an unknown query.
   - **Not yet:** writes (step 4), Postgres (step 5), `many`/`manyToMany`/computed relations, and numeric ids or foreign keys.
4. **Done (2026-10-03):** writes and transactions through mutation sources.
   - **Store sessions.** The generated `RemoteStore` trait is one mutation's _session_, shared as an `Arc` with structured-concurrency children. It has async `write`/`remove`, `finish(commit)` and `failure()`. A failed operation aborts like a defect: R cannot catch it, it unwinds through the interruption path so finalizers run, and the session keeps the reason.
   - **The host** opens a session per mutation, commits on success, and rolls back on a typed failure or interruption. A store failure answers `RemoteMutationError("Database query failed")`; `RuntimeCall::StoreFailed`.
   - **Memory** sessions write through at once and never fail, as upstream's memory backend is not transactional.
   - **SQL** sessions are `BEGIN IMMEDIATE` transactions doing update-then-insert of the given columns. A ref value's target id goes to the foreign key, and `remove` is `DELETE … WHERE id`.
   - A source that can never succeed (its output is `Never`) no longer trips output encoding.
   - **Validation:** [remote-sql-mutate.test.ts](../../packages/reffect/tests/remote-sql-mutate.test.ts) passes, with 17 stateful wire steps against the same R sources run by the reference over a raw-SQL MemoryStore inside `BEGIN IMMEDIATE` … `COMMIT`/`ROLLBACK` on the official server's own `node:sqlite` connection. It covers:
     - rename (a partial update of a NOT NULL row), create with a ref, archive, archiving an absent row;
     - a NOT NULL store failure, rolled back;
     - a typed failure after a write, rolled back;
     - a store failure after a successful write, both rolled back;
     - invalid input;
     - reads and queries in between, observing each effect.

     Each server mutates its own copy of the seed. Path assertions confirm every outcome.

   - **Stock-client acceptance (2026-10-03):** a stock `Remote.clientLayer` session runs over the native SQL server and over the official server. Each server has its own seeded SQLite file, and upstream's `RemoteServer.handlers` serves as the client transport, so no HTTP is involved on the official side. The session prefetches a page, applies `mutateInto` for rename, create and archive, sends a refused mutation, then reloads. Every model read matches the official one with `toStrictEqual`. Assertions on the official run confirm that each step observes its effect, so the comparison cannot pass vacuously.
5. Postgres as a second dialect, executed. Design below ([step 5](#step-5-postgres-as-a-second-dialect)).

## Step 5: Postgres as a second dialect

### Sources (checked 2026-10-03)

- **PostgreSQL 18** [locale docs](https://www.postgresql.org/docs/18/locale.html): the `builtin` provider supports `C`, `C.UTF-8` and `PG_UNICODE_FAST`. `PG_UNICODE_FAST` collates by code point and uses full Unicode case mapping, and it is fixed by the server build rather than libc or ICU, so it is deterministic across hosts.
- **Docker image** `postgres:18.6-alpine` (Docker Hub tags listed 2026-10-03; Docker 29.1.3 locally).
- **SQLx 0.9.0** `postgres` feature. TLS is a separate feature (`tls-rustls-ring-webpki`, `tls-native-tls`, …).
  - The Postgres driver sends typed binary parameters and decodes by type: `String` from TEXT/VARCHAR/BPCHAR/NAME, `i16`/`i32`/`i64` from INT2/INT4/INT8, `f64` from FLOAT8, `bool` from BOOL.
  - A NULL bound as `Option<String>` is typed TEXT, which Postgres refuses to assign to an integer column.
- **`pg` (node-postgres) 8.23.1** is the JS driver for the official server, through `drizzle-orm/node-postgres` (1.0.0-rc.4).
  - It sends parameters as untyped text, and Postgres infers each type from its context.
  - Its default parsers read int2/int4 with `parseInt` and float8 with `parseFloat`. Postgres 12+ prints float8 as the shortest round-trip text, so JS gets the same f64 the native decoder does.
  - Drizzle's `nodePgCodecs` changes only date/time, bigint (mode `bigint`), json, geometry and array types, none of which are admitted.
- **Upstream** `foldkit-remote-drizzle` 0.9.0 emits dialect-neutral SQL through Drizzle, and its keyset predicate is written for Postgres NULL placement.

### Decisions

- **SQLX-009 — one planner, an explicit dialect.**
  - `planQuery(…, "postgres")` differs from SQLite in only three ways:
    - placeholders are `$N`;
    - an input-folded predicate is `CASE WHEN $n THEN (P) WHEN NOT $n THEN (NOT P) END`, because Postgres has no boolean = integer, and a null input stays unknown as before;
    - every parameter carries the kind its context gives it (the compared column, boolean for a fold, text for a pattern).
  - The runtime is emitted for one dialect. Only that dialect's SQLx feature is a dependency (`postgres`, or `sqlite-bundled` with the pinned `libsqlite3-sys`).
- **SQLX-010 — a per-dialect column allowlist, by Drizzle `columnType`.**
  - SQLite: `SQLiteText`, `SQLiteInteger`, `SQLiteReal`, `SQLiteBoolean`.
  - Postgres: `PgText`, `PgVarchar`, `PgSmallInt`, `PgInteger`, `PgSerial`, `PgSmallSerial`, `PgBigInt53`, `PgBigSerial53`, `PgDoublePrecision`, `PgBoolean`.
  - Refused:
    - `real`: SQLx widens float4 to f64 while node-postgres parses its text, so `0.1` would differ;
    - `char`: blank-padded;
    - Postgres enums: a custom type SQLx will not decode as `String`;
    - `numeric`/`bigint` strings, dates, json and arrays.

    The first word of `dataType` still gives the kind.
  - This also tightens SQLite, which previously admitted any `string …`/`number …` data type.
- **SQLX-011 — typed binding.**
  - A parameter binds as its context's kind, and a null binds as a typed null of that kind.
  - A number binds as `i64` when it is a safe integer, otherwise as `f64`. Postgres compares int4/int8/float8 across types.
  - Writes bind each value by its column's kind. A ref's foreign key is text.
  - Cursor values are re-bound as decoded. Postgres decodes by wire type (TEXT, INT2/4/8, FLOAT8, BOOL), and other types fail as `Database query failed`.
- **SQLX-012 — transactions.**
  - Each mutation runs in `BEGIN ISOLATION LEVEL SERIALIZABLE` and commits or rolls back as on SQLite.
  - A serialization failure (SQLSTATE 40001) answers `Database query failed`, without a retry. Upstream offers none, a mutation source may be expensive, and the client can retry.
- **SQLX-013 — collation and case are the database's.**
  - Both servers run the same SQL on the same database, so order and `contains` folding come from its collation and agree by construction.
  - The tests create the database with `--locale-provider=builtin --builtin-locale=PG_UNICODE_FAST`, so order is by code point (as on SQLite) and `lower()` folds all of Unicode (unlike SQLite). Divergences from the JS evaluator are registered per database.
- **SQLX-014 — nullable sort columns stay refused on both dialects.** Upstream's keyset predicate is correct on Postgres, so admitting them there is a later widening with its own tests.
- **SQLX-015 — no TLS yet.**
  - Without a TLS feature, SQLx connects in plain text, and a URL with `sslmode=require` fails at connect.
  - A deployed showcase needs `tls-rustls-ring-webpki`. It will be added with the deployment, recorded as a reachable-capability dependency.
- **SQLX-016 — the reference store may be asynchronous.** `RemoteStoreApi` operations may return an `Effect`, so the Postgres oracle writes through `pg` inside its own serializable transaction. A failed write dies, matching the native abort.
- **SQLX-017 — validation by execution.**
  - Each Postgres test starts a throwaway `postgres:18.6-alpine` container on a loopback port, with a random password, and removes it afterwards.
  - It is skipped, with a printed reason, when Docker is unavailable.
  - The suites are the SQLite ones run against Postgres:
    - the planner against upstream's query source over `drizzle-orm/node-postgres`;
    - Read/Query wire steps;
    - mutation steps, including rollbacks;
    - the stock-client session.

### Known edges (not tested)

- A non-integral number compared with an integer column: node-postgres sends untyped text, so Postgres infers integer and refuses `2.5` (Database query failed), while SQLx sends float8 and compares numerically (no match). Inputs are schema-checked, so this needs a query whose input schema admits fractions against an integer column.
- Text containing NUL is refused by Postgres on both sides.

### Acceptance (step 5)

The SQLite acceptance, repeated over Postgres 18.6: planned SQL agrees with upstream's query source for the shared conformance cases and the tie-heavy set; Read/Query/Mutate match the official server over the wire; a stock client session matches; rollbacks leave no rows.

## Acceptance

- The milestone 5 acceptance from §22: the same queries agree in the JS evaluator, Drizzle/SQLite and Rust/SQLx, with every difference registered.
- Remote Read, Query and Mutate over SQLite match the Drizzle-backed official server over the wire.
- A stock `Remote.clientLayer` session over the native SQL server equals one over the official server.
- Driver errors leak no SQL. Interrupted mutations roll back.
