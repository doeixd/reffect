import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference } from "../src/index.ts";
import type { StreamIR } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// STREAM-004/005: each pipeline returns `runCollect(chunks(stream))`, so the chunk boundaries
// Effect produces are compared with native ones over the wire, as is a failure part-way.
const S = R.Stream;
const n = (value: number) => R.Number.literal(value);
const boom = S.fail(R.String.literal("boom"), R.Number);
const Chunks = R.Array(R.Array(R.Number));
const chunked = <E>(stream: StreamIR<number, E>) => S.runCollect(S.chunks(stream));
const pipeline = (build: () => StreamIR<number, never>) =>
  R.fn([], Chunks, R.Never, () => chunked(build()));
const failing = (build: () => StreamIR<number, string>) =>
  R.fn([], Chunks, R.String, () => chunked(build()));

const make = pipeline(() => S.make(n(1), n(2), n(3)));
const fromIterable = R.fn([R.Array(R.Number)], Chunks, R.Never, (values) =>
  chunked(S.fromIterable(values)),
);
const range = R.fn([R.Number, R.Number], Chunks, R.Never, (min, max) => chunked(S.range(min, max)));
const empty = pipeline(() => S.empty(R.Number));
const failPartway = failing(() => S.concat(S.make(n(1), n(2)), boom));
const mapped = pipeline(() => S.make(n(1), n(2), n(3)).pipe(S.map((x) => R.Number.add(x, x))));
// The second chunk filters to nothing and is dropped.
const filterDropsEmpty = pipeline(() =>
  S.concat(S.make(n(1), n(2)), S.make(n(7), n(8))).pipe(S.filter((x) => R.Number.lt(x, n(5)))),
);
const takeAcrossChunks = pipeline(() => S.range(1, 10000).pipe(S.take(5000)));
const takeNone = pipeline(() => S.range(1, 10).pipe(S.take(0)));
const takeFraction = pipeline(() => S.range(1, 10).pipe(S.take(2.5)));
// take stops its own source only; the concatenated stream continues.
const takeThenConcat = pipeline(() =>
  S.concat(S.make(n(1), n(2), n(3)).pipe(S.take(2)), S.make(n(4))),
);
const takeBeforeFailure = failing(() => S.concat(S.make(n(1), n(2), n(3)).pipe(S.take(1)), boom));
const rechunk = pipeline(() => S.range(1, 5).pipe(S.rechunk(2)));
const rechunkExact = pipeline(() => S.concat(S.make(n(1), n(2)), S.make(n(3))).pipe(S.rechunk(2)));
const rechunkThenTake = pipeline(() => S.range(1, 10).pipe(S.rechunk(3), S.take(4)));
const takeThenRechunk = pipeline(() => S.range(1, 10).pipe(S.take(7), S.rechunk(3)));
const rechunkFailure = failing(() => S.concat(S.make(n(1), n(2), n(3)), boom).pipe(S.rechunk(2)));
const collect = R.fn([], R.Array(R.Number), R.Never, () =>
  S.runCollect(S.range(1, 3).pipe(S.map((x) => R.Number.add(x, n(0.5))))),
);

const Wire = Schema.Array(Schema.Array(Schema.Number));
const Group = RpcGroup.make(
  Rpc.make("Make", { payload: {}, success: Wire }),
  Rpc.make("FromIterable", { payload: Schema.Array(Schema.Number), success: Wire }),
  Rpc.make("Range", { payload: { min: Schema.Number, max: Schema.Number }, success: Wire }),
  Rpc.make("Empty", { payload: {}, success: Wire }),
  Rpc.make("FailPartway", { payload: {}, success: Wire, error: Schema.String }),
  Rpc.make("Map", { payload: {}, success: Wire }),
  Rpc.make("FilterDropsEmpty", { payload: {}, success: Wire }),
  Rpc.make("TakeAcrossChunks", { payload: {}, success: Wire }),
  Rpc.make("TakeNone", { payload: {}, success: Wire }),
  Rpc.make("TakeFraction", { payload: {}, success: Wire }),
  Rpc.make("TakeThenConcat", { payload: {}, success: Wire }),
  Rpc.make("TakeBeforeFailure", { payload: {}, success: Wire, error: Schema.String }),
  Rpc.make("Rechunk", { payload: {}, success: Wire }),
  Rpc.make("RechunkExact", { payload: {}, success: Wire }),
  Rpc.make("RechunkThenTake", { payload: {}, success: Wire }),
  Rpc.make("TakeThenRechunk", { payload: {}, success: Wire }),
  Rpc.make("RechunkFailure", { payload: {}, success: Wire, error: Schema.String }),
  Rpc.make("Collect", { payload: {}, success: Schema.Array(Schema.Number) }),
);
const bindings = {
  Make: NativeRpc.bind(make),
  FromIterable: NativeRpc.bind(fromIterable),
  Range: NativeRpc.bind(range, ["min", "max"]),
  Empty: NativeRpc.bind(empty),
  FailPartway: NativeRpc.bind(failPartway),
  Map: NativeRpc.bind(mapped),
  FilterDropsEmpty: NativeRpc.bind(filterDropsEmpty),
  TakeAcrossChunks: NativeRpc.bind(takeAcrossChunks),
  TakeNone: NativeRpc.bind(takeNone),
  TakeFraction: NativeRpc.bind(takeFraction),
  TakeThenConcat: NativeRpc.bind(takeThenConcat),
  TakeBeforeFailure: NativeRpc.bind(takeBeforeFailure),
  Rechunk: NativeRpc.bind(rechunk),
  RechunkExact: NativeRpc.bind(rechunkExact),
  RechunkThenTake: NativeRpc.bind(rechunkThenTake),
  TakeThenRechunk: NativeRpc.bind(takeThenRechunk),
  RechunkFailure: NativeRpc.bind(rechunkFailure),
  Collect: NativeRpc.bind(collect),
};
const oracle = Effect.gen(function* () {
  const run = <A, E>(effect: Effect.Effect<A, E | { readonly _tag: "CompileError" }>) =>
    effect.pipe(Effect.catchTag("CompileError", Effect.die));
  const handlers = Group.toLayer({
    Make: () => run(Reference.run(make, [])),
    FromIterable: (values) => run(Reference.run(fromIterable, [values])),
    Range: ({ min, max }) => run(Reference.run(range, [min, max])),
    Empty: () => run(Reference.run(empty, [])),
    FailPartway: () => run(Reference.run(failPartway, [])),
    Map: () => run(Reference.run(mapped, [])),
    FilterDropsEmpty: () => run(Reference.run(filterDropsEmpty, [])),
    TakeAcrossChunks: () => run(Reference.run(takeAcrossChunks, [])),
    TakeNone: () => run(Reference.run(takeNone, [])),
    TakeFraction: () => run(Reference.run(takeFraction, [])),
    TakeThenConcat: () => run(Reference.run(takeThenConcat, [])),
    TakeBeforeFailure: () => run(Reference.run(takeBeforeFailure, [])),
    Rechunk: () => run(Reference.run(rechunk, [])),
    RechunkExact: () => run(Reference.run(rechunkExact, [])),
    RechunkThenTake: () => run(Reference.run(rechunkThenTake, [])),
    TakeThenRechunk: () => run(Reference.run(takeThenRechunk, [])),
    RechunkFailure: () => run(Reference.run(rechunkFailure, [])),
    Collect: () => run(Reference.run(collect, [])),
  });
  const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
    Effect.provide([handlers, RpcSerialization.layerJson]),
  );
  return HttpEffect.toWebHandler(http);
});

const request = (tag: string, payload: unknown = {}) =>
  JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] });
const corpus: ReadonlyArray<readonly [string, string]> = [
  ...[...Group.requests.keys()]
    .filter((tag) => tag !== "FromIterable" && tag !== "Range")
    .map((tag) => [tag, request(tag)] as const),
  ["FromIterable empty", request("FromIterable", [])],
  ["FromIterable", request("FromIterable", [1, 2, 3, 4, 5])],
  ["Range", request("Range", { min: 1, max: 5 })],
  ["Range across chunks", request("Range", { min: 1, max: 10000 })],
  ["Range reversed", request("Range", { min: 5, max: 1 })],
  ["Range single", request("Range", { min: 1, max: 1 })],
  ["Range fractional", request("Range", { min: 0.5, max: 3 })],
  ["Range NaN", request("Range", { min: 1, max: "NaN" })],
];

test(
  "native Stream pipelines collect the same elements and chunks as official Stream",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const official = yield* oracle;
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-stream-" });
          const artifact = yield* NativeRpc.compile(Group, bindings);
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.fetch(directory);
          yield* CargoApi.build(directory, "debug");
          const child = yield* ChildProcess.make(
            `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
            ["--port", "0"],
          );
          yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
          const ready = yield* Stream.runHead(
            Stream.splitLines(Stream.decodeText(child.stdout)),
          ).pipe(Effect.timeout("10 seconds"));
          if (!Option.isSome(ready)) throw new Error("Missing ready record");
          const { address } = Schema.decodeUnknownSync(
            Schema.Struct({
              schema: Schema.Literal("reffect.rpc.ready@1"),
              address: Schema.String,
            }),
          )(JSON.parse(ready.value));
          const answers = new Map<string, string>();
          for (const [label, body] of corpus) {
            const native = yield* Effect.promise(() =>
              fetch(`http://${address}/rpc`, { method: "POST", body }).then((r) => r.text()),
            );
            const reference = yield* Effect.promise(() =>
              official(new Request("http://reffect.test/rpc", { method: "POST", body })).then((r) =>
                r.text(),
              ),
            );
            answers.set(label, reference);
            expect(JSON.parse(native), label).toStrictEqual(JSON.parse(reference));
          }
          // The boundaries compared are really Effect's.
          const answer = (label: string) => answers.get(label) ?? "";
          expect(answer("Range across chunks")).toContain("4096],[4097");
          expect(answer("TakeAcrossChunks")).toContain("4096],[4097");
          expect(answer("FilterDropsEmpty")).toContain('"value":[[1,2]]');
          expect(answer("Rechunk")).toContain('"value":[[1,2],[3,4],[5]]');
          expect(answer("TakeThenRechunk")).toContain('"value":[[1,2,3],[4,5,6],[7]]');
          expect(answer("FailPartway")).toContain('"error":"boom"');
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 180000,
);
