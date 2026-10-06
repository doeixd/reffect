/** Private serialized callback protocol: the caller synchronously drives selected continuations.
 * Mutex protects mutations and permits reentry; it does not certify concurrent callback ordering.
 * No Future, Drop cancellation, or generated dispatcher integration is provided. */
export const queueBoundedRuntime = (): string => String.raw`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QueueTerminal { Done, Interrupted }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QueueLife { Open, Closing, Done }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QueueNotice { Retry, Terminal(QueueTerminal), Offer(bool) }
#[derive(Clone, Copy, Debug)]
struct QueueEvent { task: usize, ticket: u64, notice: QueueNotice }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QueueResult<T> { Ready(T), Pending(u64) }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QueueTake<T> { Value(T), Terminal(QueueTerminal) }
#[derive(Clone, Copy)]
enum QueueWait<T> { Take, Offer(T) }
#[derive(Clone, Copy)]
struct QueueRegistration<T> { task: usize, ticket: u64, wait: QueueWait<T> }
struct QueueState<T: Copy, const C: usize, const N: usize> {
    ring: [Option<T>; C], head: usize, len: usize,
    bank: [Option<QueueRegistration<T>>; N], next_ticket: u64,
    life: QueueLife, terminal: QueueTerminal, scheduled: bool,
}
struct BoundedQueue<T: Copy, const C: usize, const N: usize> {
    state: std::sync::Mutex<QueueState<T, C, N>>,
}
impl<T: Copy, const C: usize, const N: usize> BoundedQueue<T, C, N> {
    fn new() -> Self {
        assert!(C > 0 && (1..=4).contains(&N), "Checked private Queue bounds");
        Self { state: std::sync::Mutex::new(QueueState {
            ring: [None; C], head: 0, len: 0, bank: [None; N], next_ticket: 0,
            life: QueueLife::Open, terminal: QueueTerminal::Done, scheduled: false,
        }) }
    }
    fn register(s: &mut QueueState<T, C, N>, task: usize, wait: QueueWait<T>) -> u64 {
        assert!(task < N && !s.bank.iter().flatten().any(|r| r.task == task), "Checked Queue task identity");
        s.next_ticket = s.next_ticket.checked_add(1).expect("Queue ticket overflow");
        let ticket = s.next_ticket;
        *s.bank.iter_mut().find(|r| r.is_none()).expect("Checked Queue registration capacity") =
            Some(QueueRegistration { task, ticket, wait });
        ticket
    }
    fn first(s: &QueueState<T, C, N>, offers: bool) -> Option<usize> {
        s.bank.iter().enumerate().filter_map(|(i, r)| r.map(|r| (i, r)))
            .filter(|(_, r)| matches!(r.wait, QueueWait::Offer(_)) == offers)
            .min_by_key(|(_, r)| r.ticket).map(|(i, _)| i)
    }
    fn push(s: &mut QueueState<T, C, N>, value: T) {
        s.ring[(s.head + s.len) % C] = Some(value); s.len += 1;
    }
    fn schedule(s: &mut QueueState<T, C, N>) {
        if s.life != QueueLife::Done && Self::first(s, false).is_some() { s.scheduled = true; }
    }
    fn offer(&self, task: usize, value: T) -> QueueResult<bool> {
        let mut s = self.state.lock().expect("Queue lock");
        if s.life != QueueLife::Open { return QueueResult::Ready(false); }
        if s.len < C { Self::push(&mut s, value); Self::schedule(&mut s); QueueResult::Ready(true) }
        else { QueueResult::Pending(Self::register(&mut s, task, QueueWait::Offer(value))) }
    }
    fn take(&self, task: usize, callback: &mut impl FnMut(QueueEvent)) -> QueueResult<QueueTake<T>> {
        let value = {
            let mut s = self.state.lock().expect("Queue lock");
            if s.life == QueueLife::Done { return QueueResult::Ready(QueueTake::Terminal(s.terminal)); }
            if s.len == 0 { return QueueResult::Pending(Self::register(&mut s, task, QueueWait::Take)); }
            let head = s.head; let value = s.ring[head].take().expect("Queue buffered value");
            s.head = (head + 1) % C; s.len -= 1; value
        };
        self.release_capacity(callback);
        QueueResult::Ready(QueueTake::Value(value))
    }
    fn terminal_takers(&self, callback: &mut impl FnMut(QueueEvent)) {
        loop {
            let event = {
                let mut s = self.state.lock().expect("Queue lock");
                if s.life != QueueLife::Done { return; }
                let Some(index) = Self::first(&s, false) else { return; };
                let r = s.bank[index].take().unwrap();
                QueueEvent { task: r.task, ticket: r.ticket, notice: QueueNotice::Terminal(s.terminal) }
            };
            callback(event);
        }
    }
    fn release_capacity(&self, callback: &mut impl FnMut(QueueEvent)) {
        loop {
            let event = {
                let mut s = self.state.lock().expect("Queue lock");
                if s.life == QueueLife::Done { return; }
                if let Some(index) = Self::first(&s, true) {
                    if s.len == C { return; }
                    let r = s.bank[index].take().unwrap();
                    let QueueWait::Offer(value) = r.wait else { unreachable!() };
                    Self::push(&mut s, value);
                    Some(QueueEvent { task: r.task, ticket: r.ticket, notice: QueueNotice::Offer(true) })
                } else {
                    if s.life == QueueLife::Closing && s.len == 0 {
                        s.life = QueueLife::Done; s.scheduled = false;
                    }
                    None
                }
            };
            if let Some(event) = event { callback(event); }
            else { self.terminal_takers(callback); return; }
        }
    }
    fn end(&self, callback: &mut impl FnMut(QueueEvent)) -> bool {
        {
            let mut s = self.state.lock().expect("Queue lock");
            if s.life != QueueLife::Open { return false; }
            s.life = QueueLife::Closing; s.terminal = QueueTerminal::Done;
            Self::schedule(&mut s);
        }
        // End retains registered offers; only empty closing state finalizes.
        self.finish_empty(callback); true
    }
    fn finish_empty(&self, callback: &mut impl FnMut(QueueEvent)) {
        {
            let mut s = self.state.lock().expect("Queue lock");
            if s.life == QueueLife::Closing && s.len == 0 && Self::first(&s, true).is_none() {
                s.life = QueueLife::Done; s.scheduled = false;
            }
        }
        self.terminal_takers(callback);
    }
    fn cancel(&self, ticket: u64, callback: &mut impl FnMut(QueueEvent)) -> bool {
        let removed = {
            let mut s = self.state.lock().expect("Queue lock");
            if s.life == QueueLife::Done { return false; }
            if let Some(slot) = s.bank.iter_mut().find(|r| r.is_some_and(|r| r.ticket == ticket)) {
                *slot = None; true
            } else { false }
        };
        self.finish_empty(callback); removed
    }
    fn shutdown(&self, callback: &mut impl FnMut(QueueEvent)) -> bool {
        {
            let mut s = self.state.lock().expect("Queue lock");
            if s.life == QueueLife::Done { return false; }
            if s.life == QueueLife::Open { s.terminal = QueueTerminal::Interrupted; }
            s.life = QueueLife::Done; s.ring = [None; C]; s.len = 0; s.scheduled = false;
        }
        self.terminal_takers(callback);
        loop {
            let event = {
                let mut s = self.state.lock().expect("Queue lock");
                let Some(index) = Self::first(&s, true) else { return true; };
                let r = s.bank[index].take().unwrap();
                QueueEvent { task: r.task, ticket: r.ticket, notice: QueueNotice::Offer(false) }
            };
            callback(event);
        }
    }
    fn dispatch(&self, callback: &mut impl FnMut(QueueEvent)) -> bool {
        {
            let mut s = self.state.lock().expect("Queue lock");
            if !s.scheduled { return false; } s.scheduled = false;
        }
        loop {
            let event = {
                let mut s = self.state.lock().expect("Queue lock");
                if s.life == QueueLife::Done || s.len == 0 { return true; }
                let Some(index) = Self::first(&s, false) else { return true; };
                let r = s.bank[index].take().unwrap();
                QueueEvent { task: r.task, ticket: r.ticket, notice: QueueNotice::Retry }
            };
            callback(event); // Live scan after reentry, no detached cohort or payload reservation.
        }
    }
    fn registered(&self) -> usize { self.state.lock().expect("Queue lock").bank.iter().flatten().count() }
}
`;
