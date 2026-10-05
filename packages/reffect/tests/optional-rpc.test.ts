import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// Contract schemas with optional fields, as Remote's wire module declares them.
const PageSize = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const WireUnion = Schema.TaggedUnion({ A: {}, B: { y: Schema.Boolean } });
const WireWide = Schema.Struct({
  a: Schema.optional(Schema.Number),
  b: Schema.optionalKey(NativeRpc.StringJson),
  c: Schema.Boolean,
  d: Schema.optional(Schema.Struct({ x: Schema.Boolean })),
  e: Schema.optionalKey(Schema.Array(Schema.Boolean)),
  u: Schema.optional(WireUnion),
  n: Schema.optionalKey(Schema.Never),
  k: Schema.optional(NativeRpc.U64Json),
  s: Schema.optional(NativeRpc.StringJson),
});
const WirePage = Schema.Struct({
  size: Schema.optional(PageSize),
  cursor: Schema.optionalKey(Schema.Number),
});
// `Schema.NullOr` values (OPT-006..008), as upstream selections declare nullable columns.
const WireNulls = Schema.Struct({
  s: Schema.NullOr(Schema.String),
  d: Schema.NullOr(Schema.Struct({ x: Schema.Boolean })),
  n: Schema.NullOr(Schema.Number),
  a: Schema.NullOr(Schema.Array(Schema.Boolean)),
});
const Group = RpcGroup.make(
  Rpc.make("Echo", { payload: WireWide, success: WireWide }),
  Rpc.make("Touch", { payload: WireWide, success: WireWide }),
  Rpc.make("Page", { payload: WirePage, success: Schema.Number }),
  Rpc.make("Nulls", { payload: WireNulls, success: WireNulls }),
);

const Union = R.TaggedUnion({ A: {}, B: { y: R.Bool } });
const Wide = R.Struct({
  a: R.optional(R.Number),
  b: R.optionalKey(R.String),
  c: R.Bool,
  d: R.optional(R.Struct({ x: R.Bool })),
  e: R.optionalKey(R.Array(R.Bool)),
  u: R.optional(Union),
  n: R.optionalKey(R.Never),
  k: R.optional(R.U64),
  s: R.optional(R.String),
});
const Page = R.Struct({ size: R.optional(R.Number), cursor: R.optionalKey(R.Number) });
const echo = R.fn([Wide], Wide, (wide) => wide);
// Rebuilt: `a` mapped, `b`/`e`/`n` omitted, `d`/`u`/`k` always present, `s` defined.
const touch = R.fn([Wide], Wide, (wide) =>
  Wide.make({
    c: R.Bool.not(R.Struct.get(wide, "c")),
    a: R.UndefinedOr.map(R.Struct.get(wide, "a"), (a) => R.Number.add(a, R.Number.literal(0.5))),
    d: R.Struct.get(wide, "d"),
    u: R.Struct.get(wide, "u"),
    k: R.Struct.get(wide, "k"),
    s: R.Struct.get(wide, "s").pipe(
      R.UndefinedOr.match({
        onUndefined: () => R.String.literal("none"),
        onDefined: (s) => R.String.replaceAll(s, "a", "b"),
      }),
    ),
  }),
);
const page = R.fn([Page], R.Number, (value) =>
  R.Number.add(
    R.UndefinedOr.match(R.Struct.get(value, "size"), {
      onUndefined: () => R.Number.literal(10),
      onDefined: (size) => size,
    }),
    R.UndefinedOr.match(R.Struct.get(value, "cursor"), {
      onUndefined: () => R.Number.literal(0.25),
      onDefined: (cursor) => cursor,
    }),
  ),
);
const Nulls = R.Struct({
  s: R.NullOr(R.String),
  d: R.NullOr(R.Struct({ x: R.Bool })),
  n: R.NullOr(R.Number),
  a: R.NullOr(R.Array(R.Bool)),
});
// `s` is read through Option and written back; the rest pass through.
const nulls = R.fn([Nulls], Nulls, (value) =>
  Nulls.make({
    s: R.Option.getOrNull(
      R.Option.map(R.Option.fromNullOr(R.Struct.get(value, "s")), (s) =>
        R.String.concat(s, R.String.literal("!")),
      ),
    ),
    d: R.Struct.get(value, "d"),
    n: R.Struct.get(value, "n"),
    a: R.Struct.get(value, "a"),
  }),
);
const bindings = {
  Echo: NativeRpc.bind(echo),
  Touch: NativeRpc.bind(touch),
  Page: NativeRpc.bind(page),
  Nulls: NativeRpc.bind(nulls),
};

const request = (tag: string, payload: string, id = "1") =>
  `{"_tag":"Request","id":"${id}","tag":"${tag}","payload":${payload},"headers":[]}`;
// Lone-surrogate escapes are a whole-body divergence (STR-007) and stay out of the corpus.
const wrong = [
  "null",
  "true",
  "1",
  "1.5",
  '"x"',
  '"NaN"',
  '"12"',
  "[]",
  "[true]",
  "[1]",
  "{}",
  '{"x":1}',
  '{"x":true}',
  '{"_tag":"Z"}',
  '{"_tag":"A"}',
  '{"_tag":"B"}',
  '{"_tag":"B","y":false}',
];
const fields = ["a", "b", "d", "e", "u", "n", "k", "s"];
const corpus: ReadonlyArray<readonly [string, string]> = [
  ["minimal", request("Echo", '{"c":true}')],
  ["missing c", request("Echo", '{"a":1}')],
  ["not an object", request("Echo", "[]")],
  [
    "all present",
    request(
      "Echo",
      '{"s":"abc","k":"7","u":{"_tag":"B","y":true},"e":[true,false],"d":{"x":false},"b":"s","a":-0.5,"c":false}',
    ),
  ],
  ["all null", request("Echo", '{"c":true,"a":null,"d":null,"u":null,"k":null,"s":null}')],
  ...fields.flatMap((field) =>
    wrong.map(
      (value) =>
        [`echo ${field}=${value}`, request("Echo", `{"c":true,"${field}":${value}}`)] as const,
    ),
  ),
  ["touch minimal", request("Touch", '{"c":true}')],
  ["touch nulls", request("Touch", '{"c":true,"a":null,"d":null,"u":null,"k":null,"s":null}')],
  [
    "touch values",
    request(
      "Touch",
      '{"c":false,"a":1,"b":"x","d":{"x":true},"e":[],"u":{"_tag":"A"},"k":"0","s":"banana"}',
    ),
  ],
  ...[
    "",
    '"size":3',
    '"size":null',
    '"size":1.5',
    '"size":-1',
    '"size":"x"',
    '"size":true',
    '"cursor":2',
    '"cursor":null',
    '"cursor":"NaN"',
    '"cursor":"x"',
    '"size":2,"cursor":"Infinity"',
  ].map((body) => [`page {${body}}`, request("Page", `{${body}}`)] as const),
  ["nulls all null", request("Nulls", '{"s":null,"d":null,"n":null,"a":null}')],
  ["nulls all present", request("Nulls", '{"s":"a","d":{"x":true},"n":"NaN","a":[false]}')],
  ["nulls missing", request("Nulls", '{"s":null,"d":null,"n":null}')],
  ...["s", "d", "n", "a"].flatMap((field) =>
    wrong.map((value) => {
      const others = { s: null, d: null, n: null, a: null, [field]: "VALUE" };
      const body = JSON.stringify(others).replace('"VALUE"', value);
      return [`nulls ${field}=${value}`, request("Nulls", body)] as const;
    }),
  ),
];

const oracle = Effect.gen(function* () {
  const run = <A, E>(effect: Effect.Effect<A, E | { readonly _tag: "CompileError" }>) =>
    effect.pipe(Effect.catchTag("CompileError", Effect.die));
  const handlers = Group.toLayer({
    Echo: (value) => run(Reference.run(echo, [value])),
    Touch: (value) => run(Reference.run(touch, [value])),
    Page: (value) => run(Reference.run(page, [value])),
    Nulls: (value) => run(Reference.run(nulls, [value])),
  });
  const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
    Effect.provide([handlers, RpcSerialization.layerJson]),
  );
  return HttpEffect.toWebHandler(http);
});

test("optional fields outside the admitted profile are refused", async () => {
  const Loose = RpcGroup.make(
    Rpc.make("Only", {
      payload: Schema.Struct({ o: Schema.optional(Schema.Struct({})) }),
      success: Schema.Boolean,
    }),
  );
  const loose = R.fn([R.Struct({ o: R.optional(R.Struct({})) })], R.Bool, () =>
    R.Bool.literal(true),
  );
  const looseError = await Effect.runPromise(
    NativeRpc.compile(Loose, { Only: NativeRpc.bind(loose) }).pipe(Effect.flip),
  );
  expect(looseError.message).toContain("accepts any value");
  const Projected = RpcGroup.make(
    Rpc.make("Only", { payload: { o: Schema.optional(Schema.Boolean) }, success: Schema.Boolean }),
  );
  const projected = R.fn([R.UndefinedOr(R.Bool)], R.Bool, () => R.Bool.literal(true));
  const projectedError = await Effect.runPromise(
    NativeRpc.compile(Projected, { Only: NativeRpc.bind(projected, ["o"]) }).pipe(Effect.flip),
  );
  expect(projectedError.message).toContain("binding the whole Struct");
});

test(
  "native optional fields match the official server",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const official = yield* oracle;
          const officialPost = (body: string) =>
            Effect.promise(async () => {
              const response = await official(
                new Request("http://reffect.test/rpc", { method: "POST", body }),
              );
              return { status: response.status, body: await response.text() };
            });
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-optional-rpc-" });
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
          const url = `http://${address}/rpc`;
          const post = (body: string) =>
            Effect.promise(async () => {
              const response = await fetch(url, { method: "POST", body });
              return { status: response.status, body: await response.text() };
            });
          // Parsed JSON keeps absent keys distinct from null.
          for (const [label, body] of corpus) {
            const native = yield* post(body);
            const reference = yield* officialPost(body);
            expect(native.status, label).toBe(reference.status);
            expect(JSON.parse(native.body), label).toStrictEqual(JSON.parse(reference.body));
          }

          const client = yield* RpcClient.make(Group, { disableTracing: true }).pipe(
            Effect.provide(
              RpcClient.layerProtocolHttp({ url }).pipe(
                Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
              ),
            ),
          );
          const absent = yield* client.Echo({ c: true });
          expect(Object.keys(absent)).toEqual(["c"]);
          const present = yield* client.Echo({ c: true, a: undefined, k: 5n });
          expect(present).toStrictEqual({ a: undefined, c: true, k: 5n });
          expect(yield* client.Touch({ c: true, s: "aa" })).toStrictEqual({
            a: undefined,
            c: false,
            d: undefined,
            u: undefined,
            k: undefined,
            s: "bb",
          });
          expect(yield* client.Page({})).toBe(10.25);
          // A NullOr is null, not undefined, through the native server and the Option round trip.
          expect(yield* client.Nulls({ s: null, d: null, n: null, a: null })).toStrictEqual({
            s: null,
            d: null,
            n: null,
            a: null,
          });
          expect(yield* client.Nulls({ s: "x", d: { x: false }, n: 2, a: [] })).toStrictEqual({
            s: "x!",
            d: { x: false },
            n: 2,
            a: [],
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);
