import { Cause, Effect, Exit, FileSystem, Option, Schema, Stream } from "effect";
import { HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { Mutation, Remote, RemoteRpc } from "foldkit-remote";
import { query, source } from "foldkit-remote-drizzle";
import { RemoteServer, RemoteServerError } from "foldkit-remote-server";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  LiveHubHost,
  NativeRemote,
  R,
  Reference,
  RemoteStoreHost,
} from "../src/index.ts";
import type { LiveHubApi, NativeRemoteMutation } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { ByStatus, Project, Search, domainEntities } from "./fixtures/remote-sql-domain.ts";
import { sqlBackends } from "./fixtures/sql-database.ts";
import type { SqlBackend, SqlDatabase } from "./fixtures/sql-database.ts";
import { listen, pause } from "./fixtures/live-stream.ts";
import type { Post } from "./fixtures/live-stream.ts";

// LIVE-003: on SQL, live signals apply after the mutation's transaction commits, re-reading the
// committed row, and a rolled-back mutation signals nothing. The official server runs the same R
// sources in a transaction on its own database and calls upstream's liveHub after commit.
const Rename = Mutation.make("Rename", {
  Input: { id: Schema.String, name: Schema.String },
  Output: {},
});
const RenameThenRefuse = Mutation.make("RenameThenRefuse", {
  Input: { id: Schema.String, name: Schema.String },
  Output: {},
});
const Archive = Mutation.make("Archive", { Input: { id: Schema.String }, Output: {} });
const domain = Remote.define({
  entities: [domainEntities.User, Project],
  queries: [ByStatus, Search],
  mutations: [Rename, RenameThenRefuse, Archive],
});

const Named = R.Struct({ name: R.String });
const empty = R.Struct({});
const rename = NativeRemote.mutation(Rename, ({ input }) => {
  const id = R.Struct.get(input, "id");
  return R.Effect.flatMap(
    R.RemoteStore.write("Project", id, Named.make({ name: R.Struct.get(input, "name") })),
    () =>
      R.Effect.flatMap(R.LiveHub.changed({ entity: "Project", id }, ["name", "status"]), () =>
        R.Effect.succeed(NativeRemote.outcome(Rename).make({ output: empty.make({}) })),
      ),
  );
});
// The signal is sent before the failure, so only rollback keeps it from subscribers.
const renameThenRefuse = NativeRemote.mutation(RenameThenRefuse, ({ input }) => {
  const id = R.Struct.get(input, "id");
  return R.Effect.flatMap(
    R.RemoteStore.write("Project", id, Named.make({ name: R.Struct.get(input, "name") })),
    () =>
      R.Effect.flatMap(R.LiveHub.changed({ entity: "Project", id }, ["name"]), () =>
        R.Effect.fail(
          NativeRemote.ServerError.make({ message: R.String.literal("Refused after signalling") }),
        ),
      ),
  );
});
const archive = NativeRemote.mutation(Archive, ({ input }) => {
  const id = R.Struct.get(input, "id");
  return R.Effect.flatMap(R.RemoteStore.remove("Project", id), () =>
    R.Effect.flatMap(R.LiveHub.deleted({ entity: "Project", id }), () =>
      R.Effect.succeed(NativeRemote.outcome(Archive).make({ output: empty.make({}) })),
    ),
  );
});
const mutations: readonly NativeRemoteMutation[] = [rename, renameThenRefuse, archive];

const message = (tag: string, payload: unknown) =>
  `${JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })}\n`;
const mutate = (mutation: string, input: unknown) =>
  message("FoldkitRemoteMutate", { requestId: "r1", mutation, input });
const subscription = message("FoldkitRemoteLive", {
  version: 4,
  requirements: [
    {
      entity: "Project",
      id: "p01",
      fields: ["name", "status", "owner"],
      relations: { owner: { entity: "User", fields: ["name"] } },
    },
    { entity: "Project", id: "p02", fields: ["name"] },
  ],
  after: 0,
});
const steps = [
  mutate("Rename", { id: "p01", name: "Zephyr" }),
  mutate("RenameThenRefuse", { id: "p02", name: "Lost" }),
  mutate("Archive", { id: "p02" }),
  mutate("Rename", { id: "p01", name: "Again" }),
];

const exercise = async (post: Post) => {
  const listener = listen(post, subscription);
  await pause(300);
  const answers: string[] = [];
  for (const body of steps) {
    answers.push(await (await post(body)).text());
    await pause(200);
  }
  const lines = listener.lines();
  await listener.close();
  return { lines, answers };
};

/** The official server: upstream Drizzle sources, and the R sources in one transaction each. */
const official = (db: SqlDatabase, bindings: SqlBackend["bindings"]) =>
  Effect.gen(function* () {
    const layer = db.layer;
    // Upstream's hub, reading through the official database; set once the server exists.
    let live: LiveHubApi | undefined;
    const run =
      (native: NativeRemoteMutation) =>
      ({ input }: { readonly input: unknown }) =>
        Effect.gen(function* () {
          const transaction = yield* db.begin;
          const signals: Array<Effect.Effect<void, unknown>> = [];
          const pending: LiveHubApi = {
            changed: (ref, fields) =>
              Effect.sync(() => void signals.push(live!.changed(ref, fields))),
            deleted: (ref) => Effect.sync(() => void signals.push(live!.deleted(ref))),
          };
          const exit = yield* Effect.exit(
            Reference.run(native.fn, [input]).pipe(
              Effect.provideService(RemoteStoreHost, transaction.store),
              Effect.provideService(LiveHubHost, pending),
            ),
          );
          if (Exit.isSuccess(exit)) {
            yield* transaction.commit;
            for (const signal of signals) yield* Effect.orDie(signal);
            return { output: {} };
          }
          yield* transaction.rollback;
          const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
          return yield* new RemoteServerError({
            message: Schema.decodeUnknownSync(Schema.Struct({ message: Schema.String }))(error)
              .message,
          });
        });
    const server = RemoteServer.make({
      entities: [source(bindings.User), source(bindings.Project)],
      queries: [
        query(ByStatus, { entity: bindings.Project }),
        query(Search, { entity: bindings.Project }),
      ],
      mutations: [
        RemoteServer.mutation(Rename, run(rename)),
        RemoteServer.mutation(RenameThenRefuse, run(renameThenRefuse)),
        RemoteServer.mutation(Archive, run(archive)),
      ],
    });
    const liveHub = yield* RemoteServer.liveHub([...server.entities.values()]);
    live = {
      changed: (ref, fields) => liveHub.changed(ref, fields).pipe(Effect.provide(layer)),
      deleted: (ref) => liveHub.deleted(ref).pipe(Effect.provide(layer)),
    };
    const handlers = RemoteServer.handlers(server, undefined, { live: liveHub });
    const http = yield* RpcServer.toHttpEffect(RemoteRpc, { disableTracing: true }).pipe(
      Effect.provide([
        RemoteRpc.toLayer({
          FoldkitRemoteRead: (payload) =>
            handlers.FoldkitRemoteRead(payload).pipe(Effect.provide(layer)),
          FoldkitRemoteQuery: (payload) =>
            handlers.FoldkitRemoteQuery(payload).pipe(Effect.provide(layer)),
          FoldkitRemoteMutate: (payload) =>
            handlers.FoldkitRemoteMutate(payload).pipe(Effect.provide(layer)),
          FoldkitRemoteLive: (payload) =>
            handlers.FoldkitRemoteLive(payload).pipe(Stream.provide(layer)),
        }),
        RpcSerialization.layerNdjson,
      ]),
    );
    return HttpEffect.toWebHandler(http);
  });
for (const backend of sqlBackends)
  test.skipIf(backend.unavailable !== undefined)(
    `native ${backend.dialect} live signals apply after commit, as upstream's hub called after commit`,
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const open = yield* backend.databases;
            const reference = yield* official(yield* open("official"), backend.bindings);
            const officialRun = yield* Effect.promise(() =>
              exercise((body, signal) =>
                reference(new Request("http://reffect.test/rpc", { method: "POST", body, signal })),
              ),
            );

            const nativeDb = yield* open("native");
            const fs = yield* FileSystem.FileSystem;
            const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-sql-live-" });
            const artifact = yield* NativeRemote.compile(RemoteRpc, {
              domain,
              sql: {
                dialect: backend.dialect,
                bindings: backend.bindings,
                databaseUrlEnv: "REFFECT_DATABASE_URL",
              },
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
              { env: { REFFECT_DATABASE_URL: nativeDb.url }, extendEnv: true },
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

            expect(nativeRun).toEqual(officialRun);
            const lines = officialRun.lines.join("\n");
            // The committed rename, re-read with an unchanged field; no event for the rollback.
            expect(lines).toContain('"values":{"name":"Zephyr","status":"draft"}');
            expect(lines).not.toContain("Lost");
            expect(officialRun.answers[1]).toContain("Refused after signalling");
            expect(lines).toContain('"_tag":"EntityDeleted","cursor":2,');
            expect(lines).toContain(
              '"cursor":3,"entity":"Project","id":"p01","values":{"name":"Again"',
            );
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    },
    nativeTestBudget(0) + 300000,
  );
