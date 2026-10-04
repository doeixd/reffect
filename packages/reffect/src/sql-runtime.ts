import type { SqlDialect } from "./sql-plan.ts";
import { RuntimeSources } from "./runtime-sources.generated.ts";

/**
 * The native SQL source (SQLX-004, SQLX-005, SQLX-009): a `remote_engine::Source` over SQLx and
 * one dialect (SQLite or Postgres), running the statements `sql-plan.ts` fixed at build time. Reads, window shaping and page
 * boundaries port `foldkit-remote-drizzle` 0.9.0's `source` and `query` (`shapeWindow`, `buildPage`,
 * `toQueryPage`). Upstream: foldkit-plus `packages/remote-drizzle/src`, MIT, Copyright (c) 2026
 * Patrick Glenn; its keyset logic is adapted from fate (MIT, Nakazawa Tech).
 */
export const sqlRuntime = (dialect: SqlDialect): string =>
  // The shared source in runtime/src/remote_sql.rs, with its dialect (sql_sqlite.rs or
  // sql_postgres.rs) as a child module (#37).
  `
mod remote_sql {
${RuntimeSources.remote_sql}
mod dialect {
${dialect === "sqlite" ? RuntimeSources.sql_sqlite : RuntimeSources.sql_postgres}}
}
`;
