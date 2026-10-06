/** Private scheduled-wakeup experiment; no compiler path selects this substrate. */
export const semaphoreNativeRuntime = (): string => `
struct SemaphoreRegistration {
    next: Option<usize>,
    waker: std::task::Waker,
}
struct SemaphoreInner<const N: usize> {
    available: usize,
    capacity: usize,
    slots: [Option<SemaphoreRegistration>; N],
    head: Option<usize>,
    tail: Option<usize>,
}
#[derive(Clone)]
struct ExperimentalSemaphore<const N: usize> {
    state: std::sync::Arc<std::sync::Mutex<SemaphoreInner<N>>>,
}
impl<const N: usize> ExperimentalSemaphore<N> {
    fn new(capacity: usize) -> Self {
        assert!(N > 0 && (1..=3).contains(&capacity), "Private bounded Semaphore experiment");
        Self { state: std::sync::Arc::new(std::sync::Mutex::new(SemaphoreInner {
            available: capacity, capacity, slots: std::array::from_fn(|_| None),
            head: None, tail: None,
        })) }
    }
    fn acquire(&self) -> ExperimentalAcquire<'_, N> {
        ExperimentalAcquire { owner: self, slot: None }
    }
    fn remove(state: &mut SemaphoreInner<N>, slot: usize) {
        let mut at = state.head;
        let mut previous: Option<usize> = None;
        while let Some(index) = at {
            let next = state.slots[index].as_ref().expect("Linked Semaphore waiter").next;
            if index == slot {
                if let Some(previous) = previous {
                    state.slots[previous].as_mut().expect("Previous Semaphore waiter").next = next;
                } else { state.head = next; }
                if state.tail == Some(slot) { state.tail = previous; }
                state.slots[slot] = None;
                return;
            }
            previous = at;
            at = next;
        }
        panic!("Semaphore waiter is not linked");
    }
    fn release(&self) {
        {
            let mut state = self.state.lock().expect("Semaphore lock");
            assert!(state.available < state.capacity, "Balanced guarded release");
            state.available += 1;
            if state.head.is_none() { return; }
        }
        let owner = self.clone();
        // Spawn schedules a dispatcher phase; it cannot poll peer bodies inline.
        tokio::spawn(async move {
            let mut wake: [Option<std::task::Waker>; N] = std::array::from_fn(|_| None);
            {
                let state = owner.state.lock().expect("Semaphore lock");
                if state.available == 0 { return; }
                let mut at = state.head;
                let mut count = 0;
                while let Some(index) = at {
                    let registration = state.slots[index].as_ref().expect("Linked Semaphore waiter");
                    wake[count] = Some(registration.waker.clone());
                    count += 1;
                    at = registration.next;
                }
            }
            // Wakers enqueue polls, not permit reservations. Each acquisition rechecks.
            for waker in wake.into_iter().flatten() { waker.wake(); }
        });
    }
    fn available(&self) -> usize { self.state.lock().expect("Semaphore lock").available }
    fn waiting(&self) -> usize {
        self.state.lock().expect("Semaphore lock").slots.iter().flatten().count()
    }
}
struct ExperimentalAcquire<'a, const N: usize> {
    owner: &'a ExperimentalSemaphore<N>,
    slot: Option<usize>,
}
impl<const N: usize> Unpin for ExperimentalAcquire<'_, N> {}
impl<const N: usize> std::future::Future for ExperimentalAcquire<'_, N> {
    type Output = ExperimentalPermit<N>;
    fn poll(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Self::Output> {
        let this = self.get_mut();
        let mut state = this.owner.state.lock().expect("Semaphore lock");
        if state.available > 0 {
            if let Some(slot) = this.slot.take() { ExperimentalSemaphore::<N>::remove(&mut state, slot); }
            state.available -= 1;
            return std::task::Poll::Ready(ExperimentalPermit { owner: this.owner.clone() });
        }
        if let Some(slot) = this.slot {
            let registration = state.slots[slot].as_mut().expect("Live Semaphore waiter");
            if !registration.waker.will_wake(cx.waker()) { registration.waker = cx.waker().clone(); }
        } else {
            let slot = state.slots.iter().position(Option::is_none).expect("Checked Semaphore waiter capacity");
            state.slots[slot] = Some(SemaphoreRegistration { next: None, waker: cx.waker().clone() });
            if let Some(tail) = state.tail {
                state.slots[tail].as_mut().expect("Semaphore tail").next = Some(slot);
            } else { state.head = Some(slot); }
            state.tail = Some(slot);
            this.slot = Some(slot);
        }
        std::task::Poll::Pending
    }
}
impl<const N: usize> Drop for ExperimentalAcquire<'_, N> {
    fn drop(&mut self) {
        if let Some(slot) = self.slot.take() {
            ExperimentalSemaphore::<N>::remove(&mut self.owner.state.lock().expect("Semaphore lock"), slot);
        }
    }
}
struct ExperimentalPermit<const N: usize> { owner: ExperimentalSemaphore<N> }
impl<const N: usize> Drop for ExperimentalPermit<N> {
    fn drop(&mut self) { self.owner.release(); }
}
`;
