import {
  AddU64,
  Evidence,
  IRType,
  Law,
  Native,
  NativeRpc,
  Operation,
  R,
  Reference,
  Foldkit,
  Compile,
  SourceArtifacts,
  SemanticRef,
} from "../src/index.ts";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";
import { Context, Effect, Schema } from "effect";
import { Entity, Expr as EntityExpr, Query } from "foldkit-entity";
import { Rs } from "../src/rust-emit.ts";
import type { RsExpr, RsItem, RsMacroGroup, RsMacroRule, RsType } from "../src/rust-emit.ts";

// Compiled by strict TypeScript checks; never executed.
export const typeChecks = () => {
  const rpcGroup = RpcGroup.make(
    Rpc.make("Add", { payload: { left: NativeRpc.U64Json }, success: NativeRpc.U64Json }),
  );
  const rpcFn = R.fn([R.U64], R.U64, (value) => value);
  NativeRpc.compile(rpcGroup, { Add: NativeRpc.bind(rpcFn, ["left"]) });
  // @ts-expect-error payload fields are checked against the shared RpcGroup
  NativeRpc.compile(rpcGroup, { Add: NativeRpc.bind(rpcFn, ["missing"]) });
  // @ts-expect-error every RPC procedure requires a binding
  NativeRpc.compile(rpcGroup, {});
  NativeRpc.compile(rpcGroup, {
    // @ts-expect-error handler success values must match the shared schema
    Add: NativeRpc.bind(
      R.fn([], R.Bool, () => R.Bool.literal(true)),
      ["left"],
    ),
  });
  class Principal extends Context.Service<Principal, bigint>()("test/Principal") {}
  class OtherPrincipal extends Context.Service<OtherPrincipal, bigint>()("test/OtherPrincipal") {}
  class Auth extends RpcMiddleware.Service<Auth, { provides: Principal }>()("test/Auth", {
    error: Schema.Literal("Unauthorized"),
  }) {}
  const auth = NativeRpc.bearer(Auth, Principal, { credentialsEnv: "TEST_CREDENTIALS" });
  // @ts-expect-error the adapter projects the middleware's declared service
  NativeRpc.bearer(Auth, OtherPrincipal, { credentialsEnv: "TEST_CREDENTIALS" });
  class NeedsService extends RpcMiddleware.Service<
    NeedsService,
    { provides: Principal; requires: OtherPrincipal }
  >()("test/NeedsService", { error: Schema.Literal("Unauthorized") }) {}
  // @ts-expect-error additional middleware requirements are unsupported
  NativeRpc.bearer(NeedsService, Principal, { credentialsEnv: "TEST_CREDENTIALS" });
  class MultipleServices extends RpcMiddleware.Service<
    MultipleServices,
    { provides: Principal | OtherPrincipal }
  >()("test/MultipleServices", { error: Schema.Literal("Unauthorized") }) {}
  // @ts-expect-error the adapter cannot silently drop an additional provided service
  NativeRpc.bearer(MultipleServices, Principal, { credentialsEnv: "TEST_CREDENTIALS" });
  const protectedGroup = rpcGroup.middleware(Auth);
  const protectedFn = R.fn([R.U64, R.U64], R.U64, (principal, value) =>
    principal.pipe(R.U64.add(value)),
  );
  NativeRpc.compile(
    protectedGroup,
    { Add: NativeRpc.bindPrincipal(protectedFn, ["left"]) },
    { auth },
  );
  // @ts-expect-error protected procedures require principal projection
  NativeRpc.compile(protectedGroup, { Add: NativeRpc.bind(rpcFn, ["left"]) }, { auth });
  // @ts-expect-error a public procedure cannot receive an unauthenticated principal
  NativeRpc.compile(rpcGroup, { Add: NativeRpc.bindPrincipal(protectedFn, ["left"]) });
  // @ts-expect-error principal projection requires a first bigint argument
  NativeRpc.bindPrincipal(R.fn([R.Bool], R.Bool, (value) => value));
  const rpcUnit = RpcGroup.make(
    Rpc.make("Unit", { payload: Schema.Undefined, success: Schema.Undefined }),
  );
  NativeRpc.compile(rpcUnit, {
    Unit: NativeRpc.bind(R.fn([], R.Unit, R.Never, () => R.Effect.void)),
  });

  const addOne = Rs.defineFn(
    Rs.ident("add_one"),
    [{ name: Rs.ident("value"), type: Rs.u64Type() }],
    Rs.u64Type(),
    (arg) => Rs.exprTemplate`(${arg(Rs.ident("value"))}).wrapping_add(1u64)`,
  );
  addOne.call(Rs.litU64(1n));
  // @ts-expect-error generated helper call arity follows its declared parameter tuple
  addOne.call();
  // @ts-expect-error a Rust type fragment cannot be interpolated as a Rust expression
  const wrongExpressionRole: RsExpr = Rs.exprTemplate`consume(${Rs.u64Type()})`;
  void wrongExpressionRole;
  // @ts-expect-error a Rust expression fragment cannot be interpolated as a Rust type
  const wrongTypeRole: RsType = Rs.typeTemplate`Option<${Rs.litU64(1n)}>`;
  void wrongTypeRole;
  const matcher = Rs.macroGroup("matcher", "()", [Rs.macroFragment(Rs.ident("value"), "expr")]);
  const transcriber = Rs.macroGroup("transcriber", "{}", [Rs.macroRef(Rs.ident("value"))]);
  Rs.macroRule(matcher, transcriber);
  // @ts-expect-error matcher and transcriber token trees have distinct roles
  const wrongMacroRoles: RsMacroRule = Rs.macroRule(transcriber, matcher);
  void wrongMacroRoles;
  // @ts-expect-error visibility is a structured Rust value, not source text
  const wrongVisibility: RsItem = Rs.useItem(Rs.useTree(Rs.path([Rs.ident("Thing")])), "pub");
  void wrongVisibility;
  // @ts-expect-error a matcher node only accepts matcher-role tokens
  const wrongMatcher: RsMacroGroup<"matcher"> = Rs.macroGroup("matcher", "()", [
    Rs.macroRef(Rs.ident("value")),
  ]);
  void wrongMatcher;
  // @ts-expect-error module bodies contain items, not expression fragments
  const wrongModuleBody: RsItem = Rs.moduleItem(Rs.ident("broken"), [Rs.litU64(1n)]);
  void wrongModuleBody;
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
  const unit = R.fn([R.Unit], R.Unit, (value) => value);
  Reference.run(unit, [undefined]).pipe(
    Effect.map((value) => {
      const empty: void = value;
      return empty;
    }),
  );
  // @ts-expect-error Unit factories have no payload
  R.Unit.literal(1n);
  // @ts-expect-error Unit arguments are not null
  Reference.run(unit, [null]);
  const discard = R.fn([R.U64], R.Unit, R.Bool, (value) =>
    R.Effect.succeed(value).pipe(R.Effect.asVoid),
  );
  Reference.run(discard, [1n]);
  const framed = R.fn([R.Bool], R.U64, R.Unit, (c) =>
    R.Match.bool(c, R.Effect.succeed(R.U64.literal(1n)), R.Effect.fail(R.Unit.literal())),
  );
  Reference.runWithFrames(framed, [true], "functions.framed.body").pipe(
    Effect.map((result) => {
      const paths: readonly (readonly [string, string])[] = result.frames.map(
        (f) => [f.path, f.kind] as const,
      );
      const missed: number = result.omitted;
      return { paths, missed };
    }),
  );
  Reference.runWithFramesUnknown(framed, [true], "functions.framed.body");
  // @ts-expect-error frame base paths are strings, not numbers
  Reference.runWithFrames(framed, [true], 42);
  const logged = R.fn([], R.Unit, R.Never, () =>
    R.Log.info("started", [["count", R.U64.literal(1n)]]).pipe(
      R.Effect.flatMap(() => R.Effect.void),
    ),
  );
  Reference.run(logged, []);
  // @ts-expect-error log levels are a fixed six-severity witness
  R.Log.log("Verbose", "nope");
  // @ts-expect-error log attributes require Boolean or u64 expressions
  R.Log.info("bad", [["unit", R.Unit.literal()]]);
  const scopedComputation = R.Log.info("scoped").pipe(
    R.Log.annotate("req", R.U64.literal(7n)),
    R.Log.span("work"),
  );
  Reference.run(
    R.fn([], R.Unit, R.Never, () =>
      scopedComputation.pipe(R.Effect.flatMap(() => R.Effect.succeed(R.Unit.literal()))),
    ),
    [],
  );
  // @ts-expect-error annotation keys are strings, not numbers
  R.Log.info("x").pipe(R.Log.annotate(7, R.Bool.literal(true)));
  // @ts-expect-error a Unit success channel cannot return a Boolean payload
  R.fn([], R.Unit, R.Never, () => R.Effect.succeed(R.Bool.literal(true)));
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
