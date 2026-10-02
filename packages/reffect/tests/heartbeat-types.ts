import { Effect, Schedule } from "effect";
import { expectTypeOf } from "vite-plus/test";
import { Computation, R } from "../src/index.ts";

// Checked by strict TypeScript; these authored programs are never executed.
export const heartbeatTypeChecks = () => {
  const pending = R.Effect.addFinalizer(() => R.Effect.void);
  expectTypeOf(pending).toEqualTypeOf<Computation<void, never>>();
  const closed = pending.pipe(
    R.Effect.andThen(R.Effect.fail(R.Bool.literal(false))),
    R.Effect.scoped,
  );
  expectTypeOf(closed).toEqualTypeOf<Computation<never, boolean>>();
  const next = R.Effect.andThen(R.Effect.succeed(R.U64.literal(1n)));
  expectTypeOf(R.Effect.void.pipe(next)).toEqualTypeOf<Computation<bigint, never>>();
  expectTypeOf(pending.pipe(next)).toEqualTypeOf<Computation<bigint, never>>();
  // Scope requirements and unbounded registration counts are checked by Compile.check.
  R.fn([], R.Unit, R.Never, () => pending);
  R.Effect.repeat(pending, { schedule: R.Schedule.spaced(1) });
  // @ts-expect-error finalizers cannot fail in the admitted scope profile
  R.Effect.addFinalizer(() => R.Effect.fail(R.Bool.literal(false)));
  // @ts-expect-error Exit-aware callbacks require a separate runtime representation
  R.Effect.addFinalizer((_exit: unknown) => R.Effect.void);
  // @ts-expect-error only Unit repeat bodies are admitted
  R.Effect.repeat(R.Effect.succeed(R.U64.literal(1n)), { schedule: R.Schedule.spaced(1) });
  // @ts-expect-error stock runtime schedules are not statically representable schedule witnesses
  R.Effect.repeat(R.Effect.void, { schedule: Schedule.spaced(1) });
  // @ts-expect-error ordinary runtime Effects cannot enter compiled composition
  R.Effect.andThen(R.Effect.void, Effect.void);
  // v4-mirrored logging names all produce the same Unit/Never computation node
  for (const log of [
    R.Effect.log,
    R.Effect.logTrace,
    R.Effect.logDebug,
    R.Effect.logInfo,
    R.Effect.logWarning,
    R.Effect.logError,
    R.Effect.logFatal,
  ])
    expectTypeOf(log("message")).toEqualTypeOf<Computation<void, never>>();
  expectTypeOf(R.Effect.logInfo("message", [["attempt", R.U64.literal(1n)]])).toEqualTypeOf<
    Computation<void, never>
  >();
  expectTypeOf(R.Effect.annotateLogs("key", R.Bool.literal(true))(R.Effect.void)).toEqualTypeOf<
    Computation<void, never>
  >();
  expectTypeOf(R.Effect.withLogSpan("span")(R.Effect.void)).toEqualTypeOf<
    Computation<void, never>
  >();
  // @ts-expect-error annotation values must be typed Boolean/u64 expressions
  R.Effect.logInfo("message", [["key", "not an expression"]]);
};
