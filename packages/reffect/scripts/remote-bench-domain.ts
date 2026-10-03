/** Shared domain, rows and workloads for the native-versus-official Remote benchmark. */
import { Schema } from "effect";
import { Entity, Expr, Order, Relation } from "foldkit-entity";
import { Query, Remote, RemoteRpc } from "foldkit-remote";

export const Group = RemoteRpc.omit("FoldkitRemoteMutate", "FoldkitRemoteLive");

const UserBase = Entity.define("User", Schema.Struct({ id: Schema.String, name: Schema.String }));
const ProjectBase = Entity.define(
  "Project",
  Schema.Struct({ id: Schema.String, name: Schema.String, status: Schema.String }),
);
const { User, Project } = Entity.relate(
  { User: UserBase, Project: ProjectBase },
  { Project: { owner: Relation.one(UserBase) } },
);
export const ByStatus = Query.define("ByStatus", { status: Schema.String }, ({ input }) =>
  Query.from(Project).pipe(
    Query.where(Expr.eq(Project.fields.status, input.status)),
    Query.orderBy(Order.asc(Project.fields.name)),
  ),
);
export const domain = Remote.define({ entities: [User, Project], queries: [ByStatus] });

const statuses = ["active", "archived", "draft", "review"];
export const rows = {
  User: Array.from({ length: 500 }, (_, i) => ({ id: `u${i}`, name: `User ${i}` })),
  Project: Array.from({ length: 5000 }, (_, i) => ({
    id: `p${i}`,
    name: `Project ${String((i * 7919) % 5000).padStart(4, "0")}`,
    status: statuses[i % statuses.length],
    owner: `User:u${(i * 31) % 500}`,
  })),
};

const envelope = (tag: string, payload: unknown) =>
  JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] });
const owner = { owner: { entity: "User", fields: ["name"] } };
/** Request bodies: a single entity, a screen-sized batch, and a query page with its items. */
export const workloads: ReadonlyArray<{ readonly name: string; readonly body: string }> = [
  {
    name: "read-one",
    body: envelope("FoldkitRemoteRead", {
      version: 4,
      requests: [{ entity: "Project", id: "p1", fields: ["name", "owner"], relations: owner }],
    }),
  },
  {
    name: "read-batch-50",
    body: envelope("FoldkitRemoteRead", {
      version: 4,
      requests: Array.from({ length: 50 }, (_, i) => ({
        entity: "Project",
        id: `p${i * 97}`,
        fields: ["name", "status", "owner"],
        relations: owner,
      })),
    }),
  },
  {
    name: "query-page-20",
    body: envelope("FoldkitRemoteQuery", {
      query: "ByStatus",
      input: { status: "active" },
      window: { first: 20 },
      select: { entity: "Project", fields: ["name", "owner"], relations: owner },
    }),
  },
];
