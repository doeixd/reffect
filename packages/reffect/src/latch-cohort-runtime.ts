/** Private borrowed adapter; production selection needs checked task/scheduling receipts. */
export const latchCohortRuntime = (): string => `
#[derive(Clone, Copy, PartialEq, Eq)]
enum LatchPhase { Waiting, Scheduled, Detached, Granted }
#[derive(Clone, Copy)]
struct LatchRegistration { task: usize, ticket: u64, phase: LatchPhase }
struct LatchState<const N: usize> {
    open: bool,
    registrations: [Option<LatchRegistration>; N],
    next_ticket: u64,
    dispatching: bool,
}
struct CohortLatch<const N: usize> { state: std::sync::Mutex<LatchState<N>> }
impl<const N: usize> CohortLatch<N> {
    fn new(open: bool) -> Self {
        assert!((1..=4).contains(&N), "Private latch task bound");
        Self { state: std::sync::Mutex::new(LatchState {
            open, registrations: [None; N], next_ticket: 0, dispatching: false,
        }) }
    }
    fn wait(&self, task: usize) -> LatchAwait<'_, N> {
        assert!(task < N, "Checked latch task identity");
        LatchAwait { owner: self, task, ticket: None, complete: false }
    }
    fn signal(&self, open: bool) -> bool {
        let mut state = self.state.lock().expect("Latch state lock");
        if state.open { return false; }
        if open { state.open = true; }
        for registration in state.registrations.iter_mut().flatten() {
            if registration.phase == LatchPhase::Waiting { registration.phase = LatchPhase::Scheduled; }
        }
        true
    }
    fn open(&self) -> bool { self.signal(true) }
    fn release(&self) -> bool { self.signal(false) }
    fn close(&self) -> bool {
        let mut state = self.state.lock().expect("Latch state lock");
        let changed = state.open; state.open = false; changed
    }
    fn is_open(&self) -> bool { self.state.lock().expect("Latch state lock").open }
    fn remove(state: &mut LatchState<N>, ticket: u64) {
        if let Some(slot) = state.registrations.iter_mut().find(|slot|
            slot.is_some_and(|registration| registration.ticket == ticket)) { *slot = None; }
    }
    // Detach before callbacks: a callback's release schedules a later cohort.
    fn dispatch_one(&self, mut resume: impl FnMut(usize)) -> bool {
        let cohort = {
            let mut state = self.state.lock().expect("Latch state lock");
            assert!(!state.dispatching, "A latch callback cannot recursively dispatch");
            let mut cohort: [Option<LatchRegistration>; N] = [None; N];
            let mut len = 0;
            for registration in state.registrations.iter_mut().flatten() {
                if registration.phase != LatchPhase::Scheduled { continue; }
                registration.phase = LatchPhase::Detached;
                let mut index = len;
                while index > 0 && cohort[index - 1].expect("Latch sorted cohort").ticket > registration.ticket {
                    cohort[index] = cohort[index - 1]; index -= 1;
                }
                cohort[index] = Some(*registration); len += 1;
            }
            if len == 0 { return false; }
            state.dispatching = true;
            cohort
        };
        for selected in cohort.into_iter().flatten() {
            let granted = {
                let mut state = self.state.lock().expect("Latch state lock");
                if let Some(registration) = state.registrations.iter_mut().flatten()
                    .find(|registration| registration.ticket == selected.ticket && registration.phase == LatchPhase::Detached) {
                    registration.phase = LatchPhase::Granted; true
                } else { false }
            };
            // Drop may have invalidated this ticket and reused the task slot.
            if granted { resume(selected.task); }
        }
        self.state.lock().expect("Latch state lock").dispatching = false;
        true
    }
    fn has_scheduled(&self) -> bool {
        self.state.lock().expect("Latch state lock").registrations.iter().flatten()
            .any(|registration| registration.phase == LatchPhase::Scheduled)
    }
    fn registered(&self) -> usize {
        self.state.lock().expect("Latch state lock").registrations.iter().flatten().count()
    }
}
struct LatchAwait<'a, const N: usize> {
    owner: &'a CohortLatch<N>, task: usize, ticket: Option<u64>, complete: bool,
}
impl<const N: usize> Unpin for LatchAwait<'_, N> {}
impl<const N: usize> std::future::Future for LatchAwait<'_, N> {
    type Output = ();
    fn poll(self: std::pin::Pin<&mut Self>, _cx: &mut std::task::Context<'_>) -> std::task::Poll<()> {
        let this = self.get_mut();
        assert!(!this.complete, "Completed latch await polled again");
        let mut state = this.owner.state.lock().expect("Latch state lock");
        if let Some(ticket) = this.ticket {
            let registration = state.registrations.iter().flatten()
                .find(|registration| registration.ticket == ticket).expect("Live latch lease");
            if registration.phase != LatchPhase::Granted { return std::task::Poll::Pending; }
            CohortLatch::<N>::remove(&mut state, ticket);
            this.ticket = None; this.complete = true; return std::task::Poll::Ready(());
        }
        if state.open { this.complete = true; return std::task::Poll::Ready(()); }
        assert!(!state.registrations.iter().flatten().any(|registration| registration.task == this.task),
            "One live latch await per checked task");
        state.next_ticket = state.next_ticket.checked_add(1).expect("Latch registration ticket overflow");
        let ticket = state.next_ticket;
        let slot = state.registrations.iter_mut().find(|slot| slot.is_none()).expect("Checked latch waiter capacity");
        *slot = Some(LatchRegistration { task: this.task, ticket, phase: LatchPhase::Waiting });
        this.ticket = Some(ticket); std::task::Poll::Pending
    }
}
impl<const N: usize> Drop for LatchAwait<'_, N> {
    fn drop(&mut self) {
        if let Some(ticket) = self.ticket.take() {
            CohortLatch::<N>::remove(&mut self.owner.state.lock().expect("Latch state lock"), ticket);
        }
    }
}
`;
