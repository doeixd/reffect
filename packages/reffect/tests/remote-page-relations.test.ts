/**
 * Relations in page views (docs/research/ssr-data.md): a native page's query and get views select
 * related entities, and its engine plans and assembles them as upstream's `plan` and `assemble`
 * do. The reference is upstream `handleRequest` around `renderToString`, whose `init` replays the
 * recorded exchanges through `Data.satisfy` and reads the same projections.
 */
import { request as httpRequest } from "node:http";
import { Effect, Exit, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { NodeServices } from "@effect/platform-node";
import { Rendered, handleRequest, renderToString } from "foldkit/experimental/server";
import { defineMessageUnion } from "foldkit/message";
import { Entity, Expr, Order, Relation } from "foldkit-entity";
import { Query, Remote, RemoteData, RemoteRpc } from "foldkit-remote";
import { RemoteServer } from "foldkit-remote-server";
import { Surface } from "foldkit-surface";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRemote, R } from "../src/index.ts";
import type { Expr as RExpr, Value } from "../src/index.ts";
import { RemoteResume, planPage, record, replay } from "../src/remote-resume.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { BUILD_ID, Page } from "./fixtures/ssr-todos.ts";

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
const App = Surface.application({ Model, Message: defineMessageUnion({ ...Remote.messages }) });
const Data = Remote.make({
  model: App.model.remote,
  entities: [User, Project, Comment, Post],
  queries: [ByStatus],
});
const initial: typeof Model.Type = { remote: Remote.initial };
const rows = {
  User: [
    { id: "u1", name: "Ada" },
    { id: "u2", name: "Grace" },
  ],
  Project: [
    { id: "p1", name: "Borealis", status: "active", owner: "User:u1" },
    { id: "p2", name: "Apollo", status: "active", owner: "User:u1" },
    { id: "p3", name: "Calypso", status: "archived", owner: "User:u2" },
  ],
  Post: [{ id: "a", title: "Hello", comments: ["Comment:c1", "Comment:c2", "Comment:c3"] }],
  Comment: [
    { id: "c1", body: "first" },
    { id: "c2", body: "second" },
    { id: "c3", body: "third" },
  ],
};

const summary = Entity.select(Project, { name: true, owner: Entity.select(User, { name: true }) });
const discussion = Entity.select(Post, {
  title: true,
  comments: Entity.page(Entity.select(Comment, { body: true }), { first: 2 }),
});
// Each view exercises one planning case:
// - list: a query whose items carry their owners;
// - project: a get the list already answered, so no Read;
// - archived: a query holding only the owner's id;
// - other: a get whose project is held, so its plan follows the owner ref alone;
// - post: a get with a page of a many-relation.
const list = Data.query(ByStatus, { status: "active" }, { select: summary, first: 2 });
const archived = Data.query(
  ByStatus,
  { status: "archived" },
  {
    select: Entity.select(Project, { name: true, owner: Entity.select(User, { id: true }) }),
    first: 2,
  },
);
const plan = planPage(Data, initial, {
  list,
  project: { get: summary, id: "p1" },
  archived,
  other: { get: summary, id: "p3" },
  post: { get: discussion, id: "a" },
});
const active = {
  list: Data.active("List", () => Option.some(list)),
  project: Data.active("Project", () => Option.some(Data.get(summary, "p1"))),
  archived: Data.active("Archived", () => Option.some(archived)),
  other: Data.active("Other", () => Option.some(Data.get(summary, "p3"))),
  post: Data.active("Post", () => Option.some(Data.get(discussion, "a"))),
};
const origin = "http://reffect.test";
const template =
  '<!doctype html><html lang="en"><head><title>Placeholder</title></head>' +
  '<body><div id="root"></div></body></html>';
const group = RemoteRpc.omit("FoldkitRemoteMutate", "FoldkitRemoteLive");

// What the page shows, read from its views natively and from the projections upstream.
const ProjectItem = R.Struct({ name: R.String, owner: R.String });
const Screen = R.Struct({
  projects: R.Array(ProjectItem),
  project: R.String,
  other: R.String,
  post: R.String,
  comments: R.Array(R.String),
  more: R.Bool,
});
const H = R.Html;
const screenDocument = (screen: RExpr<Value<typeof Screen>>) =>
  H.Document.make({
    title: R.Struct.get(screen, "project"),
    body: H.main(
      [H.Id("root")],
      [
        H.h1([], [R.Struct.get(screen, "project")]),
        H.h2([], [R.Struct.get(screen, "other")]),
        H.ul(
          [],
          R.Array.map(R.Struct.get(screen, "projects"), (project) =>
            H.li([], [R.Struct.get(project, "name"), " by ", R.Struct.get(project, "owner")]),
          ),
        ),
        H.section(
          [],
          [
            H.h2([], [R.Struct.get(screen, "post")]),
            H.ul(
              [],
              R.Array.map(R.Struct.get(screen, "comments"), (body) => H.li([], [body])),
            ),
          ],
        ),
      ],
    ),
  });
const screenView = R.fn([Screen], H.Document, screenDocument);

const Flags = R.Struct({ remote: R.Unknown });
const PageRequest = R.Struct({ remote: R.Unknown, views: NativeRemote.pageViews(plan) });
const page = R.fn([PageRequest], Page, (request) => {
  const views = R.Struct.get(request, "views");
  const post = views.pipe(R.Struct.get("post"));
  return H.renderToString(
    {
      init: () =>
        Screen.make({
          projects: R.Array.map(views.pipe(R.Struct.get("list"), R.Struct.get("items")), (item) =>
            ProjectItem.make({
              name: R.Struct.get(item, "name"),
              owner: item.pipe(R.Struct.get("owner"), R.Struct.get("name")),
            }),
          ),
          project: views.pipe(
            R.Struct.get("project"),
            R.Match.valueTags({
              Ready: (ready) =>
                ready.pipe(R.Struct.get("value"), R.Struct.get("owner"), R.Struct.get("name")),
              NotFound: () => R.String.literal("?"),
            }),
          ),
          other: views.pipe(
            R.Struct.get("other"),
            R.Match.valueTags({
              Ready: (ready) =>
                ready.pipe(R.Struct.get("value"), R.Struct.get("owner"), R.Struct.get("name")),
              NotFound: () => R.String.literal("?"),
            }),
          ),
          post: post.pipe(
            R.Match.valueTags({
              Ready: (ready) => ready.pipe(R.Struct.get("value"), R.Struct.get("title")),
              NotFound: () => R.String.literal("?"),
            }),
          ),
          comments: post.pipe(
            R.Match.valueTags({
              Ready: (ready) =>
                R.Array.map(
                  ready.pipe(
                    R.Struct.get("value"),
                    R.Struct.get("comments"),
                    R.Struct.get("items"),
                  ),
                  (comment) => R.Struct.get(comment, "body"),
                ),
              NotFound: () => R.Array.empty(R.String),
            }),
          ),
          more: post.pipe(
            R.Match.valueTags({
              Ready: (ready) =>
                ready.pipe(
                  R.Struct.get("value"),
                  R.Struct.get("comments"),
                  R.Struct.get("hasNext"),
                ),
              NotFound: () => R.Bool.literal(false),
            }),
          ),
        }),
      view: screenDocument,
    },
    { buildId: BUILD_ID, flags: Flags.make({ remote: R.Struct.get(request, "remote") }) },
  );
});

const FlagsSchema = Schema.Struct({ remote: RemoteResume });
const ready = <A, B>(data: RemoteData<A>, read: (value: A) => B, otherwise: B): B =>
  RemoteData.match(data, {
    Ready: read,
    Refreshing: read,
    Initial: () => otherwise,
    Loading: () => otherwise,
    Failed: () => otherwise,
    NotFound: () => otherwise,
  });
const upstream = async (now: number) => {
  const [, exchanges] = await Effect.runPromise(
    record(Data.satisfy(initial, active, { now: () => now })).pipe(
      Effect.provide(RemoteServer.memory({ domain: Data, rows }).layer),
    ),
  );
  const response = await handleRequest(new Request(`${origin}/`), {
    template,
    renderPage: async () =>
      Rendered(
        await Effect.runPromise(
          renderToString(
            {
              Flags: FlagsSchema,
              init: (flags: typeof FlagsSchema.Type) => {
                const model = Effect.runSync(
                  Data.satisfy(initial, active, { now: () => flags.remote.now }).pipe(
                    Effect.provide(replay(flags.remote.exchanges)),
                  ),
                );
                const post = Data.get(discussion, "a").read(model);
                return {
                  model: {
                    projects: ready(
                      list.read(model),
                      (page) =>
                        page.items.map((item) => ({ name: item.name, owner: item.owner.name })),
                      [],
                    ),
                    project: ready(Data.get(summary, "p1").read(model), (v) => v.owner.name, "?"),
                    other: ready(Data.get(summary, "p3").read(model), (v) => v.owner.name, "?"),
                    post: ready(post, (v) => v.title, "?"),
                    comments: ready(post, (v) => v.comments.items.map((c) => c.body), []),
                    more: ready(post, (v) => v.comments.hasNext, false),
                  },
                };
              },
              view: R.Html.toFoldkitView(screenView),
            },
            { flags: { remote: { now, exchanges } }, buildId: BUILD_ID },
          ),
        ),
      ),
  });
  return { status: response.status, body: await response.text() };
};
const send = (address: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const [host, port] = address.split(":");
    const outgoing = httpRequest(
      { host, port: Number(port), method: "GET", path: "/" },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
const flagsOf = (body: string) => {
  const payload = /<script type="application\/json" data-foldkit-flags="app">(.*?)<\/script>/s.exec(
    body,
  );
  if (!payload) throw new Error("Missing Flags payload");
  return Schema.decodeUnknownSync(Schema.toCodecJson(FlagsSchema))(JSON.parse(payload[1]!));
};

test(
  "a native page plans, reads and assembles relations as upstream, and resumes from replay",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-page-relations-" });
          const artifact = yield* NativeRemote.compile(group, {
            domain: Data,
            rows,
            pages: { template, render: page, origin, remote: plan },
          });
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.fetch(directory);
          yield* CargoApi.build(directory, "debug");
          const child = yield* ChildProcess.make(
            `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
            ["--port", "0"],
          );
          yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
          const started = yield* Stream.runHead(
            Stream.splitLines(Stream.decodeText(child.stdout)),
          ).pipe(Effect.timeout("10 seconds"));
          if (!Option.isSome(started)) throw new Error("Missing ready record");
          const { address } = Schema.decodeUnknownSync(
            Schema.Struct({
              schema: Schema.Literal("reffect.rpc.ready@1"),
              address: Schema.String,
            }),
          )(JSON.parse(started.value));

          const native = yield* Effect.promise(() => send(address));
          const flags = flagsOf(native.body);
          expect(native).toEqual(yield* Effect.promise(() => upstream(flags.remote.now)));
          // The planning cases, as upstream made them: no Read for the listed project, the
          // owner alone for the held one, and the post with its page of comments.
          expect(flags.remote.exchanges.map((exchange) => exchange.request)).toEqual([
            expect.objectContaining({ query: "ByStatus", input: { status: "active" } }),
            expect.objectContaining({ query: "ByStatus", input: { status: "archived" } }),
            { version: 4, requests: [{ entity: "User", id: "u2", fields: ["name"] }] },
            expect.objectContaining({ requests: [expect.objectContaining({ entity: "Post" })] }),
          ]);
          expect(native.body).toContain("<h1>Ada</h1>");
          expect(native.body).toContain("<h2>Grace</h2>");
          expect(native.body).toContain("<li>Apollo by Ada</li>");
          expect(native.body).toContain("<li>second</li>");
          expect(native.body).not.toContain("third");

          const resumed = Effect.runSyncExit(
            Data.satisfy(initial, active, { now: () => flags.remote.now }).pipe(
              Effect.provide(replay(flags.remote.exchanges)),
            ),
          );
          if (!Exit.isSuccess(resumed)) throw new Error(String(resumed.cause));
          expect(Data.get(summary, "p3").read(resumed.value)).toMatchObject({ _tag: "Ready" });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
