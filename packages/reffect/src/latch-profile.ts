import { authoredChildren } from "./provenance.ts";
import { Match } from "effect";
import { Computation } from "./effect-ir.ts";
export const hasLatchComputation = (body: Computation<unknown, unknown>): boolean => {
  const pending = [body];
  const seen = new Set<Computation<unknown, unknown>>();
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (
      Match.value(current.node).pipe(
        Match.tags({
          LatchMake: () => true,
          LatchScope: () => true,
          LatchOperation: () => true,
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
