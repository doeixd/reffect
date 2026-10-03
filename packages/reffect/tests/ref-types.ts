import { R, type Computation } from "../src/index.ts";

/** Compile-only contracts: no execution, casts or annotations on author callbacks. */
export const refTypeContracts = () => {
  return R.Effect.flatMap(R.Ref.make(R.U64.literal(0n)), (cell) => {
    const read: Computation<bigint> = R.Ref.get(cell);
    const write: Computation<void> = cell.pipe(R.Ref.set(R.U64.literal(1n)));
    const updated: Computation<void> = cell.pipe(
      R.Ref.update((old) => R.U64.add(old, R.U64.literal(1n))),
    );
    const modified: Computation<bigint> = cell.pipe(
      R.Ref.modify((old) => [old, R.U64.add(old, R.U64.literal(2n))]),
    );
    // @ts-expect-error Boolean writes cannot replace u64 state.
    R.Ref.set(cell, R.Bool.literal(true));
    // @ts-expect-error Update callbacks cannot suspend.
    R.Ref.update(cell, () => R.Effect.sleep(1));
    // @ts-expect-error Modify requires [result, nextValue], not just the next value.
    R.Ref.modify(cell, (old) => old);
    // @ts-expect-error A runtime Ref handle is not an ordinary u64 expression.
    R.U64.add(cell, R.U64.literal(1n));
    return write.pipe(
      R.Effect.andThen(updated),
      R.Effect.andThen(modified),
      R.Effect.andThen(read),
    );
  });
};
