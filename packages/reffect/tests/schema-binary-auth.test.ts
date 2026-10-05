/**
 * Milestone 10 step 5 (docs/research/schema-binary.md): bearer authentication over SchemaBinary.
 * A denial is the middleware's error in `Rpc.exitSchema`'s failure union, so the native server's
 * answers must equal the official server's bytes with the same middleware, token by token.
 */
import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { SchemaBinary } from "effect/encoding";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, Reference } from "../src/index.ts";
import {
  Authenticated,
  Authentication,
  CurrentPrincipal,
} from "../../../examples/rpc-auth/contract.ts";
import { auth, bindings, publicHandler, whoAmI } from "../../../examples/rpc-auth/handlers.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const credentials = [
  { token: "fixture-alpha-token", principal: "9007199254740993" },
  { token: "fixture-beta-token", principal: "18446744073709551615" },
];

const official = Effect.gen(function* () {
  const authentication = Layer.succeed(Authentication, (effect, metadata) => {
    const header = metadata.headers.authorization;
    const token = header?.slice(0, 7).toLowerCase() === "bearer " ? header.slice(7) : undefined;
    const credential = credentials.find((c) => c.token === token);
    if (!credential) return Effect.fail("Unauthorized");
    return effect.pipe(Effect.provideService(CurrentPrincipal, BigInt(credential.principal)));
  });
  const handlers = Authenticated.toLayer({
    WhoAmI: (payload) =>
      CurrentPrincipal.pipe(
        Effect.flatMap((principal) => Reference.run(whoAmI, [principal, payload.allowed])),
        Effect.catchTag("CompileError", Effect.die),
      ),
    Public: () =>
      Reference.run(publicHandler, []).pipe(Effect.catchTag("CompileError", Effect.die)),
  });
  const http = yield* RpcServer.toHttpEffect(Authenticated, { disableTracing: true }).pipe(
    Effect.provide([handlers, authentication, RpcSerialization.layerSchemaBinary()]),
  );
  return HttpEffect.toWebHandler(http);
});

const binary = Effect.runSync(
  Effect.service(RpcSerialization.RpcSerialization).pipe(
    Effect.provide(RpcSerialization.layerSchemaBinary()),
  ),
);
const body = (
  tag: "WhoAmI" | "Public",
  payload: unknown,
  headers: ReadonlyArray<readonly [string, string]> = [],
  id = 0,
) => {
  const rpc = Authenticated.requests.get(tag);
  if (rpc === undefined) throw new Error(tag);
  return binary.makeUnsafe().encode({
    _tag: "Request",
    id,
    tag,
    payload: Schema.encodeUnknownSync(SchemaBinary.toCodec(rpc.payloadSchema))(payload),
    headers,
  }) as Uint8Array<ArrayBuffer>;
};
const corpus: ReadonlyArray<
  readonly [string, Uint8Array<ArrayBuffer>, Readonly<Record<string, string>>]
> = [
  ["missing", body("WhoAmI", { allowed: true }), {}],
  ["wrong", body("WhoAmI", { allowed: true }), { authorization: "Bearer wrong-secret" }],
  ["transport", body("WhoAmI", { allowed: true }), { authorization: "bEaReR fixture-alpha-token" }],
  [
    "envelope header",
    body("WhoAmI", { allowed: true }, [["authorization", "Bearer fixture-beta-token"]], 7),
    {},
  ],
  [
    "typed failure",
    body("WhoAmI", { allowed: false }),
    { authorization: "Bearer fixture-alpha-token" },
  ],
  ["public", body("Public", undefined, [], 3), {}],
];

test(
  "bearer authentication over SchemaBinary answers as the official middleware does",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reference = yield* official;
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-sb-auth-" });
          const artifact = yield* NativeRpc.compile(Authenticated, bindings, {
            auth,
            serialization: "schema-binary",
          });
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.fetch(directory);
          yield* CargoApi.build(directory, "debug");
          const child = yield* ChildProcess.make(
            `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
            ["--port", "0"],
            { env: { REFFECT_RPC_CREDENTIALS: JSON.stringify(credentials) }, extendEnv: true },
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
          const hex = async (response: Response) =>
            `${response.status} ${Buffer.from(await response.arrayBuffer()).toString("hex")}`;
          for (const [label, bytes, headers] of corpus) {
            const native = yield* Effect.promise(() =>
              fetch(url, { method: "POST", body: bytes, headers }).then(hex),
            );
            const expected = yield* Effect.promise(() =>
              reference(
                new Request("http://reffect.test/rpc", { method: "POST", body: bytes, headers }),
              ).then(hex),
            );
            expect(native, label).toBe(expected);
          }

          // The stock client: the denial is its typed failure.
          const client = (token?: string) =>
            RpcClient.make(Authenticated, { disableTracing: true }).pipe(
              Effect.provide(
                RpcClient.layerProtocolHttp({ url }).pipe(
                  Layer.provide([
                    FetchHttpClient.layer.pipe(
                      Layer.provide(
                        Layer.succeed(FetchHttpClient.Fetch)(((input, init) =>
                          fetch(input, {
                            ...init,
                            headers: {
                              ...Object.fromEntries(new Headers(init?.headers)),
                              ...(token ? { authorization: `Bearer ${token}` } : {}),
                            },
                          })) as typeof fetch),
                      ),
                    ),
                    RpcSerialization.layerSchemaBinary(),
                  ]),
                ),
              ),
            );
          const anonymous = yield* client();
          expect(yield* Effect.flip(anonymous.WhoAmI({ allowed: true }))).toBe("Unauthorized");
          expect(yield* anonymous.Public(undefined)).toBe(0n);
          const alpha = yield* client(credentials[0].token);
          expect(yield* alpha.WhoAmI({ allowed: true })).toBe(BigInt(credentials[0].principal));
          expect(yield* Effect.flip(alpha.WhoAmI({ allowed: false }))).toBe(false);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
