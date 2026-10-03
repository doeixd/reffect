import type { DatabaseSync } from "node:sqlite";
import { Cause, Effect, Exit, FileSystem, Option, Schema, Stream } from "effect";
import { HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { drizzle } from "drizzle-orm/node-sqlite";
import { ConnectionChangeSchema, Mutation, NormalizedEntity, RemoteRpc } from "foldkit-remote";
import { databaseLayer, query, source } from "foldkit-remote-drizzle";
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
import { ByStatus, Project, Search, bound, domain, seed } from "./fixtures/remote-sql-domain.ts";

// Milestone 5 step 4 (SQLX-006): R mutation sources over a SQLite transaction per mutation,
// against the same sources run by the reference over Drizzle writes in a transaction.
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
const mutations: ReadonlyArray<NativeRemoteMutation> = [
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

/**
 * MemoryStore semantics over the same connection: update the given columns of an existing row, or
 * insert a new one; a ref value stores its target id in the foreign key.
 */
const sqlStore = (db: DatabaseSync): RemoteStoreApi => {
  const tableOf = (entity: string) => (entity === "Project" ? "projects" : "users");
  const columnOf = (entity: string, field: string): string => {
    const binding = entity === "Project" ? bound.Project : bound.User;
    const column = Object.entries(binding.columns).find(([key]) => key === field)?.[1];
    if (column !== undefined) return column.name;
    if (entity === "Project" && field === "owner") return "owner_id";
    throw new Error(`No column for ${field}`);
  };
  const stored = (field: string, value: unknown): string | number | null => {
    if (field === "owner" && typeof value === "string") return value.slice(value.indexOf(":") + 1);
    if (typeof value === "boolean") return Number(value);
    if (typeof value === "string" || typeof value === "number" || value === null) return value;
    throw new Error(`Unexpected value for ${field}`);
  };
  return {
    write: (entity, id, values) => {
      const entries = Object.entries(values).filter(([field]) => field !== "id");
      const columns = entries.map(([field]) => columnOf(entity, field));
      const params = entries.map(([field, value]) => stored(field, value));
      const updated =
        columns.length === 0
          ? db.prepare(`select 1 from ${tableOf(entity)} where id = ?`).all(id).length
          : Number(
              db
                .prepare(
                  `update ${tableOf(entity)} set ${columns.map((column) => `"${column}" = ?`).join(", ")} where id = ?`,
                )
                .run(...params, id).changes,
            );
      if (updated === 0)
        db.prepare(
          `insert into ${tableOf(entity)} (id${columns.map((column) => `, "${column}"`).join("")}) values (?${columns.map(() => ", ?").join("")})`,
        ).run(id, ...params);
    },
    remove: (entity, id) => {
      db.prepare(`delete from ${tableOf(entity)} where id = ?`).run(id);
    },
  };
};

const oracle = (db: DatabaseSync) =>
  Effect.gen(function* () {
    const layer = databaseLayer(drizzle({ client: db }));
    const store = sqlStore(db);
    // One transaction per mutation; a store exception answers as upstream's Drizzle helpers do.
    const run =
      (native: NativeRemoteMutation) =>
      ({ input }: { readonly input: unknown }) =>
        Effect.gen(function* () {
          db.exec("BEGIN IMMEDIATE");
          let failed = false;
          const guarded: RemoteStoreApi = {
            write: (entity, id, values) => {
              try {
                store.write(entity, id, values);
              } catch (error) {
                failed = true;
                throw error;
              }
            },
            remove: (entity, id) => {
              try {
                store.remove(entity, id);
              } catch (error) {
                failed = true;
                throw error;
              }
            },
          };
          const exit = yield* Effect.exit(
            Reference.run(native.fn, [input]).pipe(Effect.provideService(RemoteStoreHost, guarded)),
          );
          if (Exit.isSuccess(exit)) {
            db.exec("COMMIT");
            return Schema.decodeUnknownSync(Outcome)(exit.value);
          }
          db.exec("ROLLBACK");
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
      entities: [source(bound.User), source(bound.Project)],
      queries: [
        query(ByStatus, { entity: bound.Project }),
        query(Search, { entity: bound.Project }),
      ],
      mutations: [
        RemoteServer.mutation(Rename, run(rename)),
        RemoteServer.mutation(Create, run(create)),
        RemoteServer.mutation(Archive, run(archive)),
        RemoteServer.mutation(Broken, run(broken)),
        RemoteServer.mutation(RenameThenRefuse, run(renameThenRefuse)),
        RemoteServer.mutation(RenameThenBreak, run(renameThenBreak)),
      ],
    });
    const handlers = RemoteServer.handlers(server, undefined);
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

test(
  "native SQL mutations match upstream sources over Drizzle writes, one transaction each",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({
            prefix: "reffect-remote-sql-mutate-",
          });
          // Separate files: each server mutates its own copy of the same seed.
          const officialDb = seed(`${parent}/official.db`);
          const nativeFile = `${parent}/native.db`;
          seed(nativeFile).close();
          yield* Effect.addFinalizer(() => Effect.sync(() => officialDb.close()));
          const official = yield* oracle(officialDb);
          const officialPost = (body: string) =>
            Effect.promise(async () => {
              const response = await official(
                new Request("http://reffect.test/rpc", { method: "POST", body }),
              );
              return { status: response.status, body: await response.text() };
            });
          const artifact = yield* NativeRemote.compile(Group, {
            domain,
            sql: { bindings: bound, databaseUrlEnv: "REFFECT_DATABASE_URL" },
            mutations,
          });
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.fetch(directory);
          yield* CargoApi.build(directory, "debug");
          const child = yield* ChildProcess.make(
            `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
            ["--port", "0"],
            {
              env: { REFFECT_DATABASE_URL: `sqlite:${nativeFile.replaceAll("\\", "/")}` },
              extendEnv: true,
            },
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
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
