/** Private context/coordinator experiment. No compiler path selects this emitter. */
export const deferredCoordinatorRuntime = (includeJoins = true): string => `
#[derive(Clone, Copy)]
struct DeferredTurnHandle<'a, const N: usize> {
    bank: &'a DeferredTurns<N>,
    task: usize,
}
impl<'a, const N: usize> DeferredTurnHandle<'a, N> {
    fn new(bank: &'a DeferredTurns<N>, task: usize) -> Self {
        assert!(task < N, "Checked coordinator task identity");
        Self { bank, task }
    }
    async fn semantic<F: std::future::Future>(self, future: F) -> F::Output {
        // Tokio's automatic coop yield must not masquerade as an authored suspension.
        let future = tokio::task::unconstrained(future);
        tokio::pin!(future);
        std::future::poll_fn(|cx| {
            let result = std::future::Future::poll(future.as_mut(), cx);
            if result.is_pending() { self.bank.suspended(self.task); }
            result
        }).await
    }
    async fn task<F: std::future::Future>(self, future: F) -> F::Output {
        tokio::pin!(future);
        std::future::poll_fn(|cx| {
            self.bank.before_poll(self.task);
            let result = std::future::Future::poll(future.as_mut(), cx);
            self.bank.after_poll(self.task, result.is_ready(), cx.waker());
            result
        }).await
    }
    async fn wait<A: Copy, E: Copy, const M: usize>(self,
        owner: &DeferredState<A, E, M>, ctx: &mut AsyncContext)
        -> Result<A, AsyncError<E>> {
        if ctx.is_cancelled() { return Err(AsyncError::Interrupted); }
        if !ctx.interruptible {
            return owner.wait(self.bank, self.task).await.map_err(AsyncError::Fail);
        }
        self.semantic(async {
            tokio::select! {
                biased;
                _ = ctx.cancellation.changed() => Err(AsyncError::Interrupted),
                outcome = owner.wait(self.bank, self.task) => outcome.map_err(AsyncError::Fail),
            }
        }).await
    }
    async fn complete<A: Copy, E: Copy, X, const M: usize>(self,
        owner: &DeferredState<A, E, M>, ctx: &mut AsyncContext, outcome: Result<A, E>)
        -> Result<bool, AsyncError<X>> {
        if ctx.is_cancelled() { return Err(AsyncError::Interrupted); }
        let interruptible = ctx.interruptible;
        ctx.interruptible = false;
        // Artificial Pending is not semantic, and cancellation cannot abandon the cohort.
        let won = owner.complete(self.bank, self.task, outcome).await;
        ctx.interruptible = interruptible;
        if ctx.is_cancelled() { Err(AsyncError::Interrupted) } else { Ok(won) }
    }
    async fn sleep<E>(self, ctx: &mut AsyncContext, milliseconds: u64)
        -> Result<(), AsyncError<E>> {
        self.semantic(ctx.sleep(milliseconds)).await
    }
}
${(includeJoins ? [2, 3] : [])
  .map((arity) => {
    const indices = Array.from({ length: arity }, (_, i) => i);
    const letters = indices.map((i) => String.fromCharCode(65 + i));
    return `
async fn deferred_join${arity}<${letters.map((x) => `${x}: std::future::Future`).join(", ")}, const N: usize>(
    bank: &DeferredTurns<N>, slots: [usize; ${arity}],
    ${indices.map((i) => `f${i}: ${letters[i]}`).join(", ")})
    -> (${letters.map((x) => `${x}::Output`).join(", ")}) {
    assert!(N > 0 && N <= 4, "Private unnested coordinator profile");
    assert!(bank.priority().is_none(), "No group startup inside resumed callbacks");
    assert!(slots.iter().all(|slot| *slot < N), "Checked group slots");
    ${indices
      .flatMap((i) =>
        indices
          .filter((j) => j > i)
          .map((j) => `assert_ne!(slots[${i}], slots[${j}], "Distinct child identities");`),
      )
      .join("\n    ")}
    tokio::pin!(${indices.map((i) => `f${i}`).join(", ")});
    ${indices.map((i) => `let mut out${i} = None;`).join("\n    ")}
    std::future::poll_fn(|cx| {
        // Retry adapter progress only; primitive wakeups return to the executor.
        for _ in 0..(2 * N * N + 2 * N) {
            bank.take_changed();
            ${indices
              .map(
                (i) => `if out${i}.is_none() && bank.permits(slots[${i}], |_, _| false) {
                if let std::task::Poll::Ready(value) = std::future::Future::poll(f${i}.as_mut(), cx) { out${i} = Some(value); }
                if bank.take_changed() { continue; }
            }`,
              )
              .join("\n            ")}
            if ${indices.map((i) => `out${i}.is_some()`).join(" && ")} {
                assert!(bank.priority().is_none(), "Completed group drains all turns");
                return std::task::Poll::Ready((${indices.map((i) => `out${i}.take().expect("Completed child")`).join(", ")}));
            }
            return std::task::Poll::Pending;
        }
        cx.waker().wake_by_ref();
        std::task::Poll::Pending
    }).await
}
`;
  })
  .join("")}
`;
