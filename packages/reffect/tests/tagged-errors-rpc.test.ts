import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// Error classes shaped like foldkit-remote's RemoteReadError and RemoteProtocolError.
class ReadError extends Schema.TaggedError<ReadError>()("ReadError", { message: Schema.String }) {}
class ProtocolError extends Schema.TaggedError<ProtocolError>()("ProtocolError", {
  message: Schema.String,
  expected: Schema.Number,
  received: Schema.Number,
}) {}
const ReadErrors = Schema.Union([ReadError, ProtocolError]);
const Group = RpcGroup.make(
  Rpc.make("Read", { payload: Schema.Number, success: Schema.Number, error: ReadErrors }),
  Rpc.make("One", { payload: Schema.Boolean, success: Schema.String, error: ReadError }),
);

const Errors = R.TaggedUnion({
  ReadError: { message: R.String },
  ProtocolError: { message: R.String, expected: R.Number, received: R.Number },
});
const OneError = R.TaggedUnion({ ReadError: { message: R.String } });
const read = R.fn([R.Number], R.Number, Errors, (x) =>
  R.Match.bool(
    R.Number.lt(x, R.Number.literal(0)),
    R.Effect.fail(Errors.cases.ReadError.make({ message: R.String.literal("négatif — ünïcode") })),
    R.Match.bool(
      R.Number.lt(x, R.Number.literal(1)),
      R.Effect.fail(
        Errors.cases.ProtocolError.make({
          message: R.String.literal("version"),
          expected: x,
          received: R.Number.add(x, R.Number.literal(Infinity)),
        }),
      ),
      R.Effect.succeed(x),
    ),
  ),
);
const one = R.fn([R.Bool], R.String, OneError, (ok) =>
  R.Match.bool(
    ok,
    R.Effect.succeed(R.String.literal("ok")),
    R.Effect.fail(OneError.cases.ReadError.make({ message: R.String.literal("no") })),
  ),
);
const bindings = { Read: NativeRpc.bind(read), One: NativeRpc.bind(one) };

const request = (tag: string, payload: string) =>
  `{"_tag":"Request","id":"1","tag":"${tag}","payload":${payload},"headers":[]}`;
const corpus: ReadonlyArray<readonly [string, string]> = [
  ["read error", request("Read", "-2")],
  ["protocol error", request("Read", "0.5")],
  ["protocol error -0", request("Read", "-0")],
  ["success", request("Read", "3")],
  ["bad payload", request("Read", "true")],
  ["one ok", request("One", "true")],
  ["one error", request("One", "false")],
];

const oracle = Effect.gen(function* () {
  // The JS boundary builds class instances from the R data (TE-002).
  const run = <A, E, S extends Schema.Codec<any, any>>(
    effect: Effect.Effect<A, E | { readonly _tag: "CompileError" }>,
    error: S,
  ): Effect.Effect<A, S["Type"]> =>
    effect.pipe(
      Effect.catchTag("CompileError", Effect.die),
      Effect.mapError((value) => Schema.decodeUnknownSync(error)(value)),
    );
  const handlers = Group.toLayer({
    Read: (x) => run(Reference.run(read, [x]), ReadErrors),
    One: (ok) => run(Reference.run(one, [ok]), ReadError),
  });
  const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
    Effect.provide([handlers, RpcSerialization.layerJson]),
  );
  return HttpEffect.toWebHandler(http);
});

test("TaggedError classes are refused where they would be decoded", async () => {
  const Payload = RpcGroup.make(Rpc.make("Only", { payload: ReadError, success: Schema.Boolean }));
  const handler = R.fn([OneError], R.Bool, () => R.Bool.literal(true));
  const error = await Effect.runPromise(
    NativeRpc.compile(Payload, { Only: NativeRpc.bind(handler) }).pipe(Effect.flip),
  );
  expect(error.message).toContain("success and error schemas only");
  class Plain extends Schema.Class<Plain>("Plain")({ message: Schema.String }) {}
  const Untagged = RpcGroup.make(
    Rpc.make("Only", { payload: Schema.Boolean, success: Schema.Boolean, error: Plain }),
  );
  const untagged = await Effect.runPromise(
    NativeRpc.compile(Untagged, {
      Only: NativeRpc.bind(
        R.fn([R.Bool], R.Bool, OneError, () => R.Effect.succeed(R.Bool.literal(true))),
      ),
    }).pipe(Effect.flip),
  );
  expect(untagged.message).toMatch(/tagged|_tag/);
});

test(
  "native TaggedError failures match the official server",
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
          const parent = yield* fs.makeTempDirectoryScoped({
            prefix: "reffect-tagged-errors-rpc-",
          });
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
          for (const [label, body] of corpus) {
            const native = yield* Effect.promise(async () => {
              const response = await fetch(url, { method: "POST", body });
              return { status: response.status, body: await response.text() };
            });
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
          const readError = yield* Effect.flip(client.Read(-1));
          expect(readError).toBeInstanceOf(ReadError);
          expect(readError.message).toBe("négatif — ünïcode");
          const protocol = yield* Effect.flip(client.Read(0.25));
          expect(protocol).toBeInstanceOf(ProtocolError);
          expect(protocol).toMatchObject({ expected: 0.25, received: Infinity });
          expect(yield* client.One(true)).toBe("ok");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);
