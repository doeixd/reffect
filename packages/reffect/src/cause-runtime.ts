/** Reachability-selected finite scalar failure carrier; ordinary values remain unwrapped. */
export const causeRuntime = (frames: boolean): string => `
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RuntimeFailure { Bool(bool), U64(u64), Unit }
#[derive(Debug)]
pub struct RuntimeCause {
    pub interrupted: bool,
    pub failures: [Option<RuntimeFailure>; 3],
    pub len: usize,
}
impl RuntimeCause {
    fn empty() -> Self { Self { interrupted: false, failures: [None; 3], len: 0 } }
    fn push(&mut self, failure: RuntimeFailure, deduplicate: bool) {
        if deduplicate && self.failures[..self.len].contains(&Some(failure)) { return; }
        assert!(self.len < 3, "Checked unnested task failure capacity");
        self.failures[self.len] = Some(failure); self.len += 1;
    }
    pub fn first(&self) -> Option<RuntimeFailure> { self.failures[0] }
    pub fn write_scalar(&self) {
        print!("cause:");
        let mut comma = false;
        if self.interrupted { print!("interrupt"); comma = true; }
        for failure in self.failures[..self.len].iter().flatten() {
            if comma { print!(","); } comma = true;
            match failure {
                RuntimeFailure::Bool(value) => print!("bool:{}", value),
                RuntimeFailure::U64(value) => print!("u64:{}", value),
                RuntimeFailure::Unit => print!("unit"),
            }
        }
        println!();
    }
}
struct TaskFailure {
    cause: RuntimeCause,
    ${frames ? "frames: Option<Box<FrameTrail>>," : ""}
}
`;
