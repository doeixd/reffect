// Postgres, the dialect `remote_sql` is compiled with (SQLX-009): a child module, so it reads the
// row and cell types of its parent.
use super::{Cell, DbRow};
use sqlx::{Row, TypeInfo, ValueRef};

pub(super) type Db = sqlx::Postgres;
/// Runtime-built statements number their placeholders `$1`, `$2`, ...
pub(super) const PLACEHOLDER: &str = "$";
pub(super) const BEGIN: &str = "BEGIN ISOLATION LEVEL SERIALIZABLE";
pub(super) fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
/// Postgres values are typed on the wire; only the admitted column types decode (SQLX-010).
pub(super) fn decode(row: &DbRow, index: usize) -> Result<Cell, sqlx::Error> {
    let raw = row.try_get_raw(index)?;
    let name = raw.type_info().name().to_string();
    Ok(match name.as_str() {
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" => Cell::Text(row.try_get(index)?),
        "INT2" => Cell::Integer(row.try_get::<i16, _>(index)? as i64),
        "INT4" => Cell::Integer(row.try_get::<i32, _>(index)? as i64),
        "INT8" => Cell::Integer(row.try_get(index)?),
        "FLOAT8" => Cell::Real(row.try_get(index)?),
        "BOOL" => Cell::Bool(row.try_get(index)?),
        other => {
            return Err(sqlx::Error::Decode(
                format!("unsupported column type {}", other).into(),
            ))
        }
    })
}
