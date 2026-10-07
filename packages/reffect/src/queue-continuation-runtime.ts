/** Private borrowed two-child experiment; scoped registration retirement, managed cleanup requires a separate host adapter. */
export const queueContinuationRuntime = (): string => String.raw`
#[derive(Clone, Copy)]
enum QueueRequest<T> { Offer(T), Take, End, Shutdown }
#[derive(Clone, Copy)]
enum QueueResponse<T> { Boolean(bool), Take(QueueTake<T>), Interrupted }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct QueueInterrupted;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct QueueDone;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QueueTakeFailure { Done(QueueDone), OwnerInterrupted, ControlInterrupted }
async fn queue_catch_done<T, Source, Handler, Recovery>(source: Source, handler: Handler) -> Result<T, QueueTakeFailure>
where Source: std::future::Future<Output = Result<T, QueueTakeFailure>>,
      Handler: FnOnce(QueueDone) -> Recovery,
      Recovery: std::future::Future<Output = Result<T, QueueTakeFailure>> {
    match source.await {
        Err(QueueTakeFailure::Done(done)) => handler(done).await,
        result => result,
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum QueueRequestPhase { Idle, Posted, Processing, Waiting, Ready }
#[derive(Clone, Copy)]
struct QueueRequestSlot<T: Copy> {
    generation: u64, phase: QueueRequestPhase, request: Option<QueueRequest<T>>,
    response: Option<QueueResponse<T>>, ticket: Option<u64>,
}
struct QueueBridge<T: Copy> { slots: std::cell::RefCell<[QueueRequestSlot<T>; 2]>, closed: std::cell::Cell<bool>, installed: std::cell::Cell<bool>, interrupted: [std::cell::Cell<bool>; 2], cleanup_waiting: [std::cell::Cell<bool>; 2] }
impl<T: Copy> QueueBridge<T> {
    fn new() -> Self {
        Self { slots: std::cell::RefCell::new([QueueRequestSlot {
            generation: 0, phase: QueueRequestPhase::Idle, request: None, response: None, ticket: None,
        }; 2]), closed: std::cell::Cell::new(false), installed: std::cell::Cell::new(false), interrupted: std::array::from_fn(|_| std::cell::Cell::new(false)), cleanup_waiting: std::array::from_fn(|_| std::cell::Cell::new(false)) }
    }
    fn task(&self, task: usize) -> QueueTask<'_, T> {
        assert!(!self.closed.get(), "Closed Queue bridge");
        assert!(task < 2, "Checked Queue bridge task"); QueueTask { bridge: self, task }
    }
}
#[derive(Clone, Copy)]
struct QueueTask<'a, T: Copy> { bridge: &'a QueueBridge<T>, task: usize }
impl<T: Copy> QueueTask<'_, T> {
    fn operation(&self, request: QueueRequest<T>) -> QueueRequestFuture<'_, T> {
        QueueRequestFuture { task: *self, request, generation: None, complete: false, masked: false }
    }
    async fn offer_exit(&self, value: T) -> Result<bool, QueueInterrupted> {
        match self.operation(QueueRequest::Offer(value)).await {
            QueueResponse::Boolean(value) => Ok(value), QueueResponse::Interrupted => Err(QueueInterrupted),
            _ => unreachable!("Queue offer control result"),
        }
    }
    async fn take_exit(&self) -> Result<QueueTake<T>, QueueInterrupted> {
        match self.operation(QueueRequest::Take).await {
            QueueResponse::Take(value) => Ok(value), QueueResponse::Interrupted => Err(QueueInterrupted),
            _ => unreachable!("Queue take control result"),
        }
    }
    async fn take_done_exit(&self) -> Result<T, QueueTakeFailure> {
        match self.take_exit().await {
            Ok(QueueTake::Value(value)) => Ok(value),
            Ok(QueueTake::Terminal(QueueTerminal::Done)) => Err(QueueTakeFailure::Done(QueueDone)),
            Ok(QueueTake::Terminal(QueueTerminal::Interrupted)) => Err(QueueTakeFailure::OwnerInterrupted),
            Err(_) => Err(QueueTakeFailure::ControlInterrupted),
        }
    }
    async fn end_exit(&self) -> Result<bool, QueueInterrupted> {
        match self.operation(QueueRequest::End).await {
            QueueResponse::Boolean(value) => Ok(value), QueueResponse::Interrupted => Err(QueueInterrupted),
            _ => unreachable!("Queue end control result"),
        }
    }
    async fn shutdown_exit(&self) -> Result<bool, QueueInterrupted> {
        match self.operation(QueueRequest::Shutdown).await {
            QueueResponse::Boolean(value) => Ok(value), QueueResponse::Interrupted => Err(QueueInterrupted),
            _ => unreachable!("Queue shutdown control result"),
        }
    }
    async fn cleanup_shutdown(&self) -> bool {
        let mut request = self.operation(QueueRequest::Shutdown); request.masked = true;
        match request.await {
            QueueResponse::Boolean(value) => value, _ => unreachable!("Masked Queue shutdown result"),
        }
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
    task: QueueTask<'a, T>, request: QueueRequest<T>, generation: Option<u64>, complete: bool, masked: bool,
}
impl<T: Copy> Unpin for QueueRequestFuture<'_, T> {}
impl<T: Copy> std::future::Future for QueueRequestFuture<'_, T> {
    type Output = QueueResponse<T>;
    fn poll(self: std::pin::Pin<&mut Self>, _cx: &mut std::task::Context<'_>) -> std::task::Poll<Self::Output> {
        let this = self.get_mut();
        assert!(!this.task.bridge.closed.get(), "Closed Queue bridge");
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
            if !this.masked && this.task.bridge.interrupted[this.task.task].get() {
                this.complete = true; return std::task::Poll::Ready(QueueResponse::Interrupted);
            }
            slot.generation = slot.generation.checked_add(1).expect("Queue request generation overflow");
            this.generation = Some(slot.generation); slot.request = Some(this.request);
            slot.phase = QueueRequestPhase::Posted; std::task::Poll::Pending
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QueueBoundary { Waiting, CleanupWaiting, Complete }
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
        assert!(!bridge.closed.get(), "Closed Queue bridge");
        assert!(!bridge.installed.get(), "Queue bridge already installed");
        assert!(bridge.slots.borrow().iter().all(|slot| slot.phase == QueueRequestPhase::Idle), "Fresh Queue bridge receipts");
        let mut state = queue.state.lock().expect("Queue driver installation");
        let exclusive = !state.driver_owned && state.bank.iter().all(Option::is_none);
        if exclusive { state.driver_owned = true; }
        drop(state);
        assert!(exclusive, "Exclusive Queue driver installation");
        bridge.installed.set(true);
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
    fn execute_with_waker(&self, task: usize, waker: &std::task::Waker) {
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
            QueueRequest::Take => match self.queue.take(task, &mut |event| self.route_with_waker(event, waker)) {
                QueueResult::Ready(value) => QueueResult::Ready(QueueResponse::Take(value)),
                QueueResult::Pending(ticket) => QueueResult::Pending(ticket),
            },
            QueueRequest::End => QueueResult::Ready(QueueResponse::Boolean(self.queue.end(&mut |event| self.route_with_waker(event, waker)))),
            QueueRequest::Shutdown => QueueResult::Ready(QueueResponse::Boolean(self.queue.shutdown(&mut |event| self.route_with_waker(event, waker)))),
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
    fn route_with_waker(&self, event: QueueEvent, waker: &std::task::Waker) {
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
            QueueNotice::Retry => self.execute_with_waker(event.task, waker), // Retry may register again; no payload grant.
            QueueNotice::Offer(value) => self.publish(event.task, generation, QueueResponse::Boolean(value)),
            QueueNotice::Terminal(terminal) => self.publish(event.task, generation, QueueResponse::Take(QueueTake::Terminal(terminal))),
        }
        // Synchronous peer continuation precedes publication of the initiating take result.
        self.pump_with_waker(event.task, waker);
    }
    fn pump_with_waker(&self, task: usize, waker: &std::task::Waker) -> QueueBoundary {
        assert!(task < 2, "Checked Queue driver task");
        if self.done[task].get() { return QueueBoundary::Complete; }
        assert!(!self.active[task].replace(true), "Queue active task reentry");
        let depth = self.depth.get() + 1;
        assert!(depth <= 256, "Private Queue bridge callback depth bound"); self.depth.set(depth);
        let boundary = loop {
            self.step();
            self.bridge.cleanup_waiting[task].set(false);
            let mut cx = std::task::Context::from_waker(waker);
            let poll = if task == 0 { self.first.borrow_mut().as_mut().poll(&mut cx) }
                else { self.second.borrow_mut().as_mut().poll(&mut cx) };
            // Short RefCell pinned borrow ends before any protocol operation or callback.
            if poll.is_ready() {
                assert!(self.bridge.slots.borrow()[task].phase == QueueRequestPhase::Idle, "Completed child retained Queue request");
                self.done[task].set(true); break QueueBoundary::Complete;
            }
            let phase = self.bridge.slots.borrow()[task].phase;
            if phase == QueueRequestPhase::Posted { self.execute_with_waker(task, waker); continue; }
            if phase == QueueRequestPhase::Idle && self.bridge.cleanup_waiting[task].get() { break QueueBoundary::CleanupWaiting; }
            assert!(phase == QueueRequestPhase::Waiting, "Foreign Pending is unsupported by the private Queue bridge");
            break QueueBoundary::Waiting;
        };
        self.depth.set(depth - 1); self.active[task].set(false); boundary
    }
    fn dispatch_with_waker(&self, waker: &std::task::Waker) -> bool {
        if self.bridge.closed.get() { return false; }
        assert!(!self.active.iter().any(|active| active.get()), "Dispatch only at a semantic boundary");
        self.step(); self.queue.dispatch(&mut |event| self.route_with_waker(event, waker))
    }
    fn pump(&self, task: usize) -> QueueBoundary { self.pump_with_waker(task, std::task::Waker::noop()) }
    fn dispatch(&self) -> bool { self.dispatch_with_waker(std::task::Waker::noop()) }
    fn route(&self, event: QueueEvent) { self.route_with_waker(event, std::task::Waker::noop()); }
    fn start(&self) {
        self.pump(0); self.pump(1); self.dispatch();
    }
    fn begin_interrupt(&self, task: usize, waker: &std::task::Waker) -> bool {
        assert!(task < 2 && !self.active.iter().any(|active| active.get()), "Interrupt only at a semantic boundary");
        if self.done[task].get() || self.bridge.interrupted[task].get() { return false; }
        if self.bridge.cleanup_waiting[task].get() {
            assert!(self.bridge.slots.borrow()[task].phase == QueueRequestPhase::Idle, "Masked cleanup retained Queue request");
            self.bridge.interrupted[task].set(true); return true;
        }
        let (ticket, generation) = {
            let mut slots = self.bridge.slots.borrow_mut(); let slot = &mut slots[task];
            assert!(slot.phase == QueueRequestPhase::Waiting, "Interrupt only a Queue-waiting child");
            let ticket = slot.ticket.take().expect("Interrupted Queue waiter ticket");
            self.bridge.interrupted[task].set(true); slot.phase = QueueRequestPhase::Processing;
            (ticket, slot.generation)
        };
        // Registration cleanup and any peer callbacks precede authored finalizers.
        self.queue.cancel(ticket, &mut |event| self.route_with_waker(event, waker));
        self.publish(task, generation, QueueResponse::Interrupted);
        let boundary = self.pump_with_waker(task, waker);
        assert!(boundary == QueueBoundary::Complete || boundary == QueueBoundary::CleanupWaiting, "Waiting Queue cleanup is unsupported");
        true
    }
    fn interrupt(&self, task: usize) -> bool {
        let interrupted = self.begin_interrupt(task, std::task::Waker::noop());
        if interrupted { assert!(self.done[task].get(), "Suspending Queue cleanup is unsupported"); }
        interrupted
    }
    fn interrupt_all(&self) -> bool {
        // The first cleanup may complete its peer normally before its turn.
        let first = self.interrupt(0); let second = self.interrupt(1); first || second
    }
    fn close(&self) -> bool {
        assert!(!self.active.iter().any(|active| active.get()), "Close only at a semantic boundary");
        self.retire()
    }
    fn retire(&self) -> bool {
        if self.bridge.closed.replace(true) { return false; }
        for done in &self.done { done.set(true); }
        // Drop cannot poll borrowed futures, panic on a RefCell borrow, or trust
        // a receipt that may not have been published before unwinding.
        if let Ok(mut slots) = self.bridge.slots.try_borrow_mut() {
            for slot in slots.iter_mut() {
                slot.phase = QueueRequestPhase::Idle; slot.request = None;
                slot.response = None; slot.ticket = None;
            }
        }
        // Both owner task IDs are exclusively ours and already inactive. This
        // is whole-driver retirement, never per-operation cancellation.
        let mut state = self.queue.state.lock().unwrap_or_else(|poison| poison.into_inner());
        for registration in &mut state.bank { *registration = None; }
        if state.life == QueueLife::Closing && state.len == 0 { state.life = QueueLife::Done; }
        state.scheduled = false; state.driver_owned = false;
        true
    }
    fn cancel(&self, task: usize) -> bool {
        assert!(task < 2 && !self.active[task].get(), "Cancel outside child poll/continuation");
        if self.done[task].replace(true) { return false; }
        let ticket = {
            let mut slots = self.bridge.slots.borrow_mut(); let slot = &mut slots[task];
            let ticket = slot.ticket.take(); slot.phase = QueueRequestPhase::Idle;
            slot.request = None; slot.response = None; ticket
        };
        // Abandoning cancellation has no authored finalizers; use interrupt for settlement.
        if let Some(ticket) = ticket { self.queue.cancel(ticket, &mut |event| self.route(event)); }
        true
    }
}
impl<T: Copy, const C: usize, F: std::future::Future<Output = ()>, G: std::future::Future<Output = ()>> Drop for QueueDriver<'_, T, C, F, G> {
    fn drop(&mut self) { self.retire(); }
}
`;
