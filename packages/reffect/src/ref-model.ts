import { Match, Predicate, Schema } from "effect";
import type { Ref } from "effect";
import { BoolType, IRType, SemanticRef, Targets, U64Type, UnitType } from "./kernel.ts";

const scalarTypes = Object.freeze([BoolType, U64Type, UnitType]);
const contents = new WeakMap<IRType<unknown>["native"], IRType<unknown>>();
const witnesses = new Map<IRType<unknown>, IRType<unknown>>();

export const refContent = (type: IRType<unknown>): IRType<unknown> | undefined =>
  contents.get(type.native);
export const refScalar = (type: IRType<unknown>): boolean =>
  scalarTypes.some((candidate) => IRType.same(candidate, type));

/** Internal lexical handle witness; never a public native value or wire codec. */
export const refType = <A>(content: IRType<A>): IRType<Ref.Ref<A>> => {
  const key = scalarTypes.find((candidate) => IRType.same(candidate, content)) ?? content;
  const found = witnesses.get(key);
  if (found) return found as IRType<Ref.Ref<A>>;
  const native = Object.freeze({ target: Targets.RustStd, type: "__reffect_lexical_ref" });
  const witness = IRType.make(
    SemanticRef.type(`reffect/lexical-ref/${content.id}@1`),
    Schema.declare((value): value is Ref.Ref<A> => Predicate.hasProperty(value, "~effect/Ref")),
    native,
  );
  contents.set(native, key);
  witnesses.set(key, witness);
  return witness;
};

export const containsRef = (type: IRType<unknown>): boolean => {
  if (refContent(type)) return true;
  const layout = type.layout;
  if (!layout) return false;
  return Match.value(layout).pipe(
    Match.tagsExhaustive({
      Struct: (value) => value.fields.some((field) => containsRef(field.type)),
      Union: (value) => value.cases.some(containsRef),
      Array: (value) => containsRef(value.item),
      UndefinedOr: (value) => containsRef(value.item),
      Record: (value) => containsRef(value.value),
      Literals: () => false,
    }),
  );
};
