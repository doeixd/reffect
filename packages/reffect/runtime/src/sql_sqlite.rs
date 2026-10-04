// SQLite, the dialect `remote_sql` is compiled with (SQLX-009): a child module, so it reads the
// row and cell types of its parent.
use super::{Cell, DbRow};
use sqlx::{Row, TypeInfo, ValueRef};

pub(super) type Db = sqlx::Sqlite;
/// Runtime-built statements number their placeholders `?1`, `?2`, ...
pub(super) const PLACEHOLDER: &str = "?";
pub(super) const BEGIN: &str = "BEGIN IMMEDIATE";
/// Backticks: an unknown double-quoted name is a string literal in SQLite (DQS), so a missing
/// column would read as its own name instead of failing.
pub(super) fn quote(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}
/// SQLx's SQLite decoder is strict, so a value is read by its storage class.
pub(super) fn decode(row: &DbRow, index: usize) -> Result<Cell, sqlx::Error> {
    let raw = row.try_get_raw(index)?;
    let class = raw.type_info().name().to_string();
    Ok(match class.as_str() {
        "INTEGER" => Cell::Integer(row.try_get(index)?),
        "REAL" => Cell::Real(row.try_get(index)?),
        "TEXT" => Cell::Text(row.try_get(index)?),
        _ => Cell::Null,
    })
}
