/** Never-error All driver for an interruptible parent; generated limits come from checked profile receipts. */
export const semaphoreAllRuntime = (
  limits: { readonly scans: number; readonly settlementRounds: number } = {
    scans: 64,
    settlementRounds: 64,
  },
): string => `
struct ScanAllState<const K: usize> {
    started: [bool; K], done: [bool; K], terminal: bool,
    parent_cancelled: bool, settle_requested: bool,
}
impl<const K: usize> ScanAllState<K> {
    fn new() -> Self {
        Self { started: [false; K], done: [false; K], terminal: false,
            parent_cancelled: false, settle_requested: false }
    }
    fn interrupt(&mut self, children: &[tokio::sync::watch::Sender<bool>; K]) {
        for index in 0..K {
            if self.started[index] && !self.done[index] { let _ = children[index].send(true); }
            if !self.started[index] { self.done[index] = true; }
        }
        self.settle_requested = true;
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
fn scan_all_turn<F: std::future::Future<Output = bool>, const N: usize, const K: usize>(
    state: &mut ScanAllState<K>, index: usize, bank: &ScanTasks<N>, slot: usize,
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
      `scan_all_turn(&mut state, ${i}, bank, slots[${i}], f${i}.as_mut(), &mut out${i}, &children, cx);`;
    return `
async fn scan_all${arity}<${indices.map((i) => `F${i}: std::future::Future<Output = bool>`).join(", ")}, const N: usize>(
    owner: &ScanSemaphore<N>, bank: &ScanTasks<N>, slots: [usize; ${arity}],
    ${indices.map((i) => `mut f${i}: std::pin::Pin<&mut F${i}>`).join(", ")},
    children: [tokio::sync::watch::Sender<bool>; ${arity}],
    mut parent: tokio::sync::watch::Receiver<bool>,
) -> bool {
    assert!(slots.iter().all(|slot| *slot < N), "Checked All task slots");
    ${indices.flatMap((i) => indices.filter((j) => j > i).map((j) => `assert_ne!(slots[${i}], slots[${j}], "Distinct All tasks");`)).join("\n    ")}
    let mut state = ScanAllState::<${arity}>::new();
    ${indices.map((i) => `let mut out${i} = None;`).join("\n    ")}
    {
        let cancellation = async {
            loop {
                if *parent.borrow() || parent.has_changed().is_err() { return; }
                if parent.changed().await.is_err() { return; }
            }
        };
        tokio::pin!(cancellation);
        std::future::poll_fn(|cx| {
            macro_rules! check_parent { () => {
                if !state.parent_cancelled &&
                    std::future::Future::poll(cancellation.as_mut(), cx).is_ready() {
                    state.parent(&children);
                }
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
            ${indices
              .map(
                (i) => `check_parent!(); settle!();
            ${turn(i)}
            check_parent!(); settle!();
            let mut scans = 0;
            while owner.dispatch_one(|selected| {
                check_parent!(); settle!();
                ${indices.map((j) => `${j === 0 ? "if" : "else if"} selected == slots[${j}] { ${turn(j)} }`).join(" ")}
                else { panic!("All scan selected a task outside its static group"); }
                // Terminal cleanup may release permits, but peers are cancelled before reuse.
                check_parent!(); settle!();
            }) {
                check_parent!(); settle!();
                scans += 1;
                assert!(scans <= ${limits.scans}, "Checked All scan bound");
            }`,
              )
              .join("\n            ")}
            check_parent!(); settle!();
            if state.done.iter().all(|done| *done) { std::task::Poll::Ready(()) }
            else { std::task::Poll::Pending }
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
