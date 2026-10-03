import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { Entity, Expr, Order, Relation } from "foldkit-entity";
import { ConnectionChangeSchema, Mutation, Query, Remote, RemoteRpc } from "foldkit-remote";
import { RemoteServer, RemoteServerError } from "foldkit-remote-server";
import type { MemoryStore } from "foldkit-remote-server";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  CompileError,
  NativeRemote,
  NativeRpc,
  R,
  Reference,
  RemoteStoreHost,
  memoryStoreApi,
} from "../src/index.ts";
import type { NativeRemoteMutation } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { successValue } from "./raw-json.ts";

// RM-001: R mutation sources over the store, against the published handler and MemoryStore.
const Group = RemoteRpc.omit("FoldkitRemoteLive");

const UserBase = Entity.define("User", Schema.Struct({ id: Schema.String, name: Schema.String }));
const ProjectBase = Entity.define(
  "Project",
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    status: Schema.String,
    rank: Schema.NullOr(Schema.Number),
  }),
);
const { User, Project } = Entity.relate(
  { User: UserBase, Project: ProjectBase },
  { Project: { owner: Relation.one(UserBase) } },
);
const ByStatus = Query.define("ByStatus", { status: Schema.String }, ({ input }) =>
  Query.from(Project).pipe(
    Query.where(Expr.eq(Project.fields.status, input.status)),
    Query.orderBy(Order.asc(Project.fields.name)),
  ),
);
const Labeled = Query.define(
  "Labeled",
  { label: Schema.String, open: Schema.Boolean },
  ({ input }) => Query.from(Project).pipe(Query.where(Expr.eq(Project.fields.name, input.label))),
);
const Ping = Mutation.make("Ping", {
  Input: { label: Schema.String, open: Schema.Boolean },
  Output: {},
});
const Rename = Mutation.make("Rename", {
  Input: { id: Schema.String, name: Schema.String },
  Output: { id: Schema.String },
});
const Create = Mutation.make("Create", {
  Input: { id: Schema.String, name: Schema.String, owner: Schema.String, rank: Schema.Finite },
  Output: { id: Schema.String },
});
const Archive = Mutation.make("Archive", { Input: { id: Schema.String }, Output: {} });
// Read-modify-write (RS-007): the stored rank is read, decoded and incremented.
const Bump = Mutation.make("Bump", { Input: { id: Schema.String }, Output: {} });
const domain = Remote.define({
  entities: [User, Project],
  queries: [ByStatus, Labeled],
  mutations: [Rename, Create, Archive, Ping, Bump],
});
const rows = {
  User: [
    { id: "u1", name: "Ada" },
    { id: "u2", name: "Grace" },
  ],
  Project: [
    { id: "p1", name: "Borealis", status: "active", rank: 2, owner: "User:u1" },
    { id: "p2", name: "Apollo", status: "active", rank: 9, owner: "User:u1" },
    { id: "p5", name: "Europa", status: "draft", rank: null, owner: "User:u1" },
    { id: "p6", name: "Fornax", status: "draft", rank: 1, owner: "User:u2" },
  ],
};

const Named = R.Struct({ name: R.String });
const Created = R.Struct({ name: R.String, status: R.String, owner: R.String, rank: R.Number });
const text = (value: string) => R.literal(R.String, value);
const rename = NativeRemote.mutation(Rename, ({ input }) => {
  const id = R.Struct.get(input, "id");
  const name = R.Struct.get(input, "name");
  const values = Named.make({ name });
  return R.Match.bool(
    R.String.eq(name, text("")),
    R.Effect.fail(NativeRemote.ServerError.make({ message: text("Name required") })),
    R.Effect.flatMap(R.RemoteStore.write("Project", id, values), () =>
      R.Effect.succeed(
        NativeRemote.outcome(Rename).make({
          output: R.Struct({ id: R.String }).make({ id }),
          entities: R.Array.make(NativeRemote.patch(Project, id, values)),
        }),
      ),
    ),
  );
});
const projectRef = (id: ReturnType<typeof text>) =>
  NativeRemote.Ref.make({ entity: text("Project"), id });
const drafts = NativeRemote.connection(
  ByStatus,
  R.Struct({ status: R.String }).make({ status: text("draft") }),
);
// Connection identities from a decoded input: key order, booleans and escaping (RM-005).
const ping = NativeRemote.mutation(Ping, ({ input }) => {
  const labeled = NativeRemote.connection(Labeled, input);
  return R.Effect.succeed(
    NativeRemote.outcome(Ping).make({
      output: R.Struct({}).make({}),
      connections: R.Array.make(
        NativeRemote.prepend(labeled, projectRef(text("p1"))),
        NativeRemote.append(labeled, projectRef(text("p2"))),
        NativeRemote.remove(
          NativeRemote.connection(
            ByStatus,
            R.Struct({ status: R.String }).make({ status: R.Struct.get(input, "label") }),
          ),
          projectRef(text("p6")),
        ),
      ),
    }),
  );
});
const create = NativeRemote.mutation(Create, ({ input }) => {
  const id = R.Struct.get(input, "id");
  const values = Created.make({
    name: R.Struct.get(input, "name"),
    status: text("draft"),
    owner: R.Struct.get(input, "owner"),
    rank: R.Struct.get(input, "rank"),
  });
  return R.Effect.flatMap(R.RemoteStore.write("Project", id, values), () =>
    R.Effect.succeed(
      NativeRemote.outcome(Create).make({
        output: R.Struct({ id: R.String }).make({ id }),
        entities: R.Array.make(NativeRemote.patch(Project, id, values)),
        connections: R.Array.make(NativeRemote.append(drafts, projectRef(id))),
      }),
    ),
  );
});
const archive = NativeRemote.mutation(Archive, ({ input }) => {
  const id = R.Struct.get(input, "id");
  return R.Effect.flatMap(R.RemoteStore.remove("Project", id), () =>
    R.Effect.succeed(
      NativeRemote.outcome(Archive).make({
        output: R.Struct({}).make({}),
        connections: R.Array.make(NativeRemote.remove(drafts, projectRef(id))),
        deleted: R.Array.make(projectRef(id)),
      }),
    ),
  );
});
const Ranked = R.Struct({ rank: R.Number });
// None when the row is absent or its rank is not a number (null), each a typed refusal.
const bump = NativeRemote.mutation(Bump, ({ input }) => {
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
          return R.Effect.flatMap(R.RemoteStore.write("Project", id, values), () =>
            R.Effect.succeed(
              NativeRemote.outcome(Bump).make({
                output: R.Struct({}).make({}),
                entities: R.Array.make(NativeRemote.patch(Project, id, values)),
              }),
            ),
          );
        },
      },
    ),
  );
});
const mutations: readonly NativeRemoteMutation[] = [rename, create, archive, ping, bump];

const request = (tag: string, payload: unknown) =>
  JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] });
const mutate = (mutation: string, input: unknown) =>
  request("FoldkitRemoteMutate", { requestId: "r1", mutation, input });
const read = (id: string) =>
  request("FoldkitRemoteRead", {
    version: 4,
    requests: [
      {
        entity: "Project",
        id,
        fields: ["name", "status", "rank", "owner"],
        relations: { owner: { entity: "User", fields: ["name"] } },
      },
    ],
  });
const byStatus = (status: string) =>
  request("FoldkitRemoteQuery", {
    query: "ByStatus",
    input: { status },
    window: {},
    select: { entity: "Project", fields: ["name"] },
  });
// Stateful: both servers see the same sequence, so each step observes earlier writes.
const corpus: ReadonlyArray<readonly [string, string]> = [
  ["read before", read("p1")],
  ["active before", byStatus("active")],
  ["rename", mutate("Rename", { id: "p1", name: "Zephyr" })],
  ["read after rename", read("p1")],
  ["active order after rename", byStatus("active")],
  ["rename refused", mutate("Rename", { id: "p2", name: "" })],
  ["rename with excess input keys", mutate("Rename", { id: "p2", name: "Aquila", x: [1] })],
  ["create", mutate("Create", { id: "p9", name: "Aurora", owner: "User:u2", rank: 0.1 })],
  ["read created", read("p9")],
  ["drafts with the new row last", byStatus("draft")],
  [
    "create over an existing row keeps key positions",
    mutate("Create", { id: "p2", name: "Apex", owner: "User:u2", rank: -0 }),
  ],
  ["read overwritten", read("p2")],
  ["bump", mutate("Bump", { id: "p1" })],
  ["bump again, reading the first bump", mutate("Bump", { id: "p1" })],
  ["read bumped", read("p1")],
  ["bump a null rank", mutate("Bump", { id: "p5" })],
  ["bump an absent row", mutate("Bump", { id: "zz" })],
  ["archive", mutate("Archive", { id: "p5" })],
  ["read archived", read("p5")],
  ["drafts after archive", byStatus("draft")],
  ["archive an absent row", mutate("Archive", { id: "zz" })],
  [
    "recreate goes last",
    mutate("Create", { id: "p5", name: "Europa", owner: "User:u1", rank: 1e21 }),
  ],
  ["drafts after recreate", byStatus("draft")],
  ["unknown mutation", mutate("Nope", {})],
  ["connection identities", mutate("Ping", { open: true, label: 'é "q"  😀  </' })],
  ["connection identity, empty label", mutate("Ping", { label: "", open: false })],
  ["input of the wrong kind", mutate("Rename", { id: 5, name: "x" })],
  ["input missing a key", mutate("Rename", { id: "p1" })],
  ["input not an object", mutate("Archive", null)],
  [
    "non-finite number as a string",
    mutate("Create", { id: "p8", name: "N", owner: "User:u1", rank: "NaN" }),
  ],
];

const oracle = Effect.gen(function* () {
  // The R source over upstream's store, its outcome as upstream types it.
  const run =
    (store: MemoryStore, native: NativeRemoteMutation) =>
    ({ input }: { readonly input: unknown }) =>
      Reference.run(native.fn, [input]).pipe(
        Effect.provideService(RemoteStoreHost, memoryStoreApi(store)),
        Effect.catch((error) =>
          error instanceof CompileError
            ? Effect.die(error)
            : Effect.fail(
                new RemoteServerError({
                  message: Schema.decodeUnknownSync(Schema.Struct({ message: Schema.String }))(
                    error,
                  ).message,
                }),
              ),
        ),
        Effect.map((outcome) =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              output: Schema.Unknown,
              entities: Schema.optionalKey(
                Schema.Array(
                  Schema.Struct({
                    entity: Schema.String,
                    id: Schema.String,
                    values: Schema.Record(Schema.String, Schema.Unknown),
                  }),
                ),
              ),
              connections: Schema.optionalKey(Schema.Array(ConnectionChangeSchema)),
              deleted: Schema.optionalKey(
                Schema.Array(Schema.Struct({ entity: Schema.String, id: Schema.String })),
              ),
            }),
          )(outcome),
        ),
      );
  // The published memory backend and its MemoryStore, served over a real RpcServer (#140).
  const server = RemoteServer.memory({
    domain,
    rows,
    mutations: (store) => [
      RemoteServer.mutation(Rename, run(store, rename)),
      RemoteServer.mutation(Create, run(store, create)),
      RemoteServer.mutation(Archive, run(store, archive)),
      RemoteServer.mutation(Bump, run(store, bump)),
      RemoteServer.mutation(Ping, run(store, ping)),
    ],
  }).server;
  const handlers = RemoteServer.handlers(server, undefined);
  const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
    Effect.provide([
      Group.toLayer({
        FoldkitRemoteRead: handlers.FoldkitRemoteRead,
        FoldkitRemoteQuery: handlers.FoldkitRemoteQuery,
        FoldkitRemoteMutate: handlers.FoldkitRemoteMutate,
      }),
      RpcSerialization.layerJson,
    ]),
  );
  return HttpEffect.toWebHandler(http);
});

test("connection identities equal upstream Query.ref(input).identity", async () => {
  const Mixed = Query.define(
    "Mixed",
    { b: Schema.Finite, a: Schema.String, c: Schema.Boolean },
    ({ input }) => Query.from(Project).pipe(Query.where(Expr.eq(Project.fields.name, input.a))),
  );
  const identity = R.fn([NativeRpc.witness(Mixed.Input)], R.String, (input) =>
    NativeRemote.connection(Mixed, input),
  );
  for (const input of [
    { b: 0.1, a: "", c: true },
    { b: 1e21, a: 'é "q"  😀  </', c: false },
    { b: -0, a: " ", c: true },
    { b: 5e-324, a: "10", c: false },
    { b: 123456789012, a: "z", c: true },
  ])
    expect(await Effect.runPromise(Reference.run(identity, [input]))).toBe(
      Mixed.ref(input).identity,
    );
});

test("mutation schemas outside the portable subset are refused", () => {
  const Loose = Mutation.make("Loose", { Input: { n: Schema.Number }, Output: {} });
  const Counted = Mutation.make("Counted", { Input: {}, Output: { n: Schema.Finite } });
  expect(() =>
    NativeRemote.mutation(Counted, () =>
      R.Effect.fail(NativeRemote.ServerError.make({ message: text("") })),
    ),
  ).toThrow(/no numbers/);
  expect(() =>
    NativeRemote.mutation(Loose, () =>
      R.Effect.succeed(
        NativeRemote.outcome(Loose).make({
          output: R.Struct({}).make({}),
        }),
      ),
    ),
  ).toThrow(/finite/);
  const Maybe = Mutation.make("Maybe", {
    Input: { n: Schema.optional(Schema.String) },
    Output: {},
  });
  expect(() =>
    NativeRemote.mutation(Maybe, () =>
      R.Effect.succeed(
        NativeRemote.outcome(Maybe).make({
          output: R.Struct({}).make({}),
        }),
      ),
    ),
  ).toThrow(/optionalKey/);
  const Name = R.Struct({ title: R.String });
  expect(() => NativeRemote.patch(Project, text("p1"), Name.make({ title: text("x") }))).toThrow(
    /declares no field title/,
  );
});

test(
  "native mutations match foldkit-remote-server's handler over its MemoryStore",
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
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-remote-mutate-" });
          const artifact = yield* NativeRemote.compile(Group, { domain, rows, mutations });
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
          // The corpus reaches each path, not only agreeing failures.
          const answer = (label: string) => answers.get(label) ?? "";
          expect(answer("read after rename")).toContain("Zephyr");
          expect(answer("read bumped")).toContain('"rank":4');
          expect(answer("bump a null rank")).toContain("No numeric rank");
          expect(answer("bump an absent row")).toContain("No numeric rank");
          expect(answer("rename")).toContain('"entities":[{"entity":"Project","id":"p1"');
          expect(answer("rename refused")).toContain("Name required");
          expect(answer("read created")).toContain("Aurora");
          // `{ ...existing, id, ...values }` keeps each existing key where it was.
          expect(answer("read overwritten")).toContain(
            '"values":{"name":"Apex","status":"draft","rank":0,"owner":"User:u2"}',
          );
          expect(answer("archive")).toContain('"deleted":[{"entity":"Project","id":"p5"}]');
          expect(answer("read archived")).not.toContain("Europa");
          expect(answer("drafts after recreate")).toMatch(/p6.*p9.*p5/);
          expect(answer("unknown mutation")).toContain("Unknown mutation: Nope");
          expect(answer("create")).toContain(
            '"connections":[{"_tag":"Insert","connection":"ByStatus',
          );
          expect(answer("connection identities")).toContain('"position":"prepend"');
          for (const label of [
            "input of the wrong kind",
            "input missing a key",
            "non-finite number as a string",
          ])
            expect(answer(label)).toContain("Invalid mutation input");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 180000,
);
