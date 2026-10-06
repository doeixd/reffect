import { authoredChildren } from "./provenance.ts";
import { Match } from "effect";
import { Computation } from "./effect-ir.ts";
import { Expr } from "./kernel.ts";
import { containsQueue, containsQueueDone } from "./queue-model.ts";
export const hasQueueComputation = (body: Computation<unknown, unknown>): boolean => {
  const pending = [body];
  const seen = new Set<Computation<unknown, unknown>>();
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (
      Match.value(current.node).pipe(
        Match.tags({
          QueueMake: () => true,
          QueueScope: () => true,
          QueueOperation: () => true,
        }),
        Match.orElse(() => false),
      )
    )
      return true;
    for (const [, child] of authoredChildren(current))
      if (child instanceof Computation) pending.push(child);
  }
  return false;
};

/** Shared fail-closed native audit, including hidden pure operation channels. */
export const usesQueueNativeType = (
  root: Expr<unknown> | Computation<unknown, unknown>,
): boolean => {
  const pending = [root];
  const seen = new Set<Expr<unknown> | Computation<unknown, unknown>>();
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const success = current instanceof Computation ? current.output : current.type;
    if (containsQueue(success) || containsQueueDone(success)) return true;
    if (
      current instanceof Computation &&
      (containsQueue(current.error) || containsQueueDone(current.error))
    )
      return true;
    if (
      current instanceof Expr &&
      Match.value(current.node).pipe(
        Match.tag(
          "Apply",
          (node) =>
            node.operation.input.some((type) => containsQueue(type) || containsQueueDone(type)) ||
            containsQueue(node.operation.output) ||
            containsQueueDone(node.operation.output),
        ),
        Match.orElse(() => false),
      )
    )
      return true;
    for (const [, child] of authoredChildren(current))
      if (child instanceof Expr || child instanceof Computation) pending.push(child);
  }
  return false;
};
