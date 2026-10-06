/** Semantic-marker driver; generated limits require checked profile receipts. Defaults retain private experiments. */
export const semaphoreTaskRuntime = (
  limits: { readonly protocolRetries: number; readonly scans: number } = {
    protocolRetries: 64,
    scans: 64,
  },
): string => `
struct ScanTasks<const N: usize> { semantic: std::sync::Mutex<[bool; N]> }
impl<const N: usize> ScanTasks<N> {
    fn new() -> Self {
        assert!((1..=4).contains(&N), "Private task bank bounds");
        Self { semantic: std::sync::Mutex::new([false; N]) }
    }
    fn before_poll(&self, task: usize) { self.semantic.lock().expect("Scan task bank")[task] = false; }
    fn suspended(&self, task: usize) { self.semantic.lock().expect("Scan task bank")[task] = true; }
    fn was_suspended(&self, task: usize) -> bool { self.semantic.lock().expect("Scan task bank")[task] }
}
#[derive(Clone, Copy)]
struct ScanTask<'a, const N: usize> { bank: &'a ScanTasks<N>, task: usize }
impl<'a, const N: usize> ScanTask<'a, N> {
    fn new(bank: &'a ScanTasks<N>, task: usize) -> Self {
        assert!(task < N, "Checked scan task slot");
        Self { bank, task }
    }
    async fn semantic<F: std::future::Future>(self, future: F) -> F::Output {
        let future = tokio::task::unconstrained(future);
        tokio::pin!(future);
        std::future::poll_fn(|cx| {
            let result = std::future::Future::poll(future.as_mut(), cx);
            if result.is_pending() { self.bank.suspended(self.task); }
            result
        }).await
    }
    async fn acquire<'b>(self, owner: &'b ScanSemaphore<N>, ctx: &mut AsyncContext)
        -> Result<ScanPermit<'b, N>, AsyncError<std::convert::Infallible>> {
        if ctx.is_cancelled() { return Err(AsyncError::Interrupted); }
        let permit = if ctx.interruptible {
            self.semantic(async {
                tokio::select! {
                    biased;
                    _ = ctx.cancellation.changed() => Err(AsyncError::Interrupted),
                    permit = owner.acquire(self.task) => Ok(permit),
                }
            }).await?
        } else { self.semantic(owner.acquire(self.task)).await };
        // Ownership is established before restoring body interruption, with no await gap.
        if ctx.is_cancelled() { drop(permit); Err(AsyncError::Interrupted) } else { Ok(permit) }
    }
}
async fn scan_with_parent<F: std::future::Future, const K: usize>(
    future: F, mut parent: tokio::sync::watch::Receiver<bool>,
    children: [tokio::sync::watch::Sender<bool>; K],
) -> (F::Output, bool) {
    assert!((2..=3).contains(&K), "Private parent group bounds");
    tokio::pin!(future);
    let mut interrupted = false;
    let output = {
        let cancellation = async {
            loop {
                if *parent.borrow() || parent.has_changed().is_err() { return; }
                if parent.changed().await.is_err() { return; }
            }
        };
        tokio::pin!(cancellation);
        std::future::poll_fn(|cx| {
            if !interrupted && std::future::Future::poll(cancellation.as_mut(), cx).is_ready() {
                interrupted = true;
                for child in &children { let _ = child.send(true); }
            }
            // Never drop a child to implement interruption: await its masked cleanup.
            std::future::Future::poll(future.as_mut(), cx)
        }).await
    };
    interrupted |= *parent.borrow() || parent.has_changed().is_err();
    (output, interrupted)
}
fn scan_poll<F: std::future::Future, const N: usize>(
    bank: &ScanTasks<N>, task: usize, mut future: std::pin::Pin<&mut F>,
    out: &mut Option<F::Output>, cx: &mut std::task::Context<'_>,
) {
    assert!(out.is_none(), "A completed scan task cannot be polled again");
    for _ in 0..${limits.protocolRetries} {
        bank.before_poll(task);
        match std::future::Future::poll(future.as_mut(), cx) {
            std::task::Poll::Ready(value) => { *out = Some(value); return; }
            std::task::Poll::Pending if bank.was_suspended(task) => return,
            // A protocol retry cannot finish a synchronous continuation or scan callback.
            std::task::Poll::Pending => {},
        }
    }
    panic!("Checked scan protocol retry bound");
}
${[2, 3]
  .map((arity) => {
    const indices = Array.from({ length: arity }, (_, i) => i);
    return `
async fn scan_join${arity}<${indices.map((i) => `F${i}: std::future::Future`).join(", ")}, const N: usize>(
    owner: &ScanSemaphore<N>, bank: &ScanTasks<N>, slots: [usize; ${arity}],
    ${indices.map((i) => `mut f${i}: std::pin::Pin<&mut F${i}>`).join(", ")},
) -> (${indices.map((i) => `F${i}::Output`).join(", ")}) {
    assert!(slots.iter().all(|slot| *slot < N), "Checked scan group slots");
    ${indices.flatMap((i) => indices.filter((j) => j > i).map((j) => `assert_ne!(slots[${i}], slots[${j}], "Distinct scan group tasks");`)).join("\n    ")}
    ${indices.map((i) => `let mut out${i} = None;`).join("\n    ")}
    std::future::poll_fn(|cx| {
        ${indices
          .map(
            (i) => `if out${i}.is_none() {
            scan_poll(bank, slots[${i}], f${i}.as_mut(), &mut out${i}, cx);
        }
        // The releasing task has now reached semantic suspension or completion.
        let mut scans = 0;
        while owner.dispatch_one(|selected| {
            ${indices
              .map(
                (j) => `${j === 0 ? "if" : "else if"} selected == slots[${j}] {
                scan_poll(bank, selected, f${j}.as_mut(), &mut out${j}, cx);
            }`,
              )
              .join(" ")}
            else { panic!("Scan selected a task outside this private static group"); }
        }) {
            scans += 1;
            assert!(scans <= ${limits.scans}, "Checked scan dispatch bound");
        }`,
          )
          .join("\n        ")}
        if ${indices.map((i) => `out${i}.is_some()`).join(" && ")} {
            return std::task::Poll::Ready((${indices.map((i) => `out${i}.take().expect("Completed scan task")`).join(", ")}));
        }
        std::task::Poll::Pending
    }).await
}
`;
  })
  .join("\n")}
`;
