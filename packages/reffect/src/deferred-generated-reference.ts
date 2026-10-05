import { EffectFn, PrivateEffectReference, checkEffectFunction } from "./effect-ir.ts";
import { analyzeGeneratedDeferredProfile } from "./deferred-generated-profile.ts";
import { CompileError, Program } from "./kernel.ts";
import type { IRType, Diagnostic } from "./kernel.ts";

const check = (fn: EffectFn, path: string): readonly Diagnostic[] => {
  try {
    const profiles = analyzeGeneratedDeferredProfile(Program.make({ work: fn }));
    return profiles.has(fn) ? [] : checkEffectFunction(fn, path);
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
  runWithFrames: <I extends readonly IRType<unknown>[], A, E>(
    fn: EffectFn<I, A, E>,
    args: readonly unknown[],
    basePath?: string,
  ) => PrivateEffectReference.runWithFramesUnknown(fn, args, basePath, check),
});
