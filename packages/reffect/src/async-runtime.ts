/** Audited execution scaffold. Logging and failure storage are selected by reachability/policy. */
export const asyncRuntime = (logging: boolean, frames: boolean): string => `
#[derive(Debug)]
pub enum AsyncError<E> { Fail(E), Interrupted }
pub struct AsyncContext {
    cancellation: tokio::sync::watch::Receiver<bool>,
    interruptible: bool,
    ${logging ? "annos: Vec<(&'static str, LogAttr)>, spans: Vec<(&'static str, std::time::Instant)>, request: Option<String>," : ""}
    ${frames ? "frames: Option<Box<FrameTrail>>," : ""}
}
impl AsyncContext {
    pub fn new(cancellation: tokio::sync::watch::Receiver<bool>) -> Self {
        Self { cancellation, interruptible: true,
            ${logging ? "annos: Vec::new(), spans: Vec::new(), request: None," : ""}
            ${frames ? "frames: None," : ""}
        }
    }
    pub fn is_cancelled(&self) -> bool {
        self.interruptible && (*self.cancellation.borrow() || self.cancellation.has_changed().is_err())
    }
    ${logging ? "pub fn set_request(&mut self, request: String) { self.request = Some(request); }" : ""}
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
