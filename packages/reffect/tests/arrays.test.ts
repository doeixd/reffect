import { Array as Arr, Cause, Effect, Exit, FileSystem, Logger, Option } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  FailureFrames,
  NativeRunner,
  R,
  Reference,
  Rust,
  SourceArtifacts,
  type Fn,
  type IRType,
  type Inputs,
} from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const Item = R.Struct({ name: R.String, count: R.U64 });
const Boundary = R.TaggedUnion({ Terminal: {}, Cursor: { cursor: R.String } });

// Sum with indexes: Σ (x + i).
const indexed = R.fn([R.U64, R.U64, R.U64], R.U64, (a, b, c) =>
  R.Array.make(a, b, c).pipe(
    R.Array.map((x, i) => R.U64.add(x, i)),
    R.Array.reduce(R.U64.literal(0n), (acc, x) => R.U64.add(acc, x)),
  ),
);
// String elements: escape, drop "c", keep the last escaped element (a borrowed value copy).
const strings = R.fn([R.String], R.String, (first) =>
  R.Array.make(first, R.String.literal("b<"), R.String.literal("c")).pipe(
    R.Array.map((s) => R.String.replaceAll(s, "<", "&lt;")),
    R.Array.filter((s) => R.Bool.not(R.String.eq(s, R.String.literal("c")))),
    R.Array.reduce(R.String.literal("none"), (acc, s) =>
      R.Match.bool(R.String.includes(s, R.String.literal("&lt;")), s, acc),
    ),
  ),
);
const count = R.fn([R.String], R.U64, (first) =>
  R.Array.length(
    R.Array.filter(R.Array.make(first, R.String.literal("x")), (s) =>
      R.String.eq(s, R.String.literal("x")),
    ),
  ),
);
// Struct elements: filter on a field, project another, count.
const items = R.fn([R.String, R.U64], R.U64, (name, n) =>
  R.Array.make(
    Item.make({ name, count: n }),
    Item.make({ name: R.String.literal("small"), count: R.U64.literal(1n) }),
  ).pipe(
    R.Array.filter((item) => R.U64.lt(R.Struct.get(item, "count"), R.U64.literal(5n))),
    R.Array.map((item) => R.Struct.get(item, "name")),
    R.Array.length,
  ),
);
// Union elements matched inside the loop.
const cursors = R.fn([R.String], R.U64, (cursor) =>
  R.Array.make(
    Boundary.cases.Cursor.make({ cursor }),
    Boundary.cases.Terminal.make({}),
    Boundary.cases.Cursor.make({ cursor: R.String.literal("") }),
  ).pipe(
    R.Array.filter((b) =>
      Boundary.match(b, {
        Terminal: () => R.Bool.literal(false),
        Cursor: (c) => R.Bool.not(R.String.eq(R.Struct.get(c, "cursor"), R.String.literal(""))),
      }),
    ),
    R.Array.length,
  ),
);
const empty = R.fn([R.U64], R.U64, (seed) =>
  R.Array.empty(R.U64).pipe(R.Array.reduce(seed, (acc, x) => R.U64.add(acc, x))),
);
// Effectful iteration: sequential and fail-fast; later elements must not run.
const visit = R.fn([R.String, R.String], R.U64, R.Bool, (a, b) =>
  R.Effect.forEach(R.Array.make(a, b, R.String.literal("tail")), (s) =>
    R.Effect.logInfo("visit", []).pipe(
      R.Effect.annotateLogs("index", R.U64.literal(0n)),
      R.Effect.andThen(
        R.Match.bool(
          R.String.eq(s, R.String.literal("stop")),
          R.Effect.fail(R.Bool.literal(false)),
          R.Effect.succeed(R.String.replaceAll(s, "<", "&lt;")),
        ),
      ),
    ),
  ).pipe(R.Effect.map((visited) => R.Array.length(visited))),
);
const discard = R.fn([R.U64], R.Unit, R.Never, (n) =>
  R.Array.make(n, R.U64.literal(2n)).pipe(
    R.Effect.forEach((x, i) => R.Effect.logInfo("discard", [["value", R.U64.add(x, i)]]), {
      discard: true,
    }),
  ),
);
const suspended = R.fn([R.U64], R.U64, R.Never, (n) =>
  R.Effect.forEach(R.Array.make(n, R.U64.literal(5n)), (x) =>
    R.Effect.sleep(1).pipe(R.Effect.andThen(R.Effect.succeed(R.U64.add(x, R.U64.literal(1n))))),
  ).pipe(
    R.Effect.map((xs) => R.Array.reduce(xs, R.U64.literal(0n), (acc, x) => R.U64.add(acc, x))),
  ),
);
const program = R.program({
  indexed,
  strings,
  count,
  items,
  cursors,
  empty,
  visit,
  discard,
  suspended,
});
const officialVisit = (a: string, b: string) =>
  Effect.forEach([a, b, "tail"], (s) =>
    Effect.logInfo("visit").pipe(
      Effect.annotateLogs("index", 0n),
      Effect.andThen(s === "stop" ? Effect.fail(false) : Effect.succeed(s.replaceAll("<", "&lt;"))),
    ),
  ).pipe(Effect.map((visited) => BigInt(visited.length)));

const official = {
  indexed: (a: bigint, b: bigint, c: bigint) =>
    Arr.reduce(
      Arr.map([a, b, c], (x, i) => x + BigInt(i)),
      0n,
      (acc, x) => acc + x,
    ),
  strings: (first: string) =>
    Arr.reduce(
      Arr.filter(
        Arr.map([first, "b<", "c"], (s) => s.replaceAll("<", "&lt;")),
        (s) => s !== "c",
      ),
      "none",
      (acc, s) => (s.includes("&lt;") ? s : acc),
    ),
  count: (first: string) => BigInt(Arr.filter([first, "x"], (s) => s === "x").length),
  items: (name: string, n: bigint) =>
    BigInt(
      Arr.map(
        Arr.filter(
          [
            { name, count: n },
            { name: "small", count: 1n },
          ],
          (item) => item.count < 5n,
        ),
        (item) => item.name,
      ).length,
    ),
  cursors: (cursor: string) =>
    BigInt(Arr.filter([cursor, null, ""], (c) => c !== null && c !== "").length),
  empty: (seed: bigint) => Arr.reduce(Arr.empty<bigint>(), seed, (acc, x) => acc + x),
};

test("array operations agree with effect/Array", async () => {
  expect(R.Array(R.U64)).toBe(R.Array(R.U64));
  for (const [a, b, c] of [
    [1n, 2n, 3n],
    [0n, 0n, 0n],
  ] as const)
    expect(await Effect.runPromise(Reference.run(indexed, [a, b, c]))).toBe(
      official.indexed(a, b, c),
    );
  for (const first of ["a<😀", "plain", "c", ""]) {
    expect(await Effect.runPromise(Reference.run(strings, [first]))).toBe(official.strings(first));
    expect(await Effect.runPromise(Reference.run(count, [first]))).toBe(official.count(first));
    expect(await Effect.runPromise(Reference.run(cursors, [first]))).toBe(official.cursors(first));
  }
  for (const [name, n] of [
    ["big", 9n],
    ["mid", 4n],
  ] as const)
    expect(await Effect.runPromise(Reference.run(items, [name, n]))).toBe(official.items(name, n));
  expect(await Effect.runPromise(Reference.run(empty, [7n]))).toBe(official.empty(7n));
  for (const [a, b] of [
    ["a<", "b"],
    ["a", "stop"],
    ["stop", "b"],
  ] as const) {
    const logs = { official: 0, reference: 0 };
    const counting = (key: keyof typeof logs) =>
      Logger.layer([Logger.make(() => void logs[key]++)]);
    const officialExit = observe(
      await Effect.runPromise(
        Effect.exit(officialVisit(a, b).pipe(Effect.provide(counting("official")))),
      ),
    );
    const referenceExit = observe(
      await Effect.runPromise(
        Effect.exit(Reference.run(visit, [a, b]).pipe(Effect.provide(counting("reference")))),
      ),
    );
    expect(referenceExit).toEqual(officialExit);
    // Elements after the failing one never run.
    expect(logs.reference).toBe(logs.official);
  }
  expect(await Effect.runPromise(Reference.run(suspended, [1n]))).toBe(8n);
  expect(() =>
    R.Effect.forEach(R.Array.make(R.U64.literal(1n)), () => R.Effect.void, {
      // @ts-expect-error Concurrency is refused in types and at authoring time.
      concurrency: 2,
    }),
  ).toThrow("sequential");
});

test("array authoring refuses mixed witnesses", () => {
  expect(() =>
    // @ts-expect-error Elements share one witness, in types and at authoring time.
    R.Array.make(R.U64.literal(1n), R.String.literal("x")),
  ).toThrow("item witness");
  const typeContracts = () => {
    // @ts-expect-error filter predicates are Boolean.
    R.Array.filter(R.Array.make(R.U64.literal(1n)), (x) => x);
  };
  void typeContracts;
});

const observe = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.match(exit, {
    onSuccess: (value) => ({ value }),
    onFailure: (cause) => ({ error: Option.getOrUndefined(Cause.findErrorOption(cause)) }),
  });

test(
  "native arrays agree with the reference across policies and profiles",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-arrays-" });
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
                    observe(yield* NativeRunner.run(artifact, directory, name, fn, args, profile)),
                    `${name}(${args.map(String).join(", ")})`,
                  ).toEqual(observe(yield* Effect.exit(Reference.run(fn, args))));
                });
              yield* agree("indexed", indexed, [1n, 2n, 3n]);
              for (const first of ["a<😀", "plain", "c", ""]) {
                yield* agree("strings", strings, [first]);
                yield* agree("count", count, [first]);
                yield* agree("cursors", cursors, [first]);
              }
              yield* agree("items", items, ["big", 9n]);
              yield* agree("items", items, ["mid", 4n]);
              yield* agree("empty", empty, [7n]);
              for (const [a, b] of [
                ["a<", "b"],
                ["a", "stop"],
                ["stop", "b"],
              ] as const) {
                expect(
                  observe(
                    yield* NativeRunner.run(artifact, directory, "visit", visit, [a, b], profile),
                  ),
                ).toEqual(observe(yield* Effect.exit(Reference.run(visit, [a, b]))));
                const raw = yield* CargoApi.run(
                  directory,
                  "visit",
                  [a, b].map((s) => `str:${Buffer.from(s, "utf8").toString("hex")}`),
                  profile,
                );
                expect(messages(raw.stderr)).toEqual(
                  Array.from({ length: a === "stop" ? 1 : 3 }, () => "visit").slice(
                    0,
                    a === "stop" ? 1 : b === "stop" ? 2 : 3,
                  ),
                );
              }
              // #40: malformed hex is refused as an argument error, never sliced mid-character into
              // a panic nor read through a sign (`+f`).
              for (const bad of ["str:aé0", "str:+f", "str:4", "str:zz", "str:4A", "plain"]) {
                const refused = yield* CargoApi.run(
                  directory,
                  "visit",
                  [bad, "str:62"],
                  profile,
                ).pipe(Effect.catchTag("CargoError", Effect.succeed));
                expect(refused.exitCode, bad).toBe(1);
                expect(refused.stderr, bad).toContain("invalid String");
                expect(refused.stderr, bad).not.toContain("panicked");
              }
              const discarded = yield* CargoApi.run(directory, "discard", [3n], profile);
              expect(messages(discarded.stderr)).toEqual(["discard", "discard"]);
              expect(
                observe(
                  yield* NativeRunner.run(
                    artifact,
                    directory,
                    "suspended",
                    suspended,
                    [1n],
                    profile,
                  ),
                ),
              ).toEqual({ value: 8n });
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);

const messages = (stderr: string) =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
    .map((line) => JSON.parse(line).message);
