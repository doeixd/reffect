import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  Expr,
  FailureFrames,
  type Fn,
  type IRType,
  type Inputs,
  NativeRunner,
  R,
  Reference,
  Rust,
  SourceArtifacts,
} from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// Foldkit Remote's WireBoundary (foldkit-plus packages/remote/src/wire.ts).
const Boundary = R.TaggedUnion({ Terminal: {}, Cursor: { cursor: R.String }, Unknown: {} });
const Item = R.Struct({ name: R.String, count: R.U64 });

const boundaryOf = (kind: Expr<bigint>, cursor: Expr<string>) =>
  R.Match.bool(
    R.U64.eq(kind, R.U64.literal(0n)),
    Boundary.cases.Terminal.make({}),
    R.Match.bool(
      R.U64.eq(kind, R.U64.literal(1n)),
      Boundary.cases.Cursor.make({ cursor }),
      Boundary.cases.Unknown.make({}),
    ),
  );
const describe = R.fn([R.U64, R.String], R.String, (kind, cursor) =>
  Boundary.match(boundaryOf(kind, cursor), {
    Terminal: () => R.String.literal("terminal"),
    Cursor: (c) => R.String.replaceAll(R.Struct.get(c, "cursor"), "<", "&lt;"),
    Unknown: () => R.String.literal("unknown"),
  }),
);
// Data-last valueTags over a union parameter-free value, returning a Copy result.
const isCursor = R.fn([R.U64, R.String], R.Bool, (kind, cursor) =>
  boundaryOf(kind, cursor).pipe(
    R.Match.valueTags({
      Terminal: () => R.Bool.literal(false),
      Cursor: () => R.Bool.literal(true),
      Unknown: () => R.Bool.literal(false),
    }),
  ),
);
const itemCount = R.fn([R.String, R.U64], R.U64, (name, count) =>
  R.U64.add(R.Struct.get(Item.make({ name, count }), "count"), R.U64.literal(1n)),
);
// A struct field reused twice: once borrowed as an operand, once cloned into the result.
const itemName = R.fn([R.String, R.U64], R.String, (name, count) => {
  const item = Item.make({ name, count });
  return R.Match.bool(
    R.String.includes(R.Struct.get(item, "name"), R.String.literal("x")),
    R.Struct.get(item, "name"),
    R.String.literal("none"),
  );
});
const named = R.fn([R.String], R.String, R.Bool, (name) =>
  R.Effect.succeed(Item.make({ name, count: R.U64.literal(1n) })).pipe(
    R.Effect.map((item) => R.Struct.get(item, "name")),
  ),
);
// Effectful branching (part 1b): typed failure, logging and a suspended case.
const resolve = R.fn([R.U64, R.String], R.String, R.Bool, (kind, cursor) =>
  Boundary.match(boundaryOf(kind, cursor), {
    Terminal: () => R.Effect.fail(R.Bool.literal(false)),
    Cursor: (c) =>
      R.Effect.logInfo("cursor").pipe(
        R.Effect.andThen(R.Effect.succeed(R.Struct.get(c, "cursor"))),
      ),
    Unknown: () => R.Effect.succeed(R.String.literal("unknown")),
  }),
);
const suspended = R.fn([R.U64, R.String], R.String, R.Never, (kind, cursor) =>
  boundaryOf(kind, cursor).pipe(
    R.Match.valueTags({
      Terminal: () => R.Effect.succeed(R.String.literal("terminal")),
      // The borrowed case value stays valid across the suspension point.
      Cursor: (c) =>
        R.Effect.sleep(1).pipe(R.Effect.andThen(R.Effect.succeed(R.Struct.get(c, "cursor")))),
      Unknown: () => R.Effect.succeed(R.String.literal("unknown")),
    }),
  ),
);
const program = R.program({ describe, isCursor, itemCount, itemName, named, resolve, suspended });

const Official = Schema.TaggedUnion({
  Terminal: {},
  Cursor: { cursor: Schema.String },
  Unknown: {},
});
const officialDescribe = (kind: bigint, cursor: string) =>
  Official.match(
    kind === 0n
      ? Official.cases.Terminal.make({})
      : kind === 1n
        ? Official.cases.Cursor.make({ cursor })
        : Official.cases.Unknown.make({}),
    {
      Terminal: () => "terminal",
      Cursor: (c) => c.cursor.replaceAll("<", "&lt;"),
      Unknown: () => "unknown",
    },
  );
const officialResolve = (kind: bigint, cursor: string) =>
  Official.match(
    kind === 0n
      ? Official.cases.Terminal.make({})
      : kind === 1n
        ? Official.cases.Cursor.make({ cursor })
        : Official.cases.Unknown.make({}),
    {
      Terminal: (): Effect.Effect<string, boolean> => Effect.fail(false),
      Cursor: (c): Effect.Effect<string, boolean> =>
        Effect.logInfo("cursor").pipe(Effect.as(c.cursor)),
      Unknown: (): Effect.Effect<string, boolean> => Effect.succeed("unknown"),
    },
  );
const observe = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.match(exit, {
    onSuccess: (value) => ({ value }),
    onFailure: (cause) => ({ error: Option.getOrUndefined(Cause.findErrorOption(cause)) }),
  });
const corpus = [
  [0n, "a<b"],
  [1n, "a<b😀"],
  [1n, ""],
  [2n, "ignored"],
] as const;

test("records and tagged unions agree with official Effect Schema and match", async () => {
  expect(R.TaggedUnion({ Terminal: {}, Cursor: { cursor: R.String }, Unknown: {} })).toBe(Boundary);
  expect(R.Struct({ name: R.String, count: R.U64 })).toBe(Item);
  expect(R.Struct({ count: R.U64, name: R.String })).not.toBe(Item);
  expect(Item.annotate({ identifier: "Item" })).not.toBe(Item);
  for (const [kind, cursor] of corpus) {
    expect(await Effect.runPromise(Reference.run(describe, [kind, cursor]))).toBe(
      officialDescribe(kind, cursor),
    );
    expect(await Effect.runPromise(Reference.run(isCursor, [kind, cursor]))).toBe(kind === 1n);
  }
  for (const [kind, cursor] of corpus) {
    expect(
      observe(await Effect.runPromise(Effect.exit(Reference.run(resolve, [kind, cursor])))),
    ).toEqual(observe(await Effect.runPromise(Effect.exit(officialResolve(kind, cursor)))));
    expect(await Effect.runPromise(Reference.run(suspended, [kind, cursor]))).toBe(
      kind === 0n ? "terminal" : kind === 1n ? cursor : "unknown",
    );
  }
  expect(await Effect.runPromise(Reference.run(itemCount, ["n", 41n]))).toBe(42n);
  expect(await Effect.runPromise(Reference.run(itemName, ["box", 1n]))).toBe("box");
  expect(await Effect.runPromise(Reference.run(itemName, ["no", 1n]))).toBe("none");
  expect(await Effect.runPromise(Reference.run(named, ["n😀"]))).toBe("n😀");
});

test("composite authoring and checking refuse incomplete or foreign shapes", async () => {
  const value = Boundary.cases.Terminal.make({});
  expect(() =>
    // @ts-expect-error a missing case is a type error, and refused for untyped callers too
    R.Match.valueTags(value, {
      Terminal: () => R.Bool.literal(true),
      Unknown: () => R.Bool.literal(false),
    }),
  ).toThrow("Missing case");
  expect(() => R.Struct({ _tag: R.String })).toThrow("reserved");
  // Result types union across handlers, so differing witnesses are refused while authoring.
  expect(() =>
    Boundary.match(value, {
      Terminal: () => R.Bool.literal(true),
      Cursor: () => R.Bool.literal(true),
      Unknown: () => R.U64.literal(1n),
    }),
  ).toThrow("same witness");
  expect(() =>
    Expr.get(Item.make({ name: R.String.literal("n"), count: R.U64.literal(1n) }), "nope"),
  ).toThrow("Unknown field");
  const checks = (fn: Parameters<typeof R.program>[0][string]) =>
    Effect.runPromise(Compile.check(R.program({ fn })).pipe(Effect.isSuccess));
  // Hand-built matches still need one case per tag.
  const partial = R.fn([R.U64], R.Bool, (kind) => {
    const union = boundaryOf(kind, R.String.literal("c"));
    const binder = Symbol("case");
    return Expr.matchTags(union, R.Bool, [{ tag: "Terminal", binder, body: R.Bool.literal(true) }]);
  });
  expect(await checks(partial)).toBe(false);
  // Delayed cleanup cannot capture composite values.
  const capture = R.fn([R.String], R.Unit, R.Never, (name) =>
    R.Effect.succeed(Item.make({ name, count: R.U64.literal(1n) })).pipe(
      R.Effect.flatMap((item) =>
        R.Effect.addFinalizer(() => R.Effect.asVoid(R.Effect.succeed(item))),
      ),
      R.Effect.scoped,
    ),
  );
  expect(await checks(capture)).toBe(false);
  const typeContracts = () => {
    // @ts-expect-error Construction requires every declared field.
    Item.make({ name: R.String.literal("n") });
    // @ts-expect-error Fields keep their witnesses.
    Item.make({ name: R.U64.literal(1n), count: R.U64.literal(1n) });
    // @ts-expect-error Unknown fields are rejected.
    R.Struct.get(Item.make({ name: R.String.literal("n"), count: R.U64.literal(1n) }), "missing");
  };
  void typeContracts;
});

test(
  "native records and tagged unions agree with the reference across policies and profiles",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-records-" });
          for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
            const artifact = yield* Compile.make(program).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withFailureFrames(policy),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.run,
            );
            expect(artifact.explanation.crates).toEqual(["tokio@1.53.1"]);
            const directory = yield* CargoApi.write(artifact, `${parent}/${policy._tag}`);
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              const agree = <I extends readonly IRType<unknown>[], A>(
                name: string,
                fn: Fn<I, A>,
                args: Inputs<I>,
              ) =>
                Effect.gen(function* () {
                  expect(
                    yield* NativeRunner.run(artifact, directory, name, fn, args, profile),
                    `${name}(${args.map(String).join(", ")})`,
                  ).toEqual(yield* Effect.exit(Reference.run(fn, args)));
                });
              for (const [kind, cursor] of corpus) {
                yield* agree("describe", describe, [kind, cursor]);
                yield* agree("isCursor", isCursor, [kind, cursor]);
                for (const [name, fn] of [
                  ["resolve", resolve],
                  ["suspended", suspended],
                ] as const)
                  expect(
                    observe(
                      yield* NativeRunner.run(
                        artifact,
                        directory,
                        name,
                        fn,
                        [kind, cursor],
                        profile,
                      ),
                    ),
                    `${name}(${kind})`,
                  ).toEqual(observe(yield* Effect.exit(Reference.run(fn, [kind, cursor]))));
              }
              yield* agree("itemCount", itemCount, ["n", 41n]);
              yield* agree("itemName", itemName, ["box", 1n]);
              yield* agree("itemName", itemName, ["no", 1n]);
              expect(
                yield* NativeRunner.run(artifact, directory, "named", named, ["n😀"], profile),
              ).toEqual(yield* Effect.exit(Reference.run(named, ["n😀"])));
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);

test("valueTags gives each handler its own case, data-first and in a pipe", async () => {
  const value = Boundary.cases.Cursor.make({ cursor: R.String.literal("c") });
  const handlers = {
    Terminal: () => R.String.literal("start"),
    Cursor: (cursor: Expr<{ readonly _tag: "Cursor"; readonly cursor: string }>) =>
      R.Struct.get(cursor, "cursor"),
    Unknown: () => R.String.literal("?"),
  };
  const first = R.Match.valueTags(value, handlers);
  // Data-last: the case types come from the piped value, so no annotation is needed.
  const piped = value.pipe(
    R.Match.valueTags({
      Terminal: () => R.String.literal("start"),
      Cursor: (cursor) => R.Struct.get(cursor, "cursor"),
      Unknown: () => R.String.literal("?"),
    }),
  );
  const run = R.fn([], R.String, () => first);
  expect(await Effect.runPromise(Reference.run(run, []))).toBe("c");
  expect(
    await Effect.runPromise(
      Reference.run(
        R.fn([], R.String, () => piped),
        [],
      ),
    ),
  ).toBe("c");
  // Typed only: a field of another case, and a tag outside the union, are type errors.
  void (() =>
    value.pipe(
      R.Match.valueTags({
        // @ts-expect-error Terminal has no cursor
        Terminal: (terminal) => R.Struct.get(terminal, "cursor"),
        Cursor: (cursor) => R.Struct.get(cursor, "cursor"),
        Unknown: () => R.String.literal("?"),
      }),
    ));
  expect(() =>
    R.Match.valueTags(value, {
      ...handlers,
      // @ts-expect-error Extra is not a tag of the union
      Extra: () => R.String.literal("x"),
    }),
  ).toThrow("outside the union");
});

test("a string-literal union widens to String with text (8B)", async () => {
  const Origin = R.Literals(["Server", "Client"]);
  const describe = R.fn([R.String], R.String, (prefix) =>
    R.String.concat(prefix, Origin.text(Origin.literal("Client"))),
  );
  expect(await Effect.runPromise(Reference.run(describe, ["on the "]))).toBe("on the Client");
  // Another union's value is a type error, and refused for untyped callers too.
  expect(() =>
    // @ts-expect-error Server is not a literal of ["A"]
    R.Literals(["A"]).text(Origin.literal("Server")),
  ).toThrow("not of this union");
});
