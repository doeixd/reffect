import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { Entity, Expr, Order, Relation } from "foldkit-entity";
import { Query, Remote, RemoteRpc } from "foldkit-remote";
import { RemoteServer } from "foldkit-remote-server";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRemote } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { successValue } from "./raw-json.ts";

// The published contract, served for Read and Query (mutations are step 4, Live is NR-006).
const Group = RemoteRpc.omit("FoldkitRemoteMutate", "FoldkitRemoteLive");

// A domain shaped after foldkit-remote-server's memory test, with queries declared by body.
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
const Named = Query.define("Named", { term: Schema.String }, ({ input }) =>
  Query.from(Project).pipe(Query.where(Expr.contains(Project.fields.name, input.term))),
);
const Ranked = Query.define("Ranked", { status: Schema.String }, ({ input }) =>
  Query.from(Project).pipe(
    Query.where(Expr.eq(Project.fields.status, input.status)),
    Query.orderBy(Order.desc(Project.fields.rank)),
  ),
);
const domain = Remote.define({ entities: [User, Project], queries: [ByStatus, Named, Ranked] });
const rows = {
  User: [
    { id: "u1", name: "Ada" },
    { id: "u2", name: "Grace" },
  ],
  Project: [
    { id: "p1", name: "Borealis", status: "active", rank: 2, owner: "User:u1" },
    { id: "p2", name: "Apollo", status: "active", rank: 9, owner: "User:u1" },
    { id: "p3", name: "Calypso", status: "archived", rank: 5, owner: "User:u2" },
    { id: "p4", name: "Dione", status: "active", rank: 7, owner: "User:u2" },
    { id: "p5", name: "Europa", status: "draft", rank: null, owner: "User:u1" },
    { id: "p6", name: "Fornax", status: "draft", rank: 1, owner: "User:u2" },
    { id: "p7", name: "Ganymede", status: "solo", rank: null, owner: "User:u1" },
  ],
};

const query = (name: string, input: unknown, window: object = {}, select?: object) =>
  JSON.stringify({
    _tag: "Request",
    id: "1",
    tag: "FoldkitRemoteQuery",
    payload: { query: name, input, window, ...(select === undefined ? {} : { select }) },
    headers: [],
  });
const active = { status: "active" };
const corpus: ReadonlyArray<readonly [string, string]> = [
  ["all active, ordered", query("ByStatus", active)],
  ["first page", query("ByStatus", active, { first: 2 })],
  ["next page after a cursor", query("ByStatus", active, { first: 2, after: "p1" })],
  ["last page", query("ByStatus", active, { last: 1 })],
  ["before a cursor", query("ByStatus", active, { last: 5, before: "p4" })],
  ["empty page with more beyond", query("ByStatus", active, { first: 0 })],
  ["cursor that stopped matching", query("ByStatus", active, { first: 1, after: "p3" })],
  ["cursor before, stopped matching", query("ByStatus", active, { last: 1, before: "p3" })],
  ["cursor for a row that is gone", query("ByStatus", active, { first: 1, after: "zz" })],
  ["both directions", query("ByStatus", active, { first: 1, last: 1 })],
  ["no matches", query("ByStatus", { status: "lost" })],
  ["containment", query("Named", { term: "OR" })],
  ["descending order", query("Ranked", active)],
  ["single null-ranked match is never compared", query("Ranked", { status: "solo" })],
  ["unknown query", query("Missing", {})],
  ["input of the wrong kind", query("ByStatus", { status: 5 })],
  ["input missing a key", query("ByStatus", {})],
  ["input not an object", query("ByStatus", null)],
  ["excess input keys are ignored", query("ByStatus", { status: "archived", extra: [1] })],
  [
    "select reads the page's items",
    query(
      "ByStatus",
      active,
      { first: 2 },
      {
        entity: "Project",
        fields: ["name", "owner"],
        relations: { owner: { entity: "User", fields: ["name"] } },
      },
    ),
  ],
  [
    "select of another entity reads nothing",
    query("ByStatus", active, {}, { entity: "User", fields: ["name"] }),
  ],
  [
    "select paging too many ways",
    query(
      "ByStatus",
      active,
      {},
      {
        entity: "Project",
        fields: ["owner@1", "owner@2", "owner@3", "owner@4", "owner@5"],
      },
    ),
  ],
];

const oracle = Effect.gen(function* () {
  // The published memory backend, served over a real RpcServer (foldkit-plus#140).
  const server = RemoteServer.memory({ domain, rows }).server;
  const handlers = RemoteServer.handlers(server, undefined);
  const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
    Effect.provide([
      Group.toLayer({
        FoldkitRemoteRead: handlers.FoldkitRemoteRead,
        FoldkitRemoteQuery: handlers.FoldkitRemoteQuery,
      }),
      RpcSerialization.layerJson,
    ]),
  );
  return HttpEffect.toWebHandler(http);
});

test("queries without a body are refused, as the memory backend refuses them", async () => {
  const Bodiless = Query.make("Bodiless", { Input: {}, Result: Project });
  const error = await Effect.runPromise(
    NativeRemote.compile(Group, {
      domain: Remote.define({ entities: [User, Project], queries: [Bodiless] }),
      rows,
    }).pipe(Effect.flip),
  );
  expect(error.message).toContain('"Bodiless" has no body to run');
});

test(
  "native queries match foldkit-remote-server's memory backend over the wire",
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
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-remote-query-" });
          const artifact = yield* NativeRemote.compile(Group, { domain, rows });
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
          for (const [label, body] of corpus) {
            const native = yield* post(body);
            const reference = yield* officialPost(body);
            expect(native.status, label).toBe(reference.status);
            expect(JSON.parse(native.body), label).toStrictEqual(JSON.parse(reference.body));
            expect(successValue(native.body), `${label} raw key order`).toStrictEqual(
              successValue(reference.body),
            );
          }
          // NR-017 closed by foldkit-entity 0.7.0 (#142): ordering by a null key is refused before
          // sorting, naming the first null in row order, so both servers answer the same bytes.
          const nullOrder = query("Ranked", { status: "draft" });
          const officialRefusal = yield* officialPost(nullOrder);
          const nativeRefusal = yield* post(nullOrder);
          expect(officialRefusal.body).toContain('orders by \\"rank\\", which is null in a row');
          expect(nativeRefusal.status).toBe(officialRefusal.status);
          expect(JSON.parse(nativeRefusal.body)).toStrictEqual(JSON.parse(officialRefusal.body));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 180000,
);
