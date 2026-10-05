import { EffectFn, PrivateEffectReference, checkEffectFunction } from "./effect-ir.ts";
import { analyzeGeneratedDeferredProfile } from "./deferred-generated-profile.ts";
import { CompileError, Program } from "./kernel.ts";
import { checkDeferredInterruptionPaths } from "./deferred-interruption-frames.ts";
import type { DeferredInterruptionFrames } from "./deferred-interruption-frames.ts";
import type { IRType, Diagnostic } from "./kernel.ts";

const check = (fn: EffectFn, path: string, requireDeferred = false): readonly Diagnostic[] => {
  try {
    const profiles = analyzeGeneratedDeferredProfile(Program.make({ work: fn }));
    return profiles.has(fn)
      ? []
      : requireDeferred
        ? [
            {
              code: "DEFERRED_GENERATED_PROFILE",
              stage: "check",
              path,
              message: "Interrupted diagnostics require the private Deferred profile",
            },
          ]
        : checkEffectFunction(fn, path);
  } catch (error) {
    if (error instanceof CompileError) return error.diagnostics;
    throw error;
  }
};

/** Private checked experiment, absent from package exports; uses the ordinary interpreters. */
export const GeneratedDeferredReference = Object.freeze({
  run: <I extends readonly IRType<unknown>[], A, E>(
    fn: EffectFn<I, A, E>,
    args: readonly unknown[],
  ) => PrivateEffectReference.runUnknown(fn, args, check),
  runWithInterruptionFrames: <I extends readonly IRType<unknown>[], A, E>(
    fn: EffectFn<I, A, E>,
    args: readonly unknown[],
    frames: DeferredInterruptionFrames,
    basePath = "functions.work.body",
  ) =>
    PrivateEffectReference.runWithFramesUnknown(
      fn,
      args,
      basePath,
      (fn, path) =>
        frames.claim()
          ? [...check(fn, path, true), ...checkDeferredInterruptionPaths(fn, basePath)]
          : [
              {
                code: "DEFERRED_FRAME_REUSE",
                stage: "check",
                path,
                message: "Each interrupted observation requires a fresh recorder",
              },
            ],
      frames.root(basePath),
    ),
  runWithFrames: <I extends readonly IRType<unknown>[], A, E>(
    fn: EffectFn<I, A, E>,
    args: readonly unknown[],
    basePath?: string,
  ) => PrivateEffectReference.runWithFramesUnknown(fn, args, basePath, check),
});
