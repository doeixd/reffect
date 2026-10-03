import { Computation } from "./effect-ir.ts";
import { NeverType, NumberType } from "./kernel.ts";

/** Synchronous wall-clock reads with a checked signed safe-integer millisecond profile. */
export const ClockIR = Object.freeze({
  currentTimeMillis: Computation.make(NumberType, NeverType, { _tag: "ClockReadMillis" }),
});
