import type { Latch } from "effect";
import { Match } from "effect";
import { Computation, EffectIR } from "./effect-ir.ts";
import { BoolType, UnitType, IRType, NeverType, fail } from "./kernel.ts";
import type { Expr } from "./kernel.ts";
import { LatchType } from "./latch-model.ts";
const owner = (self: Expr<Latch.Latch>): symbol => {
  const parameter = Match.value(self.node).pipe(
    Match.tag("Parameter", (n) => n),
    Match.orElse(() => undefined),
  );
  if (!IRType.same(self.type, LatchType) || !parameter || parameter.index !== 0)
    throw fail(
      "RESOURCE_ESCAPE",
      "authoring",
      "Latch",
      "Latch operations require a lexical handle",
    );
  return parameter.binder;
};
const make = (open = false): Computation<Latch.Latch> => {
  if (typeof open !== "boolean")
    throw fail(
      "INVALID_LATCH_STATE",
      "authoring",
      "Latch.make",
      "Initial state must be a literal Boolean",
    );
  return Computation.make(LatchType, NeverType, { _tag: "LatchMake", open });
};
const operation = <A>(
  self: Expr<Latch.Latch>,
  kind: "Await" | "Open" | "Close" | "Release" | "IsOpen",
  output: IRType<A>,
): Computation<A> =>
  Computation.make(output, NeverType, {
    _tag: "LatchOperation",
    binder: owner(self),
    operation: kind,
  });
const awaitLatch = (self: Expr<Latch.Latch>) => operation(self, "Await", UnitType);
function whenOpen<A, E>(self: Expr<Latch.Latch>, body: Computation<A, E>): Computation<A, E>;
function whenOpen(self: Expr<Latch.Latch>): <A, E>(body: Computation<A, E>) => Computation<A, E>;
function whenOpen<A, E>(
  self: Expr<Latch.Latch>,
  body?: Computation<A, E>,
): Computation<A, E> | (<B, E2>(body: Computation<B, E2>) => Computation<B, E2>) {
  if (body === undefined)
    return <B, E2>(body: Computation<B, E2>) => EffectIR.flatMap(awaitLatch(self), () => body);
  return EffectIR.flatMap(awaitLatch(self), () => body);
}
/** Lexical Effect v4 Latch builders; native execution uses the checked standalone profile. */
export const LatchIR = Object.freeze({
  make,
  await: awaitLatch,
  open: (self: Expr<Latch.Latch>) => operation(self, "Open", BoolType),
  close: (self: Expr<Latch.Latch>) => operation(self, "Close", BoolType),
  release: (self: Expr<Latch.Latch>) => operation(self, "Release", BoolType),
  isOpen: (self: Expr<Latch.Latch>) => operation(self, "IsOpen", BoolType),
  whenOpen,
});
