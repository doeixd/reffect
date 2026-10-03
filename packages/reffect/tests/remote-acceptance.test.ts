/**
 * Milestone 4 acceptance (Read and Query): the stock Foldkit Remote client, unchanged, reading
 * through `Remote.clientLayer` over an ordinary Effect RPC HTTP client from the native server.
 * The reference is upstream's own `RemoteServer.memory(...).layer`: the same client code over the
 * official in-process backend, with no vendored code on either side.
 */
import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcess } from "effect/process";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { defineMessageUnion } from "foldkit/message";
import { Entity, Expr, Order, Relation } from "foldkit-entity";
import { Query, Remote, RemoteRpc } from "foldkit-remote";
import type { RemoteRpcClient } from "foldkit-remote";
import { RemoteServer } from "foldkit-remote-server";
import { Surface } from "foldkit-surface";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRemote } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// The domain of foldkit-remote-server's memory test, plus a paged to-many relation.
const UserBase = Entity.define("User", Schema.Struct({ id: Schema.String, name: Schema.String }));
const ProjectBase = Entity.define(
  "Project",
  Schema.Struct({ id: Schema.String, name: Schema.String, status: Schema.String }),
);
const CommentBase = Entity.define(
  "Comment",
  Schema.Struct({ id: Schema.String, body: Schema.String }),
);
const PostBase = Entity.define("Post", Schema.Struct({ id: Schema.String, title: Schema.String }));
const { User, Project, Comment, Post } = Entity.relate(
  { User: UserBase, Project: ProjectBase, Comment: CommentBase, Post: PostBase },
  {
    Project: { owner: Relation.one(UserBase) },
    Post: { comments: Relation.many(CommentBase) },
  },
);
const ByStatus = Query.define("ByStatus", { status: Schema.String }, ({ input }) =>
  Query.from(Project).pipe(
    Query.where(Expr.eq(Project.fields.status, input.status)),
    Query.orderBy(Order.asc(Project.fields.name)),
  ),
);
const Model = Schema.Struct({ remote: Remote.Model });
type Model = typeof Model.Type;
const App = Surface.application({ Model, Message: defineMessageUnion({ ...Remote.messages }) });
const Data = Remote.make({
  model: App.model.remote,
  entities: [User, Project, Comment, Post],
  queries: [ByStatus],
});
const initial: Model = { remote: Remote.initial };
const rows = {
  User: [
    { id: "u1", name: "Ada" },
    { id: "u2", name: "Grace" },
  ],
  Project: [
    { id: "p1", name: "Borealis", status: "active", owner: "User:u1" },
    { id: "p2", name: "Apollo", status: "active", owner: "User:u1" },
    { id: "p3", name: "Calypso", status: "archived", owner: "User:u2" },
    { id: "p4", name: "Dione", status: "active", owner: "User:u2" },
  ],
  Post: [
    { id: "a", title: "Hello", comments: ["Comment:c1", "Comment:c2", "Comment:c1", "Comment:c3"] },
  ],
  Comment: [
    { id: "c1", body: "first" },
    { id: "c2", body: "second" },
    { id: "c3", body: "third" },
  ],
};

const summary = Entity.select(Project, { name: true, owner: Entity.select(User, { name: true }) });
const post = Data.get(
  Entity.select(Post, {
    title: true,
    comments: Entity.page(Entity.select(Comment, { body: true }), { first: 2 }),
  }),
  "a",
);
const project = Data.get(summary, "p1");
const missing = Data.get(summary, "p9");
const firstActive = Data.query(ByStatus, { status: "active" }, { select: summary, first: 1 });
const lastActive = Data.query(ByStatus, { status: "active" }, { select: summary, last: 2 });

/** What a screen does: prefetch a projection, read it, and load more once. */
const session = Effect.gen(function* () {
  const load = (projection: Parameters<typeof Data.prefetch>[1], from: Model = initial) =>
    Data.prefetch(from, projection);
  const projectModel = yield* load(project);
  const missingModel = yield* load(missing);
  const postModel = yield* load(post);
  const pageModel = yield* load(firstActive);
  const moreModel = yield* load(firstActive, Option.getOrThrow(Data.more(pageModel, firstActive)));
  const evenMore = yield* load(firstActive, Option.getOrThrow(Data.more(moreModel, firstActive)));
  const backwardModel = yield* load(lastActive);
  return {
    project: project.read(projectModel),
    missing: missing.read(missingModel),
    post: post.read(postModel),
    firstPage: firstActive.read(pageModel),
    secondPage: firstActive.read(moreModel),
    thirdPage: firstActive.read(evenMore),
    backward: lastActive.read(backwardModel),
  };
});

test(
  "a stock Remote.clientLayer reads and queries through the native server",
  async () => {
    const official = await Effect.runPromise(
      session.pipe(Effect.provide(RemoteServer.memory({ domain: Data, rows }).layer)),
    );
    // Sanity: the reference run reads what the memory test expects.
    expect(official.project).toEqual({
      _tag: "Ready",
      value: { name: "Borealis", owner: { name: "Ada" } },
    });
    expect(official.missing._tag).toBe("NotFound");

    const native = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({
            prefix: "reffect-remote-acceptance-",
          });
          const group = RemoteRpc.omit("FoldkitRemoteMutate", "FoldkitRemoteLive");
          const artifact = yield* NativeRemote.compile(group, { domain: Data, rows });
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
          // An ordinary Effect RPC HTTP client for the published contract: no native-specific code.
          const rpc = yield* RpcClient.make(RemoteRpc, { disableTracing: true }).pipe(
            Effect.provide(
              RpcClient.layerProtocolHttp({ url: `http://${address}/rpc` }).pipe(
                Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
              ),
            ),
          );
          // RemoteRpcClient admits only Remote's own errors, so any Effect RPC transport turns its
          // RpcClientError into a defect; upstream's examples use hand-written transports instead.
          const transport: RemoteRpcClient = {
            FoldkitRemoteRead: (payload) =>
              rpc.FoldkitRemoteRead(payload).pipe(Effect.catchTag("RpcClientError", Effect.die)),
            FoldkitRemoteQuery: (payload) =>
              rpc.FoldkitRemoteQuery(payload).pipe(Effect.catchTag("RpcClientError", Effect.die)),
            FoldkitRemoteMutate: (payload) =>
              rpc.FoldkitRemoteMutate(payload).pipe(Effect.catchTag("RpcClientError", Effect.die)),
            FoldkitRemoteLive: (payload) =>
              rpc.FoldkitRemoteLive(payload).pipe(Stream.catchTag("RpcClientError", Stream.die)),
          };
          const client = yield* Layer.build(Remote.clientLayer(transport));
          return yield* session.pipe(Effect.provideContext(client));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(native).toStrictEqual(official);
  },
  nativeTestBudget(0) + 180000,
);
