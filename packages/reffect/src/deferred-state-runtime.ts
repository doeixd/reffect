/** Private cooperative owner experiment; no compiler or authoring path selects it. */
export const deferredStateRuntime = (): string => `
#[derive(Clone, Copy)]
struct DeferredRegistration {
    task: usize,
    next: Option<usize>,
    released: bool,
}
struct DeferredState<A: Copy, E: Copy, const N: usize> {
    state: std::sync::Mutex<DeferredStateInner<A, E, N>>,
}
struct DeferredStateInner<A: Copy, E: Copy, const N: usize> {
    outcome: Option<Result<A, E>>,
    slots: [Option<DeferredRegistration>; N],
    head: Option<usize>,
    tail: Option<usize>,
}
impl<A: Copy, E: Copy, const N: usize> DeferredState<A, E, N> {
    fn new() -> Self {
        assert!(N > 0, "Checked positive Deferred capacity");
        Self { state: std::sync::Mutex::new(DeferredStateInner {
            outcome: None, slots: [None; N], head: None, tail: None,
        }) }
    }
    fn is_done(&self) -> bool {
        self.state.lock().expect("Deferred state lock").outcome.is_some()
    }
    fn wait<'a, const M: usize>(&'a self, bank: &'a DeferredTurns<M>, task: usize)
        -> DeferredWait<'a, A, E, N, M> {
        assert!(task < M, "Checked Deferred task identity");
        DeferredWait { owner: self, bank, task, slot: None }
    }
    fn complete<'a, const M: usize>(&'a self, bank: &'a DeferredTurns<M>, task: usize,
        outcome: Result<A, E>) -> DeferredComplete<'a, A, E, N, M> {
        assert!(task < M, "Checked Deferred task identity");
        DeferredComplete { owner: self, bank, task, outcome,
            cohort: [None; N], len: 0, index: 0, started: false, armed: false, won: false }
    }
}
struct DeferredWait<'a, A: Copy, E: Copy, const N: usize, const M: usize> {
    owner: &'a DeferredState<A, E, N>,
    bank: &'a DeferredTurns<M>,
    task: usize,
    slot: Option<usize>,
}
// Neither future contains pin-sensitive storage or projects a pinned field.
impl<A: Copy, E: Copy, const N: usize, const M: usize> Unpin for DeferredWait<'_, A, E, N, M> {}
impl<A: Copy, E: Copy, const N: usize, const M: usize> std::future::Future for DeferredWait<'_, A, E, N, M> {
    type Output = Result<A, E>;
    fn poll(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<Self::Output> {
        let this = self.get_mut();
        {
            let mut state = this.owner.state.lock().expect("Deferred state lock");
            if let Some(slot) = this.slot {
                let entry = state.slots[slot].expect("Live Deferred registration");
                assert_eq!(entry.task, this.task, "Registration ownership");
                if entry.released {
                    let outcome = state.outcome.expect("Released Deferred outcome");
                    state.slots[slot] = None;
                    this.slot = None;
                    return std::task::Poll::Ready(outcome);
                }
            } else if let Some(outcome) = state.outcome {
                return std::task::Poll::Ready(outcome);
            } else {
                assert!(!state.slots.iter().flatten().any(|entry| entry.task == this.task),
                    "One parked await per checked task");
                let slot = state.slots.iter().position(Option::is_none).expect("Checked Deferred capacity");
                state.slots[slot] = Some(DeferredRegistration { task: this.task, next: None, released: false });
                if let Some(tail) = state.tail {
                    state.slots[tail].as_mut().expect("Deferred tail").next = Some(slot);
                } else { state.head = Some(slot); }
                state.tail = Some(slot);
                this.slot = Some(slot);
            }
        }
        this.bank.suspended(this.task);
        std::task::Poll::Pending
    }
}
impl<A: Copy, E: Copy, const N: usize, const M: usize> Drop for DeferredWait<'_, A, E, N, M> {
    fn drop(&mut self) {
        if let Some(slot) = self.slot.take() {
            let mut state = self.owner.state.lock().expect("Deferred state lock");
            let mut at = state.head;
            let mut previous: Option<usize> = None;
            while let Some(index) = at {
                let next = state.slots[index].expect("Linked Deferred registration").next;
                if index == slot {
                    if let Some(previous) = previous {
                        state.slots[previous].as_mut().expect("Previous Deferred registration").next = next;
                    } else { state.head = next; }
                    if state.tail == Some(slot) { state.tail = previous; }
                    break;
                }
                previous = at;
                at = next;
            }
            assert_eq!(state.slots[slot].expect("Owned Deferred registration").task, self.task);
            state.slots[slot] = None;
        }
    }
}
struct DeferredComplete<'a, A: Copy, E: Copy, const N: usize, const M: usize> {
    owner: &'a DeferredState<A, E, N>,
    bank: &'a DeferredTurns<M>,
    task: usize,
    outcome: Result<A, E>,
    cohort: [Option<usize>; N],
    len: usize,
    index: usize,
    started: bool,
    armed: bool,
    won: bool,
}
impl<A: Copy, E: Copy, const N: usize, const M: usize> Unpin for DeferredComplete<'_, A, E, N, M> {}
impl<A: Copy, E: Copy, const N: usize, const M: usize> std::future::Future for DeferredComplete<'_, A, E, N, M> {
    type Output = bool;
    fn poll(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<bool> {
        let this = self.get_mut();
        if !this.started {
            this.started = true;
            let mut state = this.owner.state.lock().expect("Deferred state lock");
            if state.outcome.is_some() { return std::task::Poll::Ready(false); }
            state.outcome = Some(this.outcome);
            this.won = true;
            let mut at = state.head.take();
            state.tail = None;
            while let Some(slot) = at {
                this.cohort[this.len] = Some(slot);
                this.len += 1;
                at = state.slots[slot].expect("Detached Deferred registration").next;
            }
        }
        if this.armed {
            if !this.bank.finish_request(this.task) { return std::task::Poll::Pending; }
            this.armed = false;
            this.index += 1;
        }
        while this.index < this.len {
            let slot = this.cohort[this.index].expect("Deferred cohort slot");
            let task = {
                let mut state = this.owner.state.lock().expect("Deferred state lock");
                state.slots[slot].as_mut().map(|entry| {
                    entry.released = true;
                    entry.task
                })
            };
            if let Some(task) = task {
                this.bank.request(this.task, task, cx.waker());
                this.armed = true;
                return std::task::Poll::Pending;
            }
            this.index += 1;
        }
        std::task::Poll::Ready(this.won)
    }
}
`;
