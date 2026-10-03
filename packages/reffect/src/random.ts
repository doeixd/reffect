import { Computation, EffectIR } from "./effect-ir.ts";
import { NeverType, NumberType } from "./kernel.ts";

const next = Computation.make(NumberType, NeverType, { _tag: "RandomDraw" });
/** Ordered doubles from an explicitly selected owned native Random driver. */
export const RandomIR = Object.freeze({
  next,
  nextBoolean: EffectIR.map(next, (value) => NumberType.lt(NumberType.literal(0.5), value)),
});
