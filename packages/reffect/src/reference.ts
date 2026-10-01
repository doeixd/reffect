import { Fn, PureReference } from "./kernel.ts";
import type { CompileError, IRType, Inputs } from "./kernel.ts";
import { EffectFn, EffectReference } from "./effect-ir.ts";
import type { FramedExit } from "./effect-ir.ts";
import { Effect, Exit } from "effect";

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
function runWithFramesUnknown<I extends readonly IRType<unknown>[], A>(
  f: Fn<I, A>,
  args: readonly unknown[],
  basePath?: string,
): Effect.Effect<FramedExit<A, never>, CompileError>;
function runWithFramesUnknown<I extends readonly IRType<unknown>[], A, E>(
  f: EffectFn<I, A, E>,
  args: readonly unknown[],
  basePath?: string,
): Effect.Effect<FramedExit<A, E>, CompileError>;
function runWithFramesUnknown(
  f: Fn | EffectFn,
  args: readonly unknown[],
  basePath?: string,
): Effect.Effect<FramedExit<unknown, unknown>, CompileError> {
  return f instanceof EffectFn
    ? EffectReference.runWithFramesUnknown(f, args, basePath)
    : PureReference.runUnknown(f, args).pipe(
        Effect.map((value): FramedExit<unknown, unknown> => ({
          exit: Exit.succeed(value),
          frames: Object.freeze([]),
          omitted: 0,
        })),
      );
}
function runWithFrames<I extends readonly IRType<unknown>[], A>(
  f: Fn<I, A>,
  args: Inputs<I>,
  basePath?: string,
): Effect.Effect<FramedExit<A, never>, CompileError>;
function runWithFrames<I extends readonly IRType<unknown>[], A, E>(
  f: EffectFn<I, A, E>,
  args: Inputs<I>,
  basePath?: string,
): Effect.Effect<FramedExit<A, E>, CompileError>;
function runWithFrames(
  f: Fn | EffectFn,
  args: readonly unknown[],
  basePath?: string,
): Effect.Effect<FramedExit<unknown, unknown>, CompileError> {
  return runWithFramesUnknown(f as Fn, args, basePath);
}
export const Reference = Object.freeze({ run, runUnknown, runWithFrames, runWithFramesUnknown });
