import {
  AddU64,
  Evidence,
  IRType,
  Law,
  Native,
  Operation,
  R,
  Reference,
  Foldkit,
  SemanticRef,
} from "../src/index.ts";
import { Schema } from "effect";
import { Entity, Expr as EntityExpr, Query } from "foldkit-entity";

// Compiled by strict TypeScript checks; never executed.
export const typeChecks = () => {
  const add = R.fn([R.U64, R.U64], R.U64, (a, b) => R.U64.add(a, b));
  Reference.run(add, [1n, 2n]);
  // @ts-expect-error exact bigint input, not a lossy number
  Reference.run(add, [1, 2]);
  // @ts-expect-error tuple arity is preserved
  Reference.run(add, [1n]);
  // @ts-expect-error symbolic arithmetic accepts expressions, not runtime primitives
  R.U64.add(1n, 2n);
  const stringType = IRType.make(SemanticRef.type("test/string"), Schema.String, Native.U64);
  // @ts-expect-error function result must satisfy the declared IRType
  R.fn([R.U64], stringType, (a) => a);
  const otherLaw = Law.associative(
    SemanticRef.operation("other/operation"),
    Evidence.claim("fixture"),
  );
  // @ts-expect-error incompatible semantic law subject
  AddU64.pipe(Operation.withLaws([otherLaw]));
  const customRef = SemanticRef.operation("custom/add");
  Operation.make(customRef, [R.U64, R.U64], R.U64, (a, b) => a + b).pipe(
    Operation.withLaws([Law.associative(customRef, Evidence.claim("fixture"))]),
  );
  const Item = Entity.define("Item", Schema.Struct({ id: Schema.String, rank: Schema.Number }));
  const query = Query.from(Item).pipe(Query.where(EntityExpr.eq(Item.fields.rank, 1)));
  Foldkit.compile({ Items: query });
  // @ts-expect-error published Foldkit builders preserve field operand types
  EntityExpr.eq(Item.fields.rank, "one");
  // @ts-expect-error compilation consumes Query IR rather than an opaque callback
  Foldkit.compile({ Items: () => query });
};
