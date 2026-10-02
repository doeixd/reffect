import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// Remote's connection position, declared as foldkit-remote's wire module does.
const WirePosition = Schema.Union([Schema.Literal("prepend"), Schema.Literal("append")]);
const Group = RpcGroup.make(
  Rpc.make("Echo", { payload: WirePosition, success: WirePosition }),
  Rpc.make("Change", {
    payload: Schema.Struct({ p: WirePosition, q: Schema.optional(WirePosition) }),
    success: WirePosition,
  }),
  Rpc.make("Flip", { payload: Schema.Boolean, success: Schema.Literals(["prepend", "append"]) }),
  Rpc.make("Only", { payload: Schema.Literal("only"), success: Schema.Boolean }),
);

const Position = R.Literals(["prepend", "append"]);
const Change = R.Struct({ p: Position, q: R.optional(Position) });
const echo = R.fn([Position], Position, (position) => position);
const change = R.fn([Change], Position, (value) =>
  R.UndefinedOr.match(R.Struct.get(value, "q"), {
    onUndefined: () => R.Struct.get(value, "p"),
    onDefined: (q) => q,
  }),
);
const flip = R.fn([R.Bool], Position, (b) =>
  R.Match.bool(b, Position.literal("prepend"), Position.literal("append")),
);
const only = R.fn([R.Literals(["only"])], R.Bool, () => R.Bool.literal(true));
const bindings = {
  Echo: NativeRpc.bind(echo),
  Change: NativeRpc.bind(change),
  Flip: NativeRpc.bind(flip),
  Only: NativeRpc.bind(only),
};

const request = (tag: string, payload: string) =>
  `{"_tag":"Request","id":"1","tag":"${tag}","payload":${payload},"headers":[]}`;
const wrong = ['"prepend"', '"append"', '"Prepend"', '""', "1", "null", "true", "[]", "{}"];
const corpus: ReadonlyArray<readonly [string, string]> = [
  ...wrong.map((value) => [`echo ${value}`, request("Echo", value)] as const),
  ...wrong.map((value) => [`change p=${value}`, request("Change", `{"p":${value}}`)] as const),
  ...wrong.map(
    (value) => [`change q=${value}`, request("Change", `{"p":"prepend","q":${value}}`)] as const,
  ),
  ["flip true", request("Flip", "true")],
  ["flip false", request("Flip", "false")],
  ...['"only"', '"other"', "1"].map((value) => [`only ${value}`, request("Only", value)] as const),
];

const oracle = Effect.gen(function* () {
  const run = <A, E>(effect: Effect.Effect<A, E | { readonly _tag: "CompileError" }>) =>
    effect.pipe(Effect.catchTag("CompileError", Effect.die));
  const handlers = Group.toLayer({
    Echo: (value) => run(Reference.run(echo, [value])),
    Change: (value) => run(Reference.run(change, [value])),
    Flip: (value) => run(Reference.run(flip, [value])),
    Only: (value) => run(Reference.run(only, [value])),
  });
  const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
    Effect.provide([handlers, RpcSerialization.layerJson]),
  );
  return HttpEffect.toWebHandler(http);
});

test("literal unions intern and refuse non-string literals", async () => {
  expect(R.Literals(["prepend", "append"])).toBe(Position);
  expect(Effect.runSync(Reference.run(flip, [true]))).toBe("prepend");
  const Numeric = RpcGroup.make(
    Rpc.make("Only", { payload: Schema.Literals([1, 2]), success: Schema.Boolean }),
  );
  const error = await Effect.runPromise(
    NativeRpc.compile(Numeric, { Only: NativeRpc.bind(only) }).pipe(Effect.flip),
  );
  expect(error.message).toContain("Only tagged Struct or TaggedError union members");
});

test(
  "native literal unions match the official server",
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
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-literals-rpc-" });
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
          for (const [label, body] of corpus) {
            const native = yield* Effect.promise(async () => {
              const response = await fetch(`http://${address}/rpc`, { method: "POST", body });
              return { status: response.status, body: await response.text() };
            });
            const reference = yield* officialPost(body);
            expect(native.status, label).toBe(reference.status);
            expect(JSON.parse(native.body), label).toStrictEqual(JSON.parse(reference.body));
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);
