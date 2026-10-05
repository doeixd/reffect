import { deferredCoordinatorRuntime } from "./deferred-coordinator-runtime.ts";
import { deferredStateRuntime } from "./deferred-state-runtime.ts";
import { deferredTurnRuntime } from "./deferred-turn-runtime.ts";

/** Private generated profile; every admitted group waits for child finalization. */
export const deferredGeneratedRuntime = (arities: readonly number[] = [2, 3]): string =>
  [
    deferredTurnRuntime(),
    deferredStateRuntime(),
    deferredCoordinatorRuntime(false),
    ...Array.from(new Set(arities)).map((arity) => {
      if (arity !== 2 && arity !== 3)
        throw new Error("Checked generated group arity must be 2 or 3");
      const indices = Array.from({ length: arity }, (_, index) => index);
      const cancelAll = indices.map((index) => `let _ = cancel${index}.send(true);`).join(" ");
      return `
async fn coordinated_task_group${arity}<${indices.map((index) => `F${index}: std::future::Future<Output = bool>`).join(", ")}, const N: usize>(
    bank: &DeferredTurns<N>, slots: [usize; ${arity}], ends: [usize; ${arity}], parent_slot: usize,
    ${indices.map((index) => `mut future${index}: std::pin::Pin<&mut F${index}>, cancel${index}: tokio::sync::watch::Sender<bool>,`).join("\n    ")}
    mut parent: tokio::sync::watch::Receiver<bool>, interruptible: bool, race: bool,
) -> bool {
    assert!(N > 0 && N <= 6, "Private bounded coordinator profile");
    assert!(parent_slot < N && slots.iter().zip(ends).all(|(slot, end)| *slot < end && end <= N), "Checked group subtrees");
    ${indices.flatMap((index) => indices.filter((other) => other > index).map((other) => `assert!(ends[${index}] <= slots[${other}] || ends[${other}] <= slots[${index}], "Disjoint child subtrees");`)).join("\n    ")}
    ${indices.map((index) => `let mut done${index} = false; let mut started${index} = false;`).join("\n    ")}
    let mut interrupted = false;
    let mut winner: Option<usize> = None;
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
            ${indices.map((index) => `let mut semantic_pending${index} = false;`).join("\n            ")}
            // Parent watch registration remains live even when a completion masks its caller.
            for _ in 0..(2 * N * N + 2 * N) {
                if interruptible && !parent_cancelled && std::future::Future::poll(cancellation.as_mut(), cx).is_ready() {
                    parent_cancelled = true;
                    ${cancelAll}
                }
                bank.take_changed();
                ${indices
                  .map(
                    (
                      index,
                    ) => `if !done${index} && bank.permits(slots[${index}], |selected, child| child <= selected && selected < ends[${index}]) {
                    if race && winner.is_some() && !started${index} { done${index} = true; semantic_pending${index} = false; continue; }
                    started${index} = true;
                    let previous_priority = bank.priority();
                    if let std::task::Poll::Ready(success) = std::future::Future::poll(future${index}.as_mut(), cx) {
                        done${index} = true;
                        semantic_pending${index} = false;
                        if race {
                            if success && winner.is_none() { winner = Some(${index}); ${indices
                              .filter((other) => other !== index)
                              .map((other) => `let _ = cancel${other}.send(true);`)
                              .join(" ")} }
                        } else if !success { interrupted = true; ${cancelAll} }
                    } else {
                        semantic_pending${index} = bank.was_suspended(slots[${index}]);
                    }
                    if bank.take_changed() || bank.priority() != previous_priority { continue; }
                }`,
                  )
                  .join("\n                ")}
                if ${indices.map((index) => `done${index}`).join(" && ")} {
                    return std::task::Poll::Ready(());
                }
                if ${indices.map((index) => `semantic_pending${index}`).join(" || ")} { bank.suspended(parent_slot); }
                return std::task::Poll::Pending;
            }
            // Protocol-only retry never acknowledges an authored semantic suspension.
            if ${indices.map((index) => `semantic_pending${index}`).join(" || ")} { bank.suspended(parent_slot); }
            cx.waker().wake_by_ref();
            std::task::Poll::Pending
        }).await;
    }
    // Cancellation arriving during the last masked cleanup wins at the group boundary.
    if interruptible && (*parent.borrow() || parent.has_changed().is_err()) { parent_cancelled = true; }
    !parent_cancelled && if race { winner.is_some() } else { !interrupted }
}
`;
    }),
  ].join("\n");
