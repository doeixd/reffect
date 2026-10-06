/** Never-error All driver for an interruptible parent; generated limits come from checked profile receipts. */
export const latchAllRuntime = (
  limits: { readonly cohorts: number; readonly settlementRounds: number } = {
    cohorts: 64,
    settlementRounds: 64,
  },
): string => `
struct LatchAllState<const K: usize> {
    started: [bool; K], done: [bool; K], terminal: bool,
    parent_cancelled: bool, settle_requested: bool, cancellation_seen: [bool; K],
}
impl<const K: usize> LatchAllState<K> {
    fn new() -> Self {
        Self { started: [false; K], done: [false; K], terminal: false,
            parent_cancelled: false, settle_requested: false, cancellation_seen: [false; K] }
    }
    fn interrupt(&mut self, children: &[tokio::sync::watch::Sender<bool>; K]) {
        for index in 0..K {
            if self.started[index] && !self.done[index] {
                let _ = children[index].send(true);
                self.cancellation_seen[index] = true;
            }
            if !self.started[index] { self.done[index] = true; }
        }
        self.settle_requested = true;
    }
    fn check_children(&mut self, children: &[tokio::sync::watch::Sender<bool>; K]) {
        for index in 0..K {
            if self.started[index] && !self.done[index] && !self.cancellation_seen[index]
                && *children[index].borrow() {
                self.cancellation_seen[index] = true;
                self.settle_requested = true;
            }
        }
    }
    fn observe(&mut self, index: usize, success: bool,
        children: &[tokio::sync::watch::Sender<bool>; K]) {
        self.done[index] = true;
        if !success && !self.terminal {
            self.terminal = true;
            self.interrupt(children);
        }
    }
    fn parent(&mut self, children: &[tokio::sync::watch::Sender<bool>; K]) {
        self.parent_cancelled = true;
        self.interrupt(children);
    }
}
fn latch_all_turn<F: std::future::Future<Output = bool>, const N: usize, const K: usize>(
    state: &mut LatchAllState<K>, index: usize, bank: &ScanTasks<N>, slot: usize,
    future: std::pin::Pin<&mut F>, output: &mut Option<bool>,
    children: &[tokio::sync::watch::Sender<bool>; K], cx: &mut std::task::Context<'_>,
) {
    if state.done[index] { return; }
    state.started[index] = true;
    scan_poll(bank, slot, future, output, cx);
    if let Some(success) = *output { state.observe(index, success, children); }
}
${[2, 3]
  .map((arity) => {
    const indices = Array.from({ length: arity }, (_, i) => i);
    const turn = (i: number) =>
      `latch_all_turn(&mut state, ${i}, bank, slots[${i}], f${i}.as_mut(), &mut out${i}, &children, cx);`;
    const drainCohorts = `let mut cohorts = 0;
            while owner.dispatch_one(|selected| {
                check_parent!(); settle!();
                ${indices.map((j) => `${j === 0 ? "if" : "else if"} selected == slots[${j}] { ${turn(j)} }`).join(" ")}
                else { panic!("All cohort selected a task outside its static group"); }
                check_parent!(); settle!();
            }) {
                check_parent!(); settle!();
                cohorts += 1;
                assert!(cohorts <= ${limits.cohorts}, "Checked All cohort bound");
            }`;
    const orderedTurns = `
            if !startup_done {
                startup_done = true;
                ${indices.map((i) => `check_parent!(); settle!(); ${turn(i)} check_parent!(); settle!();`).join("\n                ")}
                ${drainCohorts}
                if state.done.iter().all(|done| *done) { return std::task::Poll::Ready(()); }
                assert!(!owner.has_scheduled(), "No scheduled cohort crosses a timer suspension");
                arm_timer!();
                return std::task::Poll::Pending;
            }
            // The poll-entry snapshot excludes timers registered by this wave or cleanup.
            for ready in timer_wave.into_iter().flatten() {
                check_parent!(); settle!();
                ${indices
                  .map(
                    (i) => `${i === 0 ? "if" : "else if"} ready.task == slots[${i}] {
                    if !state.done[${i}] && bank.grant_timer(ready) { ${turn(i)} }
                }`,
                  )
                  .join(" ")}
                else { panic!("Timer selected a task outside its static group"); }
                check_parent!(); settle!();
            }
            // Detached Latch cohorts cannot interrupt the current due-timer pass.
            check_parent!(); settle!();
            ${drainCohorts}
            // No further settlement may schedule a cohort before the Pending invariant.
            if state.done.iter().all(|done| *done) { std::task::Poll::Ready(()) }
            else {
                assert!(!owner.has_scheduled(), "No scheduled cohort crosses a timer suspension");
                arm_timer!();
                std::task::Poll::Pending
            }`;
    return `
async fn latch_all${arity}<${indices.map((i) => `F${i}: std::future::Future<Output = bool>`).join(", ")}, const N: usize>(
    owner: &CohortLatch<N>, bank: &ScanTasks<N>, slots: [usize; ${arity}],
    ${indices.map((i) => `mut f${i}: std::pin::Pin<&mut F${i}>`).join(", ")},
    children: [tokio::sync::watch::Sender<bool>; ${arity}],
    mut parent: tokio::sync::watch::Receiver<bool>,
) -> bool {
    assert!(slots.iter().all(|slot| *slot < N), "Checked All task slots");
    ${indices.flatMap((i) => indices.filter((j) => j > i).map((j) => `assert_ne!(slots[${i}], slots[${j}], "Distinct All tasks");`)).join("\n    ")}
    let mut state = LatchAllState::<${arity}>::new();
    ${indices.map((i) => `let mut out${i} = None;`).join("\n    ")}
    let mut startup_done = false;
    let wake_timer = tokio::time::sleep_until(tokio::time::Instant::now());
    tokio::pin!(wake_timer);
    {
        let cancellation = async {
            loop {
                if *parent.borrow() || parent.has_changed().is_err() { return; }
                if parent.changed().await.is_err() { return; }
            }
        };
        tokio::pin!(cancellation);
        std::future::poll_fn(|cx| {
            let timer_wave = bank.timer_wave(slots, tokio::time::Instant::now());
            macro_rules! arm_timer { () => {
                if let Some(deadline) = bank.next_timer_deadline(slots) {
                    wake_timer.as_mut().reset(deadline);
                    if std::future::Future::poll(wake_timer.as_mut(), cx).is_ready() {
                        cx.waker().wake_by_ref();
                    }
                }
            }; }
            macro_rules! check_parent { () => {
                if !state.parent_cancelled &&
                    std::future::Future::poll(cancellation.as_mut(), cx).is_ready() {
                    state.parent(&children);
                }
                state.check_children(&children);
            }; }
            macro_rules! settle { () => {{
                let mut rounds = 0;
                while state.settle_requested {
                    state.settle_requested = false;
                    // Cleanup prefixes follow eager startup order. Never dispatch recursively.
                    ${indices.map((i) => `if state.started[${i}] && !state.done[${i}] { ${turn(i)} check_parent!(); }`).join("\n                    ")}
                    rounds += 1;
                    assert!(rounds <= ${limits.settlementRounds}, "Checked All settlement bound");
                }
            }}; }
            check_parent!(); settle!();
            ${orderedTurns}
        }).await;
    }
    // A late cancellation still wins after the last masked cleanup.
    if *parent.borrow() || parent.has_changed().is_err() { state.parent_cancelled = true; }
    !state.terminal && !state.parent_cancelled
}
`;
  })
  .join("\n")}
`;
