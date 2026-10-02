import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const Group = RpcGroup.make(
  Rpc.make("Echo", { payload: NativeRpc.StringJson, success: NativeRpc.StringJson }),
  Rpc.make("Field", {
    payload: { text: NativeRpc.StringJson, count: NativeRpc.U64Json },
    success: NativeRpc.StringJson,
  }),
  Rpc.make("Check", {
    payload: NativeRpc.StringJson,
    success: Schema.Boolean,
    error: NativeRpc.StringJson,
  }),
  // Plain Schema.String, as Remote's requests declare it (STR-008).
  Rpc.make("Plain", { payload: { text: Schema.String }, success: Schema.String }),
);
const echo = R.fn([R.String], R.String, (text) => text);
const field = R.fn([R.String, R.U64], R.String, (text, count) =>
  R.Match.bool(R.U64.eq(count, R.U64.literal(0n)), text, R.String.replaceAll(text, "<", "&lt;")),
);
const check = R.fn([R.String], R.Bool, R.String, (text) =>
  R.Match.bool(
    R.String.eq(text, R.String.literal("ok")),
    R.Effect.succeed(R.Bool.literal(true)),
    R.Effect.fail(text),
  ),
);
const bindings = {
  Echo: NativeRpc.bind(echo),
  Field: NativeRpc.bind(field, ["text", "count"]),
  Check: NativeRpc.bind(check),
  Plain: NativeRpc.bind(echo, ["text"]),
};

const request = (tag: string, payload: string, id = "1") =>
  `{"_tag":"Request","id":"${id}","tag":"${tag}","payload":${payload},"headers":[]}`;
// Raw JSON bodies, so escapes reach both servers exactly as written.
const agreed: ReadonlyArray<readonly [string, string]> = [
  ["astral, NUL, quote, backslash", request("Echo", String.raw`"a😀\u0000\"\\<"`)],
  ["surrogate pair escape", request("Echo", String.raw`"😀"`)],
  ["nonstring payload", request("Echo", "5")],
  ["missing field", request("Field", String.raw`{"count":"1"}`)],
  ["nonstring field", request("Field", String.raw`{"text":true,"count":"1"}`)],
  ["field success", request("Field", String.raw`{"text":"<b>","count":"2"}`)],
  ["typed success", request("Check", '"ok"')],
  ["typed string failure", request("Check", '"bad 😀"')],
  ["plain string", request("Plain", String.raw`{"text":"a😀\u0000\"<"}`)],
  ["plain nonstring", request("Plain", String.raw`{"text":5}`)],
  ["plain missing", request("Plain", "{}")],
  [
    "batch",
    `[${request("Echo", '"one"', "a")},${request("Check", '"two"', "b")},${request("Echo", "null", "c")}]`,
  ],
];
const loneSurrogate = request("Field", String.raw`{"text":"x\udc00","count":"1"}`);
const plainLoneSurrogate = request("Plain", String.raw`{"text":"x\udc00"}`);

const oracle = Effect.gen(function* () {
  const run = <A, E>(effect: Effect.Effect<A, E | { readonly _tag: "CompileError" }>) =>
    effect.pipe(Effect.catchTag("CompileError", Effect.die));
  const handlers = Group.toLayer({
    Echo: (text) => run(Reference.run(echo, [text])),
    Field: ({ text, count }) => run(Reference.run(field, [text, count])),
    Check: (text) => run(Reference.run(check, [text])),
    Plain: ({ text }) => run(Reference.run(echo, [text])),
  });
  const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
    Effect.provide([handlers, RpcSerialization.layerJson]),
  );
  return HttpEffect.toWebHandler(http);
});

test("plain Schema.String maps onto R.String in payloads and results (STR-008)", async () => {
  const Plain = RpcGroup.make(Rpc.make("Echo", { payload: Schema.String, success: Schema.String }));
  const artifact = await Effect.runPromise(
    NativeRpc.compile(Plain, { Echo: NativeRpc.bind(echo) }),
  );
  expect(artifact.files["src/main.rs"]).toContain("string_arg");
});

test(
  "native string payloads, results and typed errors match the official RPC server",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const official = yield* oracle;
          const post = (url: string, body: string) =>
            Effect.promise(async () => {
              const response = await fetch(url, { method: "POST", body });
              return { status: response.status, body: await response.json() };
            });
          const officialPost = (body: string) =>
            Effect.promise(async () => {
              const response = await official(
                new Request("http://reffect.test/rpc", { method: "POST", body }),
              );
              return { status: response.status, body: await response.json() };
            });

          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-string-rpc-" });
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

          for (const [label, body] of agreed)
            expect(yield* post(url, body), label).toEqual(yield* officialPost(body));

          // Documented divergence (STR-006): both refuse without invoking the handler, but the
          // official server reports a per-request decode defect while serde_json refuses the body.
          expect(yield* officialPost(loneSurrogate)).toEqual({
            status: 200,
            body: [
              {
                _tag: "Exit",
                requestId: "1",
                exit: {
                  _tag: "Failure",
                  cause: [
                    {
                      _tag: "Die",
                      defect: 'Expected well-formed Unicode without lone surrogates\n  at ["text"]',
                    },
                  ],
                },
              },
            ],
          });
          expect(yield* post(url, loneSurrogate)).toEqual({
            status: 200,
            body: [{ _tag: "Defect", defect: { name: "SyntaxError", message: "Invalid JSON" } }],
          });
          // STR-008: plain Schema.String decodes a lone surrogate officially, so the request reaches
          // its handler (here the R reference refuses the input), while the native body is refused.
          const officialPlain = yield* officialPost(plainLoneSurrogate);
          expect(officialPlain.body).toEqual([
            {
              _tag: "Defect",
              defect: {
                name: "CompileError",
                message: "Expected well-formed Unicode without lone surrogates",
              },
            },
          ]);
          expect(yield* post(url, plainLoneSurrogate)).toEqual({
            status: 200,
            body: [{ _tag: "Defect", defect: { name: "SyntaxError", message: "Invalid JSON" } }],
          });

          const client = yield* RpcClient.make(Group, { disableTracing: true }).pipe(
            Effect.provide(
              RpcClient.layerProtocolHttp({ url }).pipe(
                Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
              ),
            ),
          );
          const text = "x😀\u0000é\r\n<";
          expect(yield* client.Echo(text)).toBe(text);
          expect(yield* client.Field({ text, count: 1n })).toBe("x😀\u0000é\r\n&lt;");
          expect(yield* client.Check("nope").pipe(Effect.flip)).toBe("nope");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 120000,
);
