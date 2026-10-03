/**
 * Milestone 9 step 2 (M9-2): resuming a server render's Remote data. The server runs upstream
 * `Data.satisfy` while recording its exchanges; the client replays them through the same
 * `Data.satisfy` in `Effect.runSync`, as `init` would. Upstream only: the reference server is
 * `RemoteServer.memory(...).layer`.
 */
import { Effect, Exit, Option, Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { Entity, Expr, Order, Relation } from "foldkit-entity";
import { Query, Remote, RemoteData } from "foldkit-remote";
import { RemoteServer } from "foldkit-remote-server";
import { Surface } from "foldkit-surface";
import { expect, test } from "vite-plus/test";
import { RemoteResume, record, replay } from "../src/remote-resume.ts";

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
  Post: [{ id: "a", title: "Hello", comments: ["Comment:c1", "Comment:c2", "Comment:c3"] }],
  Comment: [
    { id: "c1", body: "first" },
    { id: "c2", body: "second" },
    { id: "c3", body: "third" },
  ],
};

const summary = Entity.select(Project, { name: true, owner: Entity.select(User, { name: true }) });
// An entity Read with a relation, a windowed connection, and a paged to-many relation.
const project = Data.get(summary, "p1");
const firstActive = Data.query(ByStatus, { status: "active" }, { select: summary, first: 2 });
const post = Data.get(
  Entity.select(Post, {
    title: true,
    comments: Entity.page(Entity.select(Comment, { body: true }), { first: 2 }),
  }),
  "a",
);
// A Surface that reads only once another has: satisfy needs a second pass for it.
const grace = Data.get(Entity.select(User, { name: true }), "u2");
const afterProject = (model: Model) =>
  RemoteData.match(project.read(model), {
    Initial: () => Option.none(),
    Loading: () => Option.none(),
    Ready: () => Option.some(grace),
    Refreshing: () => Option.some(grace),
    Failed: () => Option.none(),
    NotFound: () => Option.none(),
  });
const active = {
  project: Data.active("Project", () => Option.some(project)),
  list: Data.active("List", () => Option.some(firstActive)),
  post: Data.active("Post", () => Option.some(post)),
  owner: Data.active("Owner", afterProject),
};
const at = 1_700_000_000_000;

/** The server render: satisfy against the reference server, recording, then cross as Flags do. */
const serverRender = Effect.gen(function* () {
  const [model, exchanges] = yield* record(Data.satisfy(initial, active, { now: () => at }));
  const codec = Schema.toCodecJson(RemoteResume);
  const text = JSON.stringify(Schema.encodeSync(codec)({ now: at, exchanges }));
  return { model, resume: Schema.decodeUnknownSync(codec)(JSON.parse(text)) };
}).pipe(Effect.provide(RemoteServer.memory({ domain: Data, rows }).layer));

/** The client's `init`: the same satisfy over the replay, synchronously. */
const resume = (flags: RemoteResume) =>
  Effect.runSyncExit(
    Data.satisfy(initial, active, { now: () => flags.now }).pipe(
      Effect.provide(replay(flags.exchanges)),
    ),
  );

test("a replayed satisfy reproduces the server's Model and plans no fetch", async () => {
  const { model, resume: flags } = await Effect.runPromise(serverRender);
  expect(flags.exchanges.map((exchange) => exchange._tag)).toContain("Query");
  expect(flags.exchanges.map((exchange) => exchange._tag)).toContain("Read");
  const resumed = resume(flags);
  if (!Exit.isSuccess(resumed)) throw new Error(`resume failed: ${String(resumed.cause)}`);
  expect(resumed.value).toStrictEqual(model);
  for (const projection of [project, firstActive, post, grace])
    expect(projection.read(resumed.value)._tag).toBe("Ready");
  expect(firstActive.read(resumed.value)).toStrictEqual(firstActive.read(model));
  // Every Surface's read entry is idle: the browser starts without an initial fetch. The owner
  // Surface had nothing to plan from `initial`; `grace` being Ready shows its second pass replayed.
  const entries = Data.subscriptions(active);
  const idle = { requirements: [], queries: [] };
  for (const entry of [entries["project.read"], entries["list.read"], entries["post.read"]]) {
    expect(entry.modelToDependencies(resumed.value)).toMatchObject(idle);
    expect(entry.modelToDependencies(initial)).not.toMatchObject(idle);
  }
  expect(entries["owner.read"].modelToDependencies(resumed.value)).toMatchObject(idle);
});

test("a request the server did not record fails with its typed error", async () => {
  const { resume: flags } = await Effect.runPromise(serverRender);
  const withoutQueries = {
    ...flags,
    exchanges: flags.exchanges.filter((exchange) => exchange._tag !== "Query"),
  };
  const resumed = resume(withoutQueries);
  expect(Exit.isFailure(resumed)).toBe(true);
  if (Exit.isFailure(resumed)) expect(String(resumed.cause)).toContain("RemoteQueryError");
});
