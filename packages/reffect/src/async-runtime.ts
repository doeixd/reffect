import {
  runtimeServiceFields,
  runtimeServiceInitializers,
  runtimeServiceMethods,
} from "./runtime-services.ts";
import type { RuntimeServiceUsage } from "./runtime-services.ts";
/** The SQL parameter and service declarations (SQL-001, SQL-007). */
const sqlRuntime = `/// One SQL parameter (SQL-001), as SQLite binds the JavaScript value.
#[derive(Clone, Debug)]
pub enum SqlParam { Null, Text(String), Real(f64), Integer(u64), Bool(bool) }
pub trait IntoSqlParam { fn into_sql_param(self) -> SqlParam; }
impl IntoSqlParam for String { fn into_sql_param(self) -> SqlParam { SqlParam::Text(self) } }
impl IntoSqlParam for &String { fn into_sql_param(self) -> SqlParam { SqlParam::Text(self.clone()) } }
impl IntoSqlParam for &str { fn into_sql_param(self) -> SqlParam { SqlParam::Text(self.to_string()) } }
impl IntoSqlParam for f64 { fn into_sql_param(self) -> SqlParam { SqlParam::Real(self) } }
impl IntoSqlParam for &f64 { fn into_sql_param(self) -> SqlParam { SqlParam::Real(*self) } }
impl IntoSqlParam for u64 { fn into_sql_param(self) -> SqlParam { SqlParam::Integer(self) } }
impl IntoSqlParam for &u64 { fn into_sql_param(self) -> SqlParam { SqlParam::Integer(*self) } }
impl IntoSqlParam for bool { fn into_sql_param(self) -> SqlParam { SqlParam::Bool(self) } }
impl IntoSqlParam for &bool { fn into_sql_param(self) -> SqlParam { SqlParam::Bool(*self) } }
impl<T: IntoSqlParam> IntoSqlParam for Option<T> {
    fn into_sql_param(self) -> SqlParam { self.map_or(SqlParam::Null, IntoSqlParam::into_sql_param) }
}
impl<'a, T> IntoSqlParam for &'a Option<T> where &'a T: IntoSqlParam {
    fn into_sql_param(self) -> SqlParam { self.as_ref().map_or(SqlParam::Null, IntoSqlParam::into_sql_param) }
}
pub type SqlFuture<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = serde_json::Value> + Send + 'a>>;
/// The SQL service a host serves (SQL-007): one statement, from its literal segments and
/// parameters, answered as its outcome data, the rows or the classified SqlError.
pub trait SqlService: Send + Sync {
    fn execute<'a>(&'a self, segments: &'static [&'static str], params: Vec<SqlParam>) -> SqlFuture<'a>;
}
`;
/** Audited execution scaffold. Logging and failure storage are selected by reachability/policy. */
export const asyncRuntime = (
  logging: boolean,
  frames: boolean,
  scopeDepth = 0,
  scopeCapacity = 0,
  launch?: string,
  store = false,
  services: RuntimeServiceUsage = { clock: false, random: false },
  taskGroups = false,
  streams = false,
  fallibleGroups = false,
  sql = false,
): string => `
#[derive(Debug)]
pub enum AsyncError<E> { Fail(E), Interrupted${fallibleGroups ? ", Combined(RuntimeCause)" : ""} }
${launch ? `pub type LaunchValues = ${launch};` : ""}
${
  scopeDepth
    ? `
struct ScopeEntry {
    finalizer: ScopeFinalizer,
    ${logging ? "annos: Vec<(&'static str, LogAttr)>, spans: Vec<(&'static str, std::time::Instant)>," : ""}
}
struct ScopeFrame {
    entries: [Option<ScopeEntry>; ${scopeCapacity}],
    len: usize,
}
impl ScopeFrame {
    fn new() -> Self { Self { entries: std::array::from_fn(|_| None), len: 0 } }
}
`
    : ""
}
${
  store
    ? `/// One store operation's completion; an error is the reason the mutation aborts.
pub type StoreFuture<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>;
/// One mutation's session of the Remote store a host serves (RS-003, SQLX-006): MemoryStore
/// semantics per operation, and for SQL one transaction the host commits or rolls back.
pub type RowFuture<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<serde_json::Value>, String>> + Send + 'a>>;
pub trait RemoteStore: Send + Sync {
    /// The stored row, wire-shaped, read in the session (RS-007).
    fn get<'a>(&'a self, entity: &'a str, id: &'a str) -> RowFuture<'a>;
    fn write<'a>(&'a self, entity: &'a str, id: &'a str, values: serde_json::Value) -> StoreFuture<'a>;
    fn remove<'a>(&'a self, entity: &'a str, id: &'a str) -> StoreFuture<'a>;
    /// Ends the session: commit when the source succeeded, otherwise roll back.
    fn finish(&self, commit: bool) -> StoreFuture<'_>;
    /// Why an operation failed, if one did; the host answers it instead of an interruption.
    fn failure(&self) -> Option<String>;
    /// Runs an effect visible outside the session once the session's writes are visible
    /// (LIVE-008). A non-transactional store runs it at once; a transactional one after its
    /// commit, and never after a rollback.
    fn after_commit(&self, action: AfterCommit) -> StoreFuture<'_> {
        Box::pin(async move { action().await; Ok(()) })
    }
}
/// An effect a session defers until its writes are visible, such as a live hub signal.
pub type AfterCommit = Box<dyn FnOnce() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send>;
/// The live hub a host serves (LIVE-001, LIVE-008): each signal is an action for the session to
/// run after its commit, so subscribers re-read committed rows.
pub trait LiveHub: Send + Sync {
    fn changed(&self, entity: &str, id: &str, fields: Vec<String>) -> AfterCommit;
    fn deleted(&self, entity: &str, id: &str) -> AfterCommit;
}
`
    : ""
}${sql ? sqlRuntime : ""}pub struct AsyncContext {
    ${runtimeServiceFields(services)}
    cancellation: tokio::sync::watch::Receiver<bool>,
    interruptible: bool,
    ${logging ? "annos: Vec<(&'static str, LogAttr)>, spans: Vec<(&'static str, std::time::Instant)>, request: Option<String>," : ""}
    ${frames ? "frames: Option<Box<FrameTrail>>," : ""}
    ${scopeDepth ? `scopes: [Option<ScopeFrame>; ${scopeDepth}], scope_depth: usize,` : ""}
    ${launch ? "launch: Option<tokio::sync::oneshot::Sender<LaunchValues>>," : ""}
    ${store ? "store: Option<std::sync::Arc<dyn RemoteStore>>, live_hub: Option<std::sync::Arc<dyn LiveHub>>," : ""}
    ${streams ? "stream_sink: Option<tokio::sync::mpsc::Sender<Vec<serde_json::Value>>>," : ""}
    ${sql ? "sql: Option<std::sync::Arc<dyn SqlService>>," : ""}
}
impl AsyncContext {
    pub fn new(cancellation: tokio::sync::watch::Receiver<bool>) -> Self {
        Self { cancellation, interruptible: true,
            ${runtimeServiceInitializers(services)}
            ${logging ? "annos: Vec::new(), spans: Vec::new(), request: None," : ""}
            ${frames ? "frames: None," : ""}
            ${scopeDepth ? "scopes: std::array::from_fn(|_| None), scope_depth: 0," : ""}
            ${launch ? "launch: None," : ""}
            ${store ? "store: None, live_hub: None," : ""}
            ${streams ? "stream_sink: None," : ""}
            ${sql ? "sql: None," : ""}
        }
    }
    ${runtimeServiceMethods(services)}
    ${
      taskGroups
        ? `fn child_context(&self, cancellation: tokio::sync::watch::Receiver<bool>, race: bool) -> Self {
        let mut child = Self::new(cancellation);
        child.interruptible = race || self.interruptible;
        ${logging ? "child.annos = self.annos.clone(); child.spans = self.spans.clone(); child.request = self.request.clone();" : ""}
        ${store ? "child.store = self.store.clone(); child.live_hub = self.live_hub.clone();" : ""}
        ${streams ? "child.stream_sink = self.stream_sink.clone();" : ""}
        ${sql ? "child.sql = self.sql.clone();" : ""}
        child
    }`
        : ""
    }
    pub fn is_cancelled(&self) -> bool {
        self.interruptible && (*self.cancellation.borrow() || self.cancellation.has_changed().is_err())
    }
    ${logging ? "pub fn set_request(&mut self, request: String) { self.request = Some(request); }" : ""}
    ${
      streams
        ? `pub fn set_stream_sink(&mut self, sink: tokio::sync::mpsc::Sender<Vec<serde_json::Value>>) { self.stream_sink = Some(sink); }
    /// Hands one encoded chunk to the host (STREAM-002/003): a full buffer waits, and a closed sink
    /// or cancellation interrupts, so the stream unwinds through its finalizers.
    async fn stream_chunk<E>(&mut self, values: Vec<serde_json::Value>) -> Result<(), AsyncError<E>> {
        let Some(sink) = self.stream_sink.clone() else { return Err(AsyncError::Interrupted) };
        if self.is_cancelled() { return Err(AsyncError::Interrupted); }
        if !self.interruptible { return sink.send(values).await.map_err(|_| AsyncError::Interrupted); }
        tokio::select! {
            biased;
            _ = self.cancellation.changed() => Err(AsyncError::Interrupted),
            sent = sink.send(values) => sent.map_err(|_| AsyncError::Interrupted),
        }
    }`
        : ""
    }
    ${
      store
        ? `pub fn set_remote_store(&mut self, store: std::sync::Arc<dyn RemoteStore>) { self.store = Some(store); }
    pub fn set_live_hub(&mut self, hub: std::sync::Arc<dyn LiveHub>) { self.live_hub = Some(hub); }
    /// A failed operation aborts like a defect: R cannot catch it, and unwinding runs finalizers.
    /// The session keeps the reason, so the host can answer it.
    async fn remote_store<E>(&mut self, write: Option<serde_json::Value>, entity: &str, id: &str) -> Result<(), AsyncError<E>> {
        let Some(store) = self.store.clone() else { return Err(AsyncError::Interrupted) };
        let done = match write { Some(values) => store.write(entity, id, values).await, None => store.remove(entity, id).await };
        done.map_err(|_| AsyncError::Interrupted)
    }
    /// A signal is the hub's action, run when the session's writes are visible (LIVE-008).
    async fn remote_live<E>(&mut self, fields: Option<Vec<String>>, entity: &str, id: &str) -> Result<(), AsyncError<E>> {
        let (Some(store), Some(hub)) = (self.store.clone(), self.live_hub.clone()) else { return Err(AsyncError::Interrupted) };
        let action = match fields { Some(fields) => hub.changed(entity, id, fields), None => hub.deleted(entity, id) };
        store.after_commit(action).await.map_err(|_| AsyncError::Interrupted)
    }
    async fn remote_store_get<E>(&mut self, entity: &str, id: &str) -> Result<Option<serde_json::Value>, AsyncError<E>> {
        let Some(store) = self.store.clone() else { return Err(AsyncError::Interrupted) };
        store.get(entity, id).await.map_err(|_| AsyncError::Interrupted)
    }`
        : ""
    }
    ${
      sql
        ? `pub fn set_sql_service(&mut self, sql: std::sync::Arc<dyn SqlService>) { self.sql = Some(sql); }
    /// Runs one statement to completion; interruption is observed after it, as on a
    /// synchronous driver. Without a service the host cannot run it, which interrupts.
    async fn sql_execute<E>(&mut self, segments: &'static [&'static str], params: Vec<SqlParam>) -> Result<serde_json::Value, AsyncError<E>> {
        let Some(sql) = self.sql.clone() else { return Err(AsyncError::Interrupted) };
        Ok(sql.execute(segments, params).await)
    }`
        : ""
    }
    ${
      launch
        ? `/// The host receives the launch values once; the hold then waits like Effect.never.
    pub fn set_launch(&mut self, sender: tokio::sync::oneshot::Sender<LaunchValues>) { self.launch = Some(sender); }
    async fn launch<E>(&mut self, values: LaunchValues) -> AsyncError<E> {
        if let Some(sender) = self.launch.take() { let _ = sender.send(values); }
        loop {
            if self.is_cancelled() { return AsyncError::Interrupted; }
            // A dropped canceller is cancellation when interruptible; masked holds never resume.
            if self.cancellation.changed().await.is_err() && !self.interruptible {
                std::future::pending::<()>().await;
            }
        }
    }`
        : ""
    }
    ${
      scopeDepth
        ? `
    fn enter_scope(&mut self) {
        self.scopes[self.scope_depth] = Some(ScopeFrame::new());
        self.scope_depth += 1;
    }
    fn register_finalizer(&mut self, finalizer: ScopeFinalizer) -> (usize, usize) {
        let entry = ScopeEntry { finalizer,
            ${logging ? "annos: self.annos.clone(), spans: self.spans.clone()," : ""}
        };
        let depth = self.scope_depth.checked_sub(1).expect("Checked registration requires an open scope");
        let scope = self.scopes[depth].as_mut().expect("Checked scope frame is present");
        let index = scope.len;
        assert!(index < scope.entries.len(), "Checked registration capacity proof");
        scope.entries[index] = Some(entry);
        scope.len += 1;
        (depth, index)
    }
    fn pop_finalizer(&mut self) -> Option<ScopeEntry> {
        let scope = self.scopes[self.scope_depth - 1].as_mut().expect("Checked scope frame is present");
        if scope.len == 0 { return None; }
        scope.len -= 1;
        Some(scope.entries[scope.len].take().expect("Registered finalizer slot is occupied"))
    }
    fn leave_scope(&mut self) {
        self.scope_depth -= 1;
        let scope = self.scopes[self.scope_depth].take().expect("Checked scope frame is present");
        assert!(scope.len == 0, "Scope finalizers have been awaited");
    }
    `
        : ""
    }
    ${
      frames
        ? `pub fn take_frames(&mut self) -> (Vec<&'static str>, usize) {
        match self.frames.take() {
            Some(trail) => (trail.frames[..trail.len].to_vec(), trail.omitted),
            None => (Vec::new(), 0),
        }
    }`
        : ""
    }
    async fn sleep<E>(&mut self, milliseconds: u64) -> Result<(), AsyncError<E>> {
        if self.is_cancelled() { return Err(AsyncError::Interrupted); }
        if !self.interruptible {
            tokio::time::sleep(std::time::Duration::from_millis(milliseconds)).await;
            return Ok(());
        }
        tokio::select! {
            biased;
            _ = self.cancellation.changed() => Err(AsyncError::Interrupted),
            _ = tokio::time::sleep(std::time::Duration::from_millis(milliseconds)) => Ok(()),
        }
    }
}
`;
