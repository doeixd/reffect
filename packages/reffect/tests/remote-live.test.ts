import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { Entity } from "foldkit-entity";
import { Mutation, Remote, RemoteRpc } from "foldkit-remote";
import { RemoteServer } from "foldkit-remote-server";
import type { LiveHub, MemoryStore } from "foldkit-remote-server";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  CompileError,
  LiveHubHost,
  NativeRemote,
  R,
  Reference,
  RemoteStoreHost,
  memoryStoreApi,
} from "../src/index.ts";
import type { NativeRemoteMutation } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// LIVE-001..004: R mutations signal upstream's own liveHub in the reference and the native hub
// port natively; live subscriptions on both servers receive the same Chunk lines.
const Rename = Mutation.make("Rename", {
  Input: { id: Schema.String, name: Schema.String },
  Output: {},
});
const Signal = Mutation.make("Signal", {
  Input: { id: Schema.String, fields: Schema.Array(Schema.String) },
  Output: {},
});
const Drop = Mutation.make("Drop", { Input: { id: Schema.String }, Output: {} });
const domain = Remote.define({
  entities: ["User", "Project"].map((name) =>
    Entity.define(name, Schema.Struct({ id: Schema.String })),
  ),
  mutations: [Rename, Signal, Drop],
});
const rows = {
  User: [
    { id: "u1", name: "Ada" },
    { id: "u2", name: "Grace" },
    { id: "u3", name: "Edsger" },
  ],
  Project: [
    {
      id: "p1",
      name: "Borealis",
      status: "active",
      rank: 2,
      members: ["User:u1", "User:u2", "User:u3"],
    },
    { id: "p2", name: "Apollo", status: "active", rank: 9, members: [] },
  ],
};

const rename = NativeRemote.mutation(Rename, ({ input }) => {
  const id = R.Struct.get(input, "id");
  const values = R.Struct({ name: R.String }).make({ name: R.Struct.get(input, "name") });
  return R.Effect.flatMap(R.RemoteStore.write("Project", id, values), () =>
    R.Effect.flatMap(R.LiveHub.changed({ entity: "Project", id }, ["name"]), () =>
      R.Effect.succeed(NativeRemote.outcome(Rename).make({ output: R.Struct({}).make({}) })),
    ),
  );
});
const signal = NativeRemote.mutation(Signal, ({ input }) =>
  R.Effect.flatMap(
    R.LiveHub.changed(
      { entity: "Project", id: R.Struct.get(input, "id") },
      R.Struct.get(input, "fields"),
    ),
    () => R.Effect.succeed(NativeRemote.outcome(Signal).make({ output: R.Struct({}).make({}) })),
  ),
);
const drop = NativeRemote.mutation(Drop, ({ input }) => {
  const id = R.Struct.get(input, "id");
  return R.Effect.flatMap(R.RemoteStore.remove("Project", id), () =>
    R.Effect.flatMap(R.LiveHub.deleted({ entity: "Project", id }), () =>
      R.Effect.succeed(NativeRemote.outcome(Drop).make({ output: R.Struct({}).make({}) })),
    ),
  );
});
const mutations: readonly NativeRemoteMutation[] = [rename, signal, drop];

const message = (tag: string, payload: unknown) =>
  `${JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })}\n`;
const mutate = (mutation: string, input: unknown) =>
  message("FoldkitRemoteMutate", { requestId: "r1", mutation, input });
const live = (requirements: unknown, after: number, version = 4) =>
  message("FoldkitRemoteLive", { version, requirements, after });
const subscriptionA = live(
  [
    { entity: "Project", id: "p1", fields: ["name", "status"] },
    { entity: "Project", id: "p2", fields: ["name"] },
  ],
  0,
);
// Windowed aliases of one field, plus a second requirement for the same row.
const subscriptionB = live(
  [
    {
      entity: "Project",
      id: "p1",
      fields: ["rank", "members@a", "members@b"],
      windows: { "members@a": { first: 1 }, "members@b": { last: 1 } },
    },
    { entity: "Project", id: "p1", fields: ["name"] },
  ],
  10,
);
const steps: ReadonlyArray<readonly [string, string]> = [
  ["rename", mutate("Rename", { id: "p1", name: "Zephyr" })],
  [
    "plain and aliased fields",
    mutate("Signal", { id: "p1", fields: ["rank", "members", "status"] }),
  ],
  ["a missing field", mutate("Signal", { id: "p2", fields: ["name", "nope"] })],
  ["unselected fields", mutate("Signal", { id: "p1", fields: ["owner"] })],
  ["drop", mutate("Drop", { id: "p2" })],
  ["a removed row", mutate("Signal", { id: "p2", fields: ["name"] })],
];
const once: ReadonlyArray<readonly [string, string]> = [
  ["protocol mismatch", live([], 0, 3)],
  [
    "too many ids",
    live(
      Array.from({ length: 1001 }, (_, i) => ({
        entity: "Project",
        id: `x${i}`,
        fields: ["name"],
      })),
      0,
    ),
  ],
];

type Post = (body: string, signal?: AbortSignal) => Promise<Response>;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Collects a streaming response's lines as they arrive. The official web handler answers with
 * the first chunk, so the response is not awaited before the scenario goes on.
 */
const listen = (post: Post, body: string) => {
  const abort = new AbortController();
  const decoder = new TextDecoder();
  let text = "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const reading = (async () => {
    try {
      reader = (await post(body, abort.signal)).body!.getReader();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
        text += decoder.decode(chunk.value, { stream: true });
    } catch {
      // Aborted.
    }
  })();
  return {
    lines: () => text.split("\n").filter((line) => line.length > 0),
    // Cancelling the body is the disconnect the official handler observes (STREAM-003).
    close: async () => {
      await reader?.cancel();
      abort.abort();
      await reading;
    },
  };
};
/** What one server answers: each subscription's lines and every mutation's response. */
const exercise = async (post: Post) => {
  const a = listen(post, subscriptionA);
  const b = listen(post, subscriptionB);
  await pause(300);
  const answers: string[] = [];
  for (const [, body] of steps) {
    answers.push(await (await post(body)).text());
    await pause(150);
  }
  const aLines = a.lines();
  await a.close();
  await pause(300);
  // A disconnected subscriber is gone; the remaining one still receives changes.
  answers.push(await (await post(mutate("Rename", { id: "p1", name: "Again" }))).text());
  await pause(300);
  const bLines = b.lines();
  await b.close();
  for (const [, body] of once) answers.push(await (await post(body)).text());
  return { aLines, bLines, answers };
};

const official = Effect.gen(function* () {
  let hub: LiveHub<undefined> | undefined;
  const run =
    (store: MemoryStore, native: NativeRemoteMutation) =>
    ({ input }: { readonly input: unknown }) =>
      Reference.run(native.fn, [input]).pipe(
        Effect.provideService(RemoteStoreHost, memoryStoreApi(store)),
        Effect.provideService(LiveHubHost, {
          changed: (ref, fields) => hub!.changed(ref, fields),
          deleted: (ref) => hub!.deleted(ref),
        }),
        Effect.catch((error) => Effect.die(error)),
        Effect.as({ output: {} }),
      );
  const server = RemoteServer.memory({
    domain,
    rows,
    mutations: (store) => [
      RemoteServer.mutation(Rename, run(store, rename)),
      RemoteServer.mutation(Signal, run(store, signal)),
      RemoteServer.mutation(Drop, run(store, drop)),
    ],
  }).server;
  const liveHub = yield* RemoteServer.liveHub([...server.entities.values()]);
  hub = liveHub;
  const handlers = RemoteServer.handlers(server, undefined, { live: liveHub });
  const http = yield* RpcServer.toHttpEffect(RemoteRpc, { disableTracing: true }).pipe(
    Effect.provide([RemoteRpc.toLayer(handlers), RpcSerialization.layerNdjson]),
  );
  const handler = HttpEffect.toWebHandler(http);
  return { handler, size: liveHub.size };
});

test("LiveHub signals need a live hub", async () => {
  const error = await Effect.runPromise(
    NativeRemote.compile(RemoteRpc, { domain, rows, mutations }).pipe(Effect.flip),
  );
  expect(error).toBeInstanceOf(CompileError);
  expect(error.message).toContain("live: true");
});

test(
  "native live subscriptions receive the changes upstream's liveHub sends",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reference = yield* official;
          const officialRun = yield* Effect.promise(() =>
            exercise((body, signal) =>
              reference.handler(
                new Request("http://reffect.test/rpc", { method: "POST", body, signal }),
              ),
            ),
          );
          // Every subscriber left the official hub when its client went away.
          expect(yield* reference.size).toBe(0);

          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-remote-live-" });
          const artifact = yield* NativeRemote.compile(RemoteRpc, {
            domain,
            rows,
            mutations,
            live: true,
            serialization: "ndjson",
          });
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
          const nativeRun = yield* Effect.promise(() =>
            exercise((body, signal) =>
              fetch(`http://${address}/rpc`, { method: "POST", body, signal }),
            ),
          );

          expect(nativeRun.aLines).toEqual(officialRun.aLines);
          expect(nativeRun.bLines).toEqual(officialRun.bLines);
          expect(nativeRun.answers).toEqual(officialRun.answers);
          // The compared streams carry what the scenario is about.
          const a = officialRun.aLines.join("\n");
          const b = officialRun.bLines.join("\n");
          expect(a).toContain('"cursor":1,"entity":"Project","id":"p1","values":{"name":"Zephyr"}');
          expect(a).toContain('"_tag":"EntityDeleted","cursor":');
          expect(b).toContain('"cursor":11,');
          expect(b).toContain('"members@a"');
          expect(b).toContain('"members@b"');
          expect(b).toContain('"Again"');
          expect(a).not.toContain('"Again"');
          expect(officialRun.answers.at(-2)).toContain("RemoteProtocolError");
          expect(officialRun.answers.at(-1)).toContain('Too many \\"Project\\" ids');
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 180000,
);
