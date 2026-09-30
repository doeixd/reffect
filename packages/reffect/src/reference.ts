import { Fn, PureReference } from "./kernel.ts";
import type { CompileError, IRType, Inputs } from "./kernel.ts";
import { EffectFn, EffectReference } from "./effect-ir.ts";
import type { Effect } from "effect";

function runUnknown<I extends readonly IRType<unknown>[], A>(
  f: Fn<I, A>,
  args: readonly unknown[],
): Effect.Effect<A, CompileError>;
function runUnknown<I extends readonly IRType<unknown>[], A, E>(
  f: EffectFn<I, A, E>,
  args: readonly unknown[],
): Effect.Effect<A, E | CompileError>;
function runUnknown(f: Fn | EffectFn, args: readonly unknown[]): Effect.Effect<unknown, unknown> {
  return f instanceof EffectFn
    ? EffectReference.runUnknown(f, args)
    : PureReference.runUnknown(f, args);
}
function run<I extends readonly IRType<unknown>[], A>(
  f: Fn<I, A>,
  args: Inputs<I>,
): Effect.Effect<A, CompileError>;
function run<I extends readonly IRType<unknown>[], A, E>(
  f: EffectFn<I, A, E>,
  args: Inputs<I>,
): Effect.Effect<A, E | CompileError>;
function run(f: Fn | EffectFn, args: readonly unknown[]): Effect.Effect<unknown, unknown> {
  return runUnknown(f as Fn, args);
}
export const Reference = Object.freeze({ run, runUnknown });
