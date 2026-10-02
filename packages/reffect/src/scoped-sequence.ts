import { Match, Pipeable } from "effect";
import { dual } from "effect/Function";
import { Computation, EffectIR, joinType } from "./effect-ir.ts";
import { NeverType, UnitType } from "./kernel.ts";
import type { IRType } from "./kernel.ts";

type Step =
  | { readonly _tag: "Register"; readonly finalizer: Computation<void, never> }
  | { readonly _tag: "Run"; readonly body: Computation<unknown, unknown> };

/** Pending sequential scope: close with scoped before compiling or nesting in ordinary IR. */
export class ScopedSequence<A, E = never> extends Pipeable.Class {
  private constructor(
    readonly output: IRType<A>,
    readonly error: IRType<E>,
    readonly steps: readonly Step[],
  ) {
    super();
    Object.freeze(this);
  }
  static register(this: void, finalizer: () => Computation<void, never>): ScopedSequence<void> {
    return new ScopedSequence(
      UnitType,
      NeverType,
      Object.freeze([Object.freeze({ _tag: "Register", finalizer: finalizer() })]),
    );
  }
  static append<A, E, B, E2>(
    self: Computation<A, E> | ScopedSequence<A, E>,
    next: Computation<B, E2> | ScopedSequence<B, E2>,
  ): ScopedSequence<B, E | E2> {
    const steps = (
      value: Computation<unknown, unknown> | ScopedSequence<unknown, unknown>,
    ): readonly Step[] =>
      value instanceof ScopedSequence ? value.steps : [Object.freeze({ _tag: "Run", body: value })];
    return new ScopedSequence(
      next.output,
      joinType(self.error, next.error) as IRType<E | E2>,
      Object.freeze([...steps(self), ...steps(next)]),
    );
  }
}

type Sequence = Computation<unknown, unknown> | ScopedSequence<unknown, unknown>;
type SuccessOf<S extends Sequence> = S["output"] extends IRType<infer A> ? A : never;
type ErrorOf<S extends Sequence> = S["error"] extends IRType<infer E> ? E : never;
type Then<S extends Sequence, N extends Sequence> =
  S | N extends Computation<unknown, unknown>
    ? Computation<SuccessOf<N>, ErrorOf<S> | ErrorOf<N>>
    : ScopedSequence<SuccessOf<N>, ErrorOf<S> | ErrorOf<N>>;
export interface AndThen {
  <N extends Sequence>(next: N): <S extends Sequence>(self: S) => Then<S, N>;
  <S extends Sequence, N extends Sequence>(self: S, next: N): Then<S, N>;
}
const andThen = dual(
  2,
  <A, E, B, E2>(
    self: Computation<A, E> | ScopedSequence<A, E>,
    next: Computation<B, E2> | ScopedSequence<B, E2>,
  ) =>
    self instanceof ScopedSequence || next instanceof ScopedSequence
      ? ScopedSequence.append(self, next)
      : EffectIR.flatMap(self, () => next),
) as AndThen;

const scoped = <A, E>(self: Computation<A, E> | ScopedSequence<A, E>): Computation<A, E> => {
  if (self instanceof Computation) return EffectIR.scoped(self);
  let tail: Computation<unknown, unknown> = EffectIR.void;
  for (let i = self.steps.length - 1; i >= 0; i--) {
    const rest = tail;
    const last = i === self.steps.length - 1;
    tail = Match.value(self.steps[i]).pipe(
      Match.tagsExhaustive({
        Register: (step) =>
          EffectIR.flatMap(
            EffectIR.addFinalizer(() => step.finalizer),
            () => rest,
          ),
        Run: (step) => (last ? step.body : EffectIR.flatMap(step.body, () => rest)),
      }),
    );
  }
  return EffectIR.scoped(tail) as Computation<A, E>;
};

export const ScopedIR = Object.freeze({ addFinalizer: EffectIR.addFinalizer, andThen, scoped });
