/** Private borrowed two-child experiment; explicit cancellation, no host or Drop integration. */
export const queueContinuationRuntime = (): string => String.raw`
#[derive(Clone, Copy)]
enum QueueRequest<T> { Offer(T), Take, End, Shutdown }
#[derive(Clone, Copy)]
enum QueueResponse<T> { Boolean(bool), Take(QueueTake<T>) }
#[derive(Clone, Copy, PartialEq, Eq)]
enum QueueRequestPhase { Idle, Posted, Processing, Waiting, Ready }
#[derive(Clone, Copy)]
struct QueueRequestSlot<T: Copy> {
    generation: u64, phase: QueueRequestPhase, request: Option<QueueRequest<T>>,
    response: Option<QueueResponse<T>>, ticket: Option<u64>,
}
struct QueueBridge<T: Copy> { slots: std::cell::RefCell<[QueueRequestSlot<T>; 2]> }
impl<T: Copy> QueueBridge<T> {
    fn new() -> Self {
        Self { slots: std::cell::RefCell::new([QueueRequestSlot {
            generation: 0, phase: QueueRequestPhase::Idle, request: None, response: None, ticket: None,
        }; 2]) }
    }
    fn task(&self, task: usize) -> QueueTask<'_, T> {
        assert!(task < 2, "Checked Queue bridge task"); QueueTask { bridge: self, task }
    }
}
#[derive(Clone, Copy)]
struct QueueTask<'a, T: Copy> { bridge: &'a QueueBridge<T>, task: usize }
impl<T: Copy> QueueTask<'_, T> {
    fn operation(&self, request: QueueRequest<T>) -> QueueRequestFuture<'_, T> {
        QueueRequestFuture { task: *self, request, generation: None, complete: false }
    }
    async fn offer(&self, value: T) -> bool {
        match self.operation(QueueRequest::Offer(value)).await {
            QueueResponse::Boolean(value) => value, _ => unreachable!("Queue offer response"),
        }
    }
    async fn take(&self) -> QueueTake<T> {
        match self.operation(QueueRequest::Take).await {
            QueueResponse::Take(value) => value, _ => unreachable!("Queue take response"),
        }
    }
    async fn end(&self) -> bool {
        match self.operation(QueueRequest::End).await {
            QueueResponse::Boolean(value) => value, _ => unreachable!("Queue end response"),
        }
    }
    async fn shutdown(&self) -> bool {
        match self.operation(QueueRequest::Shutdown).await {
            QueueResponse::Boolean(value) => value, _ => unreachable!("Queue shutdown response"),
        }
    }
}
struct QueueRequestFuture<'a, T: Copy> {
    task: QueueTask<'a, T>, request: QueueRequest<T>, generation: Option<u64>, complete: bool,
}
impl<T: Copy> Unpin for QueueRequestFuture<'_, T> {}
impl<T: Copy> std::future::Future for QueueRequestFuture<'_, T> {
    type Output = QueueResponse<T>;
    fn poll(self: std::pin::Pin<&mut Self>, _cx: &mut std::task::Context<'_>) -> std::task::Poll<Self::Output> {
        let this = self.get_mut();
        assert!(!this.complete, "Completed Queue request polled");
        let mut slots = this.task.bridge.slots.borrow_mut(); let slot = &mut slots[this.task.task];
        if let Some(generation) = this.generation {
            assert_eq!(slot.generation, generation, "Stale Queue request generation");
            if slot.phase != QueueRequestPhase::Ready { return std::task::Poll::Pending; }
            let response = slot.response.take().expect("Queue request result");
            slot.phase = QueueRequestPhase::Idle; slot.request = None; slot.ticket = None;
            this.complete = true; std::task::Poll::Ready(response)
        } else {
            assert!(slot.phase == QueueRequestPhase::Idle, "One outstanding Queue request per task");
            slot.generation = slot.generation.checked_add(1).expect("Queue request generation overflow");
            this.generation = Some(slot.generation); slot.request = Some(this.request);
            slot.phase = QueueRequestPhase::Posted; std::task::Poll::Pending
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QueueBoundary { Waiting, Complete }
struct QueueDriver<'a, T: Copy, const C: usize, F: std::future::Future<Output = ()>, G: std::future::Future<Output = ()>> {
    queue: &'a BoundedQueue<T, C, 2>, bridge: &'a QueueBridge<T>,
    first: std::cell::RefCell<std::pin::Pin<&'a mut F>>,
    second: std::cell::RefCell<std::pin::Pin<&'a mut G>>,
    active: [std::cell::Cell<bool>; 2], done: [std::cell::Cell<bool>; 2],
    steps: std::cell::Cell<usize>, depth: std::cell::Cell<usize>,
}
impl<'a, T: Copy, const C: usize, F: std::future::Future<Output = ()>, G: std::future::Future<Output = ()>> QueueDriver<'a, T, C, F, G> {
    fn new(queue: &'a BoundedQueue<T, C, 2>, bridge: &'a QueueBridge<T>,
        first: std::pin::Pin<&'a mut F>, second: std::pin::Pin<&'a mut G>) -> Self {
        Self { queue, bridge, first: std::cell::RefCell::new(first), second: std::cell::RefCell::new(second),
            active: std::array::from_fn(|_| std::cell::Cell::new(false)),
            done: std::array::from_fn(|_| std::cell::Cell::new(false)),
            steps: std::cell::Cell::new(0), depth: std::cell::Cell::new(0) }
    }
    fn step(&self) {
        let steps = self.steps.get().checked_add(1).expect("Queue bridge step overflow");
        assert!(steps <= 100_000, "Private Queue bridge protocol step bound"); self.steps.set(steps);
    }
    fn is_done(&self, task: usize) -> bool { self.done[task].get() }
    fn publish(&self, task: usize, generation: u64, response: QueueResponse<T>) {
        let mut slots = self.bridge.slots.borrow_mut(); let slot = &mut slots[task];
        assert_eq!(slot.generation, generation, "Queue publication generation");
        assert!(slot.phase == QueueRequestPhase::Processing, "Queue publication phase");
        slot.response = Some(response); slot.ticket = None; slot.phase = QueueRequestPhase::Ready;
    }
    fn execute(&self, task: usize) {
        self.step();
        let (request, generation) = {
            let mut slots = self.bridge.slots.borrow_mut(); let slot = &mut slots[task];
            assert!(slot.phase == QueueRequestPhase::Posted, "Posted Queue operation");
            slot.phase = QueueRequestPhase::Processing;
            (slot.request.expect("Queue request"), slot.generation)
        };
        // Neither the initiating future borrow nor the bank borrow crosses this callback.
        let result = match request {
            QueueRequest::Offer(value) => match self.queue.offer(task, value) {
                QueueResult::Ready(value) => QueueResult::Ready(QueueResponse::Boolean(value)),
                QueueResult::Pending(ticket) => QueueResult::Pending(ticket),
            },
            QueueRequest::Take => match self.queue.take(task, &mut |event| self.route(event)) {
                QueueResult::Ready(value) => QueueResult::Ready(QueueResponse::Take(value)),
                QueueResult::Pending(ticket) => QueueResult::Pending(ticket),
            },
            QueueRequest::End => QueueResult::Ready(QueueResponse::Boolean(self.queue.end(&mut |event| self.route(event)))),
            QueueRequest::Shutdown => QueueResult::Ready(QueueResponse::Boolean(self.queue.shutdown(&mut |event| self.route(event)))),
        };
        match result {
            QueueResult::Ready(response) => self.publish(task, generation, response),
            QueueResult::Pending(ticket) => {
                let mut slots = self.bridge.slots.borrow_mut(); let slot = &mut slots[task];
                assert_eq!(slot.generation, generation, "Queue registration generation");
                slot.ticket = Some(ticket); slot.phase = QueueRequestPhase::Waiting;
            }
        }
    }
    fn route(&self, event: QueueEvent) {
        self.step();
        if self.done[event.task].get() { return; }
        let generation = {
            let mut slots = self.bridge.slots.borrow_mut(); let slot = &mut slots[event.task];
            if slot.ticket != Some(event.ticket) { return; } // Removed ticket cannot reach replacement.
            assert!(slot.phase == QueueRequestPhase::Waiting, "Waiting Queue callback");
            slot.ticket = None;
            if event.notice == QueueNotice::Retry { slot.phase = QueueRequestPhase::Posted; }
            else { slot.phase = QueueRequestPhase::Processing; }
            slot.generation
        };
        match event.notice {
            QueueNotice::Retry => self.execute(event.task), // Retry may register again; no payload grant.
            QueueNotice::Offer(value) => self.publish(event.task, generation, QueueResponse::Boolean(value)),
            QueueNotice::Terminal(terminal) => self.publish(event.task, generation, QueueResponse::Take(QueueTake::Terminal(terminal))),
        }
        // Synchronous peer continuation precedes publication of the initiating take result.
        self.pump(event.task);
    }
    fn pump(&self, task: usize) -> QueueBoundary {
        assert!(task < 2, "Checked Queue driver task");
        if self.done[task].get() { return QueueBoundary::Complete; }
        assert!(!self.active[task].replace(true), "Queue active task reentry");
        let depth = self.depth.get() + 1;
        assert!(depth <= 256, "Private Queue bridge callback depth bound"); self.depth.set(depth);
        let boundary = loop {
            self.step();
            let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
            let poll = if task == 0 { self.first.borrow_mut().as_mut().poll(&mut cx) }
                else { self.second.borrow_mut().as_mut().poll(&mut cx) };
            // Short RefCell pinned borrow ends before any protocol operation or callback.
            if poll.is_ready() {
                assert!(self.bridge.slots.borrow()[task].phase == QueueRequestPhase::Idle, "Completed child retained Queue request");
                self.done[task].set(true); break QueueBoundary::Complete;
            }
            let phase = self.bridge.slots.borrow()[task].phase;
            if phase == QueueRequestPhase::Posted { self.execute(task); continue; }
            assert!(phase == QueueRequestPhase::Waiting, "Foreign Pending is unsupported by the private Queue bridge");
            break QueueBoundary::Waiting;
        };
        self.depth.set(depth - 1); self.active[task].set(false); boundary
    }
    fn dispatch(&self) -> bool {
        assert!(!self.active.iter().any(|active| active.get()), "Dispatch only at a semantic boundary");
        self.step(); self.queue.dispatch(&mut |event| self.route(event))
    }
    fn start(&self) {
        self.pump(0); self.pump(1); self.dispatch();
    }
    fn cancel(&self, task: usize) -> bool {
        assert!(task < 2 && !self.active[task].get(), "Cancel outside child poll/continuation");
        if self.done[task].replace(true) { return false; }
        let ticket = {
            let mut slots = self.bridge.slots.borrow_mut(); let slot = &mut slots[task];
            let ticket = slot.ticket.take(); slot.phase = QueueRequestPhase::Idle;
            slot.request = None; slot.response = None; ticket
        };
        // Explicit settlement: callbacks run before cancellation returns. No Drop assertion.
        if let Some(ticket) = ticket { self.queue.cancel(ticket, &mut |event| self.route(event)); }
        true
    }
}
`;
