import { Match, Schema } from "effect";
import type { Deferred } from "effect";
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
export const deferredScalar = (type: IRType<unknown>): boolean =>
  scalars.some((candidate) => IRType.same(candidate, type));
export const deferredError = (type: IRType<unknown>): boolean =>
  deferredScalar(type) || IRType.same(type, NeverType);
export const deferredChannels = (type: IRType<unknown>) => channels.get(type.native);
export const deferredType = <A, E>(
  success: IRType<A>,
  error: IRType<E>,
): IRType<Deferred.Deferred<A, E>> => {
  const a = scalars.find((candidate) => IRType.same(candidate, success)) ?? success;
  const e = [...scalars, NeverType].find((candidate) => IRType.same(candidate, error)) ?? error;
  let errors = witnesses.get(a);
  if (!errors) {
    errors = new Map();
    witnesses.set(a, errors);
  }
  const found = errors.get(e);
  if (found) return found as IRType<Deferred.Deferred<A, E>>;
  const native = Object.freeze({ target: Targets.RustStd, type: "__reffect_lexical_deferred" });
  const witness = IRType.make(
    SemanticRef.type(`reffect/lexical-deferred/${a.id}/${e.id}@1`),
    Schema.declare(
      (value): value is Deferred.Deferred<A, E> =>
        typeof value === "object" && value !== null && "~effect/Deferred" in value,
    ),
    native,
  );
  channels.set(native, { success: a, error: e });
  errors.set(e, witness);
  return witness;
};
export const containsDeferred = (type: IRType<unknown>): boolean => {
  if (deferredChannels(type) || type.native.type === "__reffect_lexical_deferred") return true;
  if (!type.layout) return false;
  return Match.value(type.layout).pipe(
    Match.tagsExhaustive({
      Struct: (value) => value.fields.some((field) => containsDeferred(field.type)),
      Union: (value) => value.cases.some(containsDeferred),
      Array: (value) => containsDeferred(value.item),
      UndefinedOr: (value) => containsDeferred(value.item),
      Record: (value) => containsDeferred(value.value),
      Literals: () => false,
    }),
  );
};

/** Dedicated coordinator nodes are the only permitted uses of lexical handles. */
export const usesDeferredExpression = (root: Expr<unknown>): boolean => {
  const seen = new Set<Expr<unknown>>();
  const walk = (value: Expr<unknown>): boolean => {
    if (containsDeferred(value.type)) return true;
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
