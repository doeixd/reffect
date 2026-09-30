import { Effect, Exit, Schema } from "effect";
import { CargoApi } from "./cargo.ts";
import { EffectFn } from "./effect-ir.ts";
import { BoolType, IRType, U64Type, fail } from "./kernel.ts";
import type { Fn, Inputs } from "./kernel.ts";
import type { Artifact } from "./compiler.ts";

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
  if (artifact.explanation.analysis.program.functions[name] !== fn)
    return yield* fail(
      "INVALID_INPUT",
      "native",
      name,
      "Function does not belong to this artifact",
    );
  if (args.length !== fn.input.length)
    return yield* fail("ARITY_MISMATCH", "native", name, "Incorrect input count");
  const values: (bigint | boolean)[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = yield* Schema.decodeUnknownEffect(fn.input[i].schema)(args[i]).pipe(
      Effect.mapError((cause) => fail("INVALID_INPUT", "native", `args[${i}]`, cause.message)),
    );
    if (typeof value !== "bigint" && typeof value !== "boolean")
      return yield* fail("INVALID_INPUT", "native", `args[${i}]`, "Unsupported native scalar");
    values.push(value);
  }
  const result = yield* CargoApi.run(directory, name, values, profile);
  const output = result.stdout.trim();
  const decode = <T>(type: IRType<T>, encoded: string) =>
    Effect.gen(function* () {
      let value: unknown;
      if (IRType.same(type, U64Type) && /^u64:[0-9]+$/.test(encoded))
        value = BigInt(encoded.slice(4));
      else if (IRType.same(type, BoolType) && /^bool:(true|false)$/.test(encoded))
        value = encoded === "bool:true";
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
  if (fn instanceof EffectFn) {
    if (output.startsWith("ok:"))
      return Exit.succeed(yield* decode(fn.output, output.slice(3))) as Exit.Exit<A, E>;
    if (output.startsWith("err:"))
      return Exit.fail(yield* decode(fn.error, output.slice(4))) as Exit.Exit<A, E>;
    return yield* fail("INVALID_NATIVE_OUTPUT", "native", name, "Expected a Result channel");
  }
  return Exit.succeed(
    yield* decode(fn.output, IRType.same(fn.output, U64Type) ? `u64:${output}` : output),
  ) as Exit.Exit<A, E>;
});
export const NativeRunner = Object.freeze({ run });
