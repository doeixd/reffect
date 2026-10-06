# SQL in RPC handlers: `R.sql` and `R.SqlSchema` over SQLx

Checked 2026-10-06 against `effect` 4.0.0 (`effect/sql`), `@effect/sql-sqlite-node` 4.0.0 (on `node:sqlite`, Node 24.21), SQLx 0.9.0 (already pinned for [NativeRemote SQL](sqlx-remote.md)).

## Prior work

- [rpc-mvp](../rpc-mvp.md#id-make-rpc-the-driver-for-the-whole-roadmap), demo 5: "RPC handler uses compiled SQL service → SQLx/Postgres". [Open work](../open-work.md) lists it among unbuilt demos.
- [sqlx-remote](sqlx-remote.md) and `runtime/src/remote_sql.rs`: a SQLx pool per dialect, opened from a URL read at run time (`databaseUrlEnv`), never compiled in. Its dialect modules (`sql_sqlite.rs`, `sql_postgres.rs`) are reused.
- `R.RemoteStore` (RS-001..007): the pattern for an async effect backed by an execution-context service natively and a host service in the reference.
- [config-cache-modules](config-cache-modules.md) POOL-002: SQLx's pool is used directly for a SQL service declaring SQLx semantics, without claiming Effect.Pool parity.
- Contract codecs (`contract-codec.ts`) already decode unknown JSON into admitted witnesses with Effect's exact `SchemaError` text (`formatIssue`).

## Sources

- `effect/sql` 4.0.0: `SqlClient` (the tagged template `sql\`...\``from`yield* SqlClient.SqlClient`), `SqlSchema.findAll | findNonEmpty | findOne | findOneOption | void` (`{ Request, Result, execute }`; the request is encoded with `Request`, rows decoded with `Schema.Array(Result)`or`Result`), `SqlError { reason }`with eleven reason classes carrying`message?`, `operation?`and a`cause` defect (`UniqueViolation`adds`constraint`), and `classifySqliteError`.
- `@effect/sql-sqlite-node` 4.0.0 `SqliteClient`: a `node:sqlite` `DatabaseSync`, `?` placeholders, values passed through unchanged, `.all()` for statements with columns and `[]` otherwise, prepare and execute failures classified with fixed messages.

### Probe (official client, 2026-10-06)

| Statement                             | Official result                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| insert, update, delete                | `[]`                                                                                                                    |
| duplicate primary key                 | `SqlError`, reason `ConstraintError`, `"Failed to execute statement"`, `"execute"` (not `UniqueViolation`: see SQL-004) |
| NOT NULL violation                    | `ConstraintError`, execute                                                                                              |
| syntax error; missing table           | `UnknownError`, `"Failed to prepare statement"`, `"prepare"`                                                            |
| boolean parameter                     | bound as `1`/`0`                                                                                                        |
| bigint parameter                      | bound as an integer                                                                                                     |
| number parameter (`1`, `1.5`)         | bound as REAL: `typeof` is `real`, `${1} \|\| ''` is `"1.0"`; NaN becomes NULL                                          |
| bigint parameter above i64::MAX       | `UnknownError`, execute (`BigInt value is too large to bind.`)                                                          |
| integer result beyond ±2^53−1         | `UnknownError`, execute                                                                                                 |
| INTEGER, REAL, TEXT, NULL, BLOB cells | number, number, string, `null`, `Uint8Array`                                                                            |
| `findAll` decode failure              | `SchemaError`, message `Expected number\n  at [0]["id"]`                                                                |
| `findOne` with no row                 | `NoSuchElementError`                                                                                                    |
| `findOneOption`                       | `Some(row)` / `None`                                                                                                    |

## Decisions

- **SQL-001 Authoring mirrors `effect/sql`.**
  - `R.sql\`select ... where id = ${id}\``stands for`sql`from`yield* SqlClient.SqlClient`. It is a computation yielding the rows as `Array<Unknown>`.
  - Interpolations are values only, bound as `?` parameters. The statement text is fixed at build time.
  - Admitted parameter witnesses: String, Number (bound as REAL, as SQLx binds an f64), U64 (bound as INTEGER; above i64::MAX it fails as the client does), Bool (1/0), and `NullOr` of these. Identifier fragments, `sql.in`, `sql.insert` and the other helpers are open.
  - `R.SqlSchema.findAll | findOne | findOneOption | void` take `{ Request, Result, execute }` as R witnesses, and return a function from the request to a computation.
  - `Request` and `Result` are witnesses whose encoded and type sides agree: Structs of String, Number, Bool, Literals and `NullOr` of these.
- **SQL-002 One primitive node.** `SqlExecute { sql, params }` is the only new effect node. `SqlSchema` functions are R compositions over it: execute, then decode with a message-producing decode operation, then fail or map. Reference and native share that structure.
- **SQL-003 Error channel.** Every SQL computation fails with one witness, `R.SqlSchema.Error`, a tagged union:
  - `SqlError { reason }`, where `reason` is a tagged union of the eleven reason tags, each with `message` and `operation`;
  - `SchemaError { message }`;
  - `NoSuchElementError {}`.

  Effect types these more narrowly per function (a bare statement fails only with `SqlError`). R cannot widen error unions yet (RESULT-001), so the narrower typing is a recorded boundary. Values are plain data, like `R.Option` and `R.Result`: the reason's `cause` and the error classes' prototypes are not represented.

- **SQL-004 Classification ported from the pinned client.** Native SQLite errors are classified as `classifySqliteError` sees `node:sqlite`'s errors. The string code `ERR_SQLITE_ERROR` never matches, so the primary result code (`errcode & 0xff`) decides:
  - 23 → `AuthenticationError`;
  - 3 → `AuthorizationError`;
  - 19 → `ConstraintError`;
  - 5 or 6 → `LockTimeoutError`;
  - 14 → `ConnectionError`;
  - anything else → `UnknownError`.

  Messages and operations are the client's fixed strings. Native code prepares the statement first, so prepare and execute failures are told apart as the client does.

- **SQL-005 Row values as `node:sqlite` returns them.**
  - INTEGER becomes a number when it is within ±(2^53−1); beyond that it is an `UnknownError` at execute, as the client reports it.
  - REAL becomes a number, TEXT a string, NULL `null`.
  - A BLOB cell is a defect natively (divergence SQL-D1), since rows are read through the admitted witnesses and none admits bytes.
- **SQL-006 Decoding.** Rows are decoded on the type side of `Result`, not its JSON codec. A TEXT `"NaN"` in a Number field therefore fails, as `Schema.Number` does. Failures carry Effect's formatter text, generated from the verified contract codecs. `findAll` reports paths from `[i]`, the others from the row itself.
- **SQL-007 Serving.** `NativeRpc.compile(group, bindings, { sql: { dialect: "sqlite", databaseUrlEnv } })` gives the asynchronous server one SQLx pool. A handler reaching `R.sql` without that option is refused. Each statement runs on the pool in autocommit. `sql.withTransaction`, Postgres (whose driver maps `int8`/`numeric` to strings) and streaming results are later slices.
- **SQL-008 Reference.** The reference runs `SqlExecute` through the official `SqlClient` from the context (`sql.unsafe(text, params)`), so the oracle is `@effect/sql-sqlite-node` itself. It maps the client's failures to the plain error data of SQL-003.

## Divergences

- **SQL-D1:** a BLOB cell reaching a native row read is a defect; officially it is a `Uint8Array` that the `Result` decode then rejects or accepts.
- **SQL-D2:** native SQLite connections come from SQLx's pool rather than one `DatabaseSync` per client. Statement results and classification agree; concurrent writers may see `SQLITE_BUSY` timing differences (busy timeout 5 s on both).

## Order of work and acceptance

1. **Authoring, IR and reference.** `R.sql`, `R.SqlSchema` and the error witness, with reference runs over the official SQLite client. Acceptance: for each probe row above, the R program's reference result equals the plain-data projection of the direct Effect program's result.
2. **Native.** The SQLx execution path, classification, row conversion, decoding and the `sql` compile option. Acceptance: a contract with `findAll`, `findOneOption`, `findOne`, `void`, a constraint failure and a decode failure is served natively, and the stock client gets the same answers as from the official `RpcServer` running the reference handlers over the same seeded database.
3. **Example and docs.** An `examples/rpc-sql` entry built with `reffect build`; README and package docs; divergences recorded.

## Open

- Postgres (`@effect/sql-pg` 4.0.0 value mapping), transactions (`withTransaction`), `sql.in`/`insert`/identifiers, `findNonEmpty`, streams (`SqlStream`), resolvers (`SqlResolver`), migrations.
