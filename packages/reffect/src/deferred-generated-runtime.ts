import { deferredCoordinatorRuntime } from "./deferred-coordinator-runtime.ts";
import { deferredStateRuntime } from "./deferred-state-runtime.ts";
import { deferredTurnRuntime } from "./deferred-turn-runtime.ts";

/** Private generated profile; every admitted All waits for child finalization. */
export const deferredGeneratedRuntime = (arities: readonly number[] = [2, 3]): string =>
  [
    deferredTurnRuntime(),
    deferredStateRuntime(),
    deferredCoordinatorRuntime(false),
    ...Array.from(new Set(arities)).map((arity) => {
      if (arity !== 2 && arity !== 3) throw new Error("Checked generated All arity must be 2 or 3");
      const indices = Array.from({ length: arity }, (_, index) => index);
      const cancelAll = indices.map((index) => `let _ = cancel${index}.send(true);`).join(" ");
      return `
async fn coordinated_task_group${arity}<${indices.map((index) => `F${index}: std::future::Future<Output = bool>`).join(", ")}, const N: usize>(
    bank: &DeferredTurns<N>, slots: [usize; ${arity}],
    ${indices.map((index) => `future${index}: F${index}, cancel${index}: tokio::sync::watch::Sender<bool>,`).join("\n    ")}
    mut parent: tokio::sync::watch::Receiver<bool>, interruptible: bool,
) -> bool {
    assert!(N > 0 && N <= 4, "Private unnested coordinator profile");
    assert!(bank.priority().is_none(), "No group startup inside resumed callbacks");
    assert!(slots.iter().all(|slot| *slot < N), "Checked group slots");
    ${indices.flatMap((index) => indices.filter((other) => other > index).map((other) => `assert_ne!(slots[${index}], slots[${other}], "Distinct child identities");`)).join("\n    ")}
    ${indices.map((index) => `tokio::pin!(future${index}); let mut done${index} = false;`).join("\n    ")}
    let mut interrupted = false;
    let mut parent_cancelled = false;
    {
        let cancellation = async {
            loop {
                if *parent.borrow() || parent.has_changed().is_err() { return; }
                if parent.changed().await.is_err() { return; }
            }
        };
        tokio::pin!(cancellation);
        std::future::poll_fn(|cx| {
            // Parent watch registration remains live even when a completion masks its caller.
            for _ in 0..(2 * N * N + 2 * N) {
                if interruptible && !parent_cancelled && std::future::Future::poll(cancellation.as_mut(), cx).is_ready() {
                    parent_cancelled = true;
                    ${cancelAll}
                }
                bank.take_changed();
                ${indices
                  .map(
                    (index) => `if !done${index} && bank.permits(slots[${index}], |_, _| false) {
                    if let std::task::Poll::Ready(success) = std::future::Future::poll(future${index}.as_mut(), cx) {
                        done${index} = true;
                        if !success { interrupted = true; ${cancelAll} }
                    }
                    if bank.take_changed() { continue; }
                }`,
                  )
                  .join("\n                ")}
                if ${indices.map((index) => `done${index}`).join(" && ")} {
                    assert!(bank.priority().is_none(), "Completed group drains all turns");
                    return std::task::Poll::Ready(());
                }
                return std::task::Poll::Pending;
            }
            // Protocol-only retry never acknowledges an authored semantic suspension.
            cx.waker().wake_by_ref();
            std::task::Poll::Pending
        }).await;
    }
    // Cancellation arriving during the last masked cleanup wins at the group boundary.
    if interruptible && (*parent.borrow() || parent.has_changed().is_err()) { parent_cancelled = true; }
    !parent_cancelled && !interrupted
}
`;
    }),
  ].join("\n");
