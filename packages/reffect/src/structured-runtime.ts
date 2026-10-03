/** Fixed-arity coordinator: completion always awaits child cleanup before returning. */
export const structuredRuntime = (arities: readonly number[]): string =>
  [...new Set(arities)]
    .map((arity) => {
      const indices = Array.from({ length: arity }, (_, index) => index);
      const cancelAll = indices.map((index) => `let _ = cancel${index}.send(true);`).join(" ");
      return `
async fn task_group${arity}<${indices.map((index) => `F${index}: std::future::Future<Output = bool>`).join(", ")}>(
    ${indices.map((index) => `future${index}: F${index}, cancel${index}: tokio::sync::watch::Sender<bool>,`).join("\n    ")}
    mut parent: tokio::sync::watch::Receiver<bool>, interruptible: bool, race: bool,
) -> bool {
    ${indices.map((index) => `tokio::pin!(future${index}); let mut done${index} = false;`).join("\n    ")}
    let mut interrupted = false;
    let mut winner = false;
    let mut parent_cancelled = false;
    loop {
        if interruptible && !parent_cancelled && (*parent.borrow() || parent.has_changed().is_err()) {
            parent_cancelled = true;
            ${cancelAll}
        }
        if ${indices.map((index) => `done${index}`).join(" && ")} { break; }
        tokio::select! {
            biased;
            _ = parent.changed(), if interruptible && !parent_cancelled => {}
            ${indices
              .map(
                (index) => `success = &mut future${index}, if !done${index} => {
                done${index} = true;
                if success {
                    if race && !winner { winner = true; ${cancelAll} }
                } else {
                    interrupted = true;
                    if !race { ${cancelAll} }
                }
            }`,
              )
              .join("\n            ")}
        }
    }
    // Cancellation arriving while the last child is masked still wins at the boundary.
    if interruptible && (*parent.borrow() || parent.has_changed().is_err()) { parent_cancelled = true; }
    !parent_cancelled && if race { winner } else { !interrupted }
}
`;
    })
    .join("\n");

/** Fallible specialization retains bounded scalar causes and awaits every admitted child. */
export const fallibleStructuredRuntime = (arities: readonly number[], frames: boolean): string =>
  [...new Set(arities)]
    .map((arity) => {
      const indices = Array.from({ length: arity }, (_, index) => index);
      const cancelAll = indices.map((index) => `let _ = cancel${index}.send(true);`).join(" ");
      return `
async fn fallible_task_group${arity}<${indices.map((index) => `F${index}: std::future::Future<Output = Result<(), TaskFailure>>`).join(", ")}>(
    ${indices.map((index) => `future${index}: F${index}, cancel${index}: tokio::sync::watch::Sender<bool>,`).join("\n    ")}
    mut parent: tokio::sync::watch::Receiver<bool>, interruptible: bool, race: bool,
) -> Result<(), TaskFailure> {
    ${indices.map((index) => `tokio::pin!(future${index}); let mut done${index} = false;`).join("\n    ")}
    let mut cause = RuntimeCause::empty();
    ${frames ? "let mut frames = None;" : ""}
    let mut terminal = false;
    let mut winner = false;
    let mut parent_cancelled = false;
    loop {
        if interruptible && !parent_cancelled && (*parent.borrow() || parent.has_changed().is_err()) {
            parent_cancelled = true; ${cancelAll}
        }
        if ${indices.map((index) => `done${index}`).join(" && ")} { break; }
        tokio::select! {
            biased;
            _ = parent.changed(), if interruptible && !parent_cancelled => {}
            ${indices
              .map(
                (index) => `result = &mut future${index}, if !done${index} => {
                done${index} = true;
                match result {
                    Ok(()) => { if race && !winner { winner = true; ${cancelAll} } }
                    Err(failure) => {
                        ${frames ? "if frames.is_none() && failure.cause.len > 0 { frames = failure.frames; }" : ""}
                        if !terminal || race { cause.interrupted |= failure.cause.interrupted; }
                        for error in failure.cause.failures[..failure.cause.len].iter().flatten() {
                            cause.push(*error, !race && terminal);
                        }
                        if !terminal && !race { terminal = true; ${cancelAll} }
                    }
                }
            }`,
              )
              .join("\n            ")}
        }
    }
    if interruptible && (*parent.borrow() || parent.has_changed().is_err()) { parent_cancelled = true; }
    if parent_cancelled {
        if race { cause = RuntimeCause::empty(); ${frames ? "frames = None;" : ""} }
        cause.interrupted = true;
    }
    if !parent_cancelled && if race { winner } else { !terminal } { Ok(()) }
    else { Err(TaskFailure { cause, ${frames ? "frames," : ""} }) }
}
`;
    })
    .join("\n");
