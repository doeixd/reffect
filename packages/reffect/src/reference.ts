import { containsSemaphore, usesSemaphoreExpression } from "./semaphore-model.ts";
import { Fn, NeverType, PureReference, UnitType, evaluateExpression, fail } from "./kernel.ts";
import { toEffectStream } from "./stream-ir.ts";
import type { StreamFn } from "./stream-ir.ts";
import type { CompileError, IRType, Inputs } from "./kernel.ts";
import { EffectFn, EffectReference } from "./effect-ir.ts";
import type { FramedExit } from "./effect-ir.ts";
import { containsRef } from "./ref-model.ts";
import { NESTING_LIMIT, nestingDepth } from "./nesting.ts";
import { containsDeferred, usesDeferredExpression } from "./deferred-model.ts";
import { Effect, Exit, Match, Stream } from "effect";

/** Why the reference refuses `f` before evaluating it, as `Compile.check` would. */
const refusal = (f: Fn | EffectFn): CompileError | undefined => {
  // Measured first and without recursion: evaluation, and the walks below, would overflow (#29).
  if (nestingDepth(f.body) === undefined)
    return fail(
      "NESTING_LIMIT",
      "check",
      "function",
      `The function's IR nests deeper than ${NESTING_LIMIT} levels`,
    );
  if (
    f.input.some(
      (type) => containsRef(type) || containsDeferred(type) || containsSemaphore(type),
    ) ||
    containsRef(f.output) ||
    containsDeferred(f.output) ||
    containsSemaphore(f.output) ||
    (f instanceof EffectFn &&
      (containsRef(f.error) || containsDeferred(f.error) || containsSemaphore(f.error))) ||
    (f instanceof Fn && (usesDeferredExpression(f.body) || usesSemaphoreExpression(f.body)))
  )
    return fail(
      "RESOURCE_ESCAPE",
      "check",
      "function",
      "Public channels cannot contain lexical Ref, Deferred or Semaphore handles",
    );
  return undefined;
};
function runUnknown<I extends readonly IRType<unknown>[], A>(
  f: Fn<I, A>,
  args: readonly unknown[],
): Effect.Effect<A, CompileError>;
function runUnknown<I extends readonly IRType<unknown>[], A, E>(
  f: EffectFn<I, A, E>,
  args: readonly unknown[],
): Effect.Effect<A, E | CompileError>;
function runUnknown(f: Fn | EffectFn, args: readonly unknown[]): Effect.Effect<unknown, unknown> {
  const refused = refusal(f);
  if (refused) return Effect.fail(refused);
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
  const refused = refusal(f);
  if (refused) return Effect.fail(refused);
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
/**
 * The official Stream a streaming procedure describes (STREAM-006), for an RPC oracle whose
 * handler returns a Stream; the RPC server encodes its elements.
 */
const stream = <I extends readonly IRType<unknown>[], A, E>(
  f: StreamFn<I, A, E>,
  args: Inputs<I>,
): Stream.Stream<A, E> =>
  Match.value(f.body.node).pipe(
    Match.tag(
      "StreamEmit",
      (n) =>
        toEffectStream(
          n.stream,
          new Map<symbol, readonly unknown[]>([[f.binder, args]]),
          evaluateExpression,
          (outer, binder, value) => new Map(outer).set(binder, [value]),
          // A finalizer here is closed: it reads none of the function's inputs (STREAM-005).
          (finalizer) =>
            EffectReference.runUnknown(
              EffectFn.make([], UnitType, NeverType, () => finalizer),
              [],
            ).pipe(Effect.orDie),
        ) as Stream.Stream<A, E>,
    ),
    Match.orElse(() =>
      Stream.die(fail("NOT_A_STREAM", "reference", "stream", "Expected a streaming function")),
    ),
  );
export const Reference = Object.freeze({
  run,
  runUnknown,
  runWithFrames,
  runWithFramesUnknown,
  stream,
});
