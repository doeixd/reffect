import { Cause, Effect, Exit, FileSystem, Layer, Option, Schema, Stream } from "effect";
import type { Duration } from "effect";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import {
  ConnectionChangeSchema,
  Mutation,
  NormalizedEntity,
  Remote,
  RemoteRpc,
} from "foldkit-remote";
import type { RemoteRpcClient } from "foldkit-remote";
import { Entity } from "foldkit-entity";
import { defineMessageUnion } from "foldkit/message";
import { Surface } from "foldkit-surface";
import { query, source } from "foldkit-remote-drizzle";
import { RemoteServer, RemoteServerError } from "foldkit-remote-server";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  CompileError,
  NativeRemote,
  R,
  Reference,
  RemoteStoreHost,
} from "../src/index.ts";
import type { NativeRemoteMutation, RemoteStoreApi } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { successValue } from "./raw-json.ts";
import { ByStatus, Project, Search, domain, domainEntities } from "./fixtures/remote-sql-domain.ts";
import { sqlBackends } from "./fixtures/sql-database.ts";
import type { SqlBackend, SqlDatabase } from "./fixtures/sql-database.ts";

const { User } = domainEntities;

// Milestone 5 steps 4 and 5 (SQLX-006, SQLX-012): R mutation sources in one transaction per
// mutation on SQLite and Postgres, against the same sources run by the reference over SQL writes
// in a transaction on the official server's own database.
const Group = RemoteRpc.omit("FoldkitRemoteLive");

const Rename = Mutation.make("Rename", {
  Input: { id: Schema.String, name: Schema.String },
  Output: { id: Schema.String },
});
const Create = Mutation.make("Create", {
  Input: {
    id: Schema.String,
    name: Schema.String,
    status: Schema.String,
    rank: Schema.Finite,
    done: Schema.Boolean,
    owner: Schema.String,
  },
  Output: { id: Schema.String },
});
const Archive = Mutation.make("Archive", { Input: { id: Schema.String }, Output: {} });
const Broken = Mutation.make("Broken", {
  Input: { id: Schema.String, name: Schema.String },
  Output: {},
});
const RenameThenRefuse = Mutation.make("RenameThenRefuse", {
  Input: { id: Schema.String, name: Schema.String },
  Output: {},
});
// Read-modify-write (RS-007): the stored rank, read in the mutation's transaction, plus one.
const Bump = Mutation.make("Bump", { Input: { id: Schema.String }, Output: {} });
// The same with a pause between the read and the write, so two can overlap.
const SlowBump = Mutation.make("SlowBump", { Input: { id: Schema.String }, Output: {} });
const RenameThenBreak = Mutation.make("RenameThenBreak", {
  Input: { id: Schema.String, name: Schema.String, fresh: Schema.String },
  Output: {},
});

const text = (value: string) => R.literal(R.String, value);
const Named = R.Struct({ name: R.String });
const Created = R.Struct({
  name: R.String,
  status: R.String,
  rank: R.Number,
  done: R.Bool,
  owner: R.String,
});
const empty = R.Struct({});
const rename = NativeRemote.mutation(Rename, ({ input }) => {
  const id = R.Struct.get(input, "id");
  const values = Named.make({ name: R.Struct.get(input, "name") });
  return R.Effect.flatMap(R.RemoteStore.write("Project", id, values), () =>
    R.Effect.succeed(
      NativeRemote.outcome(Rename).make({
        output: R.Struct({ id: R.String }).make({ id }),
        entities: R.Array.make(NativeRemote.patch(Project, id, values)),
      }),
    ),
  );
});
const create = NativeRemote.mutation(Create, ({ input }) => {
  const id = R.Struct.get(input, "id");
  const values = Created.make({
    name: R.Struct.get(input, "name"),
    status: R.Struct.get(input, "status"),
    rank: R.Struct.get(input, "rank"),
    done: R.Struct.get(input, "done"),
    owner: R.Struct.get(input, "owner"),
  });
  return R.Effect.flatMap(R.RemoteStore.write("Project", id, values), () =>
    R.Effect.succeed(
      NativeRemote.outcome(Create).make({
        output: R.Struct({ id: R.String }).make({ id }),
        entities: R.Array.make(NativeRemote.patch(Project, id, values)),
      }),
    ),
  );
});
const archive = NativeRemote.mutation(Archive, ({ input }) => {
  const id = R.Struct.get(input, "id");
  return R.Effect.flatMap(R.RemoteStore.remove("Project", id), () =>
    R.Effect.succeed(
      NativeRemote.outcome(Archive).make({
        output: empty.make({}),
        deleted: R.Array.make(NativeRemote.Ref.make({ entity: text("Project"), id })),
      }),
    ),
  );
});
// A new row with only a name violates NOT NULL: the store fails and nothing is kept.
const broken = NativeRemote.mutation(Broken, ({ input }) =>
  R.Effect.flatMap(
    R.RemoteStore.write(
      "Project",
      R.Struct.get(input, "id"),
      Named.make({ name: R.Struct.get(input, "name") }),
    ),
    () => R.Effect.succeed(NativeRemote.outcome(Broken).make({ output: empty.make({}) })),
  ),
);
// A typed failure after a write rolls the write back.
const renameThenRefuse = NativeRemote.mutation(RenameThenRefuse, ({ input }) =>
  R.Effect.flatMap(
    R.RemoteStore.write(
      "Project",
      R.Struct.get(input, "id"),
      Named.make({ name: R.Struct.get(input, "name") }),
    ),
    () => R.Effect.fail(NativeRemote.ServerError.make({ message: text("Refused after writing") })),
  ),
);
// A store failure after a successful write rolls both back.
const renameThenBreak = NativeRemote.mutation(RenameThenBreak, ({ input }) =>
  R.Effect.flatMap(
    R.RemoteStore.write(
      "Project",
      R.Struct.get(input, "id"),
      Named.make({ name: R.Struct.get(input, "name") }),
    ),
    () =>
      R.Effect.flatMap(
        R.RemoteStore.write(
          "Project",
          R.Struct.get(input, "fresh"),
          Named.make({ name: R.Struct.get(input, "name") }),
        ),
        () =>
          R.Effect.succeed(NativeRemote.outcome(RenameThenBreak).make({ output: empty.make({}) })),
      ),
  ),
);
const Ranked = R.Struct({ rank: R.Number });
const bumpBy = (descriptor: typeof Bump | typeof SlowBump, pause: Duration.Input) =>
  NativeRemote.mutation(descriptor, ({ input }) => {
    const id = R.Struct.get(input, "id");
    return R.Effect.flatMap(R.RemoteStore.get("Project", id), (row) =>
      R.Option(Ranked).match(
        R.Option.flatMap(row, R.Schema.decodeUnknownOption(R.Schema.toCodecJson(Ranked))),
        {
          None: () =>
            R.Effect.fail(NativeRemote.ServerError.make({ message: text("No numeric rank") })),
          Some: (found) => {
            const stored = R.Struct.get(found, "value");
            const values = Ranked.make({
              rank: R.Number.add(R.Struct.get(stored, "rank"), R.Number.literal(1)),
            });
            return R.Effect.flatMap(R.Effect.sleep(pause), () =>
              R.Effect.flatMap(R.RemoteStore.write("Project", id, values), () =>
                R.Effect.succeed(
                  NativeRemote.outcome(descriptor).make({
                    output: empty.make({}),
                    entities: R.Array.make(NativeRemote.patch(Project, id, values)),
                  }),
                ),
              ),
            );
          },
        },
      ),
    );
  });
const bump = bumpBy(Bump, 0);
const slowBump = bumpBy(SlowBump, 400);
const mutations: ReadonlyArray<NativeRemoteMutation> = [
  bump,
  slowBump,
  rename,
  create,
  archive,
  broken,
  renameThenRefuse,
  renameThenBreak,
];
// The encoded outcome a source returns, read with upstream's own wire schemas.
const Outcome = Schema.Struct({
  output: Schema.Unknown,
  entities: Schema.optionalKey(Schema.Array(NormalizedEntity)),
  connections: Schema.optionalKey(Schema.Array(ConnectionChangeSchema)),
  deleted: Schema.optionalKey(
    Schema.Array(Schema.Struct({ entity: Schema.String, id: Schema.String })),
  ),
});

const envelope = (tag: string, payload: unknown) =>
  JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] });
const mutate = (mutation: string, input: unknown) =>
  envelope("FoldkitRemoteMutate", { requestId: "r", mutation, input });
const read = (id: string) =>
  envelope("FoldkitRemoteRead", {
    version: 4,
    requests: [
      {
        entity: "Project",
        id,
        fields: ["name", "status", "rank", "done", "owner"],
        relations: { owner: { entity: "User", fields: ["name"] } },
      },
    ],
  });
const drafts = envelope("FoldkitRemoteQuery", {
  query: "ByStatus",
  input: { status: "draft" },
  window: {},
});
// Stateful: both servers see the same sequence.
const corpus: ReadonlyArray<readonly [string, string]> = [
  ["read before", read("p01")],
  ["rename", mutate("Rename", { id: "p01", name: "Zephyr" })],
  ["read after rename", read("p01")],
  [
    "create",
    mutate("Create", {
      id: "p90",
      name: "Aurora",
      status: "draft",
      rank: 7,
      done: true,
      owner: "User:u3",
    }),
  ],
  ["read created", read("p90")],
  ["drafts after create", drafts],
  ["archive", mutate("Archive", { id: "p03" })],
  ["read archived", read("p03")],
  ["drafts after archive", drafts],
  ["archive an absent row", mutate("Archive", { id: "zz" })],
  ["a store failure", mutate("Broken", { id: "p91", name: "Nameless" })],
  ["read after the store failure", read("p91")],
  ["a typed failure after a write", mutate("RenameThenRefuse", { id: "p05", name: "Lost" })],
  ["read after the typed failure", read("p05")],
  [
    "a store failure after a write",
    mutate("RenameThenBreak", { id: "p07", name: "Gone", fresh: "p92" }),
  ],
  ["read after the second failure", read("p07")],
  ["bump", mutate("Bump", { id: "p01" })],
  ["bump again, reading the first bump", mutate("Bump", { id: "p01" })],
  ["read bumped", read("p01")],
  ["bump an absent row", mutate("Bump", { id: "zz" })],
  [
    "invalid input",
    mutate("Create", {
      id: "p93",
      name: "x",
      status: "draft",
      rank: "1",
      done: true,
      owner: "User:u1",
    }),
  ],
];

/** The official server: upstream Drizzle sources, and the same R sources over its own database. */
const officialServer = (db: SqlDatabase, bindings: SqlBackend["bindings"]) => {
  // One transaction per mutation; a store failure answers as upstream's Drizzle helpers do.
  const run =
    (native: NativeRemoteMutation) =>
    ({ input }: { readonly input: unknown }) =>
      Effect.gen(function* () {
        const transaction = yield* db.begin;
        let failed = false;
        const guard = (done: void | Effect.Effect<void>) =>
          (Effect.isEffect(done) ? done : Effect.void).pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                failed = true;
              }),
            ),
          );
        const guarded: RemoteStoreApi = {
          get: (entity, id) =>
            Effect.suspend(() => {
              const row = transaction.store.get(entity, id);
              return Effect.isEffect(row) ? row : Effect.succeed(row);
            }),
          write: (entity, id, values) =>
            Effect.suspend(() => guard(transaction.store.write(entity, id, values))),
          remove: (entity, id) => Effect.suspend(() => guard(transaction.store.remove(entity, id))),
        };
        const exit = yield* Effect.exit(
          Reference.run(native.fn, [input]).pipe(Effect.provideService(RemoteStoreHost, guarded)),
        );
        if (Exit.isSuccess(exit)) {
          yield* transaction.commit;
          return Schema.decodeUnknownSync(Outcome)(exit.value);
        }
        yield* transaction.rollback;
        if (failed) return yield* new RemoteServerError({ message: "Database query failed" });
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        if (error === undefined || error instanceof CompileError)
          return yield* Effect.die(exit.cause);
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
      RemoteServer.mutation(Create, run(create)),
      RemoteServer.mutation(Archive, run(archive)),
      RemoteServer.mutation(Broken, run(broken)),
      RemoteServer.mutation(RenameThenRefuse, run(renameThenRefuse)),
      RemoteServer.mutation(RenameThenBreak, run(renameThenBreak)),
      RemoteServer.mutation(Bump, run(bump)),
      RemoteServer.mutation(SlowBump, run(slowBump)),
    ],
  });
  return server;
};
const oracle = (db: SqlDatabase, bindings: SqlBackend["bindings"]) =>
  Effect.gen(function* () {
    const layer = db.layer;
    const handlers = RemoteServer.handlers(officialServer(db, bindings), undefined);
    const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
      Effect.provide([
        Group.toLayer({
          FoldkitRemoteRead: (payload) =>
            handlers.FoldkitRemoteRead(payload).pipe(Effect.provide(layer)),
          FoldkitRemoteQuery: (payload) =>
            handlers.FoldkitRemoteQuery(payload).pipe(Effect.provide(layer)),
          FoldkitRemoteMutate: (payload) =>
            handlers.FoldkitRemoteMutate(payload).pipe(Effect.provide(layer)),
        }),
        RpcSerialization.layerJson,
      ]),
    );
    return HttpEffect.toWebHandler(http);
  });

/** The native SQL server over `db`, compiled for the backend's dialect; its address. */
const startNative = (backend: SqlBackend, db: SqlDatabase, parent: string) =>
  Effect.gen(function* () {
    const artifact = yield* NativeRemote.compile(Group, {
      domain,
      sql: {
        dialect: backend.dialect,
        bindings: backend.bindings,
        databaseUrlEnv: "REFFECT_DATABASE_URL",
      },
      mutations,
    });
    const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
    yield* CargoApi.fetch(directory);
    yield* CargoApi.build(directory, "debug");
    const child = yield* ChildProcess.make(
      `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
      ["--port", "0"],
      { env: { REFFECT_DATABASE_URL: db.url }, extendEnv: true },
    );
    yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
    const ready = yield* Stream.runHead(Stream.splitLines(Stream.decodeText(child.stdout))).pipe(
      Effect.timeout("10 seconds"),
    );
    if (!Option.isSome(ready)) throw new Error("Missing ready record");
    return Schema.decodeUnknownSync(
      Schema.Struct({ schema: Schema.Literal("reffect.rpc.ready@1"), address: Schema.String }),
    )(JSON.parse(ready.value)).address;
  });

for (const backend of sqlBackends)
  test.skipIf(backend.unavailable !== undefined)(
    `native ${backend.dialect} mutations match the same sources on the official server, one transaction each`,
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const parent = yield* fs.makeTempDirectoryScoped({
              prefix: "reffect-remote-sql-mutate-",
            });
            // Separate databases: each server mutates its own copy of the same seed.
            const open = yield* backend.databases;
            const officialDb = yield* open("official");
            const nativeDb = yield* open("native");
            const official = yield* oracle(officialDb, backend.bindings);
            const officialPost = (body: string) =>
              Effect.promise(async () => {
                const response = await official(
                  new Request("http://reffect.test/rpc", { method: "POST", body }),
                );
                return { status: response.status, body: await response.text() };
              });
            const address = yield* startNative(backend, nativeDb, parent);
            const post = (body: string) =>
              Effect.promise(async () => {
                const response = await fetch(`http://${address}/rpc`, { method: "POST", body });
                return { status: response.status, body: await response.text() };
              });
            const answers = new Map<string, string>();
            for (const [label, body] of corpus) {
              const native = yield* post(body);
              const reference = yield* officialPost(body);
              answers.set(label, reference.body);
              expect(native.status, label).toBe(reference.status);
              expect(JSON.parse(native.body), label).toStrictEqual(JSON.parse(reference.body));
              expect(successValue(native.body), `${label} raw key order`).toStrictEqual(
                successValue(reference.body),
              );
            }
            const answer = (label: string) => answers.get(label) ?? "";
            expect(answer("read after rename")).toContain("Zephyr");
            expect(answer("read created")).toContain('"owner":"User:u3"');
            expect(answer("drafts after create")).toContain("p90");
            expect(answer("drafts after archive")).not.toContain('"p03"');
            expect(answer("a store failure")).toContain("Database query failed");
            expect(answer("read after the store failure")).toContain('"entities":[]');
            expect(answer("a typed failure after a write")).toContain("Refused after writing");
            expect(answer("read after the typed failure")).not.toContain("Lost");
            expect(answer("a store failure after a write")).toContain("Database query failed");
            expect(answer("read after the second failure")).not.toContain("Gone");
            expect(answer("invalid input")).toContain("Invalid mutation input");
            expect(answer("read bumped")).toContain('"rank":3');
            expect(answer("bump an absent row")).toContain("No numeric rank");
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    },
    nativeTestBudget(0) + 300000,
  );

// Milestone 5 acceptance: the stock Remote client over the native SQL server sees what it sees over
// the official one, through queries, mutateInto, a refusal and a reload.
const Model = Schema.Struct({ remote: Remote.Model });
const App = Surface.application({ Model, Message: defineMessageUnion({ ...Remote.messages }) });
const Data = Remote.make({
  model: App.model.remote,
  entities: [User, Project],
  queries: [ByStatus, Search],
  mutations: [Rename, Create, Archive, Broken],
});
const initial: typeof Model.Type = { remote: Remote.initial };
const draftList = Data.query(
  ByStatus,
  { status: "draft" },
  {
    select: Entity.select(Project, { name: true, owner: Entity.select(User, { name: true }) }),
    first: 4,
  },
);
const session = Effect.gen(function* () {
  const loaded = yield* Data.prefetch(initial, draftList);
  const renamed = yield* Remote.mutateInto(
    Data,
    loaded,
    Rename,
    { id: "p11", name: "Zephyr" },
    "r1",
  );
  const created = yield* Remote.mutateInto(
    Data,
    renamed.model,
    Create,
    { id: "p90", name: "Aurora", status: "draft", rank: 9, done: false, owner: "User:u2" },
    "r2",
  );
  const archived = yield* Remote.mutateInto(Data, created.model, Archive, { id: "p07" }, "r3");
  const refused = yield* Remote.mutate(Broken, { id: "p91", name: "x" }, "r4").pipe(Effect.flip);
  const reloaded = yield* Data.prefetch(initial, draftList);
  return {
    loaded: draftList.read(loaded),
    renamed: draftList.read(renamed.model),
    created: draftList.read(created.model),
    archived: draftList.read(archived.model),
    refused: refused.message,
    reloaded: draftList.read(reloaded),
  };
});

for (const backend of sqlBackends)
  test.skipIf(backend.unavailable !== undefined)(
    `a stock Remote client reads, queries and mutates through the native ${backend.dialect} server`,
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-sql-acceptance-" });
            const open = yield* backend.databases;
            const officialDb = yield* open("official");
            const nativeDb = yield* open("native");
            // Upstream's handlers are a RemoteRpcClient; each answer runs against the official database.
            const layer = officialDb.layer;
            const handlers = RemoteServer.handlers(
              officialServer(officialDb, backend.bindings),
              undefined,
            );
            const officialClient: RemoteRpcClient = {
              FoldkitRemoteRead: (payload) =>
                handlers.FoldkitRemoteRead(payload).pipe(Effect.provide(layer)),
              FoldkitRemoteQuery: (payload) =>
                handlers.FoldkitRemoteQuery(payload).pipe(Effect.provide(layer)),
              FoldkitRemoteMutate: (payload) =>
                handlers.FoldkitRemoteMutate(payload).pipe(Effect.provide(layer)),
              FoldkitRemoteLive: () => Stream.die("Live is not part of this session"),
            };
            const official = yield* session.pipe(
              Effect.provide(Remote.clientLayer(officialClient)),
            );
            expect(official.reloaded).toMatchObject({ _tag: "Ready" });
            expect(official.refused).toBe("Database query failed");
            // Each step observes its effect, so the comparison below cannot pass vacuously.
            const seen = (value: unknown) => JSON.stringify(value);
            expect(seen(official.loaded)).not.toContain("Zephyr");
            expect(seen(official.renamed)).toContain("Zephyr");
            expect(seen(official.renamed)).toContain("Zeta");
            expect(seen(official.archived)).not.toContain("Zeta");
            // Create's outcome adds no connection, so only the reload pages the new top-ranked row in.
            expect(seen(official.reloaded)).toContain("Aurora");
            expect(seen(official.reloaded)).toContain("Zephyr");
            expect(seen(official.reloaded)).not.toContain("Zeta");

            const address = yield* startNative(backend, nativeDb, parent);
            const rpc = yield* RpcClient.make(RemoteRpc, { disableTracing: true }).pipe(
              Effect.provide(
                RpcClient.layerProtocolHttp({ url: `http://${address}/rpc` }).pipe(
                  Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
                ),
              ),
            );
            const native = yield* session.pipe(Effect.provide(Remote.clientLayer(rpc)));
            expect(native).toStrictEqual(official);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    },
    nativeTestBudget(0) + 300000,
  );

// SQLX-012 with RS-007: two read-modify-writes of one row that overlap. Postgres SERIALIZABLE
// refuses one rather than lose an update; SQLite's BEGIN IMMEDIATE runs them one after the other.
// The official oracle shares one SQLite connection, so it joins only on Postgres.
for (const backend of sqlBackends)
  test.skipIf(backend.unavailable !== undefined)(
    `overlapping read-modify-writes lose no update on ${backend.dialect}`,
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-sql-overlap-" });
            const open = yield* backend.databases;
            const nativeDb = yield* open("native");
            const address = yield* startNative(backend, nativeDb, parent);
            const servers: Array<readonly [string, (body: string) => Promise<string>]> = [
              [
                "native",
                (body) =>
                  fetch(`http://${address}/rpc`, { method: "POST", body }).then((r) => r.text()),
              ],
            ];
            if (backend.dialect === "postgres") {
              const official = yield* oracle(yield* open("official"), backend.bindings);
              servers.push([
                "official",
                (body) =>
                  official(new Request("http://reffect.test/rpc", { method: "POST", body })).then(
                    (r) => r.text(),
                  ),
              ]);
            }
            const rankOf = (answer: string) => Number(/"rank":(\d+)/.exec(answer)?.[1]);
            for (const [name, post] of servers) {
              const before = rankOf(yield* Effect.promise(() => post(read("p02"))));
              const answers = yield* Effect.promise(() =>
                Promise.all([
                  post(mutate("SlowBump", { id: "p02" })),
                  post(mutate("SlowBump", { id: "p02" })),
                ]),
              );
              const after = rankOf(yield* Effect.promise(() => post(read("p02"))));
              const succeeded = answers.filter((a) => a.includes('"_tag":"Success"')).length;
              const refused = answers.filter((a) => a.includes("Database query failed")).length;
              expect(succeeded + refused, `${name} ${answers.join(" | ")}`).toBe(2);
              // No lost update: the rank moved once per mutation that committed.
              expect(after, name).toBe(before + succeeded);
              if (backend.dialect === "postgres") expect(refused, name).toBe(1);
              else expect(succeeded, name).toBe(2);
            }
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    },
    nativeTestBudget(0) + 300000,
  );
