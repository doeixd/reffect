import { expectTypeOf } from "vite-plus/test";
import { R } from "../src/index.ts";
import type { Expr } from "../src/index.ts";

// Checked by strict TypeScript; never executed. Struct.get is dual, as Effect's is (#15): a
// data-first call nested directly as the argument of another cannot be inferred, because
// TypeScript does not resolve an overloaded generic call's result while inferring the outer one.
// The pipe form and a named intermediate both infer.
export const structGetTypeChecks = () => {
  const Inner = R.Struct({ b: R.U64 });
  const Outer = R.Struct({ a: Inner });
  R.fn([Outer], R.U64, (x) => {
    const piped = x.pipe(R.Struct.get("a"), R.Struct.get("b"));
    expectTypeOf(piped).toEqualTypeOf<Expr<bigint>>();
    const a = R.Struct.get(x, "a");
    const named = R.Struct.get(a, "b");
    expectTypeOf(named).toEqualTypeOf<Expr<bigint>>();
    // @ts-expect-error A nested data-first call loses the inner result's fields.
    R.Struct.get(R.Struct.get(x, "a"), "b");
    // @ts-expect-error A key the struct does not declare.
    R.Struct.get(x, "missing");
    return piped;
  });
};

export const remotePageTypeChecks = () => {
  const Item = R.Struct({ id: R.String });
  const Page = R.Remote.Page(Item);
  R.fn([Item], Page, (item) => {
    const page = Page.make({
      items: R.Array.make(item),
      hasNext: R.Bool.literal(false),
      hasPrevious: R.Bool.literal(true),
    });
    expectTypeOf(R.Struct.get(page, "hasNext")).toEqualTypeOf<Expr<boolean>>();
    expectTypeOf(R.Struct.get(page, "items")).toEqualTypeOf<
      Expr<ReadonlyArray<{ readonly id: string }>>
    >();
    return page;
  });
};
