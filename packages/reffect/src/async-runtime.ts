/** Audited execution scaffold. Logging and failure storage are selected by reachability/policy. */
export const asyncRuntime = (
  logging: boolean,
  frames: boolean,
  scopeDepth = 0,
  scopeCapacity = 0,
  launch?: string,
  store = false,
): string => `
#[derive(Debug)]
pub enum AsyncError<E> { Fail(E), Interrupted }
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
    ? `/// The Remote store a host serves (RS-003): MemoryStore semantics, one lock per operation.
pub trait RemoteStore: Send + Sync {
    fn write(&self, entity: &str, id: &str, values: serde_json::Value);
    fn remove(&self, entity: &str, id: &str);
}
`
    : ""
}pub struct AsyncContext {
    cancellation: tokio::sync::watch::Receiver<bool>,
    interruptible: bool,
    ${logging ? "annos: Vec<(&'static str, LogAttr)>, spans: Vec<(&'static str, std::time::Instant)>, request: Option<String>," : ""}
    ${frames ? "frames: Option<Box<FrameTrail>>," : ""}
    ${scopeDepth ? `scopes: [Option<ScopeFrame>; ${scopeDepth}], scope_depth: usize,` : ""}
    ${launch ? "launch: Option<tokio::sync::oneshot::Sender<LaunchValues>>," : ""}
    ${store ? "store: Option<&'static dyn RemoteStore>," : ""}
}
impl AsyncContext {
    pub fn new(cancellation: tokio::sync::watch::Receiver<bool>) -> Self {
        Self { cancellation, interruptible: true,
            ${logging ? "annos: Vec::new(), spans: Vec::new(), request: None," : ""}
            ${frames ? "frames: None," : ""}
            ${scopeDepth ? "scopes: std::array::from_fn(|_| None), scope_depth: 0," : ""}
            ${launch ? "launch: None," : ""}
            ${store ? "store: None," : ""}
        }
    }
    pub fn is_cancelled(&self) -> bool {
        self.interruptible && (*self.cancellation.borrow() || self.cancellation.has_changed().is_err())
    }
    ${logging ? "pub fn set_request(&mut self, request: String) { self.request = Some(request); }" : ""}
    ${
      store
        ? `pub fn set_remote_store(&mut self, store: &'static dyn RemoteStore) { self.store = Some(store); }
    fn remote_store(&self) -> &'static dyn RemoteStore { self.store.expect("a RemoteStore host sets its store before running") }`
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
