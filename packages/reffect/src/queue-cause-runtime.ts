import { specializeQueueRuntime, type QueueRuntimeFamily } from "./queue-runtime-symbols.ts";

/** Private adapter; requires fallible Queue emission and causeRuntime(_, true). */
export const queueCauseRuntime = (family: QueueRuntimeFamily = "Default"): string =>
  specializeQueueRuntime(
    String.raw`
impl<T: Copy, const C: usize, F: std::future::Future<Output = Result<(), QueueTakeFailure>>, G: std::future::Future<Output = Result<(), QueueTakeFailure>>> QueueDriver<'_, T, C, F, G> {
    fn all_cause(&self, parent_interrupted: bool) -> RuntimeCause {
        let result = self.all_exit(parent_interrupted);
        let mut cause = RuntimeCause::empty();
        cause.interrupted = parent_interrupted || self.terminal_interrupted.get();
        match result {
            Ok(()) => {},
            Err(QueueTakeFailure::Done(_)) => cause.push(RuntimeFailure::QueueDone, true),
            Err(QueueTakeFailure::OwnerInterrupted | QueueTakeFailure::ControlInterrupted) => cause.interrupted = true,
        }
        cause
    }
}
fn queue_recover_all_done(context: &AsyncContext, cause: RuntimeCause, handler: impl FnOnce(QueueDone)) -> RuntimeCause {
    assert!((cause.len == 0 && cause.first().is_none()) || (cause.len == 1 && cause.first() == Some(RuntimeFailure::QueueDone)), "Checked unit Done cause");
    if cause.first().is_none() || context.is_cancelled() { return cause; }
    handler(QueueDone);
    let mut recovered = RuntimeCause::empty();
    recovered.interrupted = context.is_cancelled();
    recovered
}
`,
    family,
  );
