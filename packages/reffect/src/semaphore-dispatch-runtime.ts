/** Borrowed live-scan adapter; compiler selection requires bounded generated-profile receipts. */
export const semaphoreDispatchRuntime = (): string => `
#[derive(Clone, Copy)]
struct ScanRegistration { task: usize, ticket: u64 }
struct ScanState<const N: usize> {
    available: usize,
    capacity: usize,
    registrations: [Option<ScanRegistration>; N],
    next_ticket: u64,
    pending: usize,
    scanning: bool,
}
struct ScanSemaphore<const N: usize> { state: std::sync::Mutex<ScanState<N>> }
impl<const N: usize> ScanSemaphore<N> {
    fn new(capacity: usize) -> Self {
        assert!((1..=4).contains(&N) && (1..=3).contains(&capacity), "Private scan bounds");
        Self { state: std::sync::Mutex::new(ScanState {
            available: capacity, capacity, registrations: [None; N],
            next_ticket: 0, pending: 0, scanning: false,
        }) }
    }
    fn acquire(&self, task: usize) -> ScanAcquire<'_, N> {
        assert!(task < N, "Checked scan task identity");
        ScanAcquire { owner: self, task, ticket: None, complete: false }
    }
    fn remove(state: &mut ScanState<N>, ticket: u64) {
        if let Some(slot) = state.registrations.iter_mut().find(|slot|
            slot.is_some_and(|registration| registration.ticket == ticket)) { *slot = None; }
    }
    fn release(&self) {
        let mut state = self.state.lock().expect("Scan state lock");
        assert!(state.available < state.capacity, "Balanced scan permit release");
        state.available += 1;
        if state.registrations.iter().any(Option::is_some) {
            state.pending = state.pending.checked_add(1).expect("Private scan counter overflow");
        }
    }
    // Driver calls only after the releasing continuation suspends or completes.
    // Each callback must poll the selected task through semantic suspension/completion.
    fn dispatch_one(&self, mut resume: impl FnMut(usize)) -> bool {
        {
            let mut state = self.state.lock().expect("Scan state lock");
            assert!(!state.scanning, "A resumed callback cannot recursively dispatch scans");
            if state.pending == 0 { return false; }
            state.pending -= 1;
            state.scanning = true;
        }
        let mut cursor = 0;
        loop {
            let selected = {
                let mut state = self.state.lock().expect("Scan state lock");
                if state.available == 0 { None } else {
                    let selected = state.registrations.iter().flatten()
                        .filter(|registration| registration.ticket > cursor)
                        .min_by_key(|registration| registration.ticket).copied();
                    if let Some(registration) = selected { Self::remove(&mut state, registration.ticket); }
                    selected
                }
            };
            let Some(registration) = selected else { break; };
            cursor = registration.ticket;
            // No lock crosses peer polling; reentrant release and registration are legal.
            resume(registration.task);
        }
        self.state.lock().expect("Scan state lock").scanning = false;
        true
    }
    fn has_pending_scans(&self) -> bool { self.state.lock().expect("Scan state lock").pending != 0 }
    fn available(&self) -> usize { self.state.lock().expect("Scan state lock").available }
    fn waiting(&self) -> usize {
        self.state.lock().expect("Scan state lock").registrations.iter().flatten().count()
    }
}
struct ScanAcquire<'a, const N: usize> {
    owner: &'a ScanSemaphore<N>, task: usize, ticket: Option<u64>, complete: bool,
}
impl<const N: usize> Unpin for ScanAcquire<'_, N> {}
impl<'a, const N: usize> std::future::Future for ScanAcquire<'a, N> {
    type Output = ScanPermit<'a, N>;
    fn poll(self: std::pin::Pin<&mut Self>, _cx: &mut std::task::Context<'_>) -> std::task::Poll<Self::Output> {
        let this = self.get_mut();
        assert!(!this.complete, "Completed scan acquisition polled again");
        let mut state = this.owner.state.lock().expect("Scan state lock");
        // An unrelated parent wake must not resume an observer still in the Set.
        if this.ticket.is_some_and(|ticket| state.registrations.iter().flatten()
            .any(|registration| registration.ticket == ticket)) { return std::task::Poll::Pending; }
        if state.available > 0 {
            state.available -= 1;
            this.complete = true;
            this.ticket = None;
            return std::task::Poll::Ready(ScanPermit { owner: this.owner });
        }
        assert!(!state.registrations.iter().flatten().any(|registration| registration.task == this.task),
            "One pending acquisition per checked task");
        state.next_ticket = state.next_ticket.checked_add(1).expect("Private registration counter overflow");
        let ticket = state.next_ticket;
        let slot = state.registrations.iter_mut().find(|slot| slot.is_none())
            .expect("Checked scan registration capacity");
        *slot = Some(ScanRegistration { task: this.task, ticket });
        this.ticket = Some(ticket);
        std::task::Poll::Pending
    }
}
impl<const N: usize> Drop for ScanAcquire<'_, N> {
    fn drop(&mut self) {
        if let Some(ticket) = self.ticket.take() {
            ScanSemaphore::<N>::remove(&mut self.owner.state.lock().expect("Scan state lock"), ticket);
        }
    }
}
struct ScanPermit<'a, const N: usize> { owner: &'a ScanSemaphore<N> }
impl<const N: usize> Drop for ScanPermit<'_, N> { fn drop(&mut self) { self.owner.release(); } }
`;
