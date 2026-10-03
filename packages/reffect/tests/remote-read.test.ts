import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { Entity } from "foldkit-entity";
import { Remote, RemoteRpc } from "foldkit-remote";
import { RemoteServer } from "foldkit-remote-server";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRemote } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { successValue } from "./raw-json.ts";

// The published contract, served for Read only.
const ReadGroup = RemoteRpc.omit("FoldkitRemoteMutate", "FoldkitRemoteQuery", "FoldkitRemoteLive");

// A domain shaped after foldkit-remote-server's memory, nested, nestedShared and alias tests.
const entities = ["User", "Project", "Post", "Comment", "Team"];
// The registry the memory backend serves; fields are read at the wire level, so ids suffice.
const domain = Remote.define({
  entities: entities.map((name) => Entity.define(name, Schema.Struct({ id: Schema.String }))),
});
const crowd = Array.from({ length: 1001 }, (_, i) => ({ id: `m${i}`, name: `Member ${i}` }));
const rows = {
  User: [
    {
      id: "u1",
      name: "Ada",
      team: "Team:t1",
      friend: "User:u2",
      "2": "two",
      z: 1,
      a: { y: 1, x: 2 },
    },
    { id: "u2", name: "Grace", friend: "User:u1" },
    ...crowd,
  ],
  Project: [
    { id: "p1", name: "Borealis", status: "active", owner: "User:u1" },
    { id: "p2", name: "Apollo", status: "active", owner: "User:u1" },
    { id: "p3", name: "Calypso", status: "archived", owner: "User:u2" },
  ],
  Post: [
    {
      id: "a",
      title: "Hello",
      author: "User:u1",
      // c1 listed twice: paging must not cycle back to it.
      comments: ["Comment:c1", "Comment:c2", "Comment:c1", "Comment:c3"],
      tags: ["x", "y"],
    },
  ],
  Comment: [
    { id: "c1", body: "first", author: "User:u2" },
    { id: "c2", body: "second", author: "User:u1" },
    { id: "c3", body: "third", author: "User:u2" },
  ],
  Team: [
    { id: "t1", name: "Core", members: ["User:u1", "User:u2", "Team:t9"] },
    { id: "big", name: "Everyone", members: crowd.map((member) => `User:${member.id}`) },
  ],
};

const read = (requests: unknown, version: unknown = 4) =>
  JSON.stringify({
    _tag: "Request",
    id: "1",
    tag: "FoldkitRemoteRead",
    payload: { version, requests },
    headers: [],
  });
const req = (entity: string, id: string, fields: readonly string[], extra: object = {}) => ({
  entity,
  id,
  fields,
  ...extra,
});
const rel = (entity: string, fields: readonly string[], extra: object = {}) => ({
  entity,
  fields,
  ...extra,
});
const corpus: ReadonlyArray<readonly [string, string]> = [
  [
    "plain fields, missing field, unknown id",
    read([req("User", "u1", ["name", "nope"]), req("User", "zz", ["name"])]),
  ],
  ["index-like and object values", read([req("User", "u1", ["z", "2", "a", "name"])])],
  // Own keys only, on both sides since foldkit-remote-server 0.11.0 (foldkit-plus#143).
  [
    "Object.prototype member names",
    read([req("User", "u1", ["constructor", "toString", "__proto__", "hasOwnProperty", "name"])]),
  ],
  ["unknown entity", read([req("Ghost", "g", ["x"]), req("User", "u2", ["name"])])],
  ["no requests", read([])],
  [
    "one relation",
    read([
      req("Project", "p1", ["name", "owner"], { relations: { owner: rel("User", ["name"]) } }),
    ]),
  ],
  [
    "shared target read once",
    read([
      req("Project", "p1", ["owner"], { relations: { owner: rel("User", ["name"]) } }),
      req("Project", "p2", ["owner"], { relations: { owner: rel("User", ["name", "team"]) } }),
    ]),
  ],
  [
    "target already fetched still followed",
    read([
      req("User", "u1", ["name", "team"], { relations: { team: rel("Team", ["name"]) } }),
      req("Project", "p1", ["owner"], {
        relations: {
          owner: rel("User", ["name", "team"], { relations: { team: rel("Team", ["members"]) } }),
        },
      }),
    ]),
  ],
  [
    "cycle ends at the selection's depth",
    read([
      req("User", "u1", ["friend"], {
        relations: {
          friend: rel("User", ["friend"], {
            relations: { friend: rel("User", ["name", "friend"]) },
          }),
        },
      }),
    ]),
  ],
  [
    "ref to another entity ignored",
    read([req("Team", "t1", ["members"], { relations: { members: rel("User", ["name"]) } })]),
  ],
  [
    "page of a to-many relation",
    read([
      req("Post", "a", ["title", "comments"], {
        windows: { comments: { first: 2 } },
        relations: { comments: rel("Comment", ["body"]) },
      }),
    ]),
  ],
  [
    "list and a page of it under an alias",
    read([
      req("Post", "a", ["comments", "comments@first=1"], {
        windows: { "comments@first=1": { first: 1 } },
        relations: {
          comments: rel("Comment", ["body"]),
          "comments@first=1": rel("Comment", ["author"], {
            relations: { author: rel("User", ["name"]) },
          }),
        },
      }),
    ]),
  ],
  [
    "alias without a window asks for nothing",
    read([req("Post", "a", ["comments@first=3", "title"])]),
  ],
  [
    "too many pages of one relation",
    read([
      req("Post", "a", ["comments@a", "comments@b", "comments@c", "comments@d", "comments@e"], {
        windows: Object.fromEntries(
          ["a", "b", "c", "d", "e"].map((k) => [`comments@${k}`, { first: 1 }]),
        ),
      }),
    ]),
  ],
  [
    "too many pages nested",
    read([
      req("Post", "a", ["author"], {
        relations: {
          author: rel("User", ["friend@1", "friend@2", "friend@3", "friend@4", "friend@5"]),
        },
      }),
    ]),
  ],
  ["too many ids", read(Array.from({ length: 1001 }, (_, i) => req("User", `m${i}`, ["name"])))],
  [
    "a legitimate batch larger than 64 KiB",
    read(
      Array.from({ length: 900 }, (_, i) =>
        req("User", `m${i}`, ["name", `padding-field-${"x".repeat(80)}`]),
      ),
    ),
  ],
  [
    "nested level over the id limit is chunked",
    read([req("Team", "big", ["members"], { relations: { members: rel("User", ["name"]) } })]),
  ],
  [
    "backward page and cursors",
    read([
      req("Post", "a", ["comments"], { windows: { comments: { last: 2 } } }),
      req("Post", "a", ["comments@b"], {
        windows: { "comments@b": { first: 1, after: "Comment:c1" } },
      }),
      req("Post", "a", ["comments@c"], { windows: { "comments@c": { last: 1, before: "c3" } } }),
      req("Post", "a", ["comments@d"], {
        windows: { "comments@d": { first: 1, after: "nowhere" } },
      }),
      req("Post", "a", ["comments@e"], { windows: { "comments@e": { first: 1, last: 1 } } }),
    ]),
  ],
  [
    "different windows read in separate groups",
    read([
      req("Post", "a", ["comments"], { windows: { comments: { first: 1 } } }),
      req("Post", "a", ["comments"], { windows: { comments: { first: 2 } } }),
    ]),
  ],
  [
    "window on a scalar list",
    read([req("Post", "a", ["tags"], { windows: { tags: { first: 1 } } })]),
  ],
  [
    "duplicate requests union their fields",
    read([
      req("User", "u1", ["name"]),
      req("User", "u1", ["name", "friend"]),
      req("User", "u1", ["z"]),
    ]),
  ],
  [
    "relations keyed out of order",
    read([
      req("User", "u1", ["friend", "team"], {
        relations: { team: rel("Team", ["name"]), friend: rel("User", ["name"]) },
      }),
    ]),
  ],
  ["version mismatch", read([], 3)],
  ["version large", read([], 1e21)],
  ["version fraction", read([], 0.1)],
  ["version NaN", read([], "NaN")],
  ["version -0", read([], -0)],
];

const oracle = Effect.gen(function* () {
  // The published memory backend, served over a real RpcServer (foldkit-plus#140).
  const server = RemoteServer.memory({ domain, rows }).server;
  const handlers = RemoteServer.handlers(server, undefined);
  const http = yield* RpcServer.toHttpEffect(ReadGroup, { disableTracing: true }).pipe(
    Effect.provide([
      ReadGroup.toLayer({ FoldkitRemoteRead: handlers.FoldkitRemoteRead }),
      RpcSerialization.layerJson,
    ]),
  );
  return HttpEffect.toWebHandler(http);
});

test(
  "the native read engine matches foldkit-remote-server over the wire",
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
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-remote-read-" });
          const artifact = yield* NativeRemote.compile(ReadGroup, { domain, rows });
          expect(artifact.runtime.crates).toContain("ryu-js@1.0.3");
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
            expect(successValue(native.body), `${label} raw key order`).toStrictEqual(
              successValue(reference.body),
            );
          }

          // The stock RPC client for the published contract reads through the native engine.
          const client = yield* RpcClient.make(ReadGroup, { disableTracing: true }).pipe(
            Effect.provide(
              RpcClient.layerProtocolHttp({ url }).pipe(
                Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
              ),
            ),
          );
          const result = yield* client.FoldkitRemoteRead({
            version: 4,
            requests: [
              {
                entity: "Project",
                id: "p3",
                fields: ["owner"],
                relations: { owner: { entity: "User", fields: ["name"] } },
              },
            ],
          });
          expect(result.entities.map((entity) => entity.id)).toEqual(["p3", "u2"]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 180000,
);
