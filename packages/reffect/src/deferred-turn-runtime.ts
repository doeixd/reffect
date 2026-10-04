/** Experimental semantic-turn kernel. Not selected by any authoring/compiler path yet. */
export const deferredTurnRuntime = (): string => `
#[derive(Clone, Copy)]
struct DeferredTurn {
    caller: usize,
    waiter: usize,
    acknowledged: bool,
}

// Invocation-owned: no pointers to peer futures, counters, or scalar wrappers.
struct DeferredTurns<const N: usize> {
    state: std::sync::Mutex<DeferredTurnsState<N>>,
}
struct DeferredTurnsState<const N: usize> {
    stack: [Option<DeferredTurn>; N],
    depth: usize,
    semantic: [bool; N],
    changed: bool,
}
impl<const N: usize> DeferredTurns<N> {
    fn new() -> Self {
        Self { state: std::sync::Mutex::new(DeferredTurnsState {
            stack: [None; N], depth: 0, semantic: [false; N], changed: false,
        }) }
    }
    fn priority(&self) -> Option<usize> {
        let state = self.state.lock().expect("Turn bank lock");
        if state.depth == 0 { None } else {
            let turn = state.stack[state.depth - 1].expect("Active turn");
            Some(if turn.acknowledged { turn.caller } else { turn.waiter })
        }
    }
    // Ancestor routing is supplied by the checked static child topology.
    fn permits(&self, child: usize, is_descendant: impl FnOnce(usize, usize) -> bool) -> bool {
        self.priority().is_none_or(|selected| selected == child || is_descendant(selected, child))
    }
    fn take_changed(&self) -> bool {
        let mut state = self.state.lock().expect("Turn bank lock");
        std::mem::take(&mut state.changed)
    }
    fn request(&self, caller: usize, waiter: usize, waker: &std::task::Waker) {
        {
            let mut state = self.state.lock().expect("Turn bank lock");
            assert!(caller < N && waiter < N && caller != waiter, "Checked distinct turn slots");
            assert!(state.depth < N, "Checked turn depth");
            assert!(!state.stack[..state.depth].iter().flatten().any(|turn| turn.caller == caller),
                "One active completion per caller");
            assert!(!state.stack[..state.depth].iter().flatten().any(|turn| turn.caller == waiter),
                "A blocked completing caller cannot also be a parked waiter");
            let depth = state.depth;
            state.stack[depth] = Some(DeferredTurn { caller, waiter, acknowledged: false });
            state.depth += 1;
            state.changed = true;
        }
        waker.wake_by_ref();
    }
    fn finish_request(&self, caller: usize) -> bool {
        let mut state = self.state.lock().expect("Turn bank lock");
        if state.depth == 0 { return false; }
        let depth = state.depth - 1;
        let turn = state.stack[depth].expect("Active turn");
        if turn.caller != caller || !turn.acknowledged { return false; }
        state.stack[depth] = None;
        state.depth = depth;
        state.changed = true;
        true
    }
    fn before_poll(&self, task: usize) {
        self.state.lock().expect("Turn bank lock").semantic[task] = false;
    }
    // Called only by a pending semantic primitive in this task, never a group ancestor.
    fn suspended(&self, task: usize) {
        self.state.lock().expect("Turn bank lock").semantic[task] = true;
    }
    fn after_poll(&self, task: usize, complete: bool, waker: &std::task::Waker) {
        let acknowledged = {
            let mut state = self.state.lock().expect("Turn bank lock");
            if state.depth == 0 { return; }
            let depth = state.depth - 1;
            let mut turn = state.stack[depth].expect("Active turn");
            if turn.acknowledged || turn.waiter != task || !(complete || state.semantic[task]) {
                false
            } else {
                turn.acknowledged = true;
                state.stack[depth] = Some(turn);
                state.changed = true;
                true
            }
        };
        if acknowledged { waker.wake_by_ref(); }
    }
}
`;
