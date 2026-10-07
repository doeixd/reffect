/** Private current-thread host adapter; emitted beside asyncRuntime(false, false). */
export const queueHostRuntime = (): string => String.raw`
struct QueueCleanupMask<'a> { context: &'a mut AsyncContext, previous: bool }
impl Drop for QueueCleanupMask<'_> {
    fn drop(&mut self) { self.context.interruptible = self.previous; }
}
impl<T: Copy> QueueTask<'_, T> {
    async fn cleanup_sleep(&self, context: &mut AsyncContext, milliseconds: u64) {
        assert!(!self.bridge.closed.get(), "Closed Queue cleanup bridge");
        let previous = context.interruptible; context.interruptible = false;
        let mask = QueueCleanupMask { context, previous };
        let mut sleep = std::pin::pin!(mask.context.sleep::<std::convert::Infallible>(milliseconds));
        std::future::poll_fn(|cx| {
            match std::future::Future::poll(sleep.as_mut(), cx) {
                std::task::Poll::Pending => {
                    self.bridge.cleanup_waiting[self.task].set(true);
                    std::task::Poll::Pending
                }
                std::task::Poll::Ready(result) => {
                    self.bridge.cleanup_waiting[self.task].set(false);
                    assert!(result.is_ok(), "Masked Queue cleanup sleep interrupted");
                    std::task::Poll::Ready(())
                }
            }
        }).await;
        // The pinned Sleep is destroyed before mask restores interruptibility.
    }
}
impl<T: Copy, const C: usize, F: std::future::Future<Output = ()>, G: std::future::Future<Output = ()>> QueueDriver<'_, T, C, F, G> {
    async fn run_hosted(&self, context: &mut AsyncContext) -> bool {
        assert!(!self.bridge.closed.get(), "Closed hosted Queue driver");
        assert!(self.steps.get() == 0 && !self.is_done(0) && !self.is_done(1), "Hosted Queue driver must start fresh and run once");
        let interruptible = context.interruptible;
        let mut cancellation = context.cancellation.clone();
        let mut monitor = std::pin::pin!(async move {
            loop {
                if *cancellation.borrow() || cancellation.has_changed().is_err() { return; }
                if cancellation.changed().await.is_err() { return; }
                // False updates acknowledge the version and register again without yielding.
            }
        });
        let mut started = false;
        let mut interrupted = false;
        let mut monitor_done = false;
        std::future::poll_fn(|cx| {
            let cancelled = if interruptible {
                if !monitor_done && std::future::Future::poll(monitor.as_mut(), cx).is_ready() {
                    monitor_done = true;
                }
                monitor_done || context.is_cancelled()
            } else { false };
            if !started {
                started = true;
                if cancelled {
                    self.cancel(0); self.cancel(1);
                    return std::task::Poll::Ready(true); // No child body or cleanup was entered.
                }
                self.pump_with_waker(0, cx.waker());
                if context.is_cancelled() {
                    // The second child's body has not entered a scope: retire without polling.
                    self.cancel(1);
                    self.begin_interrupt(0, cx.waker()); interrupted = true;
                } else {
                    self.pump_with_waker(1, cx.waker());
                }
            }
            if !interrupted && (cancelled || context.is_cancelled()) {
                interrupted = true;
                // Initiate in source order through first managed suspension, then settle both.
                self.begin_interrupt(0, cx.waker());
                self.begin_interrupt(1, cx.waker());
            }
            for task in 0..2 {
                if !self.is_done(task) && self.bridge.cleanup_waiting[task].get() {
                    self.pump_with_waker(task, cx.waker());
                }
            }
            // Startup and resumed cleanup reach semantic boundaries before Queue dispatch.
            if !interrupted && context.is_cancelled() {
                interrupted = true;
                self.begin_interrupt(0, cx.waker()); self.begin_interrupt(1, cx.waker());
            }
            self.dispatch_with_waker(cx.waker());
            if self.is_done(0) && self.is_done(1) {
                // Late root cancellation wins only after all entered cleanup has completed.
                return std::task::Poll::Ready(interrupted || context.is_cancelled());
            }
            std::task::Poll::Pending
        }).await
    }
}
`;
