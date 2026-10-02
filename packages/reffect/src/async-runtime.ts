/** Audited execution scaffold. Logging and failure storage are selected by reachability/policy. */
export const asyncRuntime = (
  logging: boolean,
  frames: boolean,
  scopeDepth = 0,
  scopeCapacity = 0,
): string => `
#[derive(Debug)]
pub enum AsyncError<E> { Fail(E), Interrupted }
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
pub struct AsyncContext {
    cancellation: tokio::sync::watch::Receiver<bool>,
    interruptible: bool,
    ${logging ? "annos: Vec<(&'static str, LogAttr)>, spans: Vec<(&'static str, std::time::Instant)>, request: Option<String>," : ""}
    ${frames ? "frames: Option<Box<FrameTrail>>," : ""}
    ${scopeDepth ? `scopes: [Option<ScopeFrame>; ${scopeDepth}], scope_depth: usize,` : ""}
}
impl AsyncContext {
    pub fn new(cancellation: tokio::sync::watch::Receiver<bool>) -> Self {
        Self { cancellation, interruptible: true,
            ${logging ? "annos: Vec::new(), spans: Vec::new(), request: None," : ""}
            ${frames ? "frames: None," : ""}
            ${scopeDepth ? "scopes: std::array::from_fn(|_| None), scope_depth: 0," : ""}
        }
    }
    pub fn is_cancelled(&self) -> bool {
        self.interruptible && (*self.cancellation.borrow() || self.cancellation.has_changed().is_err())
    }
    ${logging ? "pub fn set_request(&mut self, request: String) { self.request = Some(request); }" : ""}
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
