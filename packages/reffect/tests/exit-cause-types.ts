import { R } from "../src/index.ts";
import type { CauseValue, Computation, ExitValue, Expr } from "../src/index.ts";

const cause: Expr<CauseValue<bigint>> = R.Cause.fail(R.U64.literal(1n));
const mappedCause: Expr<CauseValue<boolean>> = cause.pipe(
  R.Cause.map((error) => R.U64.eq(error, R.U64.literal(1n))),
);
const success: Expr<ExitValue<bigint, boolean>> = R.Exit.succeed(R.U64.literal(2n), R.Bool);
const failure: Expr<ExitValue<bigint, boolean>> = R.Exit.fail(R.Bool.literal(false), R.U64);
const mapped: Expr<ExitValue<string, boolean>> = success.pipe(
  R.Exit.map(() => R.String.literal("ok")),
);
const mappedError: Expr<ExitValue<bigint, string>> = failure.pipe(
  R.Exit.mapError(() => R.String.literal("error")),
);
const captured: Computation<ExitValue<bigint, never>, never> = R.Effect.succeed(
  R.U64.literal(1n),
).pipe(R.Effect.exit);
const match: Expr<bigint> = success.pipe(
  R.Exit.match({
    onSuccess: (value) => value,
    onFailure: (cause) =>
      R.Option.getOrElse(
        R.Cause.findErrorOption(cause).pipe(R.Option.map(() => R.U64.literal(0n))),
        () => R.U64.literal(1n),
      ),
  }),
);
// @ts-expect-error Cause payloads retain their error type.
const wrongCause: Expr<CauseValue<string>> = cause;
// @ts-expect-error Exit mapping retains the original error channel.
const wrongExit: Expr<ExitValue<string, string>> = mapped;
void [
  cause,
  mappedCause,
  success,
  failure,
  mapped,
  mappedError,
  captured,
  match,
  wrongCause,
  wrongExit,
];

// Invalid builders are checked by TypeScript without executing them.
const invalid = () => {
  R.Exit.match(success, {
    onSuccess: () => R.U64.literal(1n),
    // @ts-expect-error Exit.match handlers must agree on the output witness/type.
    onFailure: () => R.String.literal("bad"),
  });
  // @ts-expect-error Cause and Exit payload shapes are different.
  R.Exit.map(cause, () => R.Bool.literal(true));
  // @ts-expect-error Effect.exit requires a computation, not pure Exit data.
  R.Effect.exit(success);
};
void invalid;
