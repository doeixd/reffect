import { expectTypeOf } from "vite-plus/test";
import { Computation, R } from "../src/index.ts";

export const scopeRegistrationTypeChecks = () => {
  const registration = R.Effect.addFinalizer(() => R.Effect.void);
  expectTypeOf(registration).toEqualTypeOf<Computation<void, never>>();
  const acquired = R.Effect.acquireRelease(R.Effect.succeed(R.U64.literal(9n)), (token) => {
    expectTypeOf(token).toEqualTypeOf<ReturnType<typeof R.U64.literal>>();
    return R.Effect.logInfo("release", [["token", token]]);
  });
  expectTypeOf(acquired).toEqualTypeOf<Computation<bigint, never>>();
  expectTypeOf(acquired.pipe(R.Effect.scoped)).toEqualTypeOf<Computation<bigint, never>>();
  expectTypeOf(R.Effect.andThen(registration, acquired)).toEqualTypeOf<
    Computation<bigint, never>
  >();
  expectTypeOf(registration.pipe(R.Effect.andThen(acquired))).toEqualTypeOf<
    Computation<bigint, never>
  >();
  const file = R.File.acquireReadOnly("fixture", (handle) => handle.size);
  expectTypeOf(file).toEqualTypeOf<Computation<bigint, boolean>>();
  // @ts-expect-error Registered resources cannot have fallible cleanup.
  R.Effect.acquireRelease(R.Effect.void, () => R.Effect.fail(R.Bool.literal(false)));
  // @ts-expect-error Exit-aware finalizers are outside the admitted profile.
  R.Effect.addFinalizer((_exit: unknown) => R.Effect.void);
  R.File.acquireReadOnly("fixture", (handle) =>
    // @ts-expect-error Borrowed handles cannot become ordinary runtime values.
    R.Effect.succeed(handle),
  );
  R.File.acquireReadOnly(
    "fixture",
    () => R.Effect.void,
    // @ts-expect-error After-close effects must be Unit/Never.
    R.Effect.fail(R.Bool.literal(false)),
  );
};
