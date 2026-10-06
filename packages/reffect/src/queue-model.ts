import { Cause, Match, Queue, Schema } from "effect";
import {
  BoolType,
  Expr,
  IRType,
  NeverType,
  SemanticRef,
  Targets,
  U64Type,
  UnitType,
} from "./kernel.ts";

const scalars = [BoolType, U64Type, UnitType] as const;
const channels = new WeakMap<
  IRType<unknown>["native"],
  { readonly success: IRType<unknown>; readonly error: IRType<unknown> }
>();
const witnesses = new Map<IRType<unknown>, Map<IRType<unknown>, IRType<unknown>>>();
export const queueScalar = (type: IRType<unknown>): boolean =>
  scalars.some((candidate) => IRType.same(candidate, type));
export const QueueDoneType: IRType<Cause.Done<void>> = IRType.make(
  SemanticRef.type("reffect/queue-done-unit@1"),
  Schema.declare(
    (value): value is Cause.Done<void> => Cause.isDone(value) && value.value === undefined,
  ),
  Object.freeze({ target: Targets.RustStd, type: "__reffect_queue_done_unit" }),
);
export const validQueueCapacity = (capacity: number): boolean =>
  Number.isInteger(capacity) && capacity >= 1 && capacity <= 3;
export const queueError = (type: IRType<unknown>): boolean =>
  IRType.same(type, NeverType) || IRType.same(type, QueueDoneType);
export const queueChannels = (type: IRType<unknown>) => channels.get(type.native);
export const queueType = <A, E>(
  success: IRType<A>,
  error: IRType<E>,
): IRType<Queue.Queue<A, E>> => {
  const a = scalars.find((candidate) => IRType.same(candidate, success)) ?? success;
  const e = [NeverType, QueueDoneType].find((candidate) => IRType.same(candidate, error)) ?? error;
  let errors = witnesses.get(a);
  if (!errors) {
    errors = new Map();
    witnesses.set(a, errors);
  }
  const found = errors.get(e);
  if (found) return found as IRType<Queue.Queue<A, E>>;
  const native = Object.freeze({ target: Targets.RustStd, type: "__reffect_lexical_queue" });
  const witness = IRType.make(
    SemanticRef.type(`reffect/lexical-queue/${a.id}/${e.id}@1`),
    Schema.declare((value): value is Queue.Queue<A, E> => Queue.isQueue(value)),
    native,
  );
  channels.set(native, { success: a, error: e });
  errors.set(e, witness);
  return witness;
};
export const containsQueue = (type: IRType<unknown>): boolean => {
  if (queueChannels(type) || type.native.type === "__reffect_lexical_queue") return true;
  if (!type.layout) return false;
  return Match.value(type.layout).pipe(
    Match.tagsExhaustive({
      Struct: (value) => value.fields.some((field) => containsQueue(field.type)),
      Union: (value) => value.cases.some(containsQueue),
      Array: (value) => containsQueue(value.item),
      UndefinedOr: (value) => containsQueue(value.item),
      Record: (value) => containsQueue(value.value),
      Literals: () => false,
    }),
  );
};

export const containsQueueDone = (type: IRType<unknown>): boolean => {
  if (IRType.same(type, QueueDoneType) || type.native.type === "__reffect_queue_done_unit")
    return true;
  if (!type.layout) return false;
  return Match.value(type.layout).pipe(
    Match.tagsExhaustive({
      Struct: (value) => value.fields.some((field) => containsQueueDone(field.type)),
      Union: (value) => value.cases.some(containsQueueDone),
      Array: (value) => containsQueueDone(value.item),
      UndefinedOr: (value) => containsQueueDone(value.item),
      Record: (value) => containsQueueDone(value.value),
      Literals: () => false,
    }),
  );
};

/** Dedicated coordinator nodes are the only permitted uses of lexical handles. */
export const usesQueueExpression = (root: Expr<unknown>): boolean => {
  const seen = new Set<Expr<unknown>>();
  const walk = (value: Expr<unknown>): boolean => {
    if (containsQueue(value.type)) return true;
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
