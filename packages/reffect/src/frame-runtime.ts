/** Audited bounded trail scaffold shared by synchronous and async owners. Capacity is emitted separately from the shared IR bound. */
export const frameTrailRuntime = `struct FrameTrail {
    frames: [&'static str; MAX_LOGICAL_FRAMES],
    len: usize,
    omitted: usize,
}
impl FrameTrail {
    fn new(frame: &'static str) -> Box<Self> {
        let mut trail = Box::new(Self { frames: [""; MAX_LOGICAL_FRAMES], len: 0, omitted: 0 });
        trail.push(frame);
        trail
    }
    fn push(&mut self, frame: &'static str) {
        if self.len < MAX_LOGICAL_FRAMES {
            self.frames[self.len] = frame;
            self.len += 1;
        } else {
            self.omitted = self.omitted.saturating_add(1);
        }
    }
}
`;
export const syncFrameStorageRuntime = `thread_local! {
    static LAST_FRAMES: std::cell::RefCell<Option<Box<FrameTrail>>> = const { std::cell::RefCell::new(None) };
}
fn store_frames(frames: Box<FrameTrail>) {
    LAST_FRAMES.with(|cell| *cell.borrow_mut() = Some(frames));
}
pub fn clear_last_frames() {
    LAST_FRAMES.with(|cell| { cell.borrow_mut().take(); });
}
pub fn take_last_frames() -> (Vec<&'static str>, usize) {
    LAST_FRAMES.with(|cell| match cell.borrow_mut().take() {
        Some(trail) => (trail.frames[..trail.len].to_vec(), trail.omitted),
        None => (Vec::new(), 0),
    })
}
`;
