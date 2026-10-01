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
  Compile,
  SourceArtifacts,
  SemanticRef,
} from "../src/index.ts";
import { Effect, Schema } from "effect";
import { Entity, Expr as EntityExpr, Query } from "foldkit-entity";

// Compiled by strict TypeScript checks; never executed.
export const typeChecks = () => {
  const source = R.Source.file("src/types.ts", "sum(value)");
  const site = R.Source.site(source, 0, 10);
  const annotated = R.fn([R.U64], R.U64, (value) => value.pipe(R.Source.at(site))).pipe(
    R.Source.named("identity"),
    R.Source.use(site),
  );
  Reference.run(annotated, [1n]);
  // @ts-expect-error source annotations preserve the original input tuple
  Reference.run(annotated, [true]);
  const annotatedEffect = R.fn([R.Bool], R.Bool, R.U64, (value) =>
    R.Effect.succeed(value).pipe(R.Source.at(site)),
  ).pipe(R.Source.named("bool"));
  Reference.run(annotatedEffect, [true]);
  // @ts-expect-error annotated effects preserve the input representation
  Reference.run(annotatedEffect, [1n]);
  const add = R.fn([R.U64, R.U64], R.U64, (a, b) => R.U64.add(a, b));
  const compiled = R.program({ add });
  Compile.run(compiled).pipe(Effect.map((artifact) => artifact.sources.ranges));
  const fullSpec = Compile.make(compiled);
  fullSpec.pipe(
    Compile.run,
    Effect.map((artifact) => artifact.sources.ranges),
  );
  const noneSpec = fullSpec.pipe(Compile.withSourceArtifacts(SourceArtifacts.None));
  noneSpec.pipe(
    Compile.run,
    Effect.map((artifact) => {
      const absent: undefined = artifact.sources;
      return absent;
    }),
  );
  Compile.build(fullSpec, "unused").pipe(Effect.map((result) => result.artifact.sources.ranges));
  Compile.build(noneSpec, "unused").pipe(
    Effect.map((result) => {
      const absent: undefined = result.artifact.sources;
      return absent;
    }),
  );
  // @ts-expect-error artifact policies are typed registered objects, not strings
  fullSpec.pipe(Compile.withSourceArtifacts("none"));
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
  const effect = R.fn([R.Bool, R.U64], R.U64, R.U64, (condition, value) =>
    R.Match.bool(condition, R.Effect.succeed(value), R.Effect.fail(value)).pipe(
      R.Effect.map((result) => R.U64.add(result, value)),
      R.Effect.flatMap((result) => R.Effect.succeed(result)),
    ),
  );
  Reference.run(effect, [true, 1n]);
  // @ts-expect-error Boolean inputs are not bigint
  Reference.run(effect, [1n, 1n]);
  // @ts-expect-error error payload must match the declared channel
  R.fn([], R.U64, R.U64, () => R.Effect.fail(R.Bool.literal(true)));
  // @ts-expect-error success payload must match the declared channel
  R.fn([], R.Bool, R.U64, () => R.Effect.succeed(R.U64.literal(1n)));
  // @ts-expect-error pure Match branches must agree
  R.Match.bool(R.Bool.literal(true), R.Bool.literal(true), R.U64.literal(1n));
  // @ts-expect-error pure/effectful branches cannot be mixed
  R.Match.bool(R.Bool.literal(true), R.Bool.literal(true), R.Effect.succeed(R.Bool.literal(false)));
  // @ts-expect-error exhaustive Match requires both arms
  R.Match.bool(R.Bool.literal(true), R.Bool.literal(true));
  const Item = Entity.define("Item", Schema.Struct({ id: Schema.String, rank: Schema.Number }));
  const query = Query.from(Item).pipe(Query.where(EntityExpr.eq(Item.fields.rank, 1)));
  Foldkit.compile({ Items: query });
  // @ts-expect-error published Foldkit builders preserve field operand types
  EntityExpr.eq(Item.fields.rank, "one");
  // @ts-expect-error compilation consumes Query IR rather than an opaque callback
  Foldkit.compile({ Items: () => query });
};
