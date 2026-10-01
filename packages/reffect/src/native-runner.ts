import { Effect, Exit, Predicate, Schema } from "effect";
import { CargoApi } from "./cargo.ts";
import { EffectFn } from "./effect-ir.ts";
import { BoolType, IRType, U64Type, UnitType, fail } from "./kernel.ts";
import type { Fn, Inputs } from "./kernel.ts";
import type { Artifact } from "./compiler.ts";

const locate = <I extends readonly IRType<unknown>[], A, E>(
  artifact: Artifact,
  name: string,
  fn: Fn<I, A> | EffectFn<I, A, E>,
) =>
  Effect.gen(function* () {
    const declared = artifact.explanation.analysis.program.functions[name];
    // Metadata copies retain their binder/body; unrelated or forged channel declarations do not.
    if (
      !declared ||
      declared.binder !== fn.binder ||
      declared.body !== fn.body ||
      !IRType.same(declared.output, fn.output) ||
      declared.input.length !== fn.input.length ||
      declared.input.some((type, i) => !IRType.same(type, fn.input[i])) ||
      (declared instanceof EffectFn
        ? !(fn instanceof EffectFn) || !IRType.same(declared.error, fn.error)
        : fn instanceof EffectFn)
    )
      return yield* fail(
        "INVALID_INPUT",
        "native",
        name,
        "Function does not belong to this artifact",
      );
  });

const encodeArguments = <I extends readonly IRType<unknown>[]>(
  fn: Fn<I, unknown> | EffectFn<I, unknown, unknown>,
  name: string,
  args: readonly unknown[],
) =>
  Effect.gen(function* () {
    if (args.length !== fn.input.length)
      return yield* fail("ARITY_MISMATCH", "native", name, "Incorrect input count");
    const values: (bigint | boolean | undefined)[] = [];
    for (let i = 0; i < args.length; i++) {
      const value = yield* Schema.decodeUnknownEffect(fn.input[i].schema)(args[i]).pipe(
        Effect.mapError((cause) => fail("INVALID_INPUT", "native", `args[${i}]`, cause.message)),
      );
      if (Predicate.isUndefined(value) && IRType.same(fn.input[i], UnitType)) {
        values.push(undefined);
        continue;
      }
      if (!Predicate.isBigInt(value) && !Predicate.isBoolean(value))
        return yield* fail("INVALID_INPUT", "native", `args[${i}]`, "Unsupported native scalar");
      values.push(value);
    }
    return values;
  });

const decodeScalar = <T>(type: IRType<T>, name: string, encoded: string) =>
  Effect.gen(function* () {
    let value: unknown;
    if (IRType.same(type, U64Type) && /^u64:[0-9]+$/.test(encoded))
      value = BigInt(encoded.slice(4));
    else if (IRType.same(type, BoolType) && /^bool:(true|false)$/.test(encoded))
      value = encoded === "bool:true";
    else if (IRType.same(type, UnitType) && encoded === "unit") value = undefined;
    else
      return yield* fail(
        "INVALID_NATIVE_OUTPUT",
        "native",
        name,
        "Invalid scalar output or channel witness",
      );
    return yield* Schema.decodeUnknownEffect(type.schema)(value).pipe(
      Effect.mapError((cause) => fail("INVALID_NATIVE_OUTPUT", "native", name, cause.message)),
    );
  });

const exitOf = <I extends readonly IRType<unknown>[], A, E>(
  fn: Fn<I, A> | EffectFn<I, A, E>,
  name: string,
  output: string,
) =>
  Effect.gen(function* () {
    if (fn instanceof EffectFn) {
      if (output.startsWith("ok:"))
        return Exit.succeed(yield* decodeScalar(fn.output, name, output.slice(3))) as Exit.Exit<
          A,
          E
        >;
      if (output.startsWith("err:"))
        return Exit.fail(yield* decodeScalar(fn.error, name, output.slice(4))) as Exit.Exit<A, E>;
      return yield* fail("INVALID_NATIVE_OUTPUT", "native", name, "Expected a Result channel");
    }
    return Exit.succeed(
      yield* decodeScalar(
        fn.output,
        name,
        IRType.same(fn.output, U64Type) ? `u64:${output}` : output,
      ),
    ) as Exit.Exit<A, E>;
  });

/** Execute a compiled scalar function; domain failures are Exit failures, process failures stay errors. */
const run = Effect.fn("NativeRunner.run")(function* <
  const I extends readonly IRType<unknown>[],
  A,
  E = never,
>(
  artifact: Artifact,
  directory: string,
  name: string,
  fn: Fn<I, A> | EffectFn<I, A, E>,
  args: Inputs<I>,
  profile: "debug" | "release" = "debug",
) {
  yield* locate(artifact, name, fn);
  const values = yield* encodeArguments(fn, name, args);
  const result = yield* CargoApi.run(directory, name, values, profile);
  return yield* exitOf(fn, name, result.stdout.trim());
});

export interface NativeFrame {
  readonly function: string;
  readonly path: string;
  readonly kind: string;
  readonly origin?: string;
}
export interface FramedNativeExit<A, E> {
  readonly exit: Exit.Exit<A, E>;
  readonly frames: readonly NativeFrame[];
  readonly omitted: number;
}
const frameEnvelope = Schema.Struct({
  schema: Schema.Literal("reffect.frames@1"),
  frames: Schema.Array(
    Schema.Struct({
      function: Schema.String,
      path: Schema.String,
      kind: Schema.String,
      origin: Schema.optionalKey(Schema.String),
    }),
  ),
  omitted: Schema.Number,
});
const envelopeMarker = '{"schema":"reffect.frames@1"';
const decodeFrames = (name: string, stderr: string) =>
  Effect.gen(function* () {
    // cargo forwards rustc warnings to stderr; select the envelope line.
    const lines = stderr
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(envelopeMarker));
    if (lines.length === 0)
      return yield* fail(
        "INVALID_NATIVE_FRAMES",
        "native",
        name,
        "Native failure carries no frame envelope",
      );
    if (lines.length > 1)
      return yield* fail(
        "INVALID_NATIVE_FRAMES",
        "native",
        name,
        "Native stderr carries duplicate frame envelopes",
      );
    const envelope: unknown = yield* Effect.try({
      try: () => JSON.parse(lines[0]),
      catch: () => fail("INVALID_NATIVE_FRAMES", "native", name, "Frame envelope is not JSON"),
    });
    const decoded = yield* Schema.decodeUnknownEffect(frameEnvelope)(envelope).pipe(
      Effect.mapError((cause) => fail("INVALID_NATIVE_FRAMES", "native", name, cause.message)),
    );
    for (const frame of decoded.frames) {
      if (!frame.function.length || !frame.path.length || !frame.kind.length)
        return yield* fail(
          "INVALID_NATIVE_FRAMES",
          "native",
          name,
          "Frame envelope carries an empty identity",
        );
      if (!["function", "succeed", "fail", "map", "flatMap", "match"].includes(frame.kind))
        return yield* fail(
          "INVALID_NATIVE_FRAMES",
          "native",
          name,
          "Frame envelope carries an unknown boundary kind",
        );
    }
    if (!Number.isSafeInteger(decoded.omitted) || decoded.omitted < 0)
      return yield* fail(
        "INVALID_NATIVE_FRAMES",
        "native",
        name,
        "Frame envelope carries an invalid omitted count",
      );
    return {
      frames: Object.freeze(
        decoded.frames.map((frame) => Object.freeze({ ...frame })),
      ) as readonly NativeFrame[],
      omitted: decoded.omitted,
    };
  });

/**
 * Execute a compiled effect function and relay its executed logical frames.
 * Stdout payload decoding matches {@link run}; frames arrive on stderr only for
 * failures and successes must carry none.
 */
const runWithFramesUnknown = Effect.fn("NativeRunner.runWithFramesUnknown")(function* <
  const I extends readonly IRType<unknown>[],
  A,
  E,
>(
  artifact: Artifact,
  directory: string,
  name: string,
  fn: EffectFn<I, A, E>,
  args: readonly unknown[],
  profile: "debug" | "release" = "debug",
) {
  yield* locate(artifact, name, fn);
  const values = yield* encodeArguments(fn, name, args);
  const result = yield* CargoApi.run(directory, name, values, profile);
  const exit = yield* exitOf(fn, name, result.stdout.trim());
  if (Exit.isSuccess(exit)) {
    if (result.stderr.split("\n").some((line) => line.trim().startsWith(envelopeMarker)))
      return yield* fail(
        "INVALID_NATIVE_FRAMES",
        "native",
        name,
        "Native success must not carry a frame envelope",
      );
    return { exit, frames: Object.freeze([]), omitted: 0 };
  }
  const decoded = yield* decodeFrames(name, result.stderr);
  return { exit, frames: decoded.frames, omitted: decoded.omitted };
});
const runWithFrames = Effect.fn("NativeRunner.runWithFrames")(function* <
  const I extends readonly IRType<unknown>[],
  A,
  E,
>(
  artifact: Artifact,
  directory: string,
  name: string,
  fn: EffectFn<I, A, E>,
  args: Inputs<I>,
  profile: "debug" | "release" = "debug",
) {
  return yield* runWithFramesUnknown(artifact, directory, name, fn, args, profile);
});
export const NativeRunner = Object.freeze({ run, runWithFrames, runWithFramesUnknown });
