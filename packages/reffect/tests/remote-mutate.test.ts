import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { Entity, Expr, Order, Relation } from "foldkit-entity";
import { Mutation, Query, Remote, RemoteRpc } from "foldkit-remote";
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
import type { NativeRemoteMutation } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { successValue } from "./raw-json.ts";
import { memoryQueryRun, memoryRead, storeTables } from "./fixtures/foldkit-remote-memory.ts";

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
const Rename = Mutation.make("Rename", {
  Input: { id: Schema.String, name: Schema.String },
  Output: { id: Schema.String },
});
const Create = Mutation.make("Create", {
  Input: { id: Schema.String, name: Schema.String, owner: Schema.String, rank: Schema.Finite },
  Output: { id: Schema.String },
});
const Archive = Mutation.make("Archive", { Input: { id: Schema.String }, Output: {} });
const domain = Remote.define({
  entities: [User, Project],
  queries: [ByStatus],
  mutations: [Rename, Create, Archive],
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
const rename = NativeRemote.mutation(Rename, (input) => {
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
const create = NativeRemote.mutation(Create, (input) => {
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
      }),
    ),
  );
});
const archive = NativeRemote.mutation(Archive, (input) => {
  const id = R.Struct.get(input, "id");
  return R.Effect.flatMap(R.RemoteStore.remove("Project", id), () =>
    R.Effect.succeed(
      NativeRemote.outcome(Archive).make({
        output: R.Struct({}).make({}),
        deleted: R.Array.make(NativeRemote.Ref.make({ entity: text("Project"), id })),
      }),
    ),
  );
});
const mutations: readonly NativeRemoteMutation[] = [rename, create, archive];

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
  ["input of the wrong kind", mutate("Rename", { id: 5, name: "x" })],
  ["input missing a key", mutate("Rename", { id: "p1" })],
  ["input not an object", mutate("Archive", null)],
  [
    "non-finite number as a string",
    mutate("Create", { id: "p8", name: "N", owner: "User:u1", rank: "NaN" }),
  ],
];

const oracle = Effect.gen(function* () {
  const backend = RemoteServer.memory({ domain, rows });
  const tables = storeTables(backend);
  const source = <D extends typeof Rename | typeof Create | typeof Archive>(
    definition: D,
    native: NativeRemoteMutation,
  ) =>
    RemoteServer.mutation(definition, ({ input }) =>
      Reference.run(native.fn, [input]).pipe(
        Effect.provideService(RemoteStoreHost, backend),
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
              deleted: Schema.optionalKey(
                Schema.Array(Schema.Struct({ entity: Schema.String, id: Schema.String })),
              ),
            }),
          )(outcome),
        ),
      ),
    );
  const server = RemoteServer.make<undefined>({
    entities: ["User", "Project"].map((name) =>
      RemoteServer.entity<undefined>({ name }, { read: memoryRead(tables, name) }),
    ),
    queries: [RemoteServer.query(ByStatus, memoryQueryRun(tables, ByStatus))],
    mutations: [source(Rename, rename), source(Create, create), source(Archive, archive)],
  });
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
