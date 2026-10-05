use super::remote_engine::{Boundary, EntityRecord, JsObject, PageIds, Source, Window};
use serde_json::Value;
use sqlx::{Row, ValueRef};

type Db = dialect::Db;
type DbPool = sqlx::Pool<Db>;
type DbRow = <Db as sqlx::Database>::Row;
/// The n-th (1-based) placeholder of runtime-built statements.
fn placeholder(n: usize) -> String {
    format!("{}{}", dialect::PLACEHOLDER, n)
}
fn quote(name: &str) -> String {
    dialect::quote(name)
}

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Text,
    Number,
    Boolean,
}
pub struct Column {
    pub field: &'static str,
    pub column: &'static str,
    pub kind: Kind,
}
/// A one relation: the owner's foreign key, read back as Target:id.
pub struct One {
    pub field: &'static str,
    pub column: &'static str,
    pub target: &'static str,
}
pub struct Entity {
    pub name: &'static str,
    pub table: &'static str,
    pub id: &'static str,
    pub columns: &'static [Column],
    pub relations: &'static [One],
}
/// A statement parameter, bound per request (sql-plan.ts SqlParam).
pub enum Param {
    /// An input, bound as the kind its context gives it (SQLX-011).
    Input(&'static str, Kind),
    Text(&'static str),
    Number(f64),
    Bool(bool),
    Null(Kind),
    /// upstream escapeLike over an input or a literal search; None stays null.
    PatternInput(&'static str),
    PatternText(&'static str),
    Cursor(usize),
    CursorId,
    Limit,
}
pub struct Statement {
    pub sql: &'static str,
    pub params: &'static [Param],
}
pub struct Query {
    pub name: &'static str,
    pub entity: &'static str,
    pub valid: fn(&Value) -> bool,
    pub cursor_row: Statement,
    pub forward: Statement,
    pub forward_after: Statement,
    pub backward: Statement,
    pub backward_before: Statement,
}
pub struct Sql {
    pub entities: &'static [Entity],
    pub queries: &'static [Query],
    pub url_env: &'static str,
    pub pool: std::sync::OnceLock<Option<DbPool>>,
}

const FAILED: &str = "Database query failed";
const DEFAULT_PAGE_SIZE: f64 = 20.0;
const MAX_PAGE_SIZE: f64 = 100.0;

/// A value as the database holds it, decoded by its type and bound back the same way.
#[derive(Clone)]
enum Cell {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Bool(bool),
}
fn cell(row: &DbRow, index: usize) -> Result<Cell, sqlx::Error> {
    let raw = row.try_get_raw(index)?;
    if raw.is_null() {
        return Ok(Cell::Null);
    }
    dialect::decode(row, index)
}
fn text_of(cell: &Cell) -> String {
    match cell {
        Cell::Text(text) => text.clone(),
        Cell::Integer(n) => n.to_string(),
        Cell::Real(x) => x.to_string(),
        Cell::Bool(flag) => flag.to_string(),
        Cell::Null => String::new(),
    }
}
/// A JS number as the JSON wire writes it: safe integers without a fraction (NUM-004 applies).
fn number(x: f64) -> Value {
    if x == 0.0 {
        return Value::from(0);
    }
    if x.fract() == 0.0 && x.abs() < 9007199254740992.0 {
        return Value::from(x as i64);
    }
    serde_json::Number::from_f64(x)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}
/// What Drizzle's column mapping hands upstream: text, a JS number, or a boolean.
fn json_of(cell: &Cell, kind: Kind) -> Value {
    match (cell, kind) {
        (Cell::Null, _) => Value::Null,
        (Cell::Bool(flag), _) => Value::Bool(*flag),
        (Cell::Integer(n), Kind::Boolean) => Value::Bool(*n != 0),
        (Cell::Integer(n), _) => number(*n as f64),
        (Cell::Real(x), _) => number(*x),
        (Cell::Text(text), _) => Value::String(text.clone()),
    }
}

type Query1<'q> = sqlx::query::Query<'q, Db, <Db as sqlx::Database>::Arguments>;
/// A null of the kind its context expects: Postgres will not assign a text null to a number.
fn bind_null<'q>(query: Query1<'q>, kind: Kind) -> Query1<'q> {
    match kind {
        Kind::Text => query.bind(Option::<String>::None),
        Kind::Number => query.bind(Option::<f64>::None),
        Kind::Boolean => query.bind(Option::<bool>::None),
    }
}
/// A JSON value by its own type; a safe integer binds as an integer, as the JS drivers send it.
fn bind_json<'q>(query: Query1<'q>, value: Option<&Value>, kind: Kind) -> Query1<'q> {
    match value {
        Some(Value::String(text)) => query.bind(text.clone()),
        Some(Value::Bool(flag)) => query.bind(*flag),
        Some(Value::Number(n)) => {
            let x = n.as_f64().unwrap_or(f64::NAN);
            if x.fract() == 0.0 && x.abs() < 9007199254740992.0 {
                query.bind(x as i64)
            } else {
                query.bind(x)
            }
        }
        _ => bind_null(query, kind),
    }
}
fn bind_cell<'q>(query: Query1<'q>, cell: &Cell) -> Query1<'q> {
    match cell {
        Cell::Null => query.bind(Option::<String>::None),
        Cell::Bool(flag) => query.bind(*flag),
        Cell::Integer(n) => query.bind(*n),
        Cell::Real(x) => query.bind(*x),
        Cell::Text(text) => query.bind(text.clone()),
    }
}
/// upstream escapeLike: backslash, percent and underscore are escaped with a backslash.
fn like_pattern(search: &str) -> String {
    let mut out = String::from("%");
    for c in search.chars() {
        if c == '\\' || c == '%' || c == '_' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}
struct Bindings<'a> {
    input: &'a Value,
    cursor: &'a [Cell],
    cursor_id: &'a str,
    limit: i64,
}
fn bound<'q>(statement: &'q Statement, values: &Bindings) -> Query1<'q> {
    let mut query = sqlx::query(statement.sql);
    for param in statement.params {
        query = match param {
            Param::Input(key, kind) => bind_json(query, values.input.get(*key), *kind),
            Param::Text(text) => query.bind(*text),
            Param::Number(x) => bind_json(
                query,
                serde_json::Number::from_f64(*x).map(Value::Number).as_ref(),
                Kind::Number,
            ),
            Param::Bool(flag) => query.bind(*flag),
            Param::Null(kind) => bind_null(query, *kind),
            Param::PatternInput(key) => match values.input.get(*key).and_then(Value::as_str) {
                Some(search) => query.bind(like_pattern(search)),
                None => query.bind(Option::<String>::None),
            },
            Param::PatternText(search) => query.bind(like_pattern(search)),
            Param::Cursor(index) => {
                bind_cell(query, values.cursor.get(*index).unwrap_or(&Cell::Null))
            }
            Param::CursorId => query.bind(values.cursor_id.to_string()),
            Param::Limit => query.bind(values.limit),
        };
    }
    query
}

impl Sql {
    fn pool(&self) -> Result<&DbPool, String> {
        let pool = self.pool.get_or_init(|| {
            let url = std::env::var(self.url_env).unwrap_or_default();
            match sqlx::pool::PoolOptions::<Db>::new().connect_lazy(&url) {
                Ok(pool) => Some(pool),
                Err(error) => {
                    eprintln!(
                        "[reffect] database {} is not usable: {}",
                        self.url_env, error
                    );
                    None
                }
            }
        });
        pool.as_ref().ok_or_else(|| FAILED.to_string())
    }
    /// At startup: the database URL is set and usable, so a misconfigured server exits rather
    /// than answering every request "Database query failed" (#26).
    pub fn ready(&self) -> Result<(), String> {
        if std::env::var_os(self.url_env).is_none() {
            return Err(format!("{} is not set", self.url_env));
        }
        self.pool()
            .map(|_| ())
            .map_err(|_| format!("{} is not a usable database URL", self.url_env))
    }
    fn entity(&self, name: &str) -> Option<&'static Entity> {
        self.entities.iter().find(|entity| entity.name == name)
    }
}
// Every driver failure is logged and answered without SQL or schema, as upstream's selectRows.
fn failed(error: sqlx::Error) -> String {
    eprintln!("[reffect] database query failed: {}", error);
    FAILED.to_string()
}

/// One mutation's transaction (SQLX-006, SQLX-012): writes of exactly the given columns,
/// deletes by id, then commit or roll back. A failed statement records its reason.
pub struct Session {
    entities: &'static [Entity],
    tx: tokio::sync::Mutex<Option<sqlx::Transaction<'static, Db>>>,
    failure: std::sync::Mutex<Option<String>>,
    /// Effects visible outside the transaction, held until it commits (LIVE-003, LIVE-008).
    deferred: std::sync::Mutex<Vec<Deferred>>,
}
/// An action run once the transaction's writes are visible.
pub type Deferred =
    Box<dyn FnOnce() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send>;
impl Sql {
    pub async fn begin(&'static self) -> Result<Session, String> {
        let tx = self
            .pool()?
            .begin_with(dialect::BEGIN)
            .await
            .map_err(failed)?;
        Ok(Session {
            entities: self.entities,
            tx: tokio::sync::Mutex::new(Some(tx)),
            failure: std::sync::Mutex::new(None),
            deferred: std::sync::Mutex::new(Vec::new()),
        })
    }
}
impl Session {
    fn fail(&self, message: String) -> String {
        *self
            .failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(message.clone());
        message
    }
    pub fn failure(&self) -> Option<String> {
        self.failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
    fn entity(&self, name: &str) -> Result<&'static Entity, String> {
        self.entities
            .iter()
            .find(|entity| entity.name == name)
            .ok_or_else(|| {
                eprintln!("[reffect] the store has no table for {}", name);
                FAILED.to_string()
            })
    }
    /// Runs one statement in the transaction; the rows it changed.
    async fn run(&self, query: Query1<'_>) -> Result<u64, String> {
        let mut guard = self.tx.lock().await;
        let Some(tx) = guard.as_mut() else {
            return Err(FAILED.to_string());
        };
        query
            .execute(&mut **tx)
            .await
            .map(|done| done.rows_affected())
            .map_err(failed)
    }
    /// The row as the wire holds it (RS-007): every column by kind and each foreign key as a
    /// Target:id ref, read in this transaction.
    pub async fn get(&self, entity: &str, id: &str) -> Result<Option<Value>, String> {
        let result = self.get_now(entity, id).await;
        result.map_err(|message| self.fail(message))
    }
    async fn get_now(&self, entity: &str, id: &str) -> Result<Option<Value>, String> {
        let entity = self.entity(entity)?;
        let columns: Vec<String> = entity
            .columns
            .iter()
            .map(|column| quote(column.column))
            .chain(entity.relations.iter().map(|one| quote(one.column)))
            .collect();
        // Identifiers come from build-time storage; the ID is bound.
        let sql = format!(
            "SELECT {} FROM {} WHERE {} = {}",
            columns.join(", "),
            quote(entity.table),
            quote(entity.id),
            placeholder(1)
        );
        let mut guard = self.tx.lock().await;
        let Some(tx) = guard.as_mut() else {
            return Err(FAILED.to_string());
        };
        let Some(row) = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(id.to_string())
            .fetch_optional(&mut **tx)
            .await
            .map_err(failed)?
        else {
            return Ok(None);
        };
        let mut object = serde_json::Map::new();
        for (index, column) in entity.columns.iter().enumerate() {
            object.insert(
                column.field.to_string(),
                json_of(&cell(&row, index).map_err(failed)?, column.kind),
            );
        }
        for (offset, one) in entity.relations.iter().enumerate() {
            let value = match cell(&row, entity.columns.len() + offset).map_err(failed)? {
                Cell::Null => Value::Null,
                key => Value::String(format!("{}:{}", one.target, text_of(&key))),
            };
            object.insert(one.field.to_string(), value);
        }
        Ok(Some(Value::Object(object)))
    }
    /// MemoryStore.write per column: the row becomes { ...existing, id, ...values }.
    pub async fn write(&self, entity: &str, id: &str, values: Value) -> Result<(), String> {
        let result = self.write_now(entity, id, values).await;
        result.map_err(|message| self.fail(message))
    }
    async fn write_now(&self, entity: &str, id: &str, values: Value) -> Result<(), String> {
        let entity = self.entity(entity)?;
        let Value::Object(values) = values else {
            return Err(FAILED.to_string());
        };
        let mut columns: Vec<String> = Vec::new();
        let mut bound: Vec<(Value, Kind)> = Vec::new();
        for (field, value) in values {
            if field == "id" {
                continue;
            }
            if let Some(column) = entity.columns.iter().find(|column| column.field == field) {
                // A column holds a scalar: an object or array has no binding, and binding it as
                // NULL would store a value the mutation never wrote (#26).
                if value.is_object() || value.is_array() {
                    eprintln!("[reffect] {}.{} is not a scalar", entity.name, field);
                    return Err(FAILED.to_string());
                }
                columns.push(quote(column.column));
                bound.push((value, column.kind));
            } else if let Some(one) = entity.relations.iter().find(|one| one.field == field) {
                // A ref Target:id stores the target's id in the foreign key.
                let key = match &value {
                    Value::Null => Value::Null,
                    Value::String(reference) => match reference.split_once(':') {
                        Some((target, key)) if target == one.target => {
                            Value::String(key.to_string())
                        }
                        _ => {
                            eprintln!("[reffect] {} is not a {} ref", reference, one.target);
                            return Err(FAILED.to_string());
                        }
                    },
                    _ => return Err(FAILED.to_string()),
                };
                columns.push(quote(one.column));
                bound.push((key, Kind::Text));
            } else {
                eprintln!("[reffect] {} has no column for {}", entity.name, field);
                return Err(FAILED.to_string());
            }
        }
        // { ...existing, id, ...values }: an existing row takes only the given columns. An upsert
        // cannot do this on SQLite, which checks NOT NULL on the inserted row before ON CONFLICT.
        // Identifiers come from build-time storage; every value is bound.
        let table = quote(entity.table);
        let update = if columns.is_empty() {
            format!(
                "UPDATE {} SET {} = {} WHERE {} = {}",
                table,
                quote(entity.id),
                quote(entity.id),
                quote(entity.id),
                placeholder(1)
            )
        } else {
            let sets: Vec<String> = columns
                .iter()
                .enumerate()
                .map(|(i, column)| format!("{} = {}", column, placeholder(i + 2)))
                .collect();
            format!(
                "UPDATE {} SET {} WHERE {} = {}",
                table,
                sets.join(", "),
                quote(entity.id),
                placeholder(1)
            )
        };
        let mut query = sqlx::query(sqlx::AssertSqlSafe(update)).bind(id.to_string());
        for (value, kind) in &bound {
            query = bind_json(query, Some(value), *kind);
        }
        if self.run(query).await? > 0 {
            return Ok(());
        }
        // A new row goes in with exactly the given columns; a missing NOT NULL column fails.
        let names: Vec<String> = std::iter::once(quote(entity.id))
            .chain(columns.iter().cloned())
            .collect();
        let placeholders: Vec<String> = (1..=names.len()).map(placeholder).collect();
        let insert = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            table,
            names.join(", "),
            placeholders.join(", ")
        );
        let mut query = sqlx::query(sqlx::AssertSqlSafe(insert)).bind(id.to_string());
        for (value, kind) in &bound {
            query = bind_json(query, Some(value), *kind);
        }
        self.run(query).await.map(|_| ())
    }
    /// MemoryStore.remove: deleting an absent row changes nothing.
    pub async fn remove(&self, entity: &str, id: &str) -> Result<(), String> {
        let result = async {
            let entity = self.entity(entity)?;
            let sql = format!(
                "DELETE FROM {} WHERE {} = {}",
                quote(entity.table),
                quote(entity.id),
                placeholder(1)
            );
            self.run(sqlx::query(sqlx::AssertSqlSafe(sql)).bind(id.to_string()))
                .await
                .map(|_| ())
        }
        .await;
        result.map_err(|message| self.fail(message))
    }
    pub fn defer(&self, action: Deferred) {
        self.deferred
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(action);
    }
    /// Commits, then runs the deferred actions in order; a rollback, or a failed commit,
    /// drops them.
    pub async fn finish(&self, commit: bool) -> Result<(), String> {
        let Some(tx) = self.tx.lock().await.take() else {
            return Ok(());
        };
        if !commit {
            return tx.rollback().await.map_err(failed);
        }
        tx.commit().await.map_err(failed)?;
        let deferred = std::mem::take(
            &mut *self
                .deferred
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
        for action in deferred {
            action().await;
        }
        Ok(())
    }
}

impl Source for Sql {
    fn has_source(&self, entity: &str) -> bool {
        self.entity(entity).is_some()
    }
    fn declares(&self, entity: &str, field: &str) -> bool {
        self.entity(entity).is_some_and(|entity| {
            entity.columns.iter().any(|column| column.field == field)
                || entity.relations.iter().any(|one| one.field == field)
        })
    }
    async fn read(
        &self,
        entity: &str,
        ids: &[String],
        fields: &[String],
        windows: &Option<JsObject<Window>>,
    ) -> Result<Vec<EntityRecord>, String> {
        let Some(entity) = self.entity(entity) else {
            return Ok(Vec::new());
        };
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        // selectColumns: the id first, then each requested column or foreign key in request order.
        enum Selected {
            Column(&'static Column),
            One(&'static One),
        }
        let selected: Vec<(&String, Selected)> = fields
            .iter()
            .filter_map(|field| {
                if let Some(column) = entity
                    .columns
                    .iter()
                    .find(|column| column.field == field.as_str())
                {
                    return Some((field, Selected::Column(column)));
                }
                entity
                    .relations
                    .iter()
                    .find(|one| one.field == field.as_str())
                    .map(|one| (field, Selected::One(one)))
            })
            .collect();
        if selected.is_empty() {
            return Ok(Vec::new());
        }
        let columns: Vec<String> = std::iter::once(quote(entity.id))
            .chain(selected.iter().map(|(_, selected)| match selected {
                Selected::Column(column) => quote(column.column),
                Selected::One(one) => quote(one.column),
            }))
            .collect();
        let placeholders: Vec<String> = (1..=ids.len()).map(placeholder).collect();
        // The generated text holds placeholders only; every value is bound.
        let sql = format!(
            "select {} from {} where {}.{} in ({})",
            columns.join(", "),
            quote(entity.table),
            quote(entity.table),
            quote(entity.id),
            placeholders.join(", ")
        );
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
        for id in ids {
            query = query.bind(id.clone());
        }
        let rows = query.fetch_all(self.pool()?).await.map_err(failed)?;
        for (field, selected) in &selected {
            if let Selected::One(_) = selected {
                if windows
                    .as_ref()
                    .and_then(|windows| windows.get(field.as_str()))
                    .is_some()
                {
                    return Err(format!(
                        "Relation \"{}\" is singular and cannot be windowed",
                        field
                    ));
                }
            }
        }
        let mut records = Vec::with_capacity(rows.len());
        for row in &rows {
            let id = text_of(&cell(row, 0).map_err(failed)?);
            let mut values = JsObject::new();
            for (index, (field, selected)) in selected.iter().enumerate() {
                let value = cell(row, index + 1).map_err(failed)?;
                let json = match selected {
                    Selected::Column(column) => json_of(&value, column.kind),
                    Selected::One(one) => match value {
                        Cell::Null => Value::Null,
                        other => Value::String(format!("{}:{}", one.target, text_of(&other))),
                    },
                };
                values.set((*field).clone(), json);
            }
            records.push(EntityRecord { id, values });
        }
        Ok(records)
    }
    fn check_query(&self, query: &str, input: &Value) -> Result<&'static str, String> {
        let Some(def) = self.queries.iter().find(|def| def.name == query) else {
            return Err(format!("Unknown query: {}", query));
        };
        if !(def.valid)(input) {
            return Err("Invalid query input".to_string());
        }
        Ok(def.entity)
    }
    async fn page(&self, query: &str, input: &Value, window: &Window) -> Result<PageIds, String> {
        let Some(def) = self.queries.iter().find(|def| def.name == query) else {
            return Err(format!("Unknown query: {}", query));
        };
        if (window.after.is_some() && window.before.is_some())
            || (window.first.is_some() && window.last.is_some())
        {
            return Err(
                "A query window cannot combine after with before, or first with last".to_string(),
            );
        }
        // foldkit-remote-drizzle 0.9.1 refuses a search holding NUL, which SQL text cannot hold
        // portably. Upstream throws it as a defect; a client's input answers a typed refusal here.
        let nul = def.forward.params.iter().any(|param| matches!(param, Param::PatternInput(key) if input.get(*key).and_then(Value::as_str).is_some_and(|search| search.contains('\0'))));
        if nul {
            return Err(format!("[foldkit-remote-drizzle] query \"{}\" searches for text holding a NUL character, which SQL text cannot hold portably", def.name));
        }
        // shapeWindow
        let requested = window.first.or(window.last);
        let size = match requested {
            Some(n) if n.is_finite() && n.fract() == 0.0 && n >= 0.0 => n,
            _ => DEFAULT_PAGE_SIZE,
        }
        .min(MAX_PAGE_SIZE) as i64;
        let backward = window.before.is_some() || window.last.is_some();
        let cursor = if backward {
            window.before.clone()
        } else {
            window.after.clone()
        };
        let pool = self.pool()?;
        let mut values = Bindings {
            input,
            cursor: &[],
            cursor_id: "",
            limit: size + 1,
        };
        let cursor_cells: Vec<Cell>;
        let statement = match &cursor {
            None => {
                if backward {
                    &def.backward
                } else {
                    &def.forward
                }
            }
            Some(id) => {
                values.cursor_id = id;
                let row = bound(&def.cursor_row, &values)
                    .fetch_optional(pool)
                    .await
                    .map_err(failed)?;
                let Some(row) = row else {
                    return Err("The query cursor no longer resolves to a row".to_string());
                };
                cursor_cells = (0..row.len())
                    .map(|index| cell(&row, index))
                    .collect::<Result<_, _>>()
                    .map_err(failed)?;
                values.cursor = &cursor_cells;
                if backward {
                    &def.backward_before
                } else {
                    &def.forward_after
                }
            }
        };
        let rows = bound(statement, &values)
            .fetch_all(pool)
            .await
            .map_err(failed)?;
        let mut ids: Vec<String> = rows
            .iter()
            .map(|row| cell(row, 0).map(|id| text_of(&id)))
            .collect::<Result<_, _>>()
            .map_err(failed)?;
        if backward {
            ids.reverse();
        }
        // buildPage and toQueryPage
        let page_size = size as usize;
        let has_more = ids.len() > page_size;
        let limited: Vec<String> = if backward {
            ids[ids.len().saturating_sub(page_size)..].to_vec()
        } else {
            ids.into_iter().take(page_size).collect()
        };
        let has_next = if backward { cursor.is_some() } else { has_more };
        let has_previous = if backward { has_more } else { cursor.is_some() };
        let first = limited.first().cloned();
        let last = limited.last().cloned();
        let (start, end) = if backward {
            (
                match (has_previous, first) {
                    (true, Some(id)) => Boundary::Cursor(id),
                    _ => Boundary::Terminal,
                },
                match &cursor {
                    Some(id) => Boundary::Cursor(id.clone()),
                    None => Boundary::Terminal,
                },
            )
        } else {
            (
                match &cursor {
                    Some(id) => Boundary::Cursor(id.clone()),
                    None => Boundary::Terminal,
                },
                match (has_next, last) {
                    (true, Some(id)) => Boundary::Cursor(id),
                    _ => Boundary::Terminal,
                },
            )
        };
        Ok(PageIds {
            ids: limited,
            start,
            end,
        })
    }
}
