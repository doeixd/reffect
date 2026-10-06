import { Match, Schema } from "effect";
import type { Semaphore } from "effect";
import { Expr, IRType, SemanticRef, Targets } from "./kernel.ts";

/** Private lexical witness; no standalone native representation exists. */
export const SemaphoreType: IRType<Semaphore.Semaphore> = IRType.make(
  SemanticRef.type("reffect/lexical-semaphore@1"),
  Schema.declare(
    (value): value is Semaphore.Semaphore =>
      typeof value === "object" && value !== null && "withPermits" in value,
  ),
  Object.freeze({ target: Targets.RustStd, type: "__reffect_lexical_semaphore" }),
);
export const validSemaphoreCapacity = (capacity: number): boolean =>
  Number.isSafeInteger(capacity) && capacity > 0;
export const validSemaphorePermits = (permits: number): boolean => permits === 1;
export const containsSemaphore = (type: IRType<unknown>): boolean => {
  if (IRType.same(type, SemaphoreType) || type.native.type === "__reffect_lexical_semaphore")
    return true;
  if (!type.layout) return false;
  return Match.value(type.layout).pipe(
    Match.tagsExhaustive({
      Struct: (value) => value.fields.some((field) => containsSemaphore(field.type)),
      Union: (value) => value.cases.some(containsSemaphore),
      Array: (value) => containsSemaphore(value.item),
      UndefinedOr: (value) => containsSemaphore(value.item),
      Record: (value) => containsSemaphore(value.value),
      Literals: () => false,
    }),
  );
};

/** Dedicated coordinator nodes are the only permitted uses of lexical handles. */
export const usesSemaphoreExpression = (root: Expr<unknown>): boolean => {
  const seen = new Set<Expr<unknown>>();
  const walk = (value: Expr<unknown>): boolean => {
    if (containsSemaphore(value.type)) return true;
    if (seen.has(value)) return false;
    seen.add(value);
    return Match.value(value.node).pipe(
      Match.tagsExhaustive({
        Parameter: () => false,
        Literal: () => false,
        Undefined: () => false,
        Apply: (n) => n.args.some(walk),
        Match: (n) => [n.condition, n.onTrue, n.onFalse].some(walk),
        Make: (n) => n.fields.some((field) => field !== undefined && walk(field)),
        Get: (n) => walk(n.value),
        MatchTags: (n) => walk(n.value) || n.cases.some((item) => walk(item.body)),
        ArrayMake: (n) => n.elements.some(walk),
        ArrayLength: (n) => walk(n.value),
        MatchUndefined: (n) => [n.value, n.onDefined, n.onUndefined].some(walk),
        RecordQuery: (n) => walk(n.value) || (n.key !== undefined && walk(n.key)),
        Defined: (n) => walk(n.value),
        ArrayLoop: (n) =>
          walk(n.source) ||
          walk(n.body) ||
          Match.value(n.op).pipe(
            Match.tag("Reduce", (op) => walk(op.init)),
            Match.orElse(() => false),
          ),
      }),
    );
  };
  return walk(root);
};
